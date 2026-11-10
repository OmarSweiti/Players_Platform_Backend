import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { describeError } from '../../common/logging/describe-error';
import type { PrismaClient } from '@prisma/client';
import { TenantTransactions } from '../../common/tenancy/tenant-transaction';
import { type Clock, systemClock } from '../../common/time/clock';
import { jobContext } from '../queue/job-context';
import type { OutboxPublisher } from '../queue/outbox-queue';
import type { TenantRegistry } from '../tenancy/tenant-registry';

/** How much a relay claims at once, for how long, and who it is. */
export interface RelayOptions {
  /** The most events claimed in one tenant per pass. */
  readonly batch: number;
  /** How long a claim holds before another relay may take the event again. */
  readonly leaseSeconds: number;
  /** This relay's name, at most 60 characters: a host and a process. */
  readonly owner: string;
}

export const RELAY: Omit<RelayOptions, 'owner'> = {
  batch: 100,
  leaseSeconds: 60,
};

/** What one pass did. */
export interface RelayPass {
  readonly tenants: number;
  readonly claimed: number;
  readonly published: number;
}

interface Claimed {
  readonly id: string;
  readonly type: string;
  readonly request_id: string | null;
}

/**
 * The outbox relay (0.7.6; SYS-ASY-003, SYS-TEN-006). One pass finds the
 * active tenants through the registry and, for each, in that tenant's own
 * transaction as the runtime role:
 *
 * 1. claims its due events — CREATED and available, or LEASED by a relay
 *    whose lease has run out — `FOR UPDATE SKIP LOCKED`, so two relays never
 *    claim the same event, under a lease that names this claim;
 * 2. publishes each to the queue, outside any transaction;
 * 3. marks it PUBLISHED, only while the lease is still this claim's: a relay
 *    whose lease ran out and was taken over changes nothing.
 *
 * A relay that stops between 1 and 3 leaves its events LEASED; the lease runs
 * out and the next pass takes them again. Publishing twice is one job (the
 * event's id is the job's), and the consumers' receipts keep any effect from
 * running twice.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly transactions: TenantTransactions;

  constructor(
    private readonly registry: Pick<TenantRegistry, 'activeTenantIds'>,
    prisma: Pick<PrismaClient, '$transaction'>,
    private readonly publisher: Pick<OutboxPublisher, 'publish'>,
    private readonly options: RelayOptions,
    private readonly clock: Clock = systemClock,
  ) {
    this.transactions = new TenantTransactions(prisma);
  }

  async relayOnce(): Promise<RelayPass> {
    const tenants = await this.registry.activeTenantIds();
    let claimed = 0;
    let published = 0;
    for (const tenantId of tenants) {
      const ctx = jobContext(tenantId, 'outbox:relay');
      const lease = `${this.options.owner.slice(0, 60)}:${randomUUID()}`;
      const events = await this.transactions.withTenantTransaction(
        ctx,
        (tx) =>
          tx.$queryRaw<Claimed[]>`
          UPDATE outbox_events
             SET status = 'LEASED', lease_owner = ${lease},
                 lease_until = now() + make_interval(secs => ${this.options.leaseSeconds})
           WHERE id IN (
             SELECT id FROM outbox_events
              WHERE tenant_id = ${tenantId}::uuid
                AND ((status = 'CREATED' AND available_at <= now())
                  OR (status = 'LEASED' AND lease_until < now()))
              ORDER BY available_at, id
              LIMIT ${this.options.batch}
              FOR UPDATE SKIP LOCKED)
          RETURNING id::text AS id, type, request_id`,
      );
      claimed += events.length;
      for (const event of events) {
        try {
          await this.publisher.publish({
            id: event.id,
            tenantId,
            type: event.type,
            requestId: event.request_id,
          });
          const { count } = await this.transactions.withTenantTransaction(
            ctx,
            (tx) =>
              tx.outboxEvent.updateMany({
                where: {
                  id: event.id,
                  tenantId,
                  status: 'LEASED',
                  leaseOwner: lease,
                },
                data: {
                  status: 'PUBLISHED',
                  dispatchedAt: this.clock.now(),
                  leaseOwner: null,
                  leaseUntil: null,
                },
              }),
          );
          published += count;
        } catch (error) {
          // The lease runs out on its own, and the next pass takes it again.
          this.logger.warn(
            `outbox event not published: ${describeError(error)}; its lease will run out and it is claimed again`,
          );
        }
      }
    }
    return { tenants: tenants.length, claimed, published };
  }
}
