import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tenant } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { MODEL_CLASSIFICATION } from '../../src/infrastructure/prisma/model-classification';
import { asTenant, createPlayer, createTenant } from '../harness/fixtures';

// UUIDv7 for high-ingest tables (0.4.11; SR-DB-002), as the runtime role, on
// two tenants. Prisma 7's runtime model carries no defaults, so the schema's
// own text is read for each model's @default.

/** Models whose key is natural, not a generated UUID. */
const NATURAL_KEYS = new Set(['CurrencyDefinition']);

/** Each model's id default, as prisma/schema.prisma declares it: `uuid(7)`, `uuid()`, or none. */
function declaredIdDefaults(): Record<string, string | null> {
  const schema = readFileSync(
    join(__dirname, '../../prisma/schema.prisma'),
    'utf8',
  );
  const defaults: Record<string, string | null> = {};
  for (const [, model, body] of schema.matchAll(
    /^model (\w+) \{\n([\s\S]*?)^\}/gm,
  )) {
    const id = /^\s*\w+\s+String\s+@id\b.*@default\((uuid\(\d*\))\)/m.exec(
      body,
    );
    defaults[model] = id?.[1] ?? null;
  }
  return defaults;
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The version nibble of a UUID. */
const versionOf = (id: string) => Number.parseInt(id[14], 16);

/** The Unix time in milliseconds that a UUIDv7's first 48 bits carry. */
const millisecondsOf = (id: string) =>
  Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);

describe('UUIDv7 for high-ingest tables', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    const { connectionString, options } = databaseConnectionOf(
      inject('databaseUrl'),
    );
    app = new Client({ connectionString, options });
    await app.connect();
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('high_ingest_ids_are_time_ordered', async () => {
    // The schema declares what the classification records: uuid(7) for a
    // time-ordered model, uuid() (v4) for every other.
    expect(declaredIdDefaults()).toEqual(
      Object.fromEntries(
        Object.entries(MODEL_CLASSIFICATION).map(([model, modelClass]) => [
          model,
          modelClass.ids === 'time-ordered'
            ? 'uuid(7)'
            : NATURAL_KEYS.has(model)
              ? null
              : 'uuid()',
        ]),
      ),
    );
    expect(
      Object.entries(MODEL_CLASSIFICATION)
        .filter(([, modelClass]) => modelClass.ids === 'time-ordered')
        .map(([model]) => model),
    ).toEqual([
      'SecurityEvent',
      'UserSession',
      'AuditLog',
      'OutboxEvent',
      'ConsumerInbox',
      'IdempotencyRecord',
    ]);

    // Audit rows written through Prisma, one after another, in two tenants:
    // version 7, stamped with the time of writing, in creation order.
    const writers = [a, b, a, b, a, a];
    const before = Date.now();
    const ids: string[] = [];
    for (const tenant of writers) {
      const { id } = await asTenant(tenant.id, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            actorType: 'SYSTEM',
            actorJob: 'test-fixture',
            outcome: 'SUCCEEDED',
            schemaVersion: 1,
            action: 'test.probe',
            entityType: 'Player',
            entityId: randomUUID(),
          },
          select: { id: true },
        }),
      );
      ids.push(id);
    }
    const after = Date.now();
    expect(ids.filter((id) => !UUID_V7.test(id))).toEqual([]);
    for (const id of ids) {
      expect(millisecondsOf(id)).toBeGreaterThanOrEqual(before);
      expect(millisecondsOf(id)).toBeLessThanOrEqual(after);
    }
    expect([...ids].sort()).toEqual(ids);

    // The database orders them the same way, so each new key lands at the
    // end of the primary key's index.
    for (const tenant of [a, b]) {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant.id,
        ]);
        const { rows } = await app.query<{ id: string }>(
          'SELECT id FROM audit_logs WHERE id = ANY($1::uuid[]) ORDER BY id',
          [ids],
        );
        expect(rows.map((row) => row.id)).toEqual(
          ids.filter((_, i) => writers[i] === tenant),
        );
      } finally {
        await app.query('ROLLBACK');
      }
    }

    // Every other table keeps v4.
    expect(versionOf((await createPlayer(a)).id)).toBe(4);

    // The column has no SQL default: a raw INSERT supplies its own id, and a
    // v4 id written before this step stays as it is.
    const { rows: columnDefault } = await app.query<{ value: string | null }>(
      `SELECT column_default AS value FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_logs'
          AND column_name = 'id'`,
    );
    expect(columnDefault).toEqual([{ value: null }]);
    const earlier = randomUUID();
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [b.id]);
      const { rows } = await app.query<{ id: string }>(
        `INSERT INTO audit_logs (id, event_id, tenant_id, actor_type, outcome, schema_version,
                                 action, entity_type, entity_id)
         VALUES ($1, uuidv7(), $2, 'SYSTEM', 'SUCCEEDED', 1, 'test.probe', 'Player', gen_random_uuid())
         RETURNING id`,
        [earlier, b.id],
      );
      expect(rows).toEqual([{ id: earlier }]);
      expect(versionOf(earlier)).toBe(4);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
