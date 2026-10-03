import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
// Where NestJS 12 exports the kinds of route arguments.
import { RouteParamtypes } from '@nestjs/common/internal';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProblemDetails } from '../../src/common/filters/problem-details.filter';
import { MedicalRecordRepository } from '../../src/modules/medical/infrastructure/repositories/medical-record.repository';
import { TreatmentSessionRepository } from '../../src/modules/medical/infrastructure/repositories/treatment-session.repository';
import { MedicalController } from '../../src/modules/medical/presentation/medical.controller';
import { AssignmentRepository } from '../../src/modules/scouting/infrastructure/repositories/assignment.repository';
import { ScoutingReportRepository } from '../../src/modules/scouting/infrastructure/repositories/scouting-report.repository';
import { WatchlistRepository } from '../../src/modules/scouting/infrastructure/repositories/watchlist.repository';
import { ScoutingController } from '../../src/modules/scouting/presentation/scouting.controller';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant } from '../harness/fixtures';
import { controllersOf, routesOf, withParams } from '../harness/routes';
import { TEST_MEMBER_HEADER } from '../harness/session';

// Both quarantined modules switched on before AppModule loads: their routes
// are the ones that take bodies, queries and path ids today.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

interface RouteArg {
  schema?: unknown;
}

/** The arguments a handler declares, by type: body, query, path parameters. */
function argsOf(
  controller: Type,
  handler: string,
): [RouteParamtypes, RouteArg][] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ??
    {}) as Record<string, RouteArg>;
  return Object.entries(args).map(([key, arg]) => [
    Number(key.split(':')[0]),
    arg,
  ]);
}

const ROUTES = [MedicalController, ScoutingController]
  .flatMap(routesOf)
  .map((route) => ({
    ...route,
    takes: new Set(
      argsOf(route.controller, route.handler).map(([type]) => type),
    ),
  }));

const REPOSITORIES: Type[] = [
  MedicalRecordRepository,
  TreatmentSessionRepository,
  ScoutingReportRepository,
  WatchlistRepository,
  AssignmentRepository,
];

describe('strict validation, one mechanism', () => {
  let booted: BootedApp;
  let member: Record<string, string>;

  beforeAll(async () => {
    booted = await bootApp({ testSessions: true });
    const tenant = await createTenant();
    const admin = await createMember(tenant, 'SUPER_ADMIN');
    member = { [TEST_MEMBER_HEADER]: admin.id };
    // Every permission, so that only validation can refuse.
    vi.spyOn(PermissionService.prototype, 'hasPermission').mockResolvedValue(
      true,
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await booted?.app.close();
  });

  it('an_unknown_property_is_refused', async () => {
    const spies = REPOSITORIES.flatMap((repository) => {
      const prototype = repository.prototype as Record<string, unknown>;
      return Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => vi.spyOn(prototype as never, name as never));
    });
    const bodyRoutes = ROUTES.filter(({ takes }) =>
      takes.has(RouteParamtypes.BODY),
    );
    expect(bodyRoutes.length).toBe(12);

    for (const { method, path } of bodyRoutes) {
      const response = await booted.http[method](withParams(path, randomUUID))
        .set(member)
        .send({ tenantId: randomUUID(), role: 'SUPER_ADMIN' });

      expect([method, path, response.status]).toEqual([method, path, 400]);
      const { code, fieldErrors } = response.body as ProblemDetails;
      expect(code).toBe('VALIDATION_FAILED');
      expect(fieldErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: '/tenantId',
            code: 'UNKNOWN_FIELD',
          }),
          expect.objectContaining({ field: '/role', code: 'UNKNOWN_FIELD' }),
        ]),
      );
    }
    // Refused before any handler ran.
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('a_malformed_uuid_is_a_validation_error', async () => {
    // Routes without a body: Nest resolves a handler's arguments together and
    // answers the first refusal, so a body's could come first.
    const withPathIds = ROUTES.filter(
      ({ path, takes }) =>
        path.includes(':') && !takes.has(RouteParamtypes.BODY),
    );
    expect(withPathIds.length).toBeGreaterThan(15);

    for (const { method, path } of withPathIds) {
      const response = await booted.http[method](
        withParams(path, () => 'not-a-uuid'),
      ).set(member);
      const name = /:(\w+)/.exec(path)?.[1];

      expect([method, path, response.status]).toEqual([method, path, 400]);
      expect(response.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fieldErrors: [{ field: `/${name}`, code: 'INVALID_FORMAT' }],
      });
    }
  });

  it('an_unknown_query_parameter_is_refused', async () => {
    const queryRoutes = ROUTES.filter(({ takes }) =>
      takes.has(RouteParamtypes.QUERY),
    );
    expect(queryRoutes.length).toBe(6);

    for (const { method, path } of queryRoutes) {
      const response = await booted.http[method](withParams(path, randomUUID))
        .set(member)
        .query({ tenantId: randomUUID() });

      expect([method, path, response.status]).toEqual([method, path, 400]);
      expect(response.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        fieldErrors: [{ field: '/tenantId', code: 'UNKNOWN_FIELD' }],
      });
    }
  });

  it('every_route_parameter_declares_a_schema', () => {
    // One mechanism: no body, query or path parameter is read unvalidated.
    const validated = [
      RouteParamtypes.BODY,
      RouteParamtypes.QUERY,
      RouteParamtypes.PARAM,
    ];
    const controllers = controllersOf(booted.app);
    expect(controllers).toEqual(
      expect.arrayContaining([MedicalController, ScoutingController]),
    );

    const unvalidated = controllers.flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype).flatMap((handler) =>
        argsOf(controller, handler)
          .filter(([type, arg]) => validated.includes(type) && !arg.schema)
          .map(
            ([type]) =>
              `${controller.name}.${handler} ${RouteParamtypes[type]}`,
          ),
      ),
    );
    expect(unvalidated).toEqual([]);
  });

  it('an_empty_patch_is_a_400', async () => {
    const patches = ROUTES.filter(
      ({ method, takes }) =>
        method === 'patch' && takes.has(RouteParamtypes.BODY),
    );
    expect(patches.length).toBeGreaterThan(0);

    for (const { path } of patches) {
      const response = await booted.http
        .patch(withParams(path, randomUUID))
        .set(member)
        .send({});
      expect([path, response.status]).toEqual([path, 400]);
      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('a_query_is_coerced_explicitly', async () => {
    const records = (query: Record<string, string>) =>
      booted.http.get('/api/v1/medical/records').set(member).query(query);

    const valid = await records({
      page: '2',
      limit: '5',
      isConfidential: 'false',
    });
    expect(valid.status).toBe(200);
    expect(JSON.stringify(valid.body)).toContain('"page":2,"limit":5');

    expect((await records({ isConfidential: 'yes' })).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: '/isConfidential', code: 'INVALID_VALUE' }],
    });
    expect((await records({ limit: '500' })).body).toMatchObject({
      fieldErrors: [{ field: '/limit', code: 'TOO_BIG' }],
    });
  });
});
