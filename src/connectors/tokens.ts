import type { TokenProvider } from "./types.js";
import type { ConnectionStore } from "../store/connections.js";
import type { TokenStore } from "../oauth/types.js";

/**
 * Resolve a connection's access token at the moment of publishing.
 *
 * The indirection exists so the token has the shortest possible life: the
 * publisher asks for it immediately before the call that needs it, and nothing
 * upstream — not the store, not the agent, not a log line — has ever held it.
 *
 * It is fetched per publish rather than cached. A cache would save an SSM read
 * worth a few milliseconds on a path that then spends seconds talking to Meta,
 * and in exchange would keep a live credential in memory across invocations and
 * serve a revoked one after the user disconnected.
 */
export class StoredTokenProvider implements TokenProvider {
  constructor(
    private connections: ConnectionStore,
    private tokens: TokenStore,
  ) {}

  async getAccessToken(userId: string, connectionId: string): Promise<string> {
    const connection = (await this.connections.listConnections(userId)).find(
      (c) => c.id === connectionId,
    );
    if (!connection) throw new Error(`No connection ${connectionId}`);
    return this.tokens.get(connection.tokenRef);
  }
}
