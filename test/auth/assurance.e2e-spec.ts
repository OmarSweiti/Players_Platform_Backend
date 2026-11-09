import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Controller, Post } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Tenant, User, UserRole } from '@prisma/client';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequiresRecentAuth } from '../../src/common/decorators/requires-recent-auth.decorator';
import type { Env } from '../../src/config/env.schema';
import { PRIVILEGED_ROLES } from '../../src/modules/identity/application/assurance.policy';
import { KeycloakIdentityProvider } from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  runPrisma,
} from '../harness/fixtures';
import { signedInAs } from '../harness/session';
import { setCookiesOf } from '../support/set-cookies';
import { TestIssuer, type Hostile } from '../support/test-issuer';
import { SignedIn } from '../../src/common/decorators/signed-in.decorator';

// MFA assurance for privileged roles; recent authentication for sensitive
// actions (0.5.8; SR-AUTH-002). A privileged member holds no session without
// the second factor the provider asserts as level 2; a sensitive action needs
// an authentication within five minutes, and a step-up renews the session the
// browser holds. Against an issuer in this process, which asserts whatever
// level and authentication time a test asks for.

const PREAUTH = '__Host-Http-sadara_preauth';
const SESSION = '__Host-Http-sadara_session';
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const suffix = () => randomBytes(4).toString('hex');
const now = () => Math.floor(Date.now() / 1000);

@SignedIn()
@Controller('probe/assurance')
class SensitiveProbe {
  @RequiresRecentAuth()
  @Post('approve')
  approve() {
    return { approved: true };
  }

  @Post('note')
  note() {
    return { noted: true };
  }
}

describe('assurance: second factors and recent authentication', () => {
  let issuer: TestIssuer;
  let booted: BootedApp;
  let agency: Tenant;
  let host: string;
  let addresses = 0;

  /** A browser: its cookies, its own address (for the auth rate limit). */
  class Browser {
    readonly jar = new Map<string, string>();
    private readonly address = `198.51.100.${(addresses += 1)}`;

    async get(path: string): Promise<Response> {
      const request = booted.http
        .get(path)
        .set('Host', host)
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

    /** The browser's own page writing: its session's CSRF token, its Origin. */
    async post(path: string): Promise<Response> {
      const read = await this.get('/api/v1/auth/session');
      const token = (read.body as { data?: { csrfToken?: string } }).data
        ?.csrfToken;
      return booted.http
        .post(path)
        .set('Host', host)
        .set('X-Forwarded-For', this.address)
        .set('Origin', `https://${host}`)
        .set('Cookie', `${SESSION}=${this.jar.get(SESSION) ?? ''}`)
        .set('X-CSRF-Token', token ?? '')
        .send({});
    }

    /** Answers the provider's sign-in at `url` as `hostile` says; the callback. */
    callback(url: URL, hostile: Hostile): Promise<Response> {
      const answer = issuer.authorize(url, hostile);
      return this.get(`${answer.pathname}${answer.search}`);
    }
  }

  /** A member of the agency, linked to a new person at the test issuer. */
  async function memberAs(role: UserRole) {
    const member = await createMember(agency, role);
    const subject = randomUUID();
    const { id } = await runPrisma().identity.create({
      data: { issuer: issuer.issuer, subject },
    });
    await asTenant(agency.id, (tx) =>
      tx.user.update({ where: { id: member.id }, data: { identityId: id } }),
    );
    return { member, subject };
  }

  const sessionsOf = (member: User) =>
    asTenant(agency.id, (tx) =>
      tx.userSession.findMany({ where: { userId: member.id } }),
    );
  const problemOf = (response: Response) => ({
    status: response.status,
    code: (response.body as { code?: string }).code,
  });

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    const env: Partial<Env> = {
      OIDC_ISSUER: issuer.issuer,
      OIDC_CLIENT_ID: issuer.clientId,
      OIDC_CLIENT_SECRET: issuer.clientSecret,
      OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
      OIDC_ADMIN_CLIENT_SECRET: 'not-used-by-these-tests',
    };
    booted = await bootApp({
      controllers: [SensitiveProbe],
      trustedProxies: ['loopback'],
      identityProvider: new KeycloakIdentityProvider({
        get: (name: keyof Env) => env[name],
      } as unknown as ConfigService<Env, true>),
    });
    agency = await createTenant({ slug: `agency-${suffix()}` });
    host = `${agency.slug}.localhost`;
  });

  afterAll(async () => {
    await booted?.app.close();
    await issuer?.close();
  });

  it('a_privileged_member_without_mfa_gets_no_session', async () => {
    // Every privileged tenant role: no membership holds SUPER_ADMIN, a
    // platform role (0.6.7), though the policy would demand a second factor
    // of it too.
    for (const role of [...PRIVILEGED_ROLES].filter(
      (role) => role !== 'SUPER_ADMIN',
    )) {
      const { member, subject } = await memberAs(role);
      const browser = new Browser();
      const login = await browser.get('/api/v1/auth/login?returnTo=%2Far');
      const preauth = browser.jar.get(PREAUTH);

      // A password alone (level 1): no session; back to the provider, in the
      // same browser, asking for the second factor.
      const once = await browser.callback(new URL(login.headers.location), {
        claims: { sub: subject, acr: '1' },
      });
      expect([role, once.status]).toEqual([role, 303]);
      const again = new URL(once.headers.location);
      expect(again.origin + again.pathname).toBe(
        `${issuer.issuer}/protocol/openid-connect/auth`,
      );
      expect(again.searchParams.get('acr_values')).toBe('2');
      expect(setCookiesOf(once).has(SESSION)).toBe(false);
      expect(browser.jar.get(PREAUTH)).toBe(preauth);
      expect(await sessionsOf(member)).toEqual([]);

      // With the second factor (level 2): the session, back where it began.
      const twice = await browser.callback(again, {
        claims: { sub: subject, acr: '2', amr: ['pwd', 'otp'] },
      });
      expect([role, twice.status, twice.headers.location]).toEqual([
        role,
        303,
        `https://${host}/ar`,
      ]);
      expect(await sessionsOf(member)).toEqual([
        expect.objectContaining({ acr: '2', amr: ['pwd', 'otp'] }),
      ]);
    }

    // Asked for the second factor and still not given it: refused, never
    // asked again, and no session.
    const { member, subject } = await memberAs('OWNER');
    const browser = new Browser();
    const login = await browser.get('/api/v1/auth/login');
    const once = await browser.callback(new URL(login.headers.location), {
      claims: { sub: subject, acr: '1' },
    });
    const refused = await browser.callback(new URL(once.headers.location), {
      claims: { sub: subject, acr: '1' },
    });
    expect(problemOf(refused)).toEqual({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(refused.headers.location).toBeUndefined();
    expect(browser.jar.has(PREAUTH)).toBe(false);
    expect(await sessionsOf(member)).toEqual([]);

    // Any other role signs in with a password.
    const coach = await memberAs('COACH');
    const plain = new Browser();
    const plainLogin = await plain.get('/api/v1/auth/login');
    const signedIn = await plain.callback(
      new URL(plainLogin.headers.location),
      {
        claims: { sub: coach.subject, acr: '1' },
      },
    );
    expect(setCookiesOf(signedIn).has(SESSION)).toBe(true);

    // A member made privileged mid-session holds it no longer: their next
    // request is refused, and signing in again asks for the second factor.
    expect((await plain.get('/api/v1/auth/session')).status).toBe(200);
    await asTenant(agency.id, (tx) =>
      tx.user.update({
        where: { id: coach.member.id },
        data: { role: 'ADMIN' },
      }),
    );
    expect(problemOf(await plain.get('/api/v1/auth/session'))).toEqual({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('a_sensitive_action_requires_recent_authentication', async () => {
    const coach = await createMember(agency, 'COACH');
    const admin = await createMember(agency, 'ADMIN');
    for (const member of [coach, admin]) {
      const headers = await signedInAs(member);
      const approve = () =>
        booted.http
          .post('/api/v1/probe/assurance/approve')
          .set(headers)
          .send({});
      const note = () =>
        booted.http.post('/api/v1/probe/assurance/note').set(headers).send({});
      const authenticatedAgo = (ms: number) =>
        asTenant(agency.id, (tx) =>
          tx.userSession.updateMany({
            where: {
              tokenHash: new Uint8Array(sha256(headers.Cookie.split('=')[1])),
            },
            data: { authTime: new Date(Date.now() - ms) },
          }),
        );

      // Just signed in: the sensitive action runs.
      expect((await approve()).status).toBe(201);
      // Four minutes and fifty seconds on: still recent.
      await authenticatedAgo(4 * 60 * 1000 + 50 * 1000);
      expect((await approve()).status).toBe(201);

      // Past five minutes: refused, naming where to authenticate again; an
      // ordinary write of the same session still runs.
      await authenticatedAgo(5 * 60 * 1000 + 1000);
      const refused = await approve();
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'STEP_UP_REQUIRED',
        stepUpUrl: '/api/v1/auth/step-up',
      });
      expect((await note()).status).toBe(201);
    }
  });

  it('step_up_upgrades_the_existing_session', async () => {
    const { member, subject } = await memberAs('COACH');
    const browser = new Browser();
    const login = await browser.get('/api/v1/auth/login');
    await browser.callback(new URL(login.headers.location), {
      claims: { sub: subject, acr: '1', auth_time: now() - 600 },
    });
    const [before] = await sessionsOf(member);
    const oldToken = browser.jar.get(SESSION) ?? '';
    expect((await browser.post('/api/v1/probe/assurance/approve')).status).toBe(
      403,
    );

    // The step-up route: back to the provider, to authenticate again
    // (max_age=0), bound to the session the browser holds.
    const start = await browser.get(
      '/api/v1/auth/step-up?returnTo=%2Far%2Fcontracts',
    );
    expect(start.status).toBe(303);
    expect(setCookiesOf(start).size).toBe(0);
    const asked = new URL(start.headers.location);
    expect(asked.searchParams.get('max_age')).toBe('0');
    expect(asked.searchParams.get('acr_values')).toBeNull();

    // Authenticated again: the same session, its token replaced, its
    // authentication renewed; back where the step-up began.
    const done = await browser.callback(asked, {
      claims: { sub: subject, acr: '1', auth_time: now() },
    });
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(`https://${host}/ar/contracts`);
    const newToken = browser.jar.get(SESSION) ?? '';
    expect(newToken).not.toBe(oldToken);
    const maxAge = Number(
      setCookiesOf(done).get(SESSION)?.attributes['max-age'],
    );
    expect(maxAge * 1000).toBeLessThanOrEqual(
      before.absoluteExpiresAt.getTime() - Date.now() + 1000,
    );
    const [after, ...others] = await sessionsOf(member);
    expect(others).toEqual([]);
    expect(after).toMatchObject({
      id: before.id,
      createdAt: before.createdAt,
      absoluteExpiresAt: before.absoluteExpiresAt,
      revision: before.revision + 1,
    });
    expect(Buffer.from(after.tokenHash)).toEqual(sha256(newToken));
    expect(after.authTime.getTime()).toBeGreaterThan(before.authTime.getTime());

    // The old token signs nobody in; the new one acts at once.
    const stale = await booted.http
      .get('/api/v1/auth/session')
      .set('Host', host)
      .set('Cookie', `${SESSION}=${oldToken}`);
    expect(stale.status).toBe(401);
    expect((await browser.post('/api/v1/probe/assurance/approve')).status).toBe(
      201,
    );
  });

  it('a_step_up_changes_nothing_unless_its_browser_and_person_complete_it', async () => {
    const { member, subject } = await memberAs('COACH');
    const browser = new Browser();
    const login = await browser.get('/api/v1/auth/login');
    await browser.callback(new URL(login.headers.location), {
      claims: { sub: subject, acr: '1', auth_time: now() - 600 },
    });
    const [before] = await sessionsOf(member);
    const unchanged = async () => {
      const [row] = await sessionsOf(member);
      expect(row).toMatchObject({
        tokenHash: before.tokenHash,
        authTime: before.authTime,
        revision: before.revision,
      });
      expect((await browser.get('/api/v1/auth/session')).status).toBe(200);
    };
    const stepUp = async () =>
      new URL((await browser.get('/api/v1/auth/step-up')).headers.location);

    // Completed in another browser — one with no session, and one signed in
    // as someone else — the member's step-up is refused.
    const empty = new Browser();
    const fromEmpty = await empty.callback(await stepUp(), {
      claims: { sub: subject, auth_time: now() },
    });
    expect(fromEmpty.status).toBe(401);
    await unchanged();
    const intruder = await memberAs('COACH');
    const elsewhere = new Browser();
    const intruderLogin = await elsewhere.get('/api/v1/auth/login');
    await elsewhere.callback(new URL(intruderLogin.headers.location), {
      claims: { sub: intruder.subject, acr: '1' },
    });
    const fromElsewhere = await elsewhere.callback(await stepUp(), {
      claims: { sub: subject, auth_time: now() },
    });
    expect(fromElsewhere.status).toBe(401);
    expect(setCookiesOf(fromElsewhere).has(SESSION)).toBe(false);
    await unchanged();

    // Proved as another person: refused.
    const stranger = await browser.callback(await stepUp(), {
      claims: { sub: randomUUID(), auth_time: now() },
    });
    expect(problemOf(stranger)).toEqual({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
    await unchanged();

    // An authentication that is not fresh, for max_age=0: refused.
    const old = await browser.callback(await stepUp(), {
      claims: { sub: subject, auth_time: now() - 600 },
    });
    expect(old.status).toBe(401);
    await unchanged();

    // A privileged member's step-up asks for the second factor, and
    // refuses without it.
    const admin = await memberAs('ADMIN');
    const privileged = new Browser();
    const adminLogin = await privileged.get('/api/v1/auth/login');
    const once = await privileged.callback(
      new URL(adminLogin.headers.location),
      {
        claims: { sub: admin.subject, acr: '1' },
      },
    );
    await privileged.callback(new URL(once.headers.location), {
      claims: { sub: admin.subject, acr: '2' },
    });
    const asked = new URL(
      (await privileged.get('/api/v1/auth/step-up')).headers.location,
    );
    expect(asked.searchParams.get('acr_values')).toBe('2');
    const withoutFactor = await privileged.callback(asked, {
      claims: { sub: admin.subject, acr: '1', auth_time: now() },
    });
    expect(withoutFactor.status).toBe(401);
    expect((await privileged.get('/api/v1/auth/session')).status).toBe(200);
  });
});
