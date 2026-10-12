import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DependencyUnavailableError } from '../common/errors/domain-error';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { pingValkey, withinTime } from './probes';

/** How long one dependency may take to answer a readiness probe. */
export const PROBE_TIMEOUT_MS = 1_000;

type Dependency = 'database' | 'valkey';

/**
 * Whether this process can serve: each dependency it cannot serve without
 * answers in time. The identity provider's configuration joins with 0.5.4.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  /** How each dependency is asked; only the names are ever logged. */
  readonly probes: Record<Dependency, () => Promise<unknown>>;

  constructor(prisma: PrismaService, config: ConfigService<Env, true>) {
    const valkey = {
      host: config.get('REDIS_HOST', { infer: true }),
      port: config.get('REDIS_PORT', { infer: true }),
    };
    this.probes = {
      database: () => prisma.$queryRaw`SELECT 1`,
      valkey: () => pingValkey(valkey, PROBE_TIMEOUT_MS),
    };
  }

  /** Every probe at once; DEPENDENCY_UNAVAILABLE unless all answer in time. */
  async check(): Promise<void> {
    const dependencies = Object.keys(this.probes) as Dependency[];
    const results = await Promise.allSettled(
      dependencies.map((dependency) =>
        withinTime(this.probes[dependency](), PROBE_TIMEOUT_MS),
      ),
    );
    const down = dependencies.filter(
      (_dependency, i) => results[i].status === 'rejected',
    );
    if (down.length > 0) {
      this.logger.warn(`Not ready: ${down.join(' and ')} not answering`);
      throw new DependencyUnavailableError(`Not ready: ${down.join(', ')}`);
    }
  }
}
