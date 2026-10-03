import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { bootApp, type BootedApp } from '../harness/app';
import { runPrisma } from '../harness/fixtures';
import {
  controllersOf,
  type Route,
  routesOf,
  withParams,
} from '../harness/routes';

// The local credential system is retired (0.1.6). Both quarantined modules are
// switched on here, before AppModule loads, so that every non-public route of
// every module meets the session placeholder.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

interface InventoriedRoute extends Route {
  isPublic: boolean;
}

/** Every route the application serves, read from its controllers' metadata. */
function routeInventory(app: INestApplication): InventoriedRoute[] {
  const reflector = app.get(Reflector);
  return controllersOf(app)
    .flatMap(routesOf)
    .map((route) => ({
      ...route,
      isPublic:
        reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          (route.controller.prototype as Record<string, () => unknown>)[
            route.handler
          ],
          route.controller,
        ]) === true,
    }));
}

// The sixteen routes the local credential system served, where v1 would serve them.
const RETIRED = [
  'post /api/v1/auth/login',
  'post /api/v1/auth/register',
  'post /api/v1/auth/refresh',
  'post /api/v1/auth/logout',
  'post /api/v1/auth/forgot-password',
  'post /api/v1/auth/reset-password',
  'post /api/v1/auth/change-password',
  'get /api/v1/auth/verify-email',
  'post /api/v1/auth/resend-verification',
  'get /api/v1/auth/me',
  'post /api/v1/auth/2fa/enable',
  'post /api/v1/auth/2fa/verify',
  'post /api/v1/auth/2fa/disable',
  'get /api/v1/auth/sessions',
  'post /api/v1/auth/sessions/:sessionId/revoke',
  'post /api/v1/auth/logout-all',
];

const CREDENTIAL_COLUMNS = [
  'passwordHash',
  'passwordChangedAt',
  'emailVerifiedAt',
  'failedLoginAttempts',
  'lockedUntil',
  'passwordResetToken',
  'passwordResetExpiry',
  'emailVerificationToken',
  'emailVerificationExpiry',
  'is2FAEnabled',
  'twoFASecret',
];

describe('the local credential system is retired', () => {
  let booted: BootedApp;
  let routes: InventoriedRoute[];

  beforeAll(async () => {
    booted = await bootApp();
    routes = routeInventory(booted.app);
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('no_local_credential_route_remains', () => {
    expect(routes.length).toBeGreaterThan(0);
    const served = routes.map(({ method, path }) => `${method} ${path}`);
    for (const route of RETIRED) expect(served).not.toContain(route);
    expect(served.filter((route) => route.includes('/auth/'))).toEqual([]);
  });

  it('protected_routes_refuse_without_a_session', async () => {
    const protectedRoutes = routes.filter(({ isPublic }) => !isPublic);
    expect(protectedRoutes.length).toBeGreaterThan(0);

    for (const { method, path } of protectedRoutes) {
      const url = withParams(path, randomUUID);
      const response = await booted.http[method](url);
      expect([method, path, response.status]).toEqual([method, path, 401]);
    }
    // The public routes still answer.
    for (const { method, path } of routes.filter(({ isPublic }) => isPublic)) {
      const response = await booted.http[method](path);
      expect([method, path, response.status]).toEqual([method, path, 200]);
    }
  });

  it('credential_columns_are_gone', async () => {
    const columns = await runPrisma().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${inject('databaseSchema')} AND table_name = 'users'`;
    const names = columns.map(({ column_name }) => column_name);

    expect(names).toContain('email'); // the table really was read
    for (const column of CREDENTIAL_COLUMNS) {
      expect(names).not.toContain(column);
    }
  });
});
