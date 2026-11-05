import { randomUUID } from 'node:crypto';
import type { Tenant } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
} from 'vitest';
import {
  civilDateFromDatabase,
  civilDateToDatabase,
  parseCivilDate,
} from '../../src/common/time/civil-date';
import { isTimeZone } from '../../src/common/time/time-zone';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { asTenant, createTenant } from '../harness/fixtures';

// Calendar dates, instants and time zones (0.4.8; ADR-0007), as the runtime
// role. The two zones furthest apart: Honolulu is UTC−10, Kiritimati UTC+14.
const WEST = 'Pacific/Honolulu';
const EAST = 'Pacific/Kiritimati';

/** The civil columns: a day, whatever the reader's zone. */
const CIVIL_COLUMNS = [
  'attendance.date',
  'contracts.end_date',
  'contracts.start_date',
  'contracts.termination_date',
  'legal_tickets.due_date',
  'medical_records.injury_date',
  'medical_records.recovery_date',
  'medical_records.return_to_play_date',
  'performance_records.match_date',
  'players.date_of_birth',
  'players.passport_expiry',
  'scouting_assignments.due_date',
  'scouting_reports.report_date',
  'seasons.end_date',
  'seasons.start_date',
  'training_sessions.date',
  'trainings.end_date',
  'trainings.start_date',
  'treatment_sessions.session_date',
  'users.employment_end_date',
  'users.employment_start_date',
];

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

describe('dates, instants and time zones', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  const processZone = process.env.TZ;

  /** One statement as `tenant`, in a session whose zone is `zone`. */
  async function as<T extends Record<string, unknown>>(
    tenant: Tenant,
    zone: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[] | { code?: string; message: string; constraint?: string }> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant.id,
      ]);
      await app.query("SELECT set_config('TimeZone', $1, true)", [zone]);
      const { rows } = await app.query<T>(sql, params);
      await app.query('COMMIT');
      return rows;
    } catch (error) {
      await app.query('ROLLBACK');
      const { code, message, constraint } = error as DatabaseError;
      return { code, message, constraint };
    }
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterEach(() => {
    process.env.TZ = processZone;
  });

  afterAll(async () => {
    await app?.end();
  });

  it('a_birth_date_is_the_same_day_in_every_timezone', async () => {
    const { rows: civil } = await app.query<{ column: string }>(
      `SELECT c.relname || '.' || a.attname AS column
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
          AND a.atttypid = 'date'::regtype AND NOT a.attisdropped
        ORDER BY 1`,
    );
    expect(civil.map((row) => row.column)).toEqual(CIVIL_COLUMNS);

    // Written in UTC−10 and read in UTC+14, and the other way round: a day
    // that moved with either zone would show here.
    for (const [tenant, birthday, writer, reader] of [
      [a, '1998-05-12', WEST, EAST],
      [b, '2000-02-29', EAST, WEST],
    ] as const) {
      process.env.TZ = writer;
      const { id } = await asTenant(tenant.id, (tx) =>
        tx.player.create({
          data: {
            tenantId: tenant.id,
            fullName: `Test Player ${randomUUID()}`,
            dateOfBirth: civilDateToDatabase(parseCivilDate(birthday)),
          },
        }),
      );
      process.env.TZ = reader;
      const read = await asTenant(tenant.id, (tx) =>
        tx.player.findUniqueOrThrow({
          where: { id },
          select: { dateOfBirth: true },
        }),
      );
      expect(civilDateFromDatabase(read.dateOfBirth!)).toBe(birthday);
      // And PostgreSQL says the same day in either zone.
      for (const zone of [WEST, EAST]) {
        expect(
          await as(
            tenant,
            zone,
            'SELECT date_of_birth::text AS day FROM players WHERE id = $1',
            [id],
          ),
        ).toEqual([{ day: birthday }]);
      }
    }
  });

  it('instants_round_trip_in_utc', async () => {
    // No column keeps a timestamp without its zone; every instant is
    // timestamptz(3).
    const { rows: types } = await app.query<{ type: string; columns: number }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type, count(*)::int AS columns
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'
          AND c.relname <> '_prisma_migrations' AND NOT a.attisdropped
          AND a.atttypid IN ('timestamp'::regtype, 'timestamptz'::regtype)
        GROUP BY 1`,
    );
    expect(types).toEqual([
      { type: 'timestamp(3) with time zone', columns: 99 },
    ]);

    const instant = '2026-11-04T23:30:00.123Z';
    process.env.TZ = WEST;
    const { id } = await asTenant(a.id, (tx) =>
      tx.player.create({
        data: {
          tenantId: a.id,
          fullName: `Test Player ${randomUUID()}`,
          createdAt: new Date(instant),
        },
      }),
    );
    process.env.TZ = EAST;
    const read = await asTenant(a.id, (tx) =>
      tx.player.findUniqueOrThrow({
        where: { id },
        select: { createdAt: true },
      }),
    );
    expect(read.createdAt.toISOString()).toBe(instant);
    // Shown in each session's zone, it is one instant.
    expect(
      await as(
        a,
        'Asia/Amman',
        `SELECT created_at::text AS shown, extract(epoch FROM created_at)::text AS epoch
           FROM players WHERE id = $1`,
        [id],
      ),
    ).toEqual([
      {
        shown: '2026-11-05 02:30:00.123+03',
        epoch: (Date.parse(instant) / 1000).toFixed(6),
      },
    ]);
    expect(
      await as(
        a,
        'UTC',
        'SELECT created_at::text AS shown FROM players WHERE id = $1',
        [id],
      ),
    ).toEqual([{ shown: '2026-11-04 23:30:00.123+00' }]);

    // A session starts and ends at instants, and keeps the zone its wall
    // times are in: 18:00 in Amman, whoever reads it.
    const training = await asTenant(b.id, (tx) =>
      tx.training.create({
        data: {
          tenantId: b.id,
          title: 'Test programme',
          startDate: civilDateToDatabase(parseCivilDate('2026-11-01')),
          endDate: civilDateToDatabase(parseCivilDate('2026-11-30')),
        },
      }),
    );
    const session = await asTenant(b.id, (tx) =>
      tx.trainingSession.create({
        data: {
          tenantId: b.id,
          trainingId: training.id,
          date: civilDateToDatabase(parseCivilDate('2026-11-05')),
          startsAt: new Date('2026-11-05T15:00:00Z'),
          endsAt: new Date('2026-11-05T16:30:00Z'),
          timeZone: 'Asia/Amman',
        },
      }),
    );
    expect(
      await as(
        b,
        EAST,
        `SELECT (starts_at AT TIME ZONE time_zone)::text AS starts, (ends_at AT TIME ZONE time_zone)::text AS ends
           FROM training_sessions WHERE id = $1`,
        [session.id],
      ),
    ).toEqual([{ starts: '2026-11-05 18:00:00', ends: '2026-11-05 19:30:00' }]);
  });

  it('an_invalid_tenant_timezone_is_refused', async () => {
    // A new tenant starts in UTC, in Arabic, in dinars.
    expect(
      await as(
        a,
        'UTC',
        'SELECT timezone, default_locale::text AS locale, default_currency AS currency FROM tenants',
      ),
    ).toEqual([{ timezone: 'UTC', locale: 'ar', currency: 'JOD' }]);

    const setZone = (zone: string) =>
      as(
        a,
        'UTC',
        'UPDATE tenants SET timezone = $1 WHERE id = $2 RETURNING timezone',
        [zone, a.id],
      );
    for (const zone of ['Mars/Olympus', 'asia/amman', '+03:00', 'UTC+3', '']) {
      // The application's check and the database's agree.
      expect([zone, isTimeZone(zone)]).toEqual([zone, false]);
      expect([zone, await setZone(zone)]).toEqual([
        zone,
        {
          code: '22023',
          message: 'tenants.timezone is not an IANA time zone',
          constraint: undefined,
        },
      ]);
    }
    expect(await setZone('Asia/Amman')).toEqual([{ timezone: 'Asia/Amman' }]);
    expect(await setZone('UTC')).toEqual([{ timezone: 'UTC' }]);

    // A session's zone is held to the same rule.
    const training = await asTenant(a.id, (tx) =>
      tx.training.create({
        data: {
          tenantId: a.id,
          title: 'Test programme',
          startDate: civilDateToDatabase(parseCivilDate('2026-11-01')),
          endDate: civilDateToDatabase(parseCivilDate('2026-11-30')),
        },
      }),
    );
    expect(
      await as(
        a,
        'UTC',
        `INSERT INTO training_sessions (id, tenant_id, training_id, date, time_zone, updated_at)
         VALUES ($1, $2, $3, '2026-11-05', 'Mars/Olympus', now())`,
        [randomUUID(), a.id, training.id],
      ),
    ).toMatchObject({
      code: '22023',
      message: 'training_sessions.time_zone is not an IANA time zone',
    });

    // The zone, the locale and the currency are typed: the settings JSON
    // cannot hold them any longer.
    for (const key of ['timezone', 'defaultLocale', 'defaultCurrency']) {
      expect(
        await as(
          a,
          'UTC',
          'UPDATE tenants SET settings = jsonb_build_object($1::text, $2::text) WHERE id = $3',
          [key, 'Asia/Amman', a.id],
        ),
      ).toMatchObject({ code: '23514', constraint: 'tenants_settings_check' });
    }
  });
});
