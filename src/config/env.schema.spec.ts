import { ConfigModule } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { configOptions, parseEnv } from './env.schema';

// A complete, valid environment — synthetic values only.
const valid = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgresql://sadara_app:not-a-real-password@db.agency.test:5432/sadara',
  JWT_SECRET: 'test-only-signing-value-for-the-schema-spec',
  JWT_REFRESH_SECRET: 'test-only-refresh-value-for-the-schema-spec',
  CORS_ORIGIN: 'https://app.agency.test',
  MAIL_FROM: 'no-reply@agency.test',
} as const;

const failureOf = (raw: Record<string, unknown>): string => {
  try {
    parseEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the environment was accepted');
};

describe('the environment schema', () => {
  it('accepts a complete environment and fills the defaults', () => {
    expect(parseEnv(valid)).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3000,
      API_PREFIX: 'api',
      REDIS_PORT: 6379,
    });
  });

  it('boot_fails_without_a_required_secret', async () => {
    for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL']) {
      const { [name as keyof typeof valid]: _omitted, ...rest } = valid;
      expect(failureOf(rest)).toContain(`${name} is missing`);
      expect(failureOf({ ...rest, [name]: '' })).toContain(
        `${name} is missing`,
      );
    }

    // The module the application boots with refuses too, before anything starts.
    for (const [name, value] of Object.entries(valid)) vi.stubEnv(name, value);
    vi.stubEnv('JWT_SECRET', undefined);
    await expect(
      ConfigModule.forRoot({ ...configOptions, ignoreEnvFile: true }),
    ).rejects.toThrow('JWT_SECRET is missing');
    vi.unstubAllEnvs();
  });

  it('refuses a weak secret and an unknown NODE_ENV', () => {
    expect(
      failureOf({ ...valid, JWT_SECRET: 'change-me-placeholder' }),
    ).toContain('JWT_SECRET must be at least 32 characters');
    expect(failureOf({ ...valid, NODE_ENV: undefined })).toContain(
      'NODE_ENV is missing',
    );
    expect(failureOf({ ...valid, NODE_ENV: 'prod' })).toContain(
      'NODE_ENV must be one of development, test, staging, production',
    );
  });

  it('keeps unfinished modules off unless a flag is exactly true', () => {
    expect(parseEnv(valid)).toMatchObject({
      FEATURE_MEDICAL: false,
      FEATURE_SCOUTING: false,
    });
    expect(
      parseEnv({
        ...valid,
        FEATURE_MEDICAL: 'true',
        FEATURE_SCOUTING: 'false',
      }),
    ).toMatchObject({ FEATURE_MEDICAL: true, FEATURE_SCOUTING: false });
    expect(failureOf({ ...valid, FEATURE_SCOUTING: 'yes' })).toContain(
      'FEATURE_SCOUTING must be one of true, false',
    );
  });

  it('boot_errors_name_the_variable_but_not_its_value', () => {
    const canary = 'canary-value-9b2e';
    const message = failureOf({
      ...valid,
      NODE_ENV: canary,
      JWT_SECRET: canary,
      DATABASE_URL: `postgresql://user:${canary}@`,
      CORS_ORIGIN: canary,
      MAIL_FROM: canary,
      PORT: canary,
    });

    for (const name of [
      'NODE_ENV',
      'JWT_SECRET',
      'DATABASE_URL',
      'CORS_ORIGIN',
      'MAIL_FROM',
      'PORT',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain(canary);
  });
});
