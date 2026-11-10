import { randomBytes, randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ValidationFailedError } from '../../src/common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../src/common/tenancy/tenant-transaction';
import { ConsumerInboxes } from '../../src/infrastructure/outbox/consumer-inboxes';
import { Outbox } from '../../src/infrastructure/outbox/outbox';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  runPrisma,
  testContext,
} from '../harness/fixtures';

// The transactional outbox and the consumer inbox (0.7.5; I-10,
// SYS-ASY-002, SYS-ASY-005). An event is written in the business transaction
// and commits with the change or not at all; a dedup key already enqueued in
// the tenant is a no-op that fails nothing; a consumer's receipt and its
// effect commit together, once, however often the event is delivered —
// one after another, or at once. Two tenants, real PostgreSQL 18, as the
// runtime role.

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = 'P2003';
const suffix = () => randomBytes(4).toString('hex');

const outbox = new Outbox();
const inboxes = new ConsumerInboxes();
const transactions = () => new TenantTransactions(runPrisma());

/** An invitation made in `tx`, as the users module makes one: a change an event follows. */
function invite(tx: TenantTx, owner: User) {
  const email = `invitee-${suffix()}@agency.test`;
  return tx.invitation.create({
    data: {
      tenantId: owner.tenantId,
      email,
      normalizedEmail: email,
      role: 'COACH',
      locale: 'en',
      invitedById: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
    },
    select: { id: true },
  });
}

/** The invitation's notice, as 0.7.8's producer will enqueue it. */
const noticeOf = (invitationId: string) =>
  ({
    type: 'invitation.created',
    aggregateId: invitationId,
    refs: { invitationId },
    dedupKey: `invitation.created:${invitationId}`,
  }) as const;

/** Every outbox event about `aggregateId`, as its tenant reads them. */
function eventsOf(tenant: Tenant, aggregateId: string) {
  return asTenant(tenant.id, (tx) =>
    tx.outboxEvent.findMany({
      where: { aggregateId },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

/** One event of `owner`'s tenant, committed: what consumers receive. */
async function committedEvent(owner: User) {
  const ctx = memberContext(owner);
  return transactions().withTenantTransaction(ctx, async (tx) => {
    const { id } = await invite(tx, owner);
    return (await outbox.enqueue(tx, ctx, noticeOf(id))).id;
  });
}

describe('the transactional outbox and the consumer inbox', () => {
  let tenants: Tenant[];
  let owners: User[];

  beforeAll(async () => {
    tenants = [await createTenant(), await createTenant()];
    owners = [
      await createMember(tenants[0], 'OWNER'),
      await createMember(tenants[1], 'OWNER'),
    ];
  });

  it('a_rolled_back_change_enqueues_nothing', async () => {
    for (const [i, tenant] of tenants.entries()) {
      const owner = owners[i];
      const ctx = memberContext(owner);

      // The invitation and its event are written, and then a later step of
      // the change fails: neither is kept.
      let lost = '';
      await expect(
        transactions().withTenantTransaction(ctx, async (tx) => {
          const { id } = await invite(tx, owner);
          lost = id;
          expect(await outbox.enqueue(tx, ctx, noticeOf(id))).toMatchObject({
            enqueued: true,
          });
          throw new ValidationFailedError('a later step of the change fails');
        }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.invitation.count({ where: { id: lost } }),
        ),
      ).toBe(0);
      expect(await eventsOf(tenant, lost)).toEqual([]);

      // Committed: the event with it, as written, in the context's tenant —
      // its payload identifiers only.
      const { invitationId, eventId } =
        await transactions().withTenantTransaction(ctx, async (tx) => {
          const { id } = await invite(tx, owner);
          const { id: event } = await outbox.enqueue(tx, ctx, noticeOf(id));
          return { invitationId: id, eventId: event };
        });
      const [event, ...more] = await eventsOf(tenant, invitationId);
      expect(more).toEqual([]);
      expect(event).toEqual({
        id: eventId,
        tenantId: tenant.id,
        type: 'invitation.created',
        aggregateType: 'Invitation',
        aggregateId: invitationId,
        payloadVersion: 1,
        payloadRefs: { invitationId },
        dedupKey: `invitation.created:${invitationId}`,
        status: 'CREATED',
        attempts: 0,
        availableAt: expect.any(Date) as Date,
        leaseOwner: null,
        leaseUntil: null,
        dispatchedAt: null,
        lastErrorCode: null,
        requestId: ctx.requestId,
        createdAt: expect.any(Date) as Date,
      });
      expect(event.id).toMatch(UUID_V7);
      // The other tenant sees nothing of it.
      expect(await eventsOf(tenants[1 - i], invitationId)).toEqual([]);
    }
  });

  it('a_duplicate_dedup_key_is_a_no_op', async () => {
    const dedupKey = `invitation.created:shared-${suffix()}`;
    const ids: string[] = [];
    for (const [i, tenant] of tenants.entries()) {
      const owner = owners[i];
      const ctx = memberContext(owner);
      const { invitationId, first, again, after } =
        await transactions().withTenantTransaction(ctx, async (tx) => {
          const { id } = await invite(tx, owner);
          const notice = { ...noticeOf(id), dedupKey };
          const one = await outbox.enqueue(tx, ctx, notice);
          // The same intent again, in the same transaction: nothing written,
          // and the transaction goes on — a later write still commits.
          const two = await outbox.enqueue(tx, ctx, notice);
          const later = await invite(tx, owner);
          return { invitationId: id, first: one, again: two, after: later.id };
        });
      expect(first).toEqual({
        id: expect.any(String) as string,
        enqueued: true,
      });
      expect(again).toEqual({ id: first.id, enqueued: false });
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.invitation.count({ where: { id: after } }),
        ),
      ).toBe(1);

      // And again in a transaction of its own: the event already kept.
      expect(
        await transactions().withTenantTransaction(ctx, (tx) =>
          outbox.enqueue(tx, ctx, { ...noticeOf(invitationId), dedupKey }),
        ),
      ).toEqual({ id: first.id, enqueued: false });
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.outboxEvent.count({ where: { dedupKey } }),
        ),
      ).toBe(1);
      ids.push(first.id);
    }
    // The key is the tenant's own: the other tenant's same key is its own
    // event, and a key never tells one tenant about another's.
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('a_consumer_commits_an_event_once', async () => {
    for (const [i, tenant] of tenants.entries()) {
      const eventId = await committedEvent(owners[i]);
      const job = testContext(tenant.id, 'outbox-consumer');
      let effects = 0;
      /** One delivery: the receipt and a database effect, in one transaction. */
      const deliver = (consumer: string, effect = () => Promise.resolve()) =>
        transactions().withTenantTransaction(job, (tx) =>
          inboxes.once(tx, job, { consumer, eventId }, async () => {
            await effect();
            await tx.player.create({
              data: { tenantId: tenant.id, fullName: `Effect of ${eventId}` },
            });
            effects += 1;
            return `player-of-${eventId}`;
          }),
        );
      const effectRows = () =>
        asTenant(tenant.id, (tx) =>
          tx.player.count({ where: { fullName: `Effect of ${eventId}` } }),
        );

      // An effect that fails: its receipt rolls back with it.
      class EffectFailed extends ValidationFailedError {}
      await expect(
        deliver('test.consumer', () =>
          Promise.reject(new EffectFailed('the effect fails')),
        ),
      ).rejects.toBeInstanceOf(EffectFailed);
      expect(await effectRows()).toBe(0);

      // Delivered twice, then at once: the effect commits once.
      expect(await deliver('test.consumer')).toEqual({
        processed: true,
        resultRef: `player-of-${eventId}`,
      });
      expect(await deliver('test.consumer')).toEqual({ processed: false });
      const concurrent = await Promise.all([
        deliver('test.consumer'),
        deliver('test.consumer'),
      ]);
      expect(concurrent).toEqual([{ processed: false }, { processed: false }]);
      expect(await effectRows()).toBe(1);
      expect(effects).toBe(1);

      // A second consumer of the same event commits its own effect, once.
      await deliver('test.another-consumer');
      await deliver('test.another-consumer');
      expect(await effectRows()).toBe(2);
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.consumerInbox.findMany({
            where: { eventId },
            select: { consumer: true, resultRef: true },
            orderBy: { consumer: 'asc' },
          }),
        ),
      ).toEqual([
        {
          consumer: 'test.another-consumer',
          resultRef: `player-of-${eventId}`,
        },
        { consumer: 'test.consumer', resultRef: `player-of-${eventId}` },
      ]);

      // The other tenant cannot receive this tenant's event: its receipt
      // names an event of its own tenant, or nothing.
      const other = testContext(tenants[1 - i].id, 'outbox-consumer');
      await expect(
        transactions().withTenantTransaction(other, (tx) =>
          inboxes.once(tx, other, { consumer: 'test.consumer', eventId }, () =>
            Promise.resolve(undefined),
          ),
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    }
  });

  it('two_deliveries_at_once_commit_one_effect', async () => {
    // A fresh event, delivered by two workers at the same moment: one waits
    // on the other's receipt and finds it once that commits.
    for (const [i, tenant] of tenants.entries()) {
      const eventId = await committedEvent(owners[i]);
      const job: AuthorizedTenantContext = testContext(tenant.id, 'outbox');
      let effects = 0;
      const deliver = () =>
        transactions().withTenantTransaction(job, (tx) =>
          inboxes.once(
            tx,
            job,
            { consumer: 'test.race', eventId },
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 250));
              effects += 1;
              return undefined;
            },
          ),
        );
      const outcomes = await Promise.all([deliver(), deliver()]);
      expect(outcomes.map((outcome) => outcome.processed).sort()).toEqual([
        false,
        true,
      ]);
      expect(effects).toBe(1);
    }
  });

  describe('as the database holds it', () => {
    let app: Client;

    beforeAll(async () => {
      const { connectionString, options } = databaseConnectionOf(
        inject('databaseUrl'),
      );
      app = new Client({ connectionString, options });
      await app.connect();
    });

    afterAll(async () => {
      await app?.end();
    });

    /** An outbox row written straight, as the tenant, rolled back: or why it was refused. */
    async function insert(tenant: Tenant, values: Record<string, unknown>) {
      const row = {
        id: randomUUID(),
        tenant_id: tenant.id,
        type: 'invitation.created',
        aggregate_type: 'Invitation',
        aggregate_id: randomUUID(),
        payload_version: 1,
        payload_refs: JSON.stringify({ invitationId: randomUUID() }),
        dedup_key: `probe-${suffix()}`,
        ...values,
      };
      const columns = Object.keys(row);
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
        await app.query(
          `INSERT INTO outbox_events (${columns.join(', ')})
           VALUES (${columns.map((_, n) => `$${n + 1}`).join(', ')})`,
          Object.values(row),
        );
        return 'written';
      } catch (error) {
        const { code, constraint } = error as DatabaseError;
        return { code, constraint };
      } finally {
        await app.query('ROLLBACK');
      }
    }

    it('an_outbox_row_holds_only_what_its_checks_allow', async () => {
      const [tenant] = tenants;
      const lease = new Date(Date.now() + 60_000);
      const cases: Array<[string, Record<string, unknown>]> = [
        ['outbox_events_type_check', { type: 'invitation' }],
        [
          'outbox_events_aggregate_type_check',
          { aggregate_type: 'invitation' },
        ],
        ['outbox_events_payload_version_check', { payload_version: 0 }],
        ['outbox_events_attempts_check', { attempts: -1 }],
        ['outbox_events_dedup_key_check', { dedup_key: '' }],
        ['outbox_events_lease_check', { status: 'LEASED' }],
        ['outbox_events_lease_check', { lease_owner: 'relay-1' }],
        [
          'outbox_events_lease_check',
          { status: 'CREATED', lease_owner: 'relay-1', lease_until: lease },
        ],
        ['outbox_events_dispatch_check', { status: 'PUBLISHED' }],
        ['outbox_events_dispatch_check', { dispatched_at: new Date() }],
        ['outbox_events_dead_check', { status: 'DEAD' }],
        ['outbox_events_payload_refs_check', { payload_refs: '[]' }],
        [
          'outbox_events_payload_refs_check',
          { payload_refs: JSON.stringify({ note: 'x'.repeat(4100) }) },
        ],
      ];
      for (const [constraint, values] of cases) {
        expect([constraint, values, await insert(tenant, values)]).toEqual([
          constraint,
          values,
          { code: CHECK_VIOLATION, constraint },
        ]);
      }
      // A row that keeps them all, in each state.
      for (const values of [
        {},
        { status: 'LEASED', lease_owner: 'relay-1', lease_until: lease },
        { status: 'PUBLISHED', dispatched_at: new Date(), attempts: 1 },
        { status: 'DEAD', last_error_code: 'smtp_refused', attempts: 5 },
        // 0.7.6: an event whose handling fails for good after it was dispatched.
        {
          status: 'DEAD',
          last_error_code: 'handler_failed',
          dispatched_at: new Date(),
          attempts: 8,
        },
      ]) {
        expect([values, await insert(tenant, values)]).toEqual([
          values,
          'written',
        ]);
      }

      // A consumer is named by lower-case words joined by dots.
      const eventId = await committedEvent(owners[0]);
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
        await expect(
          app.query(
            `INSERT INTO consumer_inbox (id, tenant_id, consumer, event_id) VALUES ($1, $2, $3, $4)`,
            [randomUUID(), tenant.id, 'Mail Consumer', eventId],
          ),
        ).rejects.toMatchObject({
          code: CHECK_VIOLATION,
          constraint: 'consumer_inbox_consumer_check',
        });
      } finally {
        await app.query('ROLLBACK');
      }
    });
  });
});
