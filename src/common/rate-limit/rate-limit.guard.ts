import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { clientAddressOf } from './client-address';
import { RATE_LIMIT_KEY, type RateLimitMetadata } from './rate-limit.decorator';
import { RateLimiter } from './rate-limiter';
import type { RateLimitCategory } from './rate-limits';

type SessionRequest = Request & { user?: { id: string } };

/**
 * Counts every request against its route's category before any permission
 * check or handler runs. A global guard after the session guard, so that a
 * signed-in member counts as themselves and not as the office network they
 * share; anyone else counts as their address. An `auth` request always
 * counts as its address: signing in is what an attacker repeats, and the use
 * case adds the per-account count once it knows the account.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const category =
      this.reflector.getAllAndOverride<RateLimitMetadata | undefined>(
        RATE_LIMIT_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? 'default';
    if (category === 'none') return true;

    const request = context.switchToHttp().getRequest<SessionRequest>();
    await this.limiter.take(category, subjectOf(category, request));
    return true;
  }
}

function subjectOf(category: RateLimitCategory, request: SessionRequest) {
  const member = request.user?.id;
  return member !== undefined && category !== 'auth'
    ? `member:${member}`
    : `address:${clientAddressOf(request.ip)}`;
}
