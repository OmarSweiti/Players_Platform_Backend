import { randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { Reflector } from '@nestjs/core';
import type { Tenant, User, UserRole } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  declaredAccess,
  type RouteAccess,
} from '../../src/common/authz/route-access';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  DEFAULT_ROLE_MATRIX,
  type RoleName,
} from '../../src/modules/users/domain/default-role-matrix';
import type { PermissionKey } from '../../src/modules/users/domain/permission-catalog';
import { normalizeEmail } from '../../src/modules/users/domain/email';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
} from '../harness/fixtures';
import {
  type ObjectStoreSettings,
  testStoreClient,
} from '../harness/object-store';
import {
  controllersOf,
  type Method,
  type Route,
  routesOf,
} from '../harness/routes';
import { signedInAs } from '../harness/session';
import {
  type Actor,
  type Call,
  type Entry,
  type Objects,
  type Probe,
  ROUTE_INVENTORY,
} from './route-inventory';

// The two-tenant isolation suite (0.6.9; SR-NFR-SEC-003, TEST-003). Every
// route the app serves, read from its controllers with the medical and
// scouting modules switched on, is in the inventory (route-inventory.ts).
// Each route that names an object is called with tenant B's object as every
// role of tenant A: the answer is 404, or 403 for a role without the route's
// permission — never a success — and nothing of B changes. Lists, counts and
// searches never carry B's rows, whatever they are asked to filter by. Each
// probe has a control: the same request with A's own objects succeeds for a
// member allowed to make it, so a refusal is the tenant's, not a broken
// request's. A smuggle pairs the caller's own object with B's, and changes
// neither. Each answer is a soft assertion: one run names every route that
// fails.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

type Role = Exclude<UserRole, 'SUPER_ADMIN'>;
/** Every tenant role; SUPER_ADMIN holds no membership (0.6.7). */
const ROLES = (Object.keys(DEFAULT_ROLE_MATRIX) as RoleName[]).filter(
  (role): role is Role => role !== 'SUPER_ADMIN',
);
const holds = (role: Role, permission: PermissionKey) =>
  (DEFAULT_ROLE_MATRIX[role] as readonly PermissionKey[]).includes(permission);

const suffix = () => randomBytes(4).toString('hex');
/** The PDF a seeded upload carries: its signature, then filler. */
const UPLOADED_PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  randomBytes(1015),
]);
const DAY_MS = 24 * 3_600_000;
const UNDEFINED_TABLE = '42P01';

interface Seeded {
  readonly objects: Objects;
  readonly actors: Readonly<Record<Actor, User>>;
}

type Served = Route & { key: string; access: RouteAccess; entry?: Entry };

/** A route's template as a pattern its probes' paths must match. */
const patternOf = (template: string) =>
  new RegExp(`^${template.replace(/:\w+/g, '[^/?]+')}(\\?.*)?$`);

describe('two-tenant isolation over every route', () => {
  let booted: BootedApp;
  let owner: Client;
  let routes: Served[];
  let a: Tenant;
  let b: Tenant;
  /** B's objects: what every probe names. */
  let foreign: Seeded;
  /** A's objects, for the reads' controls. */
  let readable: Seeded | undefined;
  const members = new Map<Role, User>();
  const sessions = new Map<Role, Record<string, string>>();
  /** The object store uploads send to (0.8.3), and a client that writes to it. */
  let store: ObjectStoreSettings;
  let storeClient: S3Client;

  /** A tenant's objects, every one a route can name, and their makers. */
  async function seed(tenant: Tenant): Promise<Seeded> {
    const actors = {
      owner: await createMember(tenant, 'OWNER'),
      director: await createMember(tenant, 'SPORTING_DIRECTOR'),
      scout: await createMember(tenant, 'SCOUT'),
      medic: await createMember(tenant, 'MEDICAL'),
    };
    const [player, bench] = [
      await createPlayer(tenant),
      await createPlayer(tenant),
    ];
    const email = `invitee-${suffix()}@${tenant.slug}.test`;
    const rows = await asTenant(tenant.id, async (tx) => {
      const tenantId = tenant.id;
      const record = await tx.medicalRecord.create({
        data: {
          tenantId,
          playerId: player.id,
          createdById: actors.medic.id,
          injuryType: 'Hamstring strain',
        },
      });
      const session = await tx.treatmentSession.create({
        data: {
          tenantId,
          playerId: player.id,
          medicalRecordId: record.id,
          conductedBy: actors.medic.id,
          sessionDate: new Date(Date.now() + 30 * DAY_MS),
          treatmentType: 'Physiotherapy',
        },
      });
      const report = (status: 'DRAFT' | 'SUBMITTED') =>
        tx.scoutingReport.create({
          data: {
            tenantId,
            scoutId: actors.scout.id,
            playerId: player.id,
            reportDate: new Date('2026-11-01T00:00:00Z'),
            status,
            // What a submission needs.
            overallRating: 7,
            strengths: 'Pace and first touch',
            weaknesses: 'Aerial duels',
          },
        });
      const [draft, submitted] = [
        await report('DRAFT'),
        await report('SUBMITTED'),
      ];
      const assignment = await tx.scoutingAssignment.create({
        data: {
          tenantId,
          assignedToId: actors.scout.id,
          assignedById: actors.director.id,
        },
      });
      await tx.playerWatchlist.create({
        data: { tenantId, userId: actors.scout.id, playerId: player.id },
      });
      const invitation = await tx.invitation.create({
        data: {
          tenantId,
          email,
          normalizedEmail: normalizeEmail(email),
          role: 'COACH',
          locale: 'en',
          invitedById: actors.owner.id,
          expiresAt: new Date(Date.now() + 7 * DAY_MS),
        },
      });
      // An open upload by the scout, for the player (0.8.3), its PDF arrived.
      const quarantineKey = `tenants/${tenantId}/quarantine/${randomUUID()}`;
      const file = await tx.fileObject.create({
        data: {
          tenantId,
          quarantineKey,
          sizeBytes: BigInt(UPLOADED_PDF.length),
          mimeType: 'application/pdf',
          originalName: 'contract.pdf',
          status: 'UPLOADING',
          classification: 'OPERATIONAL',
          createdById: actors.scout.id,
        },
      });
      const upload = await tx.uploadSession.create({
        data: {
          tenantId,
          fileObjectId: file.id,
          createdById: actors.scout.id,
          declaredSize: BigInt(UPLOADED_PDF.length),
          declaredType: 'application/pdf',
          ownerKind: 'player-document',
          ownerId: player.id,
          expiresAt: new Date(Date.now() + DAY_MS / 24),
        },
      });
      return {
        record,
        session,
        draft,
        submitted,
        assignment,
        invitation,
        upload,
        quarantineKey,
      };
    });
    await storeClient.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: rows.quarantineKey,
        Body: UPLOADED_PDF,
        ContentType: 'application/pdf',
      }),
    );
    // One of the scout's sign-in sessions: what DELETE /auth/sessions/:id names.
    await signedInAs(actors.scout);
    const signIn = await asTenant(tenant.id, (tx) =>
      tx.userSession.findFirstOrThrow({
        where: { userId: actors.scout.id },
        select: { id: true },
      }),
    );
    return {
      actors,
      objects: {
        player: player.id,
        bench: bench.id,
        record: rows.record.id,
        session: rows.session.id,
        draft: rows.draft.id,
        submitted: rows.submitted.id,
        assignment: rows.assignment.id,
        scout: actors.scout.id,
        invitation: rows.invitation.id,
        upload: rows.upload.id,
        signIn: signIn.id,
      },
    };
  }

  /**
   * Every row of `tenant`, table by table, as the tables' owner reads them
   * (it reads every tenant's rows): a count and a digest of each, and of the
   * tenant's own row.
   */
  async function fingerprint(
    tenant: Tenant,
    except: readonly string[] = [],
  ): Promise<Record<string, string>> {
    // Every table with a tenant_id, whatever its row-level security says.
    const { rows: tables } = await owner.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_attribute a
           ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
        ORDER BY 1`,
    );
    const print: Record<string, string> = {};
    for (const { table_name: table } of tables) {
      if (except.includes(table)) continue;
      let rows: Array<{ n: number; digest: string }>;
      try {
        ({ rows } = await owner.query<{ n: number; digest: string }>(
          `SELECT count(*)::int AS n,
                  md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
             FROM "${table}" t WHERE tenant_id = $1`,
          [tenant.id],
        ));
      } catch (error) {
        // A test's own probe table, dropped meanwhile: never the app's.
        if ((error as DatabaseError).code === UNDEFINED_TABLE) continue;
        throw error;
      }
      // A table with none of the tenant's rows is left out, so that one made
      // meanwhile changes nothing; one that gains or loses them all is seen.
      if (rows[0].n > 0) print[table] = `${rows[0].n} ${rows[0].digest}`;
    }
    const { rows } = await owner.query<{ digest: string }>(
      'SELECT md5(t::text) AS digest FROM tenants t WHERE id = $1',
      [tenant.id],
    );
    print.tenants = rows[0].digest;
    return print;
  }

  /** The headers of a session of A's `role`: fresh when the call ends it. */
  async function as(role: Role, fresh = false) {
    if (fresh || !sessions.has(role)) {
      const headers = await signedInAs(members.get(role)!);
      if (fresh) return headers;
      sessions.set(role, headers);
    }
    return sessions.get(role)!;
  }

  function send(
    method: Method,
    call: Call,
    headers: Record<string, string>,
  ): Promise<Response> {
    const request = booted.http[method](call.path).set(headers);
    // A command a client retries takes a key (0.7.7); one that does not, ignores it.
    if (method !== 'get') request.set('Idempotency-Key', randomUUID());
    return call.body ? request.send(call.body) : request;
  }

  /** What of B's a body carries: B's id, its slug, or any of its objects. */
  function leaked(body: unknown): string[] {
    const text = JSON.stringify(body ?? null);
    const marks: string[] = [
      b.id,
      b.slug,
      ...Object.values<string>({ ...foreign.objects }),
    ];
    return marks.filter((mark) => text.includes(mark));
  }

  /** What `role` of A must be answered: refused, not found, or served. */
  function expected(
    route: Served,
    role: Role,
  ): 'refused' | 'not found' | 'served' {
    const { access, entry } = route;
    if (access.kind === 'permission' && !holds(role, access.permission)) {
      return 'refused';
    }
    return entry?.kind === 'object' ? 'not found' : 'served';
  }

  const outcomeOf = (status: number) =>
    status === 403
      ? 'refused'
      : status === 404
        ? 'not found'
        : status >= 200 && status < 300
          ? 'served'
          : `answered ${status}`;

  /** Every probe of `route`, B's objects as every role of A. */
  async function probeAsEveryRole(route: Served) {
    const { entry } = route;
    if (!entry || entry.kind === 'none') return;
    const probes: readonly Probe[] =
      entry.kind === 'own' ? [entry.probe] : entry.probes;
    const revokes = entry.kind === 'own' && entry.revokes === true;
    for (const [n, probe] of probes.entries()) {
      const call = probe(foreign.objects);
      for (const role of ROLES) {
        const response = await send(
          route.method,
          call,
          await as(role, revokes),
        );
        // Signing out everywhere ends every session of the member's.
        if (revokes) sessions.delete(role);
        expect
          .soft([route.key, n, role, outcomeOf(response.status)])
          .toEqual([route.key, n, role, expected(route, role)]);
        expect
          .soft([route.key, n, role, leaked(response.body)])
          .toEqual([route.key, n, role, []]);
      }
    }
  }

  /**
   * Each smuggle of `route`: A's own object, fresh, paired with B's, by the
   * member allowed to change the own object. Not found, and A's rows as they
   * were.
   */
  async function smuggle(route: Served) {
    const { entry } = route;
    if (entry?.kind !== 'object') return;
    for (const [n, smuggled] of (entry.smuggles ?? []).entries()) {
      const own = await seed(a);
      const headers = await signedInAs(own.actors[entry.control]);
      const before = await fingerprint(a, ['user_sessions']);
      const response = await send(
        route.method,
        smuggled(foreign.objects, own.objects),
        headers,
      );
      expect
        .soft([route.key, `smuggle ${n}`, outcomeOf(response.status)])
        .toEqual([route.key, `smuggle ${n}`, 'not found']);
      expect
        .soft([route.key, `smuggle ${n}`, leaked(response.body)])
        .toEqual([route.key, `smuggle ${n}`, []]);
      expect
        .soft([
          route.key,
          `smuggle ${n}`,
          await fingerprint(a, ['user_sessions']),
        ])
        .toEqual([route.key, `smuggle ${n}`, before]);
    }
  }

  /**
   * Each probe and smuggle naming A's own objects alone, fresh, by a member
   * allowed to make it: served — and a list shows A's object.
   */
  async function controlOf(route: Served) {
    const { entry } = route;
    if (!entry || (entry.kind !== 'object' && entry.kind !== 'list')) return;
    const calls: Array<(own: Objects) => Call> = [
      ...entry.probes,
      ...(entry.kind === 'object' ? (entry.smuggles ?? []) : []).map(
        (smuggled) => (own: Objects) => smuggled(own, own),
      ),
    ];
    for (const [n, call] of calls.entries()) {
      // A read changes nothing, so the reads share one set; a write gets its own.
      const own =
        route.method === 'get' ? (readable ??= await seed(a)) : await seed(a);
      const response = await send(
        route.method,
        call(own.objects),
        await signedInAs(own.actors[entry.control]),
      );
      expect
        .soft([route.key, n, entry.control, outcomeOf(response.status)])
        .toEqual([route.key, n, entry.control, 'served']);
      if (entry.kind === 'list' && entry.shows && n === 0) {
        expect([route.key, JSON.stringify(response.body)]).toEqual([
          route.key,
          expect.stringContaining(own.objects[entry.shows]),
        ]);
      }
    }
  }

  beforeAll(async () => {
    const configured = inject('objectStore');
    // No store, no suite: uploads name objects in it (0.8.3).
    if (configured === null) {
      throw new TypeError(
        'the isolation suite needs the object store: run `just up`, or set S3_*_TEST',
      );
    }
    store = configured;
    storeClient = testStoreClient(store);
    booted = await bootApp({ objectStore: store });
    const { connectionString, options } = databaseConnectionOf(
      inject('migrationDatabaseUrl'),
    );
    owner = new Client({ connectionString, options });
    await owner.connect();

    const reflector = booted.app.get(Reflector);
    routes = controllersOf(booted.app)
      .flatMap(routesOf)
      .map((route) => {
        const key = `${route.method.toUpperCase()} ${route.path}`;
        const handler = (
          route.controller.prototype as Record<
            string,
            (...args: never[]) => unknown
          >
        )[route.handler];
        return {
          ...route,
          key,
          access: declaredAccess(reflector, handler, route.controller)[0],
          entry: ROUTE_INVENTORY[key],
        };
      });

    a = await createTenant({ slug: `agency-${suffix()}` });
    b = await createTenant({ slug: `rival-${suffix()}` });
    foreign = await seed(b);
    for (const role of ROLES) members.set(role, await createMember(a, role));
  });

  afterAll(async () => {
    await owner?.end();
    storeClient?.destroy();
    await booted?.app.close();
  });

  it('every_route_is_in_the_isolation_inventory', () => {
    // Every route served is in the inventory, and nothing else is.
    expect(routes.map(({ key }) => key).sort()).toEqual(
      Object.keys(ROUTE_INVENTORY).sort(),
    );
    expect(routes.length).toBe(51);

    // Sentinel objects, to see what each probe names.
    const names = (tag: string) =>
      Object.fromEntries(
        (
          [
            'player',
            'bench',
            'record',
            'session',
            'draft',
            'submitted',
            'assignment',
            'scout',
            'invitation',
            'signIn',
            'upload',
          ] as const
        ).map((key) => [key, `${tag}-${key}`]),
      ) as unknown as Objects;
    const [of, own] = [names('foreign'), names('own')];

    for (const route of routes) {
      const entry = route.entry!;
      // A route that takes an id in its path names an object.
      if (/:\w+/.test(route.path)) {
        expect([route.key, entry.kind]).toEqual([route.key, 'object']);
      }
      // Only a public route, or one that names no object, goes uncalled, and
      // it says why; the caller's own session is a signed-in route's.
      if (entry.kind === 'none') {
        expect([route.key, entry.why.length > 0]).toEqual([route.key, true]);
      }
      if (entry.kind === 'own') {
        expect([route.key, route.access.kind]).toEqual([
          route.key,
          'signed-in',
        ]);
      }
      if (route.access.kind === 'public') {
        expect([route.key, entry.kind]).toEqual([route.key, 'none']);
      }
      const calls: Call[] =
        entry.kind === 'own'
          ? [entry.probe(of)]
          : entry.kind === 'none'
            ? []
            : entry.probes.map((probe) => probe(of));
      const smuggled: Call[] =
        entry.kind === 'object'
          ? (entry.smuggles ?? []).map((smuggle) => smuggle(of, own))
          : [];
      for (const call of [...calls, ...smuggled]) {
        // Each probe calls the route it is filed under…
        expect([route.key, patternOf(route.path).test(call.path)]).toEqual([
          route.key,
          true,
        ]);
        // …and an object's names another tenant's object.
        if (entry.kind === 'object') {
          expect([
            route.key,
            JSON.stringify(call).includes('foreign-'),
          ]).toEqual([route.key, true]);
        }
      }
      // A smuggle pairs it with one of the caller's own.
      for (const call of smuggled) {
        expect([route.key, JSON.stringify(call).includes('own-')]).toEqual([
          route.key,
          true,
        ]);
      }
    }
  });

  it('no_route_reads_another_tenants_object', async () => {
    const before = await fingerprint(b);
    const reads = routes.filter(({ method }) => method === 'get');
    expect(reads.length).toBeGreaterThan(20);
    for (const route of reads) await probeAsEveryRole(route);
    expect(await fingerprint(b)).toEqual(before);
    for (const route of reads) await controlOf(route);
  });

  it('no_route_mutates_another_tenants_object', async () => {
    // B's rows, every table, through every probe and smuggle; and A's, but
    // for the sessions the calls open and end, through every probe.
    const [beforeB, beforeA] = [
      await fingerprint(b),
      await fingerprint(a, ['user_sessions']),
    ];
    const writes = routes.filter(({ method }) => method !== 'get');
    expect(writes.length).toBeGreaterThan(20);
    for (const route of writes) await probeAsEveryRole(route);
    expect(await fingerprint(b)).toEqual(beforeB);
    expect(await fingerprint(a, ['user_sessions'])).toEqual(beforeA);
    for (const route of writes) await smuggle(route);
    expect(await fingerprint(b)).toEqual(beforeB);
    for (const route of writes) await controlOf(route);
  });
});
