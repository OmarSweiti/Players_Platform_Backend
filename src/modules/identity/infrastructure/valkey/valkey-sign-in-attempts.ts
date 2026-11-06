import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { DependencyUnavailableError } from '../../../../common/errors/domain-error';
import {
  type SignInAttempt,
  SignInAttempts,
} from '../../application/ports/sign-in-attempts.port';
import { IdentityValkey } from './identity-valkey';

/** Where attempts live in Valkey: under the digest of their state, never the state itself. */
export const SIGN_IN_ATTEMPT_KEYS = 'sadara:sign-in:';

/** The key an attempt is kept under. */
export function attemptKeyOf(state: string): string {
  return `${SIGN_IN_ATTEMPT_KEYS}${createHash('sha256').update(state).digest('hex')}`;
}

const Kept = z.strictObject({
  tenantId: z.uuid(),
  redirectUri: z.url(),
  returnTo: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  browserBinding: z.string(),
  acrValues: z.string().optional(),
  maxAge: z.int().min(0).optional(),
  stepUpSessionId: z.uuid().optional(),
  // An invitation's token digest, SHA-256 in base64url: 43 characters.
  invitation: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});

/**
 * Sign-ins in flight, in Valkey (0.5.5), so that the callback may reach any
 * API instance. Each is one key with its expiry, read and removed in one
 * command (GETDEL), so that two callbacks with one state cannot both take it.
 * Without Valkey, sign-in is refused (DEPENDENCY_UNAVAILABLE), as the rate
 * limits are.
 */
@Injectable()
export class ValkeySignInAttempts extends SignInAttempts {
  private readonly valkey: Redis;

  constructor(connection: IdentityValkey) {
    super();
    this.valkey = connection.client;
  }

  async keep(
    state: string,
    attempt: SignInAttempt,
    seconds: number,
  ): Promise<void> {
    try {
      await this.valkey.set(
        attemptKeyOf(state),
        JSON.stringify(attempt),
        'EX',
        seconds,
      );
    } catch {
      throw new DependencyUnavailableError('Valkey did not keep the sign-in');
    }
  }

  async take(state: string): Promise<SignInAttempt | null> {
    let kept: string | null;
    try {
      kept = await this.valkey.getdel(attemptKeyOf(state));
    } catch {
      throw new DependencyUnavailableError('Valkey did not answer the sign-in');
    }
    if (kept === null) return null;
    try {
      const parsed = Kept.safeParse(JSON.parse(kept));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // not JSON: nothing this API kept
    }
  }
}
