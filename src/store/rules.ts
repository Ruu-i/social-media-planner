import { AGENT_TRANSITIONS, type Channel, type Status, type VariantDraft } from "../schemas.js";
import type { ConnectionStore } from "./connections.js";
import type { MediaStore } from "./media.js";

/**
 * The business rules, as pure functions.
 *
 * These were originally methods on MemoryStore. They are extracted here because
 * there are now two persistence implementations, and rules that live inside one
 * of them will eventually diverge from the other. A store should decide where
 * bytes go; it should not each separately decide who may approve what.
 *
 * Everything here is deliberately storage-agnostic: no reads, no writes, no
 * knowledge of DynamoDB or Maps. Given the inputs, each either returns or
 * throws.
 */

export class StoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "INVALID_STATE"
      | "INVALID_INPUT"
      | "NOT_CONNECTED",
  ) {
    super(message);
  }
}

/**
 * A datetime with no offset is the bug that publishes five and a half hours
 * late in Colombo. Reject it at the boundary rather than storing something
 * whose meaning depends on which machine reads it.
 */
export function assertHasOffset(value: string): void {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim())) {
    throw new StoreError(
      `"${value}" has no timezone offset. Use a full ISO 8601 value such as ` +
        `2026-09-14T11:00:00+05:30 so the time means the same thing everywhere.`,
      "INVALID_INPUT",
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new StoreError(`"${value}" is not a valid datetime`, "INVALID_INPUT");
  }
}

/** Resolves the channel and checks the variant against what it can actually do. */
export function assertVariantValid(
  deps: { connections: ConnectionStore; media: MediaStore | null },
  userId: string,
  v: VariantDraft,
): Channel {
  const channel = deps.connections.getChannel(userId, v.channelId);
  if (!channel) {
    throw new StoreError(
      `No channel ${v.channelId}. Call get_connected_accounts for valid ids.`,
      "INVALID_INPUT",
    );
  }

  if (!channel.supportedFormats.includes(v.media.format)) {
    throw new StoreError(
      `${channel.handle} (${channel.platform}) does not support ${v.media.format}. ` +
        `It supports: ${channel.supportedFormats.join(", ")}`,
      "INVALID_INPUT",
    );
  }
  if (v.caption.length > channel.maxCaptionLength) {
    throw new StoreError(
      `Caption is ${v.caption.length} characters; ${channel.handle} allows ` +
        `${channel.maxCaptionLength}`,
      "INVALID_INPUT",
    );
  }
  if (v.hashtags.length > channel.maxHashtags) {
    throw new StoreError(
      `${v.hashtags.length} hashtags; ${channel.handle} allows ${channel.maxHashtags}`,
      "INVALID_INPUT",
    );
  }

  // Assets must fit the format they are being used in — a landscape photo in a
  // Reel is wrong before anyone reads the caption.
  if (deps.media && v.assetIds.length > 0) {
    deps.media.assertSuitableFor(userId, v.assetIds, v.media.format);
  }

  assertHasOffset(v.scheduledFor);
  return channel;
}

/**
 * The approval boundary.
 *
 * There is no transition into APPROVED here, and that absence is the design:
 * the agent has no tool that can write it, so no rule needs to permit it.
 */
export function assertAgentTransition(from: Status, to: Status): void {
  const allowed = AGENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new StoreError(
      `The agent cannot move a variant from ${from} to ${to}` +
        (to === "APPROVED" ? " — approval requires a human." : ""),
      "FORBIDDEN",
    );
  }
}

/**
 * Does an edit survive with its approval intact?
 *
 * The human approved WORDS, not a slot in the calendar. A pure time change
 * keeps the approval; any change to the content itself revokes it. Revoking on
 * a reschedule would be technically safe and genuinely infuriating.
 */
export function approvalSurvives(changes: Partial<VariantDraft>): boolean {
  return !Object.keys(changes).some((k) => k !== "scheduledFor");
}

/** Only APPROVED content may be scheduled. This is the gate that matters most. */
export function assertSchedulable(status: Status, variantId: string): void {
  if (status !== "APPROVED") {
    throw new StoreError(
      `Variant ${variantId} is ${status}. Only APPROVED variants can be scheduled — ` +
        `a human must approve it first.`,
      "INVALID_STATE",
    );
  }
}

export function assertFutureTime(scheduledFor: string): void {
  assertHasOffset(scheduledFor);
  if (new Date(scheduledFor).getTime() <= Date.now()) {
    throw new StoreError(`${scheduledFor} is in the past`, "INVALID_INPUT");
  }
}
