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

export function Chat({ sessionId, onChanged }: { sessionId: string; onChanged: () => void }) {
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
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, phase]);

  // A clock that keeps moving even when no events arrive — which is exactly
  // when a user would otherwise assume the thing has hung.
  useEffect(() => {
    if (!phase) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  async function attach(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);
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

  return (
    <div className="flex h-full flex-col bg-white/70">
      <header className="flex items-center gap-2 border-b border-stone-200 px-4 py-3">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        <h2 className="text-[13px] font-semibold text-stone-900">Agent</h2>
        <span className="ml-auto text-[11px] text-stone-400">
          drafts · revises · schedules
        </span>
      </header>

      {/* justify-end is what kills the dead space: a short history sits just
          above the composer instead of stranded at the top. */}
      <div className="flex flex-1 flex-col justify-end gap-2.5 overflow-y-auto px-4 py-4">
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

      <div className="border-t border-stone-200 p-3">
        {/* Attached but not yet sent. Uploading on pick rather than on send
            means the vision pass is already done by the time the agent reads
            the message, so "schedule this reel" resolves immediately. */}
        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((a) => (
              <span
                key={a.assetId}
                className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 py-1 pr-1 pl-2 text-[11px]"
              >
                <span className="text-violet-700">
                  {a.kind === "VIDEO" ? "▶" : "▣"} {a.aspectRatio}
                  {a.durationSeconds ? ` · ${a.durationSeconds}s` : ""}
                </span>
                <span className="max-w-32 truncate text-stone-500">
                  {a.suitableFormats.join("/") || "unusable shape"}
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
          className="flex items-center gap-2"
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
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder={busy ? "Working…" : "Ask the agent to plan something"}
            className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-amber-500 disabled:opacity-50"
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
            {entry.asset.suitableFormats.join("/") || "unusable shape"}
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
