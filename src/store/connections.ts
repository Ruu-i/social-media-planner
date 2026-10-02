import type { Channel, ChannelSummary, Connection } from "../schemas.js";

/**
 * Connections and their channels.
 *
 * Kept separate from the content store because it has a different security
 * posture: this is the only place that knows a `tokenRef` exists, and the only
 * place that would ever talk to a secret store.
 *
 * The invariant that matters:
 *
 *   No access token ever leaves this module. The agent sees handles, formats
 *   and limits — never a token, never a tokenRef, never a platform-side id.
 *
 * `toSummary` below is what enforces it. Everything the agent can read about a
 * channel goes through that function.
 *
 * EVERY METHOD IS ASYNC, including in the in-memory implementation where
 * nothing awaits anything.
 *
 * This interface was originally synchronous, and that was a mistake that cost
 * a real bug: a user connected their Instagram account, the grant succeeded,
 * the token was written — and the connection row went into one Lambda
 * container's Map and vanished. The account still showed as the seeded demo
 * one, with nothing in the logs to say why.
 *
 * A synchronous signature cannot be implemented over a database, so "persist
 * connections" was not a swap, it was a refactor of every caller. ContentStore
 * got this right from the start for exactly this reason; this one did not, and
 * the shape of the fix is the argument for the rule.
 */
export interface ConnectionStore {
  listConnections(userId: string): Promise<Connection[]>;
  getChannel(userId: string, channelId: string): Promise<Channel | null>;
  listChannels(userId: string): Promise<ChannelSummary[]>;
  summarise(userId: string, channelId: string): Promise<ChannelSummary | null>;
  isPublishable(userId: string, channelId: string): Promise<{ ok: boolean; reason?: string }>;
  getConnectionForChannel(userId: string, channelId: string): Promise<Connection | null>;
  markReauthRequired(connectionId: string): Promise<void>;
  upsertConnection(connection: Connection, channels: Channel[]): Promise<void>;
  removeConnection(userId: string, connectionId: string): Promise<string | null>;
}

export class MemoryConnectionStore implements ConnectionStore {
  private connections = new Map<string, Connection>();
  private channels = new Map<string, Channel>();

  constructor(connections: Connection[] = [], channels: Channel[] = []) {
    for (const c of connections) this.connections.set(c.id, c);
    for (const ch of channels) this.channels.set(ch.id, ch);
  }

  async listConnections(userId: string): Promise<Connection[]> {
    return [...this.connections.values()].filter((c) => c.userId === userId);
  }

  async getChannel(userId: string, channelId: string): Promise<Channel | null> {
    const channel = this.channels.get(channelId);
    if (!channel || channel.userId !== userId) return null;
    return channel;
  }

  /** What the agent is allowed to know. Deliberately lossy. */
  async listChannels(userId: string): Promise<ChannelSummary[]> {
    return [...this.channels.values()]
      .filter((ch) => ch.userId === userId)
      .map((ch) => this.toSummary(ch))
      .filter((s): s is ChannelSummary => s !== null);
  }

  async summarise(userId: string, channelId: string): Promise<ChannelSummary | null> {
    const channel = await this.getChannel(userId, channelId);
    return channel ? this.toSummary(channel) : null;
  }

  /**
   * A channel is publishable only if its connection is healthy AND the account
   * type can actually publish. A personal Instagram account cannot be published
   * to through any Meta API, no matter how the app is configured.
   */
  async isPublishable(userId: string, channelId: string): Promise<{ ok: boolean; reason?: string }> {
    const channel = await this.getChannel(userId, channelId);
    if (!channel) return { ok: false, reason: "No such channel" };

    const connection = this.connections.get(channel.connectionId);
    if (!connection) return { ok: false, reason: "Channel has no connection" };

    if (connection.status !== "ACTIVE") {
      // Name the provider, not the platform: one Meta grant covers Instagram
      // and Facebook, so "reconnect Instagram" would send the user round the
      // loop twice and leave them still broken.
      return {
        ok: false,
        reason:
          `The ${connection.provider} connection is ${connection.status}. ` +
          `Reconnect ${connection.provider} — this affects every channel under it.`,
      };
    }

    if (channel.accountType === "PERSONAL") {
      return {
        ok: false,
        reason:
          `${channel.handle} is a personal account. Meta's publishing API only ` +
          `works with Business or Creator accounts — it must be converted first.`,
      };
    }

    return { ok: true };
  }

  /** Resolve the connection behind a channel. Publisher-only — never the agent. */
  async getConnectionForChannel(userId: string, channelId: string): Promise<Connection | null> {
    const channel = await this.getChannel(userId, channelId);
    if (!channel) return null;
    return this.connections.get(channel.connectionId) ?? null;
  }

  /**
   * A dead token takes every channel under the grant with it, which is the
   * whole reason connections are modelled separately from channels.
   */
  async markReauthRequired(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.set(connectionId, { ...connection, status: "REAUTH_REQUIRED" });
    }
  }

  /**
   * Record a completed grant, replacing any previous one for that provider.
   *
   * Replacing rather than appending matters: reconnecting Instagram after a
   * token expires must not leave the dead connection behind, or the user ends
   * up with two Instagram rows and the publisher picks whichever it finds
   * first — which is the expired one half the time.
   *
   * Channels are replaced wholesale for the same reason. An account the user
   * has since revoked must disappear, not linger as an unpublishable target.
   */
  async upsertConnection(connection: Connection, channels: Channel[]): Promise<void> {
    const previous = [...this.connections.values()].find(
      (c) => c.userId === connection.userId && c.provider === connection.provider,
    );
    if (previous) await this.removeConnection(previous.userId, previous.id);

    this.connections.set(connection.id, connection);
    for (const channel of channels) this.channels.set(channel.id, channel);
  }

  /** Disconnect. Returns the tokenRef so the caller can delete the credential. */
  async removeConnection(userId: string, connectionId: string): Promise<string | null> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.userId !== userId) return null;

    for (const [id, channel] of this.channels) {
      if (channel.connectionId === connectionId) this.channels.delete(id);
    }
    this.connections.delete(connectionId);
    return connection.tokenRef;
  }

  private toSummary(channel: Channel): ChannelSummary | null {
    const connection = this.connections.get(channel.connectionId);
    if (!connection) return null;
    return {
      channelId: channel.id,
      platform: channel.platform,
      handle: channel.handle,
      accountType: channel.accountType,
      connectionStatus: connection.status,
      supportedFormats: channel.supportedFormats,
      maxCaptionLength: channel.maxCaptionLength,
      maxHashtags: channel.maxHashtags,
      // Note what is not here: externalId, connectionId, tokenRef, scopes.
    };
  }
}
