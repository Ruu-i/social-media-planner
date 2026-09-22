import {
  agentFor,
  createSession,
  media,
  publisher,
  spendGuard,
  store,
  storage,
  USER_ID,
} from "../server/sessions.js";
import { describeImage, canDescribe } from "../media/describe.js";
import { suitableFormats } from "../media/types.js";
import { StoreError } from "../store/memory.js";
import { MediaError } from "../store/media.js";
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

export type RouteResult = JsonResult | BinaryResult;

const json = (statusCode: number, body: unknown): JsonResult => ({
  kind: "json",
  statusCode,
  body,
});

export function errorResult(error: unknown): JsonResult {
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
    if (method === "POST" && path === "/api/sessions") {
      return json(200, { sessionId: createSession() });
    }

    if (method === "GET" && path === "/api/calendar") {
      return json(200, { items: await store.getCalendar(USER_ID) });
    }

    if (method === "GET" && path === "/api/accounts") {
      return json(200, { accounts: await store.getConnectedAccounts(USER_ID) });
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

    const cancel = /^\/api\/variants\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      return json(200, { variant: await store.cancelVariant(USER_ID, cancel[1]!) });
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

  return json(200, {
    asset: media.summarise(USER_ID, asset.id),
    quality: described.quality,
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
