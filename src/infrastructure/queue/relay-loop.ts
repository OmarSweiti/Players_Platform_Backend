import { writeFile } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import { describeError } from '../../common/logging/describe-error';
import type { OutboxRelay } from '../outbox/outbox-relay';

/** How often the relay looks for due events, when it last found none. */
export const RELAY_INTERVAL_MS = 1_000;

/**
 * Runs the relay pass after pass (0.7.6), one at a time, `intervalMs` apart.
 * A pass that fails — the database not migrated yet, Valkey not answering —
 * is logged by its error's name and the next one tries again. After every
 * pass, whatever it came to, the heartbeat file is touched: the worker's
 * health check reads its age, which says the loop is turning.
 */
export class RelayLoop {
  private readonly logger = new Logger(RelayLoop.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly relay: Pick<OutboxRelay, 'relayOnce'>,
    private readonly intervalMs: number = RELAY_INTERVAL_MS,
    private readonly heartbeatFile?: string,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops looking, and waits for the pass under way, if any. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.pass().finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, delay);
  }

  private async pass(): Promise<void> {
    try {
      await this.relay.relayOnce();
    } catch (error) {
      this.logger.warn(
        `an outbox relay pass failed: ${describeError(error)}; the next one tries again`,
      );
    } finally {
      if (this.heartbeatFile) {
        await writeFile(this.heartbeatFile, `${Date.now()}\n`).catch(() =>
          this.logger.warn('the heartbeat file could not be written'),
        );
      }
    }
  }
}
