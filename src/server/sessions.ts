import { randomUUID } from "node:crypto";

import { ContentAgent } from "../agent/agent.js";
import { createMediaStore, createSeededStore, USER_ID } from "../seed.js";
import { LocalMediaStorage } from "../media/storage.js";
import { S3MediaStorage } from "../media/s3-storage.js";
import { Publisher } from "../publisher.js";
import { MockMetaConnector, MockTokenProvider } from "../connectors/mock.js";
import {
  DynamoConversationStore,
  MemoryConversationStore,
  type ConversationStore,
} from "../store/conversations.js";
import { createDynamoClient } from "../store/dynamo-table.js";
import type { ContentStore } from "../store/types.js";
import type { MediaStore } from "../store/media.js";
import {
  DynamoBudgetStore,
  MemoryBudgetStore,
  SpendGuard,
  type BudgetStore,
} from "../budget.js";

/**
 * Process-wide wiring for the server.
 *
 * The content store, media library and publisher are shared across sessions
 * because they stand in for a database — two browser tabs should see the same
 * calendar. Only the CONVERSATION is per-session, because that is the only
 * thing genuinely per-user-per-chat.
 *
 * Conversations now live in a ConversationStore rather than a Map of agents.
 * That is what makes the move to Lambda possible: history is rehydrated per
 * request instead of depending on a process that survives between them.
 */

const media: MediaStore = createMediaStore();

/**
 * S3 when a bucket is configured, disk otherwise.
 *
 * Keyed on MEDIA_BUCKET rather than on STORE, because the two are genuinely
 * independent: DynamoDB Local with disk-backed media is a reasonable local
 * setup, and so is the reverse. Tying them to one switch would rule both out.
 *
 * In Lambda the fallback is not a fallback — /var/task is read-only, so an
 * unset MEDIA_BUCKET means every upload fails with EROFS. Terraform always
 * sets it; this default only ever applies locally.
 */
const storage = process.env.MEDIA_BUCKET
  ? new S3MediaStorage(process.env.MEDIA_BUCKET)
  : new LocalMediaStorage();
const store: ContentStore = createSeededStore(undefined, media);

const publisher = new Publisher(store, new MockTokenProvider(), [
  new MockMetaConnector(() => {}),
]);

/**
 * In Lambda this must be DynamoDB — there is no process to hold a Map. Locally
 * the Map is exactly right, and avoids needing DynamoDB Local just to chat.
 */
const conversations: ConversationStore =
  process.env.STORE === "dynamo"
    ? new DynamoConversationStore(createDynamoClient())
    : new MemoryConversationStore();

/**
 * Sessions are now just ids.
 *
 * Previously this held a live ContentAgent per session. It does not any more:
 * an agent is cheap to construct and holds no state, so building one per
 * request is both simpler and the only thing that works when requests land on
 * different containers.
 */
export function createSession(): string {
  return randomUUID();
}

export function agentFor(sessionId: string): ContentAgent {
  return new ContentAgent(
    store,
    { userId: USER_ID, sessionId },
    { storage },
    conversations,
  );
}

/**
 * Spend control. Recording is always on; enforcement waits for DEMO_MODE, so
 * local development is never throttled but the counters are still exercised.
 */
const budgets: BudgetStore =
  process.env.STORE === "dynamo"
    ? new DynamoBudgetStore(createDynamoClient())
    : new MemoryBudgetStore();

export const spendGuard = new SpendGuard(budgets);

export { store, media, storage, publisher, conversations, USER_ID };
