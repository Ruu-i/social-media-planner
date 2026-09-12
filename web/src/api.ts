/**
 * The API client.
 *
 * Types are duplicated rather than imported from the server package. That is a
 * deliberate trade for a two-package repo: sharing them properly means a shared
 * workspace package, which is worth doing when the API stabilises and is
 * overhead before then.
 */

export type Status =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "SCHEDULED"
  | "PUBLISHED"
  | "FAILED"
  | "CANCELLED";

export type Format = "POST" | "CAROUSEL" | "REEL" | "STORY";
export type Platform = "instagram" | "facebook";

export interface MediaSpec {
  format: Format;
  imageConcept?: string;
  cards?: string[];
  durationSeconds?: number;
  coverFrame?: string;
  audio?: string;
  shotList?: string[];
  visual?: string;
  interaction?: string;
  interactionPrompt?: string;
}

export interface Variant {
  id: string;
  itemId: string;
  platform: Platform;
  channelId: string;
  media: MediaSpec;
  assetIds: string[];
  scheduledFor: string;
  hook: string;
  caption: string;
  hashtags: string[];
  callToAction: string;
  status: Status;
  platformPostId: string | null;
  permalink: string | null;
  failureReason: string | null;
}

export interface ContentItem {
  id: string;
  topic: string;
  coreMessage: string;
  pillar: string;
  contentCategory: string;
  rationale: string;
  campaignId: string | null;
  plannedFor: string | null;
  plannedFormat: Format | null;
  variants: Variant[];
}

export interface MediaAsset {
  assetId: string;
  kind: "IMAGE" | "VIDEO";
  aspectRatio: string;
  durationSeconds: number | null;
  description: string;
  tags: string[];
  hasTextInFrame: boolean;
  describedFrom: "IMAGE" | "VIDEO_FRAME" | "NOT_DESCRIBED";
  suitableFormats: string[];
}

export interface Account {
  channelId: string;
  platform: Platform;
  handle: string;
  accountType: string;
  connectionStatus: "ACTIVE" | "EXPIRED" | "REAUTH_REQUIRED";
  supportedFormats: Format[];
}

export interface PublishOutcome {
  variantId: string;
  platform: Platform;
  status: "PUBLISHED" | "FAILED" | "RETRY";
  detail: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  createSession: () =>
    fetch("/api/sessions", { method: "POST" }).then(json<{ sessionId: string }>),

  calendar: () => fetch("/api/calendar").then(json<{ items: ContentItem[] }>),

  accounts: () => fetch("/api/accounts").then(json<{ accounts: Account[] }>),

  media: () => fetch("/api/media").then(json<{ assets: MediaAsset[] }>),

  /** The human gate. Goes straight to the backend — never through the agent. */
  approve: (variantId: string) =>
    fetch(`/api/variants/${variantId}/approve`, { method: "POST" }).then(
      json<{ variant: Variant }>,
    ),

  cancel: (variantId: string) =>
    fetch(`/api/variants/${variantId}/cancel`, { method: "POST" }).then(
      json<{ variant: Variant }>,
    ),

  publishDue: () =>
    fetch("/api/publish/run", { method: "POST" }).then(json<{ outcomes: PublishOutcome[] }>),

  upload: (filename: string, dataBase64: string) =>
    fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, dataBase64 }),
    }).then(json<{ asset: MediaAsset; quality: string; suitableFormats: string[] }>),
};

export interface StreamHandlers {
  onTool?(name: string): void;
  onThinking?(delta: string): void;
  onWriting?(): void;
  onText?(delta: string): void;
  onDone?(payload: { text: string; toolCalls: number; usage: Record<string, number> }): void;
  onError?(message: string): void;
}

/**
 * Open the agent turn as a stream.
 *
 * A planning turn runs ~80 seconds — well past the point a plain fetch would be
 * killed by a proxy — so the turn arrives as Server-Sent Events. Returns a
 * function that aborts the stream.
 */
export function streamTurn(
  sessionId: string,
  message: string,
  handlers: StreamHandlers,
): () => void {
  const url = `/api/sessions/${sessionId}/stream?q=${encodeURIComponent(message)}`;
  const source = new EventSource(url);

  source.addEventListener("tool", (e) =>
    handlers.onTool?.(JSON.parse((e as MessageEvent).data).name),
  );
  source.addEventListener("thinking", (e) =>
    handlers.onThinking?.(JSON.parse((e as MessageEvent).data).delta),
  );
  source.addEventListener("writing", () => handlers.onWriting?.());
  source.addEventListener("text", (e) =>
    handlers.onText?.(JSON.parse((e as MessageEvent).data).delta),
  );
  source.addEventListener("done", (e) => {
    handlers.onDone?.(JSON.parse((e as MessageEvent).data));
    source.close();
  });
  source.addEventListener("error", (e) => {
    // Two different failures arrive on this listener: an "error" event the
    // server sent deliberately, and the browser's own connection error, which
    // carries no data. Only the first has something worth showing.
    const data = (e as MessageEvent).data;
    if (data) {
      handlers.onError?.(JSON.parse(data).message);
    } else if (source.readyState === EventSource.CLOSED) {
      handlers.onError?.("Connection to the server was lost.");
    }
    source.close();
  });

  return () => source.close();
}
