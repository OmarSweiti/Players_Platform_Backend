import { Module } from '@nestjs/common';
import {
  RATE_LIMIT_KEY_PREFIX,
  RATE_LIMIT_KEYS,
  RateLimiter,
} from './rate-limiter';

/**
 * The limiter, for the global guard (app.module.ts) and for a use case that
 * counts what the guard cannot see, such as the account being signed in to.
 */
@Module({
  providers: [
    RateLimiter,
    { provide: RATE_LIMIT_KEY_PREFIX, useValue: RATE_LIMIT_KEYS },
  ],
  exports: [RateLimiter],
})
export class RateLimitModule {}
