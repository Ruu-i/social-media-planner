import { OAuthError, type DiscoveredChannel, type Grant, type OAuthProvider } from "./types.js";
import type { Provider } from "../schemas.js";

/**
 * Instagram Login — the auth path that works for CREATOR accounts.
 *
 * Meta has two ways in, and the difference decides who can use this app:
 *
 *   Facebook Login    needs a Facebook Page, and an Instagram BUSINESS account
 *                     linked to it. Returns Page tokens, so it can post to the
 *                     Page as well as to Instagram.
 *   Instagram Login   needs neither. Works with BUSINESS *and* CREATOR, and
 *                     posts to Instagram only.
 *
 * Creator is what most individual accounts convert to, and it is unreachable
 * through Facebook Login — so this is the path that decides whether a given
 * user can connect at all. Facebook Pages are a separate grant.
 *
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
 */

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

export class InstagramOAuthProvider implements OAuthProvider {
  readonly provider: Provider = "instagram";

  /**
   * Credentials are read LAZILY, never captured in the constructor.
   *
   * This provider is built at module load; the app secret arrives from SSM at
   * cold start, afterwards. Capturing process.env here would freeze both values
   * as empty strings and leave isConfigured() permanently false — the same trap
   * the Anthropic client hit, which is why that one is lazily constructed too.
   */
  constructor(
    private idOverride?: string,
    private secretOverride?: string,
  ) {}

  private get clientId(): string {
    return this.idOverride ?? process.env.INSTAGRAM_APP_ID ?? "";
  }

  private get clientSecret(): string {
    return this.secretOverride ?? process.env.INSTAGRAM_APP_SECRET ?? "";
  }

  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl(state: string, redirectUri: string): string {
    if (!this.isConfigured()) {
      throw new OAuthError("Instagram app credentials are not configured", "NOT_CONFIGURED");
    }
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  async exchange(code: string, redirectUri: string): Promise<Grant> {
    if (!this.isConfigured()) {
      throw new OAuthError("Instagram app credentials are not configured", "NOT_CONFIGURED");
    }

    const short = await this.shortLivedToken(code, redirectUri);
    const long = await this.longLivedToken(short.accessToken);
    const channel = await this.discoverAccount(long.accessToken);

    return {
      accessToken: long.accessToken,
      expiresAt: long.expiresAt,
      scopes: SCOPES,
      channels: [channel],
    };
  }

  /**
   * Step 1 — the authorization code, which is single-use and expires in an hour.
   *
   * Form-encoded, not JSON. This endpoint rejects a JSON body, and the error it
   * returns does not say so.
   */
  private async shortLivedToken(
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { access_token?: string; error_message?: string };

    if (!res.ok || !json.access_token) {
      throw new OAuthError(
        `Instagram rejected the authorization code: ${json.error_message ?? res.status}`,
        "EXCHANGE_FAILED",
      );
    }
    return { accessToken: json.access_token };
  }

  /**
   * Step 2 — trade one hour for sixty days.
   *
   * Skipping this is the classic way to ship a connect flow that works in
   * testing and is broken by morning: the short-lived token lasts an hour, so
   * every scheduled post after that fails with an auth error that looks like a
   * revoked grant rather than a missed exchange.
   */
  private async longLivedToken(
    shortToken: string,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    const params = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: this.clientSecret,
      access_token: shortToken,
    });

    const res = await fetch(`${GRAPH}/access_token?${params}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };

    if (!res.ok || !json.access_token) {
      throw new OAuthError("Could not exchange for a long-lived token", "EXCHANGE_FAILED");
    }

    const seconds = json.expires_in ?? 60 * 24 * 60 * 60;
    return {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    };
  }

  /** Step 3 — who did we just connect, and can they actually be published to? */
  private async discoverAccount(token: string): Promise<DiscoveredChannel> {
    const params = new URLSearchParams({
      fields: "user_id,username,account_type",
      access_token: token,
    });
    const res = await fetch(`${GRAPH}/v23.0/me?${params}`);
    const json = (await res.json()) as {
      user_id?: string;
      id?: string;
      username?: string;
      account_type?: string;
    };

    if (!res.ok || !(json.user_id ?? json.id)) {
      throw new OAuthError("Could not read the connected Instagram account", "EXCHANGE_FAILED");
    }

    const accountType = (json.account_type ?? "BUSINESS").toUpperCase();
    if (accountType === "PERSONAL") {
      // Caught here rather than at publish time. A connection that cannot
      // publish is worse than no connection: the calendar fills up and every
      // post fails at the moment it was supposed to go out.
      throw new OAuthError(
        "That is a personal Instagram account. Switch it to Business or Creator in the Instagram app, then connect again.",
        "NO_PUBLISHABLE_ACCOUNT",
      );
    }

    return {
      platform: "instagram",
      externalId: (json.user_id ?? json.id)!,
      handle: json.username ? `@${json.username}` : "@unknown",
      accountType: accountType === "CREATOR" ? "CREATOR" : "BUSINESS",
      supportedFormats: ["POST", "CAROUSEL", "REEL", "STORY"],
      maxCaptionLength: 2200,
      maxHashtags: 30,
    };
  }
}
