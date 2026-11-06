-- Invitations (0.5.10; ADR-0002, DB-68): how a person joins a tenant that
-- already exists.
--   * permission_action gains INVITE, the action of `user.invite`; the next
--     migration writes that permission, since PostgreSQL cannot use an enum
--     value in the transaction that adds it.
--   * invitations: one tenant's rows, under forced row-level security. An
--     address, the role it grants and the language its email is written in,
--     open for seven days. Its single-use token is made when its email is sent
--     (0.7.8); only the token's SHA-256 digest is stored, and a new one
--     replaces the last. Accepting needs the token and the provider's verified
--     address, and records the membership it made and the identity that
--     accepted; its key to users names the member, the tenant and the identity
--     together, as a session's does.
--
-- Prisma runs this file as one transaction. Adding the foreign keys to users
-- takes a brief lock there; one not granted within 5 s fails the migration
-- rather than queueing every request behind it.
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "permission_action" ADD VALUE 'INVITE';

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "normalized_email" VARCHAR(255) NOT NULL,
    "role" "user_role" NOT NULL,
    "locale" "locale" NOT NULL,
    "token_hash" BYTEA,
    "token_issued_at" TIMESTAMPTZ(3),
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_member_id" UUID,
    "accepted_identity_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invitations_tenant_id_created_at_id_idx" ON "invitations"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_invited_by_id_idx" ON "invitations"("tenant_id", "invited_by_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_accepted_member_id_idx" ON "invitations"("tenant_id", "accepted_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_token_hash_key" ON "invitations"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_id_tenant_id_key" ON "invitations"("id", "tenant_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_tenant_id_fkey" FOREIGN KEY ("invited_by_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_member_id_tenant_id_accepted_identity_fkey" FOREIGN KEY ("accepted_member_id", "tenant_id", "accepted_identity_id") REFERENCES "users"("id", "tenant_id", "identity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Hand-written below: what Prisma's schema cannot say (.claude/rules/migrations.md).

-- Row-level security and the runtime role's rights, as scripts/generate-rls.ts
-- Invitation prints them (0.4.5): an invitation is closed, never removed, and
-- the list shows what became of each.
-- invitations: one tenant's rows, by tenant_id.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON invitations FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY invitations_owner_reads ON invitations FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER invitations_tenant_immutable BEFORE UPDATE ON invitations
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON invitations FROM sadara_app;

-- One open invitation per address in a tenant: not accepted, not revoked. An
-- expired one is still open until a new invitation to its address closes it.
CREATE UNIQUE INDEX invitations_open_address_key ON invitations (tenant_id, normalized_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- What the database can judge alone (test/db/invitations.integration-spec.ts):
--   * the address's normal form is users' (src/modules/users/domain/email.ts);
--   * a token's digest is a SHA-256 digest's size, 32 bytes, so the token as
--     its link carries it (32 random bytes, base64url, 43 characters) is
--     refused, and it is issued with its time;
--   * an acceptance has its member and identity, and they their acceptance;
--   * an invitation is accepted or revoked, never both;
--   * it expires after it is made;
--   * SUPER_ADMIN, a platform role, is never granted by an invitation.
ALTER TABLE invitations
  ADD CONSTRAINT invitations_normalized_email_check
    CHECK (normalized_email = lower(btrim(normalize(email, NFKC), E' \t\r\n'))),
  ADD CONSTRAINT invitations_token_hash_check CHECK (octet_length(token_hash) = 32),
  ADD CONSTRAINT invitations_token_check CHECK ((token_hash IS NULL) = (token_issued_at IS NULL)),
  ADD CONSTRAINT invitations_acceptance_check
    CHECK ((accepted_at IS NULL) = (accepted_member_id IS NULL)
       AND (accepted_at IS NULL) = (accepted_identity_id IS NULL)),
  ADD CONSTRAINT invitations_closed_once_check CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  ADD CONSTRAINT invitations_expiry_check CHECK (expires_at > created_at),
  ADD CONSTRAINT invitations_role_check CHECK (role <> 'SUPER_ADMIN');
