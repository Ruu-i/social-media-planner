import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { key, TABLE_NAME } from "./dynamo-table.js";
import { MediaStore, type NewAsset } from "./media.js";
import type { MediaAsset } from "../media/types.js";

/**
 * The media library, persisted.
 *
 * MediaStore was in-memory, which meant an uploaded photo lived in exactly one
 * Lambda container. The upload returned an id, the user's next message landed
 * on a different container, and the agent answered "No asset asset_e953248f" —
 * about a file that had just been stored successfully in S3. The bytes were
 * always fine; only the metadata evaporated.
 *
 * Reads stay SYNCHRONOUS, deliberately. MediaStore's readers are called from 25
 * places including the agent's tools, and making them async would be a third
 * sweeping refactor for the same lesson. Instead `refresh()` pulls the user's
 * assets into the in-memory maps once per request, and the writes go through to
 * DynamoDB. Reads are therefore as fresh as the request that triggered them,
 * which is the property that was actually missing.
 */
export class DynamoMediaStore extends MediaStore {
  /**
   * No userId here.
   *
   * It was a constructor argument, which bound one process-wide store to one
   * person — fine when every visitor was the same user, wrong the moment they
   * are not. The user now arrives with each refresh, like it does with every
   * other method on this class.
   */
  constructor(
    private client: DynamoDBDocumentClient,
    private table = process.env.DDB_TABLE ?? TABLE_NAME,
  ) {
    super();
  }

  /**
   * Load this user's assets into memory.
   *
   * Called at the start of a request rather than per read: a planning turn
   * touches the library repeatedly, and re-querying for each would turn one
   * query into dozens for data that cannot change mid-turn.
   */
  async refresh(userId: string): Promise<void> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": key.user(userId), ":sk": "ASSET#" },
      }),
    );

    this.replaceAll(
      (result.Items ?? []).map((row) => {
        const { PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, ...rest } = row;
        return rest as MediaAsset;
      }),
    );
  }

  override add(input: NewAsset): MediaAsset {
    const asset = super.add(input);
    // Fire-and-forget would lose the asset on a failed write with nothing to
    // show for it, so the promise is kept and surfaced by `pendingWrites`.
    this.track(this.put(asset));
    return asset;
  }

  override markUsed(assetId: string): void {
    super.markUsed(assetId);
    const asset = this.peek(assetId);
    if (asset) this.track(this.put(asset));
  }

  private async put(asset: MediaAsset): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: key.user(asset.userId), SK: key.asset(asset.id), ...asset },
      }),
    );
  }

  private writes: Promise<unknown>[] = [];

  private track(promise: Promise<unknown>): void {
    this.writes.push(promise);
  }

  /**
   * Await any writes started by the synchronous methods.
   *
   * `add` cannot be async without changing every caller, but an upload route
   * that returns before the row is durable would report success for an asset
   * that may not exist. The route awaits this before replying.
   */
  async flush(): Promise<void> {
    const pending = this.writes;
    this.writes = [];
    await Promise.all(pending);
  }
}
