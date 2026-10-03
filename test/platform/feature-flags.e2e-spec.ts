import { randomUUID } from 'node:crypto';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MedicalRecordRepository } from '../../src/modules/medical/infrastructure/repositories/medical-record.repository';
import { TreatmentSessionRepository } from '../../src/modules/medical/infrastructure/repositories/treatment-session.repository';
import { MedicalController } from '../../src/modules/medical/presentation/medical.controller';
import { AssignmentRepository } from '../../src/modules/scouting/infrastructure/repositories/assignment.repository';
import { ScoutingReportRepository } from '../../src/modules/scouting/infrastructure/repositories/scouting-report.repository';
import { WatchlistRepository } from '../../src/modules/scouting/infrastructure/repositories/watchlist.repository';
import { ScoutingController } from '../../src/modules/scouting/presentation/scouting.controller';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { bootApp, type BootedApp } from '../harness/app';
import { TEST_MEMBER_HEADER } from '../harness/session';
import { createMember, createTenant } from '../harness/fixtures';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Every route a controller declares, with its parameters filled in. */
function routesOf(controller: Type): { method: Method; path: string }[] {
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
    return [
      {
        method: RequestMethod[verb].toLowerCase() as Method,
        path: `/api/${base}/${path}`.replace(/:\w+/g, randomUUID()),
      },
    ];
  });
}

const REPOSITORIES: Type[] = [
  MedicalRecordRepository,
  TreatmentSessionRepository,
  ScoutingReportRepository,
  WatchlistRepository,
  AssignmentRepository,
];

describe('unfinished modules stay behind their flags', () => {
  let booted: BootedApp;
  let memberId: string;

  beforeAll(async () => {
    // FEATURE_MEDICAL and FEATURE_SCOUTING unset; signed-in requests through
    // the stand-in for sessions (test/harness/session.ts)
    booted = await bootApp({ testSessions: true });
    const tenant = await createTenant();
    const member = await createMember(tenant, 'SUPER_ADMIN');
    memberId = member.id;
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  /** Each route, anonymous and signed in, answers exactly what an unknown route does. */
  async function expectNotFound(controller: Type): Promise<number> {
    const routes = routesOf(controller);
    expect(routes.length).toBeGreaterThan(0);
    for (const { method, path } of routes) {
      for (const headers of [{}, { [TEST_MEMBER_HEADER]: memberId }]) {
        const response = await booted.http[method](path).set(headers);
        expect([method, path, response.status]).toEqual([method, path, 404]);
        expect(response.body).toMatchObject({
          statusCode: 404,
          error: 'Not Found',
          message: `Cannot ${method.toUpperCase()} ${path}`,
          path,
        });
      }
    }
    return routes.length;
  }

  it('medical_routes_are_not_found_when_disabled', async () => {
    expect(await expectNotFound(MedicalController)).toBe(16);
  });

  it('scouting_routes_are_not_found_when_disabled', async () => {
    expect(await expectNotFound(ScoutingController)).toBe(19);
  });

  it('a_disabled_module_never_reaches_its_repository', async () => {
    // The strongest caller there is: signed in, holding every permission.
    // Without the gate, these requests reach the handlers and repositories.
    vi.spyOn(PermissionService.prototype, 'hasPermission').mockResolvedValue(
      true,
    );
    const spies = REPOSITORIES.flatMap((repository) => {
      const prototype = repository.prototype as Record<string, unknown>;
      return Object.getOwnPropertyNames(prototype)
        .filter(
          (name) =>
            name !== 'constructor' && typeof prototype[name] === 'function',
        )
        .map((name) => vi.spyOn(prototype as never, name as never));
    });
    expect(spies.length).toBeGreaterThan(0);

    await expectNotFound(MedicalController);
    await expectNotFound(ScoutingController);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
