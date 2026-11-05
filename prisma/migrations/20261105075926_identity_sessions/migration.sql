-- Identities, memberships and sessions (0.5.3; DB-16; ADR-0002, ADR-0003).
--   * identities: a person as an identity provider knows them, the issuer and
--     the subject it gave them. Global; the runtime role reads and adds them,
--     and never rewrites or removes one.
--   * users.identity_id: a User stays the membership of one tenant, keeps its
--     id, and links to at most one identity, which has at most one membership
--     in each tenant. Empty until linked through proof of issuer and subject,
--     never by email alone (0.5.10); an unlinked member cannot sign in.
--   * user_sessions: one tenant's rows, under forced row-level security; the
--     digest of the session's token and what the ID token asserted, never a
--     token. Its key to users names the member, the tenant and the identity
--     together, so a session cannot name another tenant's member nor an
--     identity the member is not linked to.
--
-- Prisma runs this file as one transaction. Adding the column and the unique
-- keys to users takes a brief lock; one not granted within 5 s fails the
-- migration rather than queueing every request behind it.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "session_revocation" AS ENUM ('SIGN_OUT', 'SIGN_OUT_EVERYWHERE', 'REVOKED_BY_MEMBER', 'PROVIDER_LOGOUT', 'REPLACED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "identity_id" UUID;

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL,
    "issuer" VARCHAR(500) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "issuer" VARCHAR(500) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "provider_sid" VARCHAR(255),
    "acr" VARCHAR(255),
    "amr" VARCHAR(64)[] DEFAULT ARRAY[]::VARCHAR(64)[],
    "auth_time" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" "session_revocation",
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identities_issuer_subject_key" ON "identities"("issuer", "subject");

-- CreateIndex
CREATE INDEX "user_sessions_tenant_id_user_id_idx" ON "user_sessions"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "user_sessions_tenant_id_identity_id_provider_sid_idx" ON "user_sessions"("tenant_id", "identity_id", "provider_sid");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_tenant_id_token_hash_key" ON "user_sessions"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_id_tenant_id_key" ON "user_sessions"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_identity_id_tenant_id_key" ON "users"("identity_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_tenant_id_identity_id_key" ON "users"("id", "tenant_id", "identity_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "identities"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_tenant_id_identity_id_fkey" FOREIGN KEY ("user_id", "tenant_id", "identity_id") REFERENCES "users"("id", "tenant_id", "identity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written below: what Prisma's schema cannot say (.claude/rules/migrations.md).

-- Row-level security and the runtime role's rights, as scripts/generate-rls.ts
-- Identity UserSession prints them (0.4.5). Identities are global; sessions are
-- one tenant's rows.
REVOKE UPDATE, DELETE ON identities FROM sadara_app;

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_tenant ON user_sessions FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY user_sessions_owner_reads ON user_sessions FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER user_sessions_tenant_immutable BEFORE UPDATE ON user_sessions
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');

-- What the database can judge alone (test/db/identity.integration-spec.ts):
--   * an identity has an issuer and a subject;
--   * a session's token_hash is a SHA-256 digest's size, 32 bytes, so the
--     token as the cookie carries it (0.5.6: 32 random bytes, base64url, 43
--     characters) is refused; storing the digest and not the token is
--     0.5.6's to prove;
--   * it is seen no earlier than it began, and its idle expiry never passes
--     its absolute one;
--   * a revocation has its reason, and a reason its revocation;
--   * a revision counts from one (0.3.6).
ALTER TABLE identities
  ADD CONSTRAINT identities_issuer_check CHECK (issuer <> ''),
  ADD CONSTRAINT identities_subject_check CHECK (subject <> '');

ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_token_hash_check CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT user_sessions_times_check
    CHECK (last_seen_at >= created_at AND idle_expires_at <= absolute_expires_at),
  ADD CONSTRAINT user_sessions_revocation_check CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  ADD CONSTRAINT user_sessions_revision_check CHECK (revision >= 1);
