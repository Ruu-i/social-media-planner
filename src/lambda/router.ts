import {
  agentFor,
  connectService,
  conversations,
  createSession,
  livePublishing,
  ensureStoreReady,
  media,
  publisher,
  spendGuard,
  store,
  storage,
  USER_ID,
} from "../server/sessions.js";
import { describeImage, canDescribe } from "../media/describe.js";
import { ensureApiKey } from "../agent/provider.js";
import { suitableFormats } from "../media/types.js";
import { ensureOAuthSecrets } from "../oauth/secrets.js";
import { toTranscript } from "../agent/transcript.js";
import { OAuthError } from "../oauth/types.js";
import { StoreError } from "../store/memory.js";
import { MediaError } from "../store/media.js";
import type { Provider } from "../schemas.js";
import type { FunctionUrlEvent } from "./runtime.js";

/**
 * Request handling for the Lambda, independent of the streaming plumbing.
 *
 * Split from handler.ts so the routes can be exercised by tests without a
 * Lambda runtime and without a `ResponseStream`.
 *
 * Two routes are the whole architecture, and neither goes through the agent:
 *
 *   POST /api/variants/:id/approve   the human gate
 *   POST /api/publish/run            stands in for the scheduler firing
 *
 * They call the store directly. No tool the model has can reach either, which
 * is what makes "the agent cannot publish unapproved content" a fact about the
 * system rather than a promise in a prompt.
 */

export interface JsonResult {
  kind: "json";
  statusCode: number;
  body: unknown;
}

export interface BinaryResult {
  kind: "binary";
  statusCode: number;
  contentType: string;
  body: Buffer;
}

export interface RedirectResult {
  kind: "redirect";
  statusCode: number;
  location: string;
}

export type RouteResult = JsonResult | BinaryResult | RedirectResult;

const json = (statusCode: number, body: unknown): JsonResult => ({
  kind: "json",
  statusCode,
  body,
});

export function errorResult(error: unknown): JsonResult {
  if (error instanceof OAuthError) {
    // NOT_CONFIGURED is 503 rather than 500: the app is fine, this provider
    // just has not been set up yet, and the distinction is the difference
    // between "you broke it" and "that is not available".
    const statusCode =
      error.code === "NOT_CONFIGURED" ? 503 : error.code === "BAD_STATE" ? 400 : 409;
    return json(statusCode, { error: error.code, message: error.message });
  }
  if (error instanceof StoreError || error instanceof MediaError) {
    const statusCode =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "INVALID_STATE" || error.code === "NOT_CONNECTED"
            ? 409
            : 400;
    return json(statusCode, { error: error.code, message: error.message });
  }
  return json(500, {
    error: "INTERNAL",
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Who to rate-limit.
 *
 * Behind CloudFront the source IP is the CDN, so the forwarded header is the
 * only thing identifying a visitor. Taking the FIRST entry matters: later ones
 * are appended by proxies and can be spoofed by the client.
 */
export function clientIdOf(event: FunctionUrlEvent): string {
  const forwarded = event.headers["x-forwarded-for"];
  const first = forwarded?.split(",")[0];
  return (first ?? event.requestContext.http.sourceIp ?? "unknown").trim();
}

/** The SSE route is handled separately because it streams; this matches it. */
export function isStreamRoute(event: FunctionUrlEvent): string | null {
  const match = /^\/api\/sessions\/([^/]+)\/stream$/.exec(event.rawPath);
  return event.requestContext.http.method === "GET" && match ? match[1]! : null;
}

function bodyOf(event: FunctionUrlEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Hand-written routing for ten routes.
 *
 * Deliberately not an Express adapter: `streamifyResponse` does not compose
 * cleanly with Express middleware, and at this size the router is smaller than
 * the adapter would be.
 */
export async function route(event: FunctionUrlEvent): Promise<RouteResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    // The table is seeded on the first request that finds it empty. Awaited
    // here rather than per-route so no route can forget.
    await ensureStoreReady();

    if (method === "POST" && path === "/api/sessions") {
      return json(200, { sessionId: createSession() });
    }

    // Reloading the browser must not lose the conversation. The history is in
    // the store either way; without this route the UI simply had no way to ask
    // for it.
    const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
    if (method === "GET" && messages) {
      return json(200, { entries: toTranscript(await conversations.load(messages[1]!)) });
    }

    if (method === "GET" && path === "/api/profile") {
      return json(200, { profile: await store.getBusinessProfile(USER_ID) });
    }

    if (method === "PATCH" && path === "/api/profile") {
      const body = bodyOf(event);
      const changes: Record<string, unknown> = {};

      for (const field of [
        "businessName",
        "description",
        "industry",
        "targetAudience",
        "location",
        "timezone",
        "tone",
        "marketingGoal",
      ]) {
        if (typeof body[field] === "string") changes[field] = body[field];
      }
      if (typeof body.postsPerWeek === "number" && body.postsPerWeek > 0) {
        changes.postsPerWeek = Math.round(body.postsPerWeek);
      }
      for (const field of ["contentPillars", "bannedWords"]) {
        if (Array.isArray(body[field])) {
          changes[field] = (body[field] as unknown[])
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(Boolean);
        }
      }

      // An empty pillar list would leave the agent with nothing to plan around,
      // so it is refused rather than saved as a profile that cannot be used.
      if (Array.isArray(changes.contentPillars) && changes.contentPillars.length === 0) {
        return json(400, {
          error: "INVALID_INPUT",
          message: "Keep at least one content pillar — the agent plans around them.",
        });
      }
      if (Object.keys(changes).length === 0) {
        return json(400, { error: "INVALID_INPUT", message: "Nothing to change" });
      }

      return json(200, { profile: await store.updateBusinessProfile(USER_ID, changes) });
    }

    if (method === "GET" && path === "/api/calendar") {
      return json(200, { items: await store.getCalendar(USER_ID) });
    }

    if (method === "GET" && path === "/api/accounts") {
      return json(200, {
        accounts: await store.getConnectedAccounts(USER_ID),
        // The UI needs to know whether publishing is real before it offers a
        // button that posts. Reported by the server rather than guessed from a
        // build flag, because the two can disagree.
        livePublishing,
      });
    }

    // Asked BEFORE the stream is opened.
    //
    // A refusal on the stream route is a 429, and EventSource cannot read a
    // non-200 body — it reports an opaque connection failure. So a rate-limited
    // user was told "Connection to the server was lost", which is both wrong
    // and unactionable: nothing is broken, they have simply used their turns.
    //
    // Unlike /api/budget this applies the PER-CLIENT hourly limit too, which is
    // the one people actually hit.
    if (method === "GET" && path === "/api/turn-allowed") {
      return json(200, await spendGuard.check(clientIdOf(event)));
    }

    if (method === "GET" && path === "/api/budget") {
      return json(200, await spendGuard.status());
    }

    if (method === "GET" && path === "/api/media") {
      return json(200, { assets: media.search(USER_ID, { limit: 100 }) });
    }

    const item = /^\/api\/items\/([^/]+)$/.exec(path);
    if (method === "GET" && item) {
      return json(200, { item: await store.getItem(USER_ID, item[1]!) });
    }

    const approve = /^\/api\/variants\/([^/]+)\/approve$/.exec(path);
    if (method === "POST" && approve) {
      // The human gate. Straight to the store — no tool reaches this code.
      return json(200, { variant: await store.humanApprove(USER_ID, approve[1]!) });
    }

    // Direct editing, bypassing the agent — for a typo, a wrong price, a name
    // spelled badly. Going through the model for that costs a turn, takes
    // ~80 seconds and may rewrite more than was asked.
    //
    // It deliberately shares the store method the agent's update_variant tool
    // uses, so the approval rule applies identically: changing CONTENT revokes
    // approval, changing only the time keeps it. Editing your way around the
    // human gate is therefore impossible by construction.
    const edit = /^\/api\/variants\/([^/]+)$/.exec(path);
    if (method === "PATCH" && edit) {
      const body = bodyOf(event);
      const changes: Record<string, unknown> = {};
      if (typeof body.caption === "string") changes.caption = body.caption;
      if (typeof body.callToAction === "string") changes.callToAction = body.callToAction;
      if (Array.isArray(body.assetIds)) {
        changes.assetIds = (body.assetIds as unknown[]).filter(
          (a): a is string => typeof a === "string",
        );
      }
      if (Array.isArray(body.hashtags)) {
        changes.hashtags = (body.hashtags as unknown[])
          .filter((h): h is string => typeof h === "string")
          .map((h) => h.replace(/^#/, "").trim())
          .filter(Boolean);
      }
      if (Object.keys(changes).length === 0) {
        return json(400, { error: "INVALID_INPUT", message: "Nothing to change" });
      }
      return json(200, { variant: await store.updateVariant(USER_ID, edit[1]!, changes) });
    }

    const cancel = /^\/api\/variants\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      return json(200, { variant: await store.cancelVariant(USER_ID, cancel[1]!) });
    }

    if (method === "GET" && path === "/api/connections") {
      // Resolved before listProviders(), or every provider reports itself
      // unconfigured on a cold start and the UI greys out a working button.
      await ensureOAuthSecrets();
      return json(200, {
        connections: (await store.connectionStore.listConnections(USER_ID)).map((c) => ({
          // Deliberately lossy, exactly like the agent's channel view:
          // tokenRef and scopes never leave the server.
          id: c.id,
          provider: c.provider,
          status: c.status,
          connectedAt: c.connectedAt,
          expiresAt: c.expiresAt,
        })),
        providers: connectService.listProviders(),
      });
    }

    const start = /^\/api\/connect\/([^/]+)\/start$/.exec(path);
    if (method === "GET" && start) {
      await ensureOAuthSecrets();
      const provider = start[1] as Provider;
      // Returned as JSON rather than a 302 so the browser leaves the SPA by an
      // explicit click, and a misconfigured provider surfaces as a readable
      // message instead of a redirect to an error page.
      return json(200, {
        url: connectService.start(USER_ID, provider, redirectUriFor(event, provider)),
      });
    }

    const callback = /^\/api\/connect\/([^/]+)\/callback$/.exec(path);
    if (method === "GET" && callback) {
      await ensureOAuthSecrets();
      const provider = callback[1] as Provider;
      const params = new URLSearchParams(event.rawQueryString ?? "");

      // The user declined, or the provider refused. Not an error on our side.
      const denied = params.get("error");
      if (denied) {
        return redirectToUi(`connected=0&reason=${encodeURIComponent(denied)}`);
      }

      const result = await connectService.callback(
        provider,
        params.get("code") ?? "",
        params.get("state") ?? "",
        redirectUriFor(event, provider),
      );
      return redirectToUi(`connected=1&handle=${encodeURIComponent(result.handles[0] ?? "")}`);
    }

    const verify = /^\/api\/connections\/([^/]+)\/verify$/.exec(path);
    if (method === "POST" && verify) {
      await ensureOAuthSecrets();
      return json(200, await connectService.verify(USER_ID, verify[1]!));
    }

    const disconnect = /^\/api\/connections\/([^/]+)\/disconnect$/.exec(path);
    if (method === "POST" && disconnect) {
      await connectService.disconnect(USER_ID, disconnect[1]!);
      return json(200, { disconnected: true });
    }

    if (method === "POST" && path === "/api/publish/run") {
      // Stands in for the EventBridge timer. Also unreachable by the agent.
      return json(200, { outcomes: await publisher.publishDue(USER_ID) });
    }

    const file = /^\/api\/media\/([^/]+)\/file$/.exec(path);
    if (method === "GET" && file) {
      try {
        const asset = media.get(USER_ID, file[1]!);
        return {
          kind: "binary",
          statusCode: 200,
          contentType: asset.mimeType,
          body: await storage.read(asset.storageRef),
        };
      } catch {
        // Seeded assets have no file behind them; a 404 is the honest answer
        // and the UI falls back to the shape label.
        return json(404, { error: "NOT_FOUND", message: "No file for that asset" });
      }
    }

    if (method === "POST" && path === "/api/media/upload-url") {
      return await presignUpload(bodyOf(event));
    }

    if (method === "POST" && path === "/api/media/register") {
      return await registerUploaded(bodyOf(event));
    }

    if (method === "POST" && path === "/api/media") {
      return await uploadMedia(bodyOf(event));
    }

    return json(404, { error: "NOT_FOUND", message: `No route for ${method} ${path}` });
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Upload one photo.
 *
 * The vision pass runs here, once, while the user is already waiting for the
 * upload — never on a planning turn. That is the whole media cost strategy: a
 * photo is ~1,500 tokens, so describing per plan would be ruinous.
 */
async function uploadMedia(body: Record<string, unknown>): Promise<RouteResult> {
  const { filename, dataBase64 } = body;
  if (typeof filename !== "string" || typeof dataBase64 !== "string") {
    return json(400, {
      error: "INVALID_INPUT",
      message: "filename and dataBase64 are required",
    });
  }

  const mimeType = mimeFor(filename);
  if (!canDescribe(mimeType)) {
    return json(400, {
      error: "INVALID_INPUT",
      message: `${mimeType} cannot be described. Use jpg, png, gif or webp.`,
    });
  }

  // The vision pass needs the key too.
  await ensureApiKey();

  const data = Buffer.from(dataBase64, "base64");
  const profile = await store.getBusinessProfile(USER_ID);
  const described = await describeImage(data, mimeType, {
    businessName: profile.businessName,
    industry: profile.industry,
  });
  const dims = imageSize(data) ?? { width: 1080, height: 1080 };
  const stored = await storage.put(USER_ID, filename, data);

  const asset = media.add({
    userId: USER_ID,
    kind: "IMAGE",
    mimeType,
    filename,
    bytes: data.byteLength,
    width: dims.width,
    height: dims.height,
    storageRef: stored.storageRef,
    publicUrl: stored.publicUrl,
    description: described.description,
    tags: described.tags,
    hasTextInFrame: described.hasTextInFrame,
    describedFrom: "IMAGE",
  });

  // `add` is synchronous, so the DynamoDB write is still in flight here.
  // Replying first would tell the user their photo is stored and then lose it.
  await media.flush();

  return json(200, {
    asset: media.summarise(USER_ID, asset.id),
    quality: described.quality,
    suitableFormats: suitableFormats(asset),
  });
}


/**
 * The redirect URI handed to the provider.
 *
 * Must match what is registered with Meta EXACTLY — scheme, host, path, no
 * trailing slash — or the authorization is rejected before the user sees a
 * consent screen. Taken from configuration rather than the request host so it
 * cannot drift with whatever hostname a request happened to arrive on.
 */
function redirectUriFor(event: FunctionUrlEvent, provider: string): string {
  // `||` not `??`: Terraform sets this to the empty string when unconfigured,
  // and "" is not nullish — `??` would happily build "/api/connect/..." with no
  // origin at all, which Meta rejects as an invalid redirect URI.
  const base = (process.env.PUBLIC_API_BASE || `https://${event.headers.host ?? ""}`).replace(
    /\/$/,
    "",
  );
  return `${base}/api/connect/${provider}/callback`;
}

/** Hand the browser back to the SPA after the round trip. */
function redirectToUi(query: string): RouteResult {
  const ui = (process.env.PUBLIC_UI_BASE ?? "/").replace(/\/$/, "");
  return {
    kind: "redirect",
    statusCode: 302,
    location: `${ui}/?${query}`,
  };
}


/** Video types we accept. Meta publishes MP4 and MOV for Reels and Stories. */
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Hand the browser a URL it can upload to directly.
 *
 * Only the metadata comes back through this app. That is what makes video
 * possible at all — the bytes never enter a Lambda request.
 */
async function presignUpload(body: Record<string, unknown>): Promise<RouteResult> {
  const { filename } = body;
  if (typeof filename !== "string" || !filename.trim()) {
    return json(400, { error: "INVALID_INPUT", message: "filename is required" });
  }

  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const contentType = VIDEO_TYPES[ext] ?? mimeFor(filename);
  if (contentType === "application/octet-stream") {
    return json(400, {
      error: "INVALID_INPUT",
      message: `${ext || "that file"} is not supported. Use jpg, png, gif, webp, mp4 or mov.`,
    });
  }

  if (!("presignPut" in storage)) {
    return json(503, {
      error: "NOT_CONFIGURED",
      message: "Direct upload needs S3. Set MEDIA_BUCKET.",
    });
  }

  const signed = await (
    storage as unknown as {
      presignPut: (u: string, f: string, c: string) => Promise<Record<string, string>>;
    }
  ).presignPut(USER_ID, filename, contentType);

  return json(200, { ...signed, contentType });
}

/**
 * Record a file the browser has already put in S3.
 *
 * Video skips the vision pass entirely: the model cannot watch a video, and
 * describing one frame of it invites confident nonsense about what happens in
 * the other fourteen seconds. The USER describes it instead, which is both
 * cheaper and more accurate — they were there.
 */
async function registerUploaded(body: Record<string, unknown>): Promise<RouteResult> {
  const { filename, storageRef, publicUrl, description } = body;
  if (typeof filename !== "string" || typeof storageRef !== "string" || typeof publicUrl !== "string") {
    return json(400, {
      error: "INVALID_INPUT",
      message: "filename, storageRef and publicUrl are required",
    });
  }

  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const isVideo = ext in VIDEO_TYPES;
  const mimeType = isVideo ? VIDEO_TYPES[ext]! : mimeFor(filename);

  const described = typeof description === "string" ? description.trim() : "";
  if (isVideo && described.length < 10) {
    // Refused rather than defaulted. An agent planning around "a video" writes
    // copy that fits anything, which is to say nothing.
    return json(400, {
      error: "INVALID_INPUT",
      message: "Describe what happens in the video — the agent cannot watch it.",
    });
  }

  const width = Number(body.width) || 1080;
  const height = Number(body.height) || 1920;
  const durationSeconds = isVideo ? Math.round(Number(body.durationSeconds) || 0) : null;

  const asset = media.add({
    userId: USER_ID,
    kind: isVideo ? "VIDEO" : "IMAGE",
    mimeType,
    filename,
    bytes: Number(body.bytes) || 0,
    width,
    height,
    durationSeconds,
    storageRef,
    publicUrl,
    description: described,
    tags: [],
    hasTextInFrame: false,
    describedFrom: isVideo ? "USER_PROVIDED" : "IMAGE",
  });

  await media.flush();

  return json(200, {
    asset: media.summarise(USER_ID, asset.id),
    suitableFormats: suitableFormats(asset),
  });
}

function mimeFor(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return types[ext] ?? "application/octet-stream";
}

/** Minimal dimension reader, so an upload needs no image library. */
function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrameHeader) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export { agentFor, spendGuard, clientIdOf as _clientIdOf };
