import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication, LoggerService, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { answerUnknownPaths, configureApp } from '../../src/app.setup';
import { SessionGuard } from '../../src/common/guards/session.guard';
import {
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_KEYS,
} from '../../src/common/rate-limit/rate-limiter';
import { TestSessionGuard } from './session';

export interface BootedApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
}

/**
 * Boots the whole application — the real module graph and the HTTP pipeline of
 * `main.ts` — against this run's isolated schema (setup-env.ts puts it in the
 * environment). One app per test file; close it in `afterAll`.
 */
export async function bootApp(
  opts: {
    logger?: LoggerService;
    testSessions?: boolean;
    /** Test-only routes, served through the same pipeline as the app's. */
    controllers?: Type[];
    /**
     * Where this app counts its rate limits in Valkey. Each boot counts
     * apart unless two share a namespace, as two API instances share one
     * Valkey.
     */
    rateLimitNamespace?: string;
    /** TRUSTED_PROXIES, for this app only: the environment has none. */
    trustedProxies?: string[];
  } = {},
): Promise<BootedApp> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: opts.controllers,
  });
  // Nest's testing logger drops everything but errors; a test that inspects
  // the log passes its own (test/harness/log-capture.ts).
  if (opts.logger) builder.setLogger(opts.logger);
  // Signed-in requests, until real sessions exist (test/harness/session.ts).
  if (opts.testSessions) {
    builder.overrideProvider(SessionGuard).useClass(TestSessionGuard);
  }
  // Test files run at once against one Valkey: none may spend another's limits.
  const namespace = opts.rateLimitNamespace ?? randomUUID();
  builder
    .overrideProvider(RATE_LIMIT_KEY_PREFIX)
    .useValue(`${RATE_LIMIT_KEYS}test:${namespace}:`);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  if (opts.trustedProxies) app.set('trust proxy', opts.trustedProxies);
  // As main.ts does: every route first, then what none serves.
  await app.init();
  answerUnknownPaths(app);
  // Listen on 127.0.0.1 itself, on a port free there. Handed the server,
  // supertest would listen on every interface and then connect to 127.0.0.1,
  // where another process — an editor helper, a VM's port forward — may hold
  // the same port: on macOS both binds succeed, and that process answers.
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, http: request(`http://127.0.0.1:${port}`) };
}
