import {
  INestApplication,
  NotFoundException,
  RequestMethod,
  StandardSchemaValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { ValidationFailedError } from './common/errors/domain-error';
import { fieldIssuesOf } from './common/errors/schema-issues';
import {
  ProblemDetailsFilter,
  sendProblem,
} from './common/filters/problem-details.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { EnvelopeInterceptor } from './common/interceptors/envelope.interceptor';
import { assignRequestId } from './common/logging/request-id';
import type { Env } from './config/env.schema';

/** The API's version: every route is `/api/v1/…`, except the health checks. */
export const API_VERSION = '1';

/** The routes served outside the API prefix and its version: the probes. */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];

/**
 * The HTTP pipeline: middleware, interceptors, CORS, the route prefix,
 * validation and errors. `main.ts` and the API test harness both call it, so
 * the tests exercise the pipeline that production runs. Returns the prefix.
 */
export function configureApp(app: NestExpressApplication): string {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Who the client is (`request.ip`): X-Forwarded-For is believed only from
  // the proxies TRUSTED_PROXIES names, so that no client can choose the
  // address its rate limits count against (0.3.8).
  app.set('trust proxy', config.get('TRUSTED_PROXIES', { infer: true }));

  // First, so that every response carries its request id (X-Request-Id).
  app.use(assignRequestId);

  // Every error, from every layer, as RFC 9457 problem details.
  app.useGlobalFilters(new ProblemDetailsFilter());

  // The access log, then every success as `{ data }`, once.
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalInterceptors(new EnvelopeInterceptor());

  // Security - Helmet for secure HTTP headers
  app.use(helmet());

  // Compression middleware
  app.use(compression());

  // Cookie parser middleware for HTTP-only cookies
  app.use(cookieParser());

  // CORS Configuration
  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'If-Match',
    ],
    // What a browser's script may read: entity tags (0.3.6), request ids, and
    // when a refused request may be tried again (0.3.8).
    exposedHeaders: ['ETag', 'X-Request-Id', 'Retry-After'],
  });

  // Global prefix for API routes
  const apiPrefix = config.get('API_PREFIX', { infer: true });
  app.setGlobalPrefix(apiPrefix, {
    exclude: UNPREFIXED_ROUTES.map((path) => ({
      path,
      method: RequestMethod.GET,
    })),
  });
  // A breaking change gets a new version, beside the old (ADR-0010).
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: API_VERSION,
  });

  // Validation, the one mechanism (ADR-0024): every body, query and path
  // parameter declares a Zod 4 schema — `@Body({ schema })`, `@Query({ schema
  // })`, `@Param({ schema })`, built from src/common/validation/schemas.ts —
  // and receives the schema's output. A failure is VALIDATION_FAILED, naming
  // its fields.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new ValidationFailedError(
          'The input does not match its schema',
          fieldIssuesOf(issues),
        ),
    }),
  );

  return apiPrefix;
}

/**
 * Answers a path no route serves with the NOT_FOUND problem every unknown
 * API route gets — outside the API prefix too, where Nest's own not-found
 * handler does not reach. Call it after `app.init()`, so it follows every
 * route, the API description's included.
 */
export function answerUnknownPaths(app: INestApplication): void {
  app.use((request: Request, response: Response) =>
    sendProblem(new NotFoundException(), request, response),
  );
}
