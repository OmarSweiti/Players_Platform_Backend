import type { Request, Response } from 'express';
import pino from 'pino';
import type { Options } from 'pino-http';
import { describe, expect, it } from 'vitest';
import {
  accessLogOptions,
  defaultLogSink,
  loggerOptions,
} from './logger-options';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET = 'canary-7f3a';

/** A pino-http option, which accessLogOptions always sets. */
function option<K extends keyof Options<Request, Response>>(
  key: K,
): NonNullable<Options<Request, Response>[K]> {
  const value = accessLogOptions('production', 'info')[key];
  if (value === undefined) throw new Error(`${String(key)} is not set`);
  return value;
}

const request = (extra: object = {}) =>
  ({
    method: 'GET',
    url: `/api/v1/players/7?token=${SECRET}`,
    originalUrl: `/api/v1/players/7?token=${SECRET}`,
    headers: { cookie: SECRET, authorization: SECRET },
    route: { path: '/api/v1/players/:id' },
    ...extra,
  }) as unknown as Request;

const response = (statusCode: number, writableEnded = true) =>
  ({ statusCode, writableEnded }) as unknown as Response;

describe('loggerOptions', () => {
  it("writes the contract's fields: an ISO timestamp, the level by name, the service and environment — no process or host", () => {
    const lines: string[] = [];
    const logger = pino(loggerOptions('worker', 'staging', 'info'), {
      write: (line: string) => lines.push(line),
    });

    logger.info({ event: 'job.done' }, 'done');
    logger.debug('below the level');

    expect(lines).toHaveLength(1);
    const { timestamp, ...entry } = JSON.parse(lines[0]) as Record<
      string,
      unknown
    >;
    expect(timestamp).toMatch(ISO_INSTANT);
    expect(entry).toEqual({
      level: 'info',
      service: 'worker',
      environment: 'staging',
      event: 'job.done',
      msg: 'done',
    });
  });

  it('logs from debug in development, info where it is deployed, errors in tests', () => {
    expect(defaultLogSink('development').level).toBe('debug');
    expect(defaultLogSink('staging').level).toBe('info');
    expect(defaultLogSink('production').level).toBe('info');
    expect(defaultLogSink('test').level).toBe('error');
  });
});

describe('the access log', () => {
  const entry = option('customSuccessObject');
  const failure = option('customErrorObject');
  const line = option('customSuccessMessage');
  const levelOf = option('customLogLevel');

  it('names the method, route template, status and duration — never the URL, a header or a body', () => {
    const logged = entry(request(), response(200), {
      durationMs: 12,
    }) as object;

    expect(logged).toEqual({
      event: 'http.request',
      method: 'GET',
      route: '/api/v1/players/:id',
      status: 200,
      durationMs: 12,
    });
    expect(line(request(), response(200), 12)).toBe(
      'GET /api/v1/players/:id 200',
    );
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it('attributes a request to the tenant and member of its verified session', () => {
    const signedIn = request({
      tenantId: 'tenant-uuid',
      user: { id: 'member-uuid', email: 'coach@north.test' },
    });
    expect(entry(signedIn, response(200), { durationMs: 3 })).toMatchObject({
      tenantId: 'tenant-uuid',
      actorId: 'member-uuid',
    });
    expect(JSON.stringify(entry(signedIn, response(200), {}))).not.toContain(
      'north.test',
    );
  });

  it('attributes an anonymous request to no tenant', () => {
    const logged = entry(request(), response(401), { durationMs: 1 }) as object;
    expect(logged).not.toHaveProperty('tenantId');
    expect(logged).not.toHaveProperty('actorId');
  });

  it('logs a failed request with the same fields, and never the error', () => {
    const logged = failure(request(), response(500), new Error(SECRET), {
      durationMs: 9,
      err: new Error(SECRET),
    }) as object;
    expect(logged).toEqual({
      event: 'http.request',
      method: 'GET',
      route: '/api/v1/players/:id',
      status: 500,
      durationMs: 9,
    });
  });

  it('marks a request its client left before the response ended', () => {
    expect(entry(request(), response(200, false), {})).toMatchObject({
      aborted: true,
    });
  });

  it('logs a success at info, a refusal at warn, a failure at error', () => {
    expect(levelOf(request(), response(200))).toBe('info');
    expect(levelOf(request(), response(304))).toBe('info');
    expect(levelOf(request(), response(404))).toBe('warn');
    expect(levelOf(request(), response(503))).toBe('error');
    expect(levelOf(request(), response(200), new Error('aborted'))).toBe(
      'error',
    );
  });
});
