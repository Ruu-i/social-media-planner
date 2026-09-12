import type { MediaSpec, Platform, Provider } from "../schemas.js";

/**
 * The connector seam.
 *
 * One interface per provider, so the agent, the store and the publisher never
 * learn that Instagram publishing is a two-call container dance while Facebook
 * is one call. `context.md` §3 called for exactly this, and it is what makes
 * "add TikTok later" a new file rather than a refactor.
 *
 * Note what a connector is NOT given: a userId, a content item, or anything it
 * could use to reach the rest of the system. It receives one fully-resolved
 * request and returns a result.
 */

export interface PublishRequest {
  /** Our id, carried through so logs on both sides can be correlated. */
  variantId: string;
  platform: Platform;
  /** The platform's own account id — an IG Business id or a Page id. */
  externalId: string;
  handle: string;
  media: MediaSpec;
  caption: string;
  hashtags: string[];
  /**
   * Must be passed to the platform where it supports one, and used to
   * de-duplicate where it does not. This is the last line of defence against
   * a redelivered queue message posting twice to a real account.
   */
  idempotencyKey: string;
}

export interface PublishResult {
  platformPostId: string;
  permalink: string | null;
  publishedAt: string;
}

/**
 * Failure kind drives policy, so the publisher never has to parse a message.
 *
 *   AUTH        the token is dead — stop, and make the user reconnect
 *   RATE_LIMIT  back off and try later; the content is fine
 *   TRANSIENT   network, 5xx, a container still processing — retry
 *   PERMANENT   the content itself is rejected — retrying will not help
 */
export type PublishFailureKind = "AUTH" | "RATE_LIMIT" | "TRANSIENT" | "PERMANENT";

export class PublishError extends Error {
  constructor(
    message: string,
    readonly kind: PublishFailureKind,
    readonly retryable = kind === "TRANSIENT" || kind === "RATE_LIMIT",
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface SocialConnector {
  readonly provider: Provider;
  /** Platforms this connector can publish to. */
  readonly platforms: Platform[];
  publish(request: PublishRequest, accessToken: string): Promise<PublishResult>;
}

/**
 * Resolves a connection's access token at the moment of publishing.
 *
 * Kept as an interface so the token comes from Secrets Manager in production
 * and from nothing at all in tests. The publisher holds one of these; the agent
 * and the store never see it.
 */
export interface TokenProvider {
  getAccessToken(connectionId: string): Promise<string>;
}
