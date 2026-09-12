import { randomUUID } from "node:crypto";

import type { Scheduler } from "../scheduler/types.js";
import type { ConnectionStore } from "./connections.js";
import type { MediaStore } from "./media.js";
import {
  AGENT_TRANSITIONS,
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

/**
 * In-memory store standing in for DynamoDB.
 *
 * This is deliberately more than two Maps. It is the **backend validation
 * layer** — the component that decides whether an action the agent requested is
 * actually allowed. Swapping this for DynamoDB later changes persistence, not
 * policy, because the policy lives in these methods.
 *
 * The rule this file exists to enforce:
 *
 *   The agent supplies intent. The backend decides authority.
 */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "INVALID_STATE"
      | "INVALID_INPUT"
      | "NOT_CONNECTED",
  ) {
    super(message);
  }
}

export class MemoryStore {
  private items = new Map<string, ContentItem>();
  private variants = new Map<string, PostVariant>();
  private campaigns = new Map<string, Campaign>();
  private idempotencyKeys = new Map<string, string>();

  constructor(
    private profile: BusinessProfile,
    private connections: ConnectionStore,
    private scheduler: Scheduler,
    private media: MediaStore | null,
    seed: ContentItemWithVariants[] = [],
  ) {
    for (const item of seed) {
      const { variants, ...rest } = item;
      this.items.set(item.id, rest);
      for (const v of variants) this.variants.set(v.id, v);
    }
  }

  // -- reads ---------------------------------------------------------------

  getBusinessProfile(_userId: string): BusinessProfile {
    return this.profile;
  }

  getConnectedAccounts(userId: string) {
    return this.connections.listChannels(userId);
  }

  // -- campaigns -----------------------------------------------------------

  createCampaign(userId: string, draft: CampaignDraft): Campaign {
    const campaign: Campaign = {
      ...draft,
      id: `camp_${randomUUID().slice(0, 8)}`,
      userId,
      createdAt: new Date().toISOString(),
    };
    this.campaigns.set(campaign.id, campaign);
    return campaign;
  }

  listCampaigns(userId: string): Array<Campaign & { itemCount: number }> {
    return [...this.campaigns.values()]
      .filter((c) => c.userId === userId)
      .map((c) => ({
        ...c,
        itemCount: [...this.items.values()].filter((i) => i.campaignId === c.id).length,
      }));
  }

  getCampaignItems(userId: string, campaignId: string): ContentItemWithVariants[] {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign || campaign.userId !== userId) {
      throw new StoreError(`No campaign ${campaignId}`, "NOT_FOUND");
    }
    return [...this.items.values()]
      .filter((i) => i.userId === userId && i.campaignId === campaignId)
      .map((i) => ({ ...i, variants: this.variantsOf(i.id) }))
      .sort((a, b) => (a.plannedFor ?? "").localeCompare(b.plannedFor ?? ""));
  }

  /** Items with their variants, filtered by the variants' scheduled dates. */
  getCalendar(
    userId: string,
    opts: { from?: string; to?: string; status?: Status } = {},
  ): ContentItemWithVariants[] {
    const out: ContentItemWithVariants[] = [];
    for (const item of this.items.values()) {
      if (item.userId !== userId) continue;

      const all = this.variantsOf(item.id);
      const variants = all
        .filter((v) => (opts.status ? v.status === opts.status : true))
        .filter((v) => (opts.from ? v.scheduledFor >= opts.from : true))
        .filter((v) => (opts.to ? v.scheduledFor <= opts.to : true));

      if (variants.length > 0) {
        out.push({ ...item, variants });
        continue;
      }

      // A planned slot has no variants yet — copy has not been written. It must
      // still appear on the calendar, or phase-two planning cannot see what
      // phase one agreed, and the agent will plan the same slot twice.
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

  getItem(userId: string, itemId: string): ContentItemWithVariants {
    const item = this.items.get(itemId);
    // Ownership is checked before existence is revealed, so probing for another
    // user's id is indistinguishable from a miss.
    if (!item || item.userId !== userId) {
      throw new StoreError(`No content item ${itemId}`, "NOT_FOUND");
    }
    return { ...item, variants: this.variantsOf(itemId) };
  }

  getVariant(userId: string, variantId: string): PostVariant {
    const variant = this.variants.get(variantId);
    if (!variant || variant.userId !== userId) {
      throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");
    }
    return variant;
  }

  // -- writes the agent may perform ----------------------------------------

  /** Every variant lands in DRAFT. The agent cannot create one in any other state. */
  createContent(userId: string, drafts: ContentItemDraft[]): ContentItemWithVariants[] {
    const created: ContentItemWithVariants[] = [];

    for (const draft of drafts) {
      const { variants: variantDrafts, ...itemFields } = draft;
      // Validate every variant before writing anything, so a bad third variant
      // cannot leave the first two persisted.
      for (const v of variantDrafts) this.assertVariantValid(userId, v);

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
      this.items.set(item.id, item);

      const variants = variantDrafts.map((v) => this.insertVariant(userId, item.id, v));
      created.push({ ...item, variants });
    }

    return created;
  }

  /**
   * Phase one of planning: agree the shape of a month without writing any copy.
   *
   * Writing thirty captions in one turn degrades badly toward the end and
   * produces a response nobody reads. Planning slots first is both cheaper and
   * closer to how people actually work — agree the shape, then write it.
   */
  planSlots(userId: string, slots: PlannedSlot[]): ContentItem[] {
    // Validate every slot before writing any, same rule as content.
    for (const slot of slots) {
      this.assertHasOffset(slot.plannedFor);
      for (const channelId of slot.plannedChannelIds) {
        const channel = this.connections.getChannel(userId, channelId);
        if (!channel) {
          throw new StoreError(`No channel ${channelId}`, "INVALID_INPUT");
        }
        if (!channel.supportedFormats.includes(slot.plannedFormat)) {
          throw new StoreError(
            `${channel.handle} does not support ${slot.plannedFormat}`,
            "INVALID_INPUT",
          );
        }
      }
    }

    return slots.map((slot) => {
      const { plannedFor, plannedChannelIds, plannedFormat, campaignId, ...rest } = slot;
      const now = new Date().toISOString();
      const item: ContentItem = {
        ...rest,
        id: `item_${randomUUID().slice(0, 8)}`,
        userId,
        campaignId: campaignId ?? null,
        plannedFor,
        plannedChannelIds,
        plannedFormat,
        createdAt: now,
        updatedAt: now,
      };
      this.items.set(item.id, item);
      return item;
    });
  }

  /** Fan an existing idea out to more channels. */
  addVariants(userId: string, itemId: string, drafts: VariantDraft[]): PostVariant[] {
    this.getItem(userId, itemId); // ownership + existence
    for (const v of drafts) this.assertVariantValid(userId, v);
    return drafts.map((v) => this.insertVariant(userId, itemId, v));
  }

  /**
   * Edit the shared idea.
   *
   * Any variant that a human had already approved goes back to DRAFT. The
   * approval was given for copy that expressed the OLD idea; once the idea
   * changes, that approval no longer means what it meant.
   */
  updateItem(
    userId: string,
    itemId: string,
    changes: Partial<Omit<ContentItemDraft, "variants">>,
  ): ContentItemWithVariants {
    const { variants, ...item } = this.getItem(userId, itemId);
    const next: ContentItem = { ...item, ...changes, updatedAt: new Date().toISOString() };
    this.items.set(itemId, next);

    for (const v of variants) {
      if (v.status === "APPROVED" || v.status === "SCHEDULED") {
        this.variants.set(v.id, {
          ...v,
          status: "DRAFT",
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return this.getItem(userId, itemId);
  }

  /** Edit one platform's copy or timing. */
  updateVariant(userId: string, variantId: string, changes: Partial<VariantDraft>): PostVariant {
    const variant = this.getVariant(userId, variantId);

    // Published content is immutable. Editing it locally would silently diverge
    // from what is actually live on the platform.
    if (variant.status === "PUBLISHED" || variant.status === "CANCELLED") {
      throw new StoreError(`Cannot edit a ${variant.status} variant`, "INVALID_STATE");
    }

    const next: PostVariant = { ...variant, ...changes, updatedAt: new Date().toISOString() };
    const channel = this.assertVariantValid(userId, next);
    next.platform = channel.platform;

    // The human approved WORDS, not a slot in the calendar. A pure time change
    // keeps the approval; any change to the content itself revokes it.
    // Revoking on a reschedule would be technically safe and infuriating.
    const touchedContent = Object.keys(changes).some((k) => k !== "scheduledFor");
    if ((variant.status === "APPROVED" || variant.status === "SCHEDULED") && touchedContent) {
      next.status = "DRAFT";
    }

    this.variants.set(variantId, next);
    return next;
  }

  requestApproval(userId: string, variantId: string): PostVariant {
    return this.transition(userId, variantId, "PENDING_APPROVAL");
  }

  async cancelVariant(userId: string, variantId: string): Promise<PostVariant> {
    const variant = this.getVariant(userId, variantId);
    // Drop the timer before the status change, or a cancelled post still fires.
    if (variant.scheduleId) await this.scheduler.cancel(variant.scheduleId);
    const next = this.transition(userId, variantId, "CANCELLED");
    this.variants.set(next.id, { ...next, scheduleId: null });
    return this.getVariant(userId, variantId);
  }

  /**
   * The gated write. Every check that protects a real customer account runs
   * here, in backend code, before any I/O — not in the prompt.
   */
  async scheduleVariant(
    userId: string,
    variantId: string,
    scheduledFor: string,
    idempotencyKey: string,
  ): Promise<PostVariant> {
    // Replay protection. An agent loop retry, an SQS redelivery, or a Lambda
    // that timed out *after* the effect landed must not double-post.
    const seen = this.idempotencyKeys.get(idempotencyKey);
    if (seen) return this.getVariant(userId, seen);

    const variant = this.getVariant(userId, variantId);

    if (variant.status !== "APPROVED") {
      throw new StoreError(
        `Variant ${variantId} is ${variant.status}. Only APPROVED variants can be ` +
          `scheduled — a human must approve it first.`,
        "INVALID_STATE",
      );
    }

    const publishable = this.connections.isPublishable(userId, variant.channelId);
    if (!publishable.ok) {
      throw new StoreError(publishable.reason ?? "Channel cannot publish", "NOT_CONNECTED");
    }

    this.assertHasOffset(scheduledFor);
    if (new Date(scheduledFor).getTime() <= Date.now()) {
      throw new StoreError(`${scheduledFor} is in the past`, "INVALID_INPUT");
    }

    // Create the timer BEFORE marking the row scheduled. If this throws, the
    // variant stays APPROVED and the user can retry — the opposite order would
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
    this.variants.set(variantId, next);
    this.idempotencyKeys.set(idempotencyKey, variantId);
    return next;
  }

  /**
   * Move one or more variants in time, atomically.
   *
   * Two things make this more than a field update:
   *
   *   1. A SCHEDULED variant has a timer in existence. Moving the row without
   *      cancelling and recreating that timer means the post still fires at the
   *      old time — a silent, expensive bug.
   *   2. "Push everything back a week" touches many rows. Applied one at a time,
   *      a failure halfway leaves the calendar half-moved, which is worse than
   *      not moving at all.
   *
   * So: validate everything first, then apply, and unwind if the scheduler
   * fails partway. True cross-system atomicity would need an outbox or saga —
   * noted for when EventBridge is real, and out of scope for a mock.
   */
  async rescheduleVariants(
    userId: string,
    moves: Array<{ variantId: string; scheduledFor: string }>,
  ): Promise<PostVariant[]> {
    if (moves.length === 0) {
      throw new StoreError("No moves given", "INVALID_INPUT");
    }

    const seen = new Set<string>();
    const planned: Array<{ variant: PostVariant; scheduledFor: string }> = [];

    // -- phase 1: validate everything, write nothing -------------------------
    for (const move of moves) {
      if (seen.has(move.variantId)) {
        throw new StoreError(
          `Variant ${move.variantId} appears twice in one reschedule`,
          "INVALID_INPUT",
        );
      }
      seen.add(move.variantId);

      const variant = this.getVariant(userId, move.variantId);
      if (variant.status === "PUBLISHED" || variant.status === "CANCELLED") {
        throw new StoreError(
          `Cannot reschedule a ${variant.status} variant (${move.variantId})`,
          "INVALID_STATE",
        );
      }

      this.assertHasOffset(move.scheduledFor);
      if (new Date(move.scheduledFor).getTime() <= Date.now()) {
        throw new StoreError(`${move.scheduledFor} is in the past`, "INVALID_INPUT");
      }

      planned.push({ variant, scheduledFor: move.scheduledFor });
    }

    // -- phase 2: apply, remembering enough to unwind ------------------------
    //
    // Rolling back the rows is not enough. By the time a later move fails, we
    // may already have cancelled and recreated real timers, and those live
    // outside this process. So every scheduler action records a compensating
    // action, and a failure replays them in reverse.
    const applied: PostVariant[] = [];
    const undo: PostVariant[] = [];
    const compensations: Array<() => Promise<void>> = [];

    try {
      for (const { variant, scheduledFor } of planned) {
        let scheduleId = variant.scheduleId;

        if (variant.status === "SCHEDULED") {
          // The timer must move too. Cancel first: a duplicate timer is worse
          // than a missing one, because it publishes twice.
          if (variant.scheduleId) {
            await this.scheduler.cancel(variant.scheduleId);

            // Compensation: put the original timer back. It returns with a new
            // id, so the restored row has to be told about it — a rollback here
            // is a repair, not a byte-for-byte rewind.
            const oldFireAt = variant.scheduledFor;
            const oldKey = variant.idempotencyKey ?? `${variant.id}@${oldFireAt}`;
            compensations.push(async () => {
              const restored = await this.scheduler.schedule(variant.id, oldFireAt, oldKey);
              const current = this.variants.get(variant.id);
              if (current) {
                this.variants.set(variant.id, { ...current, scheduleId: restored.scheduleId });
              }
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

        undo.push(variant);
        const next: PostVariant = {
          ...variant,
          scheduledFor,
          scheduleId,
          // Status is untouched. A time change is not a content change, so an
          // approval given for these words still stands.
          updatedAt: new Date().toISOString(),
        };
        this.variants.set(variant.id, next);
        applied.push(next);
      }
    } catch (error) {
      for (const original of undo) this.variants.set(original.id, original);

      for (const compensate of compensations.reverse()) {
        // A compensation that itself fails leaves a timer orphaned. In
        // production this is where an outbox row or an alert belongs — silently
        // swallowing it is acceptable only because the scheduler is a mock.
        try {
          await compensate();
        } catch {
          // intentionally ignored; see above
        }
      }

      throw new StoreError(
        `Reschedule failed and was rolled back: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "INVALID_STATE",
      );
    }

    return applied;
  }

  // -- writes only the publisher may perform -------------------------------
  //
  // None of these are tools. Publishing is triggered by a timer firing, not by
  // the model deciding it is time — so there is no path from the agent here.

  /** SCHEDULED variants whose moment has arrived. The publisher's work queue. */
  getDueVariants(now = new Date()): PostVariant[] {
    return [...this.variants.values()]
      .filter((v) => v.status === "SCHEDULED")
      .filter((v) => new Date(v.scheduledFor).getTime() <= now.getTime())
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  }

  markPublished(variantId: string, platformPostId: string, permalink: string | null): PostVariant {
    const variant = this.variants.get(variantId);
    if (!variant) throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");

    const next: PostVariant = {
      ...variant,
      status: "PUBLISHED",
      platformPostId,
      permalink,
      publishedAt: new Date().toISOString(),
      failureReason: null,
      // The timer has fired; there is nothing left to cancel.
      scheduleId: null,
      updatedAt: new Date().toISOString(),
    };
    this.variants.set(variantId, next);
    return next;
  }

  markFailed(variantId: string, reason: string): PostVariant {
    const variant = this.variants.get(variantId);
    if (!variant) throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");
    const next: PostVariant = {
      ...variant,
      status: "FAILED",
      failureReason: reason,
      scheduleId: null,
      updatedAt: new Date().toISOString(),
    };
    this.variants.set(variantId, next);
    return next;
  }

  /** A retryable failure leaves the variant SCHEDULED so the next sweep sees it. */
  recordRetryableFailure(variantId: string, reason: string): PostVariant {
    const variant = this.variants.get(variantId);
    if (!variant) throw new StoreError(`No variant ${variantId}`, "NOT_FOUND");
    const next: PostVariant = { ...variant, failureReason: reason, updatedAt: new Date().toISOString() };
    this.variants.set(variantId, next);
    return next;
  }

  /** The publisher needs the channel; the agent only ever gets a summary. */
  get connectionStore() {
    return this.connections;
  }

  get mediaStore() {
    return this.media;
  }

  /**
   * TEST ONLY. Forces a variant's scheduled time, bypassing the past-date check.
   *
   * Needed because the real paths correctly refuse to schedule into the past,
   * which makes "a variant whose moment has arrived" otherwise impossible to
   * construct without waiting. Not exposed as a tool and not used in src/cli.
   */
  rescheduleForTest(variantId: string, scheduledFor: string): void {
    const variant = this.variants.get(variantId);
    if (variant) this.variants.set(variantId, { ...variant, scheduledFor });
  }

  // -- the write the agent may NOT perform ---------------------------------

  /**
   * Not exposed as a tool. Reached only from the CLI's /approve command, which
   * stands in for an authenticated click in the React UI.
   *
   * If you ever find yourself wiring this into a tool, stop — that is the whole
   * safety property of this design.
   */
  humanApprove(userId: string, variantId: string): PostVariant {
    const variant = this.getVariant(userId, variantId);
    if (variant.status !== "PENDING_APPROVAL" && variant.status !== "DRAFT") {
      throw new StoreError(`Cannot approve a ${variant.status} variant`, "INVALID_STATE");
    }
    const next: PostVariant = {
      ...variant,
      status: "APPROVED",
      updatedAt: new Date().toISOString(),
    };
    this.variants.set(variantId, next);
    return next;
  }

  // -- internals -----------------------------------------------------------

  /** Planned slots sort by their intended date; written items by their first variant. */
  private variantsOf(itemId: string): PostVariant[] {
    return [...this.variants.values()]
      .filter((v) => v.itemId === itemId)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  }

  private insertVariant(userId: string, itemId: string, draft: VariantDraft): PostVariant {
    const channel = this.assertVariantValid(userId, draft);
    const now = new Date().toISOString();
    const variant: PostVariant = {
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
    this.variants.set(variant.id, variant);
    for (const assetId of draft.assetIds) this.media?.markUsed(assetId);
    return variant;
  }

  private transition(userId: string, variantId: string, to: Status): PostVariant {
    const variant = this.getVariant(userId, variantId);
    const allowed = AGENT_TRANSITIONS[variant.status] ?? [];
    if (!allowed.includes(to)) {
      throw new StoreError(
        `The agent cannot move a variant from ${variant.status} to ${to}` +
          (to === "APPROVED" ? " — approval requires a human." : ""),
        "FORBIDDEN",
      );
    }
    const next: PostVariant = { ...variant, status: to, updatedAt: new Date().toISOString() };
    this.variants.set(variantId, next);
    return next;
  }

  /** Resolves the channel and checks the variant against what it can do. */
  private assertVariantValid(userId: string, v: VariantDraft) {
    const channel = this.connections.getChannel(userId, v.channelId);
    if (!channel) {
      throw new StoreError(
        `No channel ${v.channelId}. Call get_connected_accounts for valid ids.`,
        "INVALID_INPUT",
      );
    }

    if (!channel.supportedFormats.includes(v.media.format)) {
      throw new StoreError(
        `${channel.handle} (${channel.platform}) does not support ${v.media.format}. ` +
          `It supports: ${channel.supportedFormats.join(", ")}`,
        "INVALID_INPUT",
      );
    }
    if (v.caption.length > channel.maxCaptionLength) {
      throw new StoreError(
        `Caption is ${v.caption.length} characters; ${channel.handle} allows ` +
          `${channel.maxCaptionLength}`,
        "INVALID_INPUT",
      );
    }
    if (v.hashtags.length > channel.maxHashtags) {
      throw new StoreError(
        `${v.hashtags.length} hashtags; ${channel.handle} allows ${channel.maxHashtags}`,
        "INVALID_INPUT",
      );
    }
    // Assets must fit the format they are being used in — a landscape photo in
    // a Reel is wrong before anyone reads the caption.
    if (this.media && v.assetIds.length > 0) {
      this.media.assertSuitableFor(userId, v.assetIds, v.media.format);
    }

    this.assertHasOffset(v.scheduledFor);
    return channel;
  }

  /**
   * A datetime with no offset is the bug that publishes five and a half hours
   * late in Colombo. Reject it at the boundary rather than storing something
   * whose meaning depends on which machine reads it.
   */
  private assertHasOffset(value: string) {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
      throw new StoreError(
        `"${value}" has no timezone offset. Use a full ISO 8601 value such as ` +
          `2026-09-14T11:00:00+05:30 so the time means the same thing everywhere.`,
        "INVALID_INPUT",
      );
    }
    if (Number.isNaN(new Date(value).getTime())) {
      throw new StoreError(`"${value}" is not a valid datetime`, "INVALID_INPUT");
    }
  }
}

function sortKey(item: ContentItemWithVariants): string {
  return item.variants[0]?.scheduledFor ?? item.plannedFor ?? "";
}
