import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Post } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Public } from '../../src/common/decorators/public.decorator';
import {
  jobCorrelation,
  runCorrelatedJob,
} from '../../src/infrastructure/logging/correlation';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant } from '../harness/fixtures';
import { LogCapture } from '../harness/log-capture';
import { TEST_MEMBER_HEADER } from '../harness/session';

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};
// A queue of this file's own: no other run's worker takes its jobs.
const queue = new Queue(`logging-${randomUUID()}`, { connection });

const CANARY = `canary-${randomBytes(8).toString('hex')}`;

// Test-only routes, served through the real pipeline (test/harness/app.ts).
@Controller('probe/logging')
class LoggingProbeController {
  @Get('players/:playerId') // a member's read; not @Public()
  read() {
    return { read: true };
  }

  @Public()
  @Post('jobs') // work a request hands to the worker
  async enqueue() {
    const job = await queue.add('probe', { correlation: jobCorrelation() });
    return { jobId: job.id };
  }
}

/** The fields of an access log line, and nothing else. */
const ACCESS_FIELDS = [
  'durationMs',
  'environment',
  'event',
  'level',
  'method',
  'msg',
  'requestId',
  'route',
  'service',
  'status',
  'timestamp',
];

describe('structured logs, correlated from the request to the worker', () => {
  const capture = new LogCapture();
  let booted: BootedApp;
  let worker: Worker | undefined;

  beforeAll(async () => {
    booted = await bootApp({
      logs: capture,
      testSessions: true,
      controllers: [LoggingProbeController],
    });
    capture.start();
  });

  beforeEach(() => capture.clear());

  afterAll(async () => {
    capture.stop();
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await booted?.app.close();
  });

  it('a_request_id_reaches_the_worker_log', async () => {
    // The worker, as the worker process will run one (0.7.6): each job's
    // handler runs in the correlation the job carries.
    const logger = await booted.app.resolve(PinoLogger);
    const handled = new Promise<Job>((resolve, reject) => {
      worker = new Worker(
        queue.name,
        (job) =>
          runCorrelatedJob(logger, job, () => {
            logger.info({ event: 'probe.handled' }, 'probe job handled');
            return Promise.resolve();
          }),
        { connection },
      );
      worker.on('completed', resolve);
      worker.on('failed', (_job, error) => reject(error));
    });

    const response = await booted.http
      .post('/api/v1/probe/logging/jobs')
      .expect(201);
    const requestId = response.headers['x-request-id'];
    const job = await handled;

    const entries = capture.entries();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'http.request',
        route: '/api/v1/probe/logging/jobs',
        status: 201,
        requestId,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: 'probe.handled',
        requestId,
        jobId: job.id,
        attempt: 1,
      }),
    );
  });

  it('logs_carry_route_templates_not_urls', async () => {
    const tenants = [await createTenant(), await createTenant()];
    const members = await Promise.all(
      tenants.map((tenant) => createMember(tenant, 'COACH')),
    );

    // A read by a member of each tenant, then one no session signs.
    const reads = [];
    for (const member of members) {
      const playerId = randomUUID();
      const response = await booted.http
        .get(`/api/v1/probe/logging/players/${playerId}`)
        .query({ search: CANARY })
        .set(TEST_MEMBER_HEADER, member.id)
        .expect(200);
      reads.push({
        member,
        playerId,
        requestId: response.headers['x-request-id'],
      });
    }
    const anonymous = await booted.http
      .get(`/api/v1/probe/logging/players/${randomUUID()}`)
      .query({ search: CANARY })
      .expect(401);
    const unmatchedId = randomUUID();
    const unmatched = await booted.http
      .get(`/api/v1/probe/logging/coaches/${unmatchedId}`)
      .query({ search: CANARY })
      .expect(404);

    const access = capture
      .entries()
      .filter(({ event }) => event === 'http.request');
    expect(access).toHaveLength(4);
    for (const { member, requestId } of reads) {
      const line = access.find((entry) => entry.requestId === requestId);
      const { timestamp, durationMs, ...fields } = line ?? {};
      expect(typeof timestamp).toBe('string');
      expect(typeof durationMs).toBe('number');
      expect(fields).toEqual({
        level: 'info',
        service: 'api',
        environment: 'test',
        requestId,
        event: 'http.request',
        method: 'GET',
        route: '/api/v1/probe/logging/players/:playerId',
        status: 200,
        tenantId: member.tenantId,
        actorId: member.id,
        msg: 'GET /api/v1/probe/logging/players/:playerId 200',
      });
    }
    // Refused before any session: logged, attributed to no tenant.
    const refused = access.find(
      (entry) => entry.requestId === anonymous.headers['x-request-id'],
    );
    expect(Object.keys(refused ?? {}).sort()).toEqual(ACCESS_FIELDS);
    expect(refused).toMatchObject({
      level: 'warn',
      route: '/api/v1/probe/logging/players/:playerId',
      status: 401,
    });

    // A path no route serves has no template to name.
    expect(
      access.find(
        (entry) => entry.requestId === unmatched.headers['x-request-id'],
      ),
    ).toMatchObject({ route: '(unmatched route)', status: 404 });

    // No line names a path's values or carries the query string.
    const everything = capture.lines.join('\n');
    for (const { playerId } of reads)
      expect(everything).not.toContain(playerId);
    expect(everything).not.toContain(unmatchedId);
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain('search=');
  });
});
