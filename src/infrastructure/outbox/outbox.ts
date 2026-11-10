import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import {
  OUTBOX_EVENTS,
  type OutboxEventType,
  type OutboxRefs,
} from './outbox-events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest dedup key: the column's bound, in characters. */
export const DEDUP_KEY_MAX = 200;

/**
 * An outbox event its catalog does not allow: a payload naming other than its
 * entry's identifiers, an identifier that is not a UUID, a dedup key out of
 * bounds. A programming error — the change it belonged to is aborted with it.
 */
export class OutboxEventRefused extends Error {
  constructor(reason: string) {
    super(`outbox event refused: ${reason}`);
    this.name = 'OutboxEventRefused';
  }
}

/** An event to enqueue: its type, the record it is about, its payload and its key. */
export interface OutboxEventInput<T extends OutboxEventType> {
  readonly type: T;
  readonly aggregateId: string;
  readonly refs: OutboxRefs<T>;
  /**
   * The intent's own key, unique in the tenant: the same intent enqueued
   * again — a retried command, a replayed job — is a no-op. At most 200
   * characters, and never empty.
   */
  readonly dedupKey: string;
  /** When it may first be claimed; now when not given. */
  readonly availableAt?: Date;
}

/**
 * The transactional outbox (0.7.5; I-10, SYS-ASY-002, SYS-ASY-005). `enqueue`
 * writes the event on the caller's transaction, so it commits with the change
 * or not at all, in the context's tenant — never one a caller names. A dedup
 * key already enqueued in the tenant writes nothing, without failing the
 * transaction (`ON CONFLICT DO NOTHING`), and answers the event already kept.
 * The relay that claims and publishes events is 0.7.6's.
 */
@Injectable()
export class Outbox {
  async enqueue<T extends OutboxEventType>(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: OutboxEventInput<T>,
  ): Promise<{ readonly id: string; readonly enqueued: boolean }> {
    const definition = OUTBOX_EVENTS[event.type];
    const refs = refsOf(event.type, definition.refs, event.refs);
    if (!UUID.test(event.aggregateId)) {
      throw new OutboxEventRefused(
        `${event.type}: the aggregate id is not a UUID`,
      );
    }
    if (event.dedupKey === '' || [...event.dedupKey].length > DEDUP_KEY_MAX) {
      throw new OutboxEventRefused(
        `${event.type}: the dedup key is out of bounds`,
      );
    }
    const created = await tx.outboxEvent.createManyAndReturn({
      data: [
        {
          tenantId: ctx.tenantId,
          type: event.type,
          aggregateType: definition.aggregate,
          aggregateId: event.aggregateId,
          payloadVersion: definition.version,
          payloadRefs: refs,
          dedupKey: event.dedupKey,
          ...(event.availableAt ? { availableAt: event.availableAt } : {}),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (created.length === 1) return { id: created[0].id, enqueued: true };
    const kept = await tx.outboxEvent.findUniqueOrThrow({
      where: {
        tenantId_dedupKey: { tenantId: ctx.tenantId, dedupKey: event.dedupKey },
      },
      select: { id: true },
    });
    return { id: kept.id, enqueued: false };
  }
}

/** The payload as written: exactly the entry's identifiers, each a UUID. */
function refsOf(
  type: string,
  allowed: readonly string[],
  given: Readonly<Record<string, string>>,
): Record<string, string> {
  for (const key of Object.keys(given)) {
    if (!allowed.includes(key)) {
      throw new OutboxEventRefused(`${type} carries no ${key}`);
    }
  }
  const refs: Record<string, string> = {};
  for (const key of allowed) {
    const value = given[key];
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new OutboxEventRefused(`${type}: ${key} is not a UUID`);
    }
    refs[key] = value.toLowerCase();
  }
  return refs;
}
