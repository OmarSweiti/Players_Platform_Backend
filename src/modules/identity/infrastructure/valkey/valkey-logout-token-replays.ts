import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DependencyUnavailableError } from '../../../../common/errors/domain-error';
import { LogoutTokenReplays } from '../../application/ports/logout-token-replays.port';
import { IdentityValkey } from './identity-valkey';

/** Where honoured logout tokens are remembered: under a digest of issuer and `jti`. */
export const LOGOUT_TOKEN_KEYS = 'sadara:logout-token:';

/** The key a logout token is remembered under. */
export function logoutTokenKeyOf(issuer: string, jti: string): string {
  const digest = createHash('sha256')
    .update(issuer)
    .update('\n')
    .update(jti)
    .digest('hex');
  return `${LOGOUT_TOKEN_KEYS}${digest}`;
}

/**
 * Honoured logout tokens, in Valkey (0.5.7), so that every API instance
 * refuses a replay: `SET … NX EX` records a token only if it is new, in one
 * command, so two deliveries of one token cannot both pass. Without Valkey,
 * back-channel logout answers DEPENDENCY_UNAVAILABLE and the provider may try
 * again.
 */
@Injectable()
export class ValkeyLogoutTokenReplays extends LogoutTokenReplays {
  private readonly valkey: Redis;

  constructor(connection: IdentityValkey) {
    super();
    this.valkey = connection.client;
  }

  async claim(issuer: string, jti: string, seconds: number): Promise<boolean> {
    try {
      const set = await this.valkey.set(
        logoutTokenKeyOf(issuer, jti),
        '1',
        'EX',
        seconds,
        'NX',
      );
      return set === 'OK';
    } catch {
      throw new DependencyUnavailableError('Valkey did not answer the logout');
    }
  }

  async release(issuer: string, jti: string): Promise<void> {
    try {
      await this.valkey.del(logoutTokenKeyOf(issuer, jti));
    } catch {
      // Not released: the provider's retry is refused as a replay until the
      // record expires. The logout itself already failed and was reported.
    }
  }
}
