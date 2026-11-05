import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../../../config/env.schema';

/** How long a request waits for Valkey before it is refused. */
const TIMEOUT_MS = 500;

/**
 * The identity module's one connection to Valkey (0.5.5; 0.5.7): sign-ins in
 * flight and the logout tokens already honoured. It never waits: no offline
 * queue, no retried command, half a second per command. Each store turns a
 * failure into DEPENDENCY_UNAVAILABLE, as the rate limits do; the rate
 * limiter logs when Valkey stops and starts answering.
 */
@Injectable()
export class IdentityValkey implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis({
      host: config.get('REDIS_HOST', { infer: true }),
      port: config.get('REDIS_PORT', { infer: true }),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: TIMEOUT_MS,
      connectTimeout: TIMEOUT_MS * 2,
    });
    // It reconnects in the background; a command meanwhile is refused.
    this.client.on('error', () => undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect().catch(() => undefined);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
