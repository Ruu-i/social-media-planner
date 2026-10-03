import { randomUUID } from "node:crypto";

import { ContentAgent } from "../agent/agent.js";
import { createConnectionStore, createMediaStore, createSeededStore, profile, USER_ID } from "../seed.js";
import { DynamoStore } from "../store/dynamo.js";
import { DynamoConnectionStore } from "../store/connections-dynamo.js";
import { ensureSeeded } from "../store/bootstrap.js";
import { DynamoMediaStore } from "../store/media-dynamo.js";
import { MockScheduler } from "../scheduler/mock.js";
import type { ConnectionStore } from "../store/connections.js";
import { LocalMediaStorage } from "../media/storage.js";
import { S3MediaStorage } from "../media/s3-storage.js";
import { ConnectService } from "../oauth/connect.js";
import { InstagramOAuthProvider } from "../oauth/instagram.js";
import { UnavailableProvider } from "../oauth/unavailable.js";
import { createTokenStore } from "../oauth/tokens.js";
import type { OAuthProvider } from "../oauth/types.js";
import type { Provider } from "../schemas.js";
import { Publisher } from "../publisher.js";
import { MockMetaConnector, MockTokenProvider } from "../connectors/mock.js";
import { InstagramConnector } from "../connectors/instagram.js";
import { StoredTokenProvider } from "../connectors/tokens.js";
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

/**
 * The media library.
 *
 * In memory this was a per-container Map, so an uploaded photo vanished on the
 * next request — the upload succeeded, the agent then reported no such asset.
 */
const media: MediaStore =
  process.env.STORE === "dynamo"
    ? new DynamoMediaStore(createDynamoClient(), USER_ID)
    : createMediaStore();

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
/**
 * The content store, and the line that was quietly wrong for the whole deploy.
 *
 * This read `createSeededStore(...)` unconditionally — so the deployed Lambda
 * ran entirely on an in-memory store rebuilt from the seed on every cold start,
 * while STORE=dynamo and DDB_TABLE sat in the environment doing nothing. The
 * table held one rate-limit row. Posts the agent wrote, approvals, schedules
 * and OAuth connections all lived in one container and died with it.
 *
 * It looked like it worked because the seed and the table use the same ids, so
 * reads returned plausible data. Nothing failed; it just never persisted.
 */
const connectionStore: ConnectionStore =
  process.env.STORE === "dynamo"
    ? new DynamoConnectionStore(createDynamoClient())
    : createConnectionStore();

const store: ContentStore =
  process.env.STORE === "dynamo"
    ? new DynamoStore(
        createDynamoClient(),
        profile,
        connectionStore,
        new MockScheduler(),
        media,
        process.env.DDB_TABLE,
      )
    : createSeededStore(undefined, media);

/**
 * Write the demo data once, on the first request that finds the table empty.
 *
 * Memoised per container and awaited at the route boundary rather than run at
 * module load, because a cold start must not block on DynamoDB before it knows
 * whether the request even needs it.
 */
let seeding: Promise<boolean> | null = null;

export async function ensureStoreReady(): Promise<boolean> {
  if (process.env.STORE !== "dynamo") return false;
  const seeded = await seedOnce();
  // AFTER seeding, so the first request sees the demo library rather than an
  // empty one.
  await media.refresh();
  return seeded;
}

function seedOnce(): Promise<boolean> {
  seeding ??= ensureSeeded(createDynamoClient()).catch((error) => {
    // Never fatal. A failed seed leaves an empty calendar, which is survivable;
    // taking every route down because the demo content could not be written is
    // not.
    console.error(JSON.stringify({ msg: "seed failed", error: String(error) }));
    return false;
  });
  return seeding;
}

/**
 * Real publishing, or a mock that posts nothing.
 *
 * Gated on LIVE_PUBLISHING rather than on STORE or NODE_ENV, because this is
 * the one switch in the system with an irreversible side effect: the wrong
 * default here puts content on somebody's actual Instagram account. It is
 * therefore opt-in, by name, and off everywhere until explicitly set.
 *
 * The mock is not a lesser version — it fails in all four realistic ways, which
 * is how the publisher's retry and reauth policy got tested without a single
 * real post.
 */
const livePublishing = process.env.LIVE_PUBLISHING === "true";

const tokenProvider = livePublishing
  ? new StoredTokenProvider(connectionStore, createTokenStore(), USER_ID)
  : new MockTokenProvider();

const publisher = new Publisher(
  store,
  tokenProvider,
  livePublishing ? [new InstagramConnector()] : [new MockMetaConnector(() => {})],
);

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

/**
 * The connect flow.
 *
 * Instagram only for now, and that is a capability statement rather than a
 * shortcut: Instagram Login is the single path that reaches CREATOR accounts,
 * and it needs no Facebook Page. Facebook Pages are a second, independent grant
 * — registering it here before its connector exists would put a button in the
 * UI that cannot work.
 */
const oauthProviders = new Map<Provider, OAuthProvider>([
  ["instagram", new InstagramOAuthProvider()],
  // Declared, not omitted. Leaving Facebook out of this map made its row
  // vanish from the UI the moment its connection was deleted — the product
  // appeared to forget the platform existed. Declaring it unavailable keeps
  // the row, with a reason, and makes the real implementation a swap.
  [
    "facebook",
    new UnavailableProvider(
      "facebook",
      "Facebook posting needs a Page you administer, and is not wired up yet.",
    ),
  ],
]);

export const connectService = new ConnectService(
  store.connectionStore,
  createTokenStore(),
  oauthProviders,
);

export { store, media, storage, publisher, conversations, livePublishing, USER_ID };
