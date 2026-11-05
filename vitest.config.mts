import swc from 'unplugin-swc';
import { defineConfig, type TestUserConfig } from 'vitest/config';

// One runner, five projects with disjoint globs (ADR-0024): unit tests beside
// the code; integration and API tests under test/, against a real PostgreSQL in
// a schema of their own per run; the identity provider's admin calls, against
// the local stack's Keycloak; and the production image's test, which
// scripts/smoke-start.sh runs against the container it starts. SWC compiles the TypeScript so Nest's
// decorator metadata survives; Vitest loads ES-module packages natively.
const compile = () => swc.vite({ module: { type: 'es6' } });

// Synthetic, test-only configuration. Never a real secret. DATABASE_URL is
// the run's own schema, set by test/harness/setup-env.ts.
const testEnv = {
  NODE_ENV: 'test',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  CORS_ORIGIN: 'https://app.agency.test',
  MAIL_FROM: 'no-reply@agency.test',
  OIDC_ISSUER: 'https://idp.agency.test/realms/sadara',
  OIDC_CLIENT_ID: 'sadara-api',
  OIDC_CLIENT_SECRET: 'test-placeholder-not-a-secret',
  OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
  OIDC_ADMIN_CLIENT_SECRET: 'test-placeholder-not-a-secret',
  CSRF_SECRET: 'test-placeholder-not-a-secret-csrf-key',
};

const onDatabase = {
  environment: 'node',
  globalSetup: ['test/harness/global-setup.ts'],
  setupFiles: ['test/harness/setup-env.ts'],
  env: testEnv,
  testTimeout: 60_000,
  hookTimeout: 120_000,
} satisfies TestUserConfig;

export default defineConfig({
  test: {
    passWithNoTests: false, // an empty suite is a failure, never a pass
    projects: [
      {
        plugins: [compile()],
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [compile()],
        test: {
          name: 'integration',
          include: ['test/**/*.integration-spec.ts'],
          ...onDatabase,
        },
      },
      {
        plugins: [compile()],
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          ...onDatabase,
        },
      },
      {
        // Against the local stack's Keycloak (0.5.4), not in CI, which has none:
        // `npx vitest run --project keycloak` after `just up` in the umbrella.
        plugins: [compile()],
        test: {
          name: 'keycloak',
          include: ['test/**/*.keycloak-spec.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'image',
          include: ['test/**/*.image-spec.ts'],
          environment: 'node',
          testTimeout: 30_000,
        },
      },
    ],
  },
});
