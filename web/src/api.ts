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

/**
 * Every request carries the signed-in user's token.
 *
 * Centralised here rather than at each call site: there are twenty of them, and
 * one that forgot would be a request the server answers as somebody else.
 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem("idToken");
  } catch {
    /* private browsing — the request simply goes out unauthenticated */
  }
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

/** Public: it is what tells the browser whether a token is needed at all. */
export const getConfig = () =>
  fetch(apiUrl("/api/config"), { headers: authHeaders() }).then(
    json<{
      authEnabled: boolean;
      cognito: { domain: string; clientId: string; providers?: string[] };
    }>,
  );

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  createSession: () =>
    fetch(apiUrl("/api/sessions"), { method: "POST", headers: authHeaders() }).then(json<{ sessionId: string }>),

  /** The conversation so far, so a browser reload does not lose it. */
  messages: (sessionId: string) =>
    fetch(apiUrl(`/api/sessions/${sessionId}/messages`), { headers: authHeaders() }).then(
      json<{ entries: { role: "user" | "assistant"; text: string }[] }>,
    ),

  calendar: () => fetch(apiUrl("/api/calendar"), { headers: authHeaders() }).then(json<{ items: ContentItem[] }>),

  accounts: () =>
    fetch(apiUrl("/api/accounts"), { headers: authHeaders() }).then(
      json<{ accounts: Account[]; livePublishing: boolean }>,
    ),

  media: () => fetch(apiUrl("/api/media"), { headers: authHeaders() }).then(json<{ assets: MediaAsset[] }>),

  /** The human gate. Goes straight to the backend — never through the agent. */
  approve: (variantId: string) =>
    fetch(apiUrl(`/api/variants/${variantId}/approve`), { method: "POST", headers: authHeaders() }).then(
      json<{ variant: Variant }>,
    ),

  /** Edit the copy directly. Revokes approval, exactly as the agent's edit does. */
  updateVariant: (
    variantId: string,
    changes: { caption?: string; hashtags?: string[]; callToAction?: string },
  ) =>
    fetch(apiUrl(`/api/variants/${variantId}`), {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(changes),
    }).then(json<{ variant: Variant }>),

  /** Commit a post to a time. Goes straight to the store, like approve. */
  schedule: (variantId: string, scheduledFor: string) =>
    fetch(apiUrl(`/api/variants/${variantId}/schedule`), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scheduledFor }),
    }).then(json<{ variant: Variant }>),

  cancel: (variantId: string) =>
    fetch(apiUrl(`/api/variants/${variantId}/cancel`), { method: "POST", headers: authHeaders() }).then(
      json<{ variant: Variant }>,
    ),

  publishDue: () =>
    fetch(apiUrl("/api/publish/run"), { method: "POST", headers: authHeaders() }).then(json<{ outcomes: PublishOutcome[] }>),

  /** Whether a turn is allowed right now — budget AND hourly rate limit. */
  turnAllowed: () =>
    fetch(apiUrl("/api/turn-allowed"), { headers: authHeaders() }).then(
      json<{ allowed: boolean; reason?: string; spentUsd: number; budgetUsd: number }>,
    ),

  profile: () => fetch(apiUrl("/api/profile"), { headers: authHeaders() }).then(json<{ profile: BusinessProfile }>),

  updateProfile: (changes: Partial<BusinessProfile>) =>
    fetch(apiUrl("/api/profile"), {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(changes),
    }).then(json<{ profile: BusinessProfile }>),

  connections: () =>
    fetch(apiUrl("/api/connections"), { headers: authHeaders() }).then(
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
    fetch(apiUrl(`/api/connect/${provider}/start`), { headers: authHeaders() }).then(json<{ url: string }>),

  /** Ask the provider whether a stored grant still works. Persists the answer. */
  verifyConnection: (connectionId: string) =>
    fetch(apiUrl(`/api/connections/${connectionId}/verify`), { method: "POST", headers: authHeaders() }).then(
      json<{ ok: boolean; reason?: string }>,
    ),

  disconnect: (connectionId: string) =>
    fetch(apiUrl(`/api/connections/${connectionId}/disconnect`), { method: "POST", headers: authHeaders() }).then(
      json<{ disconnected: boolean }>,
    ),

  /** Step 1 of a direct upload: a URL the browser can PUT to. */
  uploadUrl: (filename: string) =>
    fetch(apiUrl("/api/media/upload-url"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ filename }),
    }).then(json<{ uploadUrl: string; storageRef: string; publicUrl: string; contentType: string }>),

  /** Step 3: record the file now sitting in S3. */
  registerMedia: (input: {
    filename: string;
    storageRef: string;
    publicUrl: string;
    description: string;
    width: number;
    height: number;
    durationSeconds: number;
    bytes: number;
  }) =>
    fetch(apiUrl("/api/media/register"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    }).then(json<{ asset: MediaAsset; suitableFormats: string[] }>),

  upload: (filename: string, dataBase64: string) =>
    fetch(apiUrl("/api/media"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
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

  /**
   * fetch, not EventSource.
   *
   * EventSource cannot send headers, so the one route that costs money and
   * touches a user's account would have been the only one unable to carry a
   * token. The alternative — putting the token in the query string — writes a
   * live credential into browser history, CloudWatch logs and any proxy in
   * between, which is exactly the kind of leak this work exists to close.
   *
   * fetch streams the same bytes and takes an Authorization header. The cost is
   * parsing the SSE wire format by hand, which is twenty lines: frames are
   * separated by a blank line, and each carries "event:" and "data:".
   */
  const abort = new AbortController();

  void (async () => {
    try {
      const res = await fetch(apiUrl(path), {
        headers: authHeaders({ Accept: "text/event-stream" }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        // A refusal arrives as JSON with a real status, not as a stream — which
        // is why the server checks the budget and the token BEFORE writing any
        // SSE headers.
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        handlers.onError?.(body.message ?? `The server refused the request (${res.status}).`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames end with a blank line. Anything after the last one is a
        // partial frame and has to wait for more bytes.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            // Comment lines (": keepalive", and the padding that defeats
            // Lambda's buffering) are ignored, exactly as EventSource did.
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;

          const payload = JSON.parse(data);
          if (event === "tool") handlers.onTool?.(payload.name);
          else if (event === "thinking") handlers.onThinking?.(payload.delta);
          else if (event === "writing") handlers.onWriting?.();
          else if (event === "text") handlers.onText?.(payload.delta);
          else if (event === "done") handlers.onDone?.(payload);
          else if (event === "error") handlers.onError?.(payload.message);
        }
      }
    } catch (e) {
      // An abort is the caller changing their mind, not a failure.
      if ((e as Error).name === "AbortError") return;
      handlers.onError?.(e instanceof Error ? e.message : String(e));
    }
  })();

  return () => abort.abort();
}
