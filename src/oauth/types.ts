import type { Channel, Provider } from "../schemas.js";

/**
 * The OAuth seam.
 *
 * Connecting an account is the one flow where a mistake is unrecoverable by the
 * user: a token leaked into a log, a store, or a tool result is a token that can
 * post to their Instagram until they notice and revoke it. So the shape here is
 * built around one rule — the access token exists in exactly two places, the
 * provider's response and the TokenStore, and travels between them without
 * passing through anything the agent or the content store can read.
 */

/** What a provider discovers about a publishable destination after the grant. */
export type DiscoveredChannel = Pick<
  Channel,
  "platform" | "externalId" | "handle" | "accountType" | "supportedFormats" | "maxCaptionLength" | "maxHashtags"
>;

export interface Grant {
  accessToken: string;
  /** Null when the provider issues tokens that do not expire. */
  expiresAt: string | null;
  scopes: string[];
  channels: DiscoveredChannel[];
}

export interface OAuthProvider {
  readonly provider: Provider;

  /** Whether credentials are configured. False means "not set up yet", not "broken". */
  isConfigured(): boolean;

  /** Why it cannot be connected, shown to the user. Only read when unconfigured. */
  readonly unavailableReason?: string;

  /** Where to send the user's browser to approve the grant. */
  authorizeUrl(state: string, redirectUri: string): string;

  /**
   * Is this grant still usable?
   *
   * Tokens die for reasons that never reach us: the user revokes the app,
   * changes their password, or switches the account type. Nothing in an OAuth
   * flow notifies the application, so a connection stays ACTIVE and green while
   * being completely dead — and the first symptom is a post that silently never
   * goes out.
   */
  verify(token: string): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Trade the callback's `code` for a token and discover what it can publish to.
   *
   * Returns the token rather than storing it, so that the one place tokens are
   * written stays visible at the call site instead of hidden in a provider.
   */
  exchange(code: string, redirectUri: string): Promise<Grant>;
}

/**
 * Where access tokens actually live.
 *
 * Separate from the ConnectionStore on purpose: a `Connection` row carries only
 * a `tokenRef`, so dumping the entire content store — in a log, a backup, or a
 * tool result handed to the model — reveals no credentials.
 */
export interface TokenStore {
  put(ref: string, token: string): Promise<void>;
  get(ref: string): Promise<string>;
  remove(ref: string): Promise<void>;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_CONFIGURED"
      | "BAD_STATE"
      | "EXCHANGE_FAILED"
      | "NO_PUBLISHABLE_ACCOUNT",
  ) {
    super(message);
    this.name = "OAuthError";
  }
}
