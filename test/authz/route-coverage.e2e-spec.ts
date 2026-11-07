import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Tenant } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  declaredAccess,
  type RouteAccess,
} from '../../src/common/authz/route-access';
import { RouteAccessUndeclared } from '../../src/common/authz/route-access-check';
import { RequirePermission } from '../../src/common/decorators/permissions.decorator';
import { Public } from '../../src/common/decorators/public.decorator';
import { SignedIn } from '../../src/common/decorators/signed-in.decorator';
import {
  DEFAULT_ROLE_MATRIX,
  type RoleName,
} from '../../src/modules/users/domain/default-role-matrix';
import type { PermissionKey } from '../../src/modules/users/domain/permission-catalog';
import { type BootedApp, bootApp } from '../harness/app';
import { createMember, createTenant } from '../harness/fixtures';
import {
  controllersOf,
  type Route,
  routesOf,
  withParams,
} from '../harness/routes';
import { signedInAs } from '../harness/session';

// Deny by default (0.6.2; ADR-0005): every route declares exactly one access
// rule — a permission, a signed-in member on their own session, or anyone —
// or the API does not start; and a member whose role lacks a route's
// permission is refused it. The quarantined modules are switched on before
// AppModule loads, so that their routes are served and exercised.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

// Test-only controllers, never served: each declares something wrong.
@Controller('probe/undeclared')
class UndeclaredProbe {
  @Get('open')
  open() {
    return null;
  }

  @Public()
  @SignedIn()
  @Get('both')
  both() {
    return null;
  }

  @RequirePermission('player.read')
  @Get('declared')
  declared() {
    return null;
  }
}

@Public()
@Controller('probe/conflicting')
class ConflictingProbe {
  @RequirePermission('player.read')
  @Get()
  read() {
    return null;
  }
}

const ROLES = (Object.keys(DEFAULT_ROLE_MATRIX) as RoleName[]).filter(
  (role) => role !== 'SUPER_ADMIN',
);
const holds = (role: RoleName, permission: PermissionKey) =>
  (DEFAULT_ROLE_MATRIX[role] as readonly PermissionKey[]).includes(permission);
const WRITES = new Set(['post', 'put', 'patch']);
/** A problem's code (RFC 9457, docs/reference/api.md), or nothing for a success. */
const codeOf = (body: unknown) => (body as { code?: string } | null)?.code;

describe('deny by default', () => {
  let booted: BootedApp;
  let routes: Array<Route & { access: RouteAccess[] }>;
  let tenants: Tenant[];
  /** A fresh session for a member of `role`, in the first or the second tenant. */
  let as: (role: RoleName, tenant: 0 | 1) => Promise<Record<string, string>>;

  beforeAll(async () => {
    booted = await bootApp();
    const reflector = booted.app.get(Reflector);
    routes = controllersOf(booted.app)
      .flatMap(routesOf)
      .map((route) => {
        const prototype = route.controller.prototype as Record<
          string,
          (...args: never[]) => unknown
        >;
        return {
          ...route,
          access: declaredAccess(
            reflector,
            prototype[route.handler],
            route.controller,
          ),
        };
      });
    tenants = [await createTenant(), await createTenant()];
    const members = new Map<string, Awaited<ReturnType<typeof createMember>>>();
    as = async (role, tenant) => {
      const key = `${role} ${tenant}`;
      if (!members.has(key)) {
        members.set(key, await createMember(tenants[tenant], role));
      }
      return signedInAs(members.get(key)!);
    };
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  /** One request to `route`, its parameters fresh ids; a write sends an empty body. */
  function call(route: Route, headers: Record<string, string>) {
    const path = withParams(route.path, () => randomUUID());
    const request = booted.http[route.method](path).set(headers);
    return WRITES.has(route.method) ? request.send({}) : request;
  }

  it('every_route_declares_exactly_one_access_rule', () => {
    const undeclared = routes.filter(({ access }) => access.length !== 1);
    expect(undeclared.map(({ method, path }) => `${method} ${path}`)).toEqual(
      [],
    );
    const count = (kind: RouteAccess['kind']) =>
      routes.filter(({ access }) => access[0]?.kind === kind).length;
    // Health (2), sign-in, its callback and the back-channel logout;
    // step-up, the session, signing out (2) and one's own sessions (2);
    // invitations (3), medical (16) and scouting (19).
    expect({
      public: count('public'),
      signedIn: count('signed-in'),
      permission: count('permission'),
    }).toEqual({ public: 5, signedIn: 6, permission: 38 });
  });

  it('a_route_without_a_permission_or_public_fails_startup', async () => {
    for (const [probe, expected] of [
      [
        UndeclaredProbe,
        [
          'GET UndeclaredProbe.open declares none',
          'GET UndeclaredProbe.both declares public and signed-in',
        ],
      ],
      [
        ConflictingProbe,
        ['GET ConflictingProbe.read declares public and permission'],
      ],
    ] as const) {
      const refusal = await bootApp({ controllers: [probe] }).then(
        async ({ app }) => {
          await app.close();
          return null;
        },
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(RouteAccessUndeclared);
      expect((refusal as RouteAccessUndeclared).routes).toEqual(expected);
    }
  });

  it('each_route_refuses_a_member_without_its_permission', async () => {
    const guarded = routes.flatMap((route) => {
      const [access] = route.access;
      return access?.kind === 'permission'
        ? [{ route, permission: access.permission }]
        : [];
    });
    expect(guarded.length).toBe(38);
    for (const { route, permission } of guarded) {
      const lacking = ROLES.find((role) => !holds(role, permission));
      const holder = ROLES.find((role) => holds(role, permission));
      expect([permission, lacking, holder].every(Boolean)).toBe(true);

      // A member of the first tenant whose role lacks it: refused, before
      // any parameter or body is read.
      const refused = await call(route, await as(lacking!, 0));
      expect([
        route.method,
        route.path,
        refused.status,
        codeOf(refused.body),
      ]).toEqual([route.method, route.path, 403, 'FORBIDDEN']);
      // A member of the second whose role holds it: past the guard, whatever
      // the handler then answers to a made-up id or an empty body.
      const allowed = await call(route, await as(holder!, 1));
      expect([route.method, route.path, codeOf(allowed.body)]).not.toEqual([
        route.method,
        route.path,
        'FORBIDDEN',
      ]);
    }
  });

  it('a_signed_in_route_needs_a_session_and_no_permission', async () => {
    const own = routes.filter(({ access }) => access[0]?.kind === 'signed-in');
    expect(own.length).toBe(6);
    for (const route of own) {
      // Nobody signed in: not authenticated.
      const anonymous = await call(route, {});
      expect([route.method, route.path, anonymous.status]).toEqual([
        route.method,
        route.path,
        401,
      ]);
      // The role with the fewest permissions, on a fresh session of its own:
      // neither refused nor sent to sign in.
      const guardian = await call(route, await as('GUARDIAN', 0));
      expect([
        route.method,
        route.path,
        [401, 403].includes(guardian.status),
      ]).toEqual([route.method, route.path, false]);
    }
  });
});
