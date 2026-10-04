import { media, publisher, store } from "../server/sessions.js";

/**
 * The publisher worker.
 *
 * Fired by an EventBridge rule on a fixed interval, NOT by a timer created when
 * a post was scheduled. That is a deliberate inversion of the obvious design,
 * and the reason is durability.
 *
 * The obvious design is one-shot schedules: when a variant is scheduled, create
 * an EventBridge schedule that fires at exactly that moment. It is precise, and
 * it makes the timer the source of truth — so every scheduling operation now
 * has two writes that can fail independently, the row and the schedule. A
 * created schedule with a failed row publishes a post the user never confirmed.
 * A written row with a failed schedule silently never posts. Cancel and
 * reschedule double the surface again. That partial-failure class has already
 * produced two real bugs in this codebase, both in the rollback paths.
 *
 * Sweeping inverts it: the DATABASE is the source of truth, and the timer is
 * gone entirely. A variant is due because its row says so — GSI2 is a sparse
 * index keyed on scheduled time, so "what is due" is one query, not a scan.
 * Nothing can be lost, because nothing is held anywhere else. A sweep that
 * fails changes nothing and the next one picks the work up again; the system
 * is self-healing by construction rather than by compensation.
 *
 * What it costs is precision: a post fires within the sweep interval rather
 * than to the second. For social scheduling that is irrelevant — nobody
 * schedules a coffee-shop post for 11:00:00 and means it.
 *
 * In-process timers (MockScheduler) remain for local development, where they
 * give immediate feedback and the process lives long enough to hold them.
 */

interface SweepResult {
  swept: number;
  published: number;
  failed: number;
}

export const handler = async (): Promise<SweepResult> => {
  const now = new Date();
  const due = await store.getDueVariants(now);

  const result: SweepResult = { swept: due.length, published: 0, failed: 0 };
  if (due.length === 0) {
    console.log(JSON.stringify({ msg: "sweep: nothing due", at: now.toISOString() }));
    return result;
  }

  for (const variant of due) {
    // One bad variant must not end the sweep — the rest are still due, and a
    // thrown error here would retry the WHOLE batch, re-attempting posts that
    // already succeeded. publishOne is idempotent, but re-running it is still
    // wasted work and noisier logs than necessary.
    try {
      // The library is loaded per OWNER, not once for the sweep: due variants
      // can belong to different people, and publishing reads each one's media
      // to resolve the URLs Meta will fetch.
      await media.refresh(variant.userId);
      const outcome = await publisher.publishOne(variant.userId, variant.id);
      if (outcome.status === "PUBLISHED") result.published++;
      else result.failed++;

      console.log(
        JSON.stringify({
          msg: "sweep: variant",
          variantId: variant.id,
          platform: outcome.platform,
          status: outcome.status,
          detail: outcome.detail,
        }),
      );
    } catch (error) {
      result.failed++;
      console.error(
        JSON.stringify({
          msg: "sweep: variant threw",
          variantId: variant.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  console.log(JSON.stringify({ msg: "sweep: done", ...result }));
  return result;
};
