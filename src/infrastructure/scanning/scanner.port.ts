import type { Readable } from 'node:stream';

/** What a malware scan of a file's bytes found: nothing, or something it names. */
export type ScanResult =
  | { readonly verdict: 'CLEAN' }
  | { readonly verdict: 'INFECTED'; readonly finding: string };

/**
 * A scan that reached no verdict (0.8.4): the scanner did not answer, broke
 * off, or answered with an error. Never a verdict: a file is clean only when
 * the scanner says so, so this is tried again, and in the end fails the file.
 * `code` names why, for the log and the outbox — never a message.
 */
export class ScanNotCompleted extends Error {
  constructor(readonly code: string) {
    super(`scan not completed: ${code}`);
    this.name = 'ScanNotCompleted';
  }
}

/**
 * The malware scanner (0.8.4; SR-DOC-004), behind a port: ClamAV's daemon
 * (clamav.adapter.ts), the stack's `clamav` service. It reads a file's bytes
 * from a stream, every one, and answers a verdict or throws
 * `ScanNotCompleted`.
 */
export abstract class ScannerPort {
  abstract scan(bytes: Readable): Promise<ScanResult>;
}
