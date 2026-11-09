import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/import-security-events';
import { migrationPrisma } from '../harness/fixtures';
import { TestIssuer } from '../support/test-issuer';

// The security-event import (0.7.3; DB-61), in-process, as an operator runs
// it: arguments, environment, exit code and printed report. The identity
// provider is an issuer in this process that answers as Keycloak's admin API
// does (test/support/test-issuer.ts); the database is this run's own schema.
// The real realm's event reader is proved against the local stack's Keycloak
// (import-security-events.keycloak-spec.ts).

describe('the security-event import command', () => {
  let issuer: TestIssuer;
  let env: Record<string, string | undefined>;
  const now = new Date();
  const typed = 'typed-at-the-provider@agency.test';

  /** The command, with its output; arguments as an operator types them. */
  async function importing(
    argv: string[],
    settings: Record<string, string | undefined> = env,
  ) {
    let out = '';
    let err = '';
    const code = await run(
      argv,
      settings,
      (text) => (out += text),
      (text) => (err += text),
      () => now,
    );
    return { code, out, err };
  }

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    env = {
      ...process.env,
      OIDC_ISSUER: issuer.issuer,
      OIDC_EVENTS_CLIENT_ID: issuer.eventReaderId,
      OIDC_EVENTS_CLIENT_SECRET: issuer.eventReaderSecret,
    };
    issuer.events.login.push(
      {
        id: randomUUID(),
        time: now.getTime() - 60_000,
        type: 'LOGIN_ERROR',
        clientId: 'sadara-api',
        ipAddress: '203.0.113.80',
        error: 'user_not_found',
        details: { username: typed },
      },
      {
        id: randomUUID(),
        time: now.getTime() - 3 * 3_600_000,
        type: 'LOGIN_ERROR',
        clientId: 'sadara-api',
        ipAddress: '203.0.113.81',
        error: 'invalid_user_credentials',
      },
    );
  });

  afterAll(async () => {
    await issuer?.close();
  });

  it('the_import_command_reports_counts_and_never_a_value', async () => {
    // The last hour's: one event, imported; its report holds counts only.
    const lastHour = await importing(['--hours', '1']);
    expect(lastHour.code).toBe(0);
    expect(lastHour.err).toBe('');
    expect(JSON.parse(lastHour.out)).toEqual({
      since: new Date(now.getTime() - 3_600_000).toISOString(),
      read: 1,
      imported: 1,
      alreadyKept: 0,
      unreadable: 0,
      complete: true,
    });
    for (const value of [typed, '203.0.113.80']) {
      expect(lastHour.out).not.toContain(value);
    }
    const [id] = issuer.events.login.map((event) => event.id as string);
    expect(
      await migrationPrisma().securityEvent.findUnique({
        where: { providerEventId: `login:${id}` },
        select: { eventType: true, outcome: true, reasonCode: true },
      }),
    ).toEqual({
      eventType: 'provider.login_error',
      outcome: 'REFUSED',
      reasonCode: 'user_not_found',
    });

    // The default window, a day: the older one too, the first not again.
    const lastDay = await importing([]);
    expect(lastDay.code).toBe(0);
    expect(JSON.parse(lastDay.out)).toMatchObject({
      read: 2,
      imported: 1,
      alreadyKept: 1,
      complete: true,
    });

    // A window holding more than the limit: the newest, and said so.
    const bounded = await importing(['--limit', '1']);
    expect(bounded.code).toBe(0);
    expect(JSON.parse(bounded.out)).toMatchObject({
      read: 1,
      complete: false,
    });
    expect(bounded.err).toContain('more events than the limit');
  });

  it('refuses_wrong_options_and_settings_without_echoing_them', async () => {
    for (const argv of [
      ['--hours', '0'],
      ['--hours', '721'],
      ['--limit', 'many'],
      ['--days', '1'],
      ['positional'],
    ]) {
      const refused = await importing(argv);
      expect([argv, refused.code, refused.out]).toEqual([argv, 2, '']);
      expect(refused.err).toContain('Usage: npm run security-events:import');
    }

    // The event reader's account is the command's own: without it, nothing
    // runs; what is wrong is named, never a value.
    const secret = 'short-secret';
    const { OIDC_EVENTS_CLIENT_ID: _id, ...withoutId } = env;
    const unset = await importing([], {
      ...withoutId,
      OIDC_EVENTS_CLIENT_SECRET: secret,
    });
    expect(unset.code).toBe(2);
    expect(unset.err).toContain('OIDC_EVENTS_CLIENT_ID is missing');
    expect(unset.err).toContain(
      'OIDC_EVENTS_CLIENT_SECRET must be at least 16 characters',
    );
    expect(unset.err).not.toContain(secret);

    // A reader the provider does not know: the import fails, and says so.
    const refused = await importing([], {
      ...env,
      OIDC_EVENTS_CLIENT_SECRET: 'not-the-readers-secret',
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe('');
    expect(refused.err).toContain('AUTHENTICATION_REQUIRED');
    expect(refused.err).not.toContain('not-the-readers-secret');

    const help = await importing(['--help']);
    expect([help.code, help.err]).toEqual([0, '']);
    expect(help.out).toContain('--hours');
  });
});
