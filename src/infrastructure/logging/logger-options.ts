import type { Request, Response } from 'express';
import type { DestinationStream, LevelWithSilent, LoggerOptions } from 'pino';
import type { Options } from 'pino-http';
import { requestIdOf } from '../../common/logging/request-id';
import { routeTemplateOf } from '../../common/logging/route-template';
import type { Env } from '../../config/env.schema';
import { newRequestId } from './correlation';

// The fields of docs/reference/observability.md, "Safe event contract": one
// JSON object per line, built from named values — never a serialized request,
// response or exception.

/** The process that writes the line. */
export type Service = 'api' | 'worker';

/** Where the log goes and from which level. */
export interface LogSink {
  level: LevelWithSilent;
  /** Absent: pino's own writer to stdout. */
  stream?: DestinationStream;
}

/** The sink the logging module writes to; a test replaces it to read the log. */
export const LOG_SINK = Symbol('LOG_SINK');

const LEVEL_OF: Record<Env['NODE_ENV'], LevelWithSilent> = {
  development: 'debug',
  // Errors only, as Nest's testing logger printed them; a test that reads the
  // log captures every level (test/harness/log-capture.ts).
  test: 'error',
  staging: 'info',
  production: 'info',
};

export function defaultLogSink(environment: Env['NODE_ENV']): LogSink {
  return { level: LEVEL_OF[environment] };
}

/** What every line carries: when, how severe, and which process wrote it. */
export function loggerOptions(
  service: Service,
  environment: Env['NODE_ENV'],
  level: LevelWithSilent,
): LoggerOptions {
  return {
    level,
    base: { service, environment }, // no process id or host name
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label }) },
  };
}

type AttributedRequest = Request & {
  tenantId?: unknown;
  user?: { id?: unknown };
};

/**
 * The access log: a line per request once its response ends — the method,
 * the route template, the status, the duration, and the tenant and member of
 * a verified session. Never the URL, a header, a body or an address. Lines
 * logged while the request runs carry its `requestId` alone.
 */
export function accessLogOptions(
  environment: Env['NODE_ENV'],
  level: LevelWithSilent,
): Options<Request, Response> {
  return {
    ...loggerOptions('api', environment, level),
    // The id assignRequestId gave the request, handed over.
    genReqId: (request) => requestIdOf(request) ?? newRequestId(),
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    customLogLevel: (_request, response, error) => {
      if (error || response.statusCode >= 500) return 'error';
      return response.statusCode >= 400 ? 'warn' : 'info';
    },
    customSuccessMessage: accessLine,
    customErrorMessage: accessLine,
    customSuccessObject: (request, response, value: { durationMs?: number }) =>
      accessEntry(request, response, value.durationMs),
    customErrorObject: (
      request,
      response,
      _error,
      value: { durationMs?: number },
    ) => accessEntry(request, response, value.durationMs),
  };
}

function accessLine(request: Request, response: Response): string {
  return `${request.method} ${routeTemplateOf(request)} ${response.statusCode}`;
}

function accessEntry(
  request: AttributedRequest,
  response: Response,
  durationMs: number | undefined,
): object {
  return {
    event: 'http.request',
    method: request.method,
    route: routeTemplateOf(request),
    status: response.statusCode,
    durationMs,
    ...sessionAttributionOf(request),
    // The client left before the response ended.
    ...(response.writableEnded ? {} : { aborted: true }),
  };
}

/**
 * The tenant and member of the verified session, as the session guard set
 * them — opaque ids, never a value the client sent: an anonymous request is
 * attributed to no tenant (SYS-TEN-007).
 */
function sessionAttributionOf(request: AttributedRequest): {
  tenantId?: string;
  actorId?: string;
} {
  const { tenantId } = request;
  const actorId = request.user?.id;
  return {
    ...(typeof tenantId === 'string' ? { tenantId } : {}),
    ...(typeof actorId === 'string' ? { actorId } : {}),
  };
}
