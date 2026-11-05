import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.schema';
import { csrfTokenOf, CsrfTokens } from './csrf-tokens';

const KEY = 'the-current-csrf-key-of-this-unit-test';
const OLD = 'the-previous-csrf-key-of-this-unit-test';
const digest = (value: string) => createHash('sha256').update(value).digest();

function tokens(previous?: string): CsrfTokens {
  const env: Partial<Env> = {
    CSRF_SECRET: KEY,
    CSRF_SECRET_PREVIOUS: previous,
  };
  return new CsrfTokens({
    get: (name: keyof Env) => env[name],
  } as unknown as ConfigService<Env, true>);
}

describe("the session's CSRF token", () => {
  it('a_csrf_token_is_derived_from_its_session_and_never_stored', () => {
    const session = digest('one session token');
    const issued = tokens().issue(session);
    // The same for every tab of the session; another session's differs.
    expect(issued).toBe(tokens().issue(session));
    expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued).not.toBe(tokens().issue(digest('another session token')));
    // It is the session's digest under the key: nothing else goes in.
    expect(issued).toBe(csrfTokenOf(session, KEY));
    expect(tokens().holds(session, issued)).toBe(true);
    for (const wrong of [undefined, '', issued.slice(1), `${issued}x`, 42]) {
      expect([wrong, tokens().holds(session, wrong)]).toEqual([wrong, false]);
    }
  });

  it('a_rotated_key_accepts_the_previous_one_until_it_is_dropped', () => {
    const session = digest('a session token');
    const old = csrfTokenOf(session, OLD);
    expect(tokens(OLD).holds(session, old)).toBe(true);
    expect(tokens(OLD).issue(session)).toBe(csrfTokenOf(session, KEY));
    expect(tokens().holds(session, old)).toBe(false);
  });
});
