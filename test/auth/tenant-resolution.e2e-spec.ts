import { randomUUID } from 'node:crypto';
import { Controller, Get, Req } from '@nestjs/common';
import type { Tenant } from '@prisma/client';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Public } from '../../src/common/decorators/public.decorator';
import { TenantResolver } from '../../src/common/tenancy/tenant-resolver';
import { bootApp, type BootedApp } from '../harness/app';
import { asTenant, createTenant } from '../harness/fixtures';

// Resolve the tenant from the host (0.5.2): before anyone signs in, the
// tenant is the host's, and every other host looks like "no account here".
// Sign-in arrives with 0.5.5; until then a probe answers what its first step
// will ask the resolver. The settings are read once, as AppModule loads.
vi.hoisted(() => {
  process.env.APEX_DOMAIN = 'localhost';
  process.env.DEFAULT_TENANT_SLUG = 'launch-agency';
  process.env.DEFAULT_TENANT_HOSTS = 'agency.test';
});

@Controller('probe/host-tenant')
class HostTenantProbe {
  constructor(private readonly tenants: TenantResolver) {}

  @Public()
  @Get()
  resolve(@Req() request: Request) {
    return this.tenants.resolve(request);
  }
}

describe('the tenant of the host', () => {
  let direct: BootedApp;
  let proxied: BootedApp;
  let sadara: Tenant;
  let other: Tenant;
  let launch: Tenant;
  let dormant: Tenant;

  const setTenant = (
    tenant: Tenant,
    data: { domain?: string; isActive?: boolean },
  ) =>
    asTenant(tenant.id, (tx) =>
      tx.tenant.update({ where: { id: tenant.id }, data }),
    );

  /** The tenant the host resolves to, or the problem the request answered. */
  async function ask(
    app: BootedApp,
    host: string,
    forwardedHost?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const request = app.http.get('/api/v1/probe/host-tenant').set('Host', host);
    if (forwardedHost) request.set('X-Forwarded-Host', forwardedHost);
    const response = await request;
    return {
      status: response.status,
      body: response.body as Record<string, unknown>,
    };
  }

  /** A refusal, without what differs on every request: its ids. */
  const refusal = ({ status, body }: { status: number; body: object }) => {
    const {
      instance: _instance,
      requestId: _requestId,
      ...rest
    } = body as Record<string, unknown>;
    return { status, ...rest };
  };

  beforeAll(async () => {
    direct = await bootApp({ controllers: [HostTenantProbe] });
    proxied = await bootApp({
      controllers: [HostTenantProbe],
      trustedProxies: ['loopback'],
    });
    sadara = await createTenant({ slug: 'sadara' });
    other = await createTenant({ slug: `other-${randomUUID().slice(0, 8)}` });
    await setTenant(other, { domain: 'other.localhost' });
    launch = await createTenant({ slug: 'launch-agency' });
    dormant = await createTenant({ slug: 'dormant' });
    await setTenant(dormant, { domain: 'dormant.test', isActive: false });
  });

  afterAll(async () => {
    await Promise.all([direct?.app.close(), proxied?.app.close()]);
  });

  it('sign_in_uses_the_tenant_of_the_host', async () => {
    const tenantOf = async (app: BootedApp, host: string, forwarded?: string) =>
      (await ask(app, host, forwarded)).body;

    // A slug under APEX_DOMAIN; an exact domain; the launch's allowlisted host.
    expect(await tenantOf(direct, 'sadara.localhost')).toEqual({
      data: { id: sadara.id, slug: 'sadara' },
    });
    expect(await tenantOf(direct, 'other.localhost')).toEqual({
      data: { id: other.id, slug: other.slug },
    });
    expect(await tenantOf(direct, 'agency.test')).toEqual({
      data: { id: launch.id, slug: 'launch-agency' },
    });
    // As browsers may write it: in capitals, with the port, a trailing dot.
    expect(await tenantOf(direct, 'OTHER.Localhost.:443')).toEqual({
      data: { id: other.id, slug: other.slug },
    });

    // A forwarded host is believed only from a trusted proxy: from anyone
    // else, the request is for the host it reached.
    expect(
      await tenantOf(direct, 'sadara.localhost', 'other.localhost'),
    ).toEqual({ data: { id: sadara.id, slug: 'sadara' } });
    expect(
      await tenantOf(proxied, 'sadara.localhost', 'other.localhost'),
    ).toEqual({ data: { id: other.id, slug: other.slug } });
  });

  it('an_unknown_host_looks_like_no_account', async () => {
    const answers = [];
    for (const host of [
      'nobody.localhost', // no tenant with that slug
      'elsewhere.test', // neither a domain, under the apex, nor allowlisted
      'localhost', // the apex itself
      'a.sadara.localhost', // not one label under the apex
      '127.0.0.1',
    ]) {
      answers.push([host, refusal(await ask(direct, host))]);
    }
    // One answer, whatever the host: a not-found that names nothing.
    const [, first] = answers[0];
    expect(first).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(answers).toEqual(answers.map(([host]) => [host, first]));
    // Nor does it repeat the host it was asked about.
    expect(JSON.stringify(answers.map(([, answer]) => answer))).not.toMatch(
      /nobody|elsewhere|localhost|127\.0\.0\.1/,
    );
  });

  it('an_inactive_tenant_cannot_sign_in', async () => {
    const unknown = refusal(await ask(direct, 'nobody.localhost'));
    // By its domain and by its slug, inactive is "no account here".
    expect(refusal(await ask(direct, 'dormant.test'))).toEqual(unknown);
    expect(refusal(await ask(direct, 'dormant.localhost'))).toEqual(unknown);

    // Active again, the same hosts find it.
    await setTenant(dormant, { isActive: true });
    try {
      expect((await ask(direct, 'dormant.test')).body).toEqual({
        data: { id: dormant.id, slug: 'dormant' },
      });
    } finally {
      await setTenant(dormant, { isActive: false });
    }
  });
});
