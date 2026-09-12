import { randomUUID } from "node:crypto";

import { ContentAgent } from "../agent/agent.js";
import { createMediaStore, createSeededStore, USER_ID } from "../seed.js";
import { LocalMediaStorage } from "../media/storage.js";
import { Publisher } from "../publisher.js";
import { MockMetaConnector, MockTokenProvider } from "../connectors/mock.js";
import type { MemoryStore } from "../store/memory.js";
import type { MediaStore } from "../store/media.js";

/**
 * Process-wide state for the dev server.
 *
 * The store, media library and publisher are shared across sessions because
 * they stand in for a database — two browser tabs should see the same calendar.
 * Only the CONVERSATION is per-session, because that is the only thing that is
 * genuinely per-user-per-chat.
 *
 * Known limitation, deliberately not solved: conversations live in this
 * process's memory, so they die on restart and would not survive a second
 * instance. Fixing that properly means persisting the message history to the
 * database — worth doing before deploying, pointless for a dev server.
 */

const media: MediaStore = createMediaStore();
const storage = new LocalMediaStorage();
const store: MemoryStore = createSeededStore(undefined, media);

const publisher = new Publisher(store, new MockTokenProvider(), [
  new MockMetaConnector(() => {}),
]);

const agents = new Map<string, ContentAgent>();

export function createSession(): string {
  const id = randomUUID();
  agents.set(id, new ContentAgent(store, { userId: USER_ID }, { storage }));
  return id;
}

export function getAgent(sessionId: string): ContentAgent | null {
  return agents.get(sessionId) ?? null;
}

export { store, media, storage, publisher, USER_ID };
