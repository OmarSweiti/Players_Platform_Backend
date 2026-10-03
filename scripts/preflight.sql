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
  'SELECT %L AS table_name, c.id AS row_id, c."tenantId" AS tenant_id, %L AS reason '
  'FROM %I c JOIN %I p ON p.%I = c.%I WHERE p."tenantId" <> c."tenantId"',
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
  AND col.attname <> 'tenantId'
  AND EXISTS (SELECT 1 FROM pg_attribute t
              WHERE t.attrelid = child.oid AND t.attname = 'tenantId' AND NOT t.attisdropped)
  AND EXISTS (SELECT 1 FROM pg_attribute t
              WHERE t.attrelid = parent.oid AND t.attname = 'tenantId' AND NOT t.attisdropped)
ORDER BY child.relname, col.attname;

-- violations: same_parent
-- Both parents exist in the tenant, but they are not the same parent.
SELECT 'treatment_sessions' AS table_name, t.id AS row_id, t."tenantId" AS tenant_id,
       'treatment_sessions.medicalRecordId names the record of another player' AS reason
FROM treatment_sessions t
JOIN medical_records r ON r.id = t."medicalRecordId" AND r."tenantId" = t."tenantId"
WHERE r."playerId" <> t."playerId"
UNION ALL
SELECT 'attendance', a.id, a."tenantId",
       'attendance joins an enrollment and a session of two different programs'
FROM attendance a
JOIN enrollments e ON e.id = a."enrollmentId" AND e."tenantId" = a."tenantId"
JOIN training_sessions s ON s.id = a."trainingSessionId" AND s."tenantId" = a."tenantId"
WHERE e."trainingId" <> s."trainingId";

-- violations: orphaned_reference
-- References no foreign key protects: they must name a row of the same tenant.
SELECT 'documents' AS table_name, d.id AS row_id, d."tenantId" AS tenant_id,
       'documents.entityId names no ' || d."entityType" || ' of its tenant' AS reason
FROM documents d
WHERE NOT CASE d."entityType"::text
  WHEN 'PLAYER' THEN EXISTS (SELECT 1 FROM players x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'CONTRACT' THEN EXISTS (SELECT 1 FROM contracts x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'TRAINING' THEN EXISTS (SELECT 1 FROM trainings x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'LEGAL_TICKET' THEN EXISTS (SELECT 1 FROM legal_tickets x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'MEDICAL_RECORD' THEN EXISTS (SELECT 1 FROM medical_records x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'USER' THEN EXISTS (SELECT 1 FROM users x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'MESSAGE' THEN EXISTS (SELECT 1 FROM messages x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'CONTRACT_VERSION' THEN EXISTS (SELECT 1 FROM contract_versions x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'TRAINING_SESSION' THEN EXISTS (SELECT 1 FROM training_sessions x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'ENROLLMENT' THEN EXISTS (SELECT 1 FROM enrollments x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'LEGAL_NOTE' THEN EXISTS (SELECT 1 FROM legal_notes x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'PLAYER_MEDIA' THEN EXISTS (SELECT 1 FROM player_media x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'SEASON' THEN EXISTS (SELECT 1 FROM seasons x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'PERFORMANCE_RECORD' THEN EXISTS (SELECT 1 FROM performance_records x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  WHEN 'RATING' THEN EXISTS (SELECT 1 FROM ratings x WHERE x.id = d."entityId" AND x."tenantId" = d."tenantId")
  ELSE false -- a type this report does not know yet: teach it, never guess
END
UNION ALL
SELECT 'documents', d.id, d."tenantId", 'documents.uploadedById names no member of its tenant'
FROM documents d
WHERE d."uploadedById" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d."uploadedById" AND u."tenantId" = d."tenantId");
-- audit_logs.entityId is history: it may outlive what it names, so it is not checked.

-- violations: duplicate_email
-- Two members of one tenant whose addresses differ only in case or surrounding
-- spaces; both rows are reported, never the address.
SELECT 'users' AS table_name, u.id AS row_id, u."tenantId" AS tenant_id,
       'users.email equals another member''s address once case and spaces are normalised' AS reason
FROM users u
WHERE EXISTS (
  SELECT 1 FROM users o
  WHERE o."tenantId" = u."tenantId" AND o.id <> u.id
    AND lower(btrim(o.email)) = lower(btrim(u.email))
);

-- violations: money_out_of_range
-- Not a finite, non-negative amount within its currency's minor units (the
-- exponents come from scripts/preflight.ts, read from ISO 4217 through Intl).
WITH exponents AS (
  SELECT key AS currency, value::int AS exponent
  FROM jsonb_each_text(current_setting('sadara.currency_exponents')::jsonb)
)
SELECT 'contracts' AS table_name, c.id AS row_id, c."tenantId" AS tenant_id,
       'contracts.salaryAmount is not a finite, non-negative amount within its currency''s minor units' AS reason
FROM contracts c LEFT JOIN exponents e ON e.currency = c."salaryCurrency"::text
WHERE c."salaryAmount" = 'NaN' OR c."salaryAmount" < 0 OR min_scale(c."salaryAmount") > e.exponent
UNION ALL
SELECT 'contracts', c.id, c."tenantId",
       'contracts.signingFee is not a finite, non-negative amount within its currency''s minor units'
FROM contracts c LEFT JOIN exponents e ON e.currency = c."salaryCurrency"::text
WHERE c."signingFee" = 'NaN' OR c."signingFee" < 0 OR min_scale(c."signingFee") > e.exponent
UNION ALL
SELECT 'trainings', t.id, t."tenantId",
       'trainings.price is not a finite, non-negative amount within its currency''s minor units'
FROM trainings t LEFT JOIN exponents e ON e.currency = t.currency::text
WHERE t.price = 'NaN' OR t.price < 0 OR min_scale(t.price) > e.exponent
UNION ALL
SELECT 'enrollments', n.id, n."tenantId", 'enrollments.paidAmount is not a finite, non-negative amount'
FROM enrollments n
WHERE n."paidAmount" = 'NaN' OR n."paidAmount" < 0;

-- violations: deleted_audit_row
-- Audit is append-only (invariant 5): a soft-deleted audit row is a removed one.
SELECT 'audit_logs' AS table_name, a.id AS row_id, a."tenantId" AS tenant_id,
       'audit_logs row is soft-deleted; audit is append-only' AS reason
FROM audit_logs a
WHERE a."deletedAt" IS NOT NULL;

-- violations: real_account
-- A member whose address is neither on a domain reserved for tests and
-- examples (RFC 2606, RFC 6761) nor one the old seed creates
-- (src/database/seed.ts, until 0.5.11 moves it to .test): a real person may
-- own it. Its credential data must not be dropped without the owner deciding.
SELECT 'users' AS table_name, u.id AS row_id, u."tenantId" AS tenant_id,
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
SELECT 'notifications' AS table_name, 'referenceId' AS column_name, count(*) AS count,
       'notifications.referenceId names an entity by a free-text type: it cannot be checked' AS reason
FROM notifications WHERE "referenceId" IS NOT NULL
HAVING count(*) > 0;

-- unknowns: money_currency_unknown
SELECT 'enrollments' AS table_name, 'paidAmount' AS column_name, count(*) AS count,
       'enrollments.paidAmount has no currency of its own: its minor units cannot be checked' AS reason
FROM enrollments WHERE "paidAmount" IS NOT NULL
HAVING count(*) > 0;

-- unknowns: secret_material
-- Raw tokens and second-factor secrets the local credential system stored;
-- 0.1.6 drops their columns.
SELECT 'users' AS table_name, c.column_name, c.count,
       'users.' || c.column_name || ' holds secret material in plain text' AS reason
FROM (
  SELECT 'passwordResetToken' AS column_name, count(*) FILTER (WHERE "passwordResetToken" IS NOT NULL) AS count FROM users
  UNION ALL
  SELECT 'emailVerificationToken', count(*) FILTER (WHERE "emailVerificationToken" IS NOT NULL) FROM users
  UNION ALL
  SELECT 'twoFASecret', count(*) FILTER (WHERE "twoFASecret" IS NOT NULL) FROM users
) c
WHERE c.count > 0;

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
