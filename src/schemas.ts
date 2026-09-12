import { z } from "zod";

/**
 * The domain model. Every `.describe()` is read by the model when a tool schema
 * is generated from these — treat them as prompt text, not developer comments.
 */

// ---------------------------------------------------------------------------
// Connections and channels
// ---------------------------------------------------------------------------

/**
 * A provider is one OAuth grant. Meta is a single grant that returns access to
 * BOTH an Instagram Business account and a Facebook Page — which is why they
 * are the sensible first pair, and why one expired token breaks both at once.
 */
export const ProviderSchema = z.enum(["meta"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const PlatformSchema = z.enum(["instagram", "facebook"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const ConnectionStatusSchema = z.enum(["ACTIVE", "EXPIRED", "REAUTH_REQUIRED"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/**
 * ONE OAUTH GRANT.
 *
 * Note what is absent: the access token. The connection carries only a
 * `tokenRef` — a pointer into the secret store. Tokens never enter the store
 * the agent can read, never appear in a tool result, and never reach the model.
 */
export interface Connection {
  id: string;
  userId: string;
  provider: Provider;
  status: ConnectionStatus;
  /** Pointer into Secrets Manager / KMS. NEVER the token itself. */
  tokenRef: string;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
}

/**
 * ONE PUBLISHABLE DESTINATION under a connection.
 *
 * A user can have two Facebook Pages — same platform, different channels — so
 * content is addressed to a channelId, never to a platform name.
 */
export interface Channel {
  id: string;
  connectionId: string;
  userId: string;
  platform: Platform;
  /** The platform's own id, e.g. an IG Business account id or a Page id. */
  externalId: string;
  handle: string;
  /**
   * Capabilities belong here, not to the platform. An Instagram BUSINESS or
   * CREATOR account can publish through the API; a PERSONAL one cannot, and
   * Meta offers no way around that.
   */
  accountType: "BUSINESS" | "CREATOR" | "PERSONAL" | "PAGE";
  supportedFormats: Format[];
  maxCaptionLength: number;
  maxHashtags: number;
}

/** What the agent is allowed to see about a channel: no ids, no tokens. */
export interface ChannelSummary {
  channelId: string;
  platform: Platform;
  handle: string;
  accountType: Channel["accountType"];
  connectionStatus: ConnectionStatus;
  supportedFormats: Format[];
  maxCaptionLength: number;
  maxHashtags: number;
}

// ---------------------------------------------------------------------------
// Formats — each one needs different fields to be valid
// ---------------------------------------------------------------------------

export const FormatSchema = z.enum(["POST", "CAROUSEL", "REEL", "STORY"]);
export type Format = z.infer<typeof FormatSchema>;

/**
 * A REEL is not a POST with a different label. It needs a duration and a cover
 * frame or it cannot be produced — and the cover is what people actually see in
 * the grid, so leaving it unspecified quietly loses most of the reach.
 *
 * Modelling this as a discriminated union means the type system refuses an
 * under-specified Reel, and the tool schema tells the agent exactly what each
 * format requires instead of hoping the system prompt is remembered.
 */
export const MediaSpecSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("POST"),
    imageConcept: z.string().describe("The single image, described concretely"),
  }),
  z.object({
    format: z.literal("CAROUSEL"),
    cards: z
      .array(z.string())
      .min(2)
      .max(10)
      .describe("2-10 cards in order. The first card carries the hook and must stand alone."),
  }),
  z.object({
    format: z.literal("REEL"),
    durationSeconds: z
      .number()
      .int()
      .min(3)
      .max(90)
      .describe("3-90 seconds. Most viewers leave in the first three."),
    coverFrame: z
      .string()
      .describe("The still shown in the grid. This is what decides whether anyone taps."),
    audio: z.string().describe("Spoken track, music, or natural sound"),
    shotList: z.array(z.string()).min(1).describe("The shots in order"),
  }),
  z.object({
    format: z.literal("STORY"),
    visual: z.string().describe("The image or short clip"),
    interaction: z
      .enum(["none", "poll", "question", "quiz", "link_sticker"])
      .describe("Stories earn replies through stickers, not captions"),
    interactionPrompt: z
      .string()
      .optional()
      .describe("The poll or question text, if there is one"),
  }),
]);
export type MediaSpec = z.infer<typeof MediaSpecSchema>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The state machine IS the human-in-the-loop guarantee, and it lives on the
 * VARIANT, not the item. You approve words, and the Instagram words are not
 * the Facebook words — so they are approved separately.
 *
 *   DRAFT ──agent──> PENDING_APPROVAL ──HUMAN ONLY──> APPROVED
 *                                                        │
 *                                                 agent ─┘
 *                                                        v
 *                                                    SCHEDULED ──> PUBLISHED
 *
 * The agent has no tool that writes APPROVED. Not a restricted tool — no tool.
 */
export const StatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
]);
export type Status = z.infer<typeof StatusSchema>;

export const AGENT_TRANSITIONS: Partial<Record<Status, Status[]>> = {
  DRAFT: ["PENDING_APPROVAL", "CANCELLED"],
  PENDING_APPROVAL: ["DRAFT", "CANCELLED"],
  APPROVED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["CANCELLED"],
};

// ---------------------------------------------------------------------------
// Business profile
// ---------------------------------------------------------------------------

export const BusinessProfileSchema = z.object({
  businessName: z.string(),
  description: z.string(),
  industry: z.string(),
  targetAudience: z.string(),
  location: z.string(),
  timezone: z
    .string()
    .describe("IANA timezone, e.g. Asia/Colombo. All user-facing times are in this zone."),
  tone: z.string(),
  marketingGoal: z.string(),
  postsPerWeek: z.number().int().positive(),
  contentPillars: z.array(z.string()).min(1),
  bannedWords: z.array(z.string()).default([]),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * Several items building toward one goal, in order.
 *
 * This is what makes promotional content an arc — tease, launch, proof, last
 * call — rather than four different ways of saying "come buy this".
 */
export const CampaignDraftSchema = z.object({
  name: z.string(),
  goal: z.string().describe("What this campaign is trying to achieve, concretely"),
  keyMessage: z.string().describe("The one thing every item in it must support"),
  startDate: z.string().describe("ISO date"),
  endDate: z.string().describe("ISO date"),
});
export type CampaignDraft = z.infer<typeof CampaignDraftSchema>;

export interface Campaign extends CampaignDraft {
  id: string;
  userId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Content: the idea, and its per-channel realisations
// ---------------------------------------------------------------------------

/**
 * ONE CHANNEL'S VERSION of an idea. This is what gets approved, scheduled and
 * published.
 *
 * Variants of the same item are ADAPTED, not duplicated. The same caption on
 * Instagram and Facebook is the mark of a lazy scheduler.
 */
export const VariantDraftSchema = z.object({
  channelId: z
    .string()
    .describe("Which channel this goes to — from get_connected_accounts, never a platform name"),
  scheduledFor: z
    .string()
    .describe(
      "ISO 8601 datetime WITH offset, e.g. 2026-09-15T19:00:00+05:30. A value " +
        "without an offset is rejected — the publisher runs in UTC and a naive " +
        "time would fire hours away from what the user asked for.",
    ),
  media: MediaSpecSchema.describe(
    "Format-specific production detail. Each format requires different fields.",
  ),
  assetIds: z
    .array(z.string())
    .default([])
    .describe(
      "Real uploaded assets to use, from list_media_assets or attached by the " +
        "user to their message. REQUIRED whenever the content is built on a file " +
        "that exists: a variant with an empty assetIds publishes with no media " +
        "attached, which is almost never what was wanted. Leave it empty ONLY " +
        "when planning ahead of a shoot — then the media fields act as a brief " +
        "for what to capture. When assets are chosen, write the caption about " +
        "what is actually in them rather than something imagined.",
    ),
  hook: z.string().describe("The opening line. Must earn the next line on its own."),
  caption: z
    .string()
    .describe("Full post body, written FOR THIS CHANNEL in the business's voice"),
  hashtags: z
    .array(z.string())
    .describe(
      "Without the # symbol. Instagram carries hashtags; on Facebook keep them " +
        "to one or two, or none at all.",
    ),
  callToAction: z.string(),
});
export type VariantDraft = z.infer<typeof VariantDraftSchema>;

/**
 * THE IDEA, independent of any channel.
 *
 * `variants` is optional: an item with none is a PLANNED SLOT from phase one of
 * calendar planning — agreed shape, copy not yet written.
 */
export const ContentItemDraftSchema = z.object({
  topic: z.string().describe("Short label for the idea, e.g. 'Cold brew relaunch'"),
  coreMessage: z
    .string()
    .describe("The one thing this content says, channel-independent. One or two sentences."),
  pillar: z.string().describe("Which of the business's content pillars this serves"),
  contentCategory: z
    .string()
    .describe("educational | promotional | engagement | behind-the-scenes"),
  rationale: z.string().describe("One sentence: why this content, this audience, this week"),
  campaignId: z.string().optional().describe("If this item belongs to a campaign"),
  variants: z
    .array(VariantDraftSchema)
    .min(1)
    .describe("One per channel this idea goes to, each written for its own channel"),
});
export type ContentItemDraft = z.infer<typeof ContentItemDraftSchema>;

/** Phase one of planning: the shape of a slot, with no copy written yet. */
export const PlannedSlotSchema = ContentItemDraftSchema.omit({ variants: true }).extend({
  plannedFor: z.string().describe("ISO 8601 datetime WITH offset for this slot"),
  plannedChannelIds: z
    .array(z.string())
    .min(1)
    .describe("Which channels this slot is intended for"),
  plannedFormat: FormatSchema.describe("The format intended for this slot"),
});
export type PlannedSlot = z.infer<typeof PlannedSlotSchema>;

/** Stored forms: drafts plus the fields only the backend may write. */
export interface PostVariant extends VariantDraft {
  id: string;
  itemId: string;
  userId: string;
  /** Resolved from the channel. Denormalised for reading; never agent-supplied. */
  platform: Platform;
  status: Status;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  idempotencyKey: string | null;
  scheduleId: string | null;
  /** The platform's own id once published, so we can link to the live post. */
  platformPostId: string | null;
  permalink: string | null;
  /** Why the last publish attempt failed, if it did. */
  failureReason: string | null;
}

export interface ContentItem
  extends Omit<ContentItemDraft, "variants" | "campaignId"> {
  id: string;
  userId: string;
  campaignId: string | null;
  plannedFor: string | null;
  plannedChannelIds: string[];
  plannedFormat: Format | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentItemWithVariants extends ContentItem {
  variants: PostVariant[];
}
