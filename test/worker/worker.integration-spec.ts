import { randomBytes } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { type Job, Queue, Worker } from 'bullmq';
import { Client, type DatabaseError } from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { DependencyUnavailableError } from '../../src/common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../src/common/tenancy/tenant-transaction';
import { ConsumerInboxes } from '../../src/infrastructure/outbox/consumer-inboxes';
import { Outbox } from '../../src/infrastructure/outbox/outbox';
import {
  type DeliveredEvent,
  OutboxConsumer,
} from '../../src/infrastructure/outbox/outbox-consumers';
import type { OutboxEventType } from '../../src/infrastructure/outbox/outbox-events';
import { OutboxRelay } from '../../src/infrastructure/outbox/outbox-relay';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  type DeliveryPolicy,
  OutboxPublisher,
  queueConnection,
} from '../../src/infrastructure/queue/outbox-queue';
import {
  OutboxJobHandler,
  OutboxWorker,
} from '../../src/infrastructure/queue/outbox-worker';
import { TenantRegistry } from '../../src/infrastructure/tenancy/tenant-registry';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';

// The worker (0.7.6; SYS-ARC-005, SYS-ASY-003, SYS-ASY-004, SYS-TEN-006), on
// real PostgreSQL 18 and Valkey, as the runtime role, with two tenants. The
// relay claims each tenant's due events in that tenant's transaction and
// publishes them; the queue's worker runs each job in its own tenant, behind
// each consumer's receipt; retries stop at their bound and mark the event
// DEAD; a crashed worker's job runs again and commits nothing twice; the
// registry role reads the active tenants' ids and nothing else.
//
// Every test has a queue and two tenants of its own, so that no event one
// test leaves behind is another's to relay. Integration files share one
// schema, so the relay is given only the test's tenants: the real registry,
// which lists every active tenant, is proved on its own.

const connection = queueConnection(
  process.env.REDIS_HOST ?? '127.0.0.1',
  Number(process.env.REDIS_PORT ?? 6379),
);
const INSUFFICIENT_PRIVILEGE = '42501';
const suffix = () => randomBytes(4).toString('hex');
const outbox = new Outbox();
const transactions = () => new TenantTransactions(runPrisma());
/** No log context in a test: the job's correlation is checked through the context. */
const logger = { runInContext: <T>(fn: () => T) => fn() };
/** Fast retries for a test: three tries, 20 ms apart, doubling. */
const QUICK: DeliveryPolicy = { attempts: 3, backoffMs: 20 };

/** Waits until `ready` holds, up to `ms`. */
async function until(
  ready: () => Promise<boolean> | boolean,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) expect.unreachable(`not ready within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A consumer of the test's, recording what it was given and writing a player as its effect. */
class Recording extends OutboxConsumer {
  readonly types: readonly OutboxEventType[] = ['invitation.created'];
  readonly calls: Array<{
    ctx: AuthorizedTenantContext;
    event: DeliveredEvent;
  }> = [];

  constructor(
    readonly name: string,
    private readonly behaviour: (
      tx: TenantTx,
      event: DeliveredEvent,
    ) => Promise<void> = () => Promise.resolve(),
  ) {
    super();
  }

  async consume(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: DeliveredEvent,
  ): Promise<string | undefined> {
    this.calls.push({ ctx, event });
    await this.behaviour(tx, event);
    const { id } = await tx.player.create({
      data: { tenantId: ctx.tenantId, fullName: `Effect of ${event.id}` },
      select: { id: true },
    });
    return id;
  }
}

describe('the worker', () => {
  const queues: Queue[] = [];
  const workers: Array<{ close(): Promise<void> }> = [];

  /** An invitation and its event, committed in `owner`'s tenant: the event's id. */
  async function enqueued(owner: User): Promise<string> {
    const ctx = memberContext(owner);
    return transactions().withTenantTransaction(ctx, async (tx) => {
      const email = `invitee-${suffix()}@agency.test`;
      const { id } = await tx.invitation.create({
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
      const event = await outbox.enqueue(tx, ctx, {
        type: 'invitation.created',
        aggregateId: id,
        refs: { invitationId: id },
        dedupKey: `invitation.created:${id}`,
      });
      return event.id;
    });
  }

  /** The event as its tenant reads it. */
  const eventOf = (tenant: Tenant, id: string) =>
    asTenant(tenant.id, (tx) =>
      tx.outboxEvent.findUniqueOrThrow({ where: { id } }),
    );

  /** The players an event's effect wrote, as its tenant reads them. */
  const effectsOf = (tenant: Tenant, eventId: string) =>
    asTenant(tenant.id, (tx) =>
      tx.player.count({ where: { fullName: `Effect of ${eventId}` } }),
    );

  /** Two tenants of the test's own, and an owner of each. */
  async function pair(): Promise<{ tenants: Tenant[]; owners: User[] }> {
    const tenants = [await createTenant(), await createTenant()];
    const owners = [
      await createMember(tenants[0], 'OWNER'),
      await createMember(tenants[1], 'OWNER'),
    ];
    return { tenants, owners };
  }

  /** A queue of the test's own, and a relay for `tenants` publishing to it. */
  function pipeline(tenants: Tenant[], policy: DeliveryPolicy = QUICK) {
    const queue = new Queue(`outbox-test-${suffix()}`, { connection });
    queues.push(queue);
    const relay = new OutboxRelay(
      { activeTenantIds: () => Promise.resolve(tenants.map((t) => t.id)) },
      runPrisma(),
      new OutboxPublisher(queue, policy),
      { batch: 100, leaseSeconds: 60, owner: `test-${suffix()}` },
    );
    return { queue, relay };
  }

  /** A worker on `queue` running `consumers`, started. */
  function worker(
    queue: Queue,
    consumers: OutboxConsumer[],
    options: { lockDurationMs?: number; stalledIntervalMs?: number } = {},
  ) {
    const running = new OutboxWorker(
      connection,
      queue.name,
      new OutboxJobHandler(
        runPrisma(),
        new ConsumerInboxes(),
        consumers,
        logger,
      ),
      runPrisma(),
      { concurrency: 2, ...options },
    );
    running.start();
    workers.push(running);
    return running;
  }

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
    for (const queue of queues) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  it('the_registry_role_reads_nothing_but_tenant_ids', async () => {
    const { tenants } = await pair();
    const url = inject('registryDatabaseUrl');
    expect(
      url,
      'REGISTRY_DATABASE_URL_TEST is not set: the worker tests log in as the registry role (scripts/test-database.sh derives it from the umbrella infra/.env)',
    ).not.toBe('');

    // The active tenants' ids, and not an inactive one's.
    const resting = await createTenant();
    await asTenant(resting.id, (tx) =>
      tx.tenant.update({
        where: { id: resting.id },
        data: { isActive: false },
      }),
    );
    const registry = new TenantRegistry(url);
    try {
      const ids = await registry.activeTenantIds();
      expect(ids).toEqual(expect.arrayContaining(tenants.map((t) => t.id)));
      expect(ids).not.toContain(resting.id);
      expect(ids).toEqual([...ids].sort());
    } finally {
      // Closed once; a second close does nothing (the worker's shutdown and
      // the application's both may ask).
      await registry.onModuleDestroy();
      await registry.onModuleDestroy();
    }

    // Nothing else: no other column of the directory, no table, and no
    // tenant's rows even with a tenant set.
    const { connectionString, options } = databaseConnectionOf(url);
    const client = new Client({ connectionString, options });
    await client.connect();
    try {
      const refused = async (sql: string) => {
        try {
          await client.query(sql);
          return 'read';
        } catch (error) {
          return (error as DatabaseError).code;
        }
      };
      for (const sql of [
        'SELECT slug FROM tenant_directory',
        'SELECT domain FROM tenant_directory',
        'SELECT id FROM tenants',
        'SELECT id FROM users',
        'SELECT id FROM outbox_events',
        'SELECT id FROM audit_logs',
      ]) {
        expect([sql, await refused(sql)]).toEqual([
          sql,
          INSUFFICIENT_PRIVILEGE,
        ]);
      }
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [
        tenants[0].id,
      ]);
      expect(await refused('SELECT id FROM players')).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    } finally {
      await client.end();
    }

    // As the catalog holds it: SELECT on two columns of one view, and no
    // right on any relation; no role attribute past the runtime role's.
    const owner = new Client(
      databaseConnectionOf(inject('migrationDatabaseUrl')),
    );
    await owner.connect();
    try {
      const { rows: columns } = await owner.query<{
        relation: string;
        column: string;
        privilege: string;
      }>(
        `SELECT table_name AS relation, column_name AS column, privilege_type AS privilege
           FROM information_schema.column_privileges
          WHERE grantee = 'sadara_registry' AND table_schema = current_schema()
          ORDER BY 1, 2`,
      );
      expect(columns).toEqual([
        { relation: 'tenant_directory', column: 'id', privilege: 'SELECT' },
        {
          relation: 'tenant_directory',
          column: 'is_active',
          privilege: 'SELECT',
        },
      ]);
      const { rows: relations } = await owner.query<{ relation: string }>(
        `SELECT c.relname AS relation FROM pg_class c
          WHERE c.relnamespace = current_schema()::regnamespace
            AND c.relkind IN ('r', 'v', 'm', 'p')
            AND has_table_privilege('sadara_registry', c.oid,
                  'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
      );
      expect(relations).toEqual([]);
      const { rows: role } = await owner.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit
           FROM pg_roles WHERE rolname = 'sadara_registry'`,
      );
      expect(role).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolinherit: false,
        },
      ]);
    } finally {
      await owner.end();
    }
  });

  it('a_job_runs_only_in_its_own_tenant', async () => {
    const { tenants, owners } = await pair();
    const { queue, relay } = pipeline(tenants);
    const consumer = new Recording('test.recording');
    worker(queue, [consumer]);

    // One event in each tenant, relayed and run: each in its own tenant.
    const [a, b] = [await enqueued(owners[0]), await enqueued(owners[1])];
    expect(await relay.relayOnce()).toMatchObject({ claimed: 2, published: 2 });
    await until(() => consumer.calls.length === 2);
    expect(
      consumer.calls
        .map(({ ctx, event }) => [event.id, event.tenantId, ctx.tenantId])
        .sort(),
    ).toEqual(
      [
        [a, tenants[0].id, tenants[0].id],
        [b, tenants[1].id, tenants[1].id],
      ].sort(),
    );
    expect([
      await effectsOf(tenants[0], a),
      await effectsOf(tenants[1], b),
    ]).toEqual([1, 1]);
    // The job ran as the system doing the delivery, in the request it was enqueued in.
    const [call] = consumer.calls.filter(({ event }) => event.id === a);
    expect(call.ctx.actor).toEqual({ kind: 'SYSTEM', job: 'outbox:deliver' });
    expect(call.ctx.requestId).toBe((await eventOf(tenants[0], a)).requestId);

    // A job naming the other tenant, with this tenant's event: it finds
    // nothing, runs nothing, is never retried, and changes nothing.
    const forged = await enqueued(owners[0]);
    await queue.add(
      'invitation.created',
      {
        tenantId: tenants[1].id,
        eventId: forged,
        correlation: { requestId: null },
      },
      { jobId: `forged-${forged}`, attempts: 3 },
    );
    await until(
      async () => (await queue.getJobState(`forged-${forged}`)) === 'failed',
    );
    const job = await queue.getJob(`forged-${forged}`);
    expect([job?.attemptsMade, job?.failedReason]).toEqual([
      1,
      'outbox job refused: its tenant holds no such event',
    ]);
    expect(consumer.calls.map(({ event }) => event.id)).not.toContain(forged);
    expect(await eventOf(tenants[0], forged)).toMatchObject({
      status: 'CREATED',
      attempts: 0,
      lastErrorCode: null,
    });
    expect(await effectsOf(tenants[1], forged)).toBe(0);
  });

  it('retries_stop_at_the_bound_and_mark_dead', async () => {
    const { tenants, owners } = await pair();
    const { queue, relay } = pipeline(tenants, QUICK);
    const attempts = new Map<string, number>();
    const failing = new Recording('test.failing', (_tx, event) => {
      attempts.set(event.id, (attempts.get(event.id) ?? 0) + 1);
      return Promise.reject(
        new DependencyUnavailableError('the provider did not answer'),
      );
    });
    worker(queue, [failing]);
    for (const [i, tenant] of tenants.entries()) {
      const id = await enqueued(owners[i]);
      await relay.relayOnce();
      await until(async () => (await eventOf(tenant, id)).status === 'DEAD');
      // Three tries, the bound, and none after it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(attempts.get(id)).toBe(QUICK.attempts);
      expect(await eventOf(tenant, id)).toMatchObject({
        status: 'DEAD',
        attempts: QUICK.attempts,
        lastErrorCode: 'dependency_unavailable',
        dispatchedAt: expect.any(Date) as Date,
        leaseOwner: null,
        leaseUntil: null,
      });
      // Every failed try rolled its receipt and its effect back.
      expect(await effectsOf(tenant, id)).toBe(0);
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.consumerInbox.count({ where: { eventId: id } }),
        ),
      ).toBe(0);
    }
  });

  it('a_crashed_worker_redelivers_and_the_handler_stays_idempotent', async () => {
    const { tenants, owners } = await pair();
    for (const [i, tenant] of tenants.entries()) {
      const { queue, relay } = pipeline([tenant]);
      const consumer = new Recording('test.idempotent');
      const handler = new OutboxJobHandler(
        runPrisma(),
        new ConsumerInboxes(),
        [consumer],
        logger,
      );
      // A worker that commits the effect and dies before it acknowledges the
      // job: its lock is never renewed, and the job is left running.
      let effectCommitted = false;
      const doomed = new Worker(
        queue.name,
        async (job: Job) => {
          await handler.handle(job);
          effectCommitted = true;
          await new Promise(() => undefined);
        },
        { connection, lockDuration: 1_000, stalledInterval: 300 },
      );
      const id = await enqueued(owners[i]);
      await relay.relayOnce();
      await until(() => effectCommitted);
      await doomed.close(true);
      expect(await effectsOf(tenant, id)).toBe(1);

      // Another worker finds the job its lock let go, and runs it again: the
      // receipt is there, so the effect is not committed twice.
      worker(queue, [consumer], {
        lockDurationMs: 1_000,
        stalledIntervalMs: 300,
      });
      await until(async () => (await queue.getJobState(id)) === 'completed');
      expect(
        consumer.calls.filter(({ event }) => event.id === id),
      ).toHaveLength(1);
      expect(await effectsOf(tenant, id)).toBe(1);
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.consumerInbox.findMany({
            where: { eventId: id },
            select: { consumer: true },
          }),
        ),
      ).toEqual([{ consumer: 'test.idempotent' }]);
    }
  });

  it('two_relays_claim_each_event_once', async () => {
    const { tenants, owners } = await pair();
    // Two relays at once, over the same tenants: SKIP LOCKED gives each
    // event to one of them.
    const published: string[] = [];
    const counting = {
      publish: (event: { id: string }) => {
        published.push(event.id);
        return Promise.resolve();
      },
    };
    const relays = [0, 1].map(
      (n) =>
        new OutboxRelay(
          { activeTenantIds: () => Promise.resolve(tenants.map((t) => t.id)) },
          runPrisma(),
          counting,
          { batch: 100, leaseSeconds: 60, owner: `relay-${n}` },
        ),
    );
    const ids: Array<[Tenant, string]> = [];
    for (const [i, tenant] of tenants.entries()) {
      for (let n = 0; n < 5; n += 1)
        ids.push([tenant, await enqueued(owners[i])]);
    }
    await Promise.all(relays.map((relay) => relay.relayOnce()));
    const mine = published.filter((id) => ids.some(([, own]) => own === id));
    expect(mine.sort()).toEqual(ids.map(([, id]) => id).sort());
    for (const [tenant, id] of ids) {
      expect(await eventOf(tenant, id)).toMatchObject({
        status: 'PUBLISHED',
        leaseOwner: null,
      });
    }
  });

  it('an_expired_lease_is_claimed_again', async () => {
    const { tenants, owners } = await pair();
    // A relay claims and dies before publishing: its events stay LEASED.
    const id = await enqueued(owners[0]);
    const dying = new OutboxRelay(
      { activeTenantIds: () => Promise.resolve([tenants[0].id]) },
      runPrisma(),
      { publish: () => Promise.reject(new DependencyUnavailableError('down')) },
      { batch: 100, leaseSeconds: 1, owner: 'dying' },
    );
    await dying.relayOnce();
    const leased = await eventOf(tenants[0], id);
    expect(leased).toMatchObject({ status: 'LEASED' });
    expect(leased.leaseOwner).toMatch(/^dying:/);

    // Before the lease runs out nobody takes it; after, the next relay does.
    const published: string[] = [];
    const next = new OutboxRelay(
      { activeTenantIds: () => Promise.resolve([tenants[0].id]) },
      runPrisma(),
      {
        publish: (event: { id: string }) => {
          published.push(event.id);
          return Promise.resolve();
        },
      },
      { batch: 100, leaseSeconds: 60, owner: 'next' },
    );
    await next.relayOnce();
    expect(published).not.toContain(id);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await next.relayOnce();
    expect(published).toContain(id);
    expect(await eventOf(tenants[0], id)).toMatchObject({
      status: 'PUBLISHED',
      leaseOwner: null,
    });
  });

  it('shutdown_drains_in_flight_jobs', async () => {
    const { tenants, owners } = await pair();
    const { queue, relay } = pipeline(tenants);
    let started = false;
    const slow = new Recording('test.slow', async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const running = worker(queue, [slow]);
    const id = await enqueued(owners[1]);
    await relay.relayOnce();
    await until(() => started);
    // Closing waits for the job under way, which commits.
    await running.close();
    expect(await queue.getJobState(id)).toBe('completed');
    expect(await effectsOf(tenants[1], id)).toBe(1);
  });
});
