-- CreateEnum
CREATE TYPE "PermissionCategory" AS ENUM ('PLAYER', 'CONTRACT', 'TRAINING', 'MEDICAL', 'SCOUTING', 'MATCH', 'FINANCE', 'LEGAL', 'CHAT', 'USER', 'TENANT', 'REPORT', 'DOCUMENT', 'NOTIFICATION');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'APPROVE', 'EXPORT', 'IMPORT', 'ASSIGN', 'VIEW_CONFIDENTIAL', 'MANAGE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'SPORTING_DIRECTOR';
ALTER TYPE "UserRole" ADD VALUE 'ASSISTANT_COACH';
ALTER TYPE "UserRole" ADD VALUE 'GOALKEEPER_COACH';
ALTER TYPE "UserRole" ADD VALUE 'FITNESS_COACH';
ALTER TYPE "UserRole" ADD VALUE 'PHYSIOTHERAPIST';
ALTER TYPE "UserRole" ADD VALUE 'FINANCE_MANAGER';
ALTER TYPE "UserRole" ADD VALUE 'PERFORMANCE_ANALYST';
ALTER TYPE "UserRole" ADD VALUE 'VIDEO_ANALYST';
ALTER TYPE "UserRole" ADD VALUE 'GUARDIAN';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "certifications" JSONB,
ADD COLUMN     "department" VARCHAR(100),
ADD COLUMN     "emergencyContact" VARCHAR(150),
ADD COLUMN     "emergencyPhone" VARCHAR(20),
ADD COLUMN     "employmentEndDate" TIMESTAMP(3),
ADD COLUMN     "employmentStartDate" TIMESTAMP(3),
ADD COLUMN     "position" VARCHAR(150);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "category" "PermissionCategory" NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "description" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "roleId" "UserRole" NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE INDEX "permissions_category_idx" ON "permissions"("category");

-- CreateIndex
CREATE INDEX "permissions_action_idx" ON "permissions"("action");

-- CreateIndex
CREATE INDEX "role_permissions_roleId_idx" ON "role_permissions"("roleId");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_roleId_permissionId_key" ON "role_permissions"("roleId", "permissionId");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
