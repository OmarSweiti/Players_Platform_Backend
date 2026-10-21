-- Preflight (0.4.1): every integrity violation, reported before any constraint
-- migration — and before any data migration later. Read only: scripts/
-- preflight.ts runs each section in one READ ONLY transaction, with
-- search_path set to the inspected schema. Every result names rows by table,
-- id and tenant id and a fixed reason — never by content: no email, name,
-- amount, token or note ever leaves the database.
--
-- Sections, each introduced by a header line:
--   -- violations: <rule>           returns (table_name, row_id, tenant_id, reason)
--   -- unknowns: <rule>             returns (table_name, column_name, count, reason)
--   -- generate violations: <rule>  returns (sql): one violations query per row
--   -- generate unknowns: <rule>    returns (sql): one unknowns query per row

-- generate violations: cross_tenant_edge
-- A single-column foreign key between two tenant-owned tables lets a row point
-- into another tenant (DB-02: six of them today). Read from the catalog, so a
-- new one is caught too.
SELECT format(
  'SELECT %L AS table_name, c.id AS row_id, c.tenant_id AS tenant_id, %L AS reason '
  'FROM %I c JOIN %I p ON p.%I = c.%I WHERE p.tenant_id <> c.tenant_id',
  child.relname,
  format('%s.%s names a row of another tenant in %s', child.relname, col.attname, parent.relname),
  child.relname, parent.relname, ref.attname, col.attname
) AS sql
FROM pg_constraint fk
JOIN pg_class child ON child.oid = fk.conrelid
JOIN pg_class parent ON parent.oid = fk.confrelid
JOIN pg_attribute col ON col.attrelid = fk.conrelid AND col.attnum = fk.conkey[1]
JOIN pg_attribute ref ON ref.attrelid = fk.confrelid AND ref.attnum = fk.confkey[1]
WHERE fk.contype = 'f'
  AND cardinality(fk.conkey) = 1
  AND child.relnamespace = current_schema()::regnamespace
  AND col.attname <> 'tenant_id'
  AND EXISTS (SELECT 1 FROM pg_attribute t
              WHERE t.attrelid = child.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
  AND EXISTS (SELECT 1 FROM pg_attribute t
              WHERE t.attrelid = parent.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped)
ORDER BY child.relname, col.attname;

-- violations: same_parent
-- Both parents exist in the tenant, but they are not the same parent.
SELECT 'treatment_sessions' AS table_name, t.id AS row_id, t.tenant_id AS tenant_id,
       'treatment_sessions.medical_record_id names the record of another player' AS reason
FROM treatment_sessions t
JOIN medical_records r ON r.id = t.medical_record_id AND r.tenant_id = t.tenant_id
WHERE r.player_id <> t.player_id
UNION ALL
SELECT 'attendance', a.id, a.tenant_id,
       'attendance joins an enrollment and a session of two different programs'
FROM attendance a
JOIN enrollments e ON e.id = a.enrollment_id AND e.tenant_id = a.tenant_id
JOIN training_sessions s ON s.id = a.training_session_id AND s.tenant_id = a.tenant_id
WHERE e.training_id <> s.training_id;

-- violations: orphaned_reference
-- References no foreign key protects: they must name a row of the same tenant.
SELECT 'documents' AS table_name, d.id AS row_id, d.tenant_id AS tenant_id,
       'documents.entity_id names no ' || d.entity_type || ' of its tenant' AS reason
FROM documents d
WHERE NOT CASE d.entity_type::text
  WHEN 'PLAYER' THEN EXISTS (SELECT 1 FROM players x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'CONTRACT' THEN EXISTS (SELECT 1 FROM contracts x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'TRAINING' THEN EXISTS (SELECT 1 FROM trainings x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'LEGAL_TICKET' THEN EXISTS (SELECT 1 FROM legal_tickets x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'MEDICAL_RECORD' THEN EXISTS (SELECT 1 FROM medical_records x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'USER' THEN EXISTS (SELECT 1 FROM users x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'MESSAGE' THEN EXISTS (SELECT 1 FROM messages x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'CONTRACT_VERSION' THEN EXISTS (SELECT 1 FROM contract_versions x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'TRAINING_SESSION' THEN EXISTS (SELECT 1 FROM training_sessions x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'ENROLLMENT' THEN EXISTS (SELECT 1 FROM enrollments x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'LEGAL_NOTE' THEN EXISTS (SELECT 1 FROM legal_notes x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'PLAYER_MEDIA' THEN EXISTS (SELECT 1 FROM player_media x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'SEASON' THEN EXISTS (SELECT 1 FROM seasons x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'PERFORMANCE_RECORD' THEN EXISTS (SELECT 1 FROM performance_records x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  WHEN 'RATING' THEN EXISTS (SELECT 1 FROM ratings x WHERE x.id = d.entity_id AND x.tenant_id = d.tenant_id)
  ELSE false -- a type this report does not know yet: teach it, never guess
END
UNION ALL
SELECT 'documents', d.id, d.tenant_id, 'documents.uploaded_by_id names no member of its tenant'
FROM documents d
WHERE d.uploaded_by_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.uploaded_by_id AND u.tenant_id = d.tenant_id);
-- audit_logs.entity_id is history: it may outlive what it names, so it is not checked.

-- violations: duplicate_email
-- Two members of one tenant whose addresses differ only in case or surrounding
-- spaces; both rows are reported, never the address.
SELECT 'users' AS table_name, u.id AS row_id, u.tenant_id AS tenant_id,
       'users.email equals another member''s address once case and spaces are normalised' AS reason
FROM users u
WHERE EXISTS (
  SELECT 1 FROM users o
  WHERE o.tenant_id = u.tenant_id AND o.id <> u.id
    AND lower(btrim(o.email)) = lower(btrim(u.email))
);

-- violations: money_out_of_range
-- Not a finite, non-negative amount within its currency's minor units (the
-- exponents come from scripts/preflight.ts, read from ISO 4217 through Intl).
WITH exponents AS (
  SELECT key AS currency, value::int AS exponent
  FROM jsonb_each_text(current_setting('sadara.currency_exponents')::jsonb)
)
SELECT 'contracts' AS table_name, c.id AS row_id, c.tenant_id AS tenant_id,
       'contracts.salary_amount is not a finite, non-negative amount within its currency''s minor units' AS reason
FROM contracts c LEFT JOIN exponents e ON e.currency = c.salary_currency::text
WHERE c.salary_amount = 'NaN' OR c.salary_amount < 0 OR min_scale(c.salary_amount) > e.exponent
UNION ALL
SELECT 'contracts', c.id, c.tenant_id,
       'contracts.signing_fee is not a finite, non-negative amount within its currency''s minor units'
FROM contracts c LEFT JOIN exponents e ON e.currency = c.salary_currency::text
WHERE c.signing_fee = 'NaN' OR c.signing_fee < 0 OR min_scale(c.signing_fee) > e.exponent
UNION ALL
SELECT 'trainings', t.id, t.tenant_id,
       'trainings.price is not a finite, non-negative amount within its currency''s minor units'
FROM trainings t LEFT JOIN exponents e ON e.currency = t.currency::text
WHERE t.price = 'NaN' OR t.price < 0 OR min_scale(t.price) > e.exponent
UNION ALL
SELECT 'enrollments', n.id, n.tenant_id, 'enrollments.paid_amount is not a finite, non-negative amount'
FROM enrollments n
WHERE n.paid_amount = 'NaN' OR n.paid_amount < 0;

-- violations: deleted_audit_row
-- Audit is append-only (invariant 5): a soft-deleted audit row is a removed one.
SELECT 'audit_logs' AS table_name, a.id AS row_id, a.tenant_id AS tenant_id,
       'audit_logs row is soft-deleted; audit is append-only' AS reason
FROM audit_logs a
WHERE a.deleted_at IS NOT NULL;

-- violations: real_account
-- A member whose address is neither on a domain reserved for tests and
-- examples (RFC 2606, RFC 6761) nor one the old seed creates
-- (src/database/seed.ts, until 0.5.11 moves it to .test): a real person may
-- own it. Its credential data must not be dropped without the owner deciding.
SELECT 'users' AS table_name, u.id AS row_id, u.tenant_id AS tenant_id,
       'users row is not a known synthetic account: a real person may own it' AS reason
FROM users u
WHERE NOT (
  lower(split_part(btrim(u.email), '@', 2)) ~ '(^|\.)(test|example|invalid|localhost)$'
  OR lower(split_part(btrim(u.email), '@', 2)) IN ('example.com', 'example.net', 'example.org')
  OR lower(btrim(u.email)) IN (
    'admin@players-platform.com',
    'admin@manchester-united.com',
    'admin@real-madrid-academy.com',
    'admin@barcelona-youth.com'
  )
);

-- unknowns: unverifiable_reference
SELECT 'notifications' AS table_name, 'reference_id' AS column_name, count(*) AS count,
       'notifications.reference_id names an entity by a free-text type: it cannot be checked' AS reason
FROM notifications WHERE reference_id IS NOT NULL
HAVING count(*) > 0;

-- unknowns: money_currency_unknown
SELECT 'enrollments' AS table_name, 'paid_amount' AS column_name, count(*) AS count,
       'enrollments.paid_amount has no currency of its own: its minor units cannot be checked' AS reason
FROM enrollments WHERE paid_amount IS NOT NULL
HAVING count(*) > 0;

-- generate unknowns: secret_material
-- Raw tokens and second-factor secrets the local credential system stored,
-- wherever those columns still exist (0.1.6 drops them). They keep their
-- camelCase names: they were gone before 0.4.0 renamed every column.
SELECT format(
  'SELECT %L AS table_name, %L AS column_name, count(%I) AS count, %L AS reason '
  'FROM %I HAVING count(%I) > 0',
  c.table_name, c.column_name, c.column_name,
  format('%s.%s holds secret material in plain text', c.table_name, c.column_name),
  c.table_name, c.column_name
) AS sql
FROM information_schema.columns c
WHERE c.table_schema = current_schema()
  AND c.table_name = 'users'
  AND c.column_name IN ('passwordResetToken', 'emailVerificationToken', 'twoFASecret')
ORDER BY c.column_name;

-- generate unknowns: timestamp_provenance
-- A timestamp without time zone does not say which zone it was written in:
-- 0.4.8 converts these only once the owner confirms their provenance.
SELECT format(
  'SELECT %L AS table_name, %L AS column_name, count(%I) AS count, %L AS reason '
  'FROM %I HAVING count(%I) > 0',
  c.table_name, c.column_name, c.column_name,
  format('%s.%s is a timestamp without time zone: its provenance must be confirmed', c.table_name, c.column_name),
  c.table_name, c.column_name
) AS sql
FROM information_schema.columns c
WHERE c.table_schema = current_schema()
  AND c.data_type = 'timestamp without time zone'
  AND c.table_name <> '_prisma_migrations'
ORDER BY c.table_name, c.column_name;
