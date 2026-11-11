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
 * An effect that cannot succeed however often it is tried — a mail server
 * that refused the message itself, say: its job ends at once, and its event
 * is DEAD with `code` (0.7.8).
 */
export class EffectFailedForGood extends Error {
  constructor(readonly code: string) {
    super(`effect failed for good: ${code}`);
    this.name = 'EffectFailedForGood';
  }
}

/**
 * A consumer of outbox events (0.7.6): its name, the event types it takes,
 * and its effect. The worker runs the effect in the event's own tenant
 * transaction, behind the consumer's receipt (ConsumerInboxes.once, 0.7.5),
 * so that it commits once however often the event is delivered. An effect
 * reaches the database through `tx` only; one that must call an outside
 * service records its intent there, and `dispatch` makes the call after the
 * commit (0.7.8).
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

  /**
   * The outside call, outside any transaction, after the receipt committed:
   * run on every delivery of the event, the first and each retry, so it
   * reads from the database what is left to do — and does nothing once it
   * is done. A failure is retried with the job's back-off, unless it is an
   * `EffectFailedForGood`.
   */
  dispatch?(ctx: AuthorizedTenantContext, event: DeliveredEvent): Promise<void>;
}

/** The consumers the worker runs: every one registered, each for its own types. */
export const OUTBOX_CONSUMERS = Symbol('OUTBOX_CONSUMERS');
