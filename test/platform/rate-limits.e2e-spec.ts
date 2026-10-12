import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Public } from '../../src/common/decorators/public.decorator';
import {
  RATE_LIMIT_KEY,
  RateLimit,
} from '../../src/common/rate-limit/rate-limit.decorator';
import {
  RATE_LIMITS,
  type RateLimitCategory,
} from '../../src/common/rate-limit/rate-limits';
import { bootApp, type BootedApp } from '../harness/app';
import { createMember, createTenant } from '../harness/fixtures';
import { controllersOf } from '../harness/routes';
import { TEST_MEMBER_HEADER } from '../harness/session';

// Test-only routes, one per category; the undecorated one is `default`.
@Public()
@Controller('probe/rate-limits')
class LimitedController {
  @Get('default')
  default() {
    return null;
  }

  @RateLimit('auth')
  @Get('auth')
  auth() {
    return null;
  }

  @RateLimit('upload')
  @Get('upload')
  upload() {
    return null;
  }

  @RateLimit('export')
  @Get('export')
  export() {
    return null;
  }

  @RateLimit('message')
  @Get('message')
  message() {
    return null;
  }

  @RateLimit('privileged')
  @Get('privileged')
  privileged() {
    return null;
  }
}

// The same categories behind a session: who counts is the signed-in member.
@Controller('probe/members')
class MemberController {
  @RateLimit('export')
  @Get('export')
  export() {
    return null;
  }

  @RateLimit('auth')
  @Get('auth')
  auth() {
    return null;
  }
}

const CATEGORIES = Object.keys(RATE_LIMITS) as RateLimitCategory[];
const pathOf = (category: RateLimitCategory) =>
  `/api/v1/probe/rate-limits/${category}`;
const CORS_ORIGIN = 'https://app.agency.test'; // vitest.config.mts

type Headers = Record<string, string>;

/** `times` requests that must all pass, each with its own headers. */
async function spend(
  app: BootedApp,
  path: string,
  times: number,
  headers: (i: number) => Headers = () => ({}),
): Promise<void> {
  for (let i = 0; i < times; i++) {
    const response = await app.http.get(path).set(headers(i));
    expect([path, i, response.status]).toEqual([path, i, 200]);
  }
}

/** The request must be refused as RATE_LIMITED, told when to try again. */
async function expectRefused(
  app: BootedApp,
  path: string,
  windowSeconds: number,
  headers: Headers = {},
): Promise<void> {
  const response = await app.http.get(path).set(headers);
  expect([path, response.status]).toEqual([path, 429]);
  expect(response.headers['content-type']).toContain(
    'application/problem+json',
  );
  expect(response.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  const retryAfter = Number(response.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
}

describe('rate limits by category, shared through Valkey', () => {
  const booted: BootedApp[] = [];
  /** An app with the test routes, counting in a namespace of its own. */
  async function boot(opts: Parameters<typeof bootApp>[0] = {}) {
    const app = await bootApp({ controllers: [LimitedController], ...opts });
    booted.push(app);
    return app;
  }
  let app: BootedApp;

  beforeAll(async () => {
    app = await boot();
  });

  afterAll(async () => {
    await Promise.all(booted.map((each) => each.app.close()));
  });

  it('each_category_applies_its_own_limit', async () => {
    // In turn: each category's allowance is whole after the last was spent.
    for (const category of CATEGORIES) {
      const { limit, windowSeconds } = RATE_LIMITS[category];
      await spend(app, pathOf(category), limit);
      await expectRefused(app, pathOf(category), windowSeconds);
    }
    // A browser's script may read when to try again.
    const refused = await app.http
      .get(pathOf('export'))
      .set('Origin', CORS_ORIGIN);
    expect(refused.status).toBe(429);
    expect(refused.headers['access-control-expose-headers']).toContain(
      'Retry-After',
    );
    // Every category says the spending of the others never touched it: each
    // is stricter than `default`, as SR-API-008 asks.
    const perMinute = (category: RateLimitCategory) =>
      (RATE_LIMITS[category].limit * 60) / RATE_LIMITS[category].windowSeconds;
    for (const category of CATEGORIES.filter((c) => c !== 'default')) {
      expect([category, perMinute(category) < perMinute('default')]).toEqual([
        category,
        true,
      ]);
    }
  });

  it('limits_hold_across_two_api_instances', async () => {
    const namespace = randomUUID();
    const instances = [
      await boot({ rateLimitNamespace: namespace }),
      await boot({ rateLimitNamespace: namespace }),
    ];
    const { limit, windowSeconds } = RATE_LIMITS.export;
    // Alternating: each instance alone has passed only half the limit.
    for (let i = 0; i < limit; i++) {
      await spend(instances[i % 2], pathOf('export'), 1);
    }
    for (const instance of instances) {
      await expectRefused(instance, pathOf('export'), windowSeconds);
    }
  });

  it('a_spoofed_forwarded_for_header_is_ignored', async () => {
    const { limit, windowSeconds } = RATE_LIMITS.export;
    const spoofed = (i: number) => ({ 'X-Forwarded-For': `198.51.100.${i}` });

    // No proxy trusted, the default: the client is whoever connected, and
    // a new address in the header each time buys nothing.
    const direct = await boot();
    await spend(direct, pathOf('export'), limit, spoofed);
    await expectRefused(direct, pathOf('export'), windowSeconds, spoofed(99));

    // Behind a trusted proxy, the client is the address the proxy appended;
    // what the client wrote before it is ignored.
    const proxied = await boot({ trustedProxies: ['loopback'] });
    const through = (i: number) => ({
      'X-Forwarded-For': `198.51.100.${i}, 203.0.113.7`,
    });
    await spend(proxied, pathOf('export'), limit, through);
    await expectRefused(proxied, pathOf('export'), windowSeconds, through(99));
    // Another client behind the same proxy keeps its own allowance.
    await spend(proxied, pathOf('export'), 1, () => ({
      'X-Forwarded-For': '203.0.113.8',
    }));
  });

  it('a_signed_in_member_counts_as_themselves', async () => {
    const signedIn = await boot({
      controllers: [MemberController],
      testSessions: true,
    });
    const tenant = await createTenant();
    const [first, second] = await Promise.all([
      createMember(tenant, 'COACH'),
      createMember(tenant, 'COACH'),
    ]);
    const as = (member: { id: string }) => () => ({
      [TEST_MEMBER_HEADER]: member.id,
    });

    // Two members on one network: one's exports leave the other's whole.
    const members = '/api/v1/probe/members';
    const { limit, windowSeconds } = RATE_LIMITS.export;
    await spend(signedIn, `${members}/export`, limit, as(first));
    await expectRefused(
      signedIn,
      `${members}/export`,
      windowSeconds,
      as(first)(),
    );
    await spend(signedIn, `${members}/export`, 1, as(second));

    // Signing in counts by address, signed in or not.
    const auth = RATE_LIMITS.auth;
    await spend(signedIn, `${members}/auth`, auth.limit, as(first));
    await expectRefused(
      signedIn,
      `${members}/auth`,
      auth.windowSeconds,
      as(second)(),
    );
  });

  it('only_the_probes_go_unlimited', () => {
    const unlimited = controllersOf(app.app).flatMap((controller) => {
      if (Reflect.getMetadata(RATE_LIMIT_KEY, controller) === 'none') {
        return [`${controller.name}, every route`];
      }
      const prototype = controller.prototype as Record<string, object>;
      return Object.getOwnPropertyNames(prototype)
        .filter(
          (handler) =>
            handler !== 'constructor' &&
            Reflect.getMetadata(RATE_LIMIT_KEY, prototype[handler]) === 'none',
        )
        .map((handler) => `${controller.name}.${handler}`);
    });
    expect(unlimited.sort()).toEqual([
      'HealthController.live',
      'HealthController.ready',
    ]);
  });
});
