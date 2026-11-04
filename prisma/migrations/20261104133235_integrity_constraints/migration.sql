-- Integrity constraints in SQL (0.4.10; SR-DB-007; DB-21, DB-22, DB-23, DB-38,
-- DB-55, DB-56). The database refuses what is impossible whatever writes it: a
-- request, an import or a job that skips the API's validation.
--
--   - CHECKs on counts, measures, scores, money, date order, tenant keys,
--     prose length and JSON shape and size. scripts/integrity-checks.ts is
--     their list and printed them as they stand below; just preflight reports
--     a row that breaks one (check_violation).
--   - A constraint trigger holds each amount to its currency's minor units,
--     and an exponent cannot change under amounts in that currency.
--   - Partial unique indexes: one current season per tenant (OPEN-13), live
--     seasons unique by name, one featured image per player.
--   - A legal note is internal unless said otherwise (DB-18).
--
-- Nothing is deleted or rewritten to let a constraint pass: a row that breaks
-- one stops the migration, and just preflight names it. Rows already written
-- keep their values, legal notes included: an existing note's audience is the
-- owner's to classify, not this migration's.
--
-- Prisma runs this file as one transaction. The tables hold only synthetic data
-- (ADR-0021); a lock not granted within 5 s fails the migration rather than
-- queueing every request behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contract_approvals
  ADD CONSTRAINT contract_approvals_step_order_check CHECK (step_order >= 1);

ALTER TABLE contract_versions
  ADD CONSTRAINT contract_versions_version_check CHECK (version >= 1),
  ADD CONSTRAINT contract_versions_file_size_check CHECK (file_size >= 0);

ALTER TABLE documents
  ADD CONSTRAINT documents_file_size_check CHECK (file_size >= 0);

ALTER TABLE messages
  ADD CONSTRAINT messages_file_size_check CHECK (file_size >= 0),
  ADD CONSTRAINT messages_content_check CHECK (char_length(content) <= 10000);

ALTER TABLE player_media
  ADD CONSTRAINT player_media_file_size_check CHECK (file_size >= 0);

ALTER TABLE performance_records
  ADD CONSTRAINT performance_records_goals_check CHECK (goals >= 0),
  ADD CONSTRAINT performance_records_assists_check CHECK (assists >= 0),
  ADD CONSTRAINT performance_records_minutes_played_check CHECK (minutes_played >= 0),
  ADD CONSTRAINT performance_records_yellow_cards_check CHECK (yellow_cards >= 0),
  ADD CONSTRAINT performance_records_red_cards_check CHECK (red_cards >= 0),
  ADD CONSTRAINT performance_records_shots_check CHECK (shots >= 0),
  ADD CONSTRAINT performance_records_shots_on_target_check CHECK (shots_on_target BETWEEN 0 AND shots),
  ADD CONSTRAINT performance_records_pass_accuracy_check CHECK (pass_accuracy BETWEEN 0 AND 100),
  ADD CONSTRAINT performance_records_rating_check CHECK (rating >= 0 AND rating <> 'NaN'),
  ADD CONSTRAINT performance_records_extra_stats_check CHECK (jsonb_typeof(extra_stats) = 'object' AND octet_length(extra_stats::text) <= 16384);

ALTER TABLE players
  ADD CONSTRAINT players_jersey_number_check CHECK (jersey_number >= 0),
  ADD CONSTRAINT players_height_check CHECK (height > 0 AND height < 'Infinity'),
  ADD CONSTRAINT players_weight_check CHECK (weight > 0 AND weight < 'Infinity'),
  ADD CONSTRAINT players_bio_check CHECK (char_length(bio) <= 10000),
  ADD CONSTRAINT players_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE scouting_assignments
  ADD CONSTRAINT scouting_assignments_min_age_check CHECK (min_age >= 0),
  ADD CONSTRAINT scouting_assignments_max_age_check CHECK (max_age >= 0),
  ADD CONSTRAINT scouting_assignments_ages_check CHECK (min_age <= max_age),
  ADD CONSTRAINT scouting_assignments_notes_check CHECK (char_length(notes) <= 10000);

ALTER TABLE scouting_reports
  ADD CONSTRAINT scouting_reports_prospect_age_check CHECK (prospect_age >= 0),
  ADD CONSTRAINT scouting_reports_technical_score_check CHECK (technical_score BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_physical_score_check CHECK (physical_score BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_tactical_score_check CHECK (tactical_score BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_mental_score_check CHECK (mental_score BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_overall_rating_check CHECK (overall_rating BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_potential_rating_check CHECK (potential_rating BETWEEN 1 AND 10),
  ADD CONSTRAINT scouting_reports_personality_notes_check CHECK (char_length(personality_notes) <= 10000),
  ADD CONSTRAINT scouting_reports_strengths_check CHECK (char_length(strengths) <= 10000),
  ADD CONSTRAINT scouting_reports_tactical_fit_check CHECK (char_length(tactical_fit) <= 10000),
  ADD CONSTRAINT scouting_reports_weaknesses_check CHECK (char_length(weaknesses) <= 10000),
  ADD CONSTRAINT scouting_reports_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE trainings
  ADD CONSTRAINT trainings_capacity_check CHECK (capacity >= 0),
  ADD CONSTRAINT trainings_price_check CHECK (price >= 0 AND price <> 'NaN'),
  ADD CONSTRAINT trainings_dates_check CHECK (end_date >= start_date),
  ADD CONSTRAINT trainings_description_check CHECK (char_length(description) <= 10000),
  ADD CONSTRAINT trainings_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE treatment_sessions
  ADD CONSTRAINT treatment_sessions_duration_check CHECK (duration >= 0),
  ADD CONSTRAINT treatment_sessions_description_check CHECK (char_length(description) <= 10000),
  ADD CONSTRAINT treatment_sessions_exercises_check CHECK (char_length(exercises) <= 10000),
  ADD CONSTRAINT treatment_sessions_progress_notes_check CHECK (char_length(progress_notes) <= 10000);

ALTER TABLE ratings
  ADD CONSTRAINT ratings_technical_score_check CHECK (technical_score >= 0 AND technical_score <> 'NaN'),
  ADD CONSTRAINT ratings_physical_score_check CHECK (physical_score >= 0 AND physical_score <> 'NaN'),
  ADD CONSTRAINT ratings_mental_score_check CHECK (mental_score >= 0 AND mental_score <> 'NaN'),
  ADD CONSTRAINT ratings_total_score_check CHECK (total_score >= 0 AND total_score <> 'NaN'),
  ADD CONSTRAINT ratings_notes_check CHECK (char_length(notes) <= 10000),
  ADD CONSTRAINT ratings_extra_scores_check CHECK (jsonb_typeof(extra_scores) = 'object' AND octet_length(extra_scores::text) <= 16384);

ALTER TABLE contracts
  ADD CONSTRAINT contracts_salary_amount_check CHECK (salary_amount >= 0 AND salary_amount <> 'NaN'),
  ADD CONSTRAINT contracts_signing_fee_check CHECK (signing_fee >= 0 AND signing_fee <> 'NaN'),
  ADD CONSTRAINT contracts_salary_period_check CHECK (salary_amount IS NULL OR salary_period IS NOT NULL),
  ADD CONSTRAINT contracts_dates_check CHECK (end_date >= start_date),
  ADD CONSTRAINT contracts_bonus_details_check CHECK (jsonb_typeof(bonus_details) = 'object' AND octet_length(bonus_details::text) <= 16384),
  ADD CONSTRAINT contracts_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_paid_amount_check CHECK (paid_amount >= 0 AND paid_amount <> 'NaN'),
  ADD CONSTRAINT enrollments_notes_check CHECK (char_length(notes) <= 10000);

ALTER TABLE seasons
  ADD CONSTRAINT seasons_dates_check CHECK (end_date >= start_date);

ALTER TABLE training_sessions
  ADD CONSTRAINT training_sessions_times_check CHECK (ends_at >= starts_at);

ALTER TABLE medical_records
  ADD CONSTRAINT medical_records_dates_check CHECK (recovery_date >= injury_date AND return_to_play_date >= injury_date),
  ADD CONSTRAINT medical_records_description_check CHECK (char_length(description) <= 10000),
  ADD CONSTRAINT medical_records_treatment_check CHECK (char_length(treatment) <= 10000),
  ADD CONSTRAINT medical_records_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE users
  ADD CONSTRAINT users_employment_dates_check CHECK (employment_end_date >= employment_start_date),
  ADD CONSTRAINT users_bio_check CHECK (char_length(bio) <= 10000),
  ADD CONSTRAINT users_certifications_check CHECK (jsonb_typeof(certifications) = 'array' AND octet_length(certifications::text) <= 16384),
  ADD CONSTRAINT users_preferences_check CHECK (jsonb_typeof(preferences) = 'object' AND octet_length(preferences::text) <= 16384);

ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_check CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  ADD CONSTRAINT tenants_domain_check CHECK (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' AND char_length(domain) <= 253),
  DROP CONSTRAINT tenants_settings_check,
  ADD CONSTRAINT tenants_settings_check CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 16384 AND NOT (settings ?| ARRAY['timezone', 'defaultLocale', 'locale', 'defaultCurrency', 'currency']));

ALTER TABLE legal_notes
  ADD CONSTRAINT legal_notes_note_check CHECK (char_length(note) <= 10000);

ALTER TABLE legal_tickets
  ADD CONSTRAINT legal_tickets_description_check CHECK (char_length(description) <= 10000),
  ADD CONSTRAINT legal_tickets_metadata_check CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 16384);

ALTER TABLE notifications
  ADD CONSTRAINT notifications_content_check CHECK (char_length(content) <= 10000);

ALTER TABLE player_watchlists
  ADD CONSTRAINT player_watchlists_notes_check CHECK (char_length(notes) <= 10000);

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_new_values_check CHECK (jsonb_typeof(new_values) = 'object' AND octet_length(new_values::text) <= 1048576),
  ADD CONSTRAINT audit_logs_old_values_check CHECK (jsonb_typeof(old_values) = 'object' AND octet_length(old_values::text) <= 1048576);

-- An amount within its currency's minor units (ISO 4217; ADR-0006): JOD to
-- three decimals, USD to two, JPY to none. The trigger's arguments are pairs,
-- (amount column, currency column); src/common/money/money.ts refuses the same
-- amounts before they reach here. NaN and a missing currency are left to the
-- CHECKs above. The message names the column and the currency, never the
-- amount.
CREATE FUNCTION refuse_amount_beyond_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fields jsonb := to_jsonb(NEW);
  amount numeric;
  currency text;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 BY 2 LOOP
    amount := (fields ->> TG_ARGV[i])::numeric;
    currency := fields ->> TG_ARGV[i + 1];
    CONTINUE WHEN amount IS NULL OR amount = 'NaN' OR currency IS NULL;
    IF min_scale(amount) > (SELECT minor_unit_exponent FROM currency_definitions WHERE code = currency) THEN
      RAISE EXCEPTION '%.% has more decimals than % allows', TG_TABLE_NAME, TG_ARGV[i], currency
        USING ERRCODE = 'check_violation', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[i], CONSTRAINT = TG_NAME;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER contracts_amounts_within_currency
  AFTER INSERT OR UPDATE OF salary_amount, signing_fee, salary_currency ON contracts
  FOR EACH ROW EXECUTE FUNCTION refuse_amount_beyond_currency('salary_amount', 'salary_currency', 'signing_fee', 'salary_currency');
CREATE CONSTRAINT TRIGGER enrollments_paid_amount_within_currency
  AFTER INSERT OR UPDATE OF paid_amount, paid_currency ON enrollments
  FOR EACH ROW EXECUTE FUNCTION refuse_amount_beyond_currency('paid_amount', 'paid_currency');
CREATE CONSTRAINT TRIGGER trainings_price_within_currency
  AFTER INSERT OR UPDATE OF price, currency ON trainings
  FOR EACH ROW EXECUTE FUNCTION refuse_amount_beyond_currency('price', 'currency');

-- A currency's minor units do not change while any amount is in it: a
-- versioned conversion policy would (docs/reference/database.md). The amounts
-- are found through the triggers above, so a money column added later with its
-- trigger is covered without editing this function. The runtime role cannot
-- update currencies at all; this holds the migrations.
CREATE FUNCTION refuse_exponent_change_in_use() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  holder record;
  args text[];
  in_use boolean;
BEGIN
  FOR holder IN
    SELECT t.tgrelid::regclass AS tbl, t.tgnargs, t.tgargs FROM pg_trigger t
    WHERE t.tgfoid = 'refuse_amount_beyond_currency'::regproc
    ORDER BY t.tgrelid::regclass::text, t.tgname
  LOOP
    args := (string_to_array(encode(holder.tgargs, 'escape'), E'\\000'))[1:holder.tgnargs];
    FOR i IN 1 .. holder.tgnargs BY 2 LOOP
      EXECUTE format('SELECT EXISTS (SELECT FROM %s WHERE %I = $1 AND %I IS NOT NULL)',
                     holder.tbl, args[i + 1], args[i])
        INTO in_use USING OLD.code;
      IF in_use THEN
        RAISE EXCEPTION 'the minor units of % cannot change while %.% holds amounts in it', OLD.code, holder.tbl, args[i]
          USING ERRCODE = 'restrict_violation',
                HINT = 'a versioned conversion policy changes them, not an edit (docs/reference/database.md)';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER currency_definitions_exponent_in_use
  BEFORE UPDATE OF minor_unit_exponent ON currency_definitions
  FOR EACH ROW WHEN (OLD.minor_unit_exponent IS DISTINCT FROM NEW.minor_unit_exponent)
  EXECUTE FUNCTION refuse_exponent_change_in_use();

-- Uniqueness among live rows only: an archived season or image (deleted_at
-- set) neither counts nor blocks. Duplicates stop the migration with the rule
-- that lists them; the owner decides which row keeps the flag or the name.
DO $$
BEGIN
  IF EXISTS (SELECT FROM seasons WHERE is_current AND deleted_at IS NULL GROUP BY tenant_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a tenant has more than one current season'
      USING HINT = 'just preflight lists them (duplicate_current_season); the owner decides which stays current';
  END IF;
  IF EXISTS (SELECT FROM seasons WHERE deleted_at IS NULL GROUP BY tenant_id, name HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a tenant has two live seasons of one name'
      USING HINT = 'just preflight lists them (duplicate_season_name); the owner renames or archives one';
  END IF;
  IF EXISTS (SELECT FROM player_media WHERE is_featured AND deleted_at IS NULL GROUP BY tenant_id, player_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a player has more than one featured image'
      USING HINT = 'just preflight lists them (duplicate_featured_media); the owner decides which stays featured';
  END IF;
END
$$;

CREATE UNIQUE INDEX seasons_tenant_id_current_key ON seasons (tenant_id)
  WHERE is_current AND deleted_at IS NULL;
CREATE UNIQUE INDEX seasons_tenant_id_name_key ON seasons (tenant_id, name)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX player_media_tenant_id_player_id_featured_key ON player_media (tenant_id, player_id)
  WHERE is_featured AND deleted_at IS NULL;

-- A new legal note is internal unless its author says otherwise.
ALTER TABLE legal_notes ALTER COLUMN is_internal SET DEFAULT true;
