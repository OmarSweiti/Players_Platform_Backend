import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant } from '../harness/fixtures';
import { LogCapture } from '../harness/log-capture';

// Canaries: random values that must never reach a log line or an error body.
const TOKEN = `canary-token-${randomBytes(12).toString('hex')}`;
const PASSWORD = `Canary-${randomBytes(12).toString('hex')}!`;
const EMAIL_ADDRESS = /[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i;

describe('secrets and personal data stay out of logs and error responses', () => {
  const capture = new LogCapture();
  let booted: BootedApp;
  let email: string;

  beforeAll(async () => {
    booted = await bootApp({ logger: capture });
    const tenant = await createTenant();
    email = (await createMember(tenant, 'COACH')).email;
    capture.start();
  });

  beforeEach(() => capture.clear());

  afterAll(async () => {
    capture.stop();
    await booted?.app.close();
  });

  it('no_log_line_contains_a_token_or_password', async () => {
    const { http } = booted;
    // Every public route that takes a token, a password or an address, on
    // its success, refusal and error paths.
    await http.get('/api/auth/verify-email').query({ token: TOKEN });
    await http.post('/api/auth/login').send({ email, password: PASSWORD });
    await http.post('/api/auth/login').send({
      email: `nobody-${randomBytes(4).toString('hex')}@agency.test`,
      password: PASSWORD,
    });
    await http.post('/api/auth/register').send({
      email: `new-${randomBytes(4).toString('hex')}@agency.test`,
      password: PASSWORD,
      firstName: 'Test',
      lastName: 'Member',
      role: 'COACH',
    });
    await http.post('/api/auth/forgot-password').send({ email });
    await http
      .post('/api/auth/reset-password')
      .send({ token: TOKEN, newPassword: PASSWORD });
    await http.post('/api/auth/resend-verification').send({ email });

    expect(capture.lines.length).toBeGreaterThan(0); // the log really was captured
    for (const line of capture.lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toMatch(EMAIL_ADDRESS);
    }
  });

  it('urls_are_logged_without_query_strings', async () => {
    await booted.http
      .get('/api/auth/verify-email')
      .query({ token: TOKEN, lang: 'ar' });

    // The access log names the route template, and never the query.
    expect(
      capture.lines.some((line) =>
        line.includes('GET /api/auth/verify-email '),
      ),
    ).toBe(true);
    for (const line of capture.lines) {
      expect(line).not.toContain('verify-email?');
      expect(line).not.toContain('lang=ar');
    }
  });

  it('error_responses_never_echo_the_query_string', async () => {
    const response = await booted.http
      .get('/api/auth/verify-email')
      .query({ token: TOKEN });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });
});
