import {
  INestApplication,
  StandardSchemaValidationPipe,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import type { Env } from './config/env.schema';

/**
 * The HTTP pipeline: middleware, interceptors, CORS, the route prefix and
 * validation. `main.ts` and the API test harness both call it, so the tests
 * exercise the pipeline that production runs. Returns the route prefix.
 */
export function configureApp(app: INestApplication): string {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Apply global interceptors for logging and response transformation
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalInterceptors(new TransformInterceptor());

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID'],
  });

  // Global prefix for API routes
  const apiPrefix = config.get('API_PREFIX', { infer: true });
  app.setGlobalPrefix(apiPrefix);

  // Validation. A parameter that declares a Standard Schema — a Zod 4 schema
  // in `@Body({ schema })`, `@Query({ schema })` or `@Param` (ADR-0024) — is
  // validated against it and receives the schema's output; the pipe leaves
  // every other parameter alone. 0.3.2 moves the routes onto schemas and
  // retires the class-validator pipes below, leaving this one mechanism.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      disableErrorMessages:
        config.get('NODE_ENV', { infer: true }) === 'production',
    }),
  );

  return apiPrefix;
}
