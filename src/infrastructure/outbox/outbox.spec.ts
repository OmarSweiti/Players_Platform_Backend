import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import { ConsumerInboxes, ConsumerNameRefused } from './consumer-inboxes';
import {
  DEDUP_KEY_MAX,
  Outbox,
  type OutboxEventInput,
  OutboxEventRefused,
} from './outbox';

// The outbox's and the inbox's own rules (0.7.5), on a transaction that only
// collects what it is asked to write. Only the minters make a context
// (eslint.config.mjs): a plain one stands in, since nothing below asks
// whether it was minted.

const TENANT = randomUUID();
const ctx = {
  tenantId: TENANT,
  actor: { kind: 'SYSTEM', job: 'test' },
  requestId: randomUUID(),
  locale: 'en',
} as unknown as AuthorizedTenantContext;

/** A transaction that keeps what the services write, and writes nothing. */
function collecting() {
  const written: Array<Record<string, unknown>> = [];
  const tx = {
    outboxEvent: {
      createManyAndReturn: ({ data }: { data: Record<string, unknown>[] }) => {
        written.push(...data);
        return Promise.resolve([{ id: randomUUID() }]);
      },
    },
    consumerInbox: {
      createMany: ({ data }: { data: Record<string, unknown>[] }) => {
        written.push(...data);
        return Promise.resolve({ count: 1 });
      },
    },
  } as unknown as TenantTx;
  return { tx, written };
}

const invitationId = randomUUID();
const notice: OutboxEventInput<'invitation.created'> = {
  type: 'invitation.created',
  aggregateId: invitationId,
  refs: { invitationId },
  dedupKey: `invitation.created:${invitationId}`,
};

describe('the outbox', () => {
  it('writes_the_catalogs_identifiers_in_the_contexts_tenant', async () => {
    const { tx, written } = collecting();
    await new Outbox().enqueue(tx, ctx, {
      ...notice,
      refs: { invitationId: invitationId.toUpperCase() },
    });
    expect(written).toEqual([
      {
        tenantId: TENANT,
        type: 'invitation.created',
        aggregateType: 'Invitation',
        aggregateId: invitationId,
        payloadVersion: 1,
        payloadRefs: { invitationId },
        dedupKey: `invitation.created:${invitationId}`,
        requestId: ctx.requestId,
      },
    ]);
  });

  it('an_event_carries_identifiers_only', async () => {
    const refused: Array<[unknown, string]> = [
      [
        { ...notice, refs: { invitationId, email: 'x@agency.test' } },
        'invitation.created carries no email',
      ],
      [
        { ...notice, refs: { invitationId: 'https://x.test/accept?t=1' } },
        'invitation.created: invitationId is not a UUID',
      ],
      [
        { ...notice, refs: {} },
        'invitation.created: invitationId is not a UUID',
      ],
      [
        { ...notice, aggregateId: 'invitation-1' },
        'invitation.created: the aggregate id is not a UUID',
      ],
      [
        { ...notice, dedupKey: '' },
        'invitation.created: the dedup key is out of bounds',
      ],
      [
        { ...notice, dedupKey: 'k'.repeat(DEDUP_KEY_MAX + 1) },
        'invitation.created: the dedup key is out of bounds',
      ],
    ];
    for (const [event, reason] of refused) {
      const { tx, written } = collecting();
      await expect(
        new Outbox().enqueue(
          tx,
          ctx,
          event as OutboxEventInput<'invitation.created'>,
        ),
      ).rejects.toThrow(new OutboxEventRefused(reason));
      expect(written).toEqual([]);
    }
  });
});

describe('the consumer inbox', () => {
  it('a_consumer_is_named_in_form', async () => {
    for (const consumer of ['Mail', 'mail notice', '.mail', 'm'.repeat(101)]) {
      const { tx, written } = collecting();
      await expect(
        new ConsumerInboxes().once(
          tx,
          ctx,
          { consumer, eventId: randomUUID() },
          () => Promise.resolve(undefined),
        ),
      ).rejects.toBeInstanceOf(ConsumerNameRefused);
      expect(written).toEqual([]);
    }
    const { tx, written } = collecting();
    const eventId = randomUUID();
    expect(
      await new ConsumerInboxes().once(
        tx,
        ctx,
        { consumer: 'mail.invitation-notice', eventId },
        () => Promise.resolve(undefined),
      ),
    ).toEqual({ processed: true });
    expect(written).toEqual([
      { tenantId: TENANT, consumer: 'mail.invitation-notice', eventId },
    ]);
  });
});
