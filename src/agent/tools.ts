import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import {
  CampaignDraftSchema,
  FormatSchema,
  ContentItemDraftSchema,
  PlannedSlotSchema,
  StatusSchema,
  VariantDraftSchema,
} from "../schemas.js";
import { StoreError } from "../store/memory.js";
import type { ContentStore } from "../store/types.js";
import { MediaError } from "../store/media.js";
import type { MediaStorage } from "../media/types.js";
import { canDescribe } from "../media/describe.js";

/**
 * The agent's tool surface.
 *
 * Three rules govern everything in this file.
 *
 * 1. TOOLS ARE FOR WHAT THE MODEL CANNOT KNOW OR CANNOT DO.
 *    Reading state it has no access to; causing effects outside the
 *    conversation. There is deliberately no `generate_caption` tool — captions
 *    are the model's *output*, written in its turn and passed as arguments.
 *    A generate-tool would mean the LLM calling a tool that calls an LLM:
 *    double the cost, and copy written without knowledge of the rest of the week.
 *
 * 2. userId IS NEVER A TOOL PARAMETER.
 *    It is closed over from the authenticated session below. If the model could
 *    pass a userId, anything that talked it into passing a different one becomes
 *    an account takeover. The model cannot name what it cannot reach.
 *
 * 3. IDEAS AND THEIR PLATFORM VERSIONS ARE SEPARATE.
 *    A content item is the idea; a variant is one platform's realisation of it.
 *    Approval and scheduling happen on variants, because what a human approves
 *    is words — and the Instagram words are not the Facebook words.
 */

export interface Session {
  userId: string;
}

/** Optional: lets get_media_asset return the actual image for a close look. */
export interface ToolDeps {
  storage?: MediaStorage;
}

/** Tool failures are returned to the model as data, not thrown. */
function fail(error: unknown): string {
  if (error instanceof StoreError || error instanceof MediaError) {
    return JSON.stringify({ ok: false, error: error.code, message: error.message });
  }
  return JSON.stringify({
    ok: false,
    error: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  });
}

function ok(data: unknown): string {
  return JSON.stringify({ ok: true, ...(data as object) });
}

export function createTools(store: ContentStore, session: Session, deps: ToolDeps = {}) {
  const { userId } = session;

  // -- reads ---------------------------------------------------------------

  const getBusinessProfile = betaZodTool({
    name: "get_business_profile",
    description:
      "Get the business profile: name, description, audience, location, timezone, tone, " +
      "marketing goal, posting frequency, content pillars and banned words. Call this " +
      "before planning or writing anything — it defines the voice you must write in.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        return ok({ profile: await store.getBusinessProfile(userId) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getConnectedAccounts = betaZodTool({
    name: "get_connected_accounts",
    description:
      "List the user's channels and what each can actually do: whether it is connected, " +
      "which formats it supports (POST, CAROUSEL, REEL, STORY), and its caption length " +
      "limit. Instagram and Facebook come from a single Meta connection, so they are " +
      "usually both available or both broken together. Call this before promising the " +
      "user any specific format — a disconnected channel cannot be scheduled to.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        return ok({ accounts: await store.getConnectedAccounts(userId) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getCalendar = betaZodTool({
    name: "get_calendar",
    description:
      "List content items and their per-platform variants in a date range, with statuses. " +
      "ALWAYS call this before creating new content, so you do not repeat a topic, clash " +
      "with something already planned, or exceed the posting frequency. Returns everything " +
      "including drafts awaiting approval.",
    inputSchema: z.object({
      from: z.string().describe("ISO date, inclusive, e.g. 2026-09-14"),
      to: z.string().describe("ISO date, inclusive, e.g. 2026-09-21"),
      status: StatusSchema.optional().describe("Optional filter to one status"),
    }),
    run: async (args) => {
      try {
        const items = await store.getCalendar(userId, args);
        return ok({
          count: items.length,
          // Captions are omitted here on purpose: a listing is for orientation,
          // and full copy for a month of content would flood the context.
          // Use get_content_item when you need the actual wording.
          items: items.map((i) => ({
            itemId: i.id,
            topic: i.topic,
            pillar: i.pillar,
            contentCategory: i.contentCategory,
            campaignId: i.campaignId,
            // A slot with no variants is planned but unwritten — phase one
            // agreed it, the copy has not been written yet.
            planned:
              i.variants.length === 0 && i.plannedFor
                ? {
                    plannedFor: i.plannedFor,
                    plannedFormat: i.plannedFormat,
                    plannedChannelIds: i.plannedChannelIds,
                    needsCopy: true,
                  }
                : undefined,
            variants: i.variants.map((v) => ({
              variantId: v.id,
              platform: v.platform,
              channelId: v.channelId,
              format: v.media.format,
              scheduledFor: v.scheduledFor,
              status: v.status,
              hook: v.hook,
            })),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getContentItem = betaZodTool({
    name: "get_content_item",
    description:
      "Get one content item in full — the shared idea plus every variant's complete " +
      "caption and hashtags. Use this when revising something and you need to see the " +
      "current wording.",
    inputSchema: z.object({ itemId: z.string() }),
    run: async (args) => {
      try {
        return ok({ item: await store.getItem(userId, args.itemId) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  // -- writes --------------------------------------------------------------

  const saveContent = betaZodTool({
    name: "save_content",
    description:
      "Save content you have written. Each item is ONE IDEA, carrying one variant per " +
      "channel it goes to. Write every caption yourself and pass them here — this tool " +
      "stores what you wrote, it does not generate anything.\n\n" +
      "Save a whole plan in ONE call rather than one call per item, so the content is " +
      "written as a coherent set.\n\n" +
      "When an idea goes to both Instagram and Facebook, create ONE item with TWO " +
      "variants — never two separate items. Write each variant for its own platform: " +
      "Instagram carries hashtags and cannot have clickable links in the caption; " +
      "Facebook tolerates links and punishes hashtag stuffing. Copy-pasting the same " +
      "caption into both is not acceptable. All variants are saved as DRAFT.",
    inputSchema: z.object({ items: z.array(ContentItemDraftSchema).min(1) }),
    run: async (args) => {
      try {
        const created = await store.createContent(userId, args.items);
        return ok({
          created: created.map((i) => ({
            itemId: i.id,
            topic: i.topic,
            variants: i.variants.map((v) => ({
              variantId: v.id,
              platform: v.platform,
              format: v.media.format,
              scheduledFor: v.scheduledFor,
              status: v.status,
            })),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const addVariants = betaZodTool({
    name: "add_variants",
    description:
      "Add more channels to an existing idea — e.g. the user says 'put the Wednesday one " +
      "on Facebook too'. Write the new variant FOR ITS PLATFORM rather than copying the " +
      "existing caption. Use this instead of save_content, so both versions stay attached " +
      "to the same idea and can be revised together.",
    inputSchema: z.object({
      itemId: z.string(),
      variants: z.array(VariantDraftSchema).min(1),
    }),
    run: async (args) => {
      try {
        const added = await store.addVariants(userId, args.itemId, args.variants);
        return ok({
          added: added.map((v) => ({
            variantId: v.id,
            platform: v.platform,
            format: v.media.format,
            status: v.status,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const updateContentItem = betaZodTool({
    name: "update_content_item",
    description:
      "Change the shared IDEA — its topic, core message, media concept, pillar or " +
      "category. Use this when the change affects every platform.\n\n" +
      "Important: this returns all approved variants of the item to DRAFT, because the " +
      "human approved copy expressing the old idea. After changing an item you should " +
      "normally rewrite its variants with update_variant to match.",
    inputSchema: z.object({
      itemId: z.string(),
      changes: ContentItemDraftSchema.omit({ variants: true })
        .partial()
        .describe("Only the fields being changed"),
    }),
    run: async (args) => {
      try {
        const item = await store.updateItem(userId, args.itemId, args.changes);
        return ok({
          itemId: item.id,
          variants: item.variants.map((v) => ({ variantId: v.id, status: v.status })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const updateVariant = betaZodTool({
    name: "update_variant",
    description:
      "Change ONE platform's version — its caption, hashtags, format or timing. Use this " +
      "for 'make the Instagram one funnier' or 'move Wednesday to Friday'.\n\n" +
      "Changing only scheduledFor keeps any existing approval, because the human approved " +
      "the words rather than the slot. Changing the copy returns it to DRAFT.",
    inputSchema: z.object({
      variantId: z.string(),
      changes: VariantDraftSchema.partial().describe("Only the fields being changed"),
    }),
    run: async (args) => {
      try {
        const v = await store.updateVariant(userId, args.variantId, args.changes);
        return ok({ variantId: v.id, status: v.status, scheduledFor: v.scheduledFor });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const requestApproval = betaZodTool({
    name: "request_approval",
    description:
      "Submit variants for human review, moving them to PENDING_APPROVAL. This is as far " +
      "as you can take content on your own. You CANNOT approve it — only the user can, in " +
      "the UI. After calling this, tell the user what is waiting for them.",
    inputSchema: z.object({ variantIds: z.array(z.string()).min(1) }),
    run: async (args) => {
      // Sequential rather than parallel: these are small writes, and a partial
      // failure is easier to report back when the order is deterministic.
      const results: Array<Record<string, unknown>> = [];
      for (const id of args.variantIds) {
        try {
          const v = await store.requestApproval(userId, id);
          results.push({ variantId: id, status: v.status });
        } catch (e) {
          results.push({ variantId: id, error: JSON.parse(fail(e)) });
        }
      }
      return ok({ results });
    },
  });

  const cancelVariant = betaZodTool({
    name: "cancel_variant",
    description:
      "Cancel one platform's version so it will not be published. The idea and its other " +
      "variants are untouched — use this for 'drop the Facebook one'.",
    inputSchema: z.object({ variantId: z.string() }),
    run: async (args) => {
      try {
        const v = await store.cancelVariant(userId, args.variantId);
        return ok({ variantId: v.id, status: v.status });
      } catch (e) {
        return fail(e);
      }
    },
  });

  /**
   * The gated tool. The only one that causes an irreversible external effect,
   * and every check that matters lives behind it in the store.
   *
   * The idempotency key is required rather than optional: making it a parameter
   * the model must supply means a retried identical call carries the same key
   * and collapses to one schedule instead of two.
   */
  const scheduleVariant = betaZodTool({
    name: "schedule_variant",
    description:
      "Schedule an APPROVED variant for publishing. Fails if a human has not approved it, " +
      "if the channel is not connected, or if the time is in the past. Supply a stable " +
      "idempotencyKey built from the variant id and time (e.g. 'var_1a2b3c@2026-09-14T11:00') " +
      "so retrying this call can never double-post.",
    inputSchema: z.object({
      variantId: z.string(),
      scheduledFor: z.string().describe("ISO 8601 datetime WITH offset"),
      idempotencyKey: z.string().describe("Stable key, e.g. '<variantId>@<scheduledFor>'"),
    }),
    run: async (args) => {
      try {
        const v = await store.scheduleVariant(
          userId,
          args.variantId,
          args.scheduledFor,
          args.idempotencyKey,
        );
        return ok({ variantId: v.id, status: v.status, scheduledFor: v.scheduledFor });
      } catch (e) {
        return fail(e);
      }
    },
  });

  /**
   * Bulk, atomic time moves. Distinct from update_variant for two reasons:
   * a SCHEDULED variant has a live timer that must move with it, and "push
   * everything back a week" must not half-apply.
   */
  const rescheduleVariants = betaZodTool({
    name: "reschedule_variants",
    description:
      "Move one or more variants to new times, all together or not at all. Use this " +
      "instead of repeated update_variant calls whenever more than one thing moves — " +
      "'push everything back a week', 'we're closed Monday, shift those', 'move the " +
      "whole campaign to after the delivery'.\n\n" +
      "Already-scheduled variants have their underlying timer cancelled and recreated, " +
      "which update_variant does not do. Approvals are preserved: moving content in " +
      "time does not change the words a human approved. If any move is invalid the " +
      "whole batch is rejected and nothing changes.",
    inputSchema: z.object({
      moves: z
        .array(
          z.object({
            variantId: z.string(),
            scheduledFor: z.string().describe("New ISO 8601 datetime WITH offset"),
          }),
        )
        .min(1)
        .describe("Every variant to move, with its new time. Each variant at most once."),
    }),
    run: async (args) => {
      try {
        const moved = await store.rescheduleVariants(userId, args.moves);
        return ok({
          moved: moved.map((v) => ({
            variantId: v.id,
            platform: v.platform,
            scheduledFor: v.scheduledFor,
            status: v.status,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  // -- media ---------------------------------------------------------------

  const listMediaAssets = betaZodTool({
    name: "list_media_assets",
    description:
      "Search the user's uploaded photos and videos by what is IN them. Returns " +
      "descriptions written when each file was uploaded — not the images themselves, " +
      "which keeps this cheap enough to call freely.\n\n" +
      "Call this before writing content whenever real assets might exist. A caption " +
      "written about a photo that actually exists is far better than one describing a " +
      "shot the user still has to take.\n\n" +
      "Each result lists suitableFormats: an asset's shape decides what it can be. A " +
      "9:16 clip can be a Reel or a Story; a 16:9 landscape photo can be neither.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Words to match against descriptions and tags, e.g. 'roaster morning'"),
      kind: z.enum(["IMAGE", "VIDEO"]).optional(),
      format: FormatSchema.optional().describe("Only assets usable as this format"),
      unusedOnly: z.boolean().optional().describe("Only assets not yet used in a post"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: (args) => {
      const media = store.mediaStore;
      if (!media) return ok({ assets: [], note: "No media library is configured." });
      try {
        return ok({ assets: media.search(userId, args) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getMediaAsset = betaZodTool({
    name: "get_media_asset",
    description:
      "Get one asset in full. Set includeImage to actually LOOK at the picture — use " +
      "that only when a decision genuinely turns on seeing it, such as choosing between " +
      "two similar shots or writing a caption about a specific visual detail. Every " +
      "image you open costs roughly 1,500 tokens, so plan from descriptions and open " +
      "images sparingly.",
    inputSchema: z.object({
      assetId: z.string(),
      includeImage: z
        .boolean()
        .default(false)
        .describe("Return the actual image so you can see it. Use sparingly."),
    }),
    run: async (args) => {
      const media = store.mediaStore;
      if (!media) return fail(new StoreError("No media library", "NOT_FOUND"));
      try {
        const summary = media.summarise(userId, args.assetId);
        if (!args.includeImage || !deps.storage) return ok({ asset: summary });

        const asset = media.get(userId, args.assetId);
        if (!canDescribe(asset.mimeType)) {
          return ok({
            asset: summary,
            note: `${asset.mimeType} cannot be viewed directly. Videos are described from an extracted frame.`,
          });
        }

        const bytes = await deps.storage.read(asset.storageRef);
        // A tool result may carry image blocks, so the agent can genuinely see
        // the photo rather than reason about a description of it.
        return [
          { type: "text", text: JSON.stringify({ ok: true, asset: summary }) },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: asset.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: bytes.toString("base64"),
            },
          },
        ];
      } catch (e) {
        return fail(e);
      }
    },
  });

  // -- campaigns and two-phase planning ------------------------------------

  const createCampaign = betaZodTool({
    name: "create_campaign",
    description:
      "Create a campaign: several pieces of content building toward one goal, in order. " +
      "Use this when the user wants to promote something over days or weeks rather than " +
      "post once — a launch, an event, a seasonal push. Content created afterwards can be " +
      "attached to it by passing campaignId, which lets you build a real arc (tease, " +
      "launch, proof, last call) instead of four variations of the same announcement.",
    inputSchema: CampaignDraftSchema,
    run: async (args) => {
      try {
        const c = await store.createCampaign(userId, args);
        return ok({ campaignId: c.id, name: c.name });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getCampaigns = betaZodTool({
    name: "get_campaigns",
    description:
      "List campaigns with how many content items each has. Use get_campaign_items to see " +
      "the arc before adding to one, so the new piece continues the story rather than " +
      "repeating an earlier beat.",
    inputSchema: z.object({}),
    run: async () => {
      try {
        return ok({ campaigns: await store.listCampaigns(userId) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getCampaignItems = betaZodTool({
    name: "get_campaign_items",
    description: "Every content item in one campaign, in planned order, with its variants.",
    inputSchema: z.object({ campaignId: z.string() }),
    run: async (args) => {
      try {
        return ok({ items: await store.getCampaignItems(userId, args.campaignId) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const planCalendar = betaZodTool({
    name: "plan_calendar",
    description:
      "PHASE ONE of planning: agree the shape of a period without writing any copy. Each " +
      "slot carries a topic, core message, pillar, intended channels, format and date — " +
      "but no caption.\n\n" +
      "Use this for anything longer than about a week. Writing thirty captions in one turn " +
      "produces weak copy toward the end and a wall of text nobody reads; agreeing the " +
      "shape first is faster, cheaper, and how people actually work. Show the user the " +
      "plan, then fill the copy in batches with write_slot_copy as they approve the shape.\n\n" +
      "For a single week, prefer save_content and write the copy directly.",
    inputSchema: z.object({
      slots: z.array(PlannedSlotSchema).min(1),
    }),
    run: async (args) => {
      try {
        const items = await store.planSlots(userId, args.slots);
        return ok({
          planned: items.map((i) => ({
            itemId: i.id,
            topic: i.topic,
            plannedFor: i.plannedFor,
            plannedFormat: i.plannedFormat,
            plannedChannelIds: i.plannedChannelIds,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const writeSlotCopy = betaZodTool({
    name: "write_slot_copy",
    description:
      "PHASE TWO of planning: write the actual copy for a slot that plan_calendar created. " +
      "Pass one variant per channel the slot is intended for, each written for its own " +
      "channel. Work in batches — a week at a time is a good unit.",
    inputSchema: z.object({
      itemId: z.string(),
      variants: z.array(VariantDraftSchema).min(1),
    }),
    run: async (args) => {
      try {
        const added = await store.addVariants(userId, args.itemId, args.variants);
        return ok({
          itemId: args.itemId,
          written: added.map((v) => ({
            variantId: v.id,
            platform: v.platform,
            format: v.media.format,
            status: v.status,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  });

  // Note what is absent: no approve_variant, no publish_now, no run_query.
  return [
    getBusinessProfile,
    getConnectedAccounts,
    getCalendar,
    getContentItem,
    saveContent,
    addVariants,
    updateContentItem,
    updateVariant,
    requestApproval,
    cancelVariant,
    scheduleVariant,
    rescheduleVariants,
    listMediaAssets,
    getMediaAsset,
    createCampaign,
    getCampaigns,
    getCampaignItems,
    planCalendar,
    writeSlotCopy,
  ];
}
