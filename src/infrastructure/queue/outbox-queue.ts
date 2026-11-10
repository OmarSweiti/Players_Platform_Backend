import type { ConnectionOptions, Queue } from 'bullmq';
import { z } from 'zod';

/** The queue outbox events are delivered through (0.7.6). */
export const OUTBOX_QUEUE = 'outbox';

/**
 * How often a delivery is tried, and how it waits between tries: an
 * exponential back-off from `backoffMs`, doubling, up to `attempts` in all.
 * After the last, the event is DEAD with its last error. 8 tries from 5 s
 * waits about 21 minutes in all before giving up.
 */
export interface DeliveryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
}

export const DELIVERY: DeliveryPolicy = { attempts: 8, backoffMs: 5_000 };

/**
 * A job's data: identifiers only — the tenant, the event, and the request it
 * was enqueued in — never the event's payload or anything a person wrote. The
 * handler loads the event in that tenant, so a job naming another tenant's
 * event finds nothing.
 */
export const OutboxJobData = z.strictObject({
  tenantId: z.uuid(),
  eventId: z.uuid(),
  correlation: z.strictObject({ requestId: z.string().max(128).nullable() }),
});
export type OutboxJobData = z.infer<typeof OutboxJobData>;

/** Valkey, as BullMQ connects to it: a blocking worker needs no retry limit per request. */
export function queueConnection(host: string, port: number): ConnectionOptions {
  return { host, port, maxRetriesPerRequest: null };
}

/**
 * Hands claimed events to the queue (0.7.6). The event's id is the job's id,
 * so an event published twice — a relay that crashed after publishing and
 * before marking it — is one job while the queue keeps it; when the queue has
 * let it go, the consumers' receipts keep its effects from running twice.
 */
export class OutboxPublisher {
  constructor(
    private readonly queue: Queue,
    private readonly policy: DeliveryPolicy = DELIVERY,
  ) {}

  async publish(event: {
    readonly id: string;
    readonly tenantId: string;
    readonly type: string;
    readonly requestId: string | null;
  }): Promise<void> {
    const data: OutboxJobData = {
      tenantId: event.tenantId,
      eventId: event.id,
      correlation: { requestId: event.requestId },
    };
    await this.queue.add(event.type, data, {
      jobId: event.id,
      attempts: this.policy.attempts,
      backoff: { type: 'exponential', delay: this.policy.backoffMs },
      // Kept for a while for inspection, then let go: the outbox row is the record.
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}
