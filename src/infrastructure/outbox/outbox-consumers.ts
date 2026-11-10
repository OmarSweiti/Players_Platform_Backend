import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import type { OutboxEventType } from './outbox-events';

/** An outbox event as its consumers receive it: what happened, about what, and its identifiers. */
export interface DeliveredEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly type: OutboxEventType;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payloadVersion: number;
  readonly payloadRefs: Readonly<Record<string, string>>;
}

/**
 * A consumer of outbox events (0.7.6): its name, the event types it takes,
 * and its effect. The worker runs the effect in the event's own tenant
 * transaction, behind the consumer's receipt (ConsumerInboxes.once, 0.7.5),
 * so that it commits once however often the event is delivered. An effect
 * reaches the database through `tx` only; one that must call an outside
 * service records its intent there and calls after the commit (0.7.8).
 */
export abstract class OutboxConsumer {
  /** Lower-case words joined by dots: `mail.invitation-notice`. */
  abstract readonly name: string;
  abstract readonly types: readonly OutboxEventType[];
  /** The effect; it may name what it produced (a record's id), which the receipt keeps. */
  abstract consume(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: DeliveredEvent,
  ): Promise<string | undefined>;
}

/** The consumers the worker runs: every one registered, each for its own types. */
export const OUTBOX_CONSUMERS = Symbol('OUTBOX_CONSUMERS');
