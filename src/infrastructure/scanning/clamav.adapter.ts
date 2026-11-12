import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { type ScanResult, ScanNotCompleted, ScannerPort } from './scanner.port';

/** Where ClamAV's daemon listens, and how long a scan may go without a byte moving. */
export interface ClamAvSettings {
  readonly host: string;
  readonly port: number;
  /** A connection, or a reply, that stalls this long fails the scan. */
  readonly idleTimeoutMs?: number;
}

/** How long a scan may stall: long enough for a large file's last chunk to be scanned. */
const IDLE_TIMEOUT_MS = 60_000;
/** The most one INSTREAM chunk carries. */
const CHUNK = 64 * 1024;
/** The longest reply clamd sends for one stream: a verdict line. */
const REPLY_MAX = 4096;

/** A finding's name as clamd reports it: printable, of at most 200 characters. */
const FOUND = /^stream: ([!-~][ -~]{0,199}) FOUND$/;

/**
 * Scans through ClamAV's daemon (0.8.4; SR-DOC-004), by its INSTREAM command
 * on TCP: `zINSTREAM\0`, the bytes in chunks each led by its length (four
 * bytes, big-endian), a chunk of length zero, then one reply ended by a NUL —
 * `stream: OK`, `stream: <name> FOUND`, or an error. Every byte is sent: the
 * daemon sees the whole file. A connection refused or dropped, a stall, a
 * source that breaks off, a reply out of form or an error reply — a size
 * limit, say — is `ScanNotCompleted`, never a verdict.
 */
export class ClamAvScanner extends ScannerPort {
  constructor(private readonly settings: ClamAvSettings) {
    super();
  }

  async scan(bytes: Readable): Promise<ScanResult> {
    let socket: Socket | undefined;
    try {
      socket = await this.open();
      const reply = replyOf(socket);
      // Observed below; a rejection after the scan has ended is not lost.
      reply.catch(() => undefined);
      // A reply before every byte is sent is an error's: sending stops.
      await Promise.race([send(socket, bytes), reply]);
      return verdictOf(await reply);
    } catch (error) {
      throw error instanceof ScanNotCompleted
        ? error
        : new ScanNotCompleted('scan_source_failed');
    } finally {
      socket?.destroy();
      bytes.destroy();
    }
  }

  private open(): Promise<Socket> {
    const { host, port, idleTimeoutMs = IDLE_TIMEOUT_MS } = this.settings;
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const refused = (error: NodeJS.ErrnoException) =>
        reject(new ScanNotCompleted(codeOf(error, 'scanner_unreachable')));
      socket.setTimeout(idleTimeoutMs, () =>
        socket.destroy(new ScanNotCompleted('scanner_timeout')),
      );
      socket.once('error', refused);
      socket.once('connect', () => {
        socket.removeListener('error', refused);
        resolve(socket);
      });
    });
  }
}

/** The stream's bytes, in length-led chunks, then the end. */
async function send(socket: Socket, bytes: Readable): Promise<void> {
  await write(socket, Buffer.from('zINSTREAM\0', 'latin1'));
  for await (const piece of bytes) {
    const data = Buffer.isBuffer(piece)
      ? piece
      : Buffer.from(piece as Uint8Array);
    for (let at = 0; at < data.length; at += CHUNK) {
      const chunk = data.subarray(at, at + CHUNK);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length);
      await write(socket, Buffer.concat([length, chunk]));
    }
  }
  await write(socket, Buffer.alloc(4));
}

/** Writes, then waits for room when the socket asks for it. */
function write(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (socket.write(data)) resolve();
    else socket.once('drain', resolve);
  });
}

/** The one reply, up to its NUL. */
function replyOf(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      received = Buffer.concat([received, data]);
      const end = received.indexOf(0);
      if (end >= 0) resolve(received.subarray(0, end).toString('latin1'));
      else if (received.length > REPLY_MAX) {
        reject(new ScanNotCompleted('scanner_reply_too_long'));
      }
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error instanceof ScanNotCompleted
          ? error
          : new ScanNotCompleted(codeOf(error, 'scanner_dropped')),
      ),
    );
    socket.once('close', () => reject(new ScanNotCompleted('scanner_closed')));
  });
}

function verdictOf(reply: string): ScanResult {
  if (reply === 'stream: OK') return { verdict: 'CLEAN' };
  const found = FOUND.exec(reply);
  if (found) return { verdict: 'INFECTED', finding: found[1] };
  // "INSTREAM size limit exceeded. ERROR", or anything else: no verdict.
  throw new ScanNotCompleted(
    reply.endsWith('ERROR') ? 'scanner_error' : 'scanner_reply_unknown',
  );
}

/** A system error's code, lower-cased (`econnrefused`), else `fallback`. */
function codeOf(error: NodeJS.ErrnoException, fallback: string): string {
  return typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code.toLowerCase()
    : fallback;
}
