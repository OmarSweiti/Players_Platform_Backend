import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { run } from '../../src/cli/import-security-events';
import { migrationPrisma } from '../harness/fixtures';

// The security-event import (0.7.3; DB-61) against the local stack's
// Keycloak — the umbrella's `just up`, with the realm's event reader,
// sadara-events — and this run's own schema. A person fails to sign in at
// the provider's own form, which Sadara never sees; the import brings the
// failure in, without what they typed. Its settings are this machine's .env
// (development-only values), with the run's database. The account it signs in
// to is made for the test, as the API's account makes one, and removed after.

const suffix = () => randomBytes(4).toString('hex');

describe('the security-event import, against Keycloak', () => {
  let env: Record<string, string>;
  let adminApi: string;
  let adminToken: string;
  const probe = `events-probe-${suffix()}@agency.test`;
  let probeId: string;

  async function tokenOf(id: string, secret: string): Promise<string> {
    const response = await fetch(
      `${env.OIDC_ISSUER}/protocol/openid-connect/token`,
      {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: id,
          client_secret: secret,
        }),
      },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { access_token: string }).access_token;
  }

  /**
   * A sign-in at the provider's own form, as a browser makes it, with a
   * password that is not the account's: the provider refuses it, and the
   * API never hears of it.
   */
  async function failToSignIn(username: string): Promise<void> {
    const authorize = new URL(
      `${env.OIDC_ISSUER}/protocol/openid-connect/auth`,
    );
    authorize.search = new URLSearchParams({
      client_id: env.OIDC_CLIENT_ID,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: 'https://sadara.localhost/api/v1/auth/callback',
      state: randomBytes(16).toString('base64url'),
      code_challenge: createHash('sha256')
        .update(randomBytes(32).toString('base64url'))
        .digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const form = await fetch(authorize, { redirect: 'manual' });
    expect(form.status).toBe(200);
    const cookies = form.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const action = /<form[^>]*\baction="([^"]+)"/
      .exec(await form.text())?.[1]
      .replaceAll('&amp;', '&');
    expect(action).toBeDefined();
    const refused = await fetch(action ?? '', {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        username,
        password: `not-the-password-${suffix()}`,
      }),
    });
    // The form again, with its error: no code, no redirect to the API.
    expect(refused.status).toBe(200);
  }

  beforeAll(async () => {
    const file = parseEnv(readFileSync('.env', 'utf8')) as Record<
      string,
      string
    >;
    env = {
      ...file,
      NODE_ENV: 'test',
      APEX_DOMAIN: 'localhost',
      DATABASE_URL: inject('databaseUrl'),
    };
    adminApi = env.OIDC_ISSUER.replace('/realms/', '/admin/realms/');
    adminToken = await tokenOf(
      env.OIDC_ADMIN_CLIENT_ID,
      env.OIDC_ADMIN_CLIENT_SECRET,
    );
    const made = await fetch(`${adminApi}/users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: probe,
        email: probe,
        emailVerified: true,
        enabled: true,
        credentials: [
          {
            type: 'password',
            value: `${suffix()}-${suffix()}-${suffix()}`,
            temporary: false,
          },
        ],
      }),
    });
    expect(made.status).toBe(201);
    probeId = (made.headers.get('location') ?? '').split('/').pop() ?? '';
  });

  afterAll(async () => {
    if (probeId) {
      await fetch(`${adminApi}/users/${probeId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminToken}` },
      });
    }
  });

  it('provider_sign_in_failures_reach_security_events', async () => {
    const before = new Date(Date.now() - 1000);
    const nobody = `nobody-${suffix()}@agency.test`;
    await failToSignIn(probe);
    await failToSignIn(nobody);

    let out = '';
    let err = '';
    const code = await run(
      ['--hours', '1'],
      env,
      (text) => (out += text),
      (text) => (err += text),
    );
    expect([code, err]).toEqual([0, '']);
    expect(JSON.parse(out)).toMatchObject({ complete: true });

    const rows = await migrationPrisma().securityEvent.findMany({
      where: {
        source: 'PROVIDER',
        eventType: 'provider.login_error',
        occurredAt: { gte: before },
      },
      orderBy: { occurredAt: 'asc' },
    });
    // A wrong password: refused, the account named by its subject alone.
    expect(rows).toContainEqual(
      expect.objectContaining({
        outcome: 'REFUSED',
        reasonCode: 'invalid_user_credentials',
        issuer: env.OIDC_ISSUER,
        subject: probeId,
        tenantHint: null,
        networkHash: expect.any(Uint8Array) as Uint8Array,
        metadata: expect.objectContaining({
          clientId: env.OIDC_CLIENT_ID,
        }) as unknown,
      }),
    );
    // An account that does not exist: refused, and nobody named.
    expect(rows).toContainEqual(
      expect.objectContaining({
        outcome: 'REFUSED',
        reasonCode: 'user_not_found',
        subject: null,
      }),
    );
    // What was typed never reached the table.
    const kept = JSON.stringify(rows);
    expect(kept).not.toContain(probe);
    expect(kept).not.toContain(nobody);

    // Imported again: nothing twice. The provider has new events by then —
    // the import's own sign-in as the event reader is one — and those are
    // imported once like any other.
    const first = JSON.parse(out) as { read: number };
    let again = '';
    expect(await run(['--hours', '1'], env, (text) => (again += text))).toBe(0);
    expect(
      (JSON.parse(again) as { alreadyKept: number }).alreadyKept,
    ).toBeGreaterThanOrEqual(first.read);
    expect(
      await migrationPrisma().securityEvent.count({
        where: { source: 'PROVIDER', subject: probeId },
      }),
    ).toBe(1);
  });
});
