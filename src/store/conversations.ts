import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";

import { key, TABLE_NAME } from "./dynamo-table.js";

/**
 * Conversation persistence.
 *
 * Lambda holds no state between invocations, so message history cannot live in
 * a process-local Map. Without this, every request starts a fresh conversation
 * and "make Wednesday funnier" means nothing — the turn that created Wednesday
 * is gone.
 *
 * Prompt caching still works across this. The cache is keyed on the message
 * prefix, not on which process assembled it, so a conversation rehydrated in a
 * cold Lambda still hits the same cached prefix.
 */
export interface ConversationStore {
  load(sessionId: string): Promise<BetaMessageParam[]>;
  save(sessionId: string, messages: BetaMessageParam[]): Promise<void>;
}

/** For the CLI and tests, where a process-local Map is exactly right. */
export class MemoryConversationStore implements ConversationStore {
  private sessions = new Map<string, BetaMessageParam[]>();

  async load(sessionId: string): Promise<BetaMessageParam[]> {
    return this.sessions.get(sessionId) ?? [];
  }

  async save(sessionId: string, messages: BetaMessageParam[]): Promise<void> {
    this.sessions.set(sessionId, messages);
  }
}

/**
 * One row per message.
 *
 * Not one row per conversation: a DynamoDB item caps at 400 KB, and a single
 * week-planning turn is already ~80 KB of JSON once tool calls and their
 * results are included. A few turns would blow the limit and the conversation
 * would start failing to save with no obvious cause.
 *
 * Per-message rows also make saving append-only — each turn writes just the
 * messages it added rather than rewriting the whole history.
 */
export class DynamoConversationStore implements ConversationStore {
  constructor(
    private client: DynamoDBDocumentClient,
    private table = TABLE_NAME,
  ) {}

  async load(sessionId: string): Promise<BetaMessageParam[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": key.session(sessionId), ":sk": "MSG#" },
      }),
    );
    // SK is zero-padded, so DynamoDB's lexical ordering IS chronological order
    // and no sort is needed here.
    return (result.Items ?? []).map((row) => row.message as BetaMessageParam);
  }

  /**
   * Append whatever is new.
   *
   * The count comes from a query rather than from process memory, because in
   * Lambda there is no process memory to trust — two invocations of the same
   * session may be different containers entirely.
   */
  async save(sessionId: string, messages: BetaMessageParam[]): Promise<void> {
    const existing = await this.load(sessionId);
    const start = existing.length;
    if (messages.length <= start) return;

    for (let i = start; i < messages.length; i++) {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: key.session(sessionId),
            SK: key.message(i),
            message: stripHeavyContent(messages[i]!),
            savedAt: new Date().toISOString(),
          },
        }),
      );
    }
  }
}

/**
 * Remove base64 image payloads before persisting.
 *
 * `get_media_asset({ includeImage: true })` returns the actual picture in the
 * tool result, which is roughly 1.5 MB of base64 — on its own, nearly four
 * times DynamoDB's 400 KB item limit.
 *
 * Replacing it with a short marker costs the agent the ability to re-examine
 * that image in a later turn without fetching it again, which is the behaviour
 * we want anyway: the whole media cost strategy is look once, then work from
 * descriptions.
 */
function stripHeavyContent(message: BetaMessageParam): BetaMessageParam {
  if (!Array.isArray(message.content)) return message;

  const content = message.content.map((block) => {
    if (block.type === "image") {
      return {
        type: "text" as const,
        text: "[image omitted from history — call get_media_asset again to view it]",
      };
    }

    // Tool results carry their own nested content array, and that is where an
    // image actually lives.
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return {
        ...block,
        content: block.content.map((inner) =>
          inner.type === "image"
            ? {
                type: "text" as const,
                text: "[image omitted from history — call get_media_asset again to view it]",
              }
            : inner,
        ),
      };
    }

    return block;
  });

  return { ...message, content } as BetaMessageParam;
}
