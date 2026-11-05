import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

/** The header a write carries its session's CSRF token in (ADR-0003). */
export const CSRF_HEADER = 'X-CSRF-Token';

// Versioned, so that a token derived for another purpose under the same key
// can never pass as this one.
const PURPOSE = 'sadara-csrf-v1:';

/**
 * The CSRF token of the session whose token hashes to `tokenHash`, under
 * `key`: HMAC-SHA-256, base64url. Nothing is stored, and every tab gets the
 * same value until the session rotates (ADR-0003).
 */
export function csrfTokenOf(tokenHash: Uint8Array, key: string): string {
  return createHmac('sha256', key)
    .update(PURPOSE)
    .update(tokenHash)
    .digest('base64url');
}

/**
 * The session's synchronizer token (0.5.6), derived under CSRF_SECRET.
 * While the key rotates, a token derived under CSRF_SECRET_PREVIOUS is still
 * accepted; every new one is derived under the current key.
 */
@Injectable()
export class CsrfTokens {
  private readonly keys: readonly string[];

  constructor(config: ConfigService<Env, true>) {
    const previous = config.get('CSRF_SECRET_PREVIOUS', { infer: true });
    this.keys = [
      config.get('CSRF_SECRET', { infer: true }),
      ...(previous ? [previous] : []),
    ];
  }

  /** The token a session's member sends with every write. */
  issue(tokenHash: Uint8Array): string {
    return csrfTokenOf(tokenHash, this.keys[0]);
  }

  /** Whether `presented` is the session's token, compared in constant time. */
  holds(tokenHash: Uint8Array, presented: unknown): boolean {
    if (typeof presented !== 'string') return false;
    const given = Buffer.from(presented);
    return this.keys.some((key) => {
      const expected = Buffer.from(csrfTokenOf(tokenHash, key));
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
  }
}
