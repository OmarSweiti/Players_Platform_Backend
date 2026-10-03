import type { LoggerService } from '@nestjs/common';
import { format } from 'node:util';
import { type MockInstance, vi } from 'vitest';

const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
] as const;

/**
 * Everything the application writes while a test watches: what it logs
 * through Nest's logger, at every level (debug included, as production
 * prints it), what reaches the console, and raw writes to stdout and stderr.
 * Pass it to `bootApp({ logger })`, then `start()` before the requests.
 */
export class LogCapture implements LoggerService {
  readonly lines: string[] = [];
  private spies: MockInstance[] = [];

  log(message: unknown, ...rest: unknown[]): void {
    this.record('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.record('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.record('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.record('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.record('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.record('fatal', message, rest);
  }

  /** Also capture the console and raw stdout and stderr writes, until `stop()`. */
  start(): this {
    for (const method of CONSOLE_METHODS) {
      this.spies.push(
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          this.lines.push(`console.${method} ${format(...args)}`);
        }),
      );
    }
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream) as (
        ...args: unknown[]
      ) => boolean;
      this.spies.push(
        vi.spyOn(stream, 'write').mockImplementation((...args: unknown[]) => {
          this.lines.push(String(args[0]));
          return write(...args);
        }),
      );
    }
    return this;
  }

  stop(): void {
    for (const spy of this.spies) spy.mockRestore();
    this.spies = [];
  }

  clear(): void {
    this.lines.length = 0;
  }

  private record(level: string, message: unknown, rest: unknown[]): void {
    // Nest passes an absent stack as `undefined`; its console logger skips it.
    const params = rest.filter((param) => param !== undefined);
    this.lines.push(`${level} ${format(message, ...params)}`);
  }
}
