/**
 * Media assets: the photos and videos a user uploads.
 *
 * The design rule that governs this whole area:
 *
 *   Look once, at upload. Search descriptions, not pixels. Re-open an image
 *   only when a decision actually turns on it.
 *
 * A photo costs roughly 1,500 tokens. Handing the agent a fifty-asset library on
 * every turn would be ~75,000 tokens per turn — taking a $0.30 planning run to
 * something like $5, and slowing it down badly. So each asset is described ONCE
 * when it is uploaded, and from then on the agent plans against text.
 */

export type MediaKind = "IMAGE" | "VIDEO";

/**
 * Aspect ratio is a first-class field because it decides which formats an asset
 * is even eligible for. A landscape photo in a Reel slot is wrong before anyone
 * reads the caption.
 */
export type AspectRatio = "1:1" | "4:5" | "9:16" | "16:9" | "OTHER";

export interface MediaAsset {
  id: string;
  userId: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;

  width: number;
  height: number;
  aspectRatio: AspectRatio;
  /** Video only. Drives the 3-90s Reel check and the ~15s Story cap. */
  durationSeconds: number | null;

  /** Where the file lives. */
  storageRef: string;
  /**
   * Meta does not accept bytes — it fetches media from a URL you give it. So an
   * asset is unpublishable until it has a publicly reachable address.
   */
  publicUrl: string;

  /** Written once by a vision pass at upload. This is what the agent searches. */
  description: string;
  tags: string[];
  /** Instagram suppresses reach on heavy text overlays, so it is worth knowing. */
  hasTextInFrame: boolean;
  /**
   * Videos are not watched — there is no video input. A video is described from
   * an extracted frame, and this says so rather than letting the agent believe
   * it has seen motion.
   */
  describedFrom: "IMAGE" | "VIDEO_FRAME" | "NOT_DESCRIBED";

  uploadedAt: string;
  lastUsedAt: string | null;
}

/** What the agent sees when listing. No bytes, no storage internals. */
export interface MediaAssetSummary {
  assetId: string;
  kind: MediaKind;
  aspectRatio: AspectRatio;
  durationSeconds: number | null;
  description: string;
  tags: string[];
  hasTextInFrame: boolean;
  describedFrom: MediaAsset["describedFrom"];
  /** Which formats this asset's shape actually allows. */
  suitableFormats: string[];
}

export interface StoredFile {
  storageRef: string;
  publicUrl: string;
}

/** Swap for S3 + CloudFront later; nothing above this changes. */
export interface MediaStorage {
  put(userId: string, filename: string, data: Buffer): Promise<StoredFile>;
  read(storageRef: string): Promise<Buffer>;
}

export function aspectRatioOf(width: number, height: number): AspectRatio {
  if (!width || !height) return "OTHER";
  const r = width / height;
  const near = (target: number) => Math.abs(r - target) < 0.06;
  if (near(1)) return "1:1";
  if (near(4 / 5)) return "4:5";
  if (near(9 / 16)) return "9:16";
  if (near(16 / 9)) return "16:9";
  return "OTHER";
}

/**
 * Which formats an asset can actually be used in.
 *
 * Reels and Stories are vertical surfaces; a 16:9 landscape frame in either is
 * letterboxed into irrelevance. Feed posts take square or 4:5 portrait.
 */
export function suitableFormats(asset: {
  kind: MediaKind;
  aspectRatio: AspectRatio;
  durationSeconds: number | null;
}): string[] {
  const out: string[] = [];
  const vertical = asset.aspectRatio === "9:16";

  if (asset.kind === "VIDEO") {
    const d = asset.durationSeconds ?? 0;
    if (vertical && d >= 3 && d <= 90) out.push("REEL");
    if (vertical && d <= 15) out.push("STORY");
    return out;
  }

  if (asset.aspectRatio === "1:1" || asset.aspectRatio === "4:5") {
    out.push("POST", "CAROUSEL");
  }
  if (vertical) out.push("STORY");
  return out;
}
