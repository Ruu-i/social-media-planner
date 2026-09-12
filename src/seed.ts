import type {
  BusinessProfile,
  Channel,
  Connection,
  ContentItemWithVariants,
} from "./schemas.js";
import { MemoryStore } from "./store/memory.js";
import { ConnectionStore } from "./store/connections.js";
import { MockScheduler } from "./scheduler/mock.js";
import type { Scheduler } from "./scheduler/types.js";
import { MediaStore } from "./store/media.js";
import { aspectRatioOf, type MediaAsset } from "./media/types.js";

export const USER_ID = "user_demo";

const profile: BusinessProfile = {
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
 * ONE Meta connection covering TWO channels.
 *
 * This is how Meta actually works: a single OAuth grant returns access to an
 * Instagram Business account and the Facebook Page it is linked to. Modelling
 * it as one connection means an expired token correctly breaks both at once,
 * and the user is told to reconnect *Meta* rather than being sent round the
 * loop twice.
 *
 * Note `tokenRef`: a pointer into a secret store, not a token. Nothing in this
 * process — and certainly nothing the agent can call — holds the real value.
 */
const connection: Connection = {
  id: "conn_meta001",
  userId: USER_ID,
  provider: "meta",
  status: "ACTIVE",
  tokenRef: "secretsmanager://brewandbean/meta/user_demo",
  scopes: [
    "instagram_business_basic",
    "instagram_business_content_publish",
    "pages_show_list",
    "pages_manage_posts",
  ],
  connectedAt: "2026-09-01T09:00:00+05:30",
  expiresAt: "2026-11-01T09:00:00+05:30",
};

const channels: Channel[] = [
  {
    id: "ch_ig001",
    connectionId: "conn_meta001",
    userId: USER_ID,
    platform: "instagram",
    externalId: "17841400000000000",
    handle: "@brewandbean.lk",
    // BUSINESS matters: Meta's publishing API does not work with personal
    // Instagram accounts at all, so this is a hard gate, not a preference.
    accountType: "BUSINESS",
    supportedFormats: ["POST", "CAROUSEL", "REEL", "STORY"],
    maxCaptionLength: 2200,
    maxHashtags: 30,
  },
  {
    id: "ch_fb001",
    connectionId: "conn_meta001",
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

/** Content already on the calendar, so the agent has something to plan around. */
function seedContent(): ContentItemWithVariants[] {
  const monday = new Date();
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(18, 0, 0, 0);
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
          scheduledFor: monday.toISOString(),
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
          scheduledFor: monday.toISOString(),
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
function seedAssets(): MediaAsset[] {
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
  return new ConnectionStore([connection], channels);
}

export function createSeededStore(
  scheduler: Scheduler = new MockScheduler(),
  media: MediaStore = createMediaStore(),
): MemoryStore {
  return new MemoryStore(profile, createConnectionStore(), scheduler, media, seedContent());
}

/** A store whose Meta token has expired — both channels go down together. */
export function createStoreWithExpiredConnection(): MemoryStore {
  const expired: Connection = { ...connection, status: "REAUTH_REQUIRED" };
  return new MemoryStore(
    profile,
    new ConnectionStore([expired], channels),
    new MockScheduler(),
    createMediaStore(),
    seedContent(),
  );
}

/** A store whose Instagram account is personal — Meta cannot publish to it. */
export function createStoreWithPersonalInstagram(): MemoryStore {
  const personal = channels.map((c) =>
    c.platform === "instagram" ? { ...c, accountType: "PERSONAL" as const } : c,
  );
  return new MemoryStore(
    profile,
    new ConnectionStore([connection], personal),
    new MockScheduler(),
    createMediaStore(),
    seedContent(),
  );
}

export { profile as demoProfile, channels as demoChannels };
