import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import {
  answerUnknownPaths,
  APP_OPTIONS,
  configureApp,
} from '../../src/app.setup';
import { IdentityProviderPort } from '../../src/modules/identity/application/ports/identity-provider.port';
import { LOG_SINK } from '../../src/infrastructure/logging/logger-options';
import {
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_KEYS,
} from '../../src/common/rate-limit/rate-limiter';
import type { LogCapture } from './log-capture';

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
    /**
     * Captures the structured log, every level. nestjs-pino keeps one logger
     * per process, built by the first app: in a file, pass it to the first
     * bootApp.
     */
    logs?: LogCapture;
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
    /**
     * The identity provider, for this app only: the environment names one
     * that does not exist. Sign-in's tests pass the adapter, configured for a
     * test issuer (test/support/test-issuer.ts).
     */
    identityProvider?: IdentityProviderPort;
  } = {},
): Promise<BootedApp> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: opts.controllers,
  });
  // The log goes to stdout, errors only, as in every test; a test that reads
  // it captures it (test/harness/log-capture.ts).
  if (opts.logs) builder.overrideProvider(LOG_SINK).useValue(opts.logs.sink);
  if (opts.identityProvider) {
    builder
      .overrideProvider(IdentityProviderPort)
      .useValue(opts.identityProvider);
  }
  // Test files run at once against one Valkey: none may spend another's limits.
  const namespace = opts.rateLimitNamespace ?? randomUUID();
  builder
    .overrideProvider(RATE_LIMIT_KEY_PREFIX)
    .useValue(`${RATE_LIMIT_KEYS}test:${namespace}:`);
  const moduleRef = await builder.compile();
  const app =
    moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
  configureApp(app);
  if (opts.trustedProxies) app.set('trust proxy', opts.trustedProxies);
  // As main.ts does: every route first, then what none serves. An app that
  // refuses to start (a check at boot) closes what it opened before the
  // refusal reaches the test.
  try {
    await app.init();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  answerUnknownPaths(app);
  // Listen on 127.0.0.1 itself, on a port free there. Handed the server,
  // supertest would listen on every interface and then connect to 127.0.0.1,
  // where another process — an editor helper, a VM's port forward — may hold
  // the same port: on macOS both binds succeed, and that process answers.
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, http: request(`http://127.0.0.1:${port}`) };
}
