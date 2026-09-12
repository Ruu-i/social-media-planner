import { randomUUID } from "node:crypto";

import {
  aspectRatioOf,
  suitableFormats,
  type AspectRatio,
  type MediaAsset,
  type MediaAssetSummary,
  type MediaKind,
} from "../media/types.js";

/**
 * The media library.
 *
 * Separate from the content store because it has a different shape of access:
 * content is planned and revised, assets are uploaded once and then searched
 * many times. Keeping them apart also keeps the expensive thing — image bytes —
 * behind an explicit `readBytes` call that nothing in the planning path touches.
 */

export class MediaError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID_INPUT" | "UNSUITABLE",
  ) {
    super(message);
  }
}

export interface NewAsset {
  userId: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds?: number | null;
  storageRef: string;
  publicUrl: string;
  description: string;
  tags: string[];
  hasTextInFrame?: boolean;
  describedFrom?: MediaAsset["describedFrom"];
}

export class MediaStore {
  private assets = new Map<string, MediaAsset>();

  constructor(seed: MediaAsset[] = []) {
    for (const a of seed) this.assets.set(a.id, a);
  }

  add(input: NewAsset): MediaAsset {
    const asset: MediaAsset = {
      ...input,
      id: `asset_${randomUUID().slice(0, 8)}`,
      aspectRatio: aspectRatioOf(input.width, input.height),
      durationSeconds: input.durationSeconds ?? null,
      hasTextInFrame: input.hasTextInFrame ?? false,
      describedFrom: input.describedFrom ?? "IMAGE",
      uploadedAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  get(userId: string, assetId: string): MediaAsset {
    const asset = this.assets.get(assetId);
    if (!asset || asset.userId !== userId) {
      throw new MediaError(`No asset ${assetId}`, "NOT_FOUND");
    }
    return asset;
  }

  /**
   * Search by description and tags — text only, never bytes.
   *
   * This is the method that keeps the feature affordable. The agent plans
   * against these summaries and only opens an actual image when a choice
   * between close candidates depends on seeing it.
   */
  search(
    userId: string,
    opts: {
      query?: string;
      kind?: MediaKind;
      aspectRatio?: AspectRatio;
      format?: string;
      unusedOnly?: boolean;
      limit?: number;
    } = {},
  ): MediaAssetSummary[] {
    const q = opts.query?.toLowerCase().trim();

    return [...this.assets.values()]
      .filter((a) => a.userId === userId)
      .filter((a) => (opts.kind ? a.kind === opts.kind : true))
      .filter((a) => (opts.aspectRatio ? a.aspectRatio === opts.aspectRatio : true))
      .filter((a) => (opts.unusedOnly ? a.lastUsedAt === null : true))
      .filter((a) => (opts.format ? suitableFormats(a).includes(opts.format) : true))
      .filter((a) => {
        if (!q) return true;
        const haystack = `${a.description} ${a.tags.join(" ")}`.toLowerCase();
        // Every word must appear somewhere — a plain AND match. Good enough for
        // a library this size; swap for OpenSearch or embeddings when it is not.
        return q.split(/\s+/).every((word) => haystack.includes(word));
      })
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .slice(0, opts.limit ?? 20)
      .map((a) => this.toSummary(a));
  }

  summarise(userId: string, assetId: string): MediaAssetSummary {
    return this.toSummary(this.get(userId, assetId));
  }

  markUsed(assetId: string): void {
    const asset = this.assets.get(assetId);
    if (asset) {
      this.assets.set(assetId, { ...asset, lastUsedAt: new Date().toISOString() });
    }
  }

  /**
   * Check a set of assets against the format they are about to be used in.
   *
   * This is the same move as the format discriminated union: refuse it in code
   * rather than hoping the system prompt is remembered. A 16:9 landscape shot
   * in a Reel is wrong before anyone reads the caption.
   */
  assertSuitableFor(userId: string, assetIds: string[], format: string): void {
    if (assetIds.length === 0) return;

    const assets = assetIds.map((id) => this.get(userId, id));

    const expected: Record<string, [number, number]> = {
      POST: [1, 1],
      CAROUSEL: [2, 10],
      REEL: [1, 1],
      STORY: [1, 1],
    };
    const range = expected[format];
    if (range && (assets.length < range[0] || assets.length > range[1])) {
      throw new MediaError(
        `${format} takes ${range[0] === range[1] ? range[0] : `${range[0]}-${range[1]}`} ` +
          `asset(s); ${assets.length} given`,
        "INVALID_INPUT",
      );
    }

    for (const asset of assets) {
      const allowed = suitableFormats(asset);
      if (!allowed.includes(format)) {
        throw new MediaError(
          `${asset.id} (${asset.kind}, ${asset.aspectRatio}` +
            `${asset.durationSeconds ? `, ${asset.durationSeconds}s` : ""}) cannot be used ` +
            `as a ${format}. It suits: ${allowed.join(", ") || "nothing — wrong shape"}.`,
          "UNSUITABLE",
        );
      }
      if (!asset.publicUrl) {
        throw new MediaError(
          `${asset.id} has no public URL — Meta fetches media by URL and cannot publish it`,
          "INVALID_INPUT",
        );
      }
    }
  }

  private toSummary(a: MediaAsset): MediaAssetSummary {
    return {
      assetId: a.id,
      kind: a.kind,
      aspectRatio: a.aspectRatio,
      durationSeconds: a.durationSeconds,
      description: a.description,
      tags: a.tags,
      hasTextInFrame: a.hasTextInFrame,
      describedFrom: a.describedFrom,
      suitableFormats: suitableFormats(a),
      // Note what is absent: storageRef, publicUrl, bytes, userId.
    };
  }
}
