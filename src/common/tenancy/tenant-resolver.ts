import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { DNS_LABEL, HOST_NAME, type Env } from '../../config/env.schema';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { NotFoundError } from '../errors/domain-error';
import type { TenantId } from './tenant-context';

/** The tenant a host names, before anyone has signed in. */
export interface HostTenant {
  readonly id: TenantId;
  readonly slug: string;
}

/**
 * "No account here" (0.5.2): what an unknown host, an inactive tenant and —
 * from `0.5.5` — a person with no membership in the host's tenant all see,
 * exactly alike. It is an ordinary not-found, so it says nothing about which
 * agencies exist.
 */
export class NoAccountHereError extends NotFoundError {
  constructor() {
    super('No account here');
  }
}

/**
 * The host a request names, as Express reads it: `X-Forwarded-Host` only when
 * the peer is a proxy TRUSTED_PROXIES names, else `Host`; without the port, in
 * lower case and without a trailing dot. Null when it is no host name.
 */
export function hostOf(request: Pick<Request, 'hostname'>): string | null {
  const host = (request.hostname ?? '').toLowerCase().replace(/\.$/, '');
  return HOST_NAME.test(host) ? host : null;
}

interface DirectoryRow {
  id: string;
  slug: string;
  is_active: boolean;
}

/**
 * The tenant of the host a request came to (0.5.2), read through the
 * `tenant_directory` view, which shows the runtime role every tenant's id,
 * slug, domain and state and nothing else (0.4.5):
 *
 *   1. a tenant whose domain is exactly the host;
 *   2. else the tenant whose slug is the host's first label, under APEX_DOMAIN;
 *   3. else, for the single-agency launch, DEFAULT_TENANT_SLUG, for a host
 *      DEFAULT_TENANT_HOSTS lists.
 *
 * Any other host, or an inactive tenant, is refused as "no account here". The
 * tenant it finds scopes the sign-in transaction and the membership lookup
 * (`0.5.5`); once signed in, the session is the only source of the tenant.
 */
@Injectable()
export class TenantResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async resolve(request: Pick<Request, 'hostname'>): Promise<HostTenant> {
    const host = hostOf(request);
    if (host === null) throw new NoAccountHereError();
    const tenant =
      (await this.find('domain', host)) ??
      (await this.find('slug', this.slugFor(host)));
    if (!tenant?.is_active) throw new NoAccountHereError();
    return { id: tenant.id as TenantId, slug: tenant.slug };
  }

  /** The slug a host stands for when no tenant has it as its domain. */
  private slugFor(host: string): string | null {
    const apex = this.config.get('APEX_DOMAIN', { infer: true });
    if (apex !== undefined && host.endsWith(`.${apex}`)) {
      const label = host.slice(0, -apex.length - 1);
      return DNS_LABEL.test(label) ? label : null;
    }
    const launch = this.config.get('DEFAULT_TENANT_HOSTS', { infer: true });
    return launch.includes(host)
      ? (this.config.get('DEFAULT_TENANT_SLUG', { infer: true }) ?? null)
      : null;
  }

  private async find(
    by: 'domain' | 'slug',
    value: string | null,
  ): Promise<DirectoryRow | null> {
    if (value === null) return null;
    const rows =
      by === 'domain'
        ? await this.prisma.$queryRaw<DirectoryRow[]>`
            SELECT id::text AS id, slug, is_active FROM tenant_directory WHERE domain = ${value}`
        : await this.prisma.$queryRaw<DirectoryRow[]>`
            SELECT id::text AS id, slug, is_active FROM tenant_directory WHERE slug = ${value}`;
    return rows[0] ?? null;
  }
}
