import { useState } from "react";
import { api, type ContentItem, type Format, type MediaAsset, type Variant } from "../api";
import {
  FormatTag,
  PlatformBadge,
  StatusPill,
  Thumb,
  dayKey,
  formatDayLabel,
  formatTime,
  relativeDay,
} from "../ui";

/**
 * The calendar.
 *
 * Grouped by day, because that is how a content calendar is actually read — a
 * flat list gives no sense of rhythm, which is half of what a week's planning is
 * about. Within a day, ideas keep their variants nested: one idea going to two
 * channels is ONE card with TWO rows, which is the data model made visible.
 */
export function Calendar({
  items,
  assets,
  onChanged,
}: {
  items: ContentItem[];
  assets: MediaAsset[];
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<Format | "ALL">("ALL");

  // Counts come from ALL items, not the filtered set, so a format showing zero
  // still appears — "where are my Stories?" is answered by seeing STORY 0
  // rather than by the tab quietly not existing.
  const counts = { POST: 0, CAROUSEL: 0, REEL: 0, STORY: 0 } as Record<Format, number>;
  for (const item of items) {
    for (const v of item.variants) counts[v.media.format]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-12 text-center">
        <div className="mb-1 h-10 w-10 rounded-xl border border-dashed border-violet-300" />
        <p className="text-sm font-medium text-stone-700">Nothing planned yet</p>
        <p className="max-w-xs text-xs text-stone-500">
          Ask the agent to plan a week. It will read what is already scheduled before it writes
          anything.
        </p>
      </div>
    );
  }

  // Group by the day the content lands on; unwritten slots use their planned date.
  const visible =
    filter === "ALL"
      ? items
      : items
          .map((i) => ({ ...i, variants: i.variants.filter((v) => v.media.format === filter) }))
          .filter((i) => i.variants.length > 0);

  const groups = new Map<string, ContentItem[]>();
  for (const item of visible) {
    const when = item.variants[0]?.scheduledFor ?? item.plannedFor;
    if (!when) continue;
    const key = dayKey(when);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const days = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6 px-5 py-5">
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip label="All" count={total} active={filter === "ALL"} onClick={() => setFilter("ALL")} />
        {(["POST", "CAROUSEL", "REEL", "STORY"] as const).map((f) => (
          <FilterChip
            key={f}
            label={f === "POST" ? "Posts" : f === "CAROUSEL" ? "Carousels" : f === "REEL" ? "Reels" : "Stories"}
            count={counts[f]}
            active={filter === f}
            onClick={() => setFilter(f)}
          />
        ))}
        {filter === "STORY" && counts.STORY === 0 && (
          <span className="ml-2 text-[11px] text-stone-500">
            Stories expire 24h after posting, so they are planned close to the day rather than a
            fortnight out. Ask the agent for one.
          </span>
        )}
      </div>

      {days.length === 0 && (
        <p className="py-8 text-center text-[13px] text-stone-500">
          Nothing planned in this format yet.
        </p>
      )}

      {days.map(([day, dayItems]) => {
        const anchor = dayItems[0]!.variants[0]?.scheduledFor ?? dayItems[0]!.plannedFor!;
        const rel = relativeDay(anchor);
        return (
          <section key={day}>
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold text-stone-800">
                {formatDayLabel(anchor)}
              </h3>
              {rel && (
                <span className="rounded-full bg-violet-100/80 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                  {rel}
                </span>
              )}
              <span className="h-px flex-1 bg-violet-200/70" />
              <span className="text-[11px] text-violet-500/80">
                {dayItems.reduce((n, i) => n + Math.max(i.variants.length, 1), 0)} posts
              </span>
            </div>

            <div className="space-y-2">
              {dayItems.map((item) => (
                <ItemCard key={item.id} item={item} assets={assets} onChanged={onChanged} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
        active
          ? "border-violet-300 bg-violet-100 text-violet-800"
          : "border-white/80 bg-white/70 text-stone-600 hover:border-violet-200 hover:text-stone-900"
      }`}
    >
      {label}
      <span className={count === 0 ? "text-stone-300" : active ? "text-violet-600" : "text-stone-400"}>
        {count}
      </span>
    </button>
  );
}

function ItemCard({
  item,
  assets,
  onChanged,
}: {
  item: ContentItem;
  assets: MediaAsset[];
  onChanged: () => void;
}) {
  const unwritten = item.variants.length === 0 && item.plannedFor;

  return (
    <article className="overflow-hidden rounded-xl card card-hover border border-white/80 bg-white/95 backdrop-blur-sm transition hover:border-violet-200">
      <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <h4 className="truncate text-[13px] font-semibold text-stone-900">
          {item.topic}
        </h4>
        {item.campaignId && (
          <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
            campaign
          </span>
        )}
        <span className="ml-auto shrink-0 truncate text-[11px] text-stone-400">
          {item.contentCategory}
        </span>
      </header>

      {/* A slot with no variants was agreed in phase one and has no copy yet.
          It must stay visible or phase two plans the same slot twice. */}
      {unwritten && (
        <div className="mx-3.5 mb-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {item.plannedFormat} planned · copy not written yet
        </div>
      )}

      <div className="divide-y divide-stone-100 border-t border-stone-100">
        {item.variants.map((v) => (
          <VariantRow key={v.id} variant={v} assets={assets} onChanged={onChanged} />
        ))}
      </div>
    </article>
  );
}

function VariantRow({
  variant,
  assets,
  onChanged,
}: {
  variant: Variant;
  assets: MediaAsset[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const used = variant.assetIds
    .map((id) => assets.find((a) => a.assetId === id))
    .filter((a): a is MediaAsset => Boolean(a));

  async function act(fn: () => Promise<unknown>) {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  const canApprove = variant.status === "PENDING_APPROVAL" || variant.status === "DRAFT";

  return (
    <div>
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        {/* A thumbnail gives the row visual weight and answers the question that
            matters at a glance: is this written about a photo that exists? */}
        {used[0] ? (
          <Thumb asset={used[0]} size={38} />
        ) : (
          <div className="h-[38px] w-[38px] shrink-0 rounded-lg border border-dashed border-stone-200" />
        )}

        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
        >
          <span className="flex items-center gap-2">
            <PlatformBadge platform={variant.platform} />
            <FormatTag format={variant.media.format} />
            <span className="text-[11px] tabular-nums text-stone-400">
              {formatTime(variant.scheduledFor)}
            </span>
          </span>
          <span className="line-clamp-1 text-[13px] text-stone-700">
            {variant.hook}
          </span>
        </button>

        <StatusPill status={variant.status} />

        {/* The human gate. This button hits an authenticated endpoint directly —
            no tool the agent has can reach it. */}
        {canApprove && (
          <button
            onClick={() => act(() => api.approve(variant.id))}
            disabled={working}
            className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            Approve
          </button>
        )}
      </div>

      {error && <p className="px-3.5 pb-2 text-[11px] text-rose-600">{error}</p>}

      {open && (
        <div className="animate-fade-up space-y-3 border-t border-stone-100 bg-amber-50/30 px-3.5 py-3">
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-stone-700">
            {variant.caption}
          </p>

          {variant.hashtags.length > 0 && (
            <p className="text-[11px] text-sky-600">
              {variant.hashtags.map((h) => `#${h}`).join(" ")}
            </p>
          )}

          <div className="grid gap-1 text-[11px] text-stone-500">
            <p>
              <span className="font-medium text-stone-600">CTA </span>
              {variant.callToAction}
            </p>
            <p>
              <span className="font-medium text-stone-600">Media </span>
              {mediaLine(variant)}
            </p>
          </div>

          {used.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {used.map((a) => (
                <div
                  key={a.assetId}
                  className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white p-1.5"
                >
                  <Thumb asset={a} size={32} />
                  <p className="max-w-52 truncate text-[11px] text-stone-500">{a.description}</p>
                </div>
              ))}
            </div>
          )}

          {variant.permalink && (
            <a
              href={variant.permalink}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-[11px] text-sky-600 underline"
            >
              View published post
            </a>
          )}
          {variant.failureReason && (
            <p className="text-[11px] text-rose-600">{variant.failureReason}</p>
          )}

          {variant.status !== "PUBLISHED" && variant.status !== "CANCELLED" && (
            <button
              onClick={() => act(() => api.cancel(variant.id))}
              disabled={working}
              className="text-[11px] text-stone-400 underline transition hover:text-rose-600"
            >
              Cancel this version
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function mediaLine(v: Variant): string {
  const m = v.media;
  switch (m.format) {
    case "POST":
      return m.imageConcept ?? "";
    case "CAROUSEL":
      return `${m.cards?.length ?? 0} cards — ${m.cards?.[0] ?? ""}`;
    case "REEL":
      return `${m.durationSeconds}s · cover: ${m.coverFrame}`;
    case "STORY":
      return `${m.visual} · ${m.interaction}`;
  }
}
