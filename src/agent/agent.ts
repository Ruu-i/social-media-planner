import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";

import { SYSTEM_PROMPT } from "./system.js";
import { createTools, type Session, type ToolDeps } from "./tools.js";
import { buildTimeContext } from "./time-context.js";
import { createClient, resolveModel } from "./provider.js";
import {
  MemoryConversationStore,
  type ConversationStore,
} from "../store/conversations.js";
import type { ContentStore } from "../store/types.js";

/**
 * The agent loop.
 *
 * We use the SDK's Tool Runner rather than hand-writing
 * `while (stop_reason === "tool_use")`. It drives the
 * request -> execute tools -> feed results back -> repeat cycle, so this file
 * only has to own the things the runner does not: conversation state across
 * turns, pause_turn resumption, and reporting.
 *
 * Provider seam: see provider.ts. The client and model id are resolved from
 * LLM_PROVIDER, so moving the whole agent to Bedrock is an env var — the loop
 * below is identical either way.
 */
const client = createClient();

export const MODEL = resolveModel();

/**
 * `high` for quality, `medium` for roughly 23% less waiting. Measured, not
 * guessed — see the comment on output_config below.
 */
const EFFORT = (process.env.MODEL_EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max";

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: unknown }>;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Progress callbacks.
 *
 * These exist because of a measured problem, not a hypothetical one. Planning a
 * week spends ~80 seconds in a single turn generating every caption as tool
 * arguments. The tokens are flowing the whole time; without these the user sees
 * a dead prompt and assumes it has hung.
 *
 * Output runs at roughly 75 tokens/second and that is not tunable. The fix is
 * not to make it faster — it is to make the wait legible.
 */
export interface AgentEvents {
  /** A tool is about to run. */
  onToolCall?(name: string): void;
  /** Summarised reasoning, as it happens. */
  onThinking?(delta: string): void;
  /** The final reply, token by token. */
  onText?(delta: string): void;
  /** Tool arguments being written — the slow phase. */
  onWriting?(info: { chars: number; elapsedMs: number }): void;
}

/**
 * Drives one conversation.
 *
 * The agent is multi-turn over persistent state: "make Wednesday funnier" only
 * means something because the previous turn created Wednesday. The full message
 * history — tool calls and their results included — is handed back to each new
 * runner so the model can see what it already did.
 *
 * History is loaded and saved per turn rather than held in the instance,
 * because in Lambda there is no instance that survives between requests. The
 * default store is in-memory, which is exactly right for the CLI.
 */
export class ContentAgent {
  constructor(
    private store: ContentStore,
    private session: Session,
    private deps: ToolDeps = {},
    private conversations: ConversationStore = new MemoryConversationStore(),
  ) {}

  /** The session key history is stored under. */
  private get conversationId(): string {
    return this.session.sessionId ?? this.session.userId;
  }

  async history(): Promise<readonly BetaMessageParam[]> {
    return this.conversations.load(this.conversationId);
  }

  async send(userMessage: string, events: AgentEvents = {}): Promise<TurnResult> {
    // Rehydrate the conversation. In Lambda this is the only way the previous
    // turn is still available; locally it is a Map lookup.
    const messages = await this.conversations.load(this.conversationId);

    // The current date and timezone rules ride along with the user turn, not
    // in the system prompt — a timestamp in the cached prefix would invalidate
    // the cache on every request. Here it sits after the breakpoint, so the
    // cache still hits.
    const timezone = (await this.store.getBusinessProfile(this.session.userId)).timezone;
    messages.push({
      role: "user",
      content: `${buildTimeContext(timezone)}

${userMessage}`,
    });

    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,

      // Adaptive thinking: the model decides how much to reason per turn.
      // Never disable it on Opus 5 — with thinking off, the model sometimes
      // writes a tool call into visible text instead of emitting a tool_use
      // block, and the call silently never runs.
      //
      // `display: "summarized"` is required to see any of it: the default on
      // Opus 5 is "omitted", which streams thinking blocks with empty text and
      // makes a long turn look like a hang.
      thinking: { type: "adaptive", display: "summarized" },

      // Measured on a week-long plan: `high` writes ~5,900 output tokens in
      // ~81s; `medium` writes ~4,600 in ~60s. Same tokens/second — the
      // difference is purely how much it writes. `high` is the better default
      // for planning; MODEL_EFFORT lets you trade it for speed.
      output_config: { effort: EFFORT },

      // A frozen prefix, cached. Everything volatile lives in messages, after
      // this breakpoint.
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],

      messages,
      tools: createTools(this.store, this.session, this.deps),

      // Stream so the caller can show progress. The tokens flow either way;
      // this is the difference between a visible wait and an apparent hang.
      stream: true,

      // A runaway loop costs real money. This is a backstop, not a target —
      // a normal planning turn uses 3-5 iterations.
      max_iterations: 15,
    });

    const toolCalls: TurnResult["toolCalls"] = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    // With `stream: true` each iteration yields a STREAM, not a message. A bare
    // `message.stop_reason` check would never fire here — the stream has to be
    // resolved first.
    for await (const stream of runner) {
      const startedAt = Date.now();
      let writtenChars = 0;

      stream.on("thinking", (delta) => events.onThinking?.(delta));
      stream.on("text", (delta) => events.onText?.(delta));
      stream.on("inputJson", (delta) => {
        writtenChars += delta.length;
        events.onWriting?.({ chars: writtenChars, elapsedMs: Date.now() - startedAt });
      });

      const message = await stream.finalMessage();
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

      for (const block of message.content) {
        if (block.type === "tool_use") {
          toolCalls.push({ name: block.name, input: block.input });
          events.onToolCall?.(block.name);
        }
      }

      // The runner does NOT auto-resume a paused turn. A server-side tool that
      // hits its iteration limit stops with `pause_turn`, and without this the
      // loop ends early and silently returns a truncated answer — no error.
      // Harmless now (we have no server tools), required the moment web_search
      // is added.
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }

    const final = await runner.done();

    // Opus 5 can decline: HTTP 200, stop_reason "refusal", no usable content.
    // Check before reading content, always.
    if (final.stop_reason === "refusal") {
      throw new Error(
        `Claude declined this request (${final.stop_details?.category ?? "unknown"}): ` +
          (final.stop_details?.explanation ?? "no explanation given"),
      );
    }

    // Persist the full exchange — assistant turns and tool results included —
    // so the next turn sees everything this one did.
    await this.conversations.save(this.conversationId, [...runner.params.messages]);

    return { text: extractText(final), toolCalls, usage };
  }
}

function extractText(message: BetaMessage): string {
  return message.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Opus 5: $5/MTok in, $25/MTok out, cache read $0.50, cache write $6.25. */
export function estimateCost(u: TurnResult["usage"]): number {
  const M = 1_000_000;
  return (
    (u.input / M) * 5 + (u.output / M) * 25 + (u.cacheRead / M) * 0.5 + (u.cacheWrite / M) * 6.25
  );
}
