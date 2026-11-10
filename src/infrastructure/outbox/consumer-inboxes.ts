import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';

const CONSUMER = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

/** A consumer named out of form: a programming error. */
export class ConsumerNameRefused extends Error {
  constructor() {
    super('consumer name refused: lower-case words joined by dots');
    this.name = 'ConsumerNameRefused';
  }
}

/** What one delivery came to: the effect committed now, or already. */
export type Delivery =
  | { readonly processed: true; readonly resultRef?: string }
  | { readonly processed: false };

/**
 * Consumer inboxes (0.7.5; I-10). `once` runs a consumer's effect for an
 * event at most once per consumer, however often the event is delivered: its
 * receipt is written first, on the effect's own transaction, so the effect
 * and the receipt commit together or not at all.
 *
 * - An event already received by this consumer runs nothing: `processed:
 *   false`.
 * - A concurrent delivery waits on the first one's receipt, and finds it once
 *   that commits; if the first rolls back, the waiting one runs the effect.
 * - An effect that fails rolls its receipt back with it, so the next delivery
 *   runs it again.
 * - The receipt's key to its event carries the tenant: a receipt for another
 *   tenant's event is refused by the database.
 *
 * An effect may name what it produced (a record's id): the receipt keeps it.
 */
@Injectable()
export class ConsumerInboxes {
  async once(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    receipt: { readonly consumer: string; readonly eventId: string },
    effect: () => Promise<string | undefined>,
  ): Promise<Delivery> {
    if (!CONSUMER.test(receipt.consumer) || receipt.consumer.length > 100) {
      throw new ConsumerNameRefused();
    }
    const key = {
      tenantId: ctx.tenantId,
      consumer: receipt.consumer,
      eventId: receipt.eventId,
    };
    // ON CONFLICT DO NOTHING: a receipt already there does not fail the
    // transaction, and a concurrent one is waited for.
    const { count } = await tx.consumerInbox.createMany({
      data: [key],
      skipDuplicates: true,
    });
    if (count === 0) return { processed: false };
    const resultRef = await effect();
    if (resultRef === undefined) return { processed: true };
    await tx.consumerInbox.update({
      where: { tenantId_consumer_eventId: key },
      data: { resultRef },
    });
    return { processed: true, resultRef };
  }
}
