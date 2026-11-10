import { randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Param, Patch, Post, Res } from '@nestjs/common';
import type { Tenant, User } from '@prisma/client';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IfMatch } from '../../src/common/concurrency/if-match.decorator';
import {
  assertChanged,
  etagOf,
  revisionToChange,
} from '../../src/common/concurrency/revision';
import { RequirePermission } from '../../src/common/decorators/permissions.decorator';
import { CurrentTenantContext } from '../../src/common/decorators/tenant-context.decorator';
import { NotFoundError } from '../../src/common/errors/domain-error';
import {
  Idempotency,
  type IdempotentCommand,
  IdempotencyInProgressError,
} from '../../src/common/idempotency/idempotency';
import {
  Idempotent,
  type IdempotentRequest,
} from '../../src/common/idempotency/idempotent-request';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import type { TenantTx } from '../../src/common/tenancy/tenant-transaction';
import { IdParams, line } from '../../src/common/validation/schemas';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  migrationPrisma,
  runPrisma,
} from '../harness/fixtures';
import { signedInAs } from '../harness/session';

// Idempotency keys for retried commands (0.7.7; I-10, SR-CORE-010), through
// HTTP, on two tenants, as the runtime role. A probe of this file stands for
// the commands clients retry: it creates and renames a fixture as a domain
// command would — its effect, a revision checked against If-Match — and
// counts every effect it commits. Values are synthetic.

const FIXTURE_TABLES = [
  `CREATE TABLE idempotency_fixture (
     id uuid PRIMARY KEY,
     tenant_id uuid NOT NULL,
     name text NOT NULL,
     revision integer NOT NULL DEFAULT 1
   )`,
  // One row per effect committed: what "one effect" is counted by.
  `CREATE TABLE idempotency_effects (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id uuid NOT NULL,
     fixture_id uuid NOT NULL,
     name text NOT NULL
   )`,
];

const PATH = '/api/v1/probe/idempotent-fixtures';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const Named = z.strictObject({ name: line(100) });
type Named = z.infer<typeof Named>;

interface Fixture {
  id: string;
  name: string;
  revision: number;
}

/** A command that stops inside its execution until the test opens it. */
function gateOf() {
  let enter!: () => void;
  let open!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return {
    entered,
    open,
    pass: async () => {
      enter();
      await Promise.race([
        opened,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    },
  };
}

let gate: ReturnType<typeof gateOf> | undefined;
/** The next execution fails after its effect, which therefore never commits. */
let crashNext = false;

class ProbeCrash extends Error {}

async function load(
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  id: string,
): Promise<Fixture> {
  const [row] = await tx.$queryRaw<Fixture[]>`
    SELECT id::text AS id, name, revision FROM idempotency_fixture
     WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid`;
  if (!row) throw new NotFoundError('No such fixture');
  return row;
}

async function effect(
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  fixture: Fixture,
) {
  await gate?.pass();
  await tx.$executeRaw`
    INSERT INTO idempotency_effects (tenant_id, fixture_id, name)
    VALUES (${ctx.tenantId}::uuid, ${fixture.id}::uuid, ${fixture.name})`;
  if (crashNext) {
    crashNext = false;
    throw new ProbeCrash('the execution died after its effect');
  }
}

/** The probe's create: a fixture and its effect, replayed from the fixture's id. */
function creating(
  ctx: AuthorizedTenantContext,
  input: Named,
): IdempotentCommand<Fixture> {
  return {
    execute: async (tx) => {
      const fixture = { id: randomUUID(), name: input.name, revision: 1 };
      await tx.$executeRaw`
        INSERT INTO idempotency_fixture (id, tenant_id, name)
        VALUES (${fixture.id}::uuid, ${ctx.tenantId}::uuid, ${fixture.name})`;
      await effect(tx, ctx, fixture);
      return { result: fixture, resultRef: fixture.id };
    },
    replay: (tx, ref) => load(tx, ctx, ref ?? ''),
  };
}

/** Test-only routes, built as a retried command is: authorized, validated, then run once. */
@Controller('probe/idempotent-fixtures')
class IdempotentFixtures {
  constructor(private readonly idempotency: Idempotency) {}

  private served(fixture: Fixture, response: Response) {
    response.setHeader('ETag', etagOf('fixture', fixture, 'full'));
    return fixture;
  }

  @RequirePermission('player.update')
  @Post()
  async create(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Idempotent() request: IdempotentRequest,
    @Body({ schema: Named }) input: Named,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.idempotency.run(
      ctx,
      request,
      input,
      creating(ctx, input),
    );
    return this.served(created, response);
  }

  @RequirePermission('player.update')
  @Patch(':id')
  async rename(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @IfMatch() ifMatch: string | undefined,
    @Idempotent() request: IdempotentRequest,
    @Body({ schema: Named }) input: Named,
    @Res({ passthrough: true }) response: Response,
  ) {
    const renamed = await this.idempotency.run(ctx, request, input, {
      // Only a first execution checks the precondition.
      execute: async (tx) => {
        const current = await load(tx, ctx, id);
        const revision = revisionToChange(ifMatch, {
          etag: etagOf('fixture', current, 'full'),
          revision: current.revision,
        });
        assertChanged(
          await tx.$executeRaw`
            UPDATE idempotency_fixture
               SET name = ${input.name}, revision = revision + 1
             WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
               AND revision = ${revision}`,
        );
        const fixture = await load(tx, ctx, id);
        await effect(tx, ctx, fixture);
        return { result: fixture, resultRef: id };
      },
      replay: (tx, ref) => load(tx, ctx, ref ?? ''),
    });
    return this.served(renamed, response);
  }
}

/** The fixture a success answered with. */
const dataOf = (response: { body: unknown }) =>
  (response.body as { data: Fixture }).data;

const key = () => `key-${randomBytes(8).toString('hex')}`;
const tag = (what: string) => `${what} ${randomBytes(3).toString('hex')}`;

/** How many effects named `name` committed, in any tenant. */
async function effectsNamed(name: string): Promise<number> {
  const [{ count }] = await runPrisma().$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM idempotency_effects WHERE name = ${name}`;
  return count;
}

/** The idempotency records of `member`, as their tenant reads them. */
function recordsOf(member: User) {
  return asTenant(member.tenantId, (tx) =>
    tx.idempotencyRecord.findMany({
      where: { actorUserId: member.id },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

describe('idempotency keys for retried commands', () => {
  let booted: BootedApp;
  let tenants: Tenant[];
  let admins: User[];
  let colleague: User;
  const headers = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    for (const ddl of FIXTURE_TABLES) {
      await migrationPrisma().$executeRawUnsafe(ddl);
    }
    booted = await bootApp({ controllers: [IdempotentFixtures] });
    tenants = [await createTenant(), await createTenant()];
    admins = [
      await createMember(tenants[0], 'ADMIN'),
      await createMember(tenants[1], 'ADMIN'),
    ];
    colleague = await createMember(tenants[0], 'ADMIN');
    for (const member of [...admins, colleague]) {
      headers.set(member.id, await signedInAs(member));
    }
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  const create = (member: User, idempotencyKey: string | null, body: Named) => {
    const request = booted.http.post(PATH).set(headers.get(member.id)!);
    if (idempotencyKey !== null) request.set('Idempotency-Key', idempotencyKey);
    return request.send(body);
  };

  const rename = (
    member: User,
    id: string,
    ifMatch: string,
    idempotencyKey: string,
    body: Named,
  ) =>
    booted.http
      .patch(`${PATH}/${id}`)
      .set(headers.get(member.id)!)
      .set('If-Match', ifMatch)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);

  it('a_replayed_command_has_one_effect', async () => {
    const [admin] = admins;
    const name = tag('Replayed');
    const k = key();
    const first = await create(admin, k, { name });
    expect(first.status).toBe(201);
    const { id } = dataOf(first);

    // Retried — after a lost answer, at once, and again: one effect.
    for (const retry of [
      await create(admin, k, { name }),
      ...(await Promise.all([
        create(admin, k, { name }),
        create(admin, k, { name }),
      ])),
    ]) {
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers.etag).toBe(first.headers.etag);
    }
    const last = await create(admin, k, { name });
    expect(last.status).toBe(201);
    expect(last.body).toEqual(first.body);
    expect(await effectsNamed(name)).toBe(1);

    // The record keeps hashes and the outcome's id: no key, no body.
    const [record] = (await recordsOf(admin)).filter((r) => r.resultRef === id);
    expect(record.id).toMatch(UUID_V7);
    expect(record).toMatchObject({
      tenantId: admin.tenantId,
      method: 'POST',
      canonicalPath: PATH,
      state: 'SUCCEEDED',
      fencingGeneration: 1,
      leaseUntil: null,
      outcomeCode: null,
    });
    expect(record.keyHash).toHaveLength(32);
    expect(record.requestHash).toHaveLength(32);
    expect(Buffer.from(record.keyHash).toString()).not.toContain(k);
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBe(
      24 * 3_600_000,
    );
  });

  it('a_reused_key_with_a_different_body_conflicts', async () => {
    const [admin] = admins;
    const name = tag('First');
    const k = key();
    expect((await create(admin, k, { name })).status).toBe(201);

    const other = tag('Other');
    const reused = await create(admin, k, { name: other });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(reused.headers['retry-after']).toBeUndefined();
    expect(await effectsNamed(name)).toBe(1);
    expect(await effectsNamed(other)).toBe(0);
  });

  it('a_concurrent_duplicate_is_refused_while_in_progress', async () => {
    const [admin] = admins;
    const name = tag('Concurrent');
    const k = key();
    gate = gateOf();
    try {
      const first = create(admin, k, { name }).then((response) => response);
      await gate.entered; // the first is executing, its record locked
      const duplicate = await create(admin, k, { name });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
      expect(duplicate.headers['retry-after']).toBe('1');
      expect(await effectsNamed(name)).toBe(0);

      gate.open();
      const done = await first;
      expect(done.status).toBe(201);
      const retried = await create(admin, k, { name });
      expect(retried.status).toBe(201);
      expect(retried.body).toEqual(done.body);
      expect(await effectsNamed(name)).toBe(1);
    } finally {
      gate = undefined;
    }
  });

  it('a_stale_lease_is_recovered_without_a_second_effect', async () => {
    const [admin] = admins;
    const idempotency = booted.app.get(Idempotency);
    const name = tag('Stale');
    const k = key();
    const ctx = memberContext(admin);
    const request: IdempotentRequest = {
      key: k,
      method: 'POST',
      canonicalPath: PATH,
    };

    // An execution claims the key, then dies before committing anything.
    const stale = await idempotency.claim(ctx, request, { name });
    expect(stale).toMatchObject({ kind: 'execute', generation: 1 });
    if (stale.kind !== 'execute') return expect.unreachable();

    // While its lease holds, a retry is told to wait.
    const waiting = await create(admin, k, { name });
    expect(waiting.status).toBe(409);
    expect(waiting.body).toMatchObject({ code: 'IDEMPOTENCY_IN_PROGRESS' });

    // Its lease runs out: the retry takes the claim over, and executes.
    await asTenant(
      admin.tenantId,
      (tx) =>
        tx.$executeRaw`
        UPDATE idempotency_records SET lease_until = now() - interval '1 second'
         WHERE id = ${stale.id}::uuid`,
    );
    const recovered = await create(admin, k, { name });
    expect(recovered.status).toBe(201);
    expect(await effectsNamed(name)).toBe(1);

    // The execution that held the old lease comes back: it cannot commit.
    await expect(
      idempotency.complete(ctx, stale, creating(ctx, { name })),
    ).rejects.toThrow(IdempotencyInProgressError);
    expect(await effectsNamed(name)).toBe(1);

    const [record] = (await recordsOf(admin)).filter((r) => r.id === stale.id);
    expect(record).toMatchObject({
      state: 'SUCCEEDED',
      fencingGeneration: 2,
      resultRef: dataOf(recovered).id,
    });
    const replayed = await create(admin, k, { name });
    expect(replayed.status).toBe(201);
    expect(replayed.body).toEqual(recovered.body);

    // And while the claim that took it over is still executing, the old
    // holder comes back first: its generation is no longer the record's.
    const later = tag('Taken over');
    const other: IdempotentRequest = { ...request, key: key() };
    const old = await idempotency.claim(ctx, other, { name: later });
    if (old.kind !== 'execute') return expect.unreachable();
    await asTenant(
      admin.tenantId,
      (tx) =>
        tx.$executeRaw`
        UPDATE idempotency_records SET lease_until = now() - interval '1 second'
         WHERE id = ${old.id}::uuid`,
    );
    const taker = await idempotency.claim(ctx, other, { name: later });
    expect(taker).toMatchObject({ kind: 'execute', id: old.id, generation: 2 });
    if (taker.kind !== 'execute') return expect.unreachable();
    await expect(
      idempotency.complete(ctx, old, creating(ctx, { name: later })),
    ).rejects.toThrow(IdempotencyInProgressError);
    expect(await effectsNamed(later)).toBe(0);
    const made = await idempotency.complete(
      ctx,
      taker,
      creating(ctx, { name: later }),
    );
    expect(await effectsNamed(later)).toBe(1);
    const again = await create(admin, other.key, { name: later });
    expect(again.status).toBe(201);
    expect(dataOf(again)).toEqual(made);
  });

  it('a_replay_succeeds_despite_its_stale_original_if_match', async () => {
    const [admin] = admins;
    const created = await create(admin, key(), { name: tag('Original') });
    const { id } = dataOf(created);
    const original = created.headers.etag;

    const name = tag('Renamed');
    const k = key();
    const first = await rename(admin, id, original, k, { name });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ data: { name, revision: 2 } });

    // The retry carries the If-Match the first success made stale: it is
    // still the same request, answered as the first was.
    const retried = await rename(admin, id, original, k, { name });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(first.body);
    expect(retried.headers.etag).toBe(first.headers.etag);
    expect(await effectsNamed(name)).toBe(1);

    // The precondition is part of the request: the key with the current tag
    // is another request.
    const current = await rename(admin, id, first.headers.etag, k, {
      name,
    });
    expect(current.status).toBe(409);
    expect(current.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    // A new request with that tag is a new execution, and it is stale.
    const again = await rename(admin, id, original, key(), { name });
    expect(again.status).toBe(412);
    expect(again.body).toMatchObject({ code: 'REVISION_MISMATCH' });
    expect(await effectsNamed(name)).toBe(1);
  });

  it('a_refusal_is_answered_again_without_a_second_execution', async () => {
    const [admin] = admins;
    const created = await create(admin, key(), { name: tag('Kept') });
    const { id } = dataOf(created);
    const stale = etagOf('fixture', { id, revision: 0 }, 'full');
    const name = tag('Refused');
    const k = key();
    const refused = await rename(admin, id, stale, k, { name });
    expect(refused.status).toBe(412);

    // Even once the tag would be current, the key answers its refusal.
    await runPrisma().$executeRaw`
      UPDATE idempotency_fixture SET revision = 0 WHERE id = ${id}::uuid`;
    const retried = await rename(admin, id, stale, k, { name });
    expect(retried.status).toBe(412);
    expect(retried.body).toMatchObject({ code: 'REVISION_MISMATCH' });
    expect(await effectsNamed(name)).toBe(0);
    const [record] = (await recordsOf(admin)).filter(
      (r) => r.canonicalPath === `${PATH}/${id}` && r.state === 'REJECTED',
    );
    expect(record).toMatchObject({
      outcomeCode: 'REVISION_MISMATCH',
      resultRef: null,
      leaseUntil: null,
    });
  });

  it('a_failure_that_commits_nothing_frees_the_key_for_its_retry', async () => {
    const [admin] = admins;
    const name = tag('Crashed');
    const k = key();
    crashNext = true;
    const crashed = await create(admin, k, { name });
    expect(crashed.status).toBe(500);
    expect(await effectsNamed(name)).toBe(0);

    // Nothing committed, so the retry executes at once — no lease to wait out.
    const retried = await create(admin, k, { name });
    expect(retried.status).toBe(201);
    expect(await effectsNamed(name)).toBe(1);
  });

  it('a_key_belongs_to_its_member_its_tenant_and_its_route', async () => {
    const [admin, northwind] = admins;
    const name = tag('Shared key');
    const k = key();
    const mine = await create(admin, k, { name });
    expect(mine.status).toBe(201);
    // The same key, from a colleague and from another tenant's member: each
    // their own command.
    for (const member of [colleague, northwind]) {
      const theirs = await create(member, k, { name });
      expect(theirs.status).toBe(201);
      expect(dataOf(theirs).id).not.toBe(dataOf(mine).id);
    }
    // And on another route: another command.
    const renamed = await rename(admin, dataOf(mine).id, mine.headers.etag, k, {
      name,
    });
    expect(renamed.status).toBe(200);
    expect(await effectsNamed(name)).toBe(4);

    // Each tenant reads its own records only.
    const seen = await Promise.all(
      tenants.map((tenant) =>
        asTenant(tenant.id, (tx) =>
          tx.idempotencyRecord.findMany({ select: { tenantId: true } }),
        ),
      ),
    );
    seen.forEach((records, n) => {
      expect(records.length).toBeGreaterThan(0);
      expect(new Set(records.map((r) => r.tenantId))).toEqual(
        new Set([tenants[n].id]),
      );
    });
  });

  it('a_command_without_a_valid_key_is_refused', async () => {
    const [admin] = admins;
    const name = tag('Keyless');
    const before = (await recordsOf(admin)).length;
    for (const k of [null, '', 'x'.repeat(129), 'two words']) {
      const refused = await create(admin, k, { name });
      expect([k, refused.status]).toEqual([k, 400]);
      expect(refused.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await effectsNamed(name)).toBe(0);
    expect(await recordsOf(admin)).toHaveLength(before);
  });

  it('an_expired_key_is_free_again', async () => {
    const [admin] = admins;
    const k = key();
    const first = await create(admin, k, { name: tag('Before') });
    await asTenant(
      admin.tenantId,
      (tx) =>
        tx.$executeRaw`
        UPDATE idempotency_records
           SET created_at = now() - interval '25 hours',
               completed_at = now() - interval '25 hours',
               expires_at = now() - interval '1 hour'
         WHERE actor_user_id = ${admin.id}::uuid
           AND result_ref = ${dataOf(first).id}::uuid`,
    );
    // Past its retention, the key answers nothing: another body is a new command.
    const name = tag('After');
    const reused = await create(admin, k, { name });
    expect(reused.status).toBe(201);
    expect(dataOf(reused).id).not.toBe(dataOf(first).id);
    expect(await effectsNamed(name)).toBe(1);
  });

  it('a_replay_is_authorized_again', async () => {
    const member = await createMember(tenants[0], 'ADMIN');
    headers.set(member.id, await signedInAs(member));
    const name = tag('Authorized');
    const k = key();
    expect((await create(member, k, { name })).status).toBe(201);

    // The member loses the permission: their retry is refused before the
    // record answers it.
    await asTenant(member.tenantId, (tx) =>
      tx.user.update({ where: { id: member.id }, data: { role: 'SCOUT' } }),
    );
    const retried = await create(member, k, { name });
    expect(retried.status).toBe(403);
    expect(retried.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(retried.body).not.toHaveProperty('data');
    expect(await effectsNamed(name)).toBe(1);
  });
});
