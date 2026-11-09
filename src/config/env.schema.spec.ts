import { ConfigModule } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import {
  configOptions,
  parseEnv,
  parseEventImportEnv,
  parseProvisioningEnv,
} from './env.schema';

// A complete, valid environment — synthetic values only.
const valid = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgresql://sadara_app:not-a-real-password@db.agency.test:5432/sadara',
  CORS_ORIGIN: 'https://app.agency.test',
  MAIL_FROM: 'no-reply@agency.test',
  OIDC_ISSUER: 'https://idp.agency.test/realms/sadara',
  OIDC_CLIENT_ID: 'sadara-api',
  OIDC_CLIENT_SECRET: 'not-a-real-client-secret',
  OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
  OIDC_ADMIN_CLIENT_SECRET: 'not-a-real-admin-secret',
  CSRF_SECRET: 'not-a-real-csrf-key-not-a-real-csrf-key',
  SECURITY_EVENT_KEY: 'not-a-real-event-key-not-a-real-event-key',
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

  it('believes no proxy unless told, and nothing that is not one', () => {
    expect(parseEnv(valid)).toMatchObject({ TRUSTED_PROXIES: [] });
    expect(
      parseEnv({
        ...valid,
        TRUSTED_PROXIES: ' loopback, 10.0.0.0/8 ,fd00::/8, 192.0.2.10',
      }),
    ).toMatchObject({
      TRUSTED_PROXIES: ['loopback', '10.0.0.0/8', 'fd00::/8', '192.0.2.10'],
    });
    // A host name, or `true` — which Express would read as "every proxy".
    for (const list of ['loopback, proxy.agency.test', 'true', '10.0.0.0/33']) {
      expect([list, failureOf({ ...valid, TRUSTED_PROXIES: list })]).toEqual([
        list,
        expect.stringContaining('TRUSTED_PROXIES is invalid'),
      ]);
    }
  });

  it('takes the hosts that name a tenant in lower case, the launch pair together', () => {
    expect(parseEnv(valid)).toMatchObject({ DEFAULT_TENANT_HOSTS: [] });
    expect(
      parseEnv({
        ...valid,
        APEX_DOMAIN: 'sadara.example',
        DEFAULT_TENANT_SLUG: 'launch-agency',
        DEFAULT_TENANT_HOSTS: ' app.agency.test ,agency.test',
      }),
    ).toMatchObject({
      APEX_DOMAIN: 'sadara.example',
      DEFAULT_TENANT_SLUG: 'launch-agency',
      DEFAULT_TENANT_HOSTS: ['app.agency.test', 'agency.test'],
    });
    for (const [name, value] of [
      ['APEX_DOMAIN', 'Sadara.example'],
      ['APEX_DOMAIN', 'https://sadara.example'],
      ['DEFAULT_TENANT_SLUG', 'Launch_Agency'],
    ] as const) {
      expect([name, failureOf({ ...valid, [name]: value })]).toEqual([
        name,
        expect.stringMatching(
          new RegExp(`${name} must be a lower-case (host name|DNS label)`),
        ),
      ]);
    }
    expect(
      failureOf({ ...valid, DEFAULT_TENANT_HOSTS: 'agency.test:443' }),
    ).toContain('DEFAULT_TENANT_HOSTS must be lower-case host names');
    // Left empty in .env, they are unset.
    expect(
      parseEnv({
        ...valid,
        APEX_DOMAIN: '',
        DEFAULT_TENANT_SLUG: '',
        DEFAULT_TENANT_HOSTS: '',
      }),
    ).toMatchObject({ DEFAULT_TENANT_HOSTS: [] });
    // One without the other maps no host, or maps hosts to no tenant.
    expect(failureOf({ ...valid, DEFAULT_TENANT_SLUG: 'launch' })).toContain(
      'DEFAULT_TENANT_HOSTS is missing',
    );
    expect(
      failureOf({ ...valid, DEFAULT_TENANT_HOSTS: 'agency.test' }),
    ).toContain('DEFAULT_TENANT_SLUG is missing');
  });

  it('takes the identity provider over HTTPS, or HTTP on this machine, with both secrets', () => {
    for (const local of [
      'http://localhost:8080/realms/sadara',
      'http://127.0.0.1:8080/realms/sadara',
      'http://[::1]:8080/realms/sadara',
    ]) {
      expect(parseEnv({ ...valid, OIDC_ISSUER: local }).OIDC_ISSUER).toBe(
        local,
      );
    }
    for (const refused of [
      'http://idp.agency.test/realms/sadara', // plain HTTP off this machine
      'https://idp.agency.test/realms/sadara?realm=other',
      'https://idp.agency.test/realms/sadara#fragment',
      'ftp://idp.agency.test/realms/sadara',
    ]) {
      expect(failureOf({ ...valid, OIDC_ISSUER: refused })).toContain(
        'OIDC_ISSUER must be',
      );
    }
    for (const secret of ['OIDC_CLIENT_SECRET', 'OIDC_ADMIN_CLIENT_SECRET']) {
      const { [secret as keyof typeof valid]: _omitted, ...rest } = valid;
      expect(failureOf(rest)).toContain(`${secret} is missing`);
      expect(failureOf({ ...valid, [secret]: 'short' })).toContain(
        `${secret} must be at least 16 characters`,
      );
    }
    expect(failureOf({ ...valid, OIDC_CLIENT_ID: 'Sadara API' })).toContain(
      'OIDC_CLIENT_ID must be a client id',
    );
  });

  it('takes a CSRF key, and the previous one while it rotates', () => {
    const { CSRF_SECRET: _omitted, ...rest } = valid;
    expect(failureOf(rest)).toContain('CSRF_SECRET is missing');
    expect(failureOf({ ...valid, CSRF_SECRET: 'too-short' })).toContain(
      'CSRF_SECRET must be at least 32 characters',
    );
    expect(parseEnv(valid).CSRF_SECRET_PREVIOUS).toBeUndefined();
    expect(
      parseEnv({ ...valid, CSRF_SECRET_PREVIOUS: '' }).CSRF_SECRET_PREVIOUS,
    ).toBeUndefined();
    expect(
      failureOf({ ...valid, CSRF_SECRET_PREVIOUS: 'too-short' }),
    ).toContain('CSRF_SECRET_PREVIOUS must be at least 32 characters');
  });

  it('the_provisioning_command_needs_its_own_account_besides_the_apis', () => {
    const provisioning = {
      ...valid,
      OIDC_PROVISIONER_CLIENT_ID: 'sadara-provisioner',
      OIDC_PROVISIONER_CLIENT_SECRET: 'not-a-real-provisioner-secret',
    };
    expect(parseProvisioningEnv(provisioning)).toMatchObject({
      OIDC_PROVISIONER_CLIENT_ID: 'sadara-provisioner',
      OIDC_ISSUER: valid.OIDC_ISSUER,
    });
    // The API does not need it: its own environment holds without.
    expect(() => parseEnv(valid)).not.toThrow();
    const message = (() => {
      try {
        parseProvisioningEnv({
          ...valid,
          OIDC_PROVISIONER_CLIENT_SECRET: 'short',
        });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toContain('OIDC_PROVISIONER_CLIENT_ID is missing');
    expect(message).toContain(
      'OIDC_PROVISIONER_CLIENT_SECRET must be at least 16 characters',
    );
    expect(message).not.toContain('short');
  });

  it('takes a key of its own for security events, with no default', () => {
    const { SECURITY_EVENT_KEY: _omitted, ...rest } = valid;
    expect(failureOf(rest)).toContain('SECURITY_EVENT_KEY is missing');
    expect(failureOf({ ...valid, SECURITY_EVENT_KEY: 'too-short' })).toContain(
      'SECURITY_EVENT_KEY must be at least 32 characters',
    );
  });

  it('the_event_import_needs_its_own_account_besides_the_apis', () => {
    expect(
      parseEventImportEnv({
        ...valid,
        OIDC_EVENTS_CLIENT_ID: 'sadara-events',
        OIDC_EVENTS_CLIENT_SECRET: 'not-a-real-events-secret',
      }),
    ).toMatchObject({
      OIDC_EVENTS_CLIENT_ID: 'sadara-events',
      OIDC_ADMIN_CLIENT_ID: valid.OIDC_ADMIN_CLIENT_ID,
    });
    // The API does not need it, and the command names what it lacks in
    // either environment, never a value.
    expect(() => parseEnv(valid)).not.toThrow();
    const { CSRF_SECRET: _omitted, ...withoutCsrf } = valid;
    const message = (() => {
      try {
        parseEventImportEnv({
          ...withoutCsrf,
          OIDC_EVENTS_CLIENT_SECRET: 'short',
        });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    })();
    expect(message).toContain('CSRF_SECRET is missing');
    expect(message).toContain('OIDC_EVENTS_CLIENT_ID is missing');
    expect(message).toContain(
      'OIDC_EVENTS_CLIENT_SECRET must be at least 16 characters',
    );
    expect(message).not.toContain('short');
  });

  it('refuses a database connection as the owner, the migrator or the superuser', () => {
    for (const role of [
      'sadara_owner',
      'sadara_migrator',
      'postgres',
      '%70ostgres',
    ]) {
      const message = failureOf({
        ...valid,
        DATABASE_URL: `postgresql://${role}:not-a-real-password@db.agency.test:5432/sadara`,
      });
      expect(message).toContain(
        'DATABASE_URL must connect as the runtime role, never as the owner, the migrator or a superuser',
      );
      expect(message).not.toContain('not-a-real-password');
    }
    expect(parseEnv(valid).DATABASE_URL).toBe(valid.DATABASE_URL);
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
      TRUSTED_PROXIES: canary,
      OIDC_ISSUER: `https://idp.agency.test/?${canary}`,
      OIDC_CLIENT_ID: `Client ${canary}`,
    });

    for (const name of [
      'NODE_ENV',
      'DATABASE_URL',
      'CORS_ORIGIN',
      'MAIL_FROM',
      'PORT',
      'TRUSTED_PROXIES',
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain(canary);
  });
});
