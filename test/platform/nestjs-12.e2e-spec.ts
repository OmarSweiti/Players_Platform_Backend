import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Public } from '../../src/common/decorators/public.decorator';
import { bootApp, type BootedApp } from '../harness/app';

const BACKEND_ROOT = resolve(__dirname, '../..');

interface Manifest {
  version: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifestOf = (directory: string): Manifest =>
  JSON.parse(
    readFileSync(resolve(BACKEND_ROOT, directory, 'package.json'), 'utf8'),
  ) as Manifest;

/** Every @nestjs/* package the backend declares, as installed. */
function installedNestPackages(): (Manifest & { name: string })[] {
  const { dependencies = {}, devDependencies = {} } = manifestOf('.');
  return Object.keys({ ...dependencies, ...devDependencies })
    .filter((name) => name.startsWith('@nestjs/'))
    .map((name) => ({ name, ...manifestOf(`node_modules/${name}`) }));
}

// Constructor injection needs the decorator metadata SWC emits.
@Injectable()
class Clock {}

@Injectable()
class Agenda {
  constructor(readonly clock: Clock) {}
}

const PageQuery = z.strictObject({ page: z.coerce.number().int().min(1) });

@Controller('probe')
class ProbeController {
  @Public()
  @Get('page')
  page(@Query({ schema: PageQuery }) query: z.infer<typeof PageQuery>) {
    return query;
  }
}

describe('NestJS 12', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp({ controllers: [ProbeController] });
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('the_test_runner_loads_es_module_packages', async () => {
    // NestJS ships as ES modules from 12 on — what the Jest setup could not
    // load (backend #26).
    const packages = installedNestPackages();
    expect(packages.length).toBeGreaterThan(0);
    for (const { name, type } of packages) {
      expect([name, type]).toEqual([name, 'module']);
    }
    const moduleRef = await Test.createTestingModule({
      providers: [Clock, Agenda],
    }).compile();
    expect(moduleRef.get(Agenda).clock).toBeInstanceOf(Clock);
  });

  it('the_app_boots_on_nestjs_12', async () => {
    // One major across the family, from 12 on: a lone major (@nestjs/testing
    // 12 against core 11) is what broke the build on 28 September 2026.
    const majors = new Set(
      installedNestPackages().map(({ version }) =>
        Number(version.split('.')[0]),
      ),
    );
    expect(majors.size).toBe(1);
    expect([...majors][0]).toBeGreaterThanOrEqual(12);

    await booted.http.get('/api/health').expect(200);
  });

  it('a_route_schema_validates_and_transforms_its_parameter', async () => {
    const valid = await booted.http.get('/api/probe/page').query({ page: '2' });
    expect(valid.status).toBe(200);
    // The schema's output, a number, whatever the envelope around it (two
    // today; 0.3.4 makes it `{ data }` once).
    expect(JSON.stringify(valid.body)).toContain('{"page":2}');

    const invalid = await booted.http
      .get('/api/probe/page')
      .query({ page: '0' });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: '/page', code: 'TOO_SMALL' }],
    });

    // A strict schema refuses a property it does not name.
    const unknown = await booted.http
      .get('/api/probe/page')
      .query({ page: '2', tenantId: 'f7d6b7d2-1d4c-4c43-9a6f-0a1b2c3d4e5f' });
    expect(unknown.status).toBe(400);
  });
});
