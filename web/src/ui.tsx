import { useState } from "react";
import type { Status, Platform, MediaAsset } from "./api";

/**
 * Shared visual vocabulary.
 *
 * One warm light theme. Greys are `stone` throughout — it carries a little red,
 * so surfaces read as paper rather than screen-white, which suits a tool full of
 * coffee photography. Amber is the brand accent; emerald stays reserved for
 * approval, because there it means "go" rather than "on brand".
 */

export const STATUS_STYLE: Record<Status, string> = {
  DRAFT: "bg-stone-100 text-stone-600 ring-stone-200",
  PENDING_APPROVAL: "bg-amber-50 text-amber-800 ring-amber-200",
  APPROVED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  SCHEDULED: "bg-sky-50 text-sky-800 ring-sky-200",
  PUBLISHED: "bg-emerald-600 text-white ring-emerald-600",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-200",
  CANCELLED: "bg-stone-100 text-stone-400 line-through ring-stone-200",
};

export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ring-1 ring-inset ${STATUS_STYLE[status]}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

/** A platform mark. Colour carries the identity so the label can stay small. */
export function PlatformBadge({ platform }: { platform: Platform }) {
  const instagram = platform === "instagram";
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-5 w-5 shrink-0 rounded-md shadow-sm ${
          instagram
            ? "bg-gradient-to-br from-fuchsia-500 via-rose-500 to-amber-400"
            : "bg-gradient-to-br from-blue-500 to-blue-700"
        }`}
      />
      <span className="text-[11px] font-medium text-stone-600">
        {instagram ? "Instagram" : "Facebook"}
      </span>
    </span>
  );
}

export function FormatTag({ format }: { format: string }) {
  return (
    <span className="rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-500">
      {format}
    </span>
  );
}

/**
 * Asset thumbnail.
 *
 * Seeded assets have no file behind them, so the image 404s — falling back to a
 * shape label keeps the layout intact instead of showing a broken icon, and
 * still says something useful about whether the asset is usable at all.
 */
export function Thumb({
  asset,
  size = 40,
  className = "",
}: {
  asset: MediaAsset;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const unusable = asset.suitableFormats.length === 0;

  if (failed || asset.kind === "VIDEO") {
    return (
      <div
        style={size ? { width: size, height: size } : undefined}
        className={`flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg text-[9px] font-medium ring-1 ring-inset ${
          unusable
            ? "bg-rose-50 text-rose-500 ring-rose-200"
            : "bg-gradient-to-br from-stone-100 to-stone-200 text-stone-500 ring-stone-200"
        } ${className}`}
      >
        {asset.kind === "VIDEO" ? (
          <>
            <span className="text-[11px] text-stone-400">▶</span>
            <span>{asset.durationSeconds}s</span>
          </>
        ) : (
          asset.aspectRatio
        )}
      </div>
    );
  }

  return (
    <img
      src={`/api/media/${asset.assetId}/file`}
      alt={asset.description}
      onError={() => setFailed(true)}
      style={size ? { width: size, height: size } : undefined}
      className={`shrink-0 rounded-lg object-cover ring-1 ring-stone-200 ${className}`}
    />
  );
}

/**
 * The animated field behind the content area.
 *
 * Purely decorative, so it is inert to the pointer and invisible to screen
 * readers. It sits OUTSIDE the scroll container on purpose: a backdrop that
 * scrolls away with the content would draw attention to itself, and the point
 * is for it to stay still and drift.
 */
export function AnimatedBackdrop() {
  return (
    <div className="backdrop-field" aria-hidden="true">
      <div className="backdrop-grid" />
      <div className="backdrop-blob backdrop-blob-a" />
      <div className="backdrop-blob backdrop-blob-b" />
      <div className="backdrop-blob backdrop-blob-c" />
    </div>
  );
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

/** Group key: the calendar day an item lands on, for the day rails. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

export function relativeDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${Math.abs(days)}d ago`;
  if (days < 7) return `in ${days}d`;
  return null;
}
