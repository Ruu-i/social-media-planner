import { randomUUID } from "node:crypto";

import type { Platform, Provider } from "../schemas.js";
import {
  PublishError,
  type PublishFailureKind,
  type PublishRequest,
  type PublishResult,
  type SocialConnector,
  type TokenProvider,
} from "./types.js";

/**
 * Meta connector, mocked.
 *
 * It publishes nothing. What it does is model the *shape* of the real thing
 * faithfully enough that swapping in `MetaConnector` changes one file:
 *
 *   - It de-duplicates on the idempotency key, because a redelivered queue
 *     message must not post twice to a real account.
 *   - It returns a platform post id and a permalink, because the store needs
 *     somewhere to put them.
 *   - It can fail in each of the four ways the real API fails, so the
 *     publisher's policy branches are actually exercised.
 *
 * The real one will differ in one visible way: Instagram publishing is two
 * calls — create a media container, then publish it — and Reels need polling
 * while the container processes. That is why `publish` is async and why the
 * publisher runs in a worker rather than a request handler.
 */
export class MockMetaConnector implements SocialConnector {
  readonly provider: Provider = "meta";
  readonly platforms: Platform[] = ["instagram", "facebook"];

  /** idempotencyKey -> result, so a replay returns the original post. */
  private published = new Map<string, PublishResult>();
  private failures: PublishFailureKind[] = [];

  constructor(private log: (line: string) => void = () => {}) {}

  /** Queue up failures for the next N calls, to exercise publisher policy. */
  failNext(...kinds: PublishFailureKind[]) {
    this.failures.push(...kinds);
  }

  async publish(request: PublishRequest, accessToken: string): Promise<PublishResult> {
    // Replay protection lives here as well as in the store. Two layers is
    // correct: the store stops a duplicate being queued, this stops a duplicate
    // that got past it from reaching a real account.
    const seen = this.published.get(request.idempotencyKey);
    if (seen) {
      this.log(`  [mock] replay of ${request.idempotencyKey} — returning original post`);
      return seen;
    }

    const kind = this.failures.shift();
    if (kind) {
      throw new PublishError(`simulated ${kind} failure`, kind);
    }

    if (!accessToken) {
      throw new PublishError("no access token", "AUTH");
    }

    const result: PublishResult = {
      platformPostId: `${request.platform}_${randomUUID().slice(0, 12)}`,
      permalink: `https://example.invalid/${request.platform}/${randomUUID().slice(0, 8)}`,
      publishedAt: new Date().toISOString(),
    };
    this.published.set(request.idempotencyKey, result);

    this.log(
      `  [mock] PUBLISHED ${request.media.format} to ${request.handle} ` +
        `(${request.platform}) — ${result.platformPostId}`,
    );
    return result;
  }
}

/** Stands in for Secrets Manager. Returns a placeholder, never a real token. */
export class MockTokenProvider implements TokenProvider {
  async getAccessToken(connectionId: string): Promise<string> {
    return `mock-token-for-${connectionId}`;
  }
}
