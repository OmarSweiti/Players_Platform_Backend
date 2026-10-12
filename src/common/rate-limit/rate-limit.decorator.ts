import { SetMetadata } from '@nestjs/common';
import type { RateLimitCategory } from './rate-limits';

export const RATE_LIMIT_KEY = 'sadara:rate-limit';

/** What a route's metadata may say: a category, or no limit at all. */
export type RateLimitMetadata = RateLimitCategory | 'none';

/** The category this route's requests count against; `default` if unsaid. */
export const RateLimit = (category: RateLimitCategory) =>
  SetMetadata(RATE_LIMIT_KEY, category satisfies RateLimitMetadata);

/**
 * No limit, for the probes only: an orchestrator polls them, and liveness
 * must answer whether Valkey does or not.
 */
export const NoRateLimit = () =>
  SetMetadata(RATE_LIMIT_KEY, 'none' satisfies RateLimitMetadata);
