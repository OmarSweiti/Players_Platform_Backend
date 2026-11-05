import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config/env.schema';
import {
  AccountExistsError,
  AccountNotFoundError,
} from '../../src/modules/identity/application/ports/identity-provider.port';
import {
  adminApiOf,
  KeycloakIdentityProvider,
} from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';

// The identity provider's admin calls (0.5.4), against the local stack's
// Keycloak: the umbrella's `just up`, with the realm from
// infra/keycloak/realm-sadara.json. Run with `npx vitest run --project
// keycloak`; CI has no Keycloak. The settings are this machine's .env
// (OIDC_*, development-only values). Each change the adapter makes is read
// back independently: through the admin API with a token of the test's own,
// and in Mailpit's inbox. The account it creates is synthetic, on .test, and
// deleted afterwards.

const NAMES = [
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ADMIN_CLIENT_ID',
  'OIDC_ADMIN_CLIENT_SECRET',
] as const;
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

describe('the adapter manages accounts at Keycloak', () => {
  let env: Pick<Env, (typeof NAMES)[number]>;
  let provider: KeycloakIdentityProvider;
  let admin: string;
  let token: string;
  const created: string[] = [];

  /** The account as the admin API shows it, read with the test's own token. */
  async function account(subject: string) {
    const response = await fetch(`${admin}/users/${subject}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  /** The messages Mailpit holds for `address`, waiting up to ten seconds for one. */
  async function mailTo(address: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
      );
      const { messages } = (await response.json()) as {
        messages: Array<{ Subject: string; To: Array<{ Address: string }> }>;
      };
      if (messages.length > 0) return messages;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  }

  beforeAll(async () => {
    try {
      process.loadEnvFile('.env');
    } catch {
      // the variables may come from the shell instead
    }
    const missing = NAMES.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(
        `set ${missing.join(', ')} (.env.example has local values)`,
      );
    }
    env = Object.fromEntries(
      NAMES.map((n) => [n, process.env[n]]),
    ) as typeof env;
    provider = new KeycloakIdentityProvider({
      get: (name: keyof Env) => env[name as keyof typeof env],
    } as unknown as ConfigService<Env, true>);
    const issuer = new URL(env.OIDC_ISSUER);
    admin = adminApiOf(issuer);
    const grant = await fetch(`${issuer.href}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.OIDC_ADMIN_CLIENT_ID,
        client_secret: env.OIDC_ADMIN_CLIENT_SECRET,
      }),
    });
    expect(grant.status).toBe(200);
    token = ((await grant.json()) as { access_token: string }).access_token;
  });

  afterAll(async () => {
    for (const subject of created) {
      await fetch(`${admin}/users/${subject}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    }
  });

  it('the_adapter_manages_accounts_at_keycloak', async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@agency.test`;

    // A new account, in Arabic, with what the person must complete.
    const { subject } = await provider.createAccount(email, 'ar', [
      'VERIFY_EMAIL',
      'SET_PASSWORD',
    ]);
    created.push(subject);
    expect(await account(subject)).toMatchObject({
      id: subject,
      username: email,
      email,
      enabled: true,
      emailVerified: false,
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
      attributes: { locale: ['ar'] },
    });

    // The same address again is a conflict, not a second account.
    await expect(
      provider.createAccount(email, 'en', []),
    ).rejects.toBeInstanceOf(AccountExistsError);

    // The setup email reaches the address, in the account's language.
    await provider.sendSetupEmail(subject);
    const mail = await mailTo(email);
    expect(mail).toHaveLength(1);
    expect(mail[0].Subject).toMatch(/[؀-ۿ]/);

    // Disabled: the account can no longer sign in, and the rest of it stays.
    await provider.disableAccount(subject);
    expect(await account(subject)).toMatchObject({
      enabled: false,
      email,
      requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
    });

    // An account the provider does not have is not found, whatever the call.
    const nobody = randomUUID();
    await expect(provider.sendSetupEmail(nobody)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    await expect(provider.disableAccount(nobody)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    await expect(provider.disableAccount('../clients')).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });
});
