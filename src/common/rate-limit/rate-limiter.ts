import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.schema';
import {
  DependencyUnavailableError,
  RateLimitedError,
} from '../errors/domain-error';
import { RATE_LIMITS, type RateLimitCategory } from './rate-limits';

/** Where the counters live in Valkey; a test boot takes a namespace of its own. */
export const RATE_LIMIT_KEY_PREFIX = Symbol('RATE_LIMIT_KEY_PREFIX');
export const RATE_LIMIT_KEYS = 'sadara:rate-limit:';

/** How long a request waits for Valkey before it is refused. */
const RATE_LIMIT_TIMEOUT_MS = 500;

/**
 * Counts requests in Valkey, so that every API instance counts against the
 * same limits. A window opens with a subject's first request in a category
 * and closes `windowSeconds` later; past the limit, the request is refused
 * with the seconds until the window closes.
 *
 * Fails closed: when Valkey cannot answer, the request is refused with
 * DEPENDENCY_UNAVAILABLE rather than served without a limit
 * (docs/reference/observability.md), and readiness reports Valkey down.
 */
@Injectable()
export class RateLimiter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly valkey: Redis;
  private answering = true;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(RATE_LIMIT_KEY_PREFIX) private readonly prefix: string,
  ) {
    this.valkey = new Redis({
      host: config.get('REDIS_HOST', { infer: true }),
      port: config.get('REDIS_PORT', { infer: true }),
      lazyConnect: true,
      // A request never waits for a reconnection: it is refused at once.
      enableOfflineQueue: false,
      // A command lost with its connection is not sent again: it may have
      // counted already.
      maxRetriesPerRequest: 0,
      commandTimeout: RATE_LIMIT_TIMEOUT_MS,
      connectTimeout: RATE_LIMIT_TIMEOUT_MS * 2,
    });
    // The client keeps reconnecting in the background; the log says when
    // limits stop and start being enforced, not every failed attempt.
    this.valkey.on('error', () => this.answered(false));
    this.valkey.on('ready', () => this.answered(true));
  }

  async onModuleInit(): Promise<void> {
    // A Valkey that is down at boot does not stop the API: requests are
    // refused until it answers, and readiness says so.
    await this.valkey.connect().catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.valkey.disconnect();
  }

  /**
   * Counts one request of `subject` against `category`: RATE_LIMITED once
   * past its limit. A subject is `member:<id>`, `address:<client address>`
   * or, from a use case that knows who is signing in, `account:<id>`.
   */
  async take(category: RateLimitCategory, subject: string): Promise<void> {
    const { limit, windowSeconds } = RATE_LIMITS[category];
    const key = `${this.prefix}${category}:${subject}`;
    const [count, remainingMs] = await this.count(key, windowSeconds * 1000);
    if (count > limit) {
      throw new RateLimitedError(
        Math.max(1, Math.ceil(remainingMs / 1000)),
        `Over the ${category} limit`,
      );
    }
  }

  /** The window's count with this request, and the milliseconds it has left. */
  private async count(
    key: string,
    windowMs: number,
  ): Promise<[number, number]> {
    let replies: [Error | null, unknown][] | null;
    try {
      // One transaction: the first request of a window sets its expiry, and
      // no request counts without one.
      replies = await this.valkey
        .multi()
        .incr(key)
        .pexpire(key, windowMs, 'NX')
        .pttl(key)
        .exec();
    } catch {
      throw new DependencyUnavailableError('Valkey did not answer the count');
    }
    const count = replies?.[0]?.[1];
    const remainingMs = replies?.[2]?.[1];
    if (
      replies?.some(([error]) => error) ||
      typeof count !== 'number' ||
      typeof remainingMs !== 'number'
    ) {
      throw new DependencyUnavailableError('Valkey refused the count');
    }
    return [count, remainingMs > 0 ? remainingMs : windowMs];
  }

  private answered(answering: boolean): void {
    if (answering === this.answering) return;
    this.answering = answering;
    if (answering) {
      this.logger.log('Valkey is answering: rate limits apply');
    } else {
      this.logger.warn(
        'Valkey is not answering: rate-limited requests are refused',
      );
    }
  }
}
