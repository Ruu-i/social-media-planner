import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Single-table design.
 *
 * One table, two GSIs. Everything about this layout is driven by the access
 * patterns the application actually has — which is the whole discipline of
 * DynamoDB modelling, and the opposite of how you would design it relationally.
 *
 * | Entity     | PK        | SK          | GSI1PK      | GSI1SK  | GSI2PK           | GSI2SK       |
 * |------------|-----------|-------------|-------------|---------|------------------|--------------|
 * | Profile    | USER#u    | PROFILE     |             |         |                  |              |
 * | Connection | USER#u    | CONN#id     |             |         |                  |              |
 * | Channel    | USER#u    | CHAN#id     |             |         |                  |              |
 * | Campaign   | USER#u    | CAMP#id     |             |         |                  |              |
 * | Item       | USER#u    | ITEM#id     | CAMP#campId | ITEM#id |                  |              |
 * | Variant    | USER#u    | VAR#id      | ITEM#itemId | VAR#id  | STATUS#SCHEDULED | scheduledFor |
 * | Asset      | USER#u    | ASSET#id    |             |         |                  |              |
 * | Message    | SESSION#s | MSG#000001  |             |         |                  |              |
 *
 * The access patterns each of those exists for:
 *
 *   getBusinessProfile   Get(USER#u, PROFILE)
 *   getConnectedAccounts Query(USER#u, SK begins_with CHAN#)
 *   getItem              Get(USER#u, ITEM#id) + Query(GSI1, ITEM#id)
 *   getVariant           Get(USER#u, VAR#id)          <- why variants hang off
 *                                                        USER and not ITEM: they
 *                                                        are fetched by id far
 *                                                        more often than by item
 *   getCalendar          Query(USER#u, SK begins_with VAR#) then group by itemId
 *   getCampaignItems     Query(GSI1, CAMP#id)
 *   getDueVariants       Query(GSI2, STATUS#SCHEDULED, GSI2SK <= now)
 *   conversation history Query(SESSION#s, SK begins_with MSG#)
 *
 * GSI2 is the one that earns its keep: the publisher sweep needs variants
 * across ALL users ordered by time, which no user-partitioned key can answer.
 * Only SCHEDULED variants carry a GSI2PK, so the index stays small — a sparse
 * index, which is the idiomatic way to model a work queue in DynamoDB.
 */

export const TABLE_NAME = process.env.DDB_TABLE ?? "social-planner";

export function createDynamoClient(): DynamoDBDocumentClient {
  const endpoint = process.env.DDB_ENDPOINT;

  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    // DDB_ENDPOINT points at DynamoDB Local. Unset in production, where the
    // Lambda's execution role supplies credentials and the real endpoint is
    // resolved from the region.
    ...(endpoint
      ? {
          endpoint,
          credentials: { accessKeyId: "local", secretAccessKey: "local" },
        }
      : {}),
  });

  return DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      // Undefined attributes are dropped rather than stored as NULL. Our domain
      // uses `null` deliberately (an unpublished variant has publishedAt: null),
      // so nulls are kept and only genuine undefined is removed.
      removeUndefinedValues: true,
      convertClassInstanceToMap: false,
    },
  });
}

/** Key builders, in one place so a typo cannot create an unreachable row. */
export const key = {
  user: (userId: string) => `USER#${userId}`,
  profile: () => "PROFILE",
  connection: (id: string) => `CONN#${id}`,
  channel: (id: string) => `CHAN#${id}`,
  campaign: (id: string) => `CAMP#${id}`,
  item: (id: string) => `ITEM#${id}`,
  variant: (id: string) => `VAR#${id}`,
  asset: (id: string) => `ASSET#${id}`,
  session: (id: string) => `SESSION#${id}`,
  /** Zero-padded so lexical order is chronological order. */
  message: (n: number) => `MSG#${String(n).padStart(6, "0")}`,
  dueStatus: () => "STATUS#SCHEDULED",
};

export async function createTable(client: DynamoDBDocumentClient, tableName = TABLE_NAME) {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST", // no provisioned capacity to leave running
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
        { AttributeName: "GSI2PK", AttributeType: "S" },
        { AttributeName: "GSI2SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "GSI2PK", KeyType: "HASH" },
            { AttributeName: "GSI2SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
}

export async function tableExists(client: DynamoDBDocumentClient, tableName = TABLE_NAME) {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch {
    return false;
  }
}

export async function dropTable(client: DynamoDBDocumentClient, tableName = TABLE_NAME) {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  } catch {
    // Already gone is the desired end state, so a failure here is not one.
  }
}
