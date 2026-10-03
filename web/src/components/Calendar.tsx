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
  onAskAgent,
}: {
  items: ContentItem[];
  assets: MediaAsset[];
  onChanged: () => void;
  onAskAgent: (text: string) => void;
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
  /**
   * Within a day, work that needs you comes before work that is finished.
   *
   * Strict chronology is the obvious ordering for a calendar and the wrong one
   * here: a post published at 1:25 is history, and a draft awaiting approval at
   * 3:00 is the only thing on the screen the user can act on. Burying the
   * second under the first means the newest plan appears below something that
   * already happened.
   *
   * Time still decides within each group, so the day reads chronologically
   * wherever the status is the same.
   */
  const attention = (item: ContentItem): number => {
    const statuses = item.variants.map((v) => v.status);
    if (statuses.some((s) => s === "PENDING_APPROVAL" || s === "DRAFT")) return 0;
    if (statuses.some((s) => s === "APPROVED")) return 1;
    if (statuses.some((s) => s === "FAILED")) return 2;
    if (statuses.some((s) => s === "SCHEDULED")) return 3;
    return 4; // published, cancelled — done with
  };

  const timeOf = (item: ContentItem): string =>
    item.variants[0]?.scheduledFor ?? item.plannedFor ?? "";

  for (const [, dayItems] of groups) {
    dayItems.sort((a, b) => attention(a) - attention(b) || timeOf(a).localeCompare(timeOf(b)));
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
                <ItemCard
                  key={item.id}
                  item={item}
                  assets={assets}
                  onChanged={onChanged}
                  onAskAgent={onAskAgent}
                />
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
  onAskAgent,
}: {
  item: ContentItem;
  assets: MediaAsset[];
  onChanged: () => void;
  onAskAgent: (text: string) => void;
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
          <VariantRow
            key={v.id}
            variant={v}
            assets={assets}
            topic={item.topic}
            onChanged={onChanged}
            onAskAgent={onAskAgent}
          />
        ))}
      </div>
    </article>
  );
}

function VariantRow({
  variant,
  assets,
  topic,
  onChanged,
  onAskAgent,
}: {
  variant: Variant;
  assets: MediaAsset[];
  topic: string;
  onChanged: () => void;
  onAskAgent: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftCaption, setDraftCaption] = useState(variant.caption);
  const [draftTags, setDraftTags] = useState(variant.hashtags.join(" "));
  const [revision, setRevision] = useState("");
  const [slot, setSlot] = useState("");
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

  /**
   * Approving something that cannot publish wastes the approval.
   *
   * The agent saved this Reel with no asset attached, the user approved it, the
   * agent then fixed its own omission — and attaching media is a content
   * change, so the approval was revoked and had to be given twice. The second
   * approval was not the bug. Letting the first one happen was: they approved a
   * post that would have failed at 3:00 PM with nothing to publish.
   *
   * The store already refuses to SCHEDULE media-less Instagram content. This is
   * the same rule, moved to where the user can see it before acting.
   */
  const missingMedia = variant.platform === "instagram" && variant.assetIds.length === 0;
  const canApprove =
    (variant.status === "PENDING_APPROVAL" || variant.status === "DRAFT") && !missingMedia;

  return (
    <div>
      {/* The whole row is the disclosure control, and it now LOOKS like one.
          It was already clickable, with nothing to say so: no chevron, no hover
          state, no cursor change. Everything behind it — the full caption, the
          media plan, Approve and Cancel — was reachable only by guessing. */}
      <div
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition hover:bg-stone-50/80"
      >
        {/* A thumbnail gives the row visual weight and answers the question that
            matters at a glance: is this written about a photo that exists? */}
        {used[0] ? (
          <Thumb asset={used[0]} size={38} />
        ) : (
          <div className="h-[38px] w-[38px] shrink-0 rounded-lg border border-dashed border-stone-200" />
        )}

        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
          <span className="flex items-center gap-2">
            <PlatformBadge platform={variant.platform} />
            <FormatTag format={variant.media.format} />
            <span className="text-[11px] tabular-nums text-stone-400">
              {formatTime(variant.scheduledFor)}
            </span>

            {/* Which photo, by name. The thumbnail shows WHAT it looks like;
                the name is how the user refers to it and what they recognise
                when several shots look alike. An empty space here now also
                means something specific: no media attached. */}
            {/* Three states, not two.
                "no media" is only true when assetIds is EMPTY. A populated
                assetIds that cannot be resolved means the library has not
                loaded yet — claiming the post has no photo then is a lie that
                sent the user looking for a bug that was not there. */}
            {used[0] ? (
              <span className="max-w-32 truncate text-[11px] text-stone-500">
                {used[0].kind === "VIDEO" ? "▶ " : ""}
                {used[0].filename || used[0].assetId}
              </span>
            ) : variant.assetIds.length === 0 ? (
              <span className="text-[11px] font-medium text-amber-700">
                {variant.media.format === "REEL" || variant.media.format === "STORY"
                  ? "no video"
                  : "no photo"}
              </span>
            ) : null}
          </span>
          <span className="line-clamp-1 text-[13px] text-stone-700">
            {variant.hook}
          </span>
        </div>

        <StatusPill status={variant.status} />

        {/* The human gate. This button hits an authenticated endpoint directly —
            no tool the agent has can reach it. */}
        {canApprove && (
          <button
            onClick={(e) => {
              // Stop the row's toggle firing too — approving should not also
              // collapse what you were reading.
              e.stopPropagation();
              void act(() => api.approve(variant.id));
            }}
            disabled={working}
            className="shrink-0 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            Approve
          </button>
        )}

        {/* The affordance. Without it the row is a wall of text that happens to
            react to clicks — a chevron is the one convention everyone already
            reads as "there is more underneath". */}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-violet-600 transition hover:bg-violet-50 hover:text-violet-700"
        >
          {/* Violet, not grey. The chevron is the only thing telling a user
              there is anything behind the row, so it has to read as
              interactive — and violet is already the app's action colour
              (Connect, Ask the agent), so it says "clickable" without
              introducing a new convention. The label is gone: the chevron is
              universally understood, and the text was competing with the
              status pill beside it. */}
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          >
            <path d="M5 7.5 10 12.5 15 7.5" />
          </svg>
        </button>
      </div>

      {error && <p className="px-3.5 pb-2 text-[11px] text-rose-600">{error}</p>}

      {open && (
        <div className="animate-fade-up space-y-3 border-t border-stone-100 bg-amber-50/30 px-3.5 py-3">
          {/* What actually lands on the platform, boxed and labelled.
              Caption, hashtags and the photo are published. CTA and the media
              plan are NOT — the connector sends caption + hashtags only. They
              were rendered in the same list, so a reader could not tell which
              lines were post content and which were the agent's notes, and the
              CTA read like a stray second post. */}
          <div className="rounded-lg border border-stone-200 bg-white p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <p className="text-[10px] font-semibold tracking-wide text-stone-400 uppercase">
                Posts to {variant.platform} as
              </p>
              {!editing && variant.status !== "PUBLISHED" && (
                <button
                  onClick={() => {
                    setDraftCaption(variant.caption);
                    setDraftTags(variant.hashtags.join(" "));
                    setEditing(true);
                  }}
                  className="ml-auto text-[11px] font-medium text-violet-600 transition hover:text-violet-700"
                >
                  Edit
                </button>
              )}
            </div>

            {editing ? (
              <div className="space-y-2">
                <textarea
                  value={draftCaption}
                  onChange={(e) => setDraftCaption(e.target.value)}
                  rows={6}
                  className="w-full resize-y rounded-lg border border-stone-300 bg-white px-2.5 py-2 text-[13px] leading-relaxed text-stone-800 outline-none focus:border-violet-400"
                />
                <input
                  value={draftTags}
                  onChange={(e) => setDraftTags(e.target.value)}
                  placeholder="hashtags, space separated"
                  className="w-full rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-[11px] text-sky-700 outline-none focus:border-violet-400"
                />
                <p className="text-[11px] text-amber-700">
                  Editing the words withdraws your approval — you will need to approve it again.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={working}
                    onClick={async () => {
                      await act(() =>
                        api.updateVariant(variant.id, {
                          caption: draftCaption,
                          hashtags: draftTags.split(/[\s,]+/).filter(Boolean),
                        }),
                      );
                      setEditing(false);
                    }}
                    className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
                  >
                    Save changes
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-stone-300"
                  >
                    Discard
                  </button>
                </div>

                {/* The second mechanism, offered WITHIN the task rather than
                    before it.
                    Presenting "edit yourself or ask the AI?" as a choice up
                    front demands a decision the user cannot make informed —
                    they usually do not know whether it is a two-word fix or a
                    rewrite until they are looking at the words. So the cheap,
                    instant, exact option is the one their hands are already on,
                    and the model is right here when typing is not what they
                    want. */}
                <div className="border-t border-stone-200 pt-2.5">
                  <label className="text-[11px] text-stone-500">
                    Or describe the change and let the agent write it
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      value={revision}
                      onChange={(e) => setRevision(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && revision.trim()) {
                          e.preventDefault();
                          onAskAgent(
                            `Revise the ${variant.platform} post for "${topic}": ${revision.trim()}`,
                          );
                          setRevision("");
                          setEditing(false);
                        }
                      }}
                      placeholder="make it shorter, less salesy, mention the weekend…"
                      className="flex-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-[11px] text-stone-800 outline-none placeholder:text-stone-400 focus:border-violet-400"
                    />
                    <button
                      disabled={!revision.trim()}
                      onClick={() => {
                        onAskAgent(
                          `Revise the ${variant.platform} post for "${topic}": ${revision.trim()}`,
                        );
                        setRevision("");
                        setEditing(false);
                      }}
                      className="shrink-0 rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-[11px] font-medium text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-400"
                    >
                      Ask agent
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-stone-400">
                    Takes about a minute and uses your API credit. Typing it yourself is free.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-stone-800">
                  {variant.caption}
                </p>
                {variant.hashtags.length > 0 && (
                  <p className="mt-2 text-[11px] text-sky-600">
                    {variant.hashtags.map((h) => `#${h}`).join(" ")}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="grid gap-1 text-[11px] text-stone-500">
            <p className="text-[10px] font-semibold tracking-wide text-stone-400 uppercase">
              Planning notes — not published
            </p>
            <p>
              <span className="font-medium text-stone-600">Goal </span>
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

          {/* Where this post is in its life, in words.
              The status pill alone was misleading: an already-approved post
              shows no Approve button, which reads as a missing feature rather
              than a completed step. Saying so removes the question. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-stone-200/70 pt-3">
            <span className="text-[11px] text-stone-500">{lifecycleOf(variant)}</span>

            {missingMedia &&
              (variant.status === "PENDING_APPROVAL" || variant.status === "DRAFT") && (
                <span className="text-[11px] font-medium text-amber-700">
                  Attach a {variant.media.format === "REEL" ? "video" : "photo"} before approving —
                  Instagram cannot publish text on its own.
                </span>
              )}

            {canApprove && (
              <button
                onClick={async () => {
                  await act(() => api.approve(variant.id));
                  // Hand the user straight to the next step. Approval is a
                  // dead end otherwise: the status changes, nothing else
                  // happens, and the post quietly never goes out.
                  onAskAgent(
                    `I approved the ${variant.platform} post for "${topic}". ` +
                      `Please schedule it.`,
                  );
                }}
                disabled={working}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                Approve this version
              </button>
            )}

            {/* Schedule it YOURSELF.
                This was agent-only, which made committing a post to a time
                depend on the model choosing schedule_variant over
                update_variant. It chose wrong, set the time, left the status
                APPROVED and said "Scheduled" — so the post would never have
                gone out and nothing anywhere said so.
                Approve and publish already bypass the model for exactly this
                reason. This was the one decision left behind. */}
            {variant.status === "APPROVED" && (
              <>
                <input
                  type="datetime-local"
                  value={slotFor(variant.scheduledFor)}
                  onChange={(e) => setSlot(e.target.value)}
                  className="rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-[11px] text-stone-800 outline-none focus:border-violet-400"
                />
                <button
                  disabled={working}
                  onClick={() =>
                    act(() => api.schedule(variant.id, withOffset(slot || slotFor(variant.scheduledFor))))
                  }
                  className="rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-violet-500 disabled:opacity-40"
                >
                  Schedule it
                </button>
              </>
            )}

            {variant.status !== "PUBLISHED" && variant.status !== "CANCELLED" && (
              <div className="ml-auto flex items-center gap-2">
                {/* Two steps, not a browser confirm().
                    A scheduled post is a commitment the user made deliberately,
                    and one stray click should not undo it — but window.confirm
                    is an OS dialog that cannot say WHICH post, and people
                    dismiss it reflexively. An inline confirm names the stake
                    and stays in the row it belongs to. */}
                {confirming ? (
                  <>
                    <span className="text-[11px] text-stone-600">
                      Stop this from posting?
                    </span>
                    <button
                      onClick={async () => {
                        setConfirming(false);
                        await act(() => api.cancel(variant.id));
                      }}
                      disabled={working}
                      className="rounded-lg bg-rose-600 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-rose-500 disabled:opacity-40"
                    >
                      Yes, cancel it
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-stone-300"
                    >
                      Keep it
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirming(true)}
                    disabled={working}
                    className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[11px] font-medium text-stone-600 transition hover:border-rose-200 hover:text-rose-600 disabled:opacity-40"
                  >
                    Cancel this post
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One sentence saying what has happened and what happens next.
 *
 * The approval gate is the most important behaviour in this product and it was
 * invisible: a SCHEDULED post is PAST approval, so it correctly shows no
 * Approve button — and a user reasonably reads that absence as "there is no way
 * to approve things".
 */
function lifecycleOf(v: Variant): string {
  switch (v.status) {
    case "DRAFT":
    case "PENDING_APPROVAL":
      return "Waiting for you. Nothing is scheduled until you approve it.";
    case "APPROVED":
      // Explicit that this is NOT done. Approval unlocks scheduling; it does
      // not schedule. Without saying so, an approved post looks finished and
      // silently never goes out.
      return "You approved this. It will NOT post until it is scheduled.";
    case "SCHEDULED":
      return `Approved and scheduled. It posts automatically at ${formatTime(v.scheduledFor)}.`;
    case "PUBLISHED":
      return "Published.";
    case "FAILED":
      return "Publishing failed. Nothing was posted.";
    case "CANCELLED":
      // Cancelled, not deleted. The row stays so the calendar remains a record
      // of what was planned and what was called off — which matters when the
      // agent reads the calendar back and would otherwise re-suggest the very
      // thing the user just rejected.
      return "Cancelled. It will not be posted, and stays here as a record.";
  }
}

/** An ISO instant as the local "YYYY-MM-DDTHH:mm" a datetime-local input wants. */
function slotFor(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Put the browser's offset back on.
 *
 * A datetime-local value has NO timezone — it is wall-clock text. The store
 * refuses offset-less datetimes precisely so a time can never be stored meaning
 * whatever the server's clock happened to be, so the offset has to be attached
 * here, where the user's intent actually lives.
 */
function withOffset(local: string): string {
  const d = new Date(local);
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${local}:00${sign}${pad(mins / 60)}:${pad(mins % 60)}`;
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
