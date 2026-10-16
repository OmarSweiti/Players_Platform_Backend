import { type INestApplication, Logger } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { buildContract } from '../common/openapi/contract';
import type { Env } from './env.schema';

/**
 * Serves the API description at /docs — in development only, and only when
 * NODE_ENV says so explicitly: staging and production never publish it. It
 * is the committed contract's document (src/common/openapi/contract.ts); a
 * route that does not declare its responses yet leaves /docs off, with a
 * warning, rather than stopping the server. Returns whether it is served.
 */
export function setupSwagger(
  app: INestApplication,
  nodeEnv: Env['NODE_ENV'],
): boolean {
  if (nodeEnv !== 'development') return false;
  try {
    SwaggerModule.setup('docs', app, buildContract(app));
    return true;
  } catch (error) {
    new Logger('Swagger').warn(
      `API description not served: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return false;
  }
}
