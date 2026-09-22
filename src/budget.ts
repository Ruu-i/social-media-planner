import { UpdateCommand, GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { TABLE_NAME } from "./store/dynamo-table.js";

/**
 * Spend control for a public demo.
 *
 * The problem this solves is specific: an agent turn costs about $0.30, and a
 * public URL is reachable by anyone — including crawlers. Fifty curious
 * visitors is $15 in an afternoon, from strangers, with no ceiling.
 *
 * The shape of the answer matters as much as the existence of it. Browsing the
 * calendar, opening captions, approving and publishing all cost NOTHING, because
 * none of them touch the model. Only the chat does. So a spent budget degrades
 * to a still-fully-explorable app rather than a dead page.
 *
 * Two independent limits, because they stop different things:
 *
 *   daily budget   caps total spend regardless of who is spending it
 *   per-client rate  stops one visitor consuming the whole day's budget
 */

export interface DaySpend {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface BudgetStore {
  getDaySpend(day: string): Promise<DaySpend>;
  addUsage(day: string, usage: TurnUsage): Promise<void>;
  /** Returns the count AFTER incrementing, so the caller sees its own request. */
  bumpClient(clientId: string, hour: string): Promise<number>;
}

export interface TurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Opus 5: $5/MTok in, $25/MTok out, cache read $0.50, cache write $6.25. */
export function costOf(u: TurnUsage): number {
  const M = 1_000_000;
  return (
    (u.input / M) * 5 + (u.output / M) * 25 + (u.cacheRead / M) * 0.5 + (u.cacheWrite / M) * 6.25
  );
}

export const today = () => new Date().toISOString().slice(0, 10);
export const thisHour = () => new Date().toISOString().slice(0, 13);

// ---------------------------------------------------------------------------

export class MemoryBudgetStore implements BudgetStore {
  private days = new Map<string, DaySpend>();
  private clients = new Map<string, number>();

  async getDaySpend(day: string): Promise<DaySpend> {
    return this.days.get(day) ?? { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  async addUsage(day: string, usage: TurnUsage): Promise<void> {
    // Read and write with NO await in between. Awaiting here yields the
    // microtask queue, and ten concurrent turns would each read the same
    // starting total and clobber one another — losing nine increments. The
    // DynamoDB implementation avoids the same trap with an atomic ADD.
    const current = this.days.get(day) ?? {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    this.days.set(day, {
      turns: current.turns + 1,
      inputTokens: current.inputTokens + usage.input,
      outputTokens: current.outputTokens + usage.output,
      costUsd: current.costUsd + costOf(usage),
    });
  }

  async bumpClient(clientId: string, hour: string): Promise<number> {
    const k = `${clientId}#${hour}`;
    const next = (this.clients.get(k) ?? 0) + 1;
    this.clients.set(k, next);
    return next;
  }
}

/**
 * DynamoDB-backed counters.
 *
 * Uses atomic ADD rather than read-modify-write. Two concurrent turns doing
 * read-then-write would both see the same starting total and one increment
 * would vanish — which is precisely the case a spend cap must not get wrong.
 */
export class DynamoBudgetStore implements BudgetStore {
  constructor(
    private client: DynamoDBDocumentClient,
    private table = TABLE_NAME,
  ) {}

  async getDaySpend(day: string): Promise<DaySpend> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { PK: `BUDGET#${day}`, SK: "TOTAL" } }),
    );
    const item = result.Item;
    return {
      turns: Number(item?.turns ?? 0),
      inputTokens: Number(item?.inputTokens ?? 0),
      outputTokens: Number(item?.outputTokens ?? 0),
      costUsd: Number(item?.costUsd ?? 0),
    };
  }

  async addUsage(day: string, usage: TurnUsage): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: `BUDGET#${day}`, SK: "TOTAL" },
        UpdateExpression:
          "ADD turns :one, inputTokens :in, outputTokens :out, costUsd :cost",
        ExpressionAttributeValues: {
          ":one": 1,
          ":in": usage.input,
          ":out": usage.output,
          ":cost": costOf(usage),
        },
      }),
    );
  }

  async bumpClient(clientId: string, hour: string): Promise<number> {
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: `RATE#${clientId}`, SK: hour },
        UpdateExpression: "ADD #c :one",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Number(result.Attributes?.count ?? 1);
  }
}

// ---------------------------------------------------------------------------

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
  spentUsd: number;
  budgetUsd: number;
}

/**
 * Decides whether a turn may run.
 *
 * Enforcement is opt-in via DEMO_MODE, but RECORDING is always on: knowing what
 * the thing costs is useful locally too, and a counter that only runs in
 * production is a counter that has never been tested.
 */
export class SpendGuard {
  constructor(
    private store: BudgetStore,
    private dailyBudgetUsd = Number(process.env.DEMO_DAILY_BUDGET_USD ?? 2),
    private turnsPerHour = Number(process.env.DEMO_TURNS_PER_HOUR ?? 5),
    private enforcing = process.env.DEMO_MODE === "true",
  ) {}

  async check(clientId: string): Promise<GuardDecision> {
    const spend = await this.store.getDaySpend(today());
    const base = { spentUsd: spend.costUsd, budgetUsd: this.dailyBudgetUsd };

    if (!this.enforcing) return { allowed: true, ...base };

    if (spend.costUsd >= this.dailyBudgetUsd) {
      return {
        allowed: false,
        reason:
          "The demo budget for today has been spent. Everything else still works — " +
          "browse the calendar, open the captions, approve and publish. The agent " +
          "itself is back tomorrow.",
        ...base,
      };
    }

    // Counted per client, so one visitor cannot drain the day in five minutes.
    const used = await this.store.bumpClient(clientId, thisHour());
    if (used > this.turnsPerHour) {
      return {
        allowed: false,
        reason:
          `That is ${this.turnsPerHour} agent runs this hour, which is the demo limit. ` +
          "The rest of the app keeps working — try again shortly.",
        ...base,
      };
    }

    return { allowed: true, ...base };
  }

  /** Called after a turn, whether or not enforcement is on. */
  async record(usage: TurnUsage): Promise<void> {
    await this.store.addUsage(today(), usage);
  }

  async status(): Promise<GuardDecision & { enforcing: boolean }> {
    const spend = await this.store.getDaySpend(today());
    return {
      allowed: !this.enforcing || spend.costUsd < this.dailyBudgetUsd,
      spentUsd: spend.costUsd,
      budgetUsd: this.dailyBudgetUsd,
      enforcing: this.enforcing,
    };
  }
}
