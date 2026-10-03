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
    // A token in the query and a password in the body, on the routes that
    // log — the public health checks — and on the retired sign-in addresses
    // (0.1.6), which must leave no trace either.
    await http.get('/api/health').query({ token: TOKEN, password: PASSWORD });
    await http.get('/api/health/ready').query({ token: TOKEN });
    await http
      .post('/api/health')
      .send({ email, password: PASSWORD, token: TOKEN });
    await http.get('/api/auth/verify-email').query({ token: TOKEN });
    await http.post('/api/auth/login').send({ email, password: PASSWORD });
    await http
      .post('/api/auth/reset-password')
      .send({ token: TOKEN, newPassword: PASSWORD });

    expect(capture.lines.length).toBeGreaterThan(0); // the log really was captured
    for (const line of capture.lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(PASSWORD);
      expect(line).not.toMatch(EMAIL_ADDRESS);
    }
  });

  it('urls_are_logged_without_query_strings', async () => {
    await booted.http.get('/api/health').query({ token: TOKEN, lang: 'ar' });

    // The access log names the route template, and never the query.
    expect(
      capture.lines.some((line) => line.includes('GET /api/health ')),
    ).toBe(true);
    for (const line of capture.lines) {
      expect(line).not.toContain('health?');
      expect(line).not.toContain('lang=ar');
    }
  });

  it('unmatched_routes_never_echo_the_query_string', async () => {
    // Nest's own not-found message quotes the request's original URL.
    const response = await booted.http
      .get('/api/no-such-route')
      .query({ token: TOKEN });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect(response.body).toMatchObject({
      message: 'Cannot GET /api/no-such-route',
      path: '/api/no-such-route',
    });
  });

  it('error_responses_never_echo_the_query_string', async () => {
    // A matched route's refusal: the quarantine of 0.1.8 answers 404.
    const response = await booted.http
      .get('/api/medical/records')
      .query({ token: TOKEN });

    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    expect(response.body).toMatchObject({ path: '/api/medical/records' });
  });
});
