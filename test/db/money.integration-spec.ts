import { randomUUID } from 'node:crypto';
import type { Tenant } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ISO_4217_MINOR_UNITS,
  ISO_4217_PUBLISHED,
} from '../../src/common/money/iso-4217';
import { Money } from '../../src/common/money/money';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { asTenant, createPlayer, createTenant } from '../harness/fixtures';

// Money in the database (0.4.7; ADR-0006): the currencies, and the columns
// that carry amounts in them. Everything runs as the runtime role.

/** Each money column, and the column that names its currency. */
const MONEY_COLUMNS = [
  ['contracts', 'salary_amount', 'salary_currency'],
  ['contracts', 'signing_fee', 'salary_currency'],
  ['trainings', 'price', 'currency'],
  ['enrollments', 'paid_amount', 'paid_currency'],
] as const;

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

describe('money in the database', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('every_active_iso_4217_currency_is_seeded_with_its_decimals', async () => {
    const { rows } = await app.query<{
      code: string;
      exponent: number;
      enabled: boolean;
    }>(
      `SELECT code, minor_unit_exponent AS exponent, enabled
         FROM currency_definitions ORDER BY code`,
    );
    // The list ISO 4217's maintenance agency published, every code enabled.
    expect(ISO_4217_PUBLISHED).toBe('2026-09-17');
    expect(rows).toEqual(
      Object.entries(ISO_4217_MINOR_UNITS)
        .sort(([x], [y]) => (x < y ? -1 : 1))
        .map(([code, exponent]) => ({ code, exponent, enabled: true })),
    );
    expect(rows).toHaveLength(165);
    const exponentOf = (code: string) =>
      rows.find((row) => row.code === code)?.exponent;
    expect(['JOD', 'KWD', 'USD', 'JPY', 'CLF'].map(exponentOf)).toEqual([
      3, 3, 2, 0, 4,
    ]);
    expect(exponentOf('XAU')).toBeUndefined(); // gold: no minor units, never payable

    // Its rules are the database's, and the runtime role reads it only.
    const { rows: checks } = await app.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'currency_definitions'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    expect(checks.map((c) => c.definition)).toEqual([
      "CHECK ((code ~ '^[A-Z]{3}$'::text))",
      'CHECK (((minor_unit_exponent >= 0) AND (minor_unit_exponent <= 4)))',
    ]);
    await expect(
      app.query(
        "INSERT INTO currency_definitions (code, minor_unit_exponent) VALUES ('ZZZ', 2)",
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('money_columns_hold_every_currencys_decimals', async () => {
    // NUMERIC(19,4), each beside a currency of currency_definitions; no column
    // keeps scale 2, and the four-value enum is gone.
    for (const [table, amount, currency] of MONEY_COLUMNS) {
      const { rows } = await app.query<{
        type: string;
        currencyType: string;
        key: string | null;
      }>(
        `SELECT format_type(m.atttypid, m.atttypmod) AS type,
                format_type(c.atttypid, c.atttypmod) AS "currencyType",
                (SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k
                  WHERE k.conrelid = $1::regclass AND k.contype = 'f'
                    AND k.conkey = ARRAY[c.attnum]) AS key
           FROM pg_attribute m, pg_attribute c
          WHERE m.attrelid = $1::regclass AND m.attname = $2
            AND c.attrelid = $1::regclass AND c.attname = $3`,
        [table, amount, currency],
      );
      expect([table, amount, rows]).toEqual([
        table,
        amount,
        [
          {
            type: 'numeric(19,4)',
            currencyType: 'character(3)',
            key: `FOREIGN KEY (${currency}) REFERENCES currency_definitions(code) ON UPDATE RESTRICT ON DELETE RESTRICT`,
          },
        ],
      ]);
    }
    const { rows: enums } = await app.query(
      "SELECT FROM pg_type WHERE typname = 'currency' AND typnamespace = current_schema()::regnamespace",
    );
    expect(enums).toEqual([]);

    // A JOD price keeps its three decimals through PostgreSQL, and another
    // tenant's KWD price its own, exactly.
    for (const [tenant, price] of [
      [a, Money.parse('1250.125', 'JOD')],
      [b, Money.parse('0.875', 'KWD')],
    ] as const) {
      const stored = await asTenant(tenant.id, (tx) =>
        tx.training.create({
          data: {
            tenantId: tenant.id,
            title: 'Test programme',
            startDate: new Date('2026-09-01T00:00:00Z'),
            endDate: new Date('2026-09-30T00:00:00Z'),
            price: price.toDecimal(),
            currency: price.currency,
          },
          select: { price: true, currency: true },
        }),
      );
      expect(
        Money.fromDatabase(stored.price!, stored.currency).toWire(),
      ).toEqual(price.toWire());
    }

    // A payment carries its own currency, a real one, whenever it has an amount.
    const player = await createPlayer(a);
    const training = await asTenant(a.id, (tx) =>
      tx.training.create({
        data: {
          tenantId: a.id,
          title: 'Paid programme',
          startDate: new Date('2026-10-01T00:00:00Z'),
          endDate: new Date('2026-10-31T00:00:00Z'),
        },
      }),
    );
    const pay = async (amount: string | null, currency: string | null) => {
      await app.query('BEGIN');
      try {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [a.id]);
        await app.query(
          `INSERT INTO enrollments (id, tenant_id, training_id, player_id, paid_amount, paid_currency, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [randomUUID(), a.id, training.id, player.id, amount, currency],
        );
        return 'succeeded';
      } catch (error) {
        const { code, constraint } = error as DatabaseError;
        return { code, constraint };
      } finally {
        await app.query('ROLLBACK');
      }
    };
    expect(await pay('50.000', null)).toEqual({
      code: '23514',
      constraint: 'enrollments_paid_currency_check',
    });
    expect(await pay('50.00', 'XAU')).toEqual({
      code: '23503',
      constraint: 'enrollments_paid_currency_fkey',
    });
    expect(await pay('50.000', 'JOD')).toBe('succeeded');
    expect(await pay(null, null)).toBe('succeeded');
  });
});
