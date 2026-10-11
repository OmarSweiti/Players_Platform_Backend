import { Redis } from 'ioredis';

/** A probe that got no answer in time. */
export class NoAnswerInTime extends Error {}

/** Settles as `work` does, or rejects once `ms` pass without an answer. */
export function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NoAnswerInTime(`${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Asks Valkey for a PONG over a connection of its own, closed after: no
 * retries and no offline queue, so a stopped Valkey fails the probe at once
 * instead of leaving it waiting for a reconnection.
 */
export async function pingValkey(
  address: { host: string; port: number },
  ms: number,
): Promise<void> {
  const client = new Redis({
    ...address,
    lazyConnect: true,
    connectTimeout: ms,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // A refused connection rejects connect(); its error event needs a listener.
  client.on('error', () => undefined);
  try {
    await withinTime(
      client.connect().then(() => client.ping()),
      ms,
    );
  } finally {
    client.disconnect();
  }
}
