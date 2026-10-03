import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { OAuthError, type OAuthProvider, type TokenStore } from "./types.js";
import type { Channel, Connection, Provider } from "../schemas.js";
import type { ConnectionStore } from "../store/connections.js";

/**
 * The connect flow.
 *
 * Two steps with a user's browser and a third party in between, which is what
 * makes it the most security-sensitive code here:
 *
 *   1. start     sign a state, send the browser to the provider
 *   2. callback  verify the state, trade the code for a token, store the token
 *                behind a ref, record what we can now publish to
 */

/** How long a start is good for. Long enough to read a consent screen, no longer. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  userId: string;
  provider: Provider;
  nonce: string;
  exp: number;
}

export class ConnectService {
  constructor(
    private connections: ConnectionStore,
    private tokens: TokenStore,
    private providers: Map<Provider, OAuthProvider>,
    /** Lazily read, for the same reason the provider's credentials are. */
    private secretOverride?: string,
  ) {}

  private get secret(): string {
    return this.secretOverride ?? process.env.OAUTH_STATE_SECRET ?? "";
  }

  listProviders(): { provider: Provider; configured: boolean; reason?: string }[] {
    return [...this.providers.values()].map((p) => ({
      provider: p.provider,
      configured: p.isConfigured(),
      reason: p.isConfigured() ? undefined : p.unavailableReason,
    }));
  }

  /** Where to send the browser. */
  start(userId: string, provider: Provider, redirectUri: string): string {
    const impl = this.providerFor(provider);
    const state = this.signState({
      userId,
      provider,
      nonce: randomUUID(),
      exp: Date.now() + STATE_TTL_MS,
    });
    return impl.authorizeUrl(state, redirectUri);
  }

  /** Handle the provider's redirect back. */
  async callback(
    provider: Provider,
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<{ userId: string; handles: string[] }> {
    const payload = this.verifyState(state);
    if (payload.provider !== provider) {
      throw new OAuthError("State does not match this provider", "BAD_STATE");
    }

    const impl = this.providerFor(provider);
    const grant = await impl.exchange(code, redirectUri);

    if (grant.channels.length === 0) {
      throw new OAuthError(
        "That account has nothing this app can publish to.",
        "NO_PUBLISHABLE_ACCOUNT",
      );
    }

    const connectionId = `conn_${provider}_${randomUUID().slice(0, 8)}`;
    const tokenRef = `${payload.userId}/${provider}`;

    // The token goes to the TokenStore FIRST. If this fails there is no
    // connection row pointing at a credential that was never written — which
    // would read as connected and fail at publish time instead.
    await this.tokens.put(tokenRef, grant.accessToken);

    const connection: Connection = {
      id: connectionId,
      userId: payload.userId,
      provider,
      status: "ACTIVE",
      tokenRef,
      scopes: grant.scopes,
      connectedAt: new Date().toISOString(),
      expiresAt: grant.expiresAt,
    };

    const channels: Channel[] = grant.channels.map((c, i) => ({
      ...c,
      id: `ch_${provider}_${randomUUID().slice(0, 8)}_${i}`,
      connectionId,
      userId: payload.userId,
    }));

    await this.connections.upsertConnection(connection, channels);
    return { userId: payload.userId, handles: channels.map((c) => c.handle) };
  }

  /**
   * Check a stored grant against the provider, and record the answer.
   *
   * Marking REAUTH_REQUIRED here is the point: without it the check is a
   * read-only curiosity that tells one browser tab the truth and leaves the
   * database still claiming the connection is fine. The publisher reads the
   * database.
   */
  async verify(
    userId: string,
    connectionId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const connection = (await this.connections.listConnections(userId)).find(
      (c) => c.id === connectionId,
    );
    if (!connection) return { ok: false, reason: "No such connection" };

    const impl = this.providers.get(connection.provider);
    if (!impl) return { ok: false, reason: `No provider for ${connection.provider}` };

    let result: { ok: boolean; reason?: string };
    try {
      result = await impl.verify(await this.tokens.get(connection.tokenRef));
    } catch (error) {
      // A missing token is itself a dead connection — the row outlived the
      // credential it points at.
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (!result.ok && connection.status === "ACTIVE") {
      await this.connections.markReauthRequired(connection.id);
    }
    return result;
  }

  async disconnect(userId: string, connectionId: string): Promise<void> {
    const tokenRef = await this.connections.removeConnection(userId, connectionId);
    // Revoking our copy of the credential is the part that actually matters;
    // the row is just bookkeeping.
    if (tokenRef) await this.tokens.remove(tokenRef);
  }

  private providerFor(provider: Provider): OAuthProvider {
    const impl = this.providers.get(provider);
    if (!impl) throw new OAuthError(`No OAuth provider for ${provider}`, "NOT_CONFIGURED");
    if (!impl.isConfigured()) {
      throw new OAuthError(
        `${provider} is not set up yet — its app credentials are missing.`,
        "NOT_CONFIGURED",
      );
    }
    return impl;
  }

  /**
   * State is SIGNED, not stored.
   *
   * The obvious implementation keeps a Map of issued states and looks the
   * callback's up. That cannot work here: start and callback are two separate
   * HTTPS requests that routinely land on different Lambda containers, so the
   * lookup misses and every connection attempt fails — intermittently, which is
   * worse than always.
   *
   * An HMAC makes the state self-describing and tamper-evident with nothing to
   * persist. The expiry is inside the signed payload, so it cannot be extended
   * by editing the query string.
   */
  private signState(payload: StatePayload): string {
    if (!this.secret) {
      throw new OAuthError("OAUTH_STATE_SECRET is not set", "NOT_CONFIGURED");
    }
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.hmac(body)}`;
  }

  private verifyState(state: string): StatePayload {
    const [body, signature] = state.split(".");
    if (!body || !signature) throw new OAuthError("Malformed state", "BAD_STATE");

    const expected = this.hmac(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    // Length check first: timingSafeEqual throws on a length mismatch rather
    // than returning false.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new OAuthError("State signature does not verify", "BAD_STATE");
    }

    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (payload.exp < Date.now()) {
      throw new OAuthError("That connect link expired. Start again.", "BAD_STATE");
    }
    return payload;
  }

  private hmac(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }
}
