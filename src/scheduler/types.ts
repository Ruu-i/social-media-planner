/**
 * The scheduling seam.
 *
 * A scheduled variant is not just a row with a future date on it — there is a
 * timer in existence somewhere that will fire and publish. That distinction is
 * the whole reason rescheduling is harder than editing a field: move the row
 * without moving the timer and the post still goes out at the old time.
 *
 * Today this is backed by an in-memory mock. In production it is EventBridge
 * Scheduler creating one-shot schedules that drop a message on SQS for the
 * publisher Lambda. Nothing above this interface changes when that swap happens.
 */

export interface ScheduledJob {
  scheduleId: string;
  variantId: string;
  fireAt: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface Scheduler {
  /**
   * Create a one-shot schedule. Returns the provider's schedule id, which the
   * store keeps on the variant so the job can be found again to cancel it.
   *
   * The idempotency key travels to the publisher, so a redelivered SQS message
   * or a retried Lambda cannot post twice.
   */
  schedule(variantId: string, fireAt: string, idempotencyKey: string): Promise<ScheduledJob>;

  /** Cancel a schedule. Must tolerate an id that has already fired or gone. */
  cancel(scheduleId: string): Promise<void>;

  /** Inspect pending jobs. Exists for tests and the CLI, not for the agent. */
  pending(): ScheduledJob[];
}
