import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Player, Tenant, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
} from '../harness/fixtures';
import { signedInAs } from '../harness/session';

// The existing modules on the tenant transaction (0.4.12; SYS-TEN-003): users,
// medical and scouting reach the database only through
// withTenantTransaction(ctx, …), with the tenant of the verified context,
// never one a caller passes. The quarantined modules are switched on before
// AppModule loads. Two tenants, every value synthetic.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

const API = '/api/v1';
const MODULES = ['users', 'medical', 'scouting'];

/** Every TypeScript file under a module, by path. */
function sourcesOf(module: string): Array<[string, string]> {
  const root = join(__dirname, '../../src/modules', module);
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .map((path) => [
      `${module}/${path}`,
      readFileSync(join(root, path), 'utf8'),
    ]);
}

const ids = (body: unknown) =>
  (body as { data: Array<{ id: string }> }).data.map(({ id }) => id).sort();

describe('the existing modules on the tenant transaction', () => {
  let booted: BootedApp;
  let a: Tenant;
  let b: Tenant;
  let memberA: User;
  let memberB: User;
  let playerA: Player;
  let playerB: Player;

  beforeAll(async () => {
    booted = await bootApp();
    [a, b] = [await createTenant(), await createTenant()];
    [memberA, memberB] = [
      await createMember(a, 'MEDICAL'),
      await createMember(b, 'MEDICAL'),
    ];
    [playerA, playerB] = [await createPlayer(a), await createPlayer(b)];
    // Every permission: what is under test is the tenant, not the role.
    vi.spyOn(PermissionService.prototype, 'hasPermission').mockResolvedValue(
      true,
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await booted?.app.close();
  });

  it('medical_reads_see_only_the_context_tenant', async () => {
    const record = (
      tenant: Tenant,
      member: User,
      player: Player,
      deletedAt?: Date,
    ) =>
      asTenant(tenant.id, (tx) =>
        tx.medicalRecord.create({
          data: {
            tenantId: tenant.id,
            playerId: player.id,
            createdById: member.id,
            injuryType: 'Test injury',
            deletedAt,
          },
        }),
      );
    const liveA = await record(a, memberA, playerA);
    const archivedA = await record(a, memberA, playerA, new Date());
    const ofB = await record(b, memberB, playerB);
    const sessionB = await asTenant(b.id, (tx) =>
      tx.treatmentSession.create({
        data: {
          tenantId: b.id,
          playerId: playerB.id,
          medicalRecordId: ofB.id,
          conductedBy: memberB.id,
          sessionDate: new Date('2026-11-20T00:00:00Z'),
          treatmentType: 'Physiotherapy',
        },
      }),
    );
    const asA = await signedInAs(memberA);
    const get = (path: string) => booted.http.get(`${API}${path}`).set(asA);

    // Lists: A's live records only, never B's, never an archived one.
    expect(ids((await get('/medical/records')).body)).toEqual([liveA.id]);
    expect(
      ids((await get(`/medical/records/player/${playerA.id}`)).body),
    ).toEqual([liveA.id]);
    expect(
      (await get(`/medical/records/player/${playerA.id}/history`)).body,
    ).toMatchObject({ data: { total: 1 } });

    // By id: B's player, record and session, and A's archived record, are
    // not found (B's player since 0.6.9: a foreign id is never served).
    for (const path of [
      `/medical/records/player/${playerB.id}`,
      `/medical/sessions/player/${playerB.id}`,
      `/medical/records/${ofB.id}`,
      `/medical/records/${archivedA.id}`,
      `/medical/sessions/${sessionB.id}`,
    ]) {
      const response = await get(path);
      expect([path, response.status]).toEqual([path, 404]);
    }
    expect((await get(`/medical/records/${liveA.id}`)).body).toMatchObject({
      data: { id: liveA.id },
    });

    // Nor can A change or archive B's record: it is not found, and stays.
    expect(
      (
        await booted.http
          .patch(`${API}/medical/records/${ofB.id}`)
          .set(asA)
          .send({ severity: 'Severe' })
      ).status,
    ).toBe(404);
    expect(
      (await booted.http.delete(`${API}/medical/records/${ofB.id}`).set(asA))
        .status,
    ).toBe(404);
    expect(
      await asTenant(b.id, (tx) =>
        tx.medicalRecord.findUniqueOrThrow({
          where: { id: ofB.id },
          select: { severity: true, deletedAt: true },
        }),
      ),
    ).toEqual({ severity: null, deletedAt: null });

    // And B, signed in, sees its own record and none of A's.
    expect(
      ids(
        (
          await booted.http
            .get(`${API}/medical/records`)
            .set(await signedInAs(memberB))
        ).body,
      ),
    ).toEqual([ofB.id]);
  });

  it('scouting_writes_are_stamped_with_the_context_tenant', async () => {
    const scoutA = await createMember(a, 'SCOUT');
    const asScoutA = await signedInAs(scoutA);
    const post = (path: string, body: object) =>
      booted.http.post(`${API}${path}`).set(asScoutA).send(body);

    // A report recommending a signing: the context's tenant and member are
    // the report's, and its automatic watchlist entry's, in one transaction.
    const created = await post('/scouting/reports', {
      playerId: playerA.id,
      recommendation: 'SIGN',
      technicalScore: 7,
    });
    expect(created.status).toBe(201);
    const reportId = (created.body as { data: { id: string } }).data.id;
    const assignment = await post('/scouting/assignments', {
      assignedToId: scoutA.id,
      region: 'Levant',
    });
    expect(assignment.status).toBe(201);
    const assignmentId = (assignment.body as { data: { id: string } }).data.id;

    const written = await asTenant(a.id, async (tx) => ({
      report: await tx.scoutingReport.findUniqueOrThrow({
        where: { id: reportId },
        select: { tenantId: true, scoutId: true, status: true },
      }),
      watchlist: await tx.playerWatchlist.findMany({
        where: { userId: scoutA.id },
        select: { tenantId: true, playerId: true, priority: true },
      }),
      assignment: await tx.scoutingAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: { tenantId: true, assignedById: true },
      }),
    }));
    expect(written).toEqual({
      report: { tenantId: a.id, scoutId: scoutA.id, status: 'DRAFT' },
      watchlist: [{ tenantId: a.id, playerId: playerA.id, priority: 'HIGH' }],
      assignment: { tenantId: a.id, assignedById: scoutA.id },
    });

    // A tenant in the body is refused; another tenant's player is not found
    // (0.6.9), and the report's key to it carries the context's tenant too.
    expect(
      (
        await post('/scouting/reports', {
          playerId: playerA.id,
          tenantId: b.id,
        })
      ).status,
    ).toBe(400);
    const crossing = await post('/scouting/reports', {
      playerId: playerB.id,
    });
    expect(crossing.status).toBe(404);
    expect(
      await asTenant(b.id, (tx) =>
        tx.scoutingReport.count({ where: { playerId: playerB.id } }),
      ),
    ).toBe(0);

    // Archived, the report leaves every ordinary read.
    expect(
      (
        await booted.http
          .delete(`${API}/scouting/reports/${reportId}`)
          .set(asScoutA)
      ).status,
    ).toBe(200);
    expect(
      ids(
        (await booted.http.get(`${API}/scouting/reports`).set(asScoutA)).body,
      ),
    ).not.toContain(reportId);
    expect(
      (
        await booted.http
          .get(`${API}/scouting/reports/${reportId}`)
          .set(asScoutA)
      ).status,
    ).toBe(404);

    // B sees none of it.
    const asB = await signedInAs(memberB);
    expect(
      ids((await booted.http.get(`${API}/scouting/reports`).set(asB)).body),
    ).toEqual([]);
    expect(
      (await booted.http.get(`${API}/scouting/watchlist`).set(asB)).body,
    ).toEqual({ data: [] });
  });

  it('no_module_repository_takes_a_tenant_id', () => {
    const sources = MODULES.flatMap(sourcesOf);
    // No module names a tenant id but its context's, or reaches the root
    // client: the database is withTenantTransaction's (0.4.3).
    expect(
      sources
        .filter(([, text]) => /\btenantId\??\s*:\s*string\b/.test(text))
        .map(([path]) => path),
    ).toEqual([]);
    expect(
      sources
        .filter(([, text]) =>
          /infrastructure\/prisma\/prisma\.service/.test(text),
        )
        .map(([path]) => path),
    ).toEqual([]);

    // Every repository method takes the transaction and the context first,
    // and still names the context's tenant in its predicate: row-level
    // security is the backstop, not the only filter.
    // The one exception reads reference data that belongs to no tenant —
    // the permission matrix (0.6.1) — so it has no tenant to name; it still
    // reads inside the caller's tenant transaction.
    const REFERENCE = 'permission.repository.ts';
    const reference = sources.filter(
      ([path]) => path.includes('/repositories/') && path.endsWith(REFERENCE),
    );
    expect(reference.map(([path]) => path)).toEqual([
      `users/infrastructure/repositories/${REFERENCE}`,
    ]);
    for (const [, text] of reference) {
      expect(text).not.toMatch(/tenantId/);
      for (const chunk of text.split(/^ {2}async /m).slice(1)) {
        expect(/^\w+\(\s*tx: TenantTx,/.test(chunk)).toBe(true);
      }
    }
    const repositories = sources.filter(
      ([path]) => path.includes('/repositories/') && !path.endsWith(REFERENCE),
    );
    // The users module's invitations (0.5.10) are the sixth; medical's and
    // scouting's players and members (0.6.9) the seventh and eighth.
    expect(repositories.length).toBe(8);
    for (const [path, text] of repositories) {
      const methods = text
        .split(/^ {2}async /m)
        .slice(1)
        .map((chunk) => {
          const [, name, params] = /^(\w+)\(([^)]*)\)/.exec(chunk) ?? [];
          return { name, params, body: chunk };
        });
      expect(methods.length).toBeGreaterThan(0);
      for (const { name, params, body } of methods) {
        expect([
          path,
          name,
          params
            .split(',')
            .slice(0, 2)
            .map((param) => param.trim()),
          /ctx\.tenantId|this\.live\(ctx,/.test(body),
        ]).toEqual([
          path,
          name,
          ['tx: TenantTx', 'ctx: AuthorizedTenantContext'],
          true,
        ]);
      }
    }
  });
});
