import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../../src/health/health.controller';
import { bootApp, type BootedApp } from '../harness/app';
import { controllersOf, routesOf, withParams } from '../harness/routes';

// Every module switched on before AppModule loads, so that every route the
// application can serve is in the inventory.
vi.hoisted(() => {
  process.env.FEATURE_MEDICAL = 'true';
  process.env.FEATURE_SCOUTING = 'true';
});

describe('versioned routes', () => {
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp();
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  it('routes_are_served_under_v1', async () => {
    const routes = controllersOf(booted.app).flatMap(routesOf);
    const health = routes.filter(
      ({ controller }) => controller === HealthController,
    );
    const versioned = routes.filter(
      ({ controller }) => controller !== HealthController,
    );
    expect(versioned.length).toBeGreaterThan(30);

    for (const { method, path } of versioned) {
      expect(path).toMatch(/^\/api\/v1\//);
      const url = withParams(path, randomUUID);
      // Served under v1 — refused for want of a session, not unknown…
      const served = await booted.http[method](url);
      expect([method, path, served.status]).toEqual([method, path, 401]);
      // …and nowhere else.
      const unversioned = await booted.http[method](
        url.replace('/api/v1/', '/api/'),
      );
      expect([method, path, unversioned.status]).toEqual([method, path, 404]);
    }

    // The health checks alone stay unversioned.
    expect(health.map(({ path }) => path)).toEqual([
      '/api/health',
      '/api/health/ready',
    ]);
    for (const { path } of health) {
      expect((await booted.http.get(path)).status).toBe(200);
      const versionedHealth = path.replace('/api/', '/api/v1/');
      expect((await booted.http.get(versionedHealth)).status).toBe(404);
    }
  });
});
