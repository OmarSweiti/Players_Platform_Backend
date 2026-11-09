import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Tenant, User } from '@prisma/client';
import { Redis } from 'ioredis';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/config/env.schema';
import { KeycloakIdentityProvider } from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';
import { attemptKeyOf } from '../../src/modules/identity/infrastructure/valkey/valkey-sign-in-attempts';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  runPrisma,
  securityEventsOf,
} from '../harness/fixtures';
import { LogCapture } from '../harness/log-capture';
import { setCookiesOf } from '../support/set-cookies';
import { TestIssuer, type Hostile } from '../support/test-issuer';

// Sign-in through the API (0.5.5; ADR-0003, SR-CORE-001), end to end against
// an issuer in this process (test/support/test-issuer.ts): the login route,
// the provider's answer, and the callback, as a browser makes them. Each
// Browser keeps its own cookies and comes from its own address, through the
// trusted proxy, so that every scenario has the `auth` rate limit to itself.
// Tenants are found from the host, {slug}.localhost (0.5.2).
vi.hoisted(() => {
  process.env.APEX_DOMAIN = 'localhost';
});

const PREAUTH = '__Host-Http-sadara_preauth';
const SESSION = '__Host-Http-sadara_session';
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const suffix = () => randomBytes(4).toString('hex');

describe('sign-in through the API', () => {
  const logs = new LogCapture();
  let issuer: TestIssuer;
  let booted: BootedApp;
  let valkey: Redis;
  let agency: Tenant;
  let english: Tenant;
  let member: User;
  let addresses = 0;

  /** A browser on `host`: its own cookie jar, its own address. */
  class Browser {
    readonly jar = new Map<string, string>();
    private readonly address = `192.0.2.${(addresses += 1)}`;

    constructor(readonly host = `${agency.slug}.localhost`) {}

    /** One request, as the browser sends it; a redirect is not followed. */
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

    login(returnTo?: string): Promise<Response> {
      const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
      return this.get(`/api/v1/auth/login${query}`);
    }

    /** Signs in at the provider: the callback URL the provider sends back. */
    async authorize(hostile: Hostile = {}, returnTo?: string): Promise<URL> {
      const login = await this.login(returnTo);
      expect(login.status).toBe(303);
      return issuer.authorize(new URL(login.headers.location), hostile);
    }

    /** Comes back to the API with the provider's answer. */
    callback(answer: URL): Promise<Response> {
      return this.get(`${answer.pathname}${answer.search}`);
    }
  }

  /** A new identity at the test issuer, and its subject. */
  async function identity(subject: string = randomUUID()) {
    const { id } = await runPrisma().identity.create({
      data: { issuer: issuer.issuer, subject },
    });
    return { id, subject };
  }

  /** A member of `tenant` linked to the identity, changed by `data`. */
  async function memberOf(
    tenant: Tenant,
    identityId: string | null,
    data: { isActive?: boolean; deletedAt?: Date; email?: string } = {},
  ): Promise<User> {
    const created = await createMember(tenant, 'COACH');
    return asTenant(tenant.id, (tx) =>
      tx.user.update({
        where: { id: created.id },
        data: {
          identityId,
          ...data,
          ...(data.email ? { normalizedEmail: data.email } : {}),
        },
      }),
    );
  }

  const sessionsOf = (tenant: Tenant, user: User) =>
    asTenant(tenant.id, (tx) =>
      tx.userSession.findMany({ where: { userId: user.id } }),
    );

  /** A problem, without what differs on every request: its ids. */
  function problemOf(response: Response) {
    const {
      instance: _instance,
      requestId: _requestId,
      ...rest
    } = response.body as Record<string, unknown>;
    return { status: response.status, ...rest };
  }

  /** What every refused callback has in common: no session, nothing kept. */
  function expectNoSession(response: Response) {
    expect(response.headers.location).toBeUndefined();
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
    booted = await bootApp({
      logs,
      trustedProxies: ['loopback'],
      identityProvider: new KeycloakIdentityProvider({
        get: (name: keyof Env) => env[name],
      } as unknown as ConfigService<Env, true>),
    });
    valkey = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
    await valkey.connect();
    agency = await createTenant({ slug: `agency-${suffix()}` });
    english = await createTenant({ slug: `english-${suffix()}` });
    await asTenant(english.id, (tx) =>
      tx.tenant.update({
        where: { id: english.id },
        data: { defaultLocale: 'en' },
      }),
    );
    member = await memberOf(agency, (await identity(issuer.subject)).id);
    logs.start();
  });

  afterAll(async () => {
    logs.stop();
    valkey?.disconnect();
    await booted?.app.close();
    await issuer?.close();
  });

  it('a_member_signs_in_end_to_end', async () => {
    const browser = new Browser();
    const host = `https://${agency.slug}.localhost`;

    // The login route: to the provider, for this host's callback, in the
    // tenant's language, bound to this browser by the pre-auth cookie.
    const login = await browser.login('/ar/players?tab=contracts#current');
    expect(login.status).toBe(303);
    expect(login.headers['cache-control']).toBe('no-store');
    const authorization = new URL(login.headers.location);
    expect(authorization.origin + authorization.pathname).toBe(
      `${issuer.issuer}/protocol/openid-connect/auth`,
    );
    const asked = Object.fromEntries(authorization.searchParams);
    expect(asked).toEqual({
      client_id: issuer.clientId,
      response_type: 'code',
      redirect_uri: `${host}/api/v1/auth/callback`,
      scope: 'openid',
      state: expect.stringMatching(SECRET) as string,
      nonce: expect.stringMatching(SECRET) as string,
      code_challenge: expect.stringMatching(SECRET) as string,
      code_challenge_method: 'S256',
      ui_locales: 'ar',
    });
    const preauth = setCookiesOf(login).get(PREAUTH);
    expect(preauth?.value).toMatch(SECRET);
    expect(preauth?.attributes).toEqual({
      'max-age': '600',
      path: '/',
      expires: expect.any(String) as string,
      httponly: '',
      secure: '',
      samesite: 'Lax',
    });

    // The attempt waits in Valkey for ten minutes, under its state's digest,
    // holding the browser's digest and never its cookie.
    const key = attemptKeyOf(asked.state);
    const kept = await valkey.get(key);
    expect(kept).not.toContain(preauth?.value);
    expect(JSON.parse(kept ?? '{}')).toMatchObject({
      tenantId: agency.id,
      returnTo: '/ar/players?tab=contracts#current',
      browserBinding: sha256(preauth?.value ?? '').toString('base64url'),
    });
    const ttl = await valkey.pttl(key);
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(600_000);

    // The callback: a session for the member, back where sign-in began.
    const answer = issuer.authorize(authorization);
    const signedIn = await browser.callback(answer);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.location).toBe(
      `${host}/ar/players?tab=contracts#current`,
    );
    expect(signedIn.headers['cache-control']).toBe('no-store');
    const cookies = setCookiesOf(signedIn);
    const session = cookies.get(SESSION);
    expect(session?.value).toMatch(SECRET);
    expect(session?.attributes).toEqual({
      'max-age': String(12 * 60 * 60),
      path: '/',
      expires: expect.any(String) as string,
      httponly: '',
      secure: '',
      samesite: 'Lax',
    });
    // The pre-auth cookie is cleared, with the attributes it was set with.
    expect(cookies.get(PREAUTH)).toEqual({
      value: '',
      attributes: {
        path: '/',
        expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
        httponly: '',
        secure: '',
        samesite: 'Lax',
      },
    });
    expect(await valkey.exists(key)).toBe(0);

    // The row: the token's digest, who signed in and how, and its expiries.
    const [row, ...others] = await sessionsOf(agency, member);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      tenantId: agency.id,
      identityId: member.identityId,
      issuer: issuer.issuer,
      subject: issuer.subject,
      providerSid: issuer.sid,
      acr: '1',
      amr: ['pwd'],
      revokedAt: null,
      revision: 1,
    });
    expect(Buffer.from(row.tokenHash)).toEqual(sha256(session?.value ?? ''));
    const opened = row.createdAt.getTime();
    expect(row.lastSeenAt.getTime()).toBe(opened);
    expect(row.idleExpiresAt.getTime() - opened).toBe(30 * 60 * 1000);
    expect(row.absoluteExpiresAt.getTime() - opened).toBe(12 * 60 * 60 * 1000);
    expect(Math.abs(row.authTime.getTime() - (opened - 5000))).toBeLessThan(
      2000,
    );

    // Its security event (0.7.3), written with the session: who, how, the
    // session, the tenant, the request, and the address only as its hash.
    expect(await securityEventsOf(signedIn.headers['x-request-id'])).toEqual([
      expect.objectContaining({
        source: 'SADARA',
        eventType: 'sign_in',
        outcome: 'SUCCEEDED',
        reasonCode: null,
        tenantHint: agency.id,
        issuer: issuer.issuer,
        subject: issuer.subject,
        sessionId: row.id,
        networkHash: expect.any(Uint8Array) as Uint8Array,
        metadata: { acr: '1', amr: 'pwd' },
      }),
    ]);

    // Without a return path, sign-in returns to the start of the web app; a
    // tenant whose members start in English sees the provider in English.
    const englishBrowser = new Browser(`${english.slug}.localhost`);
    const inEnglish = new URL((await englishBrowser.login()).headers.location);
    expect(inEnglish.searchParams.get('ui_locales')).toBe('en');

    // Nothing of it reached the log: not the cookies, the state or the code.
    const secrets = [
      preauth?.value,
      session?.value,
      asked.state,
      asked.nonce,
      answer.searchParams.get('code'),
    ];
    expect(logs.lines.length).toBeGreaterThan(0);
    for (const line of logs.lines) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });

  it('a_non_member_gets_no_session', async () => {
    // What an unknown host answers (0.5.2): "no account here".
    const unknown = problemOf(
      await new Browser(`nobody-${suffix()}.localhost`).login(),
    );
    expect(unknown).toMatchObject({ status: 404, code: 'NOT_FOUND' });

    const elsewhere = await createTenant({ slug: `elsewhere-${suffix()}` });
    const stranger = await identity();
    const theirs = await identity();
    const away = await memberOf(elsewhere, theirs.id);
    const resting = await identity();
    const inactive = await memberOf(agency, resting.id, { isActive: false });
    const gone = await identity();
    const archived = await memberOf(agency, gone.id, {
      deletedAt: new Date(),
    });
    // An unlinked membership with the address the provider asserts: an
    // identity is never linked by email alone.
    const unlinked = await identity();
    const sameAddress = await memberOf(agency, null, {
      email: 'member@agency.test',
    });

    for (const [who, subject] of [
      ['an identity Sadara has never seen', stranger.subject],
      ["a member of another tenant's", theirs.subject],
      ['an inactive member', resting.subject],
      ['an archived member', gone.subject],
      ['an identity whose address a member has', unlinked.subject],
    ]) {
      const browser = new Browser();
      const answer = await browser.authorize({ claims: { sub: subject } });
      const refused = await browser.callback(answer);
      expect([who, problemOf(refused)]).toEqual([who, unknown]);
      expectNoSession(refused);
      // Recorded (0.7.3): whom the provider proved, refused in this tenant.
      expect([
        who,
        await securityEventsOf(refused.headers['x-request-id']),
      ]).toEqual([
        who,
        [
          expect.objectContaining({
            eventType: 'sign_in',
            outcome: 'REFUSED',
            reasonCode: 'no_account',
            tenantHint: agency.id,
            issuer: issuer.issuer,
            subject,
            sessionId: null,
          }),
        ],
      ]);
    }
    for (const [tenant, user] of [
      [elsewhere, away],
      [agency, inactive],
      [agency, archived],
      [agency, sameAddress],
    ] as const) {
      expect(await sessionsOf(tenant, user)).toEqual([]);
    }
  });

  it('a_replayed_or_mismatched_state_is_refused', async () => {
    const before = (await sessionsOf(agency, member)).length;
    const refusedAs = (response: Response) => {
      expect(problemOf(response)).toMatchObject({
        status: 401,
        code: 'AUTHENTICATION_REQUIRED',
      });
      expectNoSession(response);
    };

    // A callback taken once: replayed in the browser that made it — with the
    // pre-auth cookie it began with, or with a sign-in of its own in flight —
    // it is refused.
    const browser = new Browser();
    const answer = await browser.authorize();
    const began = browser.jar.get(PREAUTH) ?? '';
    expect((await browser.callback(answer)).status).toBe(303);
    browser.jar.set(PREAUTH, began);
    refusedAs(await browser.callback(answer));
    await browser.login();
    refusedAs(await browser.callback(answer));

    // A state this API never handed out, or none.
    const tampered = new Browser();
    const real = await tampered.authorize();
    const forged = new URL(real);
    forged.searchParams.set('state', randomBytes(32).toString('base64url'));
    refusedAs(await tampered.callback(forged));
    const stateless = new Browser();
    const bare = await stateless.authorize();
    bare.searchParams.delete('state');
    refusedAs(await stateless.callback(bare));

    // A provider's answer that names another state than the one it was
    // sent, in the browser that holds the attempt.
    const mixed = new Browser();
    const first = await mixed.authorize();
    const second = await mixed.authorize();
    const swapped = new URL(second);
    swapped.searchParams.set('state', first.searchParams.get('state') ?? '');
    refusedAs(await mixed.callback(swapped));

    // An attempt begun on one tenant's host, brought back on another's.
    const wanderer = new Browser();
    const begun = await wanderer.authorize();
    const onEnglish = new Browser(`${english.slug}.localhost`);
    onEnglish.jar.set(PREAUTH, wanderer.jar.get(PREAUTH) ?? '');
    refusedAs(await onEnglish.callback(begun));

    // Only the one sign-in that completed opened a session.
    expect(await sessionsOf(agency, member)).toHaveLength(before + 1);
  });

  it('a_callback_from_another_browser_is_refused', async () => {
    // Login CSRF: someone signs in as themselves and has another browser
    // finish it, to sign that browser in as them.
    const theirs = await identity();
    const attacker = await memberOf(agency, theirs.id);
    const mallory = new Browser();
    const answer = await mallory.authorize({ claims: { sub: theirs.subject } });

    // A browser with no sign-in in flight, and one with its own.
    const victim = new Browser();
    const refused = await victim.callback(answer);
    expect(problemOf(refused)).toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
    });
    expectNoSession(refused);
    const busy = new Browser();
    await busy.login();
    const alsoRefused = await busy.callback(answer);
    expect(alsoRefused.status).toBe(401);
    expectNoSession(alsoRefused);

    // No session for the attacker anywhere, and their answer is spent.
    expect(await sessionsOf(agency, attacker)).toEqual([]);
    const spent = await mallory.callback(answer);
    expect(spent.status).toBe(401);
    expectNoSession(spent);
    expect(await sessionsOf(agency, attacker)).toEqual([]);
  });

  it('return_to_cannot_leave_the_origin', async () => {
    for (const returnTo of [
      'https://elsewhere.test/',
      '//elsewhere.test/ar',
      '/\\elsewhere.test',
      '\\\\elsewhere.test',
      '/.//elsewhere.test',
      'javascript:alert(1)',
      'ar/players',
      '/ar/players\r\nSet-Cookie: x=y',
      `/${'a'.repeat(2048)}`,
    ]) {
      const browser = new Browser();
      const refused = await browser.login(returnTo);
      const problem = problemOf(refused) as {
        fieldErrors?: Array<{ field: string }>;
      };
      expect([returnTo, problem]).toEqual([
        returnTo,
        expect.objectContaining({ status: 400, code: 'VALIDATION_FAILED' }),
      ]);
      // Each issue names the return path: one too long is also no path.
      expect(new Set(problem.fieldErrors?.map(({ field }) => field))).toEqual(
        new Set(['/returnTo']),
      );
      // Refused before anything began: no cookie, no provider.
      expect(refused.headers.location).toBeUndefined();
      expect(refused.headers['set-cookie']).toBeUndefined();
    }

    // A path on this origin, query and fragment and all, is where it ends.
    const browser = new Browser();
    const answer = await browser.authorize({}, '/en/players/42?view=card#bio');
    const signedIn = await browser.callback(answer);
    expect(signedIn.headers.location).toBe(
      `https://${agency.slug}.localhost/en/players/42?view=card#bio`,
    );
    // Unsaid, it is the start of the web app.
    const plain = new Browser();
    expect(
      (await plain.callback(await plain.authorize())).headers.location,
    ).toBe(`https://${agency.slug}.localhost/`);
  });
});
