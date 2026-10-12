import { createServer } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.schema';
import { DependencyUnavailableError } from '../errors/domain-error';
import { RateLimiter } from './rate-limiter';

/** A local port nothing listens on: bound once, then released. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

describe('RateLimiter', () => {
  it('refuses the request when Valkey does not answer, at once', async () => {
    const valkey: Partial<Env> = {
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: await closedPort(),
    };
    const limiter = new RateLimiter(
      {
        get: (key: keyof Env) => valkey[key],
      } as unknown as ConfigService<Env, true>,
      'sadara:rate-limit:unit:',
    );
    await limiter.onModuleInit(); // boots although Valkey is down
    try {
      const started = Date.now();
      // Every category: none is served without its limit.
      for (const category of ['auth', 'default'] as const) {
        await expect(
          limiter.take(category, 'address:203.0.113.7'),
        ).rejects.toBeInstanceOf(DependencyUnavailableError);
      }
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      limiter.onModuleDestroy();
    }
  });
});
