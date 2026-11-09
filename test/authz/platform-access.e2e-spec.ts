import { randomBytes, randomUUID } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Tenant, type User, UserRole } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  declaredAccess,
  type RouteAccess,
} from '../../src/common/authz/route-access';
import { ForbiddenError } from '../../src/common/errors/domain-error';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { IdentityProviderPort } from '../../src/modules/identity/application/ports/identity-provider.port';
import { mayGrant } from '../../src/modules/users/application/role-grants.policy';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { InviteMemberUseCase } from '../../src/modules/users/application/use-cases/invite-member.usecase';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';
import { controllersOf, type Route, routesOf } from '../harness/routes';
import { signedInAs } from '../harness/session';

// No implicit platform access (0.6.7; SR-ACL-003, BR-RULE-12). SUPER_ADMIN is
// a platform role: it holds no tenant-data permission, no tenant membership
// holds it, and nothing a tenant does grants it — not an invitation, not a
// role change. Platform support reaches a tenant only through an audited,
// time-boxed grant (4.1.2); until then, not at all. The quarantined modules
// are switched on before AppModule loads, so that their routes — where the
// medical and scouting records are — are examined too.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

const CHECK_VIOLATION = '23514';
const INVITATIONS = '/api/v1/users/invitations';
const DAY_MS = 24 * 3_600_000;

const suffix = () => randomBytes(4).toString('hex');
const address = () => `would-be-platform-${suffix()}@agency.test`;

type Outcome = { rowCount: number } | { code?: string; constraint?: string };

/** A route's handler, read as metadata and never called. */
const handlerOf = (route: Route) =>
  (route.controller.prototype as Record<string, (...args: never[]) => unknown>)[
    route.handler
  ];

const refusedBy = (constraint: string) =>
  expect.objectContaining({ code: CHECK_VIOLATION, constraint }) as unknown;

describe('no implicit platform access', () => {
  let booted: BootedApp;
  let database: Client;
  let tenants: Tenant[];
  /** Each tenant's owner and administrator: those who may grant a role. */
  let granters: Map<string, User[]>;
  /** Every route the app serves, with the access rule it declares. */
  let routes: Array<Route & { access: RouteAccess }>;

  /**
   * One statement as `tenant`, through the runtime role and row-level
   * security, in a transaction rolled back whatever it did: how many rows it
   * wrote, or why the database refused it.
   */
  async function attempt(
    tenant: Tenant,
    sql: string,
    params: unknown[],
  ): Promise<Outcome> {
    await database.query('BEGIN');
    try {
      await database.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant.id,
      ]);
      const { rowCount } = await database.query(sql, params);
      return { rowCount: rowCount ?? 0 };
    } catch (error) {
      const { code, constraint } = error as DatabaseError;
      return { code, constraint };
    } finally {
      await database.query('ROLLBACK');
    }
  }

  /** How many members of `tenant` hold `role`, archived ones included. */
  const membersHolding = (tenant: Tenant, role: UserRole) =>
    asTenant(tenant.id, (tx) => tx.user.count({ where: { role } }));

  beforeAll(async () => {
    booted = await bootApp();
    const { connectionString, options } = databaseConnectionOf(
      inject('databaseUrl'),
    );
    database = new Client({ connectionString, options });
    await database.connect();

    tenants = [
      await createTenant({ slug: `agency-${suffix()}` }),
      await createTenant({ slug: `rival-${suffix()}` }),
    ];
    granters = new Map();
    for (const tenant of tenants) {
      granters.set(tenant.id, [
        await createMember(tenant, 'OWNER'),
        await createMember(tenant, 'ADMIN'),
      ]);
    }

    const reflector = booted.app.get(Reflector);
    // Exactly one rule each: deny by default (0.6.2) holds the API to it.
    routes = controllersOf(booted.app)
      .flatMap(routesOf)
      .map((route) => ({
        ...route,
        access: declaredAccess(
          reflector,
          handlerOf(route),
          route.controller,
        )[0],
      }));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await database?.end();
    await booted?.app.close();
  });

  it('super_admin_reads_no_tenant_data', async () => {
    const permissions = booted.app.get(PermissionService);

    // The stored matrix grants the platform role nothing: read apart from
    // the API, since the matrix belongs to no tenant.
    expect(
      await runPrisma().rolePermission.count({
        where: { roleId: 'SUPER_ADMIN' },
      }),
    ).toBe(0);

    // Every route the app serves, the medical and scouting ones among them,
    // reads tenant data behind a permission, on the caller's own session, or
    // not at all (public). Each route behind a permission is refused to
    // SUPER_ADMIN by the real permission guard, in either tenant, as it would
    // be were such a member signed in.
    const guarded = routes.flatMap((route) =>
      route.access.kind === 'permission'
        ? [{ ...route, permission: route.access.permission }]
        : [],
    );
    // Invitations, medical and scouting: the routes that read tenant data.
    expect(
      [
        ...new Set(
          guarded.map(({ path }) => path.split('/').slice(0, 4).join('/')),
        ),
      ].sort(),
    ).toEqual(['/api/v1/medical', '/api/v1/scouting', '/api/v1/users']);
    const guard = new PermissionGuard(booted.app.get(Reflector), permissions);
    for (const tenant of tenants) {
      // What the session guard would mint for such a member: none exists.
      const platform = {
        id: randomUUID(),
        tenantId: tenant.id,
        role: 'SUPER_ADMIN',
      } as const;
      const asPlatform = memberContext(platform);
      for (const route of guarded) {
        const decided = guard.canActivate({
          getHandler: () => handlerOf(route),
          getClass: () => route.controller,
          switchToHttp: () => ({
            getRequest: () => ({
              user: platform,
              tenantContext: asPlatform,
            }),
          }),
        } as unknown as ExecutionContext);
        // Refused because the role does not hold the route's permission.
        const label = `${tenant.slug} ${route.method} ${route.path}`;
        await expect(decided, label).rejects.toBeInstanceOf(ForbiddenError);
        await expect(decided, label).rejects.toThrow(
          `the role does not hold ${route.permission}`,
        );
      }
      // Nothing for the web app to show, and no confidential class.
      expect(await permissions.effectivePermissions(asPlatform)).toEqual([]);
      expect([...(await permissions.grantedClasses(asPlatform))]).toEqual([]);

      // The routes on the caller's own session need a membership's session,
      // and no membership holds the role: the database refuses one.
      const email = address();
      expect(
        await attempt(
          tenant,
          `INSERT INTO users (id, tenant_id, email, normalized_email, role, updated_at)
           VALUES ($1, $2, $3, $3, 'SUPER_ADMIN', now())`,
          [randomUUID(), tenant.id, email],
        ),
      ).toEqual(refusedBy('users_role_check'));
      // A tenant role, otherwise the same: accepted (and rolled back).
      expect(
        await attempt(
          tenant,
          `INSERT INTO users (id, tenant_id, email, normalized_email, role, updated_at)
           VALUES ($1, $2, $3, $3, 'GUARDIAN', now())`,
          [randomUUID(), tenant.id, email],
        ),
      ).toEqual({ rowCount: 1 });
      expect(await membersHolding(tenant, 'SUPER_ADMIN')).toBe(0);
    }
  });

  it('super_admin_cannot_be_granted_by_invitation', async () => {
    const provider = booted.app.get(IdentityProviderPort);
    const asked = [
      vi.spyOn(provider, 'findAccount'),
      vi.spyOn(provider, 'createAccount'),
    ];
    const inviteMember = booted.app.get(InviteMemberUseCase);

    for (const tenant of tenants) {
      const [owner, admin] = granters.get(tenant.id)!;

      // Through the API, by those who may invite: the route admits them —
      // a refusal of the request, not a 403 — and the request names no role
      // an invitation can grant.
      for (const granter of [owner, admin]) {
        const response = await booted.http
          .post(INVITATIONS)
          .set(await signedInAs(granter))
          .send({ email: address(), role: 'SUPER_ADMIN' });
        expect([tenant.slug, granter.role, response.status]).toEqual([
          tenant.slug,
          granter.role,
          400,
        ]);
        expect(response.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          fieldErrors: [
            expect.objectContaining({ field: '/role', code: 'INVALID_VALUE' }),
          ],
        });
      }

      // Past the request's validation, the use case refuses it itself, even
      // to the owner, who may grant every tenant role.
      await expect(
        inviteMember.execute(memberContext(owner), {
          email: address(),
          role: 'SUPER_ADMIN',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // And the database refuses the invitation, however it is written.
      expect(
        await attempt(
          tenant,
          `INSERT INTO invitations (id, tenant_id, email, normalized_email, role, locale,
                                    invited_by_id, expires_at, updated_at)
           VALUES ($1, $2, $3, $3, 'SUPER_ADMIN', 'en', $4, $5, now())`,
          [
            randomUUID(),
            tenant.id,
            address(),
            owner.id,
            new Date(Date.now() + 7 * DAY_MS),
          ],
        ),
      ).toEqual(refusedBy('invitations_role_check'));

      expect(
        await asTenant(tenant.id, (tx) =>
          tx.invitation.count({ where: { role: 'SUPER_ADMIN' } }),
        ),
      ).toBe(0);
    }
    // Refused before the identity provider was asked for anything.
    for (const spy of asked) expect(spy).not.toHaveBeenCalled();
  });

  it('super_admin_cannot_be_granted_by_a_role_change', async () => {
    // No route changes a member's role yet (1.1.x). The rule one will apply
    // lets no role grant SUPER_ADMIN…
    for (const granter of Object.values(UserRole)) {
      expect([granter, mayGrant(granter, 'SUPER_ADMIN')]).toEqual([
        granter,
        false,
      ]);
    }

    // …and the database refuses the change, whoever writes it: to a live
    // member, or to an archived one, whom reactivation would bring back.
    for (const tenant of tenants) {
      const [owner] = granters.get(tenant.id)!;
      const coach = await createMember(tenant, 'COACH');
      for (const member of [owner, coach]) {
        expect(
          await attempt(
            tenant,
            `UPDATE users SET role = 'SUPER_ADMIN' WHERE id = $1`,
            [member.id],
          ),
        ).toEqual(refusedBy('users_role_check'));
        expect(
          await attempt(
            tenant,
            `UPDATE users SET role = 'SUPER_ADMIN', deleted_at = now() WHERE id = $1`,
            [member.id],
          ),
        ).toEqual(refusedBy('users_role_check'));
        // Another tenant role: changed (and rolled back).
        expect(
          await attempt(
            tenant,
            `UPDATE users SET role = 'SCOUT' WHERE id = $1`,
            [member.id],
          ),
        ).toEqual({ rowCount: 1 });
      }
      // Each keeps the role they had.
      for (const member of [owner, coach]) {
        expect(
          await asTenant(tenant.id, (tx) =>
            tx.user.findUniqueOrThrow({
              where: { id: member.id },
              select: { role: true, deletedAt: true },
            }),
          ),
        ).toEqual({ role: member.role, deletedAt: null });
      }
      expect(await membersHolding(tenant, 'SUPER_ADMIN')).toBe(0);
    }
  });
});
