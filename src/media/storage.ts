import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { MediaStorage, StoredFile } from "./types.js";

/**
 * Local disk storage, standing in for S3 + CloudFront.
 *
 * The `publicUrl` it returns is fake, and deliberately says so. That matters
 * because Meta does not accept media bytes — it fetches from a URL you hand it —
 * so an asset without a genuinely reachable address is unpublishable no matter
 * how good the photo is. Returning an obviously-fake URL here keeps that
 * requirement visible instead of letting it surface at the first real publish.
 */
export class LocalMediaStorage implements MediaStorage {
  constructor(
    private root = "media",
    private baseUrl = "https://media.example.invalid",
  ) {}

  async put(userId: string, filename: string, data: Buffer): Promise<StoredFile> {
    const ext = path.extname(filename) || "";
    const key = `${userId}/${randomUUID().slice(0, 12)}${ext}`;
    const full = path.join(this.root, key);

    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);

    return { storageRef: key, publicUrl: `${this.baseUrl}/${key}` };
  }

  async read(storageRef: string): Promise<Buffer> {
    return readFile(path.join(this.root, storageRef));
  }
}
