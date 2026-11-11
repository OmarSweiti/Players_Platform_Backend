import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Tenant, User, UserRole } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/config/env.schema';
import {
  AccountExistsError,
  type Locale,
  type RequiredAction,
} from '../../src/modules/identity/application/ports/identity-provider.port';
import { KeycloakIdentityProvider } from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';
import { attemptKeyOf } from '../../src/modules/identity/infrastructure/valkey/valkey-sign-in-attempts';
import { DependencyUnavailableError } from '../../src/common/errors/domain-error';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { systemClock } from '../../src/common/time/clock';
import { IssueInvitationToken } from '../../src/modules/users/application/use-cases/issue-invitation-token.usecase';
import { InvitationRepository } from '../../src/modules/users/infrastructure/repositories/invitation.repository';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  runPrisma,
  testContext,
} from '../harness/fixtures';
import { LogCapture } from '../harness/log-capture';
import { signedInAs } from '../harness/session';
import { setCookiesOf } from '../support/set-cookies';
import { type Hostile, TestIssuer } from '../support/test-issuer';

// Invitations (0.5.10; ADR-0002), end to end: an owner or an administrator
// invites through the API; the invitation's token is issued as its email's
// delivery will issue it (0.7.8); the invitee's browser follows the link,
// signs in at an issuer in this process (test/support/test-issuer.ts), and
// comes back to the callback, which binds the membership only with the token
// and the provider's verified address. The provider's accounts are a double
// in memory; its protocol is the real adapter's against the test issuer.
// Tenants are found from the host, {slug}.localhost (0.5.2). Every address,
// name and subject is synthetic.
vi.hoisted(() => {
  process.env.APEX_DOMAIN = 'localhost';
});

const API = '/api/v1';
const SESSION = '__Host-Http-sadara_session';
const DAY_MS = 24 * 3_600_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const suffix = () => randomBytes(4).toString('hex');

/** An invitation as the API answers it. */
interface InvitationJson {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly locale: string;
  readonly status: string;
  readonly invitedById: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
}

/** The `data` of a success. */
const dataOf = <T>(response: Response): T =>
  (response.body as { data: T }).data;

/** The invitation a success answers with. */
const invitationOf = (response: Response) => dataOf<InvitationJson>(response);

interface Account {
  readonly subject: string;
  readonly locale: Locale;
  readonly actions: readonly RequiredAction[];
}

/**
 * The identity provider: the real adapter for the protocol, against the test
 * issuer, and its accounts in memory — found by address, made with required
 * actions, and never with a password, which the port cannot even pass.
 */
class ProviderWithAccounts extends KeycloakIdentityProvider {
  readonly accounts = new Map<string, Account>();
  /** The subjects the provider sent its setup email to, in order. */
  readonly setupEmails: string[] = [];
  /** Whether the provider is down when asked for one. */
  setupEmailFails = false;

  override findAccount(email: string): Promise<{ subject: string } | null> {
    const account = this.accounts.get(email);
    return Promise.resolve(account ? { subject: account.subject } : null);
  }

  override createAccount(
    email: string,
    locale: Locale,
    actions: readonly RequiredAction[],
  ): Promise<{ subject: string }> {
    if (this.accounts.has(email)) throw new AccountExistsError();
    const subject = randomUUID();
    this.accounts.set(email, { subject, locale, actions: [...actions] });
    return Promise.resolve({ subject });
  }

  /** As the adapter does: sent only while something is left to set up. */
  override sendSetupEmail(subject: string): Promise<void> {
    if (this.setupEmailFails) {
      return Promise.reject(
        new DependencyUnavailableError('the provider is down'),
      );
    }
    const account = [...this.accounts.values()].find(
      (candidate) => candidate.subject === subject,
    );
    if (account && account.actions.length > 0) this.setupEmails.push(subject);
    return Promise.resolve();
  }
}

describe('invitations', () => {
  const logs = new LogCapture();
  let issuer: TestIssuer;
  let provider: ProviderWithAccounts;
  let booted: BootedApp;
  let valkey: Redis;
  let agency: Tenant;
  let other: Tenant;
  let owner: User;
  let admin: User;
  let addresses = 0;

  /** A browser on `host`: its own cookie jar, its own address. */
  class Browser {
    readonly jar = new Map<string, string>();
    private readonly address = `198.51.100.${(addresses += 1)}`;

    constructor(readonly host = `${agency.slug}.localhost`) {}

    async get(path: string): Promise<Response> {
      const request = booted.http
        .get(path)
        .set('Host', this.host)
        .set('X-Forwarded-For', this.address)
        .redirects(0);
      if (this.jar.size > 0) {
        request.set(
          'Cookie',
          [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '),
        );
      }
      const response = await request;
      for (const [name, { value, attributes }] of setCookiesOf(response)) {
        const cleared =
          value === '' || Date.parse(attributes.expires ?? '') < Date.now();
        if (cleared) this.jar.delete(name);
        else this.jar.set(name, value);
      }
      return response;
    }

    /** Follows the invitation's link: the sign-in it starts. */
    follow(token: string): Promise<Response> {
      return this.get(`${API}/auth/login?invitation=${token}`);
    }

    /** Signs in at the provider as `claims` say, and comes back. */
    async signIn(started: Response, claims: Hostile['claims']) {
      expect(started.status).toBe(303);
      const answer = issuer.authorize(new URL(started.headers.location), {
        claims,
      });
      return this.get(`${answer.pathname}${answer.search}`);
    }
  }

  /** The person accepting: their subject, and their verified address. */
  const person = (email: string, extra: Record<string, unknown> = {}) => ({
    sub: randomUUID(),
    email,
    email_verified: true,
    ...extra,
  });

  const address = (label = 'invitee') => `${label}-${suffix()}@agency.test`;

  function invite(
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return booted.http.post(`${API}/users/invitations`).set(headers).send(body);
  }

  /** What makes an invitation's token: the worker's, at its notice's send time (0.7.8). */
  const tokens = () =>
    new IssueInvitationToken(
      new TenantTransactions(runPrisma()),
      new InvitationRepository(),
      systemClock,
    );

  /** A pending invitation's token, as its notice's delivery issues it (0.7.8). */
  async function issue(invitationId: string, tenant = agency): Promise<string> {
    const issued = await tokens().execute(
      testContext(tenant.id, 'invitation-delivery'),
      invitationId,
    );
    if (!issued) throw new Error('the invitation is not pending');
    return issued.token;
  }

  const invitationRow = (id: string, tenant = agency) =>
    asTenant(tenant.id, (tx) =>
      tx.invitation.findUniqueOrThrow({ where: { id } }),
    );

  const membersWith = (email: string, tenant = agency) =>
    asTenant(tenant.id, (tx) =>
      tx.user.findMany({
        where: { normalizedEmail: email.toLowerCase() },
        select: { id: true, role: true, identityId: true, email: true },
      }),
    );

  const identityOf = (subject: string) =>
    runPrisma().identity.findUnique({
      where: { issuer_subject: { issuer: issuer.issuer, subject } },
    });

  /** Moves an invitation's life back, so that it expired `ago` ms ago. */
  const expire = (id: string, ago = DAY_MS) =>
    asTenant(agency.id, (tx) =>
      tx.invitation.update({
        where: { id },
        data: {
          createdAt: new Date(Date.now() - 8 * DAY_MS),
          expiresAt: new Date(Date.now() - ago),
        },
      }),
    );

  /** What a refused callback leaves: no session, and a 401. */
  function expectRefused(response: Response) {
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(setCookiesOf(response).has(SESSION)).toBe(false);
  }

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    const env: Partial<Env> = {
      OIDC_ISSUER: issuer.issuer,
      OIDC_CLIENT_ID: issuer.clientId,
      OIDC_CLIENT_SECRET: issuer.clientSecret,
      OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
      OIDC_ADMIN_CLIENT_SECRET: 'not-used-by-these-tests',
    };
    provider = new ProviderWithAccounts({
      get: (name: keyof Env) => env[name],
    } as unknown as ConfigService<Env, true>);
    booted = await bootApp({
      logs,
      trustedProxies: ['loopback'],
      identityProvider: provider,
    });
    valkey = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
    await valkey.connect();
    agency = await createTenant({ slug: `agency-${suffix()}` });
    other = await createTenant({ slug: `other-${suffix()}` });
    owner = await createMember(agency, 'OWNER');
    admin = await createMember(agency, 'ADMIN');
    logs.start();
  });

  afterAll(async () => {
    logs.stop();
    await booted?.app.close();
    await valkey?.quit();
    await issuer?.close();
  });

  it('accepting_binds_the_invited_role_to_the_signed_in_identity', async () => {
    const email = address('scout');
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'SCOUT',
      locale: 'en',
    });
    expect(created.status).toBe(201);
    const invitation = invitationOf(created);
    expect(invitation).toEqual({
      id: expect.any(String) as string,
      email,
      role: 'SCOUT',
      locale: 'en',
      status: 'pending',
      invitedById: owner.id,
      createdAt: expect.any(String) as string,
      expiresAt: expect.any(String) as string,
      acceptedAt: null,
      revokedAt: null,
    });
    // Seven days to accept.
    expect(
      Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt),
    ).toBe(7 * DAY_MS);
    // The invitee's account at the provider: made to verify their address
    // and choose a password, in the invitation's language; no second factor
    // for a scout, who is not privileged.
    expect(provider.accounts.get(email)).toMatchObject({
      locale: 'en',
      actions: ['VERIFY_EMAIL', 'SET_PASSWORD'],
    });

    // The link starts a sign-in that tells the provider whom to expect.
    const token = await issue(invitation.id);
    const browser = new Browser();
    const started = await browser.follow(token);
    expect(started.status).toBe(303);
    const authorization = new URL(started.headers.location);
    expect(authorization.searchParams.get('login_hint')).toBe(email);
    expect(authorization.searchParams.get('ui_locales')).toBe('en');

    // Signed in as the invited address, verified, in any case: a member.
    const invitee = person(email.toUpperCase());
    const signedIn = await browser.signIn(started, invitee);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.location).toBe(`https://${agency.slug}.localhost/`);
    expect(browser.jar.has(SESSION)).toBe(true);

    const identity = await identityOf(invitee.sub);
    const [member] = await membersWith(email);
    expect(member).toEqual({
      id: expect.any(String) as string,
      role: 'SCOUT',
      identityId: identity?.id,
      email,
    });
    expect(await invitationRow(invitation.id)).toMatchObject({
      acceptedAt: expect.any(Date) as Date,
      acceptedMemberId: member.id,
      acceptedIdentityId: identity?.id,
    });

    // The session is that member's, as the scout they were invited as.
    const session = await browser.get(`${API}/auth/session`);
    expect(session.status).toBe(200);
    expect(dataOf<{ member: unknown }>(session).member).toMatchObject({
      id: member.id,
      role: 'SCOUT',
    });

    // Made and accepted, each audited, and neither names the address.
    const audit = await asTenant(agency.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: invitation.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map(({ action, userId }) => [action, userId])).toEqual([
      ['invitation.created', owner.id],
      ['invitation.accepted', member.id],
    ]);
    expect(JSON.stringify(audit).toLowerCase()).not.toContain(email);
  });

  it('a_privileged_invitee_signs_in_with_a_second_factor', async () => {
    const email = address('legal');
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'LEGAL',
    });
    expect(created.status).toBe(201);
    // In the tenant's language, and with a second factor to set up (0.5.8).
    expect(invitationOf(created).locale).toBe('ar');
    expect(provider.accounts.get(email)?.actions).toEqual([
      'VERIFY_EMAIL',
      'SET_PASSWORD',
      'CONFIGURE_OTP',
    ]);

    // A password alone binds the membership, and opens no session: the
    // browser goes back for the second factor, and then signs in.
    const browser = new Browser();
    const invitee = person(email, { acr: '1' });
    const bounced = await browser.signIn(
      await browser.follow(await issue(invitationOf(created).id)),
      invitee,
    );
    expect(bounced.status).toBe(303);
    expect(
      new URL(bounced.headers.location).searchParams.get('acr_values'),
    ).toBe('2');
    expect(browser.jar.has(SESSION)).toBe(false);
    expect(await membersWith(email)).toMatchObject([{ role: 'LEGAL' }]);

    const signedIn = await browser.signIn(bounced, { ...invitee, acr: '2' });
    expect(signedIn.status).toBe(303);
    expect(browser.jar.has(SESSION)).toBe(true);
  });

  it('an_invitation_works_once', async () => {
    const email = address();
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'COACH',
    });
    const token = await issue(invitationOf(created).id);

    // Two browsers follow the link while it is pending; the first to come
    // back accepts it, and the second is refused, the same person or not.
    const first = new Browser();
    const second = new Browser();
    const third = new Browser();
    const [a, b, c] = [
      await first.follow(token),
      await second.follow(token),
      await third.follow(token),
    ];
    const invitee = person(email);
    expect((await first.signIn(a, invitee)).status).toBe(303);
    expectRefused(await second.signIn(b, invitee));
    expectRefused(await third.signIn(c, person(email)));
    expect(await membersWith(email)).toHaveLength(1);

    // Accepted, the link no longer starts anything.
    const again = await new Browser().follow(token);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an_expired_invitation_is_refused', async () => {
    const owners = await signedInAs(owner);
    // Expired before its link is followed: the link starts nothing.
    const email = address();
    const created = await invite(owners, { email, role: 'COACH' });
    const token = await issue(invitationOf(created).id);
    await expire(invitationOf(created).id);
    expect((await new Browser().follow(token)).status).toBe(404);
    // And no new token makes it work again.
    expect(
      await tokens().execute(testContext(agency.id), invitationOf(created).id),
    ).toBeNull();

    // Expired while its sign-in was under way: refused at the callback.
    const late = address();
    const pending = await invite(owners, { email: late, role: 'COACH' });
    const browser = new Browser();
    const started = await browser.follow(await issue(invitationOf(pending).id));
    expect(started.status).toBe(303);
    await expire(invitationOf(pending).id, 1000);
    expectRefused(await browser.signIn(started, person(late)));
    expect(await membersWith(late)).toEqual([]);

    // The list says so; inviting the address again replaces it.
    const listed = await booted.http
      .get(`${API}/users/invitations?status=expired`)
      .set(owners);
    expect(dataOf<InvitationJson[]>(listed).map(({ id }) => id)).toEqual(
      expect.arrayContaining([invitationOf(created).id]),
    );
    const renewed = await invite(owners, { email, role: 'COACH' });
    expect(renewed.status).toBe(201);
    expect(await invitationRow(invitationOf(created).id)).toMatchObject({
      revokedAt: expect.any(Date) as Date,
    });
  });

  it('an_admin_cannot_invite_above_their_role', async () => {
    const admins = await signedInAs(admin);
    // Above their own: refused, before the provider is asked for anything.
    const ownerEmail = address('would-be-owner');
    const above = await invite(admins, { email: ownerEmail, role: 'OWNER' });
    expect(above.status).toBe(403);
    expect(above.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(provider.accounts.has(ownerEmail)).toBe(false);
    expect(
      await asTenant(agency.id, (tx) =>
        tx.invitation.count({ where: { normalizedEmail: ownerEmail } }),
      ),
    ).toBe(0);

    // Their own role and every role beneath it: invited.
    for (const role of ['ADMIN', 'SCOUT', 'MEDICAL'] satisfies UserRole[]) {
      expect((await invite(admins, { email: address(), role })).status).toBe(
        201,
      );
    }
    // An owner may make another owner.
    expect(
      (
        await invite(await signedInAs(owner), {
          email: address(),
          role: 'OWNER',
        })
      ).status,
    ).toBe(201);
    // Nobody grants SUPER_ADMIN, a platform role: not even a valid request.
    const platform = await invite(await signedInAs(owner), {
      email: address(),
      role: 'SUPER_ADMIN',
    });
    expect(platform.status).toBe(400);
    expect((platform.body as { fieldErrors: unknown }).fieldErrors).toEqual([
      expect.objectContaining({ field: '/role', code: 'INVALID_VALUE' }),
    ]);
    // A role without `user.invite` invites nobody.
    const coach = await createMember(agency, 'COACH');
    expect(
      (
        await invite(await signedInAs(coach), {
          email: address(),
          role: 'PLAYER',
        })
      ).status,
    ).toBe(403);
  });

  it('an_invitation_needs_its_inviters_authority_when_accepted', async () => {
    // The administrator who invited is no longer one when it is accepted.
    const inviter = await createMember(agency, 'ADMIN');
    const email = address();
    const created = await invite(await signedInAs(inviter), {
      email,
      role: 'ADMIN',
    });
    expect(created.status).toBe(201);
    const browser = new Browser();
    const started = await browser.follow(await issue(invitationOf(created).id));
    await asTenant(agency.id, (tx) =>
      tx.user.update({ where: { id: inviter.id }, data: { role: 'COACH' } }),
    );
    expectRefused(await browser.signIn(started, person(email)));
    expect(await membersWith(email)).toEqual([]);
  });

  it('binding_needs_the_token_and_the_verified_address', async () => {
    const email = address();
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'SCOUT',
    });
    const token = await issue(invitationOf(created).id);
    const attempt = async (claims: Hostile['claims']) => {
      const browser = new Browser();
      return browser.signIn(await browser.follow(token), claims);
    };

    // The address unverified, another address, or none: refused, and the
    // invitation stays pending.
    expectRefused(await attempt(person(email, { email_verified: false })));
    expectRefused(await attempt(person(address('someone-else'))));
    expectRefused(await attempt(person(email, { email: undefined })));
    expect(await membersWith(email)).toEqual([]);
    expect(await invitationRow(invitationOf(created).id)).toMatchObject({
      acceptedAt: null,
    });

    // A token that is not this tenant's starts nothing here.
    const elsewhere = await new Browser(`${other.slug}.localhost`).follow(
      token,
    );
    expect(elsewhere.status).toBe(404);
    // Nor does one in the wrong shape.
    const malformed = await new Browser().follow('not-a-token');
    expect(malformed.status).toBe(400);

    // The token and the verified address: accepted.
    expect((await attempt(person(email))).status).toBe(303);
    expect(await membersWith(email)).toHaveLength(1);
  });

  it('invitation_tokens_are_stored_hashed', async () => {
    const email = address();
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'COACH',
    });
    const id = invitationOf(created).id;
    // No token before its email is sent, and none in any answer.
    expect((await invitationRow(id)).tokenHash).toBeNull();
    expect(JSON.stringify(created.body)).not.toMatch(/token/i);

    // Stored as its SHA-256 digest, and only as that: no column of the row
    // holds the token itself.
    const first = await issue(id);
    const stored = await invitationRow(id);
    expect(Buffer.from(stored.tokenHash ?? [])).toEqual(sha256(first));
    const row = await asTenant(
      agency.id,
      (tx) =>
        tx.$queryRaw<{ row: string }[]>`
        SELECT row_to_json(invitations)::text AS row FROM invitations WHERE id = ${id}::uuid`,
    );
    expect(row[0].row).not.toContain(first);

    // A new token replaces it: only the newest link works.
    const second = await issue(id);
    expect(Buffer.from((await invitationRow(id)).tokenHash ?? [])).toEqual(
      sha256(second),
    );
    expect((await new Browser().follow(first)).status).toBe(404);

    // The sign-in in flight keeps the digest, never the token.
    const browser = new Browser();
    const started = await browser.follow(second);
    expect(started.status).toBe(303);
    const state = new URL(started.headers.location).searchParams.get('state');
    const kept = await valkey.get(attemptKeyOf(state ?? ''));
    expect(kept).not.toContain(second);
    expect(JSON.parse(kept ?? '{}')).toMatchObject({
      invitation: sha256(second).toString('base64url'),
    });
    expect((await browser.signIn(started, person(email))).status).toBe(303);

    // Nothing logged on the way holds a token or the address.
    const logged = logs.lines.join('\n');
    for (const secret of [first, second, email]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('the_list_shows_what_became_of_each_and_revoking_closes_one', async () => {
    const owners = await signedInAs(owner);
    const make = async () => {
      const response = await invite(owners, {
        email: address(),
        role: 'COACH',
      });
      return invitationOf(response).id;
    };
    const [pending, expired, revoked, accepted] = [
      await make(),
      await make(),
      await make(),
      await make(),
    ];
    await expire(expired);
    const revoke = (id: string) =>
      booted.http.delete(`${API}/users/invitations/${id}`).set(owners);
    expect(await revoke(revoked)).toMatchObject({
      status: 200,
      body: { data: null },
    });
    const acceptedRow = await invitationRow(accepted);
    const browser = new Browser();
    await browser.signIn(
      await browser.follow(await issue(accepted)),
      person(acceptedRow.email),
    );

    // Newest first, each as it stands.
    const listed = await booted.http
      .get(`${API}/users/invitations?limit=100`)
      .set(owners);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    const status = new Map(
      dataOf<InvitationJson[]>(listed).map((i) => [i.id, i.status]),
    );
    expect(
      [pending, expired, revoked, accepted].map((id) => status.get(id)),
    ).toEqual(['pending', 'expired', 'revoked', 'accepted']);
    const ids = dataOf<InvitationJson[]>(listed).map(({ id }) => id);
    expect(ids.indexOf(accepted)).toBeLessThan(ids.indexOf(pending));
    const onlyRevoked = await booted.http
      .get(`${API}/users/invitations?status=revoked&limit=100`)
      .set(owners);
    expect(
      dataOf<InvitationJson[]>(onlyRevoked).every(
        (i) => i.status === 'revoked',
      ),
    ).toBe(true);

    // Revoking: a revoked one stays revoked; an accepted one cannot be; a
    // revoked link starts nothing; another tenant's invitation is not found.
    expect((await revoke(revoked)).status).toBe(200);
    expect(await revoke(accepted)).toMatchObject({
      status: 409,
      body: { code: 'INVALID_TRANSITION' },
    });
    const token = await issue(pending);
    expect((await revoke(pending)).status).toBe(200);
    expect((await new Browser().follow(token)).status).toBe(404);
    const theirs = await createMember(other, 'OWNER');
    const foreign = await invite(await signedInAs(theirs), {
      email: address(),
      role: 'COACH',
    });
    expect((await revoke(invitationOf(foreign).id)).status).toBe(404);
    expect((await revoke(randomUUID())).status).toBe(404);
  });

  it('a_change_is_audited_with_its_request_and_client', async () => {
    // The request's client, through a trusted proxy (loopback, for this app),
    // and its user agent: the audit entry keeps both, with the request id the
    // answer carried (0.7.2).
    const email = address('audited');
    const created = await booted.http
      .post(`${API}/users/invitations`)
      .set(await signedInAs(owner))
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'Sadara-Validation/1.0 (synthetic)')
      .send({ email, role: 'COACH' });
    expect(created.status).toBe(201);
    const audit = await asTenant(agency.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: invitationOf(created).id },
        select: {
          action: true,
          actorType: true,
          userId: true,
          actorRole: true,
          requestId: true,
          ipAddress: true,
          userAgent: true,
          newValues: true,
          schemaVersion: true,
        },
      }),
    );
    expect(audit).toEqual([
      {
        action: 'invitation.created',
        actorType: 'USER',
        userId: owner.id,
        actorRole: 'OWNER',
        requestId: created.headers['x-request-id'],
        ipAddress: '203.0.113.9',
        userAgent: 'Sadara-Validation/1.0 (synthetic)',
        newValues: expect.objectContaining({
          email: {
            ref: `Invitation/${invitationOf(created).id}/email`,
            class: 'PERSONAL',
          },
        }) as unknown,
        schemaVersion: 2,
      },
    ]);
    expect(JSON.stringify(audit).toLowerCase()).not.toContain(email);
  });

  it('an_address_a_member_holds_or_a_pending_invitation_names_is_refused', async () => {
    const owners = await signedInAs(owner);
    const member = await createMember(agency, 'COACH');
    const taken = await invite(owners, {
      email: member.email.toUpperCase(),
      role: 'SCOUT',
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'CONFLICT' });

    const email = address();
    expect((await invite(owners, { email, role: 'SCOUT' })).status).toBe(201);
    const twice = await invite(owners, { email, role: 'COACH' });
    expect(twice.status).toBe(409);
    // Neither problem repeats the address.
    expect(
      JSON.stringify([taken.body, twice.body]).toLowerCase(),
    ).not.toContain(email);
  });

  it('inviting_needs_a_recent_authentication', async () => {
    const headers = await signedInAs(owner);
    await asTenant(agency.id, (tx) =>
      tx.userSession.updateMany({
        where: {
          tokenHash: new Uint8Array(sha256(headers.Cookie.split('=')[1])),
        },
        data: { authTime: new Date(Date.now() - 6 * 60 * 1000) },
      }),
    );
    const email = address();
    const refused = await invite(headers, { email, role: 'SCOUT' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(provider.accounts.has(email)).toBe(false);
    // The list and a revocation do not grant anything: they need none.
    expect(
      (await booted.http.get(`${API}/users/invitations`).set(headers)).status,
    ).toBe(200);
  });

  // 0.7.8: the invitation's notice is enqueued with it, and a new invitee's
  // account is sent the provider's setup email.

  /** The outbox events about `invitationId`, as its tenant reads them. */
  const noticesOf = (invitationId: string, tenant = agency) =>
    asTenant(tenant.id, (tx) =>
      tx.outboxEvent.findMany({
        where: { aggregateId: invitationId },
        select: {
          type: true,
          aggregateType: true,
          payloadRefs: true,
          dedupKey: true,
          status: true,
        },
      }),
    );

  it('an_invitation_enqueues_its_notice_with_its_id_only', async () => {
    const email = address();
    const created = await invite(await signedInAs(owner), {
      email,
      role: 'COACH',
      locale: 'ar',
    });
    expect(created.status).toBe(201);
    const { id } = invitationOf(created);
    // One event, in the invitation's transaction: its id, never a link,
    // a token or the address.
    const events = await noticesOf(id);
    expect(events).toEqual([
      {
        type: 'invitation.created',
        aggregateType: 'Invitation',
        payloadRefs: { invitationId: id },
        dedupKey: `invitation.created:${id}`,
        status: 'CREATED',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(email);

    // A refused invitation enqueues nothing.
    const before = await asTenant(agency.id, (tx) => tx.outboxEvent.count());
    const refused = await invite(await signedInAs(admin), {
      email: address(),
      role: 'OWNER',
    });
    expect(refused.status).toBe(403);
    expect(await asTenant(agency.id, (tx) => tx.outboxEvent.count())).toBe(
      before,
    );
  });

  it('a_new_invitee_is_sent_the_providers_setup_email', async () => {
    const headers = await signedInAs(owner);
    // A new account: the provider sends its setup email, once.
    const email = address();
    expect((await invite(headers, { email, role: 'SCOUT' })).status).toBe(201);
    const { subject } = provider.accounts.get(email)!;
    expect(provider.setupEmails.filter((s) => s === subject)).toHaveLength(1);

    // An account already set up — someone who signs in elsewhere: none.
    const settled = address('settled');
    const settledSubject = randomUUID();
    provider.accounts.set(settled, {
      subject: settledSubject,
      locale: 'en',
      actions: [],
    });
    expect(
      (await invite(headers, { email: settled, role: 'COACH' })).status,
    ).toBe(201);
    expect(provider.setupEmails).not.toContain(settledSubject);

    // The provider down when asked: nothing is written, no invitation and
    // no notice; the retry finds the account and asks again.
    const later = address('later');
    provider.setupEmailFails = true;
    try {
      const failed = await invite(headers, { email: later, role: 'SCOUT' });
      expect(failed.status).toBe(503);
    } finally {
      provider.setupEmailFails = false;
    }
    const laterSubject = provider.accounts.get(later)!.subject;
    expect(
      await asTenant(agency.id, (tx) =>
        tx.invitation.count({ where: { normalizedEmail: later } }),
      ),
    ).toBe(0);
    const retried = await invite(headers, { email: later, role: 'SCOUT' });
    expect(retried.status).toBe(201);
    expect(provider.setupEmails.filter((s) => s === laterSubject)).toHaveLength(
      1,
    );
    expect(await noticesOf(invitationOf(retried).id)).toHaveLength(1);
  });
});
