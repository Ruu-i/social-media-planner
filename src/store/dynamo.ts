import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";

import {
  type BusinessProfile,
  type Campaign,
  type CampaignDraft,
  type ContentItem,
  type ContentItemDraft,
  type ContentItemWithVariants,
  type PlannedSlot,
  type PostVariant,
  type Status,
  type VariantDraft,
} from "../schemas.js";
import type { ConnectionStore } from "./connections.js";
import type { MediaStore } from "./media.js";
import type { ContentStore } from "./types.js";
import {
  approvalSurvives,
  assertAgentTransition,
  assertFutureTime,
  assertHasOffset,
  assertSchedulable,
  assertVariantValid,
  StoreError,
} from "./rules.js";
import { key, TABLE_NAME } from "./dynamo-table.js";
import type { Scheduler } from "../scheduler/types.js";

/**
 * DynamoDB-backed content store.
 *
 * Implements the same `ContentStore` interface as `MemoryStore`, so the same
 * assertion suite runs against both. That is the point: parity is demonstrated
 * by running the tests twice, not by reading the code and believing it.
 *
 * Notice what is NOT in this file: the approval gate, the format checks, the
 * timezone rule. Those live in `rules.ts` and are shared. This class decides
 * only where bytes go.
 *
 * Scope: persists content — items, variants, campaigns. The business profile,
 * connections and media library are injected, exactly as they are for
 * MemoryStore. Moving those into the table is mechanical and is the next step.
 */
export class DynamoStore implements ContentStore {
  constructor(
    private client: DynamoDBDocumentClient,
    private profile: BusinessProfile,
    private connections: ConnectionStore,
    private scheduler: Scheduler,
    private media: MediaStore | null = null,
    private table = TABLE_NAME,
  ) {}

  private get deps() {
    return { connections: this.connections, media: this.media };
  }

  // -- injected, not persisted (yet) ---------------------------------------

  async getBusinessProfile(_userId: string): Promise<BusinessProfile> {
    return this.profile;
  }

  async getConnectedAccounts(userId: string) {
    return this.connections.listChannels(userId);
  }

  get connectionStore() {
    return this.connections;
  }

  get mediaStore() {
    return this.media;
  }

  // -- reads ---------------------------------------------------------------

  /**
   * Two queries, joined in memory: items, then variants.
   *
   * Filters are applied after the fetch rather than pushed into the query.
   * At one user's calendar that is a handful of rows and the simpler code
   * wins; at scale the date range would move into the SK to avoid reading
   * rows only to discard them.
   */
  async getCalendar(
    userId: string,
    opts: { from?: string; to?: string; status?: Status } = {},
  ): Promise<ContentItemWithVariants[]> {
    const [items, variants] = await Promise.all([
      this.queryPrefix<ContentItem>(key.user(userId), "ITEM#"),
      this.queryPrefix<PostVariant>(key.user(userId), "VAR#"),
    ]);

    const byItem = new Map<string, PostVariant[]>();
    for (const v of variants) {
      byItem.set(v.itemId, [...(byItem.get(v.itemId) ?? []), v]);
    }

    const out: ContentItemWithVariants[] = [];
    for (const item of items) {
      const all = (byItem.get(item.id) ?? []).sort((a, b) =>
        a.scheduledFor.localeCompare(b.scheduledFor),
      );
      const matching = all
        .filter((v) => (opts.status ? v.status === opts.status : true))
        .filter((v) => (opts.from ? v.scheduledFor >= opts.from : true))
        .filter((v) => (opts.to ? v.scheduledFor <= opts.to : true));

      if (matching.length > 0) {
        out.push({ ...item, variants: matching });
        continue;
      }

      // A planned slot has no variants yet. It must still appear, or phase-two
      // planning cannot see what phase one agreed and plans the slot twice.
      const isUnwrittenSlot = all.length === 0 && item.plannedFor !== null;
      const inRange =
        (!opts.from || item.plannedFor! >= opts.from) &&
        (!opts.to || item.plannedFor! <= opts.to);
      if (isUnwrittenSlot && inRange && !opts.status) {
        out.push({ ...item, variants: [] });
      }
    }

    return out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  }

  async getItem(userId: string, itemId: string): Promise<ContentItemWithVariants> {
    const item = await this.getRow<ContentItem>(key.user(userId), key.item(itemId));
    // Ownership is implicit: the row is under this user's partition, so a probe
    // for another user's item id simply misses.
    if (!item) throw new StoreError(`No content item ${itemId}`, "NOT_FOUND");

    const variants = await this.queryIndex<PostVariant>("GSI1", key.item(itemId));
    return {
      ...item,
      variants: variants.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)),
    };
  }

  async getVariant(userId: string, variantId: string): Promise<PostVariant> {
    const v = await this.getRow<PostVariant>(key.user(userId), key.variant(variantId));
    if (!v) throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");
    return v;
  }

  // -- campaigns -----------------------------------------------------------

  async createCampaign(userId: string, draft: CampaignDraft): Promise<Campaign> {
    const campaign: Campaign = {
      ...draft,
      id: `camp_${randomUUID().slice(0, 8)}`,
      userId,
      createdAt: new Date().toISOString(),
    };
    await this.put(key.user(userId), key.campaign(campaign.id), campaign);
    return campaign;
  }

  async listCampaigns(userId: string): Promise<Array<Campaign & { itemCount: number }>> {
    const [campaigns, items] = await Promise.all([
      this.queryPrefix<Campaign>(key.user(userId), "CAMP#"),
      this.queryPrefix<ContentItem>(key.user(userId), "ITEM#"),
    ]);
    return campaigns.map((c) => ({
      ...c,
      itemCount: items.filter((i) => i.campaignId === c.id).length,
    }));
  }

  async getCampaignItems(userId: string, campaignId: string): Promise<ContentItemWithVariants[]> {
    const campaign = await this.getRow<Campaign>(key.user(userId), key.campaign(campaignId));
    if (!campaign) throw new StoreError(`No campaign ${campaignId}`, "NOT_FOUND");

    // GSI1 partitions items by campaign, so this is one query rather than a
    // scan-and-filter over every item the user has.
    const items = await this.queryIndex<ContentItem>("GSI1", key.campaign(campaignId));
    const withVariants = await Promise.all(
      items.map(async (i) => ({
        ...i,
        variants: await this.queryIndex<PostVariant>("GSI1", key.item(i.id)),
      })),
    );
    return withVariants.sort((a, b) => (a.plannedFor ?? "").localeCompare(b.plannedFor ?? ""));
  }

  // -- writes the agent may perform ----------------------------------------

  async createContent(
    userId: string,
    drafts: ContentItemDraft[],
  ): Promise<ContentItemWithVariants[]> {
    const created: ContentItemWithVariants[] = [];

    for (const draft of drafts) {
      const { variants: variantDrafts, ...itemFields } = draft;
      // Validate everything before writing anything, so a bad third variant
      // cannot leave the first two persisted.
      for (const v of variantDrafts) assertVariantValid(this.deps, userId, v);

      const now = new Date().toISOString();
      const { campaignId, ...rest } = itemFields;
      const item: ContentItem = {
        ...rest,
        id: `item_${randomUUID().slice(0, 8)}`,
        userId,
        campaignId: campaignId ?? null,
        plannedFor: null,
        plannedChannelIds: [],
        plannedFormat: null,
        createdAt: now,
        updatedAt: now,
      };

      const variants = variantDrafts.map((v) => this.buildVariant(userId, item.id, v));

      // One transaction per item: either the idea and all of its channel
      // versions land, or none of them do.
      await this.transact([
        this.putOp(key.user(userId), key.item(item.id), item, {
          GSI1PK: item.campaignId ? key.campaign(item.campaignId) : undefined,
          GSI1SK: key.item(item.id),
        }),
        ...variants.flatMap((v) => [this.variantPutOp(v), this.variantPointerOp(v)]),
      ]);

      for (const v of variants) for (const a of v.assetIds) this.media?.markUsed(a);
      created.push({ ...item, variants });
    }

    return created;
  }

  async planSlots(userId: string, slots: PlannedSlot[]): Promise<ContentItem[]> {
    for (const slot of slots) {
      assertHasOffset(slot.plannedFor);
      for (const channelId of slot.plannedChannelIds) {
        const channel = this.connections.getChannel(userId, channelId);
        if (!channel) throw new StoreError(`No channel ${channelId}`, "INVALID_INPUT");
        if (!channel.supportedFormats.includes(slot.plannedFormat)) {
          throw new StoreError(
            `${channel.handle} does not support ${slot.plannedFormat}`,
            "INVALID_INPUT",
          );
        }
      }
    }

    const now = new Date().toISOString();
    const items = slots.map((slot) => {
      const { plannedFor, plannedChannelIds, plannedFormat, campaignId, ...rest } = slot;
      return {
        ...rest,
        id: `item_${randomUUID().slice(0, 8)}`,
        userId,
        campaignId: campaignId ?? null,
        plannedFor,
        plannedChannelIds,
        plannedFormat,
        createdAt: now,
        updatedAt: now,
      } satisfies ContentItem;
    });

    // A transaction caps at 100 items, so a very long plan is chunked.
    for (const batch of chunk(items, 100)) {
      await this.transact(
        batch.map((item) =>
          this.putOp(key.user(userId), key.item(item.id), item, {
            GSI1PK: item.campaignId ? key.campaign(item.campaignId) : undefined,
            GSI1SK: key.item(item.id),
          }),
        ),
      );
    }
    return items;
  }

  async addVariants(
    userId: string,
    itemId: string,
    drafts: VariantDraft[],
  ): Promise<PostVariant[]> {
    await this.getItem(userId, itemId); // ownership + existence
    for (const v of drafts) assertVariantValid(this.deps, userId, v);

    const variants = drafts.map((v) => this.buildVariant(userId, itemId, v));
    await this.transact(variants.flatMap((v) => [this.variantPutOp(v), this.variantPointerOp(v)]));
    for (const v of variants) for (const a of v.assetIds) this.media?.markUsed(a);
    return variants;
  }

  /**
   * Edit the shared idea.
   *
   * Any variant a human had already approved goes back to DRAFT: the approval
   * was given for copy expressing the OLD idea, and once the idea changes that
   * approval no longer means what it meant.
   */
  async updateItem(
    userId: string,
    itemId: string,
    changes: Partial<Omit<ContentItemDraft, "variants">>,
  ): Promise<ContentItemWithVariants> {
    const { variants, ...item } = await this.getItem(userId, itemId);
    const next: ContentItem = { ...item, ...changes, updatedAt: new Date().toISOString() };

    const revoked = variants
      .filter((v) => v.status === "APPROVED" || v.status === "SCHEDULED")
      .map((v) => ({ ...v, status: "DRAFT" as Status, updatedAt: new Date().toISOString() }));

    await this.transact([
      this.putOp(key.user(userId), key.item(itemId), next, {
        GSI1PK: next.campaignId ? key.campaign(next.campaignId) : undefined,
        GSI1SK: key.item(itemId),
      }),
      ...revoked.map((v) => this.variantPutOp(v)),
    ]);

    return this.getItem(userId, itemId);
  }

  async updateVariant(
    userId: string,
    variantId: string,
    changes: Partial<VariantDraft>,
  ): Promise<PostVariant> {
    const variant = await this.getVariant(userId, variantId);

    // Published content is immutable: editing it locally would silently diverge
    // from what is actually live on the platform.
    if (variant.status === "PUBLISHED" || variant.status === "CANCELLED") {
      throw new StoreError(`Cannot edit a ${variant.status} variant`, "INVALID_STATE");
    }

    const next: PostVariant = { ...variant, ...changes, updatedAt: new Date().toISOString() };
    const channel = assertVariantValid(this.deps, userId, next);
    next.platform = channel.platform;

    if ((variant.status === "APPROVED" || variant.status === "SCHEDULED") && !approvalSurvives(changes)) {
      next.status = "DRAFT";
    }

    await this.writeVariant(next);
    return next;
  }

  async requestApproval(userId: string, variantId: string): Promise<PostVariant> {
    return this.transition(userId, variantId, "PENDING_APPROVAL");
  }

  async cancelVariant(userId: string, variantId: string): Promise<PostVariant> {
    const variant = await this.getVariant(userId, variantId);
    // Drop the timer before the status change, or a cancelled post still fires.
    if (variant.scheduleId) await this.scheduler.cancel(variant.scheduleId);
    const next = await this.transition(userId, variantId, "CANCELLED");
    const cleared = { ...next, scheduleId: null };
    await this.writeVariant(cleared);
    return cleared;
  }

  /** The gated write. Every check that protects a real account runs first. */
  async scheduleVariant(
    userId: string,
    variantId: string,
    scheduledFor: string,
    idempotencyKey: string,
  ): Promise<PostVariant> {
    // Replay protection, done as a CONDITIONAL PUT rather than read-then-write.
    // Two concurrent retries racing here would both pass a read check; only one
    // can win a conditional put.
    const claimed = await this.claimIdempotencyKey(userId, idempotencyKey, variantId);
    if (!claimed.won) return this.getVariant(userId, claimed.existingVariantId!);

    const variant = await this.getVariant(userId, variantId);
    assertSchedulable(variant.status, variantId);

    const publishable = this.connections.isPublishable(userId, variant.channelId);
    if (!publishable.ok) {
      throw new StoreError(publishable.reason ?? "Channel cannot publish", "NOT_CONNECTED");
    }

    assertFutureTime(scheduledFor);

    // Create the timer BEFORE marking the row scheduled. If this throws, the
    // variant stays APPROVED and can be retried — the opposite order would
    // leave a row claiming to be scheduled with nothing behind it.
    const job = await this.scheduler.schedule(variantId, scheduledFor, idempotencyKey);

    const next: PostVariant = {
      ...variant,
      status: "SCHEDULED",
      scheduledFor,
      idempotencyKey,
      scheduleId: job.scheduleId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeVariant(next);
    return next;
  }

  /**
   * Move variants in time, atomically.
   *
   * Where MemoryStore unwinds by hand, DynamoDB offers `TransactWriteItems`:
   * up to 100 writes that all land or none do. That is strictly better than a
   * compensating rollback for the database half.
   *
   * The scheduler half still needs compensation, because a timer lives outside
   * the transaction. So: validate, move timers, write rows in one transaction,
   * and undo the timers if the transaction is rejected.
   */
  async rescheduleVariants(
    userId: string,
    moves: Array<{ variantId: string; scheduledFor: string }>,
  ): Promise<PostVariant[]> {
    if (moves.length === 0) throw new StoreError("No moves given", "INVALID_INPUT");
    if (moves.length > 100) {
      throw new StoreError("Too many moves for one transaction (max 100)", "INVALID_INPUT");
    }

    const seen = new Set<string>();
    const planned: Array<{ variant: PostVariant; scheduledFor: string }> = [];

    for (const move of moves) {
      if (seen.has(move.variantId)) {
        throw new StoreError(
          `Variant ${move.variantId} appears twice in one reschedule`,
          "INVALID_INPUT",
        );
      }
      seen.add(move.variantId);

      const variant = await this.getVariant(userId, move.variantId);
      if (variant.status === "PUBLISHED" || variant.status === "CANCELLED") {
        throw new StoreError(
          `Cannot reschedule a ${variant.status} variant (${move.variantId})`,
          "INVALID_STATE",
        );
      }
      assertFutureTime(move.scheduledFor);
      planned.push({ variant, scheduledFor: move.scheduledFor });
    }

    const compensations: Array<() => Promise<void>> = [];
    const next: PostVariant[] = [];

    try {
      for (const { variant, scheduledFor } of planned) {
        let scheduleId = variant.scheduleId;

        if (variant.status === "SCHEDULED") {
          if (variant.scheduleId) {
            await this.scheduler.cancel(variant.scheduleId);
            const oldFireAt = variant.scheduledFor;
            const oldKey = variant.idempotencyKey ?? `${variant.id}@${oldFireAt}`;
            compensations.push(async () => {
              // Recreating a cancelled timer returns a NEW id, so the row has to
              // be told about it. Without this the row keeps pointing at a dead
              // job while a live one is orphaned — and a later cancel silently
              // no-ops against the stale id, leaving the post to fire anyway.
              const restored = await this.scheduler.schedule(variant.id, oldFireAt, oldKey);
              await this.writeVariant({ ...variant, scheduleId: restored.scheduleId });
            });
          }
          const job = await this.scheduler.schedule(
            variant.id,
            scheduledFor,
            `${variant.id}@${scheduledFor}`,
          );
          scheduleId = job.scheduleId;
          compensations.push(() => this.scheduler.cancel(job.scheduleId));
        }

        // Status is untouched: a time change is not a content change, so an
        // approval given for these words still stands.
        next.push({ ...variant, scheduledFor, scheduleId, updatedAt: new Date().toISOString() });
      }

      await this.transact(next.map((v) => this.variantPutOp(v)));
      return next;
    } catch (error) {
      for (const compensate of compensations.reverse()) {
        try {
          await compensate();
        } catch {
          // A failed compensation orphans a timer. In production this is where
          // an outbox row or an alert belongs.
        }
      }
      throw new StoreError(
        `Reschedule failed and was rolled back: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "INVALID_STATE",
      );
    }
  }

  // -- writes only the publisher may perform -------------------------------

  /**
   * The work queue.
   *
   * GSI2 is sparse — only SCHEDULED variants carry a GSI2PK — so this reads a
   * small index of pending work rather than filtering the whole table.
   */
  async getDueVariants(now = new Date()): Promise<PostVariant[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk AND GSI2SK <= :now",
        ExpressionAttributeValues: { ":pk": key.dueStatus(), ":now": now.toISOString() },
      }),
    );
    return (result.Items ?? []).map((i) => strip<PostVariant>(i));
  }

  async markPublished(
    variantId: string,
    platformPostId: string,
    permalink: string | null,
  ): Promise<PostVariant> {
    const variant = await this.findVariantAnyUser(variantId);
    const next: PostVariant = {
      ...variant,
      status: "PUBLISHED",
      platformPostId,
      permalink,
      publishedAt: new Date().toISOString(),
      failureReason: null,
      scheduleId: null, // the timer has fired; nothing left to cancel
      updatedAt: new Date().toISOString(),
    };
    await this.writeVariant(next);
    return next;
  }

  async markFailed(variantId: string, reason: string): Promise<PostVariant> {
    const variant = await this.findVariantAnyUser(variantId);
    const next: PostVariant = {
      ...variant,
      status: "FAILED",
      failureReason: reason,
      scheduleId: null,
      updatedAt: new Date().toISOString(),
    };
    await this.writeVariant(next);
    return next;
  }

  /** A retryable failure leaves the variant SCHEDULED so the next sweep sees it. */
  async recordRetryableFailure(variantId: string, reason: string): Promise<PostVariant> {
    const variant = await this.findVariantAnyUser(variantId);
    const next: PostVariant = {
      ...variant,
      failureReason: reason,
      updatedAt: new Date().toISOString(),
    };
    await this.writeVariant(next);
    return next;
  }

  // -- the write the agent may NOT perform ---------------------------------

  /**
   * Not exposed as a tool. Reached only from an authenticated human action.
   * If you ever find yourself wiring this into a tool, stop — that is the whole
   * safety property of this design.
   */
  async humanApprove(userId: string, variantId: string): Promise<PostVariant> {
    const variant = await this.getVariant(userId, variantId);
    if (variant.status !== "PENDING_APPROVAL" && variant.status !== "DRAFT") {
      throw new StoreError(`Cannot approve a ${variant.status} variant`, "INVALID_STATE");
    }
    const next: PostVariant = {
      ...variant,
      status: "APPROVED",
      updatedAt: new Date().toISOString(),
    };
    await this.writeVariant(next);
    return next;
  }

  /** TEST ONLY. Forces a scheduled time past the past-date guard. */
  async rescheduleForTest(variantId: string, scheduledFor: string): Promise<void> {
    const variant = await this.findVariantAnyUser(variantId);
    await this.writeVariant({ ...variant, scheduledFor });
  }

  // -- internals -----------------------------------------------------------

  private buildVariant(userId: string, itemId: string, draft: VariantDraft): PostVariant {
    const channel = assertVariantValid(this.deps, userId, draft);
    const now = new Date().toISOString();
    return {
      ...draft,
      id: `var_${randomUUID().slice(0, 8)}`,
      itemId,
      userId,
      // Platform is derived from the channel, never supplied by the agent.
      platform: channel.platform,
      status: "DRAFT",
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
      idempotencyKey: null,
      scheduleId: null,
      platformPostId: null,
      permalink: null,
      failureReason: null,
    };
  }

  private async transition(userId: string, variantId: string, to: Status): Promise<PostVariant> {
    const variant = await this.getVariant(userId, variantId);
    assertAgentTransition(variant.status, to);
    const next: PostVariant = { ...variant, status: to, updatedAt: new Date().toISOString() };
    await this.writeVariant(next);
    return next;
  }

  /**
   * GSI2 keys are written ONLY for SCHEDULED variants, which is what keeps the
   * publisher's index sparse. Anything else omits them, and DynamoDB drops the
   * row from the index.
   */
  /** The pointer row that makes findVariantAnyUser possible. */
  private variantPointerOp(v: PostVariant) {
    return this.putOp(key.variant(v.id), "PTR", { userId: v.userId, variantId: v.id });
  }

  private variantPutOp(v: PostVariant) {
    return this.putOp(key.user(v.userId), key.variant(v.id), v, {
      GSI1PK: key.item(v.itemId),
      GSI1SK: key.variant(v.id),
      GSI2PK: v.status === "SCHEDULED" ? key.dueStatus() : undefined,
      GSI2SK: v.status === "SCHEDULED" ? v.scheduledFor : undefined,
    });
  }

  private async writeVariant(v: PostVariant) {
    const op = this.variantPutOp(v);
    await this.client.send(new PutCommand({ TableName: this.table, Item: op.Put.Item }));
  }

  /**
   * Find a variant when there is no userId to hand.
   *
   * The publisher works from a queue, so it has a variant id and nothing else —
   * but every content row is partitioned by user, and a GSI cannot be queried
   * by its sort key alone.
   *
   * The fix is a POINTER ROW: a tiny record at PK=VAR#<id> holding just the
   * owning userId. Two small Gets instead of a Scan, and no third index to pay
   * for on every write. This is the standard DynamoDB answer to "I have the id
   * but not the partition".
   */
  private async findVariantAnyUser(variantId: string): Promise<PostVariant> {
    const pointer = await this.getRow<{ userId: string }>(key.variant(variantId), "PTR");
    if (!pointer) throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");
    return this.getVariant(pointer.userId, variantId);
  }

  /**
   * Claim an idempotency key with a conditional put.
   *
   * Read-then-write would let two concurrent retries both see "not claimed" and
   * both proceed. A conditional put is decided by the database: exactly one
   * wins, and the loser is told who did.
   */
  private async claimIdempotencyKey(
    userId: string,
    idempotencyKey: string,
    variantId: string,
  ): Promise<{ won: boolean; existingVariantId?: string }> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: key.user(userId),
            SK: `IDEM#${idempotencyKey}`,
            variantId,
            claimedAt: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return { won: true };
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        const existing = await this.getRow<{ variantId: string }>(
          key.user(userId),
          `IDEM#${idempotencyKey}`,
        );
        return { won: false, existingVariantId: existing?.variantId ?? variantId };
      }
      throw error;
    }
  }

  private putOp(
    pk: string,
    sk: string,
    body: object,
    indexKeys: Record<string, string | undefined> = {},
  ) {
    const item: Record<string, unknown> = { PK: pk, SK: sk, ...body };
    for (const [k, v] of Object.entries(indexKeys)) {
      if (v !== undefined) item[k] = v;
    }
    return { Put: { TableName: this.table, Item: item } };
  }

  private async put(pk: string, sk: string, body: object) {
    await this.client.send(new PutCommand({ TableName: this.table, Item: { PK: pk, SK: sk, ...body } }));
  }

  private async transact(ops: Array<{ Put: { TableName: string; Item: Record<string, unknown> } }>) {
    if (ops.length === 0) return;
    await this.client.send(new TransactWriteCommand({ TransactItems: ops }));
  }

  private async getRow<T>(pk: string, sk: string): Promise<T | null> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk } }),
    );
    return result.Item ? strip<T>(result.Item) : null;
  }

  private async queryPrefix<T>(pk: string, prefix: string): Promise<T[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": pk, ":sk": prefix },
      }),
    );
    return (result.Items ?? []).map((i) => strip<T>(i));
  }

  private async queryIndex<T>(indexName: string, pk: string): Promise<T[]> {
    const pkAttr = indexName === "GSI1" ? "GSI1PK" : "GSI2PK";
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: indexName,
        KeyConditionExpression: `${pkAttr} = :pk`,
        ExpressionAttributeValues: { ":pk": pk },
      }),
    );
    return (result.Items ?? []).map((i) => strip<T>(i));
  }
}

/** Remove the storage keys so callers only ever see domain objects. */
function strip<T>(row: Record<string, unknown>): T {
  const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...rest } = row;
  return rest as T;
}

function sortKey(item: ContentItemWithVariants): string {
  return item.variants[0]?.scheduledFor ?? item.plannedFor ?? "";
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
