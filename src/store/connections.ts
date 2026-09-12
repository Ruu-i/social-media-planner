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
 */
export class ConnectionStore {
  private connections = new Map<string, Connection>();
  private channels = new Map<string, Channel>();

  constructor(connections: Connection[] = [], channels: Channel[] = []) {
    for (const c of connections) this.connections.set(c.id, c);
    for (const ch of channels) this.channels.set(ch.id, ch);
  }

  listConnections(userId: string): Connection[] {
    return [...this.connections.values()].filter((c) => c.userId === userId);
  }

  getChannel(userId: string, channelId: string): Channel | null {
    const channel = this.channels.get(channelId);
    if (!channel || channel.userId !== userId) return null;
    return channel;
  }

  /** What the agent is allowed to know. Deliberately lossy. */
  listChannels(userId: string): ChannelSummary[] {
    return [...this.channels.values()]
      .filter((ch) => ch.userId === userId)
      .map((ch) => this.toSummary(ch))
      .filter((s): s is ChannelSummary => s !== null);
  }

  summarise(userId: string, channelId: string): ChannelSummary | null {
    const channel = this.getChannel(userId, channelId);
    return channel ? this.toSummary(channel) : null;
  }

  /**
   * A channel is publishable only if its connection is healthy AND the account
   * type can actually publish. A personal Instagram account cannot be published
   * to through any Meta API, no matter how the app is configured.
   */
  isPublishable(userId: string, channelId: string): { ok: boolean; reason?: string } {
    const channel = this.getChannel(userId, channelId);
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
  getConnectionForChannel(userId: string, channelId: string): Connection | null {
    const channel = this.getChannel(userId, channelId);
    if (!channel) return null;
    return this.connections.get(channel.connectionId) ?? null;
  }

  /**
   * A dead token takes every channel under the grant with it, which is the
   * whole reason connections are modelled separately from channels.
   */
  markReauthRequired(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.set(connectionId, { ...connection, status: "REAUTH_REQUIRED" });
    }
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
