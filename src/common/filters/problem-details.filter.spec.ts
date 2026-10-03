import {
  type ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationFailedError } from '../errors/domain-error';
import { FIELD_PROBLEMS, PROBLEMS } from '../errors/error-codes';
import {
  classify,
  MAX_FIELD_ERRORS,
  ProblemDetailsFilter,
  type ProblemDetails,
} from './problem-details.filter';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on slug', {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

// What Express's body parsers throw (http-errors).
const parserError = (status: number) =>
  Object.assign(new Error('request entity too large'), {
    status,
    statusCode: status,
    expose: status < 500,
  });

describe('classify', () => {
  it('takes a domain error at its word', () => {
    const fieldIssues = [{ field: '/age', code: 'TOO_SMALL' as const }];
    expect(
      classify(new ValidationFailedError('too young', fieldIssues)),
    ).toEqual({ code: 'VALIDATION_FAILED', fieldIssues, unexpected: false });
    expect(classify(new NotFoundError('Player not found'))).toMatchObject({
      code: 'NOT_FOUND',
      fieldIssues: [],
    });
  });

  it.each([
    [
      new BadRequestException('Unexpected token s, "{"name": secret"'),
      'VALIDATION_FAILED',
    ],
    [new UnauthorizedException(), 'AUTHENTICATION_REQUIRED'],
    [new ForbiddenException('Insufficient role permissions'), 'FORBIDDEN'],
    [new NotFoundException('Cannot GET /api/x?token=secret'), 'NOT_FOUND'],
    [prismaError('P2002'), 'CONFLICT'],
    [prismaError('P2003'), 'CONFLICT'],
    [prismaError('P2025'), 'NOT_FOUND'],
    [parserError(413), 'PAYLOAD_TOO_LARGE'],
    [parserError(415), 'UNSUPPORTED_MEDIA_TYPE'],
  ])('maps %s to %s', (exception, code) => {
    expect(classify(exception)).toEqual({
      code,
      fieldIssues: [],
      unexpected: false,
    });
  });

  it.each([
    new Error('boom at /srv/secret'),
    new InternalServerErrorException(),
    new HttpException('I am a teapot', 418), // a status the contract does not name
    prismaError('P2034'),
    parserError(500),
    'a thrown string',
    undefined,
  ])('treats %s as unexpected', (exception) => {
    expect(classify(exception)).toEqual({
      code: 'INTERNAL_ERROR',
      fieldIssues: [],
      unexpected: true,
    });
  });
});

describe('ProblemDetailsFilter', () => {
  function answer(exception: unknown, headers: Record<string, string> = {}) {
    const sent: {
      status?: number;
      type?: string;
      headers: object;
      body?: ProblemDetails;
    } = { headers: {} };
    const response = {
      headersSent: false,
      status(status: number) {
        sent.status = status;
        return this;
      },
      set(fields: object) {
        Object.assign(sent.headers, fields);
        return this;
      },
      type(type: string) {
        sent.type = type;
        return this;
      },
      json(body: ProblemDetails) {
        sent.body = body;
        return this;
      },
    };
    const request = { method: 'POST', headers, route: { path: '/api/probe' } };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;
    new ProblemDetailsFilter().catch(exception, host);
    return sent;
  }

  it('answers application/problem+json, in the language asked for', () => {
    const sent = answer(
      new ValidationFailedError('too young', [
        { field: '/age', code: 'TOO_SMALL' },
      ]),
      { 'accept-language': 'ar' },
    );

    expect(sent).toMatchObject({
      status: 400,
      type: 'application/problem+json',
      headers: { 'Content-Language': 'ar' },
    });
    expect(sent.body).toMatchObject({
      type: 'urn:sadara:problem:validation-failed',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      message: PROBLEMS.VALIDATION_FAILED.message.ar,
      detail: PROBLEMS.VALIDATION_FAILED.message.ar,
      fieldErrors: [
        {
          field: '/age',
          code: 'TOO_SMALL',
          message: FIELD_PROBLEMS.TOO_SMALL.ar,
        },
      ],
    });
    expect(sent.body?.instance).toBe(`urn:uuid:${sent.body?.requestId}`);
    expect(JSON.stringify(sent.body)).not.toContain('too young');
  });

  it('names at most MAX_FIELD_ERRORS fields', () => {
    const fieldIssues = Array.from(
      { length: MAX_FIELD_ERRORS + 10 },
      (_, i) => ({
        field: `/key${i}`,
        code: 'UNKNOWN_FIELD' as const,
      }),
    );
    const sent = answer(new ValidationFailedError('many', fieldIssues));
    expect(sent.body?.fieldErrors).toHaveLength(MAX_FIELD_ERRORS);
  });
});
