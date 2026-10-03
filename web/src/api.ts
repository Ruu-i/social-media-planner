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
  /** When it actually went out, as opposed to when it was meant to. */
  publishedAt: string | null;
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
  filename: string;
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

/**
 * One OAuth grant. Note what is absent: no token, no tokenRef, no scopes —
 * the server does not send them, so the browser cannot leak them.
 */
export interface Connection {
  id: string;
  provider: string;
  status: "ACTIVE" | "EXPIRED" | "REAUTH_REQUIRED";
  connectedAt: string;
  expiresAt: string | null;
}

/** A provider the server knows about, and whether its app credentials exist. */
export interface ProviderStatus {
  provider: string;
  configured: boolean;
  /** Why it cannot be connected. Present only when `configured` is false. */
  reason?: string;
}

/** Everything the agent knows about who it is writing for. */
export interface BusinessProfile {
  businessName: string;
  description: string;
  industry: string;
  targetAudience: string;
  location: string;
  timezone: string;
  tone: string;
  marketingGoal: string;
  postsPerWeek: number;
  contentPillars: string[];
  bannedWords: string[];
}

export interface PublishOutcome {
  variantId: string;
  platform: Platform;
  status: "PUBLISHED" | "FAILED" | "RETRY";
  detail: string;
}

/**
 * Where the API lives.
 *
 * In development this is empty, so paths stay relative and Vite's proxy
 * forwards them — one origin, no CORS.
 *
 * In production the UI is on CloudFront and the API is on a Lambda Function
 * URL, which are DIFFERENT ORIGINS. That separation is deliberate: CloudFront
 * buffers streaming responses, which would destroy the live progress the agent
 * turn depends on. So the built bundle needs the API's absolute address baked
 * in at build time.
 *
 *   VITE_API_BASE=https://xxxx.lambda-url.us-east-1.on.aws npm run build
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export const apiUrl = (path: string) => `${API_BASE}${path}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  createSession: () =>
    fetch(apiUrl("/api/sessions"), { method: "POST" }).then(json<{ sessionId: string }>),

  /** The conversation so far, so a browser reload does not lose it. */
  messages: (sessionId: string) =>
    fetch(apiUrl(`/api/sessions/${sessionId}/messages`)).then(
      json<{ entries: { role: "user" | "assistant"; text: string }[] }>,
    ),

  calendar: () => fetch(apiUrl("/api/calendar")).then(json<{ items: ContentItem[] }>),

  accounts: () =>
    fetch(apiUrl("/api/accounts")).then(
      json<{ accounts: Account[]; livePublishing: boolean }>,
    ),

  media: () => fetch(apiUrl("/api/media")).then(json<{ assets: MediaAsset[] }>),

  /** The human gate. Goes straight to the backend — never through the agent. */
  approve: (variantId: string) =>
    fetch(apiUrl(`/api/variants/${variantId}/approve`), { method: "POST" }).then(
      json<{ variant: Variant }>,
    ),

  /** Edit the copy directly. Revokes approval, exactly as the agent's edit does. */
  updateVariant: (
    variantId: string,
    changes: { caption?: string; hashtags?: string[]; callToAction?: string },
  ) =>
    fetch(apiUrl(`/api/variants/${variantId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }).then(json<{ variant: Variant }>),

  cancel: (variantId: string) =>
    fetch(apiUrl(`/api/variants/${variantId}/cancel`), { method: "POST" }).then(
      json<{ variant: Variant }>,
    ),

  publishDue: () =>
    fetch(apiUrl("/api/publish/run"), { method: "POST" }).then(json<{ outcomes: PublishOutcome[] }>),

  /** Whether a turn is allowed right now — budget AND hourly rate limit. */
  turnAllowed: () =>
    fetch(apiUrl("/api/turn-allowed")).then(
      json<{ allowed: boolean; reason?: string; spentUsd: number; budgetUsd: number }>,
    ),

  profile: () => fetch(apiUrl("/api/profile")).then(json<{ profile: BusinessProfile }>),

  updateProfile: (changes: Partial<BusinessProfile>) =>
    fetch(apiUrl("/api/profile"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }).then(json<{ profile: BusinessProfile }>),

  connections: () =>
    fetch(apiUrl("/api/connections")).then(
      json<{ connections: Connection[]; providers: ProviderStatus[] }>,
    ),

  /**
   * Returns the provider's URL rather than following it.
   *
   * The redirect has to happen as a full page navigation the user can see —
   * fetch-following it would land the consent page inside an XHR, where it
   * cannot be displayed and the user never gets to approve anything.
   */
  connectStart: (provider: string) =>
    fetch(apiUrl(`/api/connect/${provider}/start`)).then(json<{ url: string }>),

  /** Ask the provider whether a stored grant still works. Persists the answer. */
  verifyConnection: (connectionId: string) =>
    fetch(apiUrl(`/api/connections/${connectionId}/verify`), { method: "POST" }).then(
      json<{ ok: boolean; reason?: string }>,
    ),

  disconnect: (connectionId: string) =>
    fetch(apiUrl(`/api/connections/${connectionId}/disconnect`), { method: "POST" }).then(
      json<{ disconnected: boolean }>,
    ),

  upload: (filename: string, dataBase64: string) =>
    fetch(apiUrl("/api/media"), {
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
  attachedAssetIds: string[] = [],
): () => void {
  // Attached files are already uploaded by this point; the ids tell the agent
  // what "this" refers to in "schedule this reel".
  const assets = attachedAssetIds.length
    ? `&assets=${encodeURIComponent(attachedAssetIds.join(","))}`
    : "";
  const path = `/api/sessions/${sessionId}/stream?q=${encodeURIComponent(message)}${assets}`;
  // apiUrl, NOT a bare relative path. Every other call goes through it; this one
  // did not, so in production the stream was opened against CloudFront — which
  // answers unknown paths with index.html, so EventSource would fail on HTML
  // where every other request succeeded. Locally it worked, because Vite's proxy
  // makes relative and absolute the same thing.
  // Preflight the guard before opening the stream, so a refusal arrives as a
  // readable reason instead of an opaque EventSource error.
  const source = new EventSource(apiUrl(path));

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
