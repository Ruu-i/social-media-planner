import { useEffect, useRef, useState } from "react";
import { api, streamTurn, type MediaAsset, type StreamHandlers } from "../api";

/**
 * The conversation panel.
 *
 * Two deliberate choices here.
 *
 * Content is anchored to the BOTTOM. A chat that grows downward from the top
 * leaves a large dead area above the input whenever the history is short, which
 * was most of the empty space in the first version.
 *
 * A turn takes ~80 seconds and output runs at a fixed ~75 tokens/second, so the
 * wait cannot be shortened — only made legible. Tool calls appear as they
 * happen, reasoning streams, and a clock ticks through the long stretch where
 * the model is writing captions and emitting nothing visible.
 */

type Entry =
  | { kind: "user"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "thinking"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "error"; text: string }
  | { kind: "attachment"; asset: MediaAsset };

const PROMPTS = [
  "Plan next week using my photos",
  "Plan 3 posts for next week",
  "Push everything back a week",
];

export function Chat({
  sessionId,
  onChanged,
  prompt,
  onPromptSent,
  onNewChat,
}: {
  sessionId: string;
  onChanged: () => void;
  /** A message pushed in from elsewhere in the app — see App's agentPrompt. */
  prompt?: string | null;
  onPromptSent?: () => void;
  onNewChat?: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"thinking" | "writing" | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // Files attached to the NEXT message. They upload immediately on pick, so by
  // send time they are real assets the agent can already search.
  const [attached, setAttached] = useState<MediaAsset[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingVideo, setPendingVideo] = useState<{
    file: File;
    width: number;
    height: number;
    duration: number;
  } | null>(null);
  const [videoDescription, setVideoDescription] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, phase]);

  /**
   * Rehydrate the conversation for this session.
   *
   * Runs once per session id. The server strips the injected time context and
   * attached-media blocks, so what comes back is what the person actually
   * typed and what the agent actually said — not the model's working copy.
   *
   * Tool calls and thinking are deliberately not restored: they are live
   * progress indicators for a turn in flight, and replaying them as history
   * would be noise.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .messages(sessionId)
      .then(({ entries: prior }) => {
        if (cancelled) return;
        // Set unconditionally, INCLUDING an empty result. Skipping the empty
        // case left the previous conversation on screen after "New chat" — the
        // session had genuinely changed, so the next message went somewhere
        // else, but the transcript still showed the old one. It looked like the
        // button did nothing.
        setEntries(
          prior.map((e) =>
            e.role === "user"
              ? ({ kind: "user", text: e.text } as const)
              : ({ kind: "assistant", text: e.text } as const),
          ),
        );
        // Anything half-composed belonged to the old conversation.
        setAttached([]);
        setInput("");
      })
      .catch(() => {
        // A missing transcript is not an error worth showing — it just means
        // this is a new conversation.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /**
   * Send a prompt handed in from another panel.
   *
   * Cleared immediately via onPromptSent so the same message cannot fire twice
   * on a re-render. Skipped while a turn is in flight rather than queued: two
   * overlapping turns on one session would interleave in the conversation
   * store, and the user can simply press the button again.
   */
  useEffect(() => {
    if (!prompt || busy) return;
    send(prompt);
    onPromptSent?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt]);

  // A clock that keeps moving even when no events arrive — which is exactly
  // when a user would otherwise assume the thing has hung.
  useEffect(() => {
    if (!phase) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  /**
   * Read a video's shape and length in the browser.
   *
   * The server cannot do this without a media library, and does not need to —
   * the browser already decoded the file to show a preview. Aspect ratio is
   * what decides whether something can be a Reel at all, so getting it from the
   * source beats guessing 1080x1920 and being wrong.
   */
  function videoMeta(file: File): Promise<{ width: number; height: number; duration: number }> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = document.createElement("video");
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          width: el.videoWidth,
          height: el.videoHeight,
          duration: Math.round(el.duration || 0),
        });
      };
      // A codec the browser cannot decode should not block the upload — the
      // server falls back to a vertical default.
      el.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ width: 0, height: 0, duration: 0 });
      };
      el.src = url;
    });
  }

  async function attach(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);

    const isVideo = /\.(mp4|mov)$/i.test(file.name);
    if (isVideo) {
      // Hold it until the user says what is in it. The model cannot watch a
      // video, so a description is not optional metadata — it is the only
      // thing the agent will know about these bytes.
      const meta = await videoMeta(file);
      setPendingVideo({ file, ...meta });
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setUploading(file.name);
    try {
      const dataBase64 = await toBase64(file);
      const { asset } = await api.upload(file.name, dataBase64);
      setAttached((a) => [...a, asset]);
      // The library changed, so the calendar view should know about it.
      onChanged();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  /** Upload the held video once it has been described. */
  async function uploadVideo() {
    if (!pendingVideo || videoDescription.trim().length < 10) return;
    const { file, width, height, duration } = pendingVideo;

    setUploading(file.name);
    setUploadError(null);
    try {
      const signed = await api.uploadUrl(file.name);

      // Straight to S3. The bytes never touch this app, which is the only way
      // a 20 MB Reel gets uploaded at all.
      const put = await fetch(signed.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": signed.contentType },
        body: file,
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      const { asset } = await api.registerMedia({
        filename: file.name,
        storageRef: signed.storageRef,
        publicUrl: signed.publicUrl,
        description: videoDescription.trim(),
        width,
        height,
        durationSeconds: duration,
        bytes: file.size,
      });

      setAttached((a) => [...a, asset]);
      setPendingVideo(null);
      setVideoDescription("");
      onChanged();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  function send(text: string) {
    if ((!text.trim() && attached.length === 0) || busy) return;

    const sending = attached;
    setAttached([]);
    for (const asset of sending) {
      setEntries((e) => [...e, { kind: "attachment", asset }]);
    }
    setEntries((e) => [...e, { kind: "user", text }]);
    setInput("");
    setBusy(true);
    setPhase("thinking");

    const append = (entry: Entry) => setEntries((e) => [...e, entry]);

    // Ask the guard first. A refusal on the stream itself comes back as a 429,
    // which EventSource reports as an unexplained connection failure — so the
    // user saw "Connection to the server was lost" when nothing was lost and
    // the real answer was "you have used your turns for this hour".
    void api
      .turnAllowed()
      .then((decision) => {
        if (decision.allowed) return startStream();
        append({
          kind: "error",
          text:
            decision.reason ??
            `Spending limit reached ($${decision.spentUsd.toFixed(2)} of $${decision.budgetUsd.toFixed(2)}). Everything except the agent still works.`,
        });
        setBusy(false);
        setPhase(null);
      })
      .catch(() => startStream());

    function startStream() {

    const handlers: StreamHandlers = {
      onTool: (name) => {
        setPhase("thinking");
        append({ kind: "tool", name });
      },
      onThinking: (delta) => {
        setPhase("thinking");
        setEntries((e) => {
          const last = e[e.length - 1];
          if (last?.kind === "thinking") {
            return [...e.slice(0, -1), { kind: "thinking", text: last.text + delta }];
          }
          return [...e, { kind: "thinking", text: delta }];
        });
      },
      onWriting: () => setPhase("writing"),
      onText: (delta) => {
        setPhase(null);
        setEntries((e) => {
          const last = e[e.length - 1];
          if (last?.kind === "assistant") {
            return [...e.slice(0, -1), { kind: "assistant", text: last.text + delta }];
          }
          return [...e, { kind: "assistant", text: delta }];
        });
      },
      onDone: () => {
        setBusy(false);
        setPhase(null);
        onChanged();
      },
      onError: (message) => {
        setBusy(false);
        setPhase(null);
        append({ kind: "error", text: message });
      },
    };

    streamTurn(
      sessionId,
      text,
      handlers,
      sending.map((a) => a.assetId),
    );
    }
  }

  return (
    <div className="flex h-full flex-col bg-white/70">
      <header className="flex items-center gap-2 border-b border-stone-200 px-4 py-3">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        <h2 className="text-[13px] font-semibold text-stone-900">Agent</h2>
        <span className="ml-auto text-[11px] text-stone-400">
          drafts · revises · schedules
        </span>

        {/* Now that a session survives a reload, there has to be a way OUT of
            one — otherwise a user is stuck in a single conversation forever,
            carrying context they no longer want. */}
        {onNewChat && entries.length > 0 && (
          <button
            onClick={onNewChat}
            title="Start a new conversation. Your calendar and posts are not affected."
            className="rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 transition hover:border-violet-300 hover:text-violet-700"
          >
            New chat
          </button>
        )}
      </header>

      {/* justify-end on a SCROLL CONTAINER is a trap: once the content is taller
          than the box, the overflow goes out of the TOP where scrolling cannot
          reach it, so the start of a long conversation becomes unreadable.
          min-h-0 matters too — a flex child defaults to min-height:auto and
          refuses to shrink below its content, so the container never overflows
          and never scrolls.
          The dead-space fix moves to the inner column, which pushes a SHORT
          history down without stranding a long one. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex min-h-full flex-col justify-end gap-2.5">
        {entries.map((entry, i) => (
          <Bubble key={i} entry={entry} />
        ))}

        {phase && (
          <div className="flex items-center gap-2 text-[11px] text-stone-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            {phase === "writing" ? "writing content" : "thinking"}
            <span className="tabular-nums">{elapsed}s</span>
            {phase === "writing" && (
              <span className="text-stone-400">
                · a week of captions takes about 80s
              </span>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      </div>

      <div className="border-t border-stone-200 p-3">
        {/* Attached but not yet sent. Uploading on pick rather than on send
            means the vision pass is already done by the time the agent reads
            the message, so "schedule this reel" resolves immediately. */}
        {/* A video cannot be auto-described, so the upload pauses here.
            The agent gets exactly what the user writes — which beats a vision
            pass on one frame, because that frame says nothing about the other
            fourteen seconds. */}
        {pendingVideo && (
          <div className="mb-2 rounded-xl border border-violet-200 bg-violet-50/60 p-3">
            <p className="text-[12px] font-medium text-stone-800">
              What happens in {pendingVideo.file.name}?
            </p>
            <p className="mt-0.5 text-[11px] text-stone-600">
              {pendingVideo.width > 0
                ? `${pendingVideo.width}×${pendingVideo.height}`
                : "shape unknown"}
              {pendingVideo.duration > 0 ? ` · ${pendingVideo.duration}s` : ""} - the agent cannot
              watch it, so it only knows what you write here.
            </p>
            <textarea
              value={videoDescription}
              onChange={(e) => setVideoDescription(e.target.value)}
              rows={2}
              autoFocus
              placeholder="Pouring a cold brew over ice, close up, steam on the glass, no talking"
              className="mt-2 w-full resize-y rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-[12px] text-stone-800 outline-none placeholder:text-stone-400 focus:border-violet-400"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                disabled={videoDescription.trim().length < 10 || uploading !== null}
                onClick={() => void uploadVideo()}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
              >
                {uploading ? "Uploading…" : "Upload video"}
              </button>
              <button
                onClick={() => {
                  setPendingVideo(null);
                  setVideoDescription("");
                }}
                className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-stone-300"
              >
                Cancel
              </button>
              {videoDescription.trim().length > 0 && videoDescription.trim().length < 10 && (
                <span className="text-[10px] text-stone-500">a little more detail</span>
              )}
            </div>
          </div>
        )}

        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((a) => (
              <span
                key={a.assetId}
                className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 py-1 pr-1 pl-2 text-[11px]"
              >
                {/* The NAME first. "4:5 POST/CAROUSEL" is what the agent needs
                    to know; it tells the person nothing about which photo they
                    just picked, and reads like a format they are choosing
                    rather than a file they attached. */}
                <span className="text-violet-700">{a.kind === "VIDEO" ? "▶" : "▣"}</span>
                <span className="max-w-40 truncate font-medium text-stone-700">
                  {a.filename || a.assetId}
                </span>
                <span className="shrink-0 text-stone-500">
                  {a.aspectRatio}
                  {a.durationSeconds ? ` · ${a.durationSeconds}s` : ""}
                </span>
                <button
                  onClick={() => setAttached((list) => list.filter((x) => x.assetId !== a.assetId))}
                  className="rounded px-1 text-stone-400 transition hover:bg-violet-100 hover:text-stone-700"
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {uploading && (
          <p className="mb-2 flex items-center gap-2 text-[11px] text-stone-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
            Uploading {uploading}…
          </p>
        )}
        {uploadError && <p className="mb-2 text-[11px] text-rose-600">{uploadError}</p>}

        {entries.length === 0 && attached.length === 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => send(p)}
                className="rounded-full border border-stone-200 px-2.5 py-1 text-[11px] text-stone-600 transition hover:border-stone-400 hover:text-stone-900"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-end gap-2"
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => void attach(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy || uploading !== null}
            title="Attach a photo or video"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-lg leading-none text-stone-500 transition hover:border-violet-400 hover:text-violet-600 disabled:opacity-40"
          >
            +
          </button>
          {/* A textarea, not an input.
              A single-line input scrolls sideways as you type, so a request of
              any length becomes a keyhole showing only the last few words — you
              cannot read back what you asked before sending it. This grows to
              fit, then scrolls once it hits 160px. */}
          <textarea
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              // Reset before measuring: scrollHeight never reports less than
              // the element's current height, so without this the box can grow
              // but never shrink back when text is deleted.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline — the convention in every
              // chat app. A bare Enter inserting a newline would make the
              // common case require the mouse.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
                e.currentTarget.style.height = "auto";
              }
            }}
            disabled={busy}
            placeholder={busy ? "Working…" : "Ask the agent to plan something"}
            className="max-h-40 min-h-[38px] flex-1 resize-none rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] leading-relaxed text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || (!input.trim() && attached.length === 0)}
            className="rounded-lg bg-amber-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-500 disabled:opacity-30"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="animate-fade-up ml-8 self-end rounded-2xl rounded-br-md bg-amber-600 px-3 py-2 text-[13px] text-white">
          {entry.text}
        </div>
      );

    // Showing tool calls is not decoration — it is how you see whether the agent
    // read existing state before writing, which is the whole difference between
    // a planner and a generator.
    case "tool":
      return (
        <div className="flex items-center gap-2 font-mono text-[11px] text-stone-400">
          <span className="text-amber-500">→</span>
          {entry.name}
        </div>
      );

    case "thinking":
      return (
        <div className="border-l-2 border-stone-200 pl-3 text-[11px] leading-relaxed text-stone-500 italic">
          {entry.text}
        </div>
      );

    case "assistant":
      return (
        <div className="animate-fade-up text-[13px] leading-relaxed whitespace-pre-wrap text-stone-700">
          {entry.text}
        </div>
      );

    case "error":
      return (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
          {entry.text}
        </div>
      );

    case "attachment":
      return (
        <div className="animate-fade-up ml-8 flex items-center gap-2 self-end rounded-xl border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px]">
          <span className="text-violet-700">{entry.asset.kind === "VIDEO" ? "▶" : "▣"}</span>
          <span className="text-stone-600">
            {entry.asset.aspectRatio}
            {entry.asset.durationSeconds ? ` · ${entry.asset.durationSeconds}s` : ""}
          </span>
          <span className="text-stone-400">
            {entry.asset.filename || entry.asset.assetId}
          </span>
        </div>
      );
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // The result is a data URL; the server wants only the payload after the comma.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
