import { once } from 'node:events';
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from 'node:net';

/** A message the sink accepted: its envelope, and its content as sent. */
export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  /** The message, its headers and body, dot-unstuffed. */
  readonly raw: string;
}

/**
 * An SMTP server in this process, for the mail adapter's tests (0.7.8): it
 * speaks enough of RFC 5321 for a client to send a message — EHLO, MAIL,
 * RCPT, DATA, RSET, NOOP, QUIT — and keeps what it accepted. A test makes it
 * refuse the next messages with `refuseNext` ('451 …' transient, '550 …'
 * permanent), as a server might.
 */
export class SmtpSink {
  readonly received: ReceivedMail[] = [];
  private readonly refusals: string[] = [];
  private readonly sockets = new Set<Socket>();

  private constructor(private readonly server: Server) {}

  static async start(): Promise<SmtpSink> {
    const server = createServer();
    const sink = new SmtpSink(server);
    server.on('connection', (socket) => sink.serve(socket));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return sink;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Answers the next messages' DATA with these replies, in order, instead of accepting them. */
  refuseNext(...replies: string[]): void {
    this.refusals.push(...replies);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    await once(this.server, 'close');
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let buffered = '';
    let from = '';
    let to: string[] = [];
    let data: string[] | null = null;
    reply('220 sink.test ESMTP');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (data !== null) {
          if (line !== '.') {
            data.push(line.startsWith('..') ? line.slice(1) : line);
            continue;
          }
          const raw = data.join('\r\n');
          data = null;
          const refusal = this.refusals.shift();
          if (refusal !== undefined) reply(refusal);
          else {
            this.received.push({ from, to, raw });
            reply(`250 2.0.0 Ok: queued as ${this.received.length}`);
          }
          from = '';
          to = [];
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          reply('250-sink.test');
          reply('250-8BITMIME');
          reply('250 SMTPUTF8');
        } else if (verb === 'HELO') reply('250 sink.test');
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 2.1.5 Ok');
        } else if (verb === 'DATA') {
          data = [];
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          from = '';
          to = [];
          reply('250 2.0.0 Ok');
        } else if (verb === 'NOOP') reply('250 2.0.0 Ok');
        else if (verb === 'QUIT') {
          reply('221 2.0.0 Bye');
          socket.end();
        } else reply('502 5.5.2 Command not recognized');
      }
    });
  }
}

/** A header of `raw`, its encoded words (RFC 2047) decoded. */
export function headerOf(raw: string, name: string): string | undefined {
  const head = raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const line = head
    .split('\r\n')
    .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  if (line === undefined) return undefined;
  return line
    .slice(name.length + 1)
    .trim()
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?utf-8\?([bq])\?([^?]*)\?=/gi,
      (_match, encoding: string, text: string) =>
        encoding.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64').toString('utf8')
          : quotedPrintable(text.replace(/_/g, ' ')),
    );
}

/** The text of the part of `raw` of `type`, decoded; '' when it has none. */
export function partOf(raw: string, type: 'text/plain' | 'text/html'): string {
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw)?.[1];
  const parts = boundary === undefined ? [raw] : raw.split(`--${boundary}`);
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split).toLowerCase();
    if (!head.includes(`content-type: ${type}`)) continue;
    const body = part.slice(split + 4);
    if (head.includes('content-transfer-encoding: base64')) {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (head.includes('content-transfer-encoding: quoted-printable')) {
      return quotedPrintable(body);
    }
    return body;
  }
  return '';
}

function quotedPrintable(text: string): string {
  const bytes = text
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  return Buffer.from(bytes, 'latin1').toString('utf8');
}
