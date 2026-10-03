import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { describeError, stackFramesOf } from '../logging/describe-error';
import { routeTemplateOf } from '../logging/route-template';

export interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error?: string;
  timestamp: string;
  path: string;
}

/**
 * A message that quotes the request's full URL — Nest's own not-found
 * message, `Cannot GET /api/x?token=…`, does — quotes its path instead.
 */
function withoutQuery(
  message: string | string[],
  request: Request,
): string | string[] {
  const strip = (text: string) =>
    request.originalUrl === request.path
      ? text
      : text.split(request.originalUrl).join(request.path);
  return Array.isArray(message) ? message.map(strip) : strip(message);
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode: number;
    let message: string | string[];
    let error: string | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const responseBody = exception.getResponse();

      if (typeof responseBody === 'string') {
        message = responseBody;
      } else if (typeof responseBody === 'object') {
        message = (responseBody as any).message || exception.message;
        error = (responseBody as any).error;
      } else {
        message = exception.message;
      }
    } else {
      statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      error = 'Internal Server Error';

      // The class and the frames, never the message: it can carry the
      // values that caused the error (describe-error.ts).
      this.logger.error(
        `Unhandled ${describeError(exception)} on ${request.method} ${routeTemplateOf(request)}`,
        stackFramesOf(exception),
      );
    }

    const errorResponse: ErrorResponse = {
      statusCode,
      message: withoutQuery(message, request),
      error,
      timestamp: new Date().toISOString(),
      path: request.path, // never request.url: the query can carry a token
    };

    response.status(statusCode).json(errorResponse);
  }
}
