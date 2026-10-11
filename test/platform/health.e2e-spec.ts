import { randomBytes } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PROBE_TIMEOUT_MS,
  ReadinessService,
} from '../../src/health/readiness.service';
import { bootApp, type BootedApp } from '../harness/app';

const TOKEN = `canary-${randomBytes(12).toString('hex')}`;

describe('liveness and readiness', () => {
  let booted: BootedApp;
  let readiness: ReadinessService;

  beforeAll(async () => {
    booted = await bootApp();
    readiness = booted.app.get(ReadinessService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await booted?.app.close();
  });

  /** Readiness is 503 while `dependency` refuses, and 200 once it answers. */
  async function expectNotReadyWhileDown(
    dependency: keyof ReadinessService['probes'],
    refusal: Error,
  ) {
    expect((await booted.http.get('/health/ready')).status).toBe(200);

    vi.spyOn(readiness.probes, dependency).mockRejectedValue(refusal);
    const down = await booted.http.get('/health/ready');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    // Which dependency, where and why stay in the log.
    expect(JSON.stringify(down.body)).not.toMatch(
      new RegExp(`${dependency}|ECONNREFUSED|127\\.0\\.0\\.1`, 'i'),
    );

    vi.restoreAllMocks();
    expect((await booted.http.get('/health/ready')).status).toBe(200);
  }

  it('liveness_answers_while_the_process_runs', async () => {
    const response = await booted.http.get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'live' } });
  });

  it('readiness_fails_when_the_database_is_down', async () => {
    await expectNotReadyWhileDown(
      'database',
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    );
  });

  it('readiness_fails_when_valkey_is_down', async () => {
    await expectNotReadyWhileDown(
      'valkey',
      new Error('connect ECONNREFUSED 127.0.0.1:6379'),
    );
  });

  it('readiness_answers_in_bounded_time', async () => {
    // A dependency that hangs fails the probe; it never hangs readiness.
    vi.spyOn(readiness.probes, 'database').mockReturnValue(
      new Promise(() => undefined),
    );
    const started = Date.now();
    const response = await booted.http.get('/health/ready');
    expect(response.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + 1_000);
  });

  it('unknown_paths_outside_the_api_answer_a_problem', async () => {
    const outside: ['get' | 'post', string][] = [
      ['get', '/'],
      ['get', '/no-such-page'],
      ['post', '/health/live'], // a probe takes GET only
      ['get', '/api/health'], // the probes' old address
    ];
    for (const [method, path] of outside) {
      const response = await booted.http[method](path).query({ token: TOKEN });
      expect([method, path, response.status]).toEqual([method, path, 404]);
      expect(response.headers['content-type']).toBe(
        'application/problem+json; charset=utf-8',
      );
      expect(response.body).toMatchObject({
        code: 'NOT_FOUND',
        requestId: response.headers['x-request-id'],
      });
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    }
  });
});
