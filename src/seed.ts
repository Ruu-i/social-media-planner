import type {
  BusinessProfile,
  Channel,
  Connection,
  ContentItemWithVariants,
} from "./schemas.js";
import { MemoryStore } from "./store/memory.js";
import { MemoryConnectionStore, type ConnectionStore } from "./store/connections.js";
import { MockScheduler } from "./scheduler/mock.js";
import type { Scheduler } from "./scheduler/types.js";
import type { ContentStore } from "./store/types.js";
import { DynamoStore } from "./store/dynamo.js";
import {
  createDynamoClient,
  createTable,
  dropTable,
  key,
  TABLE_NAME,
} from "./store/dynamo-table.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { MediaStore } from "./store/media.js";
import { aspectRatioOf, type MediaAsset } from "./media/types.js";

export const USER_ID = "user_demo";

export const profile: BusinessProfile = {
  businessName: "Brew & Bean",
  description:
    "A small independent coffee shop roasting our own beans, with a compact food menu and a " +
    "weekend cupping session for people who want to taste properly.",
  industry: "Coffee shop / cafe",
  targetAudience: "18-35 year olds in Colombo who care about good coffee and third-wave culture",
  location: "Colombo, Sri Lanka",
  timezone: "Asia/Colombo",
  tone: "Friendly and a little humorous. Plain-spoken. Never corporate, never salesy.",
  marketingGoal: "Increase Instagram engagement and get more weekday morning footfall",
  postsPerWeek: 4,
  contentPillars: [
    "Coffee education people can use at home",
    "Behind the scenes of roasting and the shop",
    "New drinks and seasonal menu",
    "Community and regulars",
  ],
  bannedWords: ["yummy", "delish", "game-changer", "obsessed", "hustle"],
};

/**
 * TWO connections, one channel each.
 *
 * This said "one Meta connection covering two channels", which is true only of
 * Meta's Facebook Login path — and that path cannot reach Creator accounts at
 * all. Instagram Login and Facebook Pages are separate grants, so they are
 * separate connections, and one expiring no longer takes the other down.
 *
 * Note `tokenRef`: a pointer into a secret store, not a token. Nothing in this
 * process — and certainly nothing the agent can call — holds the real value.
 */
export const seedConnections: Connection[] = [
  {
    id: "conn_ig001",
    userId: USER_ID,
    provider: "instagram",
    status: "ACTIVE",
    tokenRef: "ssm://social-planner/tokens/user_demo/instagram",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    connectedAt: "2026-09-01T09:00:00+05:30",
    expiresAt: "2026-11-01T09:00:00+05:30",
  },
  {
    id: "conn_fb001",
    userId: USER_ID,
    provider: "facebook",
    status: "ACTIVE",
    tokenRef: "ssm://social-planner/tokens/user_demo/facebook",
    scopes: ["pages_show_list", "pages_manage_posts"],
    connectedAt: "2026-09-01T09:00:00+05:30",
    // Separate expiry is the point of splitting them: Instagram going stale
    // must not stop Facebook publishing, and vice versa.
    expiresAt: "2026-12-01T09:00:00+05:30",
  },
];

export const seedChannels: Channel[] = [
  {
    id: "ch_ig001",
    connectionId: "conn_ig001",
    userId: USER_ID,
    platform: "instagram",
    externalId: "17841400000000000",
    handle: "@brewandbean.lk",
    // Publishing does not work with PERSONAL accounts at all — a hard gate,
    // not a preference. CREATOR and BUSINESS both work, but only through
    // Instagram Login; Facebook Login reaches Business accounts alone.
    accountType: "CREATOR",
    supportedFormats: ["POST", "CAROUSEL", "REEL", "STORY"],
    maxCaptionLength: 2200,
    maxHashtags: 30,
  },
  {
    id: "ch_fb001",
    connectionId: "conn_fb001",
    userId: USER_ID,
    platform: "facebook",
    externalId: "1000000000000",
    handle: "Brew & Bean Colombo",
    accountType: "PAGE",
    supportedFormats: ["POST", "CAROUSEL", "REEL", "STORY"],
    maxCaptionLength: 5000,
    // Facebook reads a wall of hashtags as spam. This limit is ours, not Meta's.
    maxHashtags: 3,
  },
];

/**
 * A seeded time, in the BUSINESS's timezone rather than the server's.
 *
 * `setHours` works in whatever zone the process happens to run in. Locally that
 * is Colombo and the seed looked right; in Lambda it is UTC, so "18:00" became
 * 18:00Z — which the UI correctly rendered as 23:30 for a coffee shop that
 * closes at six. The data was never wrong, it was NAIVE, and the server's
 * accidental timezone silently became part of it.
 *
 * The store already refuses datetimes without an offset for exactly this
 * reason. The seed was writing through toISOString, which always produces one,
 * so it satisfied the rule while still being wrong.
 */
function atColomboTime(day: Date, hour: number, minute = 0): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return `${date}T${pad(hour)}:${pad(minute)}:00+05:30`;
}

export function seedContent(): ContentItemWithVariants[] {
  const mondayDate = new Date();
  mondayDate.setDate(mondayDate.getDate() + ((8 - mondayDate.getDay()) % 7 || 7));

  // A separate day, so the calendar shows two distinct groups rather than one
  // pile — which is also what makes the differing statuses legible side by side.
  const saturdayDate = new Date(mondayDate);
  saturdayDate.setDate(saturdayDate.getDate() + 5);

  const monday = atColomboTime(mondayDate, 18);
  const saturday = atColomboTime(saturdayDate, 9);

  const now = new Date().toISOString();

  const base = {
    itemId: "item_seed001",
    userId: USER_ID,
    status: "SCHEDULED" as const,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    idempotencyKey: null,
    platformPostId: null,
    permalink: null,
    failureReason: null,
  };

  return [
    {
      id: "item_seed001",
      userId: USER_ID,
      campaignId: null,
      plannedFor: null,
      plannedChannelIds: [],
      plannedFormat: null,
      topic: "Cold brew relaunch",
      coreMessage: "The cold brew is back for the season: 18 hours steeped, no ice dilution.",
      pillar: "New drinks and seasonal menu",
      contentCategory: "promotional",
      rationale: "Seasonal launch, already committed to.",
      createdAt: now,
      updatedAt: now,
      variants: [
        {
          ...base,
          id: "var_seed001a",
          channelId: "ch_ig001",
          platform: "instagram" as const,
          scheduledFor: monday,
          media: {
            format: "POST" as const,
            imageConcept: "Cold brew poured over a single large ice cube, shot close.",
          },
          hook: "The cold brew is back and it is colder than your ex.",
          caption:
            "The cold brew is back and it is colder than your ex.\n\n18 hours steeped, " +
            "no ice dilution, served in a proper glass. In from tomorrow.",
          assetIds: ["asset_pour01"],
          hashtags: ["coldbrew", "colombocafe", "srilankacoffee"],
          callToAction: "Come try it this week.",
          scheduleId: "sch_seed001a",
        },
        {
          ...base,
          id: "var_seed001b",
          channelId: "ch_fb001",
          platform: "facebook" as const,
          scheduledFor: monday,
          media: {
            format: "POST" as const,
            imageConcept: "Cold brew poured over a single large ice cube, shot close.",
          },
          hook: "Cold brew is back on the menu from tomorrow.",
          caption:
            "Cold brew is back on the menu from tomorrow.\n\nEighteen hours steeped, " +
            "served over one big cube so it does not water down halfway through. " +
            "Same price as last season.",
          assetIds: ["asset_pour01"],
          hashtags: [],
          callToAction: "Open 7am-6pm, come in and try it.",
          scheduleId: "sch_seed001b",
        },
      ],
    },
    /**
     * A draft waiting on the human.
     *
     * Every other seeded post is SCHEDULED, which meant the approval gate — the
     * single most important behaviour in this product — was invisible to anyone
     * opening the app: no post was ever in a state where Approve applied, so the
     * button never rendered and the feature looked absent.
     *
     * One pending item fixes that. It is also the honest demo: this is what the
     * agent actually produces, and what it cannot do next without you.
     */
    {
      id: "item_seed002",
      userId: USER_ID,
      campaignId: null,
      plannedFor: null,
      plannedChannelIds: [],
      plannedFormat: null,
      topic: "Saturday morning regulars",
      coreMessage: "The 7am crowd has its own rhythm, and it is worth showing.",
      pillar: "The people and the place",
      contentCategory: "community",
      rationale: "Balances a promotional week with something human.",
      createdAt: now,
      updatedAt: now,
      variants: [
        {
          ...base,
          // MUST override base's itemId. `base` is shared with item_seed001 and
          // carries its id, so spreading it alone files this variant under the
          // wrong post — it rendered nested inside "Cold brew relaunch".
          itemId: "item_seed002",
          // The agent drafts; it cannot approve. There is no tool that sets
          // this to APPROVED — only the button in the UI can.
          status: "PENDING_APPROVAL" as const,
          id: "var_seed002a",
          channelId: "ch_ig001",
          platform: "instagram" as const,
          scheduledFor: saturday,
          media: {
            format: "POST" as const,
            imageConcept: "The counter at 7am, steam and morning light, no people posing.",
          },
          hook: "Saturday at 7am has its own regulars.",
          caption:
            "Saturday at 7am has its own regulars.\n\nSame seats, same orders, barely " +
            "any talking until the first cup is down. It is the quietest hour we have " +
            "and somehow the busiest.",
          assetIds: ["asset_roaster01"],
          hashtags: ["colombocafe", "morningcoffee", "srilankacoffee"],
          callToAction: "Come find your seat.",
          scheduleId: null,
        },
      ],
    },
  ];
}

/**
 * A demo media library.
 *
 * Descriptions here are pre-written, as if the upload-time vision pass had
 * already run — so the agent has something real to plan against without
 * needing image files on disk. Uploading an actual photo through the CLI runs
 * the real vision pass.
 *
 * Note the deliberate mix of shapes: the 16:9 landscape shot exists so the
 * agent has to notice it cannot be a Reel.
 */
export function seedAssets(): MediaAsset[] {
  const base = (i: number) => ({
    userId: USER_ID,
    uploadedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
    lastUsedAt: null,
    hasTextInFrame: false,
    bytes: 1_400_000,
  });

  const make = (
    id: string,
    i: number,
    kind: "IMAGE" | "VIDEO",
    w: number,
    h: number,
    description: string,
    tags: string[],
    durationSeconds: number | null = null,
  ): MediaAsset => ({
    ...base(i),
    id,
    kind,
    mimeType: kind === "IMAGE" ? "image/jpeg" : "video/mp4",
    filename: `${id.replace("asset_", "")}.${kind === "IMAGE" ? "jpg" : "mp4"}`,
    width: w,
    height: h,
    aspectRatio: aspectRatioOf(w, h),
    durationSeconds,
    storageRef: `${USER_ID}/${id}.${kind === "IMAGE" ? "jpg" : "mp4"}`,
    publicUrl: `https://media.example.invalid/${USER_ID}/${id}`,
    description,
    tags,
    describedFrom: kind === "IMAGE" ? "IMAGE" : "VIDEO_FRAME",
  });

  return [
    make("asset_roaster01", 1, "IMAGE", 1080, 1350,
      "A drum roaster mid-batch in a dim room, beans visible through the sight glass. Warm orange light from the burner, steam rising. Nobody in frame.",
      ["roaster", "roasting", "machine", "close-up", "warm light", "behind the scenes"]),
    make("asset_pour01", 2, "IMAGE", 1080, 1080,
      "Overhead square shot of cold brew being poured over one large clear ice cube in a tall glass, on a pale wooden counter. Condensation on the glass.",
      ["cold brew", "pour", "ice", "drink", "overhead", "counter"]),
    make("asset_cupping01", 3, "IMAGE", 1080, 1350,
      "Five white cupping bowls in a row on a dark counter, spoons resting beside them, crust of grounds still floating on three.",
      ["cupping", "tasting", "bowls", "row", "ritual"]),
    make("asset_shopfront01", 4, "IMAGE", 1920, 1080,
      "Wide landscape shot of the shopfront from across the street in early morning, shutter half up, one person walking past.",
      ["shopfront", "exterior", "street", "morning", "wide"]),
    make("asset_firstcrack01", 5, "VIDEO", 1080, 1920,
      "Vertical clip. Frame shows beans tumbling in the roaster drum shot close, shallow depth of field. Described from the opening frame only — the motion and audio have not been seen.",
      ["roasting", "first crack", "vertical", "video", "process"], 24),
    make("asset_latteart01", 6, "VIDEO", 1080, 1920,
      "Vertical clip. Opening frame is a bare white cup under the steam wand, milk about to be poured. Described from the opening frame only.",
      ["latte art", "milk", "pour", "vertical", "video", "barista"], 11),
  ];
}

export function createMediaStore(): MediaStore {
  return new MediaStore(seedAssets());
}

export function createConnectionStore(): ConnectionStore {
  return new MemoryConnectionStore(seedConnections, seedChannels);
}

export function createSeededStore(
  scheduler: Scheduler = new MockScheduler(),
  media: MediaStore = createMediaStore(),
): MemoryStore {
  return new MemoryStore(profile, createConnectionStore(), scheduler, media, seedContent());
}

/**
 * A store where every grant needs re-authorising.
 *
 * Both are expired explicitly. That used to be unavoidable — one Meta grant
 * backed both platforms, so one dead token took everything down. Now it is a
 * deliberate choice for the test, and the fact that it HAS to be stated is the
 * improvement: Instagram and Facebook can now fail independently.
 */
export function createStoreWithExpiredConnection(): MemoryStore {
  const expired: Connection[] = seedConnections.map((c) => ({
    ...c,
    status: "REAUTH_REQUIRED" as const,
  }));
  return new MemoryStore(
    profile,
    new MemoryConnectionStore(expired, seedChannels),
    new MockScheduler(),
    createMediaStore(),
    seedContent(),
  );
}

/** A store whose Instagram account is personal — Meta cannot publish to it. */
export function createStoreWithPersonalInstagram(): MemoryStore {
  const personal = seedChannels.map((c) =>
    c.platform === "instagram" ? { ...c, accountType: "PERSONAL" as const } : c,
  );
  return new MemoryStore(
    profile,
    new MemoryConnectionStore(seedConnections, personal),
    new MockScheduler(),
    createMediaStore(),
    seedContent(),
  );
}

export { profile as demoProfile, seedChannels as demoChannels };


// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/**
 * Build whichever store STORE says, seeded identically.
 *
 * This exists so the SAME assertion suite runs against both implementations.
 * Parity between an in-memory Map and a database is not something to read the
 * code and believe — it is something to prove by running the tests twice.
 *
 *   STORE=memory  (default)  MemoryStore
 *   STORE=dynamo             DynamoStore against DDB_ENDPOINT
 */
export async function createStore(
  scheduler: Scheduler = new MockScheduler(),
  media: MediaStore = createMediaStore(),
): Promise<ContentStore> {
  if ((process.env.STORE ?? "memory") !== "dynamo") {
    return createSeededStore(scheduler, media);
  }

  const client = createDynamoClient();

  // A fresh table per store keeps tests isolated — the same guarantee the
  // in-memory implementation gets for free by constructing a new Map.
  const table = `${TABLE_NAME}-${Math.random().toString(36).slice(2, 8)}`;
  await dropTable(client, table);
  await createTable(client, table);

  const store = new DynamoStore(
    client,
    profile,
    createConnectionStore(),
    scheduler,
    media,
    table,
  );

  // Write the seed content directly, using the same key scheme the store uses.
  for (const item of seedContent()) {
    const { variants, ...rest } = item;
    await client.send(
      new PutCommand({
        TableName: table,
        Item: { PK: key.user(rest.userId), SK: key.item(rest.id), ...rest },
      }),
    );
    for (const v of variants) {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: key.user(v.userId),
            SK: key.variant(v.id),
            GSI1PK: key.item(v.itemId),
            GSI1SK: key.variant(v.id),
            ...(v.status === "SCHEDULED"
              ? { GSI2PK: key.dueStatus(), GSI2SK: v.scheduledFor }
              : {}),
            ...v,
          },
        }),
      );
      // The pointer row that lets the publisher find a variant by id alone.
      await client.send(
        new PutCommand({
          TableName: table,
          Item: { PK: key.variant(v.id), SK: "PTR", userId: v.userId, variantId: v.id },
        }),
      );
    }
  }

  return store;
}
