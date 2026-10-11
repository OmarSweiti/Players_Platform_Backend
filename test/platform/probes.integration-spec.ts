import { createServer } from 'node:net';
import { describe, expect, it, inject } from 'vitest';
import {
  NoAnswerInTime,
  pingValkey,
  withinTime,
} from '../../src/health/probes';
import { prismaFor } from '../harness/db';

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

const valkey = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

describe('the readiness probes, against real endpoints', () => {
  it('a_running_valkey_answers_the_probe', async () => {
    await expect(pingValkey(valkey, 1_000)).resolves.toBeUndefined();
  });

  it('a_stopped_valkey_fails_the_probe_at_once', async () => {
    const started = Date.now();
    await expect(
      pingValkey({ host: '127.0.0.1', port: await closedPort() }, 1_000),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a_stopped_database_fails_the_probe_in_time', async () => {
    const url = new URL(inject('databaseUrl'));
    url.port = String(await closedPort());
    const unreachable = prismaFor(url.toString());
    try {
      await expect(
        withinTime(unreachable.prisma.$queryRaw`SELECT 1`, 1_000),
      ).rejects.toThrow();
    } finally {
      await unreachable.close();
    }
  });

  it('a_probe_without_an_answer_times_out', async () => {
    await expect(
      withinTime(new Promise(() => undefined), 50),
    ).rejects.toBeInstanceOf(NoAnswerInTime);
  });
});
