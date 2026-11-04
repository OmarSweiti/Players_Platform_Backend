// The database's CHECK constraints for values it can judge alone (0.4.10;
// SR-DB-007; DB-21, DB-38, DB-55, DB-56): one list, three readers.
//   - The integrity_constraints migration carries them as this prints them.
//   - scripts/preflight.sql reports every row that would break one
//     (check_violation), before the migration that adds it.
//   - test/db/constraints.integration-spec.ts holds the catalog to the list.
//   npx --no-install ts-node --transpile-only scripts/integrity-checks.ts
//
// The database refuses what is impossible: a negative count, an end before its
// start, a score off its scale, a value that is not finite. What is merely
// unwise (a prospect of 45, a 200-minute match) stays the API's to refuse,
// where a policy can change without a migration. A CHECK passes on NULL, so a
// column that may be empty is not made required here.
import { PROSE_MAX } from '../src/common/validation/schemas';

export interface IntegrityCheck {
  table: string;
  /** The constraint's name: `<table>_<column or subject>_check`. */
  name: string;
  /** The SQL condition every row satisfies. */
  holds: string;
  /** Replaces a constraint of the same name that an earlier migration added. */
  replaces?: true;
}

/**
 * The largest JSON value a metadata or settings column holds, in bytes of its
 * text: room for configuration, none for a hidden table. An initial
 * engineering default, reviewed against measured values.
 */
export const METADATA_BYTES = 16 * 1024;

/**
 * The largest audit snapshot, before or after: the API's request-body limit
 * (docs/reference/api.md), since a change cannot carry more than a request.
 */
export const SNAPSHOT_BYTES = 1024 * 1024;

/** A lower-case DNS label: letters, digits and inner hyphens, at most 63. */
export const DNS_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';

const check = (
  table: string,
  subject: string,
  holds: string,
): IntegrityCheck => ({ table, name: `${table}_${subject}_check`, holds });

/** A count or a size: never negative. */
const count = (table: string, column: string, least = 0) =>
  check(table, column, `${column} >= ${least}`);

/** A NUMERIC measure or amount: not negative, and a number (NaN sorts above every number). */
const finite = (table: string, column: string) =>
  check(table, column, `${column} >= 0 AND ${column} <> 'NaN'`);

/** A floating-point measure: above zero and finite (NaN and Infinity excluded). */
const positiveReal = (table: string, column: string) =>
  check(table, column, `${column} > 0 AND ${column} < 'Infinity'`);

/** A score on a closed scale (BETWEEN refuses NaN). */
const scale = (table: string, column: string, low: number, high: number) =>
  check(table, column, `${column} BETWEEN ${low} AND ${high}`);

/** Prose, as long as the API takes. */
const prose = (table: string, column: string) =>
  check(table, column, `char_length(${column}) <= ${PROSE_MAX}`);

/** JSON of one shape, bounded in size. */
const json = (
  table: string,
  column: string,
  shape: 'object' | 'array',
  bytes = METADATA_BYTES,
  also = '',
) =>
  check(
    table,
    column,
    `jsonb_typeof(${column}) = '${shape}' AND octet_length(${column}::text) <= ${bytes}${also}`,
  );

export const INTEGRITY_CHECKS: IntegrityCheck[] = [
  // Counts and sizes.
  count('contract_approvals', 'step_order', 1),
  count('contract_versions', 'version', 1),
  count('contract_versions', 'file_size'),
  count('documents', 'file_size'),
  count('messages', 'file_size'),
  count('player_media', 'file_size'),
  count('performance_records', 'goals'),
  count('performance_records', 'assists'),
  count('performance_records', 'minutes_played'),
  count('performance_records', 'yellow_cards'),
  count('performance_records', 'red_cards'),
  count('performance_records', 'shots'),
  check(
    'performance_records',
    'shots_on_target',
    'shots_on_target BETWEEN 0 AND shots',
  ),
  count('players', 'jersey_number'),
  count('scouting_assignments', 'min_age'),
  count('scouting_assignments', 'max_age'),
  check('scouting_assignments', 'ages', 'min_age <= max_age'),
  count('scouting_reports', 'prospect_age'),
  count('trainings', 'capacity'),
  count('treatment_sessions', 'duration'),

  // Measures and scores. A rating's scale is not recorded anywhere, so it is
  // held to finite and not negative; a percentage and a scouting score have one.
  positiveReal('players', 'height'),
  positiveReal('players', 'weight'),
  scale('performance_records', 'pass_accuracy', 0, 100),
  finite('performance_records', 'rating'),
  finite('ratings', 'technical_score'),
  finite('ratings', 'physical_score'),
  finite('ratings', 'mental_score'),
  finite('ratings', 'total_score'),
  ...[
    'technical_score',
    'physical_score',
    'tactical_score',
    'mental_score',
    'overall_rating',
    'potential_rating',
  ].map((column) => scale('scouting_reports', column, 1, 10)),

  // Money: finite and not negative (a trigger holds each amount to its
  // currency's minor units); a salary says how often it is paid.
  finite('contracts', 'salary_amount'),
  finite('contracts', 'signing_fee'),
  check(
    'contracts',
    'salary_period',
    'salary_amount IS NULL OR salary_period IS NOT NULL',
  ),
  finite('enrollments', 'paid_amount'),
  finite('trainings', 'price'),

  // Nothing ends before it starts.
  check('contracts', 'dates', 'end_date >= start_date'),
  check('seasons', 'dates', 'end_date >= start_date'),
  check('trainings', 'dates', 'end_date >= start_date'),
  check('training_sessions', 'times', 'ends_at >= starts_at'),
  check(
    'medical_records',
    'dates',
    'recovery_date >= injury_date AND return_to_play_date >= injury_date',
  ),
  check(
    'users',
    'employment_dates',
    'employment_end_date >= employment_start_date',
  ),

  // A tenant's keys as a Host header carries them: lower case, ASCII (an
  // Arabic domain in punycode), no trailing dot.
  check('tenants', 'slug', `slug ~ '^${DNS_LABEL}$'`),
  check(
    'tenants',
    'domain',
    `domain ~ '^(${DNS_LABEL}\\.)*${DNS_LABEL}$' AND char_length(domain) <= 253`,
  ),

  // Prose: as long as the API takes, whatever writes it.
  prose('enrollments', 'notes'),
  prose('legal_notes', 'note'),
  prose('legal_tickets', 'description'),
  prose('medical_records', 'description'),
  prose('medical_records', 'treatment'),
  prose('messages', 'content'),
  prose('notifications', 'content'),
  prose('player_watchlists', 'notes'),
  prose('players', 'bio'),
  prose('ratings', 'notes'),
  prose('scouting_assignments', 'notes'),
  prose('scouting_reports', 'personality_notes'),
  prose('scouting_reports', 'strengths'),
  prose('scouting_reports', 'tactical_fit'),
  prose('scouting_reports', 'weaknesses'),
  prose('trainings', 'description'),
  prose('treatment_sessions', 'description'),
  prose('treatment_sessions', 'exercises'),
  prose('treatment_sessions', 'progress_notes'),
  prose('users', 'bio'),

  // JSON: one shape, bounded, so metadata cannot become a hidden table.
  json('audit_logs', 'new_values', 'object', SNAPSHOT_BYTES),
  json('audit_logs', 'old_values', 'object', SNAPSHOT_BYTES),
  json('contracts', 'bonus_details', 'object'),
  json('contracts', 'metadata', 'object'),
  json('legal_tickets', 'metadata', 'object'),
  json('medical_records', 'metadata', 'object'),
  json('performance_records', 'extra_stats', 'object'),
  json('players', 'metadata', 'object'),
  json('ratings', 'extra_scores', 'object'),
  json('scouting_reports', 'metadata', 'object'),
  {
    // 0.4.8's rule, that the typed settings stay out, joined by the bounds.
    ...json(
      'tenants',
      'settings',
      'object',
      METADATA_BYTES,
      ` AND NOT (settings ?| ARRAY['timezone', 'defaultLocale', 'locale', 'defaultCurrency', 'currency'])`,
    ),
    replaces: true,
  },
  json('trainings', 'metadata', 'object'),
  json('users', 'certifications', 'array'),
  json('users', 'preferences', 'object'),
];

/** The migration's statements: one ALTER TABLE per table, in the list's order. */
export function integritySql(checks = INTEGRITY_CHECKS): string {
  const tables = [...new Set(checks.map((c) => c.table))];
  return tables
    .map((table) => {
      const clauses = checks
        .filter((c) => c.table === table)
        .flatMap((c) => [
          ...(c.replaces ? [`  DROP CONSTRAINT ${c.name}`] : []),
          `  ADD CONSTRAINT ${c.name} CHECK (${c.holds})`,
        ]);
      return `ALTER TABLE ${table}\n${clauses.join(',\n')};`;
    })
    .join('\n\n');
}

if (process.argv[1]?.endsWith('integrity-checks.ts')) {
  process.stdout.write(`${integritySql()}\n`);
}
