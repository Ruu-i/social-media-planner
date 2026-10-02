import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { key, TABLE_NAME } from "./dynamo-table.js";
import { MemoryConnectionStore, type ConnectionStore } from "./connections.js";
import type { Channel, ChannelSummary, Connection } from "../schemas.js";

/**
 * Connections and channels in DynamoDB.
 *
 * Rows live under the user's partition alongside their content, using the
 * `CONN#` and `CHAN#` sort keys the table schema already defined:
 *
 *     PK = USER#<userId>   SK = CONN#<connectionId>
 *     PK = USER#<userId>   SK = CHAN#<channelId>
 *
 * One query loads both, because they are always needed together — a channel is
 * meaningless without its connection's status, and `toSummary` refuses to
 * describe a channel whose connection it cannot see.
 *
 * Each call reads fresh rather than caching per container. A cache would be
 * faster and WRONG in the specific way that matters here: connect and the next
 * page load are separate requests that routinely land on different containers,
 * so a cached container would keep serving the pre-connection state and the
 * user would see their account connect and then apparently un-connect. That is
 * exactly the bug this class exists to fix, and a cache would reintroduce it
 * with a shorter fuse.
 *
 * The decoding and the invariant — no token ever reaches a summary — are reused
 * from MemoryConnectionStore rather than reimplemented, so the two cannot drift
 * on the one thing that must never be got wrong.
 */
export class DynamoConnectionStore implements ConnectionStore {
  constructor(
    private client: DynamoDBDocumentClient,
    private table = process.env.DDB_TABLE ?? TABLE_NAME,
  ) {}

  /** Load a user's grants into an in-memory view, and let that do the thinking. */
  private async load(userId: string): Promise<MemoryConnectionStore> {
    // TWO queries, not one with an OR.
    //
    // A KeyConditionExpression permits exactly one condition on the sort key —
    // `OR` across two begins_with is a validation error, not a slow query. The
    // alternative is reading the user's whole partition and filtering in code,
    // which also drags back every item and variant they own.
    const [connRows, chanRows] = await Promise.all([
      this.queryPrefix(userId, "CONN#"),
      this.queryPrefix(userId, "CHAN#"),
    ]);

    return new MemoryConnectionStore(
      connRows as unknown as Connection[],
      chanRows as unknown as Channel[],
    );
  }

  async listConnections(userId: string): Promise<Connection[]> {
    return (await this.load(userId)).listConnections(userId);
  }

  async getChannel(userId: string, channelId: string): Promise<Channel | null> {
    return (await this.load(userId)).getChannel(userId, channelId);
  }

  async listChannels(userId: string): Promise<ChannelSummary[]> {
    return (await this.load(userId)).listChannels(userId);
  }

  async summarise(userId: string, channelId: string): Promise<ChannelSummary | null> {
    return (await this.load(userId)).summarise(userId, channelId);
  }

  async isPublishable(userId: string, channelId: string) {
    return (await this.load(userId)).isPublishable(userId, channelId);
  }

  async getConnectionForChannel(userId: string, channelId: string): Promise<Connection | null> {
    return (await this.load(userId)).getConnectionForChannel(userId, channelId);
  }

  /**
   * Mark a grant as needing re-authorisation.
   *
   * Takes only a connectionId, with no userId — the publisher calls this from a
   * context that has one but not the other — so the row has to be found before
   * it can be written. A GSI would avoid the scan; with one connection per
   * provider per user, it would cost more to maintain than it saves.
   */
  async markReauthRequired(connectionId: string): Promise<void> {
    const found = await this.findConnection(connectionId);
    if (!found) return;
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: key.user(found.userId),
          SK: key.connection(found.id),
          // Re-stated, not inherited: a Put REPLACES the item, so omitting the
          // index keys here would silently drop the row out of GSI1 and the
          // next markReauthRequired for it would find nothing.
          GSI1PK: key.connection(found.id),
          GSI1SK: key.connection(found.id),
          ...found,
          status: "REAUTH_REQUIRED",
        },
      }),
    );
  }

  async upsertConnection(connection: Connection, channels: Channel[]): Promise<void> {
    // Remove the previous grant for this provider FIRST. Without it a
    // reconnection leaves the dead connection and its channels behind, and the
    // publisher picks whichever row it reads first — the expired one half the
    // time.
    const existing = await this.listConnections(connection.userId);
    for (const previous of existing.filter((c) => c.provider === connection.provider)) {
      await this.removeConnection(previous.userId, previous.id);
    }

    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: key.user(connection.userId),
          SK: key.connection(connection.id),
          // Indexed by its own id, so markReauthRequired can find the row from
          // a connectionId alone — the publisher knows which grant died, but
          // not whose it is.
          GSI1PK: key.connection(connection.id),
          GSI1SK: key.connection(connection.id),
          ...connection,
        },
      }),
    );

    for (const channel of channels) {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: key.user(channel.userId),
            SK: key.channel(channel.id),
            ...channel,
          },
        }),
      );
    }
  }

  async removeConnection(userId: string, connectionId: string): Promise<string | null> {
    const view = await this.load(userId);
    const connection = (await view.listConnections(userId)).find((c) => c.id === connectionId);
    if (!connection) return null;

    // Channels first. Deleting the connection first and then failing would
    // leave channels pointing at nothing, which `toSummary` renders as simply
    // absent — a channel that exists, cannot publish, and cannot be seen.
    for (const channel of await this.channelsOf(userId, connectionId)) {
      await this.client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: key.user(userId), SK: key.channel(channel.id) },
        }),
      );
    }

    await this.client.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: key.user(userId), SK: key.connection(connectionId) },
      }),
    );
    return connection.tokenRef;
  }

  /** One partition, one sort-key prefix, keys stripped. */
  private async queryPrefix(userId: string, prefix: string): Promise<Record<string, unknown>[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": key.user(userId), ":prefix": prefix },
      }),
    );
    return (result.Items ?? []).map((row) => {
      const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...rest } = row;
      return rest;
    });
  }

  private async channelsOf(userId: string, connectionId: string): Promise<Channel[]> {
    const rows = await this.queryPrefix(userId, "CHAN#");
    return (rows as unknown as Channel[]).filter((c) => c.connectionId === connectionId);
  }

  private async findConnection(connectionId: string): Promise<Connection | null> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": key.connection(connectionId) },
      }),
    );
    const row = (result.Items ?? [])[0];
    if (!row) return null;
    const { PK, SK, GSI1PK, GSI1SK, ...rest } = row;
    return rest as Connection;
  }
}
