import type { SocialConnector, TokenProvider } from "./connectors/types.js";
import { PublishError } from "./connectors/types.js";
import type { MemoryStore } from "./store/memory.js";
import type { Platform, Provider } from "./schemas.js";

/**
 * The publisher.
 *
 * In production this is the Lambda draining SQS after EventBridge fires. Here it
 * is a function you call. The logic is the same either way, and the logic is the
 * point.
 *
 * Two things about this file matter more than the code in it.
 *
 * 1. THERE IS NO PUBLISH TOOL.
 *    Publishing is triggered by a timer reaching its moment, never by the model
 *    deciding it is time. The agent cannot reach anything in this file. That is
 *    the last link in the chain that begins with the agent having no approval
 *    tool: a human approves the words, a timer fires, and only then does a post
 *    leave the building.
 *
 * 2. FAILURE POLICY IS DRIVEN BY A TYPED KIND, NOT BY PARSING MESSAGES.
 *    A dead token and a rejected caption need opposite responses. Getting that
 *    wrong means either spamming a retry loop against a 401 forever, or marking
 *    content permanently failed because of a blip.
 */

export interface PublishOutcome {
  variantId: string;
  platform: Platform;
  status: "PUBLISHED" | "FAILED" | "RETRY";
  detail: string;
}

export class Publisher {
  private connectors = new Map<Provider, SocialConnector>();

  constructor(
    private store: MemoryStore,
    private tokens: TokenProvider,
    connectors: SocialConnector[],
    private log: (line: string) => void = () => {},
  ) {
    for (const c of connectors) this.connectors.set(c.provider, c);
  }

  /** One sweep of everything whose moment has passed. */
  async publishDue(userId: string, now = new Date()): Promise<PublishOutcome[]> {
    const due = this.store.getDueVariants(now);
    const outcomes: PublishOutcome[] = [];
    for (const variant of due) {
      if (variant.userId !== userId) continue;
      outcomes.push(await this.publishOne(userId, variant.id));
    }
    return outcomes;
  }

  async publishOne(userId: string, variantId: string): Promise<PublishOutcome> {
    const variant = this.store.getVariant(userId, variantId);
    const connections = this.store.connectionStore;

    // Already done. A redelivered message must be a no-op, not a second post.
    if (variant.status === "PUBLISHED") {
      return {
        variantId,
        platform: variant.platform,
        status: "PUBLISHED",
        detail: `already published as ${variant.platformPostId}`,
      };
    }

    if (variant.status !== "SCHEDULED") {
      return {
        variantId,
        platform: variant.platform,
        status: "FAILED",
        detail: `refusing to publish a ${variant.status} variant`,
      };
    }

    const channel = connections.getChannel(userId, variant.channelId);
    const connection = connections.getConnectionForChannel(userId, variant.channelId);
    if (!channel || !connection) {
      this.store.markFailed(variantId, "Channel or connection no longer exists");
      return { variantId, platform: variant.platform, status: "FAILED", detail: "no channel" };
    }

    const connector = this.connectors.get(connection.provider);
    if (!connector) {
      this.store.markFailed(variantId, `No connector for ${connection.provider}`);
      return { variantId, platform: variant.platform, status: "FAILED", detail: "no connector" };
    }

    try {
      // The token is resolved here, at the moment of use, and never stored,
      // logged, or returned. Nothing upstream of this line has seen it.
      const accessToken = await this.tokens.getAccessToken(connection.id);

      const result = await connector.publish(
        {
          variantId: variant.id,
          platform: channel.platform,
          externalId: channel.externalId,
          handle: channel.handle,
          media: variant.media,
          caption: variant.caption,
          hashtags: variant.hashtags,
          // Reuse the key the scheduler already committed to. Generating a new
          // one here would defeat the whole mechanism.
          idempotencyKey: variant.idempotencyKey ?? `${variant.id}@${variant.scheduledFor}`,
        },
        accessToken,
      );

      this.store.markPublished(variantId, result.platformPostId, result.permalink);
      return {
        variantId,
        platform: channel.platform,
        status: "PUBLISHED",
        detail: result.platformPostId,
      };
    } catch (error) {
      return this.handleFailure(variantId, channel.platform, connection.id, error);
    }
  }

  private handleFailure(
    variantId: string,
    platform: Platform,
    connectionId: string,
    error: unknown,
  ): PublishOutcome {
    const connections = this.store.connectionStore;

    if (error instanceof PublishError) {
      switch (error.kind) {
        case "AUTH":
          // The token is dead, and it is shared: every channel under this grant
          // is now broken. Mark the CONNECTION, not the channel, so the user is
          // told to reconnect Meta once rather than chasing each platform.
          connections.markReauthRequired(connectionId);
          this.store.markFailed(variantId, `Authentication failed: ${error.message}`);
          this.log(`  connection ${connectionId} needs reauthorisation`);
          return { variantId, platform, status: "FAILED", detail: "auth — reconnect required" };

        case "RATE_LIMIT":
        case "TRANSIENT":
          // Leave it SCHEDULED. The next sweep picks it up, and the idempotency
          // key means a retry that partly succeeded cannot post twice.
          this.store.recordRetryableFailure(variantId, error.message);
          return { variantId, platform, status: "RETRY", detail: error.message };

        case "PERMANENT":
          this.store.markFailed(variantId, error.message);
          return { variantId, platform, status: "FAILED", detail: error.message };
      }
    }

    // An unrecognised error is treated as permanent on purpose. Retrying
    // something we do not understand against a real account is worse than
    // stopping and telling the user.
    const message = error instanceof Error ? error.message : String(error);
    this.store.markFailed(variantId, message);
    return { variantId, platform, status: "FAILED", detail: message };
  }
}
