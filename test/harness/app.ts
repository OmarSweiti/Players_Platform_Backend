import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

export interface BootedApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
}

/**
 * Boots the whole application — the real module graph and the HTTP pipeline of
 * `main.ts` — against this run's isolated schema. One app per test file; close
 * it in `afterAll`.
 */
export async function bootApp(
  opts: { logger?: LoggerService } = {},
): Promise<BootedApp> {
  process.env.DATABASE_URL = inject('databaseUrl');
  const builder = Test.createTestingModule({ imports: [AppModule] });
  // Nest's testing logger drops everything but errors; a test that inspects
  // the log passes its own (test/harness/log-capture.ts).
  if (opts.logger) builder.setLogger(opts.logger);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  // Nest types its HTTP server as `any`; supertest wants a Node server.
  const server = app.getHttpServer() as Parameters<typeof request>[0];
  return { app, http: request(server) };
}
