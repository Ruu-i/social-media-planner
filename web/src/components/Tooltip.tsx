import { useId, type ReactNode } from "react";

/**
 * A styled tooltip.
 *
 * Replaces the browser's native `title`, which cannot be styled, waits about a
 * second before appearing, renders in the OS theme rather than the app's, and
 * never shows for keyboard users at all.
 *
 * Built on CSS state rather than React state deliberately: a `useState` version
 * re-renders the subtree on every hover, and needs its own handlers for focus,
 * blur, touch and unmount. `group-hover` and `group-focus-within` get the same
 * behaviour for free and cannot leak an open tooltip when the trigger unmounts
 * mid-hover.
 *
 * Accessibility is the reason for `aria-describedby` and `focus-within`: hover
 * is not available to anyone navigating by keyboard, so a hover-only tooltip
 * hides the explanation from the people most likely to need it.
 */
export function Tooltip({
  text,
  children,
  align = "right",
}: {
  text: string;
  children: ReactNode;
  /** Which edge to line up with. The header sits at the right, so default there. */
  align?: "left" | "right" | "center";
}) {
  const id = useId();

  const alignment =
    align === "right"
      ? "right-0"
      : align === "left"
        ? "left-0"
        : "left-1/2 -translate-x-1/2";

  const arrow =
    align === "right"
      ? "right-4"
      : align === "left"
        ? "left-4"
        : "left-1/2 -translate-x-1/2";

  return (
    <span className="group relative inline-flex">
      <span aria-describedby={id} className="inline-flex">
        {children}
      </span>

      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute top-full z-50 mt-2 w-60 origin-top rounded-xl border border-stone-200/80 bg-white px-3 py-2 text-left text-[11px] leading-relaxed text-stone-600 opacity-0 shadow-lg shadow-stone-900/5 transition-all duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100 ${alignment} translate-y-1 scale-[0.98] group-hover:translate-y-0 group-hover:scale-100 group-focus-within:translate-y-0 group-focus-within:scale-100`}
      >
        {/* A rotated square borrowing the panel's own border and background, so
            the arrow stays correct if either is themed later. */}
        <span
          className={`absolute -top-1 h-2 w-2 rotate-45 border-t border-l border-stone-200/80 bg-white ${arrow}`}
        />
        {text}
      </span>
    </span>
  );
}
