import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamAvScanner } from './clamav.adapter';
import { ScanNotCompleted } from './scanner.port';

/** What a fake daemon heard: the command, then the stream's chunks, reassembled. */
interface Heard {
  command: string;
  bytes: Buffer;
  chunks: number[];
  ended: boolean;
}

/**
 * A fake clamd on a free local port: it reads INSTREAM as the daemon does
 * and answers what `reply` says once the stream ends — or earlier, or never.
 */
async function fakeDaemon(
  reply: (heard: Heard, socket: Socket) => void,
): Promise<{ server: Server; port: number; heard: Heard[] }> {
  const heard: Heard[] = [];
  const server = createServer((socket) => {
    const one: Heard = {
      command: '',
      bytes: Buffer.alloc(0),
      chunks: [],
      ended: false,
    };
    heard.push(one);
    let buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (one.command === '') {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        one.command = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 1);
      }
      while (!one.ended && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          one.ended = true;
          buffer = buffer.subarray(4);
          reply(one, socket);
          return;
        }
        if (buffer.length < 4 + length) return;
        one.chunks.push(length);
        one.bytes = Buffer.concat([one.bytes, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, heard };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function daemon(reply: (heard: Heard, socket: Socket) => void) {
  const fake = await fakeDaemon(reply);
  servers.push(fake.server);
  return {
    ...fake,
    scanner: new ClamAvScanner({
      host: '127.0.0.1',
      port: fake.port,
      idleTimeoutMs: 300,
    }),
  };
}

const notCompleted = (code: string) =>
  expect.objectContaining({ name: 'ScanNotCompleted', code }) as unknown;

describe('the ClamAV adapter', () => {
  it('sends every byte as INSTREAM, in bounded chunks, then the end', async () => {
    const { scanner, heard } = await daemon((_, socket) =>
      socket.end('stream: OK\0'),
    );
    const file = randomBytes(200 * 1024 + 7);
    // Two pieces, as a store's stream gives them.
    const source = Readable.from([
      file.subarray(0, 100_000),
      file.subarray(100_000),
    ]);
    await expect(scanner.scan(source)).resolves.toEqual({ verdict: 'CLEAN' });
    expect(heard).toHaveLength(1);
    expect(heard[0].command).toBe('zINSTREAM');
    expect(heard[0].bytes.equals(file)).toBe(true);
    expect(Math.max(...heard[0].chunks)).toBeLessThanOrEqual(64 * 1024);
    expect(heard[0].ended).toBe(true);
  });

  it('names what it found', async () => {
    const { scanner } = await daemon((_, socket) =>
      socket.end('stream: Win.Test.EICAR_HDB-1 FOUND\0'),
    );
    await expect(
      scanner.scan(Readable.from([Buffer.from('x')])),
    ).resolves.toEqual({
      verdict: 'INFECTED',
      finding: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('reaches no verdict on an error, a stall, a drop, or no daemon', async () => {
    // An error reply, before the stream ends, as clamd's size limit sends it.
    const limited = await daemon(() => undefined);
    limited.server.removeAllListeners('connection');
    limited.server.on('connection', (socket: Socket) => {
      socket.once('data', () =>
        socket.end('INSTREAM size limit exceeded. ERROR\0'),
      );
    });
    await expect(
      limited.scanner.scan(Readable.from([randomBytes(1024)])),
    ).rejects.toEqual(notCompleted('scanner_error'));

    // A reply out of form.
    const odd = await daemon((_, socket) => socket.end('stream: MAYBE\0'));
    await expect(
      odd.scanner.scan(Readable.from([Buffer.from('x')])),
    ).rejects.toEqual(notCompleted('scanner_reply_unknown'));

    // A daemon that never answers.
    const silent = await daemon(() => undefined);
    await expect(
      silent.scanner.scan(Readable.from([Buffer.from('x')])),
    ).rejects.toEqual(notCompleted('scanner_timeout'));

    // A daemon that hangs up without a verdict.
    const dropping = await daemon((_, socket) => socket.destroy());
    await expect(
      dropping.scanner.scan(Readable.from([Buffer.from('x')])),
    ).rejects.toEqual(notCompleted('scanner_closed'));

    // No daemon at all.
    const closed = await daemon(() => undefined);
    await new Promise((resolve) => closed.server.close(resolve));
    servers.splice(servers.indexOf(closed.server), 1);
    await expect(
      closed.scanner.scan(Readable.from([Buffer.from('x')])),
    ).rejects.toEqual(notCompleted('econnrefused'));

    // A source that breaks off midway.
    const waiting = await daemon((_, socket) => socket.end('stream: OK\0'));
    const broken = new Readable({
      read() {
        this.destroy(new Error('the store stopped sending'));
      },
    });
    await expect(waiting.scanner.scan(broken)).rejects.toBeInstanceOf(
      ScanNotCompleted,
    );
  });
});
