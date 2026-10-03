import { Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailService } from './mail.service';

const TOKEN = 'canary-token-3c9d1e';
const ADDRESS = 'member-3c9d1e@agency.test';

describe('MailService', () => {
  const lines: string[] = [];
  const capture: LoggerService = {
    log: (...args: unknown[]) => lines.push(format(...args)),
    error: (...args: unknown[]) => lines.push(format(...args)),
    warn: (...args: unknown[]) => lines.push(format(...args)),
    debug: (...args: unknown[]) => lines.push(format(...args)),
    verbose: (...args: unknown[]) => lines.push(format(...args)),
    fatal: (...args: unknown[]) => lines.push(format(...args)),
  };
  const config = {
    get: (key: string) =>
      key === 'CORS_ORIGIN' ? 'https://sadara.localhost' : undefined,
  } as unknown as ConfigService;

  beforeEach(() => {
    lines.length = 0;
    Logger.overrideLogger(capture);
  });

  afterEach(() => Logger.overrideLogger(false));

  it('the_mail_stub_logs_neither_the_address_nor_the_link', async () => {
    const mail = new MailService(config);

    await mail.sendPasswordResetEmail(ADDRESS, TOKEN);
    await mail.sendVerificationEmail(ADDRESS, TOKEN);

    expect(lines.length).toBeGreaterThan(0); // the stub still says what it did
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(ADDRESS);
    }
  });
});
