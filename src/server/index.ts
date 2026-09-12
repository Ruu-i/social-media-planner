import "dotenv/config";
import express from "express";
import cors from "cors";

import { createSession, getAgent, media, publisher, store, storage, USER_ID } from "./sessions.js";
import { describeImage, canDescribe } from "../media/describe.js";
import { suitableFormats } from "../media/types.js";
import { readVideoInfo, videoMimeFor } from "../media/video.js";
import { StoreError } from "../store/memory.js";
import { MediaError } from "../store/media.js";

/**
 * The HTTP layer.
 *
 * It is deliberately thin. Every rule — who may approve, what may be scheduled,
 * which assets fit which format — already lives in the store, so this file's
 * only jobs are transport and translating errors into status codes.
 *
 * Two routes are the whole point of the architecture:
 *
 *   POST /api/variants/:id/approve   does NOT go through the agent
 *   POST /api/publish/run            does NOT go through the agent either
 *
 * They call the store directly, the way an authenticated click should. The
 * model has no path to either, which is what makes "the agent cannot publish
 * unapproved content" a fact about the system rather than a promise.
 */

const app = express();
// Base64 uploads ride in the JSON body, so the default 100kb limit is far too
// small for a photo.
app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: true }));

const PORT = Number(process.env.PORT ?? 3001);

function fail(res: express.Response, error: unknown) {
  if (error instanceof StoreError || error instanceof MediaError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "FORBIDDEN"
          ? 403
          : error.code === "INVALID_STATE" || error.code === "NOT_CONNECTED"
            ? 409
            : 400;
    return res.status(status).json({ error: error.code, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ error: "INTERNAL", message });
}

// -- conversation ------------------------------------------------------------

app.post("/api/sessions", (_req, res) => {
  res.json({ sessionId: createSession() });
});

/**
 * The agent turn, streamed.
 *
 * A planning turn takes ~80 seconds — far past the point where a plain
 * request/response would be killed by a proxy. Server-Sent Events keep the
 * connection alive and let the browser render exactly what the terminal shows:
 * reasoning, the phase, then tokens as they arrive.
 *
 * SSE is GET-only, so the message rides in a query parameter rather than a body.
 */
app.get("/api/sessions/:id/stream", async (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "NOT_FOUND", message: "No such session" });

  const message = String(req.query.q ?? "").trim();
  if (!message) return res.status(400).json({ error: "INVALID_INPUT", message: "q is required" });

  /**
   * Files attached to THIS message.
   *
   * They are already uploaded and described by the time we get here, so what
   * the agent needs is not the bytes but the knowledge that "this" in "schedule
   * this reel" refers to a specific asset. Prepending a delimited block is the
   * same trick the time context uses, and it keeps the reference unambiguous
   * without inventing a tool.
   */
  const attachedIds = String(req.query.assets ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  let prompt = message;
  if (attachedIds.length > 0) {
    const lines: string[] = [];
    for (const id of attachedIds) {
      const a = media.summarise(USER_ID, id);
      if (!a) continue;
      lines.push(
        `- ${a.assetId} (${a.kind}, ${a.aspectRatio}` +
          `${a.durationSeconds ? `, ${a.durationSeconds}s` : ""}) ` +
          `usable as: ${a.suitableFormats.join(", ") || "NOTHING — wrong shape for any format"}
` +
          `  ${a.description}` +
          (a.describedFrom === "NOT_DESCRIBED"
            ? `
  NOT DESCRIBED: this is a video and you cannot watch it. You know only its ` +
              `shape and length. Ask the user what is in it rather than inventing detail, ` +
              `and say so plainly if you write copy around it.`
            : ""),
      );
    }
    if (lines.length > 0) {
      prompt =
        `<attached_media>
The user attached these files to this message. When they say ` +
        `"this", they mean these. Whenever you create or revise content that uses one of ` +
        `these files, you MUST put its id in that variant's assetIds — otherwise the ` +
        `content is not actually linked to the file and will publish with nothing attached.

${lines.join("\n")}
</attached_media>

${message}`;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Without this, nginx and friends buffer the whole response and the stream
    // arrives all at once at the end — which looks exactly like a hang.
    "X-Accel-Buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // A heartbeat keeps intermediaries from closing an idle connection during the
  // long stretch where the model is writing tool arguments and emitting nothing.
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);

  try {
    const result = await agent.send(prompt, {
      onToolCall: (name) => send("tool", { name }),
      onThinking: (delta) => send("thinking", { delta }),
      onWriting: () => send("writing", {}),
      onText: (delta) => send("text", { delta }),
    });
    send("done", {
      text: result.text,
      toolCalls: result.toolCalls.length,
      usage: result.usage,
    });
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// -- calendar ----------------------------------------------------------------

app.get("/api/calendar", (_req, res) => {
  try {
    res.json({ items: store.getCalendar(USER_ID) });
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/items/:id", (req, res) => {
  try {
    res.json({ item: store.getItem(USER_ID, req.params.id) });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * THE HUMAN GATE.
 *
 * This is the endpoint the Approve button hits. It bypasses the agent entirely
 * and calls the store directly — there is no tool that reaches this code, so an
 * agent cannot approve its own work no matter what it is told.
 */
app.post("/api/variants/:id/approve", (req, res) => {
  try {
    res.json({ variant: store.humanApprove(USER_ID, req.params.id) });
  } catch (e) {
    fail(res, e);
  }
});

app.post("/api/variants/:id/cancel", async (req, res) => {
  try {
    res.json({ variant: await store.cancelVariant(USER_ID, req.params.id) });
  } catch (e) {
    fail(res, e);
  }
});

/** Stands in for the EventBridge timer firing. Also not reachable by the agent. */
app.post("/api/publish/run", async (_req, res) => {
  try {
    res.json({ outcomes: await publisher.publishDue(USER_ID) });
  } catch (e) {
    fail(res, e);
  }
});

// -- media -------------------------------------------------------------------

app.get("/api/media", (_req, res) => {
  try {
    res.json({ assets: media.search(USER_ID, { limit: 100 }) });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Upload one photo.
 *
 * The vision pass runs here, once, while the user is already waiting for the
 * upload — never on a planning turn. That is the whole cost strategy: a photo
 * is ~1,500 tokens, so describing on every plan would be ruinous.
 *
 * Base64 in a JSON body rather than multipart: it keeps the dependency list
 * short and a browser can produce it with one FileReader call.
 */
app.post("/api/media", async (req, res) => {
  const { filename, dataBase64 } = req.body ?? {};
  if (typeof filename !== "string" || typeof dataBase64 !== "string") {
    return res
      .status(400)
      .json({ error: "INVALID_INPUT", message: "filename and dataBase64 are required" });
  }

  const videoMime = videoMimeFor(filename);
  const mimeType = videoMime ?? mimeFor(filename);
  if (!videoMime && !canDescribe(mimeType)) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: `${mimeType} is not supported. Use jpg, png, gif, webp, mp4 or mov.`,
    });
  }

  try {
    const data = Buffer.from(dataBase64, "base64");
    const stored = await storage.put(USER_ID, filename, data);

    // --- video -------------------------------------------------------------
    // There is no video input to the model, so a clip is stored and measured
    // but NOT described. Saying so explicitly is the point: the agent must not
    // plan around footage nobody has looked at.
    if (videoMime) {
      const info = readVideoInfo(data);
      if (!info) {
        return res.status(400).json({
          error: "INVALID_INPUT",
          message:
            "Could not read the dimensions of that video. MP4 and MOV are supported; " +
            "WebM is not, because its header is a different container format.",
        });
      }

      const asset = media.add({
        userId: USER_ID,
        kind: "VIDEO",
        mimeType: videoMime,
        bytes: data.byteLength,
        width: info.width,
        height: info.height,
        durationSeconds: info.durationSeconds,
        storageRef: stored.storageRef,
        publicUrl: stored.publicUrl,
        description:
          `Video uploaded as "${filename}". Not yet described — Claude cannot watch video, ` +
          `so nothing is known about its content beyond its shape and length.`,
        tags: ["video", "undescribed"],
        describedFrom: "NOT_DESCRIBED",
      });

      return res.json({
        asset: media.summarise(USER_ID, asset.id),
        quality: "unknown",
        suitableFormats: suitableFormats(asset),
      });
    }

    // --- image -------------------------------------------------------------
    const profile = store.getBusinessProfile(USER_ID);
    const described = await describeImage(data, mimeType, {
      businessName: profile.businessName,
      industry: profile.industry,
    });
    const dims = imageSize(data) ?? { width: 1080, height: 1080 };

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

    res.json({
      asset: media.summarise(USER_ID, asset.id),
      quality: described.quality,
      suitableFormats: suitableFormats(asset),
    });
  } catch (e) {
    fail(res, e);
  }
});

/** Serves the stored bytes so the browser can show thumbnails. */
app.get("/api/media/:id/file", async (req, res) => {
  try {
    const asset = media.get(USER_ID, req.params.id);
    const bytes = await storage.read(asset.storageRef);
    res.setHeader("Content-Type", asset.mimeType);
    res.send(bytes);
  } catch {
    // Seeded assets have no file behind them — a 404 is the honest answer and
    // the UI falls back to showing the description.
    res.status(404).end();
  }
});

// -- accounts ----------------------------------------------------------------

app.get("/api/accounts", (_req, res) => {
  try {
    res.json({ accounts: store.getConnectedAccounts(USER_ID) });
  } catch (e) {
    fail(res, e);
  }
});

// -- helpers -----------------------------------------------------------------

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

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
