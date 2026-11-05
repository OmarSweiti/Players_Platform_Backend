import { createHash, randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Tenant, User } from '@prisma/client';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CurrentTenantContext } from '../../src/common/decorators/tenant-context.decorator';
import { csrfTokenOf } from '../../src/common/security/csrf-tokens';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import type { Env } from '../../src/config/env.schema';
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
import { TestIssuer } from '../support/test-issuer';

// Server sessions, the session cookie and CSRF (0.5.6; ADR-0003, ADR-0023,
// SR-AUTH-003, SR-ACL-007). The session sign-in opened (0.5.5) authenticates
// every request, checked in PostgreSQL each time; a write needs its CSRF
// token, this host's Origin, and same-origin fetch metadata. The CSRF key is
// mid-rotation here, so that the previous key's tokens are still accepted.
const PREVIOUS_KEY = vi.hoisted(() => {
  const key = 'the-previous-csrf-key-of-this-test-file';
  process.env.CSRF_SECRET_PREVIOUS = key;
  return key;
});

const SESSION = '__Host-Http-sadara_session';

@Controller('probe/sessions')
class SessionProbe {
  /** Who the request acts as: the context the session guard minted. */
  @Get('context')
  context(@CurrentTenantContext() ctx: AuthorizedTenantContext) {
    return { tenantId: ctx.tenantId, actor: ctx.actor };
  }

  @Post('notes')
  write(
    @Body({ schema: z.strictObject({ note: z.string().max(20) }) })
    body: {
      note: string;
    },
  ) {
    return body;
  }

  @Delete('notes')
  remove() {
    return null;
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const suffix = () => randomBytes(4).toString('hex');

describe('server sessions, the session cookie and CSRF', () => {
  let issuer: TestIssuer;
  let booted: BootedApp;
  let agency: Tenant;
  let other: Tenant;
  let member: User;

  /** The problem a refused request answered, without its ids. */
  const problemOf = (response: Response) => {
    const {
      instance: _instance,
      requestId: _requestId,
      ...rest
    } = response.body as Record<string, unknown>;
    return { status: response.status, ...rest };
  };
  const refusedAs = (status: number, code: string) =>
    expect.objectContaining({ status, code }) as unknown;

  /** The session row a set of signed-in headers carries. */
  async function sessionOf(headers: Record<string, string>) {
    const token = headers.Cookie.split('=')[1];
    return asTenant(agency.id, (tx) =>
      tx.userSession.findFirstOrThrow({
        where: { tokenHash: new Uint8Array(sha256(token)) },
      }),
    );
  }

  const read = (headers: Record<string, string>) =>
    booted.http.get('/api/v1/auth/session').set(headers);
  const write = (
    headers: Record<string, string>,
    body: unknown = { note: 'n' },
  ) =>
    booted.http
      .post('/api/v1/probe/sessions/notes')
      .set(headers)
      .send(body as object);

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
      controllers: [SessionProbe],
      identityProvider: new KeycloakIdentityProvider({
        get: (name: keyof Env) => env[name],
      } as unknown as ConfigService<Env, true>),
    });
    agency = await createTenant({ slug: `agency-${suffix()}` });
    other = await createTenant({ slug: `other-${suffix()}` });
    member = await createMember(agency, 'COACH');
  });

  afterAll(async () => {
    await booted?.app.close();
    await issuer?.close();
  });

  it('the_session_cookie_is_host_only_httponly_and_secure', async () => {
    // A real sign-in (0.5.5): the member's identity at the test issuer.
    const { id: identityId } = await runPrisma().identity.create({
      data: { issuer: issuer.issuer, subject: issuer.subject },
    });
    const signedIn = await createMember(agency, 'COACH');
    await asTenant(agency.id, (tx) =>
      tx.user.update({ where: { id: signedIn.id }, data: { identityId } }),
    );
    const host = `${agency.slug}.localhost`;
    const login = await booted.http
      .get('/api/v1/auth/login')
      .set('Host', host)
      .redirects(0);
    const preauth = setCookiesOf(login).get('__Host-Http-sadara_preauth');
    const answer = issuer.authorize(new URL(login.headers.location));
    const callback = await booted.http
      .get(`${answer.pathname}${answer.search}`)
      .set('Host', host)
      .set('Cookie', `__Host-Http-sadara_preauth=${preauth?.value}`)
      .redirects(0);
    expect(callback.status).toBe(303);

    // The cookie: host-only (no Domain), the whole site (Path=/), never to a
    // script (HttpOnly), over HTTPS only (Secure), and not on a cross-site
    // request other than a top-level navigation (SameSite=Lax); its
    // `__Host-Http-` name makes the browser enforce the first two and refuse
    // one a script tries to set (ADR-0023).
    const cookie = setCookiesOf(callback).get(SESSION);
    expect(cookie?.attributes).toEqual({
      'max-age': String(12 * 60 * 60),
      path: '/',
      expires: expect.any(String) as string,
      httponly: '',
      secure: '',
      samesite: 'Lax',
    });
    const value = cookie?.value ?? '';

    // On its host it signs the member in, every tab alike…
    const session = await booted.http
      .get('/api/v1/auth/session')
      .set('Host', host)
      .set('Cookie', `${SESSION}=${value}`);
    expect(session.status).toBe(200);
    expect(session.headers['cache-control']).toBe('no-store');
    const { data } = session.body as {
      data: {
        member: { id: string };
        tenant: { id: string };
        csrfToken: string;
      };
    };
    expect(data).toEqual({
      member: {
        id: signedIn.id,
        role: 'COACH',
        firstName: null,
        lastName: null,
      },
      tenant: {
        id: agency.id,
        slug: agency.slug,
        name: agency.name,
        locale: 'ar',
      },
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
    });

    // …and nowhere else: not on another tenant's host, not under another
    // name, not without it.
    const elsewhere = await booted.http
      .get('/api/v1/auth/session')
      .set('Host', `${other.slug}.localhost`)
      .set('Cookie', `${SESSION}=${value}`);
    expect(problemOf(elsewhere)).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    for (const name of ['sadara_session', '__Host-sadara_session']) {
      const renamed = await booted.http
        .get('/api/v1/auth/session')
        .set('Host', host)
        .set('Cookie', `${name}=${value}`);
      expect([name, renamed.status]).toEqual([name, 401]);
    }
    expect(
      (await booted.http.get('/api/v1/auth/session').set('Host', host)).status,
    ).toBe(401);
  });

  it('a_request_acts_as_its_sessions_member_and_tenant', async () => {
    const headers = await signedInAs(member);
    const { id: sessionId } = await sessionOf(headers);
    // A tenant named by the request itself changes nothing.
    const response = await booted.http
      .get('/api/v1/probe/sessions/context')
      .set(headers)
      .set('X-Tenant-ID', other.id);
    expect(response.body).toEqual({
      data: {
        tenantId: agency.id,
        actor: { kind: 'USER', userId: member.id, sessionId },
      },
    });
  });

  it('a_write_without_the_csrf_token_is_refused', async () => {
    const headers = await signedInAs(member);
    const { csrfToken } = (
      (await read(headers)).body as { data: { csrfToken: string } }
    ).data;
    // The token the session hands out is the one its writes carry.
    expect(csrfToken).toBe(headers['X-CSRF-Token']);
    expect((await write(headers)).status).toBe(201);
    expect(
      (await booted.http.delete('/api/v1/probe/sessions/notes').set(headers))
        .status,
    ).toBe(200);

    const { 'X-CSRF-Token': _token, ...without } = headers;
    const another = await signedInAs(member);
    const { tokenHash } = await sessionOf(headers);
    for (const [why, presented] of [
      ['none at all', undefined],
      ['an empty one', ''],
      ['a random one', randomBytes(32).toString('base64url')],
      ["another session's", another['X-CSRF-Token']],
      [
        'one under a key the API does not hold',
        csrfTokenOf(tokenHash, 'x'.repeat(32)),
      ],
    ] as const) {
      const sent =
        presented === undefined
          ? without
          : { ...without, 'X-CSRF-Token': presented };
      expect([why, problemOf(await write(sent))]).toEqual([
        why,
        refusedAs(403, 'CSRF_FAILED'),
      ]);
      const removed = await booted.http
        .delete('/api/v1/probe/sessions/notes')
        .set(sent);
      expect([why, removed.status]).toEqual([why, 403]);
    }

    // While the key rotates, a token derived under the previous one holds.
    const underPrevious = csrfTokenOf(tokenHash, PREVIOUS_KEY);
    expect(
      (await write({ ...headers, 'X-CSRF-Token': underPrevious })).status,
    ).toBe(201);
  });

  it('a_write_that_is_not_json_is_refused', async () => {
    const headers = await signedInAs(member);
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await booted.http
        .post('/api/v1/probe/sessions/notes')
        .set(headers)
        .set('Content-Type', type)
        .send('note=n');
      expect([type, problemOf(response)]).toEqual([
        type,
        refusedAs(415, 'UNSUPPORTED_MEDIA_TYPE'),
      ]);
    }
  });

  it('a_write_from_another_origin_is_refused', async () => {
    const headers = await signedInAs(member);
    const { Origin: _origin, ...without } = headers;
    for (const origin of [
      undefined,
      'https://elsewhere.test',
      `https://${other.slug}.localhost`,
      `http://${agency.slug}.localhost`,
      `https://${agency.slug}.localhost:8443`,
      'null',
    ]) {
      const sent =
        origin === undefined ? without : { ...without, Origin: origin };
      expect([origin, problemOf(await write(sent))]).toEqual([
        origin,
        refusedAs(403, 'CSRF_FAILED'),
      ]);
    }
    expect((await write(headers)).status).toBe(201);
  });

  it('a_cross_site_fetch_is_refused_even_with_the_token', async () => {
    // The cookie, the right token and this host's Origin, from a request the
    // browser says another site made: fetch metadata alone refuses it.
    const headers = await signedInAs(member);
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await write({ ...headers, 'Sec-Fetch-Site': site });
      expect([site, problemOf(response)]).toEqual([
        site,
        refusedAs(403, 'CSRF_FAILED'),
      ]);
    }
    expect(
      (await write({ ...headers, 'Sec-Fetch-Site': 'same-origin' })).status,
    ).toBe(201);
    // A browser that sends no fetch metadata is judged by the rest.
    expect((await write(headers)).status).toBe(201);
    // Reads change nothing, and carry no token.
    const { 'X-CSRF-Token': _token, Origin: _origin, ...bare } = headers;
    expect(
      (await read({ ...bare, 'Sec-Fetch-Site': 'cross-site' })).status,
    ).toBe(200);
  });

  it('a_revoked_session_fails_on_the_next_request', async () => {
    const headers = await signedInAs(member);
    const otherTab = await signedInAs(member);
    expect((await read(headers)).status).toBe(200);
    const { id } = await sessionOf(headers);
    await asTenant(agency.id, (tx) =>
      tx.userSession.update({
        where: { id },
        data: { revokedAt: new Date(), revokeReason: 'SIGN_OUT' },
      }),
    );
    expect(problemOf(await read(headers))).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    expect(problemOf(await write(headers))).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    // Only that session: the member's other one still holds.
    expect((await read(otherTab)).status).toBe(200);
  });

  it('a_session_past_its_expiry_is_refused', async () => {
    for (const lapsed of ['idleExpiresAt', 'absoluteExpiresAt'] as const) {
      const headers = await signedInAs(member);
      const { id } = await sessionOf(headers);
      const past = new Date(Date.now() - 1000);
      await asTenant(agency.id, (tx) =>
        tx.userSession.update({
          where: { id },
          data:
            lapsed === 'idleExpiresAt'
              ? { idleExpiresAt: past }
              : { idleExpiresAt: past, absoluteExpiresAt: past },
        }),
      );
      expect([lapsed, problemOf(await read(headers))]).toEqual([
        lapsed,
        refusedAs(401, 'SESSION_EXPIRED'),
      ]);
    }
  });

  it('a_session_is_renewed_but_never_past_its_absolute_expiry', async () => {
    const headers = await signedInAs(member);
    const { id } = await sessionOf(headers);
    const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);
    const stamp = (data: object) =>
      asTenant(agency.id, (tx) =>
        tx.userSession.update({ where: { id }, data }),
      );

    // Seen two minutes ago: a request moves the idle expiry 30 minutes on.
    await stamp({
      createdAt: minutes(-3),
      lastSeenAt: minutes(-2),
      idleExpiresAt: minutes(5),
    });
    const before = Date.now();
    expect((await read(headers)).status).toBe(200);
    const renewed = await sessionOf(headers);
    expect(renewed.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(renewed.idleExpiresAt.getTime() - renewed.lastSeenAt.getTime()).toBe(
      30 * 60 * 1000,
    );
    expect(renewed.revision).toBe(2);

    // Seen just now: no write at all.
    expect((await read(headers)).status).toBe(200);
    expect((await sessionOf(headers)).revision).toBe(2);

    // Ten minutes from its absolute expiry, renewal stops there.
    await stamp({
      createdAt: minutes(-3),
      lastSeenAt: minutes(-2),
      idleExpiresAt: minutes(5),
      absoluteExpiresAt: minutes(10),
    });
    expect((await read(headers)).status).toBe(200);
    const capped = await sessionOf(headers);
    expect(capped.idleExpiresAt).toEqual(capped.absoluteExpiresAt);
  });

  it('a_deactivated_member_loses_access_on_the_next_request', async () => {
    const leaving = await createMember(agency, 'COACH');
    const headers = await signedInAs(leaving);
    const setMember = (data: { isActive?: boolean; deletedAt?: Date | null }) =>
      asTenant(agency.id, (tx) =>
        tx.user.update({ where: { id: leaving.id }, data }),
      );
    expect((await read(headers)).status).toBe(200);

    await setMember({ isActive: false });
    expect(problemOf(await read(headers))).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    expect(problemOf(await write(headers))).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    await setMember({ isActive: true });
    expect((await read(headers)).status).toBe(200);

    await setMember({ deletedAt: new Date() });
    expect((await read(headers)).status).toBe(401);
    await setMember({ deletedAt: null });

    // A tenant switched off takes its members' sessions with it.
    await asTenant(agency.id, (tx) =>
      tx.tenant.update({ where: { id: agency.id }, data: { isActive: false } }),
    );
    try {
      expect(problemOf(await read(headers))).toEqual(
        refusedAs(401, 'AUTHENTICATION_REQUIRED'),
      );
    } finally {
      await asTenant(agency.id, (tx) =>
        tx.tenant.update({
          where: { id: agency.id },
          data: { isActive: true },
        }),
      );
    }
    expect((await read(headers)).status).toBe(200);
  });
});
