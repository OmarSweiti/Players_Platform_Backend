import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Tenant } from '@prisma/client';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import type { Env } from '../../src/config/env.schema';
import { KeycloakIdentityProvider } from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createTenant,
  securityEventsOf,
} from '../harness/fixtures';
import { controllersOf, routesOf } from '../harness/routes';
import { signedInAs } from '../harness/session';
import { setCookiesOf } from '../support/set-cookies';
import { TestIssuer, type Hostile } from '../support/test-issuer';

// Sign-out, back-channel logout and session management (0.5.7; SR-AUTH-007).
// A member ends this session or every one of theirs, lists and ends their own
// sessions, and never another's; the identity provider ends the sessions its
// signed logout token names, once. Sessions are real (test/harness/session.ts);
// the provider is the adapter, against an issuer in this process.

const SESSION = '__Host-Http-sadara_session';
const suffix = () => randomBytes(4).toString('hex');

/** The adapter, configured for `issuer` (or for an issuer at `url`). */
function providerFor(issuer: TestIssuer, url = issuer.issuer) {
  const env: Partial<Env> = {
    OIDC_ISSUER: url,
    OIDC_CLIENT_ID: issuer.clientId,
    OIDC_CLIENT_SECRET: issuer.clientSecret,
    OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
    OIDC_ADMIN_CLIENT_SECRET: 'not-used-by-these-tests',
  };
  return new KeycloakIdentityProvider({
    get: (name: keyof Env) => env[name],
  } as unknown as ConfigService<Env, true>);
}

describe('sign-out, back-channel logout and session management', () => {
  let issuer: TestIssuer;
  let booted: BootedApp;
  let agency: Tenant;
  let other: Tenant;

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
  /** The security events (0.7.3) the request behind `response` left. */
  const eventsOf = (response: Response) =>
    securityEventsOf(response.headers['x-request-id']);

  const read = (headers: Record<string, string>) =>
    booted.http.get('/api/v1/auth/session').set(headers);
  const post = (headers: Record<string, string>, path: string) =>
    booted.http.post(`/api/v1/auth/${path}`).set(headers).send({});
  const backchannel = (logoutToken?: string) =>
    booted.http
      .post('/api/v1/auth/backchannel-logout')
      .type('form')
      .send(logoutToken === undefined ? {} : { logout_token: logoutToken });

  /** The session row a set of signed-in headers carries. */
  async function rowOf(tenant: Tenant, headers: Record<string, string>) {
    const token = headers.Cookie.split('=')[1];
    return asTenant(tenant.id, (tx) =>
      tx.userSession.findFirstOrThrow({
        where: {
          tokenHash: new Uint8Array(
            createHash('sha256').update(token).digest(),
          ),
        },
      }),
    );
  }

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    booted = await bootApp({ identityProvider: providerFor(issuer) });
    agency = await createTenant({ slug: `agency-${suffix()}` });
    other = await createTenant({ slug: `other-${suffix()}` });
  });

  afterAll(async () => {
    await booted?.app.close();
    await issuer?.close();
  });

  it('logout_revokes_the_session_server_side', async () => {
    const member = await createMember(agency, 'COACH');
    const signedIn = await signedInAs(member);
    const elsewhere = await signedInAs(member);

    // Signing out is a write: without the session's token, nothing ends.
    const { 'X-CSRF-Token': _token, ...withoutToken } = signedIn;
    expect(problemOf(await post(withoutToken, 'logout'))).toEqual(
      refusedAs(403, 'CSRF_FAILED'),
    );
    expect((await read(signedIn)).status).toBe(200);

    const signedOut = await post(signedIn, 'logout');
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers['cache-control']).toBe('no-store');
    const { data } = signedOut.body as {
      data: { revoked: number; endSessionUrl: string };
    };
    expect(data.revoked).toBe(1);
    // The provider's sign-out, returning to this host's start page.
    const end = new URL(data.endSessionUrl);
    expect(end.origin + end.pathname).toBe(
      `${issuer.issuer}/protocol/openid-connect/logout`,
    );
    expect(Object.fromEntries(end.searchParams)).toEqual({
      client_id: issuer.clientId,
      post_logout_redirect_uri: `https://${agency.slug}.localhost/`,
      ui_locales: 'en',
    });
    // The cookie is cleared with the attributes it was set with.
    expect(setCookiesOf(signedOut).get(SESSION)).toEqual({
      value: '',
      attributes: {
        path: '/',
        expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
        httponly: '',
        secure: '',
        samesite: 'Lax',
      },
    });

    // Ended in PostgreSQL: the cookie, kept or replayed, signs nobody in.
    const ended = await rowOf(agency, signedIn);
    expect(ended).toMatchObject({
      revokedAt: expect.any(Date) as Date,
      revokeReason: 'SIGN_OUT',
    });
    // Recorded with it (0.7.3): this session, in this tenant.
    expect(await eventsOf(signedOut)).toEqual([
      expect.objectContaining({
        eventType: 'sign_out',
        outcome: 'SUCCEEDED',
        tenantHint: agency.id,
        sessionId: ended.id,
        metadata: { revoked: 1 },
      }),
    ]);
    expect(problemOf(await read(signedIn))).toEqual(
      refusedAs(401, 'AUTHENTICATION_REQUIRED'),
    );
    expect((await post(signedIn, 'logout')).status).toBe(401);
    // Only this session: the member's other one still holds.
    expect((await read(elsewhere)).status).toBe(200);
  });

  it('the_session_ends_even_when_the_provider_does_not_answer', async () => {
    const gone = await TestIssuer.start();
    const url = gone.issuer;
    await gone.close();
    const offline = await bootApp({ identityProvider: providerFor(gone, url) });
    try {
      const signedIn = await signedInAs(await createMember(agency, 'COACH'));
      const signedOut = await offline.http
        .post('/api/v1/auth/logout')
        .set(signedIn)
        .send({});
      expect(signedOut.status).toBe(200);
      expect(signedOut.body).toEqual({
        data: { revoked: 1, endSessionUrl: null },
      });
      expect((await read(signedIn)).status).toBe(401);
    } finally {
      await offline.app.close();
    }
  });

  it('logout_everywhere_revokes_every_session', async () => {
    const person = {
      issuer: 'https://idp.agency.test/realms/sadara',
      subject: randomUUID(),
    };
    const member = await createMember(agency, 'COACH');
    const colleague = await createMember(agency, 'COACH');
    const mine = [
      await signedInAs(member, person),
      await signedInAs(member, person),
      await signedInAs(member, person),
    ];
    const theirs = await signedInAs(colleague);
    // The same person's membership of another agency is another membership.
    const atOther = await signedInAs(
      await createMember(other, 'COACH'),
      person,
    );

    const signedOut = await post(mine[0], 'logout-all');
    expect(signedOut.status).toBe(200);
    expect((signedOut.body as { data: { revoked: number } }).data.revoked).toBe(
      3,
    );
    expect(await eventsOf(signedOut)).toEqual([
      expect.objectContaining({
        eventType: 'sign_out_everywhere',
        outcome: 'SUCCEEDED',
        tenantHint: agency.id,
        sessionId: (await rowOf(agency, mine[0])).id,
        metadata: { revoked: 3 },
      }),
    ]);
    expect(setCookiesOf(signedOut).get(SESSION)?.value).toBe('');
    for (const headers of mine) {
      expect((await read(headers)).status).toBe(401);
      expect((await rowOf(agency, headers)).revokeReason).toBe(
        'SIGN_OUT_EVERYWHERE',
      );
    }
    expect((await read(theirs)).status).toBe(200);
    expect((await read(atOther)).status).toBe(200);
  });

  it('a_member_cannot_revoke_another_members_session', async () => {
    const member = await createMember(agency, 'COACH');
    const colleague = await createMember(agency, 'COACH');
    const first = await signedInAs(member);
    const second = await signedInAs(member);
    const theirs = await signedInAs(colleague);
    const [firstRow, secondRow, theirRow] = [
      await rowOf(agency, first),
      await rowOf(agency, second),
      await rowOf(agency, theirs),
    ];

    // The list: the member's own live sessions, newest first, this one marked.
    const list = await booted.http.get('/api/v1/auth/sessions').set(first);
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({
      data: [secondRow, firstRow].map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        idleExpiresAt: row.idleExpiresAt.toISOString(),
        absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
        acr: row.acr,
        current: row.id === firstRow.id,
      })),
      page: { nextCursor: null, hasMore: false },
    });

    // Another member's session is not there to end — exactly as one that
    // never existed — and it goes on working.
    const end = (headers: Record<string, string>, id: string) =>
      booted.http.delete(`/api/v1/auth/sessions/${id}`).set(headers);
    const attempt = await end(first, theirRow.id);
    const notTheirs = problemOf(attempt);
    expect(notTheirs).toEqual(refusedAs(404, 'NOT_FOUND'));
    // The attempt on another's session is recorded (0.7.3), with the session
    // it named and the one that asked.
    expect(await eventsOf(attempt)).toEqual([
      expect.objectContaining({
        eventType: 'session_revoked',
        outcome: 'REFUSED',
        reasonCode: 'not_found',
        tenantHint: agency.id,
        sessionId: theirRow.id,
        metadata: {
          revokeReason: 'REVOKED_BY_MEMBER',
          actorSessionId: firstRow.id,
        },
      }),
    ]);
    expect(problemOf(await end(first, randomUUID()))).toEqual(notTheirs);
    expect((await read(theirs)).status).toBe(200);

    // Their own other session ends; this browser stays signed in.
    const { 'X-CSRF-Token': _token, ...withoutToken } = first;
    expect((await end(withoutToken, secondRow.id)).status).toBe(403);
    const ended = await end(first, secondRow.id);
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ data: null });
    expect(await eventsOf(ended)).toEqual([
      expect.objectContaining({
        eventType: 'session_revoked',
        outcome: 'SUCCEEDED',
        reasonCode: null,
        sessionId: secondRow.id,
      }),
    ]);
    expect(setCookiesOf(ended).has(SESSION)).toBe(false);
    expect((await read(second)).status).toBe(401);
    expect((await rowOf(agency, second)).revokeReason).toBe(
      'REVOKED_BY_MEMBER',
    );
    expect((await end(first, secondRow.id)).status).toBe(404);

    // Ending this browser's own session signs it out.
    const self = await end(first, firstRow.id);
    expect(self.status).toBe(200);
    expect(setCookiesOf(self).get(SESSION)?.value).toBe('');
    expect((await read(first)).status).toBe(401);
  });

  it('the_session_list_pages_by_cursor_for_its_member_only', async () => {
    const member = await createMember(agency, 'COACH');
    const sessions = [];
    for (let i = 0; i < 3; i += 1) sessions.push(await signedInAs(member));
    const list = (headers: Record<string, string>, query: string) =>
      booted.http.get(`/api/v1/auth/sessions?${query}`).set(headers);

    const first = (await list(sessions[0], 'limit=2')).body as {
      data: unknown[];
      page: { nextCursor: string; hasMore: boolean };
    };
    expect(first.data).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    const next = (
      await list(sessions[0], `limit=2&cursor=${first.page.nextCursor}`)
    ).body as { data: unknown[]; page: { hasMore: boolean } };
    expect(next.data).toHaveLength(1);
    expect(next.page.hasMore).toBe(false);

    // A cursor is its member's: another's list refuses it.
    const stranger = await signedInAs(await createMember(agency, 'COACH'));
    expect(
      problemOf(await list(stranger, `cursor=${first.page.nextCursor}`)),
    ).toEqual(refusedAs(400, 'INVALID_CURSOR'));
  });

  describe('back-channel logout', () => {
    /** A member of `tenant` signed in as the issuer's person, with `sid`. */
    async function sessionAt(tenant: Tenant, subject: string, sid: string) {
      const member = await createMember(tenant, 'COACH');
      return signedInAs(member, { issuer: issuer.issuer, subject, sid });
    }

    it('a_valid_back_channel_logout_revokes_matching_sessions', async () => {
      const dormant = await createTenant({ slug: `dormant-${suffix()}` });
      const subject = issuer.subject;
      const thisSession = await sessionAt(agency, subject, issuer.sid);
      const sameSidElsewhere = await sessionAt(dormant, subject, issuer.sid);
      const anotherSession = await sessionAt(
        other,
        subject,
        'another-provider-session',
      );
      // Another person whose provider session shares the sid: not theirs.
      const someoneElse = await sessionAt(agency, randomUUID(), issuer.sid);
      // A tenant switched off still has its sessions ended.
      await asTenant(dormant.id, (tx) =>
        tx.tenant.update({
          where: { id: dormant.id },
          data: { isActive: false },
        }),
      );

      // The provider names the person and the session it ended: no cookie,
      // no CSRF token — the signed token is the proof.
      const answered = await backchannel(await issuer.logoutToken());
      expect(answered.status).toBe(200);
      expect(answered.headers['cache-control']).toBe('no-store');
      expect(answered.body).toEqual({ data: null });
      // Recorded (0.7.3) without a tenant: its sessions are in two.
      expect(await eventsOf(answered)).toEqual([
        expect.objectContaining({
          eventType: 'backchannel_logout',
          outcome: 'SUCCEEDED',
          tenantHint: null,
          issuer: issuer.issuer,
          subject,
          metadata: { revoked: 2 },
        }),
      ]);
      expect(await rowOf(agency, thisSession)).toMatchObject({
        revokeReason: 'PROVIDER_LOGOUT',
      });
      expect(await rowOf(dormant, sameSidElsewhere)).toMatchObject({
        revokeReason: 'PROVIDER_LOGOUT',
      });
      expect((await rowOf(other, anotherSession)).revokedAt).toBeNull();
      expect((await rowOf(agency, someoneElse)).revokedAt).toBeNull();
      expect((await read(thisSession)).status).toBe(401);

      // A logout naming the person alone ends every session of theirs.
      const everywhere = await backchannel(
        await issuer.logoutToken({ claims: { sid: undefined } }),
      );
      expect(everywhere.status).toBe(200);
      expect(await rowOf(other, anotherSession)).toMatchObject({
        revokeReason: 'PROVIDER_LOGOUT',
      });
      expect((await rowOf(agency, someoneElse)).revokedAt).toBeNull();
      expect((await read(someoneElse)).status).toBe(200);

      // A logout naming the provider's session alone ends that session.
      const bySid = await sessionAt(other, randomUUID(), 'named-by-sid-alone');
      const sidOnly = await backchannel(
        await issuer.logoutToken({
          claims: { sub: undefined, sid: 'named-by-sid-alone' },
        }),
      );
      expect(sidOnly.status).toBe(200);
      expect(await rowOf(other, bySid)).toMatchObject({
        revokeReason: 'PROVIDER_LOGOUT',
      });
      expect((await read(someoneElse)).status).toBe(200);
    });

    it('a_forged_or_replayed_logout_token_is_refused', async () => {
      const subject = randomUUID();
      const member = await createMember(agency, 'COACH');
      const person = {
        issuer: issuer.issuer,
        subject,
        sid: 'the-target-session',
      };
      const target = await signedInAs(member, person);
      const now = Math.floor(Date.now() / 1000);
      const naming = { sub: subject, sid: 'the-target-session' };
      const forgeries: Array<[string, Hostile]> = [
        [
          'signed with a key never published',
          { claims: naming, signedWith: 'unpublished' },
        ],
        ['not signed', { claims: naming, signedWith: 'none' }],
        [
          'for another client',
          { claims: { ...naming, aud: 'another-client' } },
        ],
        [
          'from another issuer',
          {
            claims: { ...naming, iss: 'https://elsewhere.test/realms/sadara' },
          },
        ],
        [
          'without the logout event',
          { claims: { ...naming, events: undefined } },
        ],
        ['with a nonce', { claims: { ...naming, nonce: 'a-nonce' } }],
        ['naming nobody', { claims: { sub: undefined, sid: undefined } }],
        ['without an id', { claims: { ...naming, jti: undefined } }],
        ['too old', { claims: { ...naming, iat: now - 400, exp: now + 60 } }],
        [
          'from the future',
          { claims: { ...naming, iat: now + 300, exp: now + 420 } },
        ],
      ];
      for (const [why, hostile] of forgeries) {
        const refused = await backchannel(await issuer.logoutToken(hostile));
        // Recorded (0.7.3), naming nobody: the token proved no one.
        expect([why, await eventsOf(refused)]).toEqual([
          why,
          [
            expect.objectContaining({
              eventType: 'backchannel_logout',
              outcome: 'REFUSED',
              reasonCode: expect.stringMatching(/^[a-z0-9_.:-]+$/) as string,
              issuer: null,
              subject: null,
            }),
          ],
        ]);
        expect([why, problemOf(refused)]).toEqual([
          why,
          expect.objectContaining({
            status: 400,
            code: 'VALIDATION_FAILED',
            fieldErrors: [
              expect.objectContaining({ field: '/logout_token' }),
            ] as unknown,
          }),
        ]);
      }
      expect(problemOf(await backchannel())).toEqual(
        refusedAs(400, 'VALIDATION_FAILED'),
      );
      expect(problemOf(await backchannel('not.a.token'))).toEqual(
        refusedAs(400, 'VALIDATION_FAILED'),
      );
      expect((await read(target)).status).toBe(200);

      // The real one, honoured once; the same token again is refused.
      const token = await issuer.logoutToken({ claims: naming });
      expect((await backchannel(token)).status).toBe(200);
      expect((await read(target)).status).toBe(401);
      // Signed in again with the same provider session: the replay ends nothing.
      const replayed = await signedInAs(member, person);
      const again = await backchannel(token);
      expect(problemOf(again)).toEqual(refusedAs(400, 'VALIDATION_FAILED'));
      expect(await eventsOf(again)).toEqual([
        expect.objectContaining({
          outcome: 'REFUSED',
          reasonCode: 'logout_token:replayed',
          issuer: issuer.issuer,
          subject,
        }),
      ]);
      expect((await read(replayed)).status).toBe(200);
    });

    it('back_channel_logout_is_the_only_public_write', () => {
      const reflector = booted.app.get(Reflector);
      const publicWrites = controllersOf(booted.app)
        .flatMap(routesOf)
        .filter(
          ({ method, controller, handler }) =>
            method !== 'get' &&
            reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
              (controller.prototype as Record<string, () => unknown>)[handler],
              controller,
            ]) === true,
        )
        .map(({ method, path }) => `${method} ${path}`);
      // The CSRF guard exempts public routes: this one, whose proof is the
      // provider's signed token, and no other.
      expect(publicWrites).toEqual(['post /api/v1/auth/backchannel-logout']);
    });
  });
});
