import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureRoutes } from './app.setup';
import { buildContract } from './common/openapi/contract';
import { DEFAULT_API_PREFIX } from './config/env.schema';

/** The committed contract, from the repository root (ADR-0010). */
export const CONTRACT_FILE = 'openapi/openapi.json';

/**
 * The API's contract, from the routes AppModule mounts. Nest's preview mode
 * reads the module graph without creating a provider, so nothing connects to
 * the database, Valkey or the identity provider. The paths are those of the
 * default prefix, which the web app calls.
 */
export async function generateContract(): Promise<OpenAPIObject> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    preview: true,
    logger: false,
  });
  try {
    configureRoutes(app, DEFAULT_API_PREFIX);
    return buildContract(app);
  } finally {
    await app.close();
  }
}

/** The contract as the committed file holds it. */
export function serializeContract(contract: OpenAPIObject): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
