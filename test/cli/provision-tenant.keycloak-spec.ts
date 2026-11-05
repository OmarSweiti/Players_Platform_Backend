import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { run } from '../../src/cli/provision-tenant';
import { asTenant, runPrisma } from '../harness/fixtures';

// The tenant provisioning command (0.5.9; BR-OBJ-08), against the local
// stack's Keycloak — the umbrella's `just up`, with the realm's provisioning
// account — and this run's own schema. It runs in-process, as an operator
// runs it: arguments, environment, exit code and printed report. Its
// settings are this machine's .env (development-only values), with the run's
// database. Everything it makes at Keycloak is removed afterwards: the
// accounts, and the sign-in client's added addresses, restored as they were.

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const suffix = () => randomBytes(4).toString('hex');

describe('the tenant provisioning command', () => {
  let env: Record<string, string>;
  let adminApi: string;
  const tokens: Record<'admin' | 'provisioner', string> = {
    admin: '',
    provisioner: '',
  };
  const madeEmails: string[] = [];
  let originalClient: Record<string, unknown>;

  /** A token of the test's own, for reading back what the command did. */
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

  async function admin(
    as: 'admin' | 'provisioner',
    path: string,
    init: RequestInit = {},
  ) {
    return fetch(`${adminApi}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tokens[as]}`,
        'content-type': 'application/json',
      },
    });
  }

  /** The command, with its output; arguments as an operator types them. */
  async function provision(...argv: string[]) {
    let out = '';
    let err = '';
    const code = await run(
      argv,
      env,
      (text) => (out += text),
      (text) => (err += text),
    );
    return { code, out, err };
  }

  const signInClient = async () => {
    const response = await admin(
      'provisioner',
      `/clients?clientId=${env.OIDC_CLIENT_ID}`,
    );
    return ((await response.json()) as Array<Record<string, unknown>>)[0];
  };
  const accountsOf = async (email: string) =>
    (await (
      await admin(
        'admin',
        `/users?email=${encodeURIComponent(email)}&exact=true`,
      )
    ).json()) as Array<Record<string, unknown>>;
  const mailTo = async (email: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
      );
      const { messages } = (await response.json()) as {
        messages: Array<{ Subject: string }>;
      };
      if (messages.length > 0) return messages;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  };
  const tenantsWithSlug = (slug: string) =>
    runPrisma().$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM tenant_directory WHERE slug = ${slug}`;

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
    const issuer = new URL(env.OIDC_ISSUER);
    adminApi = issuer.href.replace('/realms/', '/admin/realms/');
    tokens.admin = await tokenOf(
      env.OIDC_ADMIN_CLIENT_ID,
      env.OIDC_ADMIN_CLIENT_SECRET,
    );
    tokens.provisioner = await tokenOf(
      env.OIDC_PROVISIONER_CLIENT_ID,
      env.OIDC_PROVISIONER_CLIENT_SECRET,
    );
    originalClient = await signInClient();
  });

  afterAll(async () => {
    tokens.admin = await tokenOf(
      env.OIDC_ADMIN_CLIENT_ID,
      env.OIDC_ADMIN_CLIENT_SECRET,
    );
    tokens.provisioner = await tokenOf(
      env.OIDC_PROVISIONER_CLIENT_ID,
      env.OIDC_PROVISIONER_CLIENT_SECRET,
    );
    for (const email of madeEmails) {
      for (const user of await accountsOf(email)) {
        await admin('admin', `/users/${String(user.id)}`, { method: 'DELETE' });
      }
    }
    // The sign-in client, as it was: the realm's own hosts only.
    const now = await signInClient();
    await admin('provisioner', `/clients/${String(now.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...now,
        redirectUris: originalClient.redirectUris,
        attributes: originalClient.attributes,
      }),
    });
  });

  it('provisioning_creates_a_tenant_and_an_invited_owner', async () => {
    const id = suffix();
    const email = `owner-${id}@agency.test`;
    madeEmails.push(email);
    // As typed, in mixed case: stored in lower case (DB-55).
    const { code, out, err } = await provision(
      '--slug',
      `Agency-${id}`,
      '--name',
      `Agency ${id}`,
      '--domain',
      `Agency-${id}.Example.Test`,
      '--owner-email',
      email,
    );
    expect([code, err]).toEqual([0, '']);
    const report = JSON.parse(out) as {
      tenant: { id: string; slug: string; created: boolean };
      hosts: Array<{ host: string; added: boolean }>;
      owner: {
        membershipId: string;
        created: boolean;
        accountCreated: boolean;
      };
      setupEmail: string;
    };
    const slug = `agency-${id}`;
    const hosts = [`agency-${id}.example.test`, `${slug}.localhost`];
    expect(report).toEqual({
      tenant: { id: expect.any(String) as string, slug, created: true },
      hosts: hosts.map((host) => ({ host, added: true })),
      owner: {
        membershipId: expect.any(String) as string,
        created: true,
        accountCreated: true,
      },
      setupEmail: 'sent',
    });
    // The report never names the owner's address.
    expect(out).not.toContain(email);

    // The tenant and its domain, in lower case.
    const tenantId = report.tenant.id;
    const tenant = await asTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    );
    expect(tenant).toMatchObject({
      slug,
      domain: hosts[0],
      name: `Agency ${id}`,
      isActive: true,
      defaultLocale: 'ar',
    });

    // The owner's account: required actions, no credential of any kind.
    const [account, ...others] = await accountsOf(email);
    expect(others).toEqual([]);
    expect(account).toMatchObject({
      email,
      enabled: true,
      emailVerified: false,
      attributes: { locale: ['ar'] },
    });
    expect([...(account.requiredActions as string[])].sort()).toEqual([
      'CONFIGURE_TOTP',
      'UPDATE_PASSWORD',
      'VERIFY_EMAIL',
    ]);
    const credentials = (await (
      await admin('admin', `/users/${String(account.id)}/credentials`)
    ).json()) as unknown[];
    expect(credentials).toEqual([]);

    // The OWNER membership, linked to that identity.
    const member = await asTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: report.owner.membershipId },
        include: { identity: true },
      }),
    );
    expect(member).toMatchObject({
      tenantId,
      role: 'OWNER',
      normalizedEmail: email,
      identity: { issuer: env.OIDC_ISSUER, subject: account.id },
    });

    // The tenant's hosts at the provider: their exact addresses.
    const client = await signInClient();
    for (const host of hosts) {
      expect(client.redirectUris).toContain(
        `https://${host}/api/v1/auth/callback`,
      );
      expect(
        (client.attributes as Record<string, string>)[
          'post.logout.redirect.uris'
        ].split('##'),
      ).toContain(`https://${host}/`);
    }

    // The setup email, in the tenant's language; the audit entry, with no address.
    const mail = await mailTo(email);
    expect(mail).toHaveLength(1);
    expect(mail[0].Subject).toMatch(/[؀-ۿ]/);
    const audit = await asTenant(tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId } }),
    );
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'tenant.provisioned',
        entityType: 'Tenant',
        entityId: tenantId,
        userId: null,
      }),
    ]);
    expect(JSON.stringify(audit[0].newValues)).not.toContain(email);
  });

  it('provisioning_is_idempotent_per_slug', async () => {
    const id = suffix();
    const email = `owner-${id}@agency.test`;
    madeEmails.push(email);
    const args = [
      '--slug',
      `agency-${id}`,
      '--name',
      `Agency ${id}`,
      '--domain',
      `agency-${id}.example.test`,
      '--owner-email',
      email,
    ];
    const first = await provision(...args);
    expect(first.code).toBe(0);
    const before = await signInClient();

    // Again: everything found, nothing made, nothing sent.
    const second = await provision(...args);
    expect([second.code, second.err]).toEqual([0, '']);
    const report = JSON.parse(second.out) as Record<string, unknown>;
    expect(report).toMatchObject({
      tenant: { created: false },
      hosts: [
        { host: `agency-${id}.example.test`, added: false },
        { host: `agency-${id}.localhost`, added: false },
      ],
      owner: { created: false, accountCreated: false },
      setupEmail: 'not-sent',
    });
    const tenants = await tenantsWithSlug(`agency-${id}`);
    expect(tenants).toHaveLength(1);
    const tenantId = tenants[0].id;
    expect(
      await asTenant(tenantId, (tx) => tx.user.count({ where: { tenantId } })),
    ).toBe(1);
    expect(await accountsOf(email)).toHaveLength(1);
    expect((await signInClient()).redirectUris).toEqual(before.redirectUris);
    expect(await mailTo(email)).toHaveLength(1);
    // Only the run that changed something is audited.
    expect(
      await asTenant(tenantId, (tx) =>
        tx.auditLog.count({ where: { tenantId } }),
      ),
    ).toBe(1);

    // The slug with another domain is another tenant's request: refused,
    // and nothing changes.
    const clash = await provision(
      '--slug',
      `agency-${id}`,
      '--name',
      `Agency ${id}`,
      '--domain',
      `elsewhere-${id}.example.test`,
      '--owner-email',
      email,
    );
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('CONFLICT');
    expect((await signInClient()).redirectUris).toEqual(before.redirectUris);

    // A run that stopped part-way — the account made, nothing else — is
    // finished by running it again; and the setup email can be sent again.
    const resumedId = suffix();
    const resumedEmail = `owner-${resumedId}@agency.test`;
    madeEmails.push(resumedEmail);
    await admin('admin', '/users', {
      method: 'POST',
      body: JSON.stringify({
        username: resumedEmail,
        email: resumedEmail,
        enabled: true,
        requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      }),
    });
    const resumed = await provision(
      '--slug',
      `agency-${resumedId}`,
      '--name',
      `Agency ${resumedId}`,
      '--owner-email',
      resumedEmail,
      '--resend-setup-email',
    );
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out)).toMatchObject({
      tenant: { created: true },
      owner: { created: true, accountCreated: false },
      setupEmail: 'sent',
    });
    expect(await accountsOf(resumedEmail)).toHaveLength(1);
  });

  it('provisioning_never_links_a_membership_by_address_alone', async () => {
    const id = suffix();
    const owner = `owner-${id}@agency.test`;
    madeEmails.push(owner);
    const base = ['--slug', `agency-${id}`, '--name', `Agency ${id}`];
    expect((await provision(...base, '--owner-email', owner)).code).toBe(0);
    const [{ id: tenantId }] = await tenantsWithSlug(`agency-${id}`);

    // A membership with an address and no identity: provisioning an owner
    // with that address is refused, before the provider is touched.
    const other = `coach-${id}@agency.test`;
    madeEmails.push(other);
    await asTenant(tenantId, (tx) =>
      tx.user.create({
        data: { tenantId, email: other, normalizedEmail: other, role: 'COACH' },
      }),
    );
    const refused = await provision(...base, '--owner-email', other);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('CONFLICT');
    expect(refused.err).not.toContain(other);
    expect(await accountsOf(other)).toEqual([]);
    expect(
      await asTenant(tenantId, (tx) =>
        tx.user.findFirstOrThrow({
          where: { tenantId, normalizedEmail: other },
        }),
      ),
    ).toMatchObject({ identityId: null, role: 'COACH' });
  });

  it('provisioning_never_accepts_a_password', async () => {
    const id = suffix();
    const email = `owner-${id}@agency.test`;
    // Cleaned up whatever happens: a command that wrongly ran makes an account.
    madeEmails.push(email);
    const secret = `Not-a-password-${id}!`;
    const base = [
      '--slug',
      `agency-${id}`,
      '--name',
      `Agency ${id}`,
      '--owner-email',
      email,
    ];
    for (const attempt of [
      ['--password', secret],
      [`--password=${secret}`],
      ['--owner-password', secret],
      [`--admin-pass=${secret}`],
      ['--client-secret', secret],
      ['-p', secret],
      [secret], // a stray value is no argument either
    ]) {
      const refused = await provision(...base, ...attempt);
      expect([attempt[0], refused.code]).toEqual([attempt[0], 2]);
      expect(refused.out).toBe('');
      // The value is never repeated back.
      expect(refused.err).not.toContain(secret);
    }
    // Refused before anything began: no tenant, no account.
    expect(await tenantsWithSlug(`agency-${id}`)).toEqual([]);
    expect(await accountsOf(email)).toEqual([]);

    // And what it does make holds no credential: the owner chooses one.
    expect((await provision(...base)).code).toBe(0);
    const [account] = await accountsOf(email);
    expect(
      await (
        await admin('admin', `/users/${String(account.id)}/credentials`)
      ).json(),
    ).toEqual([]);
    expect(account.requiredActions).toContain('UPDATE_PASSWORD');
  });
});
