import { describe, expect, it } from 'vitest';
import { checkWordsOf } from './identity-provider.port';

// What of a provider refusal's check may reach a security event (0.7.3): the
// check's name, and only words OAuth and the token claims define.

describe("a provider refusal's words", () => {
  it('a_refusals_words_are_codes_never_what_the_query_carried', () => {
    // The checks the adapters name, kept whole.
    for (const check of [
      'id_token:auth_time',
      'logout_token:sub_or_sid',
      'logout_token:replayed',
      'ERR_JWT_CLAIM_VALIDATION_FAILED:aud',
      'OAUTH_AUTHORIZATION_RESPONSE_ERROR:access_denied',
      'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    ]) {
      expect(checkWordsOf(check)).toBe(check);
    }
    // An error in the callback's query is anyone's to write: a word OAuth
    // does not define is kept as `other`, never as itself.
    expect(
      checkWordsOf('OAUTH_AUTHORIZATION_RESPONSE_ERROR:owner@agency.test'),
    ).toBe('OAUTH_AUTHORIZATION_RESPONSE_ERROR:other');
    expect(checkWordsOf('OAUTH_AUTHORIZATION_RESPONSE_ERROR:a:b:aud')).toBe(
      'OAUTH_AUTHORIZATION_RESPONSE_ERROR:other:other:aud',
    );
  });
});
