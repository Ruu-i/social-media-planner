import { useEffect, useMemo, useState } from "react";

import type { ContentItem, Variant } from "../api";

/**
 * What happened while you were not looking.
 *
 * Publishing is the one thing in this app that happens with nobody watching —
 * the sweep fires on a schedule and posts to a real account. Before this there
 * was no way to learn it had: the calendar quietly changed status, and only if
 * you reloaded.
 *
 * FAILED matters more than PUBLISHED here. A post that went out is pleasant to
 * know about; a post that did NOT go out is something you have to act on, and
 * silence is the worst way to deliver it.
 *
 * Derived from the calendar rather than a notifications table. The events are
 * already in the data — a separate store would be a second source of truth for
 * something the variant already records.
 */

const SEEN_KEY = "notificationsSeenAt";

interface Event {
  variant: Variant;
  topic: string;
  at: string;
}

function readSeen(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Notifications({ items }: { items: ContentItem[] }) {
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(readSeen);

  const events = useMemo<Event[]>(() => {
    const out: Event[] = [];
    for (const item of items) {
      for (const v of item.variants) {
        if (v.status !== "PUBLISHED" && v.status !== "FAILED") continue;
        // publishedAt is when it actually happened; scheduledFor is when it was
        // meant to. A failure has no publishedAt, so fall back.
        out.push({ variant: v, topic: item.topic, at: v.publishedAt ?? v.scheduledFor });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }, [items]);

  const unread = events.filter((e) => e.at > seenAt).length;

  // Mark read on OPEN, not on render: a badge that clears itself because the
  // page happened to refresh is a badge you learn to distrust.
  useEffect(() => {
    if (!open || events.length === 0) return;
    const newest = events[0]!.at;
    setSeenAt(newest);
    try {
      localStorage.setItem(SEEN_KEY, newest);
    } catch {
      /* ignore — the badge simply returns next load */
    }
  }, [open, events]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `${unread} new updates` : "Updates"}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-stone-500 transition hover:bg-stone-100 hover:text-stone-700"
      >
        <svg
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4.5 w-4.5"
        >
          <path d="M10 3a4 4 0 0 0-4 4c0 3-1.2 4.2-1.7 4.7a.6.6 0 0 0 .4 1h10.6a.6.6 0 0 0 .4-1C15.2 11.2 14 10 14 7a4 4 0 0 0-4-4Z" />
          <path d="M8.3 15a1.8 1.8 0 0 0 3.4 0" />
        </svg>

        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* A click-catcher rather than a document listener: it cannot leak if
              the component unmounts while open. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-stone-200 bg-white shadow-lg shadow-stone-900/5">
            <div className="border-b border-stone-100 px-4 py-2.5">
              <p className="text-[12px] font-semibold text-stone-900">Updates</p>
              <p className="text-[11px] text-stone-500">Posts that went out, and ones that did not.</p>
            </div>

            {events.length === 0 ? (
              <p className="px-4 py-6 text-center text-[11px] text-stone-500">
                Nothing has published yet. Scheduled posts appear here once they go out.
              </p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {events.map((e) => (
                  <li
                    key={e.variant.id}
                    className="flex gap-2.5 border-b border-stone-50 px-4 py-2.5 last:border-0"
                  >
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                        e.variant.status === "PUBLISHED" ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="text-[12px] text-stone-800">
                        {e.variant.status === "PUBLISHED" ? "Published to " : "Failed to post to "}
                        <span className="font-medium">{e.variant.platform}</span>
                      </p>
                      <p className="truncate text-[11px] text-stone-500">{e.topic}</p>

                      {e.variant.status === "FAILED" && e.variant.failureReason && (
                        <p className="mt-0.5 text-[11px] text-rose-600">
                          {e.variant.failureReason}
                        </p>
                      )}

                      {/* The link is the point of a success notification: it
                          lets you go and look at the thing that was posted. */}
                      {e.variant.permalink && (
                        <a
                          href={e.variant.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 inline-block text-[11px] font-medium text-violet-600 hover:text-violet-700"
                        >
                          View on {e.variant.platform} →
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
