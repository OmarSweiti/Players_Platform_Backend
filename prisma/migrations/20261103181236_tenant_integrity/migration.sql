-- Composite and same-parent foreign keys (0.4.4; SYS-TEN-004, DB-03, DB-06,
-- DB-07, DB-08, DB-53). A reference can no longer name another tenant's row, a
-- treatment session another player's record, or an attendance row an
-- enrollment and a session of two programs; no key nulls tenant_id on delete
-- (SET NULL) or rewrites it when a parent key changes (ON UPDATE CASCADE).
--
-- Each stronger key is added NOT VALID, so new writes are checked at once, then
-- validated in its own statement; only then is the weaker key it replaces
-- dropped. A row that breaks a new key stops the migration: nothing is
-- deleted or rewritten to make it pass (`just preflight` names such rows).
--
-- Prisma runs this file as one transaction: if any statement fails, nothing
-- here is applied. The tables hold only synthetic data (ADR-0021), so the
-- locks are brief; a lock that is not granted within 5 s fails the migration
-- rather than queueing every request behind it.
SET LOCAL lock_timeout = '5s';

-- The parent keys the same-parent references need.
CREATE UNIQUE INDEX enrollments_id_tenant_id_training_id_key ON enrollments (id, tenant_id, training_id);
CREATE UNIQUE INDEX medical_records_id_tenant_id_player_id_key ON medical_records (id, tenant_id, player_id);
CREATE UNIQUE INDEX training_sessions_id_tenant_id_training_id_key ON training_sessions (id, tenant_id, training_id);

-- attendance.training_id: the program the enrollment and the session share,
-- taken only where the two agree. Where they disagree, neither is picked.
ALTER TABLE attendance ADD COLUMN training_id UUID;
UPDATE attendance AS a
SET training_id = e.training_id
FROM enrollments AS e, training_sessions AS s
WHERE e.id = a.enrollment_id AND e.tenant_id = a.tenant_id
  AND s.id = a.training_session_id AND s.tenant_id = a.tenant_id
  AND s.training_id = e.training_id;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance WHERE training_id IS NULL) THEN
    RAISE EXCEPTION 'attendance joins an enrollment and a session of two different programs'
      USING HINT = 'just preflight names the rows (same_parent); correct them, then migrate again';
  END IF;
END
$$;
ALTER TABLE attendance ALTER COLUMN training_id SET NOT NULL;

-- The stronger keys: composite with tenant_id, and same-parent where a row
-- has two parents that must agree.
ALTER TABLE attendance ADD CONSTRAINT attendance_enrollment_id_tenant_id_training_id_fkey
  FOREIGN KEY (enrollment_id, tenant_id, training_id) REFERENCES enrollments (id, tenant_id, training_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE attendance ADD CONSTRAINT attendance_training_session_id_tenant_id_training_id_fkey
  FOREIGN KEY (training_session_id, tenant_id, training_id) REFERENCES training_sessions (id, tenant_id, training_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_tenant_id_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contracts ADD CONSTRAINT contracts_season_id_tenant_id_fkey
  FOREIGN KEY (season_id, tenant_id) REFERENCES seasons (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE documents ADD CONSTRAINT documents_uploaded_by_id_tenant_id_fkey
  FOREIGN KEY (uploaded_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_tickets ADD CONSTRAINT legal_tickets_assigned_to_id_tenant_id_fkey
  FOREIGN KEY (assigned_to_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_tenant_id_fkey
  FOREIGN KEY (sender_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE performance_records ADD CONSTRAINT performance_records_season_id_tenant_id_fkey
  FOREIGN KEY (season_id, tenant_id) REFERENCES seasons (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE trainings ADD CONSTRAINT trainings_season_id_tenant_id_fkey
  FOREIGN KEY (season_id, tenant_id) REFERENCES seasons (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE treatment_sessions ADD CONSTRAINT treatment_sessions_medical_record_id_tenant_id_player_id_fkey
  FOREIGN KEY (medical_record_id, tenant_id, player_id) REFERENCES medical_records (id, tenant_id, player_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE attendance VALIDATE CONSTRAINT attendance_enrollment_id_tenant_id_training_id_fkey;
ALTER TABLE attendance VALIDATE CONSTRAINT attendance_training_session_id_tenant_id_training_id_fkey;
ALTER TABLE audit_logs VALIDATE CONSTRAINT audit_logs_user_id_tenant_id_fkey;
ALTER TABLE contracts VALIDATE CONSTRAINT contracts_season_id_tenant_id_fkey;
ALTER TABLE documents VALIDATE CONSTRAINT documents_uploaded_by_id_tenant_id_fkey;
ALTER TABLE legal_tickets VALIDATE CONSTRAINT legal_tickets_assigned_to_id_tenant_id_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_sender_id_tenant_id_fkey;
ALTER TABLE performance_records VALIDATE CONSTRAINT performance_records_season_id_tenant_id_fkey;
ALTER TABLE trainings VALIDATE CONSTRAINT trainings_season_id_tenant_id_fkey;
ALTER TABLE treatment_sessions VALIDATE CONSTRAINT treatment_sessions_medical_record_id_tenant_id_player_id_fkey;

-- The weaker keys they replace: single-column, or composite without the
-- shared parent.
ALTER TABLE attendance DROP CONSTRAINT attendance_enrollment_id_tenant_id_fkey;
ALTER TABLE attendance DROP CONSTRAINT attendance_training_session_id_tenant_id_fkey;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_user_id_fkey;
ALTER TABLE contracts DROP CONSTRAINT contracts_season_id_fkey;
ALTER TABLE legal_tickets DROP CONSTRAINT legal_tickets_assigned_to_id_fkey;
ALTER TABLE messages DROP CONSTRAINT messages_sender_id_fkey;
ALTER TABLE performance_records DROP CONSTRAINT performance_records_season_id_fkey;
ALTER TABLE trainings DROP CONSTRAINT trainings_season_id_fkey;
ALTER TABLE treatment_sessions DROP CONSTRAINT treatment_sessions_medical_record_id_tenant_id_fkey;

-- Every other key keeps its columns and changes its actions: ON UPDATE
-- RESTRICT, and RESTRICT instead of SET NULL on scouting_reports.player_id.
-- PostgreSQL cannot change a key's actions in place, so each is dropped and
-- added again in one statement, then validated. role_permissions keeps
-- deleting with its permission until 0.6.1.
ALTER TABLE attendance DROP CONSTRAINT attendance_tenant_id_fkey, ADD CONSTRAINT attendance_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_tenant_id_fkey, ADD CONSTRAINT audit_logs_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_approvals DROP CONSTRAINT contract_approvals_approved_by_id_tenant_id_fkey, ADD CONSTRAINT contract_approvals_approved_by_id_tenant_id_fkey
  FOREIGN KEY (approved_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_approvals DROP CONSTRAINT contract_approvals_contract_id_tenant_id_fkey, ADD CONSTRAINT contract_approvals_contract_id_tenant_id_fkey
  FOREIGN KEY (contract_id, tenant_id) REFERENCES contracts (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_approvals DROP CONSTRAINT contract_approvals_tenant_id_fkey, ADD CONSTRAINT contract_approvals_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_versions DROP CONSTRAINT contract_versions_contract_id_tenant_id_fkey, ADD CONSTRAINT contract_versions_contract_id_tenant_id_fkey
  FOREIGN KEY (contract_id, tenant_id) REFERENCES contracts (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_versions DROP CONSTRAINT contract_versions_created_by_id_tenant_id_fkey, ADD CONSTRAINT contract_versions_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contract_versions DROP CONSTRAINT contract_versions_tenant_id_fkey, ADD CONSTRAINT contract_versions_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contracts DROP CONSTRAINT contracts_created_by_id_tenant_id_fkey, ADD CONSTRAINT contracts_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contracts DROP CONSTRAINT contracts_player_id_tenant_id_fkey, ADD CONSTRAINT contracts_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE contracts DROP CONSTRAINT contracts_tenant_id_fkey, ADD CONSTRAINT contracts_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_conversation_id_tenant_id_fkey, ADD CONSTRAINT conversation_members_conversation_id_tenant_id_fkey
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_tenant_id_fkey, ADD CONSTRAINT conversation_members_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE conversation_members DROP CONSTRAINT conversation_members_user_id_tenant_id_fkey, ADD CONSTRAINT conversation_members_user_id_tenant_id_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE conversations DROP CONSTRAINT conversations_tenant_id_fkey, ADD CONSTRAINT conversations_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE documents DROP CONSTRAINT documents_tenant_id_fkey, ADD CONSTRAINT documents_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE enrollments DROP CONSTRAINT enrollments_player_id_tenant_id_fkey, ADD CONSTRAINT enrollments_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE enrollments DROP CONSTRAINT enrollments_tenant_id_fkey, ADD CONSTRAINT enrollments_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE enrollments DROP CONSTRAINT enrollments_training_id_tenant_id_fkey, ADD CONSTRAINT enrollments_training_id_tenant_id_fkey
  FOREIGN KEY (training_id, tenant_id) REFERENCES trainings (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_notes DROP CONSTRAINT legal_notes_created_by_id_tenant_id_fkey, ADD CONSTRAINT legal_notes_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_notes DROP CONSTRAINT legal_notes_tenant_id_fkey, ADD CONSTRAINT legal_notes_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_notes DROP CONSTRAINT legal_notes_ticket_id_tenant_id_fkey, ADD CONSTRAINT legal_notes_ticket_id_tenant_id_fkey
  FOREIGN KEY (ticket_id, tenant_id) REFERENCES legal_tickets (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_tickets DROP CONSTRAINT legal_tickets_created_by_id_tenant_id_fkey, ADD CONSTRAINT legal_tickets_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_tickets DROP CONSTRAINT legal_tickets_player_id_tenant_id_fkey, ADD CONSTRAINT legal_tickets_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE legal_tickets DROP CONSTRAINT legal_tickets_tenant_id_fkey, ADD CONSTRAINT legal_tickets_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE medical_records DROP CONSTRAINT medical_records_created_by_id_tenant_id_fkey, ADD CONSTRAINT medical_records_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE medical_records DROP CONSTRAINT medical_records_player_id_tenant_id_fkey, ADD CONSTRAINT medical_records_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE medical_records DROP CONSTRAINT medical_records_tenant_id_fkey, ADD CONSTRAINT medical_records_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_tenant_id_fkey, ADD CONSTRAINT messages_conversation_id_tenant_id_fkey
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE messages DROP CONSTRAINT messages_tenant_id_fkey, ADD CONSTRAINT messages_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE notifications DROP CONSTRAINT notifications_tenant_id_fkey, ADD CONSTRAINT notifications_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE notifications DROP CONSTRAINT notifications_user_id_tenant_id_fkey, ADD CONSTRAINT notifications_user_id_tenant_id_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE performance_records DROP CONSTRAINT performance_records_player_id_tenant_id_fkey, ADD CONSTRAINT performance_records_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE performance_records DROP CONSTRAINT performance_records_tenant_id_fkey, ADD CONSTRAINT performance_records_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE player_media DROP CONSTRAINT player_media_player_id_tenant_id_fkey, ADD CONSTRAINT player_media_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE player_media DROP CONSTRAINT player_media_tenant_id_fkey, ADD CONSTRAINT player_media_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE player_watchlists DROP CONSTRAINT player_watchlists_player_id_tenant_id_fkey, ADD CONSTRAINT player_watchlists_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE player_watchlists DROP CONSTRAINT player_watchlists_tenant_id_fkey, ADD CONSTRAINT player_watchlists_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE player_watchlists DROP CONSTRAINT player_watchlists_user_id_tenant_id_fkey, ADD CONSTRAINT player_watchlists_user_id_tenant_id_fkey
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE players DROP CONSTRAINT players_tenant_id_fkey, ADD CONSTRAINT players_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE ratings DROP CONSTRAINT ratings_created_by_id_tenant_id_fkey, ADD CONSTRAINT ratings_created_by_id_tenant_id_fkey
  FOREIGN KEY (created_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE ratings DROP CONSTRAINT ratings_player_id_tenant_id_fkey, ADD CONSTRAINT ratings_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE ratings DROP CONSTRAINT ratings_tenant_id_fkey, ADD CONSTRAINT ratings_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_permission_id_fkey, ADD CONSTRAINT role_permissions_permission_id_fkey
  FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_assignments DROP CONSTRAINT scouting_assignments_assigned_by_id_tenant_id_fkey, ADD CONSTRAINT scouting_assignments_assigned_by_id_tenant_id_fkey
  FOREIGN KEY (assigned_by_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_assignments DROP CONSTRAINT scouting_assignments_assigned_to_id_tenant_id_fkey, ADD CONSTRAINT scouting_assignments_assigned_to_id_tenant_id_fkey
  FOREIGN KEY (assigned_to_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_assignments DROP CONSTRAINT scouting_assignments_tenant_id_fkey, ADD CONSTRAINT scouting_assignments_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_reports DROP CONSTRAINT scouting_reports_player_id_tenant_id_fkey, ADD CONSTRAINT scouting_reports_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_reports DROP CONSTRAINT scouting_reports_scout_id_tenant_id_fkey, ADD CONSTRAINT scouting_reports_scout_id_tenant_id_fkey
  FOREIGN KEY (scout_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE scouting_reports DROP CONSTRAINT scouting_reports_tenant_id_fkey, ADD CONSTRAINT scouting_reports_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE seasons DROP CONSTRAINT seasons_tenant_id_fkey, ADD CONSTRAINT seasons_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE training_sessions DROP CONSTRAINT training_sessions_tenant_id_fkey, ADD CONSTRAINT training_sessions_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE training_sessions DROP CONSTRAINT training_sessions_training_id_tenant_id_fkey, ADD CONSTRAINT training_sessions_training_id_tenant_id_fkey
  FOREIGN KEY (training_id, tenant_id) REFERENCES trainings (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE trainings DROP CONSTRAINT trainings_tenant_id_fkey, ADD CONSTRAINT trainings_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE treatment_sessions DROP CONSTRAINT treatment_sessions_conducted_by_tenant_id_fkey, ADD CONSTRAINT treatment_sessions_conducted_by_tenant_id_fkey
  FOREIGN KEY (conducted_by, tenant_id) REFERENCES users (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE treatment_sessions DROP CONSTRAINT treatment_sessions_player_id_tenant_id_fkey, ADD CONSTRAINT treatment_sessions_player_id_tenant_id_fkey
  FOREIGN KEY (player_id, tenant_id) REFERENCES players (id, tenant_id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE treatment_sessions DROP CONSTRAINT treatment_sessions_tenant_id_fkey, ADD CONSTRAINT treatment_sessions_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE users DROP CONSTRAINT users_tenant_id_fkey, ADD CONSTRAINT users_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE attendance VALIDATE CONSTRAINT attendance_tenant_id_fkey;
ALTER TABLE audit_logs VALIDATE CONSTRAINT audit_logs_tenant_id_fkey;
ALTER TABLE contract_approvals VALIDATE CONSTRAINT contract_approvals_approved_by_id_tenant_id_fkey;
ALTER TABLE contract_approvals VALIDATE CONSTRAINT contract_approvals_contract_id_tenant_id_fkey;
ALTER TABLE contract_approvals VALIDATE CONSTRAINT contract_approvals_tenant_id_fkey;
ALTER TABLE contract_versions VALIDATE CONSTRAINT contract_versions_contract_id_tenant_id_fkey;
ALTER TABLE contract_versions VALIDATE CONSTRAINT contract_versions_created_by_id_tenant_id_fkey;
ALTER TABLE contract_versions VALIDATE CONSTRAINT contract_versions_tenant_id_fkey;
ALTER TABLE contracts VALIDATE CONSTRAINT contracts_created_by_id_tenant_id_fkey;
ALTER TABLE contracts VALIDATE CONSTRAINT contracts_player_id_tenant_id_fkey;
ALTER TABLE contracts VALIDATE CONSTRAINT contracts_tenant_id_fkey;
ALTER TABLE conversation_members VALIDATE CONSTRAINT conversation_members_conversation_id_tenant_id_fkey;
ALTER TABLE conversation_members VALIDATE CONSTRAINT conversation_members_tenant_id_fkey;
ALTER TABLE conversation_members VALIDATE CONSTRAINT conversation_members_user_id_tenant_id_fkey;
ALTER TABLE conversations VALIDATE CONSTRAINT conversations_tenant_id_fkey;
ALTER TABLE documents VALIDATE CONSTRAINT documents_tenant_id_fkey;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_player_id_tenant_id_fkey;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_tenant_id_fkey;
ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_training_id_tenant_id_fkey;
ALTER TABLE legal_notes VALIDATE CONSTRAINT legal_notes_created_by_id_tenant_id_fkey;
ALTER TABLE legal_notes VALIDATE CONSTRAINT legal_notes_tenant_id_fkey;
ALTER TABLE legal_notes VALIDATE CONSTRAINT legal_notes_ticket_id_tenant_id_fkey;
ALTER TABLE legal_tickets VALIDATE CONSTRAINT legal_tickets_created_by_id_tenant_id_fkey;
ALTER TABLE legal_tickets VALIDATE CONSTRAINT legal_tickets_player_id_tenant_id_fkey;
ALTER TABLE legal_tickets VALIDATE CONSTRAINT legal_tickets_tenant_id_fkey;
ALTER TABLE medical_records VALIDATE CONSTRAINT medical_records_created_by_id_tenant_id_fkey;
ALTER TABLE medical_records VALIDATE CONSTRAINT medical_records_player_id_tenant_id_fkey;
ALTER TABLE medical_records VALIDATE CONSTRAINT medical_records_tenant_id_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_conversation_id_tenant_id_fkey;
ALTER TABLE messages VALIDATE CONSTRAINT messages_tenant_id_fkey;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_tenant_id_fkey;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_user_id_tenant_id_fkey;
ALTER TABLE performance_records VALIDATE CONSTRAINT performance_records_player_id_tenant_id_fkey;
ALTER TABLE performance_records VALIDATE CONSTRAINT performance_records_tenant_id_fkey;
ALTER TABLE player_media VALIDATE CONSTRAINT player_media_player_id_tenant_id_fkey;
ALTER TABLE player_media VALIDATE CONSTRAINT player_media_tenant_id_fkey;
ALTER TABLE player_watchlists VALIDATE CONSTRAINT player_watchlists_player_id_tenant_id_fkey;
ALTER TABLE player_watchlists VALIDATE CONSTRAINT player_watchlists_tenant_id_fkey;
ALTER TABLE player_watchlists VALIDATE CONSTRAINT player_watchlists_user_id_tenant_id_fkey;
ALTER TABLE players VALIDATE CONSTRAINT players_tenant_id_fkey;
ALTER TABLE ratings VALIDATE CONSTRAINT ratings_created_by_id_tenant_id_fkey;
ALTER TABLE ratings VALIDATE CONSTRAINT ratings_player_id_tenant_id_fkey;
ALTER TABLE ratings VALIDATE CONSTRAINT ratings_tenant_id_fkey;
ALTER TABLE role_permissions VALIDATE CONSTRAINT role_permissions_permission_id_fkey;
ALTER TABLE scouting_assignments VALIDATE CONSTRAINT scouting_assignments_assigned_by_id_tenant_id_fkey;
ALTER TABLE scouting_assignments VALIDATE CONSTRAINT scouting_assignments_assigned_to_id_tenant_id_fkey;
ALTER TABLE scouting_assignments VALIDATE CONSTRAINT scouting_assignments_tenant_id_fkey;
ALTER TABLE scouting_reports VALIDATE CONSTRAINT scouting_reports_player_id_tenant_id_fkey;
ALTER TABLE scouting_reports VALIDATE CONSTRAINT scouting_reports_scout_id_tenant_id_fkey;
ALTER TABLE scouting_reports VALIDATE CONSTRAINT scouting_reports_tenant_id_fkey;
ALTER TABLE seasons VALIDATE CONSTRAINT seasons_tenant_id_fkey;
ALTER TABLE training_sessions VALIDATE CONSTRAINT training_sessions_tenant_id_fkey;
ALTER TABLE training_sessions VALIDATE CONSTRAINT training_sessions_training_id_tenant_id_fkey;
ALTER TABLE trainings VALIDATE CONSTRAINT trainings_tenant_id_fkey;
ALTER TABLE treatment_sessions VALIDATE CONSTRAINT treatment_sessions_conducted_by_tenant_id_fkey;
ALTER TABLE treatment_sessions VALIDATE CONSTRAINT treatment_sessions_player_id_tenant_id_fkey;
ALTER TABLE treatment_sessions VALIDATE CONSTRAINT treatment_sessions_tenant_id_fkey;
ALTER TABLE users VALIDATE CONSTRAINT users_tenant_id_fkey;
