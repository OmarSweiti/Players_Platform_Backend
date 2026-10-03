import { randomUUID } from 'node:crypto';
import {
  type INestApplication,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { bootApp, type BootedApp } from '../harness/app';
import { runPrisma } from '../harness/fixtures';

// The local credential system is retired (0.1.6). Both quarantined modules are
// switched on here, before AppModule loads, so that every non-public route of
// every module meets the session placeholder.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Route {
  method: Method;
  path: string;
  isPublic: boolean;
}

/** Every route the application serves, read from its controllers' metadata. */
function routeInventory(app: INestApplication): Route[] {
  const reflector = app.get(Reflector);
  const controllers = [...app.get(ModulesContainer).values()].flatMap(
    (module) =>
      [...module.controllers.values()]
        .map(({ metatype }) => metatype as Type | null)
        .filter((metatype): metatype is Type => metatype !== null),
  );
  return controllers.flatMap((controller) => {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const prototype = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(prototype).flatMap((name) => {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') return [];
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (path === undefined || verb === undefined) return [];
      const isPublic =
        reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
          handler,
          controller,
        ]) === true;
      return [
        {
          method: RequestMethod[verb].toLowerCase() as Method,
          path: `/api/${base}/${path}`.replace(/\/+/g, '/').replace(/\/$/, ''),
          isPublic,
        },
      ];
    });
  });
}

// The sixteen routes the local credential system served.
const RETIRED = [
  'post /api/auth/login',
  'post /api/auth/register',
  'post /api/auth/refresh',
  'post /api/auth/logout',
  'post /api/auth/forgot-password',
  'post /api/auth/reset-password',
  'post /api/auth/change-password',
  'get /api/auth/verify-email',
  'post /api/auth/resend-verification',
  'get /api/auth/me',
  'post /api/auth/2fa/enable',
  'post /api/auth/2fa/verify',
  'post /api/auth/2fa/disable',
  'get /api/auth/sessions',
  'post /api/auth/sessions/:sessionId/revoke',
  'post /api/auth/logout-all',
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
  let routes: Route[];

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
    expect(served.filter((route) => route.includes(' /api/auth/'))).toEqual([]);
  });

  it('protected_routes_refuse_without_a_session', async () => {
    const protectedRoutes = routes.filter(({ isPublic }) => !isPublic);
    expect(protectedRoutes.length).toBeGreaterThan(0);

    for (const { method, path } of protectedRoutes) {
      const url = path.replace(/:\w+/g, randomUUID());
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
