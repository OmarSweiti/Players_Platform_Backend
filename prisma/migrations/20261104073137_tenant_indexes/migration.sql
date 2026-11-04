-- Tenant-leading indexes; duplicate indexes dropped (0.4.6; SR-DB-006, DB-39,
-- DB-40, DB-54). Every index on a tenant-owned table now leads with tenant_id,
-- so a lookup narrows to one tenant before anything else, as every query does
-- under row-level security (0.4.5); an index serves every foreign key; and no
-- plain index repeats the leading columns of another, each of which cost every
-- write and served nothing. test/db/indexes.integration-spec.ts holds the
-- catalog to these rules.
--
-- Prisma runs this file as one transaction. The tables hold only synthetic data
-- (ADR-0021), so CREATE INDEX holds its write lock only briefly; a lock not
-- granted within 5 s fails the migration rather than queueing every request
-- behind it. A table of real size would build its indexes CONCURRENTLY, outside
-- a transaction, in a migration of its own.
SET LOCAL lock_timeout = '5s';

-- Filter and key indexes, each now led by tenant_id (they replace the unprefixed
-- ones dropped below).
CREATE INDEX attendance_tenant_id_date_idx ON attendance (tenant_id, date);
CREATE INDEX attendance_tenant_id_training_session_id_idx ON attendance (tenant_id, training_session_id);
CREATE INDEX audit_logs_tenant_id_entity_type_entity_id_idx ON audit_logs (tenant_id, entity_type, entity_id);
CREATE INDEX audit_logs_tenant_id_user_id_idx ON audit_logs (tenant_id, user_id);
CREATE INDEX contract_approvals_tenant_id_approved_by_id_idx ON contract_approvals (tenant_id, approved_by_id);
CREATE INDEX contract_versions_tenant_id_created_by_id_idx ON contract_versions (tenant_id, created_by_id);
CREATE INDEX contracts_tenant_id_season_id_idx ON contracts (tenant_id, season_id);
CREATE INDEX conversation_members_tenant_id_user_id_idx ON conversation_members (tenant_id, user_id);
CREATE INDEX documents_tenant_id_entity_type_entity_id_idx ON documents (tenant_id, entity_type, entity_id);
CREATE INDEX enrollments_tenant_id_player_id_idx ON enrollments (tenant_id, player_id);
CREATE INDEX legal_notes_tenant_id_created_by_id_idx ON legal_notes (tenant_id, created_by_id);
CREATE INDEX legal_notes_tenant_id_ticket_id_idx ON legal_notes (tenant_id, ticket_id);
CREATE INDEX legal_tickets_tenant_id_assigned_to_id_idx ON legal_tickets (tenant_id, assigned_to_id);
CREATE INDEX medical_records_tenant_id_created_by_id_idx ON medical_records (tenant_id, created_by_id);
CREATE INDEX messages_tenant_id_conversation_id_created_at_idx ON messages (tenant_id, conversation_id, created_at);
CREATE INDEX notifications_tenant_id_reference_type_reference_id_idx ON notifications (tenant_id, reference_type, reference_id);
CREATE INDEX performance_records_tenant_id_season_id_idx ON performance_records (tenant_id, season_id);
CREATE INDEX player_media_tenant_id_player_id_idx ON player_media (tenant_id, player_id);
CREATE INDEX players_tenant_id_position_idx ON players (tenant_id, position);
CREATE INDEX ratings_tenant_id_created_by_id_idx ON ratings (tenant_id, created_by_id);
CREATE INDEX scouting_assignments_tenant_id_assigned_to_id_idx ON scouting_assignments (tenant_id, assigned_to_id);
CREATE INDEX scouting_assignments_tenant_id_status_idx ON scouting_assignments (tenant_id, status);
CREATE INDEX scouting_reports_tenant_id_player_id_idx ON scouting_reports (tenant_id, player_id);
CREATE INDEX scouting_reports_tenant_id_recommendation_idx ON scouting_reports (tenant_id, recommendation);
CREATE INDEX scouting_reports_tenant_id_scout_id_idx ON scouting_reports (tenant_id, scout_id);
CREATE INDEX scouting_reports_tenant_id_status_idx ON scouting_reports (tenant_id, status);
CREATE INDEX training_sessions_tenant_id_training_id_idx ON training_sessions (tenant_id, training_id);
CREATE INDEX trainings_tenant_id_season_id_idx ON trainings (tenant_id, season_id);
CREATE INDEX treatment_sessions_tenant_id_medical_record_id_idx ON treatment_sessions (tenant_id, medical_record_id);
CREATE INDEX treatment_sessions_tenant_id_player_id_idx ON treatment_sessions (tenant_id, player_id);
CREATE INDEX treatment_sessions_tenant_id_session_date_idx ON treatment_sessions (tenant_id, session_date);
CREATE INDEX treatment_sessions_tenant_id_status_idx ON treatment_sessions (tenant_id, status);

-- An index for each foreign key no index served (DB-54's six, and the
-- uploader's key that 0.4.4 added).
CREATE INDEX contracts_tenant_id_created_by_id_idx ON contracts (tenant_id, created_by_id);
CREATE INDEX documents_tenant_id_uploaded_by_id_idx ON documents (tenant_id, uploaded_by_id);
CREATE INDEX legal_tickets_tenant_id_created_by_id_idx ON legal_tickets (tenant_id, created_by_id);
CREATE INDEX legal_tickets_tenant_id_player_id_idx ON legal_tickets (tenant_id, player_id);
CREATE INDEX player_watchlists_tenant_id_player_id_idx ON player_watchlists (tenant_id, player_id);
CREATE INDEX scouting_assignments_tenant_id_assigned_by_id_idx ON scouting_assignments (tenant_id, assigned_by_id);
CREATE INDEX treatment_sessions_tenant_id_conducted_by_idx ON treatment_sessions (tenant_id, conducted_by);

-- The unprefixed indexes the ones above replace.
DROP INDEX attendance_date_idx;
DROP INDEX attendance_training_session_id_idx;
DROP INDEX audit_logs_entity_type_entity_id_idx;
DROP INDEX audit_logs_user_id_idx;
DROP INDEX contract_approvals_approved_by_id_idx;
DROP INDEX contract_versions_created_by_id_idx;
DROP INDEX contracts_season_id_idx;
DROP INDEX conversation_members_user_id_idx;
DROP INDEX documents_entity_type_entity_id_idx;
DROP INDEX enrollments_player_id_idx;
DROP INDEX legal_notes_created_by_id_idx;
DROP INDEX legal_notes_ticket_id_idx;
DROP INDEX legal_tickets_assigned_to_id_idx;
DROP INDEX medical_records_created_by_id_idx;
DROP INDEX messages_conversation_id_created_at_idx;
DROP INDEX notifications_reference_type_reference_id_idx;
DROP INDEX performance_records_season_id_idx;
DROP INDEX player_media_player_id_idx;
DROP INDEX players_position_idx;
DROP INDEX ratings_created_by_id_idx;
DROP INDEX scouting_assignments_assigned_to_id_idx;
DROP INDEX scouting_assignments_status_idx;
DROP INDEX scouting_reports_player_id_idx;
DROP INDEX scouting_reports_recommendation_idx;
DROP INDEX scouting_reports_scout_id_idx;
DROP INDEX scouting_reports_status_idx;
DROP INDEX training_sessions_training_id_idx;
DROP INDEX trainings_season_id_idx;
DROP INDEX treatment_sessions_medical_record_id_idx;
DROP INDEX treatment_sessions_player_id_idx;
DROP INDEX treatment_sessions_session_date_idx;
DROP INDEX treatment_sessions_status_idx;

-- Redundant: each repeats the leading columns of another index on its table,
-- which serves every query it could (DB-39's tenants.slug among them).
DROP INDEX attendance_tenant_id_idx;
DROP INDEX audit_logs_tenant_id_idx;
DROP INDEX contract_approvals_contract_id_idx;
DROP INDEX contract_versions_contract_id_idx;
DROP INDEX contracts_tenant_id_idx;
DROP INDEX contracts_tenant_id_player_id_idx;
DROP INDEX contracts_tenant_id_status_idx;
DROP INDEX conversations_tenant_id_idx;
DROP INDEX documents_tenant_id_idx;
DROP INDEX enrollments_training_id_idx;
DROP INDEX legal_tickets_tenant_id_idx;
DROP INDEX legal_tickets_tenant_id_status_idx;
DROP INDEX medical_records_tenant_id_idx;
DROP INDEX messages_tenant_id_idx;
DROP INDEX notifications_tenant_id_idx;
DROP INDEX performance_records_tenant_id_idx;
DROP INDEX performance_records_tenant_id_player_id_idx;
DROP INDEX player_watchlists_user_id_idx;
DROP INDEX players_tenant_id_idx;
DROP INDEX ratings_tenant_id_idx;
DROP INDEX role_permissions_role_id_idx;
DROP INDEX seasons_tenant_id_idx;
DROP INDEX tenants_slug_idx;
DROP INDEX training_sessions_tenant_id_idx;
DROP INDEX trainings_tenant_id_idx;
DROP INDEX users_tenant_id_idx;

-- Redundant once the indexes above lead with tenant_id.
DROP INDEX contract_approvals_tenant_id_idx;
DROP INDEX contract_versions_tenant_id_idx;
DROP INDEX conversation_members_tenant_id_idx;
DROP INDEX documents_tenant_id_entity_type_idx;
DROP INDEX enrollments_tenant_id_idx;
DROP INDEX legal_notes_tenant_id_idx;
DROP INDEX messages_tenant_id_conversation_id_idx;
DROP INDEX player_media_tenant_id_idx;
DROP INDEX player_watchlists_tenant_id_idx;
DROP INDEX scouting_assignments_tenant_id_idx;
DROP INDEX scouting_reports_tenant_id_idx;
DROP INDEX treatment_sessions_tenant_id_idx;
DROP INDEX users_email_idx;
