import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { key, TABLE_NAME } from "./dynamo-table.js";
import { seedChannels, seedConnections, seedContent, USER_ID } from "../seed.js";

/**
 * Put the demo data in the table, once, if the table is empty.
 *
 * The deployed app used to build its content store from the seed on every cold
 * start, which meant it was never persisting anything: a post the agent wrote
 * lived in one Lambda container and was gone by the next request. The table
 * held a single rate-limit row and nothing else.
 *
 * Seeding at all is a product decision rather than a technical one. An empty
 * calendar is the honest first-run state, but it is also a blank page that
 * cannot be filled without spending model credit, and this app is meant to be
 * openable by someone who just wants to see what it does.
 *
 * So the seed stays, but it is now written ONCE and then owned by the user.
 * The demo Instagram account is a real row they can disconnect, and connecting
 * a real account replaces it permanently — rather than the seed reasserting
 * itself on the next cold start and silently undoing what they did.
 */
export async function ensureSeeded(
  client: DynamoDBDocumentClient,
  table = process.env.DDB_TABLE ?? TABLE_NAME,
): Promise<boolean> {
  const existing = await client.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": key.user(USER_ID) },
      Limit: 1,
    }),
  );
  // Any row at all under the user means this has run before. Checking for
  // content specifically would re-seed the calendar for someone who had
  // deliberately deleted every post.
  if ((existing.Items ?? []).length > 0) return false;

  const put = (Item: Record<string, unknown>) =>
    client.send(new PutCommand({ TableName: table, Item }));

  for (const connection of seedConnections) {
    await put({
      PK: key.user(connection.userId),
      SK: key.connection(connection.id),
      GSI1PK: key.connection(connection.id),
      GSI1SK: key.connection(connection.id),
      ...connection,
    });
  }

  for (const channel of seedChannels) {
    await put({ PK: key.user(channel.userId), SK: key.channel(channel.id), ...channel });
  }

  for (const item of seedContent()) {
    const { variants, ...rest } = item;
    await put({
      PK: key.user(rest.userId),
      SK: key.item(rest.id),
      ...(rest.campaignId ? { GSI1PK: key.campaign(rest.campaignId), GSI1SK: key.item(rest.id) } : {}),
      ...rest,
    });

    for (const variant of variants) {
      await put({
        PK: key.user(variant.userId),
        SK: key.variant(variant.id),
        GSI1PK: key.item(variant.itemId),
        GSI1SK: key.variant(variant.id),
        // Only SCHEDULED variants carry GSI2, which is what keeps the
        // publisher's work queue sparse rather than a scan of every row.
        ...(variant.status === "SCHEDULED" && variant.scheduledFor
          ? { GSI2PK: key.dueStatus(), GSI2SK: variant.scheduledFor }
          : {}),
        ...variant,
      });
      // The pointer row, so the publisher can find a variant without a userId.
      await put({ PK: key.variant(variant.id), SK: "PTR", userId: variant.userId });
    }
  }

  return true;
}
