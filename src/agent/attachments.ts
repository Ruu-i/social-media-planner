import type { MediaStore } from "../store/media.js";

/**
 * Turn attached asset ids into a block the model can act on.
 *
 * Extracted from the Express server because the Lambda did not have it, and the
 * failure was invisible: the browser sent `?assets=...`, the Lambda read only
 * `q`, and the agent received a message saying "use this photo" with no photo.
 * It then did the right thing — asked which one — so nothing errored and
 * nothing logged. Attachments simply never worked in production while working
 * perfectly in development.
 *
 * Two copies of this logic would drift the same way `ContentStore`'s rules
 * would, which is why those live in `store/rules.ts`. Same reasoning here.
 */
export function buildAttachedPrompt(
  media: MediaStore,
  userId: string,
  message: string,
  assetIds: string[],
): string {
  if (assetIds.length === 0) return message;

  const lines: string[] = [];
  for (const id of assetIds) {
    const a = media.summarise(userId, id);
    if (!a) continue;

    lines.push(
      `- ${a.assetId} (${a.kind}, ${a.aspectRatio}` +
        `${a.durationSeconds ? `, ${a.durationSeconds}s` : ""}) ` +
        `usable as: ${a.suitableFormats.join(", ") || "NOTHING — wrong shape for any format"}\n` +
        `  ${a.description}` +
        (a.describedFrom === "NOT_DESCRIBED"
          ? `\n  NOT DESCRIBED: this is a video and you cannot watch it. You know only its ` +
            `shape and length. Ask the user what is in it rather than inventing detail, ` +
            `and say so plainly if you write copy around it.`
          : ""),
    );
  }

  if (lines.length === 0) return message;

  // A delimited block rather than a tool: the reference has to be unambiguous
  // at the moment "this" is said, and a tool call would resolve it a turn too
  // late. Same trick as the time context.
  return `<attached_media>
The user attached these files to this message. When they say "this", they mean these. Whenever you create or revise content that uses one of these files, you MUST put its id in that variant's assetIds — otherwise the content is not actually linked to the file and will publish with nothing attached.

${lines.join("\n")}
</attached_media>

${message}`;
}

/** Parse the `assets` query parameter. */
export function parseAssetIds(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
