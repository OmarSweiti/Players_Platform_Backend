-- Retire the local credential system (0.1.6). Identity moves to an external
-- provider (ADR-0002): passwords, second factors, reset and verification
-- tokens and lockouts are no longer the application's to store.
--
-- Run only after the 0.4.1 preflight (`just preflight`) reports no real
-- account in the target database: dropping these columns destroys the
-- credentials of whoever holds them. No real data exists (ADR-0021); a
-- database with a real account follows the OPEN item on existing data.

ALTER TABLE "users"
  DROP COLUMN "passwordHash",
  DROP COLUMN "passwordChangedAt",
  DROP COLUMN "emailVerifiedAt",
  DROP COLUMN "failedLoginAttempts",
  DROP COLUMN "lockedUntil",
  DROP COLUMN "passwordResetToken",
  DROP COLUMN "passwordResetExpiry",
  DROP COLUMN "emailVerificationToken",
  DROP COLUMN "emailVerificationExpiry",
  DROP COLUMN "is2FAEnabled",
  DROP COLUMN "twoFASecret";
