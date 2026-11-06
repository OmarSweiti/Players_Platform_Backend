import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { Prisma, type Tenant } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PROSE_MAX } from '../../src/common/validation/schemas';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  INTEGRITY_CHECKS,
  METADATA_BYTES,
  SNAPSHOT_BYTES,
  type IntegrityCheck,
} from '../../scripts/integrity-checks';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
} from '../harness/fixtures';

// Integrity constraints in SQL (0.4.10; SR-DB-007), in raw SQL as the runtime
// role, on two tenants: each rule refuses its counter-example, and the catalog
// holds exactly the rules scripts/integrity-checks.ts lists. Every value is
// synthetic.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

/**
 * The CHECKs other steps add in their own migrations, each proved by that
 * step's own test; this one leaves them as they are.
 */
const OTHER_STEPS_CHECKS = [
  'currency_definitions_code_check',
  'currency_definitions_minor_unit_exponent_check',
  'enrollments_paid_currency_check',
  'users_normalized_email_check',
  // 0.5.3: test/db/identity.integration-spec.ts
  'identities_issuer_check',
  'identities_subject_check',
  'user_sessions_revision_check',
  'user_sessions_revocation_check',
  'user_sessions_times_check',
  'user_sessions_token_hash_check',
  // 0.5.10: test/db/invitations.integration-spec.ts
  'invitations_acceptance_check',
  'invitations_closed_once_check',
  'invitations_expiry_check',
  'invitations_normalized_email_check',
  'invitations_role_check',
  'invitations_token_check',
  'invitations_token_hash_check',
];

/** Each amount, its currency, and the trigger that holds it to the currency's minor units. */
const AMOUNTS = [
  [
    'contracts',
    'salary_amount',
    'salary_currency',
    'contracts_amounts_within_currency',
  ],
  [
    'contracts',
    'signing_fee',
    'salary_currency',
    'contracts_amounts_within_currency',
  ],
  [
    'enrollments',
    'paid_amount',
    'paid_currency',
    'enrollments_paid_amount_within_currency',
  ],
  ['trainings', 'price', 'currency', 'trainings_price_within_currency'],
] as const;

/** The partial unique indexes, as PostgreSQL prints them. */
const PARTIAL_UNIQUES = {
  player_media_tenant_id_player_id_featured_key:
    'CREATE UNIQUE INDEX player_media_tenant_id_player_id_featured_key ON player_media USING btree (tenant_id, player_id) WHERE (is_featured AND (deleted_at IS NULL))',
  seasons_tenant_id_current_key:
    'CREATE UNIQUE INDEX seasons_tenant_id_current_key ON seasons USING btree (tenant_id) WHERE (is_current AND (deleted_at IS NULL))',
  seasons_tenant_id_name_key:
    'CREATE UNIQUE INDEX seasons_tenant_id_name_key ON seasons USING btree (tenant_id, name) WHERE (deleted_at IS NULL)',
  // 0.5.10: one open invitation per address (test/db/invitations.integration-spec.ts)
  invitations_open_address_key:
    'CREATE UNIQUE INDEX invitations_open_address_key ON invitations USING btree (tenant_id, normalized_email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL))',
};

/** Column → SQL expression: the values one statement writes. */
type Values = Record<string, string>;

const NAN = "'NaN'";
const below = (column: string, value: string) => ({ [column]: value });

/** Counter-examples to each hand-written rule: every one breaks that rule alone. */
const BREAKS: Record<string, Values[]> = {
  contract_approvals_step_order_check: [{ step_order: '0' }],
  contract_versions_version_check: [{ version: '0' }],
  performance_records_shots_on_target_check: [
    { shots_on_target: '-1' },
    { shots: '2', shots_on_target: '3' },
  ],
  scouting_assignments_ages_check: [{ min_age: '20', max_age: '18' }],
  players_height_check: [
    { height: '0' },
    { height: '-180' },
    { height: NAN },
    { height: "'Infinity'" },
  ],
  players_weight_check: [
    { weight: '0' },
    { weight: NAN },
    { weight: "'Infinity'" },
  ],
  performance_records_pass_accuracy_check: [
    { pass_accuracy: '100.01' },
    { pass_accuracy: '-0.01' },
    { pass_accuracy: NAN },
  ],
  contracts_salary_period_check: [{ salary_period: 'NULL' }],
  enrollments_paid_amount_check: [
    { paid_amount: '-0.001', paid_currency: "'JOD'" },
    { paid_amount: NAN, paid_currency: "'JOD'" },
  ],
  contracts_dates_check: [{ end_date: 'start_date - 1' }],
  seasons_dates_check: [{ end_date: 'start_date - 1' }],
  trainings_dates_check: [{ end_date: 'start_date - 1' }],
  training_sessions_times_check: [
    {
      starts_at: "'2026-11-05T16:00:00Z'",
      ends_at: "'2026-11-05T15:59:59.999Z'",
    },
  ],
  medical_records_dates_check: [
    { injury_date: "'2026-05-10'", recovery_date: "'2026-05-09'" },
    { injury_date: "'2026-05-10'", return_to_play_date: "'2026-05-09'" },
  ],
  users_employment_dates_check: [
    {
      employment_start_date: "'2026-05-10'",
      employment_end_date: "'2026-05-09'",
    },
  ],
  tenants_settings_check: [{ settings: `'{"timezone": "Asia/Amman"}'` }],
  tenants_slug_check: [
    "'Agency'",
    "'-agency'",
    "'agency-'",
    "'agency.one'",
    "'agency_one'",
    "'وكالة'",
    "repeat('a', 64)",
  ].map((slug) => ({ slug })),
  tenants_domain_check: [
    "'Agency.test'",
    "'agency.test.'",
    "'agency..test'",
    "'-agency.test'",
    "'agency_one.test'",
    "'وكالة.test'",
    "repeat('a.', 125) || 'test'", // 254 characters: one past a DNS name's 253
  ].map((domain) => ({ domain })),
};

/**
 * The counter-examples to `check`: the hand-written ones, else those its kind
 * implies (a count, a finite amount, a scale, prose, JSON).
 */
function breaks({ name, table, holds }: IntegrityCheck): Values[] {
  const listed = BREAKS[name];
  const column = name.slice(table.length + 1, -'_check'.length);
  const json =
    /^jsonb_typeof\(\w+\) = '(object|array)' AND octet_length\(\w+::text\) <= (\d+)/.exec(
      holds,
    );
  if (json) {
    const [, shape, bytes] = json;
    const oversized =
      shape === 'object'
        ? `jsonb_build_object('k', repeat('x', ${bytes}))`
        : `jsonb_build_array(repeat('x', ${bytes}))`;
    return [
      ...(listed ?? []),
      below(column, shape === 'object' ? `'[]'` : `'{}'`),
      below(column, `'"a string"'`),
      below(column, `'null'`),
      below(column, oversized),
    ];
  }
  if (listed) return listed;
  if (holds === `char_length(${column}) <= ${PROSE_MAX}`) {
    return [below(column, `repeat('x', ${PROSE_MAX + 1})`)];
  }
  if (holds === `${column} >= 0`) return [below(column, '-1')];
  if (holds === `${column} >= 0 AND ${column} <> 'NaN'`) {
    return [below(column, '-1'), below(column, NAN)];
  }
  if (holds === `${column} BETWEEN 1 AND 10`) {
    return [below(column, '0.9'), below(column, '10.1'), below(column, NAN)];
  }
  throw new Error(`no counter-example to ${name}`);
}

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

type Outcome<T> = T[] | { code?: string; constraint?: string };

describe('integrity constraints in SQL', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  /** One row of tenant A in each table a rule is on: table → id. */
  let rowOf: Record<string, string>;

  /** One statement as `tenant`, rolled back whatever it did: what it returned, or why it failed. */
  async function attempt<T extends Record<string, unknown>>(
    tenant: Tenant,
    sql: string,
    params: unknown[] = [],
    commit = false,
  ): Promise<Outcome<T>> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant.id,
      ]);
      const { rows } = await app.query<T>(sql, params);
      await app.query(commit ? 'COMMIT' : 'ROLLBACK');
      return rows;
    } catch (error) {
      await app.query('ROLLBACK');
      const { code, constraint } = error as DatabaseError;
      return { code, constraint };
    }
  }

  /**
   * Writes `values` to tenant A's row of `table`, and rolls it back. Audit is
   * appended, never updated, so its counter-examples are new rows.
   */
  function write(table: string, values: Values) {
    const columns = Object.keys(values);
    const expressions = Object.values(values);
    if (table === 'audit_logs') {
      return attempt(
        a,
        `INSERT INTO audit_logs (id, tenant_id, action, entity_type, entity_id, ${columns.join(', ')})
         VALUES (gen_random_uuid(), $1, 'test.probe', 'Player', gen_random_uuid(), ${expressions.join(', ')})
         RETURNING tenant_id AS id`,
        [a.id],
      );
    }
    const set = columns.map((c, i) => `${c} = ${expressions[i]}`).join(', ');
    return attempt(a, `UPDATE ${table} SET ${set} WHERE id = $1 RETURNING id`, [
      rowOf[table],
    ]);
  }

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
    const [member, player] = [
      await createMember(a, 'ADMIN'),
      await createPlayer(a),
    ];
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    rowOf = await asTenant(a.id, async (tx) => {
      const tenantId = a.id;
      const season = await tx.season.create({
        data: {
          tenantId,
          name: `Season ${randomUUID()}`,
          startDate: day('2026-08-01'),
          endDate: day('2027-05-31'),
        },
      });
      // A salary in dinars: what the exponent guard below finds in use.
      const contract = await tx.contract.create({
        data: {
          tenantId,
          playerId: player.id,
          createdById: member.id,
          title: 'Test contract',
          startDate: day('2026-08-01'),
          endDate: day('2028-06-30'),
          salaryAmount: new Prisma.Decimal('1000.125'),
          salaryCurrency: 'JOD',
          salaryPeriod: 'MONTHLY',
        },
      });
      const training = await tx.training.create({
        data: {
          tenantId,
          title: 'Test programme',
          startDate: day('2026-11-01'),
          endDate: day('2026-11-30'),
        },
      });
      const conversation = await tx.conversation.create({
        data: { tenantId },
      });
      const ticket = await tx.legalTicket.create({
        data: {
          tenantId,
          playerId: player.id,
          createdById: member.id,
          subject: 'Test ticket',
          description: 'A synthetic ticket',
        },
      });
      const record = await tx.medicalRecord.create({
        data: {
          tenantId,
          playerId: player.id,
          createdById: member.id,
          injuryType: 'Test injury',
        },
      });
      const created = {
        tenants: a.id,
        users: member.id,
        players: player.id,
        seasons: season.id,
        contracts: contract.id,
        trainings: training.id,
        legal_tickets: ticket.id,
        medical_records: record.id,
        contract_versions: (
          await tx.contractVersion.create({
            data: {
              tenantId,
              contractId: contract.id,
              createdById: member.id,
              version: 1,
              fileUrl: 'objects/test-version',
            },
          })
        ).id,
        contract_approvals: (
          await tx.contractApproval.create({
            data: {
              tenantId,
              contractId: contract.id,
              approvedById: member.id,
            },
          })
        ).id,
        documents: (
          await tx.document.create({
            data: {
              tenantId,
              entityType: 'PLAYER',
              entityId: player.id,
              fileUrl: 'objects/test-document',
              fileName: 'test-document.pdf',
            },
          })
        ).id,
        messages: (
          await tx.message.create({
            data: {
              tenantId,
              conversationId: conversation.id,
              senderId: member.id,
              type: 'TEXT',
              content: 'A synthetic message',
            },
          })
        ).id,
        player_media: (
          await tx.playerMedia.create({
            data: {
              tenantId,
              playerId: player.id,
              fileUrl: 'objects/test-media',
            },
          })
        ).id,
        performance_records: (
          await tx.performanceRecord.create({
            data: {
              tenantId,
              playerId: player.id,
              matchDate: day('2026-09-12'),
            },
          })
        ).id,
        ratings: (
          await tx.rating.create({
            data: {
              tenantId,
              playerId: player.id,
              createdById: member.id,
              technicalScore: new Prisma.Decimal('7.5'),
              physicalScore: new Prisma.Decimal('8'),
              mentalScore: new Prisma.Decimal('6.5'),
              totalScore: new Prisma.Decimal('7.33'),
            },
          })
        ).id,
        scouting_assignments: (
          await tx.scoutingAssignment.create({
            data: {
              tenantId,
              assignedToId: member.id,
              assignedById: member.id,
            },
          })
        ).id,
        scouting_reports: (
          await tx.scoutingReport.create({
            data: {
              tenantId,
              scoutId: member.id,
              reportDate: day('2026-10-03'),
            },
          })
        ).id,
        player_watchlists: (
          await tx.playerWatchlist.create({
            data: { tenantId, userId: member.id, playerId: player.id },
          })
        ).id,
        notifications: (
          await tx.notification.create({
            data: {
              tenantId,
              userId: member.id,
              type: 'CONTRACT_EXPIRING',
              content: 'A synthetic notification',
            },
          })
        ).id,
        legal_notes: (
          await tx.legalNote.create({
            data: {
              tenantId,
              ticketId: ticket.id,
              createdById: member.id,
              note: 'A synthetic note',
            },
          })
        ).id,
        training_sessions: (
          await tx.trainingSession.create({
            data: {
              tenantId,
              trainingId: training.id,
              date: day('2026-11-05'),
              timeZone: 'Asia/Amman',
            },
          })
        ).id,
        enrollments: (
          await tx.enrollment.create({
            data: { tenantId, trainingId: training.id, playerId: player.id },
          })
        ).id,
        treatment_sessions: (
          await tx.treatmentSession.create({
            data: {
              tenantId,
              playerId: player.id,
              medicalRecordId: record.id,
              conductedBy: member.id,
              sessionDate: day('2026-09-20'),
              treatmentType: 'Physiotherapy',
            },
          })
        ).id,
      };
      return created;
    });
  });

  afterAll(async () => {
    await app?.end();
  });

  it('impossible_values_are_refused_by_the_database', async () => {
    // Every CHECK refuses each of its counter-examples, by name.
    const seen: unknown[] = [];
    const wanted: unknown[] = [];
    for (const check of INTEGRITY_CHECKS) {
      for (const values of breaks(check)) {
        seen.push([check.name, values, await write(check.table, values)]);
        wanted.push([
          check.name,
          values,
          { code: CHECK_VIOLATION, constraint: check.name },
        ]);
      }
    }
    expect(seen).toEqual(wanted);

    // An amount finer than its currency's minor units: JOD has three
    // decimals, USD two, JPY none.
    const refusedAmounts: Array<[string, Values, string]> = [
      [
        'contracts',
        { salary_amount: '1000.1255' },
        'contracts_amounts_within_currency',
      ],
      [
        'contracts',
        { salary_currency: "'USD'" },
        'contracts_amounts_within_currency',
      ],
      [
        'contracts',
        { signing_fee: '250.0001' },
        'contracts_amounts_within_currency',
      ],
      [
        'trainings',
        { price: '5.5', currency: "'JPY'" },
        'trainings_price_within_currency',
      ],
      [
        'enrollments',
        { paid_amount: '10.555', paid_currency: "'USD'" },
        'enrollments_paid_amount_within_currency',
      ],
    ];
    for (const [table, values, trigger] of refusedAmounts) {
      expect([values, await write(table, values)]).toEqual([
        values,
        { code: CHECK_VIOLATION, constraint: trigger },
      ]);
    }

    // The edges themselves are allowed.
    const allowed: Array<[string, Values]> = [
      [
        'contracts',
        { salary_amount: '0', signing_fee: '250.125', end_date: 'start_date' },
      ],
      ['contracts', { salary_amount: '10.55', salary_currency: "'USD'" }],
      ['contracts', { salary_amount: 'NULL', salary_period: 'NULL' }],
      [
        'trainings',
        {
          price: '5',
          currency: "'JPY'",
          capacity: '0',
          end_date: 'start_date',
        },
      ],
      ['enrollments', { paid_amount: '0.875', paid_currency: "'KWD'" }],
      [
        'performance_records',
        {
          pass_accuracy: '100',
          shots: '3',
          shots_on_target: '3',
          rating: '0',
          minutes_played: '0',
        },
      ],
      ['performance_records', { pass_accuracy: '0' }],
      [
        'scouting_reports',
        Object.fromEntries(
          [
            'technical_score',
            'physical_score',
            'tactical_score',
            'mental_score',
            'overall_rating',
            'potential_rating',
          ].map((c) => [c, '1']),
        ),
      ],
      [
        'scouting_reports',
        { overall_rating: '10', potential_rating: '10', prospect_age: '0' },
      ],
      ['scouting_assignments', { min_age: '18', max_age: '18' }],
      ['players', { height: '0.1', weight: '0.1', jersey_number: '0' }],
      ['seasons', { end_date: 'start_date' }],
      [
        'training_sessions',
        {
          starts_at: "'2026-11-05T15:00:00Z'",
          ends_at: "'2026-11-05T15:00:00Z'",
        },
      ],
      [
        'medical_records',
        {
          injury_date: "'2026-05-10'",
          recovery_date: "'2026-05-10'",
          return_to_play_date: "'2026-05-10'",
        },
      ],
      // Prose is counted in characters: Arabic, two bytes each, is no shorter.
      ['players', { bio: `repeat('x', ${PROSE_MAX})` }],
      ['players', { bio: `repeat('ب', ${PROSE_MAX})` }],
      // JSON to its last byte: {"k": "…"} is 9 bytes besides its value.
      [
        'players',
        {
          metadata: `jsonb_build_object('k', repeat('x', ${METADATA_BYTES - 9}))`,
        },
      ],
      [
        'users',
        { certifications: `'[{"name": "UEFA B"}]'`, preferences: `'{}'` },
      ],
      [
        'audit_logs',
        {
          new_values: `jsonb_build_object('k', repeat('x', ${SNAPSHOT_BYTES - 9}))`,
        },
      ],
      ['tenants', { slug: `repeat('a', 63)` }],
      // An Arabic domain, in the punycode a Host header carries.
      [
        'tenants',
        {
          slug: "'a'",
          domain: `'${domainToASCII(`وكالة.${randomUUID().slice(0, 8)}.test`)}'`,
        },
      ],
    ];
    for (const [table, values] of allowed) {
      expect([table, values, await write(table, values)]).toEqual([
        table,
        values,
        [{ id: table === 'audit_logs' ? a.id : rowOf[table] }],
      ]);
    }
  });

  it('a_tenant_has_at_most_one_current_season', async () => {
    const season = (tenant: Tenant, name: string, current: boolean) =>
      attempt(
        tenant,
        `INSERT INTO seasons (id, tenant_id, name, start_date, end_date, is_current, updated_at)
         VALUES (gen_random_uuid(), $1, $2, '2026-08-01', '2027-05-31', $3, now())
         RETURNING name`,
        [tenant.id, name, current],
        true,
      );
    const [first, second, third] = ['2026/27', '2027/28', '2028/29'].map(
      (year) => `${year} ${randomUUID().slice(0, 8)}`,
    );

    expect(await season(a, first, true)).toEqual([{ name: first }]);
    expect(await season(a, second, true)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'seasons_tenant_id_current_key',
    });
    // Seasons that are not current, and another tenant's current one, are free.
    expect(await season(a, second, false)).toEqual([{ name: second }]);
    expect(await season(b, first, true)).toEqual([{ name: first }]);

    // Live seasons are unique by name within their tenant.
    expect(await season(a, second, false)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'seasons_tenant_id_name_key',
    });

    // An archived season neither counts as current nor holds its name.
    expect(
      await attempt(
        a,
        `UPDATE seasons SET deleted_at = now() WHERE name = $1 RETURNING name`,
        [first],
        true,
      ),
    ).toEqual([{ name: first }]);
    expect(await season(a, first, true)).toEqual([{ name: first }]);

    // Two writers racing to make a season current: the second waits for the
    // first, then is refused.
    const [one, two] = [
      await connect(inject('databaseUrl')),
      await connect(inject('databaseUrl')),
    ];
    try {
      const insert = (client: Client, name: string) =>
        client.query(
          `INSERT INTO seasons (id, tenant_id, name, start_date, end_date, is_current, updated_at)
           VALUES (gen_random_uuid(), $1, $2, '2026-08-01', '2027-05-31', true, now())`,
          [b.id, name],
        );
      for (const client of [one, two]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          b.id,
        ]);
      }
      await one.query(
        'UPDATE seasons SET is_current = false WHERE tenant_id = $1',
        [b.id],
      );
      await insert(one, second);
      const racing = insert(two, third).then(
        () => 'inserted',
        (error: DatabaseError) => ({
          code: error.code,
          constraint: error.constraint,
        }),
      );
      await one.query('COMMIT');
      expect(await racing).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'seasons_tenant_id_current_key',
      });
      await two.query('ROLLBACK');
    } finally {
      await Promise.all([one.end(), two.end()]);
    }
    expect(
      await attempt(
        b,
        'SELECT name FROM seasons WHERE is_current AND deleted_at IS NULL',
      ),
    ).toEqual([{ name: second }]);
  });

  it('legal_notes_are_internal_by_default', async () => {
    // Written without saying, raw or through Prisma, a note is internal.
    expect(
      await attempt(
        a,
        `INSERT INTO legal_notes (id, tenant_id, ticket_id, created_by_id, note, updated_at)
         SELECT gen_random_uuid(), tenant_id, ticket_id, created_by_id, 'A synthetic note', now()
           FROM legal_notes WHERE id = $1
         RETURNING is_internal`,
        [rowOf.legal_notes],
      ),
    ).toEqual([{ is_internal: true }]);
    const viaPrisma = await asTenant(a.id, (tx) =>
      tx.legalNote.findUniqueOrThrow({
        where: { id: rowOf.legal_notes },
        select: { isInternal: true },
      }),
    );
    expect(viaPrisma).toEqual({ isInternal: true });

    // Shared only when its author says so.
    const shared = await asTenant(a.id, async (tx) => {
      const { ticketId, createdById } = await tx.legalNote.findUniqueOrThrow({
        where: { id: rowOf.legal_notes },
      });
      return tx.legalNote.create({
        data: {
          tenantId: a.id,
          ticketId,
          createdById,
          note: 'A note for the requester',
          isInternal: false,
        },
        select: { isInternal: true },
      });
    });
    expect(shared).toEqual({ isInternal: false });
  });

  it('a_player_has_at_most_one_featured_image', async () => {
    const [player, other, ofB] = [
      await createPlayer(a),
      await createPlayer(a),
      await createPlayer(b),
    ];
    const image = (tenant: Tenant, playerId: string, featured: boolean) =>
      attempt<{ id: string }>(
        tenant,
        `INSERT INTO player_media (id, tenant_id, player_id, file_url, is_featured, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'objects/test-image', $3, now())
         RETURNING id`,
        [tenant.id, playerId, featured],
        true,
      );
    const featured = (await image(a, player.id, true)) as Array<{ id: string }>;
    expect(await image(a, player.id, true)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: 'player_media_tenant_id_player_id_featured_key',
    });
    // Images that are not featured, another player's and another tenant's are free.
    expect(await image(a, player.id, false)).toHaveLength(1);
    expect(await image(a, other.id, true)).toHaveLength(1);
    expect(await image(b, ofB.id, true)).toHaveLength(1);
    // Archived, the featured image gives the place up.
    await attempt(
      a,
      'UPDATE player_media SET deleted_at = now() WHERE id = $1',
      [featured[0].id],
      true,
    );
    expect(await image(a, player.id, true)).toHaveLength(1);
  });

  it('a_currency_exponent_cannot_change_under_amounts', async () => {
    // As the migrator, the only role that can edit a currency; rolled back.
    const migrator = await connect(inject('migrationDatabaseUrl'));
    const setExponent = async (code: string, exponent: number) => {
      await migrator.query('BEGIN');
      try {
        const { rows } = await migrator.query<{ code: string }>(
          'UPDATE currency_definitions SET minor_unit_exponent = $2 WHERE code = $1 RETURNING code',
          [code, exponent],
        );
        return rows;
      } catch (error) {
        const { code: sqlState, message } = error as DatabaseError;
        return { code: sqlState, message };
      } finally {
        await migrator.query('ROLLBACK');
      }
    };
    try {
      // Tenant A holds a salary in dinars.
      expect(await setExponent('JOD', 2)).toEqual({
        code: RESTRICT_VIOLATION,
        message:
          'the minor units of JOD cannot change while contracts.salary_amount holds amounts in it',
      });
      // No test writes amounts in Omani rials.
      expect(await setExponent('OMR', 2)).toEqual([{ code: 'OMR' }]);
    } finally {
      await migrator.end();
    }
  });

  it('the_catalog_holds_every_integrity_constraint_by_name', async () => {
    const schema = inject('databaseSchema');
    const migrator = await connect(inject('migrationDatabaseUrl'));
    try {
      // Every CHECK, by name: this step's list and the other steps' own.
      const { rows: checks } = await migrator.query<{
        name: string;
        table: string;
        definition: string;
      }>(
        `SELECT conname AS name, conrelid::regclass::text AS table,
                pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE contype = 'c' AND connamespace = $1::regnamespace
          ORDER BY conname`,
        [schema],
      );
      expect(checks.map((c) => c.name)).toEqual(
        [...INTEGRITY_CHECKS.map((c) => c.name), ...OTHER_STEPS_CHECKS].sort(),
      );

      // Each as the list words it: the catalog's definition is the one
      // PostgreSQL makes of the listed condition on a probe of its table.
      await migrator.query('BEGIN');
      try {
        for (const [i, check] of INTEGRITY_CHECKS.entries()) {
          await migrator.query(
            `CREATE TABLE probe_${i} (LIKE ${check.table});
             ALTER TABLE probe_${i} ADD CONSTRAINT probe_${i}_check CHECK (${check.holds})`,
          );
          const { rows } = await migrator.query<{ definition: string }>(
            `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
              WHERE conname = $1 AND connamespace = $2::regnamespace`,
            [`probe_${i}_check`, schema],
          );
          expect([check.name, rows[0].definition]).toEqual([
            check.name,
            checks.find((c) => c.name === check.name)?.definition,
          ]);
        }
      } finally {
        await migrator.query('ROLLBACK');
      }

      // Every prose column is bounded, but the two IANA zones, which a trigger
      // holds to pg_timezone_names; every JSON column has its shape and size.
      const columnsOf = async (type: string) =>
        (
          await migrator.query<{ column: string }>(
            `SELECT c.relname || '.' || a.attname AS column
               FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'
                AND c.relname <> '_prisma_migrations' AND a.attnum > 0
                AND NOT a.attisdropped AND a.atttypid = $2::regtype
              ORDER BY 1`,
            [schema, type],
          )
        ).rows.map((row) => row.column);
      const checked = (kind: RegExp) =>
        INTEGRITY_CHECKS.filter((c) => kind.test(c.holds))
          .map((c) => `${c.table}.${c.name.slice(c.table.length + 1, -6)}`)
          .sort();
      expect(await columnsOf('text')).toEqual(
        [
          ...checked(/^char_length\(\w+\) <= \d+$/),
          'tenants.timezone',
          'training_sessions.time_zone',
        ].sort(),
      );
      expect(await columnsOf('jsonb')).toEqual(checked(/^jsonb_typeof/));

      // Every amount is held to its currency's minor units by a constraint
      // trigger, which the exponent guard finds it by.
      const { rows: triggers } = await migrator.query<{
        name: string;
        table: string;
        args: string[];
      }>(
        `SELECT t.tgname AS name, t.tgrelid::regclass::text AS table,
                (string_to_array(encode(t.tgargs, 'escape'), E'\\\\000'))[1:t.tgnargs] AS args
           FROM pg_trigger t JOIN pg_constraint k ON k.oid = t.tgconstraint
          WHERE k.contype = 't' AND k.connamespace = $1::regnamespace
            AND t.tgfoid = 'refuse_amount_beyond_currency'::regproc
          ORDER BY 1`,
        [schema],
      );
      expect(
        triggers.flatMap(({ name, table, args }) =>
          args
            .filter((_, i) => i % 2 === 0)
            .map((amount, i) => [table, amount, args[2 * i + 1], name]),
        ),
      ).toEqual(AMOUNTS.map((row) => [...row]));
      const { rows: money } = await migrator.query<{ column: string }>(
        `SELECT c.relname || '.' || a.attname AS column
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'
            AND format_type(a.atttypid, a.atttypmod) = 'numeric(19,4)'
          ORDER BY 1`,
        [schema],
      );
      expect(money.map((m) => m.column)).toEqual(
        AMOUNTS.map(([t, column]) => `${t}.${column}`).sort(),
      );
      const { rows: guard } = await migrator.query<{ definition: string }>(
        `SELECT replace(pg_get_triggerdef(oid), $1 || '.', '') AS definition FROM pg_trigger
          WHERE tgname = 'currency_definitions_exponent_in_use'
            AND tgrelid = 'currency_definitions'::regclass`,
        [schema],
      );
      expect(guard).toEqual([
        {
          definition:
            'CREATE TRIGGER currency_definitions_exponent_in_use BEFORE UPDATE OF minor_unit_exponent ON currency_definitions FOR EACH ROW WHEN ((old.minor_unit_exponent IS DISTINCT FROM new.minor_unit_exponent)) EXECUTE FUNCTION refuse_exponent_change_in_use()',
        },
      ]);

      // The partial unique indexes, with their predicates.
      const { rows: indexes } = await migrator.query<{
        name: string;
        definition: string;
      }>(
        `SELECT i.indexrelid::regclass::text AS name,
                replace(pg_get_indexdef(i.indexrelid), $1 || '.', '') AS definition
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relnamespace = $1::regnamespace AND i.indpred IS NOT NULL
          ORDER BY 1`,
        [schema],
      );
      expect(
        Object.fromEntries(indexes.map((i) => [i.name, i.definition])),
      ).toEqual(PARTIAL_UNIQUES);

      // And a legal note's default.
      const { rows: defaults } = await migrator.query<{ value: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS value
           FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'legal_notes'::regclass AND a.attname = 'is_internal'`,
      );
      expect(defaults).toEqual([{ value: 'true' }]);
    } finally {
      await migrator.end();
    }
  });
});
