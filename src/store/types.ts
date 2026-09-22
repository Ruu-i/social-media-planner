import type {
  BusinessProfile,
  Campaign,
  CampaignDraft,
  ChannelSummary,
  ContentItem,
  ContentItemDraft,
  ContentItemWithVariants,
  PlannedSlot,
  PostVariant,
  Status,
  VariantDraft,
} from "../schemas.js";
import type { ConnectionStore } from "./connections.js";
import type { MediaStore } from "./media.js";

/**
 * The content store interface.
 *
 * EVERY METHOD IS ASYNC, including on the in-memory implementation where
 * nothing actually awaits. That is deliberate: persistence is I/O, and an
 * interface that pretends otherwise cannot be implemented by a database. Making
 * `MemoryStore` return resolved promises costs nothing and means the DynamoDB
 * implementation is a drop-in rather than a rewrite of every call site.
 *
 * This is the seam that lets the same 83 assertions run against both
 * implementations — which is the only way to know they actually behave the
 * same.
 */
export interface ContentStore {
  // -- reads ---------------------------------------------------------------
  getBusinessProfile(userId: string): Promise<BusinessProfile>;
  getConnectedAccounts(userId: string): Promise<ChannelSummary[]>;
  getCalendar(
    userId: string,
    opts?: { from?: string; to?: string; status?: Status },
  ): Promise<ContentItemWithVariants[]>;
  getItem(userId: string, itemId: string): Promise<ContentItemWithVariants>;
  getVariant(userId: string, variantId: string): Promise<PostVariant>;

  // -- campaigns -----------------------------------------------------------
  createCampaign(userId: string, draft: CampaignDraft): Promise<Campaign>;
  listCampaigns(userId: string): Promise<Array<Campaign & { itemCount: number }>>;
  getCampaignItems(userId: string, campaignId: string): Promise<ContentItemWithVariants[]>;

  // -- writes the agent may perform ----------------------------------------
  createContent(userId: string, drafts: ContentItemDraft[]): Promise<ContentItemWithVariants[]>;
  planSlots(userId: string, slots: PlannedSlot[]): Promise<ContentItem[]>;
  addVariants(userId: string, itemId: string, drafts: VariantDraft[]): Promise<PostVariant[]>;
  updateItem(
    userId: string,
    itemId: string,
    changes: Partial<Omit<ContentItemDraft, "variants">>,
  ): Promise<ContentItemWithVariants>;
  updateVariant(
    userId: string,
    variantId: string,
    changes: Partial<VariantDraft>,
  ): Promise<PostVariant>;
  requestApproval(userId: string, variantId: string): Promise<PostVariant>;
  cancelVariant(userId: string, variantId: string): Promise<PostVariant>;
  scheduleVariant(
    userId: string,
    variantId: string,
    scheduledFor: string,
    idempotencyKey: string,
  ): Promise<PostVariant>;
  rescheduleVariants(
    userId: string,
    moves: Array<{ variantId: string; scheduledFor: string }>,
  ): Promise<PostVariant[]>;

  // -- writes only the publisher may perform -------------------------------
  // None of these are tools. Publishing is triggered by a timer firing, never
  // by the model deciding it is time, so there is no path from the agent here.
  getDueVariants(now?: Date): Promise<PostVariant[]>;
  markPublished(
    variantId: string,
    platformPostId: string,
    permalink: string | null,
  ): Promise<PostVariant>;
  markFailed(variantId: string, reason: string): Promise<PostVariant>;
  recordRetryableFailure(variantId: string, reason: string): Promise<PostVariant>;

  // -- the write the agent may NOT perform ---------------------------------
  // Reached only from an authenticated human action. There is no tool for it.
  humanApprove(userId: string, variantId: string): Promise<PostVariant>;

  // -- sub-stores ----------------------------------------------------------
  readonly connectionStore: ConnectionStore;
  readonly mediaStore: MediaStore | null;

  /** TEST ONLY. Forces a scheduled time past the past-date guard. */
  rescheduleForTest(variantId: string, scheduledFor: string): Promise<void>;
}

/**
 * Conversation persistence.
 *
 * Lambda holds no state between invocations, so message history cannot live in
 * a process-local Map. Prompt caching still works across this — the cache is
 * keyed on the message prefix, not on which process assembled it.
 */
export interface ConversationStore {
  load(sessionId: string): Promise<unknown[]>;
  save(sessionId: string, messages: unknown[]): Promise<void>;
}
