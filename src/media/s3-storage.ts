import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { MediaStorage, StoredFile } from "./types.js";

/**
 * Media storage on S3.
 *
 * The deployed counterpart to LocalMediaStorage, and the reason the
 * MediaStorage seam exists. Nothing above this changes: the upload route, the
 * media library and the agent's view of an asset are all identical.
 *
 * Local disk is not merely suboptimal in Lambda, it is broken. The function's
 * working directory is /var/task and that filesystem is READ-ONLY, so writing a
 * relative path there fails with EROFS. Only /tmp is writable, and it is
 * per-container and discarded — an upload would vanish the moment the container
 * was recycled, and would be invisible to every other container in the
 * meantime. There is no version of "keep using the disk" that works.
 */
export class S3MediaStorage implements MediaStorage {
  private client: S3Client;

  constructor(
    private bucket: string,
    private region = process.env.AWS_REGION ?? "us-east-1",
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({ region: this.region });
  }

  async put(userId: string, filename: string, data: Buffer): Promise<StoredFile> {
    const ext = path.extname(filename) || "";
    const key = `${userId}/${randomUUID().slice(0, 12)}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        // Set explicitly, because S3 does not infer it. The default of
        // application/octet-stream makes a browser download the file instead of
        // rendering it, and gives Meta a content type it refuses on fetch — so
        // a perfectly good photo becomes unpublishable over a missing header.
        ContentType: contentTypeFor(ext),
      }),
    );

    return { storageRef: key, publicUrl: this.publicUrl(key) };
  }

  async read(storageRef: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageRef }),
    );
    if (!result.Body) throw new Error(`No body for ${storageRef}`);

    // transformToByteArray is the SDK's own helper. Collecting the stream by
    // hand works too, and is one more place to get backpressure wrong.
    return Buffer.from(await result.Body.transformToByteArray());
  }

  /**
   * The address Meta will fetch from.
   *
   * Unlike LocalMediaStorage's deliberately-fake host, this one resolves. The
   * bucket policy allows public GetObject for exactly this reason: Meta does
   * not accept media bytes on publish, it takes a URL and fetches it, so an
   * unreachable asset is an unpublishable one.
   */
  private publicUrl(key: string): string {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
  }
}

function contentTypeFor(ext: string): string {
  const types: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
  };
  return types[ext.toLowerCase()] ?? "application/octet-stream";
}
