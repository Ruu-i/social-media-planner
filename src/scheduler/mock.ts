import { randomUUID } from "node:crypto";

import type { ScheduledJob, Scheduler } from "./types.js";

/**
 * In-memory stand-in for EventBridge Scheduler.
 *
 * It deliberately does NOT fire anything — publishing is a later phase. What it
 * does provide is the thing that makes rescheduling honest: a job that exists,
 * has an id, and must be explicitly cancelled when a variant moves.
 *
 * `failNext` exists so tests can prove the rollback path works. Without a way
 * to make the scheduler fail, "atomic" is an untested claim.
 */
export class MockScheduler implements Scheduler {
  private jobs = new Map<string, ScheduledJob>();
  private failCount = 0;

  /** Make the next N schedule() calls throw, to exercise rollback. */
  failNext(times = 1) {
    this.failCount = times;
  }

  async schedule(
    variantId: string,
    fireAt: string,
    idempotencyKey: string,
  ): Promise<ScheduledJob> {
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error("scheduler unavailable");
    }
    const job: ScheduledJob = {
      scheduleId: `sch_${randomUUID().slice(0, 8)}`,
      variantId,
      fireAt,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.scheduleId, job);
    return job;
  }

  async cancel(scheduleId: string): Promise<void> {
    // Deliberately forgiving: a job that already fired, or was cancelled by a
    // retry, is not an error. EventBridge behaves the same way, and treating it
    // as fatal would make every retry path brittle.
    this.jobs.delete(scheduleId);
  }

  pending(): ScheduledJob[] {
    return [...this.jobs.values()].sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }
}
