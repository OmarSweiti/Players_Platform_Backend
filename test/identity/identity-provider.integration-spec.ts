import type { ConfigService } from '@nestjs/config';
import * as oidc from 'openid-client';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DependencyUnavailableError } from '../../src/common/errors/domain-error';
import type { Env } from '../../src/config/env.schema';
import {
  ProviderAnswerRefusedError,
  type VerifiedSignIn,
} from '../../src/modules/identity/application/ports/identity-provider.port';
import { KeycloakIdentityProvider } from '../../src/modules/identity/infrastructure/keycloak/keycloak-identity-provider';
import { TestIssuer, type Hostile } from '../support/test-issuer';

// The identity-provider port's protocol half (0.5.4; SR-AUTH-001), through the
// Keycloak adapter, against an issuer in this process (test/support/
// test-issuer.ts) that signs what each test asks for. A sign-in is the API's
// authorization request, the provider's answer to it, and the exchange of
// that answer; every hostile ID token is refused, named by the check it
// failed. The adapter's admin calls are proved against Keycloak itself
// (test/identity/keycloak-accounts.keycloak-spec.ts).

const CALLBACK = new URL('https://sadara.localhost/api/v1/auth/callback');

/** The adapter, configured for `issuer`. */
function providerFor(issuer: TestIssuer, url = issuer.issuer) {
  const env: Partial<Env> = {
    OIDC_ISSUER: url,
    OIDC_CLIENT_ID: issuer.clientId,
    OIDC_CLIENT_SECRET: issuer.clientSecret,
    OIDC_ADMIN_CLIENT_ID: 'sadara-admin',
    OIDC_ADMIN_CLIENT_SECRET: 'not-used-by-these-tests',
  };
  const config = { get: (name: keyof Env) => env[name] };
  return new KeycloakIdentityProvider(
    config as unknown as ConfigService<Env, true>,
  );
}

/** A refusal, named by the check that failed. */
const refusedBy = (check: RegExp) =>
  expect.objectContaining({
    constructor: ProviderAnswerRefusedError,
    check: expect.stringMatching(check) as string,
  }) as unknown;

describe('the identity provider, against a test issuer', () => {
  let issuer: TestIssuer;
  let provider: KeycloakIdentityProvider;

  /**
   * One sign-in as the browser makes it: the API's authorization request, the
   * provider's answer (as `hostile` shapes it), and the exchange.
   */
  async function signIn(
    hostile: Hostile = {},
    {
      through = provider,
      expectedNonce,
    }: { through?: KeycloakIdentityProvider; expectedNonce?: string } = {},
  ): Promise<VerifiedSignIn> {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const authorizationUrl = await through.authorizationUrl({
      redirectUri: CALLBACK,
      state,
      nonce,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      locale: 'ar',
    });
    return through.exchange({
      callbackUrl: issuer.authorize(authorizationUrl, hostile),
      codeVerifier,
      expectedState: state,
      expectedNonce: expectedNonce ?? nonce,
    });
  }

  const outcomeOf = (attempt: Promise<unknown>) =>
    attempt.then(
      () => 'accepted',
      (error: unknown) => error,
    );

  beforeAll(async () => {
    issuer = await TestIssuer.start();
    provider = providerFor(issuer);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await issuer?.close();
  });

  it('a_sign_in_proves_who_signed_in', async () => {
    // The request: the authorization code flow, PKCE S256, this host's
    // callback, the state, the nonce and the language.
    const url = await provider.authorizationUrl({
      redirectUri: CALLBACK,
      state: 'the-state',
      nonce: 'the-nonce',
      codeChallenge: 'the-challenge',
      loginHint: 'member@agency.test',
      locale: 'ar',
    });
    expect(url.origin + url.pathname).toBe(
      `${issuer.issuer}/protocol/openid-connect/auth`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: issuer.clientId,
      response_type: 'code',
      redirect_uri: CALLBACK.href,
      scope: 'openid',
      state: 'the-state',
      nonce: 'the-nonce',
      code_challenge: 'the-challenge',
      code_challenge_method: 'S256',
      login_hint: 'member@agency.test',
      ui_locales: 'ar',
    });

    // The answer, exchanged: who signed in, and how, and nothing else.
    expect(await signIn()).toEqual({
      issuer: issuer.issuer,
      subject: issuer.subject,
      sid: issuer.sid,
      acr: '1',
      amr: ['pwd'],
      authTime: expect.any(Date) as Date,
      email: 'member@agency.test',
      emailVerified: true,
    });
  });

  it('id_tokens_from_another_issuer_are_refused', async () => {
    // An ID token another issuer signed with this one's key.
    expect(
      await outcomeOf(
        signIn({ claims: { iss: 'https://elsewhere.test/realms/sadara' } }),
      ),
    ).toEqual(refusedBy(/:iss$/));
    // An answer that says it comes from another issuer.
    expect(
      await outcomeOf(
        signIn({ responseIssuer: 'https://elsewhere.test/realms/sadara' }),
      ),
    ).toEqual(refusedBy(/./));
    // An issuer whose discovery document names another: not the allowlisted
    // issuer, so nothing it says is used.
    const impostor = await TestIssuer.start(
      'https://elsewhere.test/realms/sadara',
    );
    try {
      expect(
        await outcomeOf(
          providerFor(impostor).authorizationUrl({
            redirectUri: CALLBACK,
            state: 's',
            nonce: 'n',
            codeChallenge: 'c',
            locale: 'en',
          }),
        ),
      ).toBeInstanceOf(DependencyUnavailableError);
    } finally {
      await impostor.close();
    }
    // The well-formed sign-in still passes.
    await expect(signIn()).resolves.toMatchObject({ issuer: issuer.issuer });
  });

  it('id_tokens_for_another_audience_are_refused', async () => {
    // Issued to another client.
    expect(
      await outcomeOf(
        signIn({ claims: { aud: 'another-client', azp: undefined } }),
      ),
    ).toEqual(refusedBy(/:aud$/));
    // For several audiences, authorized for another party.
    expect(
      await outcomeOf(
        signIn({
          claims: {
            aud: [issuer.clientId, 'another-client'],
            azp: 'another-client',
          },
        }),
      ),
    ).toEqual(refusedBy(/:azp$/));
    // Past its expiry, or issued in the future beyond the clock tolerance.
    const now = Math.floor(Date.now() / 1000);
    expect(
      await outcomeOf(signIn({ claims: { exp: now - 120, iat: now - 600 } })),
    ).toEqual(refusedBy(/:exp$/));
    expect(
      await outcomeOf(signIn({ claims: { iat: now + 600, exp: now + 900 } })),
    ).toEqual(refusedBy(/:iat$/));
  });

  it('a_mismatched_nonce_is_refused', async () => {
    // The token carries another sign-in's nonce.
    expect(
      await outcomeOf(signIn({ claims: { nonce: 'another-sign-ins-nonce' } })),
    ).toEqual(refusedBy(/:nonce$/));
    // Or none at all.
    expect(await outcomeOf(signIn({ claims: { nonce: undefined } }))).toEqual(
      refusedBy(/./),
    );
    // Or this sign-in expected another (a replayed answer).
    expect(
      await outcomeOf(signIn({}, { expectedNonce: oidc.randomNonce() })),
    ).toEqual(refusedBy(/:nonce$/));
  });

  it('rotated_signing_keys_are_accepted', async () => {
    const rotating = await TestIssuer.start();
    const fresh = providerFor(rotating);
    const previous = issuer;
    issuer = rotating; // signIn() asks the rotating issuer
    try {
      await expect(signIn({}, { through: fresh })).resolves.toMatchObject({
        subject: rotating.subject,
      });
      expect(rotating.keySetFetches).toBe(1);

      // The issuer signs with a new key and drops the old one. The cached key
      // set is refetched once a token names a key it does not hold, at most
      // once a minute: a minute on, the new key is fetched and accepted.
      await rotating.rotateKeys({ retire: true });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 61_000);
      await expect(signIn({}, { through: fresh })).resolves.toMatchObject({
        subject: rotating.subject,
      });
      expect(rotating.keySetFetches).toBe(2);

      // A key the issuer never published is refused, refetch or not; so is a
      // token with no signature.
      vi.setSystemTime(Date.now() + 61_000);
      expect(
        await outcomeOf(
          signIn({ signedWith: 'unpublished' }, { through: fresh }),
        ),
      ).toEqual(refusedBy(/KEY_SELECTION/));
      expect(
        await outcomeOf(signIn({ signedWith: 'none' }, { through: fresh })),
      ).toEqual(refusedBy(/./));
    } finally {
      issuer = previous;
      await rotating.close();
    }
  });

  it('logout_tokens_are_verified', async () => {
    // A well-formed back-channel logout token names the subject and session,
    // and the token itself, so that it is honoured once (0.5.7).
    const before = Math.floor(Date.now() / 1000) * 1000;
    const claims = await provider.verifyLogoutToken(await issuer.logoutToken());
    expect(claims).toEqual({
      issuer: issuer.issuer,
      jti: expect.any(String) as string,
      issuedAt: expect.any(Date) as Date,
      subject: issuer.subject,
      sid: issuer.sid,
    });
    expect(claims.issuedAt.getTime()).toBeGreaterThanOrEqual(before);
    const now = Math.floor(Date.now() / 1000);
    const refusals: Array<[Hostile, RegExp]> = [
      // older than five minutes, or issued in the future
      [{ claims: { iat: now - 301 - 30, exp: now + 60 } }, /iat/],
      [{ claims: { iat: now + 120, exp: now + 240 } }, /iat/],
      [{ claims: { aud: 'another-client' } }, /aud/],
      [{ claims: { iss: 'https://elsewhere.test/realms/sadara' } }, /iss/],
      [{ claims: { events: undefined } }, /events/],
      [{ claims: { events: { 'urn:another:event': {} } } }, /events/],
      [{ claims: { nonce: 'a-nonce' } }, /nonce/],
      [{ claims: { sub: undefined, sid: undefined } }, /sub_or_sid/],
      [{ claims: { jti: undefined } }, /jti/],
      [{ signedWith: 'unpublished' }, /NO_MATCHING_KEY|SIGNATURE/],
      [{ signedWith: 'none' }, /./],
    ];
    for (const [hostile, check] of refusals) {
      expect([
        hostile,
        await outcomeOf(
          provider.verifyLogoutToken(await issuer.logoutToken(hostile)),
        ),
      ]).toEqual([hostile, refusedBy(check)]);
    }
  });

  it('the_end_session_url_returns_to_this_host', async () => {
    const url = await provider.endSessionUrl({
      postLogoutRedirectUri: new URL('https://sadara.localhost/'),
      locale: 'ar',
    });
    expect(url.origin + url.pathname).toBe(
      `${issuer.issuer}/protocol/openid-connect/logout`,
    );
    // No ID token is kept, so the client names itself (no id_token_hint).
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: issuer.clientId,
      post_logout_redirect_uri: 'https://sadara.localhost/',
      ui_locales: 'ar',
    });
  });

  it('an_issuer_that_does_not_answer_is_unavailable', async () => {
    const gone = await TestIssuer.start();
    const url = gone.issuer;
    await gone.close();
    expect(
      await outcomeOf(
        providerFor(gone, url).authorizationUrl({
          redirectUri: CALLBACK,
          state: 's',
          nonce: 'n',
          codeChallenge: 'c',
          locale: 'en',
        }),
      ),
    ).toBeInstanceOf(DependencyUnavailableError);
  });
});
