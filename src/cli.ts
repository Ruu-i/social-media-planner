import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";

import { ContentAgent, estimateCost, MODEL } from "./agent/agent.js";
import { createSeededStore, createMediaStore, USER_ID } from "./seed.js";
import { Publisher } from "./publisher.js";
import { MockMetaConnector, MockTokenProvider } from "./connectors/mock.js";
import { LocalMediaStorage } from "./media/storage.js";
import { describeImage, canDescribe } from "./media/describe.js";
import { suitableFormats } from "./media/types.js";
import { StoreError } from "./store/memory.js";
import type { MediaStore } from "./store/media.js";
import type { ContentItemWithVariants, PostVariant } from "./schemas.js";

/**
 * A REPL standing in for the React UI.
 *
 * Note the division of labour, because it is the point of the whole design:
 *
 *   Chat messages  -> go to the agent, which decides which tools to call.
 *   /approve       -> does NOT go to the agent. It calls the store directly,
 *                     the way an authenticated click in the UI would.
 *   /publish       -> does NOT go to the agent either. It stands in for a timer
 *                     firing. There is no publish tool.
 *
 * The agent cannot approve or publish. Not "is told not to" — has no path to.
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const STATUS_COLOR: Record<string, (s: string) => string> = {
  DRAFT: dim,
  PENDING_APPROVAL: yellow,
  APPROVED: green,
  SCHEDULED: green,
  PUBLISHED: green,
  CANCELLED: red,
  FAILED: red,
};

async function main() {
  // A placeholder is truthy, so checking existence alone lets the .env.example
  // value through and turns a setup mistake into a cryptic 401.
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key || key.includes("...")) {
    console.error(
      "\nANTHROPIC_API_KEY is " +
        (key ? "still the placeholder from .env.example." : "not set.") +
        "\nPut a real key in .env — get one at https://console.anthropic.com/settings/keys\n",
    );
    process.exit(1);
  }

  // Catch copy-paste damage before spending a round trip on a 401. A stray
  // trailing full stop picked up from surrounding prose is the classic one: the
  // key looks completely normal and fails with an opaque auth error.
  const stray = key.match(/[^A-Za-z0-9_-]/g);
  if (stray) {
    console.error(
      "\nANTHROPIC_API_KEY contains characters that are not valid in a key: " +
        [...new Set(stray)].map((c) => JSON.stringify(c)).join(", ") +
        "\nThis usually means a trailing full stop or a quote was copied with it." +
        "\nCheck it against the first and last characters shown at" +
        "\nhttps://console.anthropic.com/settings/keys\n",
    );
    process.exit(1);
  }

  const media = createMediaStore();
  const storage = new LocalMediaStorage();
  const store = createSeededStore(undefined, media);
  const agent = new ContentAgent(store, { userId: USER_ID }, { storage });

  // The publisher is constructed here, alongside the agent, and deliberately
  // NOT passed to it. Publishing is triggered by /publish standing in for a
  // timer firing — there is no tool the model could call to reach it.
  const publisher = new Publisher(
    store,
    new MockTokenProvider(),
    [new MockMetaConnector((line) => console.log(dim(line)))],
    (line) => console.log(dim(line)),
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let sessionCost = 0;

  console.log(`\n${bold("Social Media Planning Agent")}  ${dim(MODEL)}`);
  console.log(dim("Talk to it normally. Commands:"));
  console.log(dim("  /calendar         show the calendar"));
  console.log(dim("  /show <itemId>    one idea + every platform version"));
  console.log(dim("  /media            the uploaded photo and video library"));
  console.log(dim("  /upload <path>    add a real photo (runs the vision pass)"));
  console.log(dim("  /approve <varId>  approve as the human (the agent cannot)"));
  console.log(dim("  /publish          run the publisher (simulates the timer firing)"));
  console.log(dim("  /cost             session spend"));
  console.log(dim("  /exit"));
  console.log(dim('\nTry: "plan next week using my photos"\n'));

  while (true) {
    // Ctrl+D, or piped stdin running out, closes readline. That is a normal
    // exit, not an error worth a stack trace.
    let input: string;
    try {
      input = (await rl.question(bold("you > "))).trim();
    } catch {
      break;
    }
    if (!input) continue;

    if (input.startsWith("/")) {
      if (input === "/exit" || input === "/quit") break;

      if (input === "/publish") {
        const outcomes = await publisher.publishDue(USER_ID);
        if (outcomes.length === 0) {
          console.log(dim("\n  nothing is due yet\n"));
        } else {
          console.log();
          for (const o of outcomes) {
            const colour =
              o.status === "PUBLISHED" ? green : o.status === "RETRY" ? yellow : red;
            console.log(
              `  ${dim(o.variantId)}  ${o.platform.padEnd(10)} ${colour(o.status)}  ${dim(o.detail)}`,
            );
          }
          console.log();
        }
        continue;
      }

      if (input.startsWith("/upload ")) {
        await handleUpload(input.slice("/upload ".length).trim(), media, storage, store);
        continue;
      }

      handleCommand(input, store, media, sessionCost);
      continue;
    }

    try {
      // Live progress.
      //
      // Measured: a week-long plan spends ~80 seconds in ONE turn while the
      // model writes every caption as tool arguments. Output runs at a fixed
      // ~75 tokens/second, so that wait cannot be shortened — only made
      // legible. Hence a ticking clock rather than a spinner: it keeps moving
      // even when no stream events arrive, which is exactly when a user would
      // otherwise assume the thing has hung.
      const state = {
        phase: "thinking" as "thinking" | "writing" | "text",
        since: Date.now(),
      };
      const clearLine = () => process.stdout.write("\r" + " ".repeat(76) + "\r");

      const paint = () => {
        if (state.phase === "text") return;
        const label = state.phase === "writing" ? "writing content" : "thinking";
        clearLine();
        process.stdout.write(
          dim(`  ${label}... ${((Date.now() - state.since) / 1000).toFixed(0)}s`),
        );
      };

      paint();
      const ticker = setInterval(paint, 500);

      let result;
      try {
        result = await agent.send(input, {
          onToolCall: (toolName) => {
            clearLine();
            // Showing tool calls live is not decoration — it is how you debug an
            // agent. Most agent bugs are "it called the wrong tool" or "it never
            // checked existing state", and both are invisible without this.
            console.log(dim(`  → ${toolName}`));
            state.phase = "thinking";
            state.since = Date.now();
          },

          // Summarised reasoning is genuinely informative here — it says which
          // conflicts it spotted before writing anything — so it is shown
          // rather than hidden behind the clock.
          onThinking: (delta) => {
            if (state.phase !== "thinking") {
              state.phase = "thinking";
              state.since = Date.now();
            }
            clearLine();
            process.stdout.write(dim(delta));
          },

          onWriting: () => {
            if (state.phase === "writing") return;
            clearLine();
            console.log();
            state.phase = "writing";
            state.since = Date.now();
          },

          onText: (delta) => {
            if (state.phase !== "text") {
              clearLine();
              console.log();
              state.phase = "text";
            }
            process.stdout.write(delta);
          },
        });
      } finally {
        clearInterval(ticker);
        clearLine();
      }

      if (state.phase !== "text") console.log(`\n${result.text}`);
      console.log();

      sessionCost += estimateCost(result.usage);
      console.log(
        dim(
          `  ${result.toolCalls.length} tool calls · ` +
            `${result.usage.input} in / ${result.usage.output} out · ` +
            `cache read ${result.usage.cacheRead} · ` +
            `$${estimateCost(result.usage).toFixed(4)}\n`,
        ),
      );
    } catch (error) {
      console.log(red(`\n  ${explainError(error)}\n`));
    }
  }

  console.log(dim(`\nSession cost: $${sessionCost.toFixed(4)}\n`));
  rl.close();
}

/**
 * Upload one photo.
 *
 * The vision pass runs ONCE, here, while the user is already waiting for the
 * upload — not on every planning turn. That is the whole cost strategy: look
 * once, then search text forever after.
 */
async function handleUpload(
  filePath: string,
  media: MediaStore,
  storage: LocalMediaStorage,
  store: ReturnType<typeof createSeededStore>,
) {
  if (!filePath) return console.log(red("\n  usage: /upload <path to image>\n"));

  try {
    const data = await readFile(filePath);
    const mimeType = mimeFor(filePath);
    if (!canDescribe(mimeType)) {
      console.log(red(`\n  ${mimeType} cannot be described. Use jpg, png, gif or webp.\n`));
      return;
    }

    process.stdout.write(dim("  looking at the image..."));
    const profile = store.getBusinessProfile(USER_ID);
    const described = await describeImage(data, mimeType, {
      businessName: profile.businessName,
      industry: profile.industry,
    });
    const dims = imageSize(data) ?? { width: 1080, height: 1080 };
    const stored = await storage.put(USER_ID, filePath, data);

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

    process.stdout.write("\r" + " ".repeat(40) + "\r");
    console.log(
      green(`\n  ${asset.id}`) +
        `  ${asset.width}x${asset.height} ${asset.aspectRatio}  ${dim(described.quality)}`,
    );
    console.log(`  ${asset.description}`);
    console.log(dim(`  tags: ${asset.tags.join(", ")}`));
    console.log(
      dim(`  usable as: ${suitableFormats(asset).join(", ") || "nothing — wrong shape"}\n`),
    );
  } catch (error) {
    console.log(red(`\n  ${error instanceof Error ? error.message : String(error)}\n`));
  }
}

/**
 * Turn SDK errors into something actionable.
 *
 * Match on the SDK's typed exception classes, never on error message strings —
 * message text is not a stable API. Most specific first.
 */
function explainError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return (
      "Your API key was rejected (401).\n" +
      "  The key in .env is well-formed, so it has most likely been revoked,\n" +
      "  regenerated, or copied from a deleted workspace.\n" +
      "  Create a fresh one at https://console.anthropic.com/settings/keys\n" +
      "  Note: a Claude Pro/Max subscription is not API access — the API is\n" +
      "  billed separately and needs credit on the account."
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return (
      "The key is valid but not permitted to do this (403).\n" +
      "  Check the workspace and that the key has Messages API access."
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited (429). Wait a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the API. Check your network connection or proxy.";
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status ?? ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function handleCommand(
  input: string,
  store: ReturnType<typeof createSeededStore>,
  media: MediaStore,
  cost: number,
) {
  const [cmd, arg] = input.split(/\s+/);

  switch (cmd) {
    // The calendar is nested: ideas, each with one row per channel. Seeing the
    // shape here is the fastest way to notice the agent has wrongly split one
    // idea into two items.
    case "/posts":
    case "/calendar": {
      const items = store.getCalendar(USER_ID);
      if (items.length === 0) {
        console.log(dim("\n  nothing planned yet\n"));
        return;
      }
      console.log();
      for (const item of items) {
        console.log(`  ${bold(item.topic)}  ${dim(item.id)}`);
        console.log(dim(`  ${item.contentCategory} · ${item.pillar}`));
        if (item.variants.length === 0 && item.plannedFor) {
          console.log(
            dim(
              `    planned ${formatDay(item.plannedFor)} · ${item.plannedFormat} · copy not written`,
            ),
          );
        }
        for (const v of item.variants) {
          const colour = STATUS_COLOR[v.status] ?? ((s: string) => s);
          console.log(
            `    ${dim(v.id)}  ${formatDay(v.scheduledFor)}  ` +
              `${v.platform}/${v.media.format}  ${colour(v.status)}`,
          );
          console.log(`    ${" ".repeat(13)}${dim(v.hook.slice(0, 58))}`);
        }
        console.log();
      }
      return;
    }

    case "/media": {
      const assets = media.search(USER_ID, { limit: 50 });
      if (assets.length === 0) {
        console.log(dim("\n  library is empty — try /upload <path>\n"));
        return;
      }
      console.log();
      for (const a of assets) {
        const note = a.describedFrom === "VIDEO_FRAME" ? yellow(" frame only") : "";
        console.log(
          `  ${dim(a.assetId)}  ${a.kind.padEnd(5)} ${a.aspectRatio.padEnd(5)}` +
            `${a.durationSeconds ? ` ${String(a.durationSeconds).padStart(2)}s` : "    "}  ` +
            `${dim(a.suitableFormats.join("/") || "—")}${note}`,
        );
        console.log(`  ${" ".repeat(15)}${dim(a.description.slice(0, 74))}`);
      }
      console.log();
      return;
    }

    case "/show": {
      if (!arg) return console.log(red("\n  usage: /show <itemId>\n"));
      try {
        renderItem(store.getItem(USER_ID, arg), media);
      } catch (e) {
        console.log(red(`\n  ${(e as Error).message}\n`));
      }
      return;
    }

    case "/approve": {
      if (!arg) return console.log(red("\n  usage: /approve <variantId>\n"));
      try {
        // This is the human action. It bypasses the agent entirely — exactly as
        // a button click in the React UI will hit an authenticated endpoint
        // rather than going through the model.
        //
        // It approves ONE variant: the Instagram wording and the Facebook
        // wording are different text, so they are approved separately.
        const v = store.humanApprove(USER_ID, arg);
        console.log(
          green(`\n  ${v.id} (${v.platform}) approved — the agent can now schedule it\n`),
        );
      } catch (e) {
        console.log(red(`\n  ${e instanceof StoreError ? e.message : String(e)}\n`));
      }
      return;
    }

    case "/cost":
      console.log(dim(`\n  session: $${cost.toFixed(4)}\n`));
      return;

    default:
      console.log(dim(`\n  unknown command ${cmd}\n`));
  }
}

/** The idea first, then each channel's version of it. */
function renderItem(item: ContentItemWithVariants, media: MediaStore) {
  console.log(`\n  ${bold(item.topic)}  ${dim(item.id)}`);
  console.log(dim(`  ${item.contentCategory} · ${item.pillar}`));
  console.log(`\n  ${item.coreMessage}`);
  console.log(dim(`  Why: ${item.rationale}`));

  for (const v of item.variants) {
    const colour = STATUS_COLOR[v.status] ?? ((s: string) => s);
    console.log(`\n  ${"─".repeat(60)}`);
    console.log(
      `  ${bold(v.platform.toUpperCase())} ${v.media.format}  ${colour(v.status)}  ${dim(v.id)}`,
    );
    console.log(dim(`  ${formatDay(v.scheduledFor)}`));
    console.log();
    console.log(`  ${v.caption.split("\n").join("\n  ")}`);
    console.log();
    if (v.hashtags.length > 0) {
      console.log(dim(`  ${v.hashtags.map((h: string) => `#${h}`).join(" ")}`));
    }
    console.log(dim(`  CTA: ${v.callToAction}`));
    console.log(dim(`  ${mediaLine(v.media)}`));

    // Real assets beat a brief. Showing which were chosen is how you tell at a
    // glance whether the caption was written about something that exists.
    for (const id of v.assetIds) {
      try {
        const a = media.summarise(USER_ID, id);
        console.log(dim(`  asset ${id} (${a.aspectRatio}): ${a.description.slice(0, 58)}`));
      } catch {
        console.log(red(`  asset ${id} is missing`));
      }
    }
  }
  console.log();
}

/** Each format carries different production detail — show what it actually has. */
function mediaLine(m: PostVariant["media"]): string {
  switch (m.format) {
    case "POST":
      return `Image: ${m.imageConcept}`;
    case "CAROUSEL":
      return `Carousel (${m.cards.length} cards): ${m.cards[0]}`;
    case "REEL":
      return `Reel ${m.durationSeconds}s · cover: ${m.coverFrame} · audio: ${m.audio}`;
    case "STORY":
      return (
        `Story: ${m.visual} · ${m.interaction}` +
        (m.interactionPrompt ? ` — "${m.interactionPrompt}"` : "")
      );
  }
}

/** Minimal dimension reader, so an upload does not need an image library. */
function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: IHDR width and height sit at fixed offsets.
  if (buf.length > 24 && buf.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segment markers to the first start-of-frame header.
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

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

main().catch((error: unknown) => {
  console.error(red(`\n${error instanceof Error ? error.message : String(error)}\n`));
  process.exit(1);
});
