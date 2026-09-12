import { useEffect, useRef, useState } from "react";
import { streamTurn, type StreamHandlers } from "../api";

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
  | { kind: "error"; text: string };

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
  const bottom = useRef<HTMLDivElement>(null);

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

  function send(text: string) {
    if (!text.trim() || busy) return;
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

    streamTurn(sessionId, text, handlers);
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
        {entries.length === 0 && (
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
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder={busy ? "Working…" : "Ask the agent to plan something"}
            className="flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-amber-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
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
  }
}
