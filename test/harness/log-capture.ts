import { format } from 'node:util';
import { type MockInstance, vi } from 'vitest';
import type { LogSink } from '../../src/infrastructure/logging/logger-options';

const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Everything the application writes while a test watches: every line of the
 * structured log, at every level — the access log and Nest's own lines alike —
 * and, once `start()`ed, what reaches the console and raw writes to stdout and
 * stderr. Pass it to `bootApp({ logs })`, then `start()` before the requests.
 */
export class LogCapture {
  readonly lines: string[] = [];
  private spies: MockInstance[] = [];

  /** Where bootApp points the logger: every level, into `lines`. */
  get sink(): LogSink {
    return {
      level: 'trace',
      stream: { write: (line: string) => this.lines.push(line.trimEnd()) },
    };
  }

  /** The structured lines, parsed; console and raw writes are not JSON. */
  entries(): Record<string, unknown>[] {
    return this.lines.flatMap((line) => {
      try {
        const entry: unknown = JSON.parse(line);
        return isRecord(entry) ? [entry] : [];
      } catch {
        return [];
      }
    });
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
}
