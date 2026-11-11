-- The legacy documents table, contained (0.8.2; DB-06, DB-19, SR-DB-008). It names
-- its owner polymorphically — entity_type and entity_id, with no referential
-- integrity — and holds a URL. Files are file objects now; documents is kept
-- as it is until 1.3.1 migrates its rows to file objects and their typed
-- bindings, and retires it: no new writes, its rows kept. The runtime role
-- reads it and writes nothing; a migration may still write it, as the owner.
-- No row changes here: nothing to preflight.

-- As scripts/generate-rls.ts prints it for Document, its contained class's line.
-- Contained: no new writes, its rows kept, until its owning step retires it.
REVOKE INSERT, UPDATE, DELETE ON documents FROM sadara_app;
