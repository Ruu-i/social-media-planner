import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { agentFor, spendGuard } from "../server/sessions.js";
import { ensureApiKey } from "../agent/provider.js";
import { clientIdOf, isStreamRoute, route, type RouteResult } from "./router.js";
import type { FunctionUrlEvent, ResponseStream } from "./runtime.js";

/**
 * The Lambda entry point.
 *
 * Invoked through a Function URL with `RESPONSE_STREAM` invoke mode, which is
 * the only serverless path that survives this app's 80-second agent turns.
 * API Gateway's integration timeout is 29 seconds and is not adjustable — a
 * buffered handler behind it would be killed mid-turn, every time.
 *
 * `awslambda.streamifyResponse` is a runtime global, not an import. Every
 * response goes through the stream, including the small JSON ones: a streaming
 * handler has no other way to reply.
 */

export const handler = awslambda.streamifyResponse(
  async (event: FunctionUrlEvent, responseStream: ResponseStream) => {
    // CORS is answered here rather than in a middleware, because there is no
    // middleware. In the deployed shape CloudFront serves the UI and the API
    // from one origin, so this only matters for local testing.
    if (event.requestContext.http.method === "OPTIONS") {
      return await writeJson(responseStream, { kind: "json", statusCode: 204, body: {} });
    }

    const sessionId = isStreamRoute(event);
    if (sessionId) {
      return streamTurn(event, responseStream, sessionId);
    }

    await writeResult(responseStream, await route(event));
  },
);

/**
 * The agent turn, as Server-Sent Events.
 *
 * The only route that costs money, and the only one that streams. Everything
 * the CLI prints — tool calls, reasoning, the phase, the reply — arrives here
 * as a named event.
 */
async function streamTurn(
  event: FunctionUrlEvent,
  raw: ResponseStream,
  sessionId: string,
): Promise<void> {
  const params = new URLSearchParams(event.rawQueryString ?? "");
  const message = (params.get("q") ?? "").trim();

  if (!message) {
    return await writeJson(raw, {
      kind: "json",
      statusCode: 400,
      body: { error: "INVALID_INPUT", message: "q is required" },
    });
  }

  // Check the budget BEFORE opening the stream. Once headers are written the
  // status code is committed, and a 429 would have to be faked inside a 200.
  const decision = await spendGuard.check(clientIdOf(event));
  if (!decision.allowed) {
    return await writeJson(raw, {
      kind: "json",
      statusCode: 429,
      body: {
        error: "BUDGET_EXHAUSTED",
        message: decision.reason,
        spentUsd: decision.spentUsd,
        budgetUsd: decision.budgetUsd,
      },
    });
  }

  // Resolve the key before opening the stream. Failing here can still return a
  // real status code; failing after the headers are written cannot.
  try {
    await ensureApiKey();
  } catch (error) {
    return await writeJson(raw, {
      kind: "json",
      statusCode: 500,
      body: {
        error: "CONFIG",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const stream = awslambda.HttpResponseStream.from(raw, {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      // Without this an intermediary may buffer the whole response and deliver
      // it at the end — indistinguishable from a hang.
      "X-Accel-Buffering": "no",
    },
  });

  // Lambda response streaming has an UNDOCUMENTED internal buffer, and there is
  // no flush API. Small frames — and an SSE event carrying one tool name is
  // ~60 bytes — sit in it rather than going out, so the browser would see
  // nothing for eighty seconds and then everything at once. That is exactly the
  // failure the live progress UI exists to prevent.
  //
  // Padding each frame past the threshold fixes it. SSE comment lines start
  // with ":" and EventSource ignores them, so this is invisible to the client.
  // At ~120 frames a turn the cost is ~120 KB — nothing against the seconds of
  // apparent hang it buys back.
  const padBytes = Number(process.env.SSE_PAD_BYTES ?? 1024);
  const padding = padBytes > 0 ? `:${" ".repeat(padBytes)}\n` : "";

  const send = (name: string, data: unknown) => {
    stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n${padding}`);
  };

  // The model emits nothing visible for long stretches while writing tool
  // arguments. A heartbeat stops an idle-connection timer firing mid-turn.
  const heartbeat = setInterval(() => stream.write(": keepalive\n\n"), 15_000);

  try {
    // An agent is cheap to build and holds no state — history comes from the
    // conversation store, which is what makes this work across cold starts.
    const agent = agentFor(sessionId);

    const result = await agent.send(message, {
      onToolCall: (name) => send("tool", { name }),
      onThinking: (delta) => send("thinking", { delta }),
      onWriting: () => send("writing", {}),
      onText: (delta) => send("text", { delta }),
    });

    // Recorded after the fact: the true cost is only known once the turn ends.
    await spendGuard.record(result.usage);

    send("done", {
      text: result.text,
      toolCalls: result.toolCalls.length,
      usage: result.usage,
    });
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    // Wait for the close to flush, for the same reason writeBody exists: an
    // unawaited end() can drop the final frames.
    await new Promise<void>((resolve) => {
      (stream as unknown as NodeJS.WritableStream).end(() => resolve());
    });
  }
}

/**
 * Send a complete response body.
 *
 * `write()` then `end()` LOSES THE BODY. The write is queued, end() closes the
 * stream before it reaches the transport, and the client gets HTTP 200 with
 * Content-Length: 0 and no error anywhere — the function logs a clean, fast,
 * successful invocation.
 *
 * `pipeline` is the documented pattern: it waits for the data to drain before
 * closing, and propagates errors rather than swallowing them.
 */
async function writeBody(
  raw: ResponseStream,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
): Promise<void> {
  const stream = awslambda.HttpResponseStream.from(raw, {
    statusCode,
    headers: { "Content-Type": contentType },
  });
  await pipeline(Readable.from([body]), stream as unknown as NodeJS.WritableStream);
}

function writeResult(raw: ResponseStream, result: RouteResult): Promise<void> {
  return result.kind === "binary"
    ? writeBody(raw, result.statusCode, result.contentType, result.body)
    : writeJson(raw, result);
}

function writeJson(raw: ResponseStream, result: RouteResult): Promise<void> {
  return writeBody(
    raw,
    result.statusCode,
    "application/json",
    JSON.stringify(result.kind === "json" ? result.body : {}),
  );
}
