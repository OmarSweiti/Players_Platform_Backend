import swc from 'unplugin-swc';
import { defineConfig, type TestUserConfig } from 'vitest/config';

// One runner, three projects with disjoint globs (ADR-0024): unit tests beside
// the code; integration and API tests under test/, against a real PostgreSQL in
// a schema of their own per run. SWC compiles the TypeScript so Nest's
// decorator metadata survives; Vitest loads ES-module packages natively.
const compile = () => swc.vite({ module: { type: 'es6' } });

// Synthetic, test-only configuration. Never a real secret.
const testEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-only-signing-value',
  JWT_REFRESH_SECRET: 'test-only-refresh-value',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
};

const onDatabase = {
  environment: 'node',
  globalSetup: ['test/harness/global-setup.ts'],
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
    ],
  },
});
