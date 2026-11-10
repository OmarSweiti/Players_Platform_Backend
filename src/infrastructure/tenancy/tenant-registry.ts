import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { databaseConnectionOf } from '../prisma/database-url';

/**
 * Which tenants have work to find (0.7.6; SYS-TEN-006, docs/reference/
 * database.md, "TenantRegistry"): the ids of the active tenants, and nothing
 * else of theirs. It connects as the registry role, which may read only
 * tenant_directory's id and is_active (the …_registry_role migration): no
 * slug, no domain, no table, and no way past row-level security. The worker
 * enumerates it, then claims each tenant's work in that tenant's own
 * transaction, as the runtime role; there is no privileged client and no
 * query across tenants.
 */
@Injectable()
export class TenantRegistry implements OnModuleDestroy {
  private readonly pool: Pool;
  private closed = false;

  /** `url`: the registry role's connection (REGISTRY_DATABASE_URL). */
  constructor(url: string) {
    const { connectionString, options } = databaseConnectionOf(url);
    this.pool = new Pool({
      connectionString,
      options,
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  /** The active tenants' ids, in a stable order. */
  async activeTenantIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM tenant_directory WHERE is_active ORDER BY id',
    );
    return rows.map((row) => row.id);
  }

  /** Closes the connection, once: a second call does nothing. */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
