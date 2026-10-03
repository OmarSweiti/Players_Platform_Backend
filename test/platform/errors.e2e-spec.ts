import { randomBytes, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Public } from '../../src/common/decorators/public.decorator';
import {
  type ErrorCode,
  FIELD_PROBLEMS,
  PROBLEMS,
  problemTypeOf,
} from '../../src/common/errors/error-codes';
import type { ProblemDetails } from '../../src/common/filters/problem-details.filter';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { bootApp, type BootedApp } from '../harness/app';
import { LogCapture } from '../harness/log-capture';

// A random value that must never come back in an error or reach a log.
const CANARY = `canary-${randomBytes(12).toString('hex')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NewMember = z.strictObject({
  name: z.string().trim().min(1).max(100),
  age: z.number().int().min(16),
});

// Test-only routes, served through the real pipeline (test/harness/app.ts).
@Controller('probe/errors')
class ErrorsProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Post('members')
  create(@Body({ schema: NewMember }) member: z.infer<typeof NewMember>) {
    return member;
  }

  @Get('private') // not @Public(): the session guard refuses it
  private(): string {
    return 'never';
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('boom at /srv/secret');
  }

  @Public()
  @Post('missing')
  renameMissing() {
    return this.prisma.tenant.update({
      where: { id: randomUUID() },
      data: { name: 'Renamed agency' },
    });
  }

  @Public()
  @Post('duplicate')
  async createTwice() {
    const slug = `probe-${randomBytes(4).toString('hex')}`;
    await this.prisma.tenant.create({ data: { name: 'Probe agency', slug } });
    return this.prisma.tenant.create({ data: { name: 'Probe agency', slug } });
  }

  @Public()
  @Post('orphan')
  createOrphan() {
    return this.prisma.user.create({
      data: {
        tenantId: randomUUID(),
        email: 'orphan@agency.test',
        role: 'COACH',
      },
    });
  }
}

/** The response is the problem `code` names, in English; returns it. */
function expectProblem(response: Response, code: ErrorCode): ProblemDetails {
  const { status, title, message } = PROBLEMS[code];
  expect([response.status, response.headers['content-type']]).toEqual([
    status,
    'application/problem+json; charset=utf-8',
  ]);
  expect(response.body).toMatchObject({
    type: problemTypeOf(code),
    title,
    status,
    detail: message.en,
    code,
    message: message.en,
  });
  return response.body as ProblemDetails;
}

describe('one error format: RFC 9457 problem details', () => {
  const capture = new LogCapture();
  let booted: BootedApp;

  beforeAll(async () => {
    booted = await bootApp({
      logger: capture,
      controllers: [ErrorsProbeController],
    });
    capture.start();
  });

  beforeEach(() => capture.clear());

  afterAll(async () => {
    capture.stop();
    await booted?.app.close();
  });

  it('validation_errors_list_their_fields', async () => {
    const invalid = await booted.http
      .post('/api/v1/probe/errors/members')
      .send({ name: '   ', age: 12, tenantId: CANARY });

    expect(expectProblem(invalid, 'VALIDATION_FAILED').fieldErrors).toEqual([
      {
        field: '/name',
        code: 'TOO_SMALL',
        message: FIELD_PROBLEMS.TOO_SMALL.en,
      },
      {
        field: '/age',
        code: 'TOO_SMALL',
        message: FIELD_PROBLEMS.TOO_SMALL.en,
      },
      {
        field: '/tenantId',
        code: 'UNKNOWN_FIELD',
        message: FIELD_PROBLEMS.UNKNOWN_FIELD.en,
      },
    ]);
    expect(JSON.stringify(invalid.body)).not.toContain(CANARY);

    const incomplete = await booted.http
      .post('/api/v1/probe/errors/members')
      .send({ age: 30 });
    expect(expectProblem(incomplete, 'VALIDATION_FAILED').fieldErrors).toEqual([
      { field: '/name', code: 'REQUIRED', message: FIELD_PROBLEMS.REQUIRED.en },
    ]);
  });

  it('unknown_errors_leak_nothing', async () => {
    const response = await booted.http.get('/api/v1/probe/errors/boom');

    const problem = expectProblem(response, 'INTERNAL_ERROR');
    expect(problem.fieldErrors).toEqual([]);
    const answered = JSON.stringify([response.body, response.headers]);
    for (const leak of ['boom', '/srv/secret', '.ts:', 'stack']) {
      expect(answered).not.toContain(leak);
    }

    // The log names the class, the route and the request, never the message.
    expect(capture.lines.join('\n')).toContain(
      `Unhandled Error on GET /api/v1/probe/errors/boom [${problem.requestId}]`,
    );
    for (const line of capture.lines) {
      expect(line).not.toContain('boom at');
      expect(line).not.toContain('/srv/secret');
    }
  });

  it('every_error_carries_the_request_id', async () => {
    const { http } = booted;
    const responses = [
      await http.get('/api/no-such-route'), // Nest's own not-found
      await http.get('/api/v1/probe/errors/private'), // a guard's refusal
      await http.post('/api/v1/probe/errors/members').send({}), // a schema's
      await http
        .post('/api/v1/probe/errors/members')
        .set('Content-Type', 'application/json')
        .send('{"name": '), // the body parser's
      await http.get('/api/v1/probe/errors/boom'), // the unexpected
    ];
    expect(responses.map(({ status }) => status)).toEqual([
      404, 401, 400, 400, 500,
    ]);

    const ids = responses.map((response) => {
      const id = response.headers['x-request-id'];
      expect(id).toMatch(UUID);
      expect(response.body).toMatchObject({
        requestId: id,
        instance: `urn:uuid:${id}`,
      });
      return id;
    });
    expect(new Set(ids).size).toBe(ids.length);

    // A success carries one too.
    const health = await http.get('/api/health');
    expect(health.headers['x-request-id']).toMatch(UUID);
  });

  it('a_missing_record_is_a_404_not_a_500', async () => {
    // Prisma's P2025: the record an update needs does not exist.
    const response = await booted.http.post('/api/v1/probe/errors/missing');
    expectProblem(response, 'NOT_FOUND');
    expect(capture.lines.join('\n')).not.toContain('Unhandled');
  });

  it('a_broken_unique_or_foreign_key_is_a_409', async () => {
    for (const probe of ['duplicate', 'orphan']) {
      // P2002, then P2003
      expectProblem(
        await booted.http.post(`/api/v1/probe/errors/${probe}`),
        'CONFLICT',
      );
    }
  });

  it('a_body_the_parser_refuses_is_a_problem_that_quotes_nothing', async () => {
    const malformed = await booted.http
      .post('/api/v1/probe/errors/members')
      .set('Content-Type', 'application/json')
      .send(`{"name": ${CANARY}}`);
    expectProblem(malformed, 'VALIDATION_FAILED');
    expect(JSON.stringify(malformed.body)).not.toContain(CANARY);

    const oversized = await booted.http
      .post('/api/v1/probe/errors/members')
      .send({ name: 'x'.repeat(2 * 1024 * 1024), age: 30 });
    expectProblem(oversized, 'PAYLOAD_TOO_LARGE');
  });

  it('a_problem_speaks_the_language_the_client_accepts', async () => {
    const response = await booted.http
      .post('/api/v1/probe/errors/members')
      .set('Accept-Language', 'ar-JO,ar;q=0.9,en;q=0.5')
      .send({ age: 30 });

    expect(response.headers['content-language']).toBe('ar');
    expect(response.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: PROBLEMS.VALIDATION_FAILED.message.ar,
      fieldErrors: [
        {
          field: '/name',
          code: 'REQUIRED',
          message: FIELD_PROBLEMS.REQUIRED.ar,
        },
      ],
    });
  });
});
