import { ConfigModule } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { configOptions, parseEnv } from './env.schema';

// A complete, valid environment — synthetic values only.
const valid = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgresql://sadara_app:not-a-real-password@db.agency.test:5432/sadara',
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

  // DATABASE_URL carries the database password: the one secret the API reads
  // until sessions add theirs (0.5.6).
  it('boot_fails_without_a_required_secret', async () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(failureOf(rest)).toContain('DATABASE_URL is missing');
    expect(failureOf({ ...rest, DATABASE_URL: '' })).toContain(
      'DATABASE_URL is missing',
    );

    // The module the application boots with refuses too, before anything starts.
    for (const [name, value] of Object.entries(valid)) vi.stubEnv(name, value);
    vi.stubEnv('DATABASE_URL', undefined);
    await expect(
      ConfigModule.forRoot({ ...configOptions, ignoreEnvFile: true }),
    ).rejects.toThrow('DATABASE_URL is missing');
    vi.unstubAllEnvs();
  });

  it('refuses a database that is not PostgreSQL and an unknown NODE_ENV', () => {
    expect(
      failureOf({
        ...valid,
        DATABASE_URL: 'mysql://app@db.agency.test/sadara',
      }),
    ).toContain('DATABASE_URL must be a valid url');
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
      DATABASE_URL: `postgresql://user:${canary}@`,
      CORS_ORIGIN: canary,
      MAIL_FROM: canary,
      PORT: canary,
    });

    for (const name of [
      'NODE_ENV',
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
