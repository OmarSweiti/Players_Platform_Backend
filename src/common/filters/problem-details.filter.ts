import { randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { problemCodeOfPrismaError } from '../../infrastructure/prisma/prisma-errors';
import { DomainError, type FieldIssue } from '../errors/domain-error';
import {
  type ErrorCode,
  FIELD_PROBLEMS,
  type FieldErrorCode,
  PROBLEMS,
  problemTypeOf,
} from '../errors/error-codes';
import { localeOf } from '../errors/locale';
import { describeError, stackFramesOf } from '../logging/describe-error';
import { REQUEST_ID_HEADER, requestIdOf } from '../logging/request-id';
import { routeTemplateOf } from '../logging/route-template';

/** An RFC 9457 problem, with Sadara's extensions (docs/reference/api.md). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string; // the occurrence, never a URL
  code: ErrorCode;
  message: string;
  requestId: string;
  fieldErrors: { field: string; code: FieldErrorCode; message: string }[];
}

/** A response names at most this many fields, however many were wrong. */
export const MAX_FIELD_ERRORS = 50;

// The code of an exception that carries nothing but an HTTP status: Nest's
// own (an unknown route, a guard's refusal, malformed JSON) and the body
// parsers'. A status the contract does not name is an internal error.
const CODE_OF_STATUS = new Map<number, ErrorCode>([
  [400, 'VALIDATION_FAILED'],
  [401, 'AUTHENTICATION_REQUIRED'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'CONFLICT'],
  [412, 'REVISION_MISMATCH'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [415, 'UNSUPPORTED_MEDIA_TYPE'],
  [428, 'PRECONDITION_REQUIRED'],
  [429, 'RATE_LIMITED'],
  [503, 'DEPENDENCY_UNAVAILABLE'],
]);

export interface Classified {
  code: ErrorCode;
  fieldIssues: readonly FieldIssue[];
  /** Nothing in the contract explains it: a 500, logged. */
  unexpected: boolean;
}

/**
 * What an exception means to a client. Only a domain error says more than
 * its code; every other exception's own message is discarded, because it
 * can quote the request — Nest's not-found message quotes the URL, its
 * malformed-JSON message quotes the body.
 */
export function classify(exception: unknown): Classified {
  if (exception instanceof DomainError) {
    const { code, fieldIssues } = exception;
    return { code, fieldIssues, unexpected: false };
  }
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : clientErrorStatusOf(exception);
  const code =
    problemCodeOfPrismaError(exception) ??
    (status === undefined ? undefined : CODE_OF_STATUS.get(status));
  return code
    ? { code, fieldIssues: [], unexpected: false }
    : { code: 'INTERNAL_ERROR', fieldIssues: [], unexpected: true };
}

/** The status of a client error from the body parsers (`http-errors`). */
function clientErrorStatusOf(exception: unknown): number | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { status, expose } = exception as {
    status?: unknown;
    expose?: unknown;
  };
  return expose === true && typeof status === 'number' ? status : undefined;
}

const logger = new Logger('ProblemDetailsFilter');

/**
 * Answers `exception` as a problem: the one writer of error bodies, whether
 * Nest caught the exception (ProblemDetailsFilter) or no route took the
 * request at all (answerUnknownPaths, app.setup.ts).
 */
export function sendProblem(
  exception: unknown,
  request: Request,
  response: Response,
): void {
  const requestId = requestIdOf(request) ?? randomUUID();
  const { code, fieldIssues, unexpected } = classify(exception);
  const { status, title } = PROBLEMS[code];

  // The class and, for the unexpected, the frames — never the message: it
  // can carry the values that caused the error (describe-error.ts).
  const line = `${unexpected ? 'Unhandled' : code} ${describeError(exception)} on ${request.method} ${routeTemplateOf(request)} [${requestId}]`;
  if (unexpected) logger.error(line, stackFramesOf(exception));
  else if (status >= 500) logger.error(line); // named by the contract: no frames
  if (response.headersSent) {
    response.end(); // too late for a problem; the log has the cause
    return;
  }

  const locale = localeOf(request.headers['accept-language']);
  const message = PROBLEMS[code].message[locale];
  const problem: ProblemDetails = {
    type: problemTypeOf(code),
    title,
    status,
    detail: message,
    instance: `urn:uuid:${requestId}`,
    code,
    message,
    requestId,
    fieldErrors: fieldIssues
      .slice(0, MAX_FIELD_ERRORS)
      .map(({ field, code: fieldCode }) => ({
        field,
        code: fieldCode,
        message: FIELD_PROBLEMS[fieldCode][locale],
      })),
  };

  response
    .status(status)
    .set({ [REQUEST_ID_HEADER]: requestId, 'Content-Language': locale })
    .type('application/problem+json')
    .json(problem);
}

/**
 * Every error, from every layer, as `application/problem+json`: a route's
 * exception, a guard's refusal, an unknown route, a body the parser refused.
 * Registered once, in the pipeline production and the tests share.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendProblem(
      exception,
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
  }
}
