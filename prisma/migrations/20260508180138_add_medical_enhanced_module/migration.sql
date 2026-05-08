-- CreateEnum
CREATE TYPE "InjuryType" AS ENUM ('MUSCLE', 'LIGAMENT', 'TENDON', 'BONE', 'JOINT', 'HEAD_CONCUSSION', 'OTHER');

-- CreateEnum
CREATE TYPE "InjurySeverity" AS ENUM ('MINOR', 'MODERATE', 'SEVERE', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TreatmentStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MedicalRecordType" AS ENUM ('INJURY', 'ILLNESS', 'TREATMENT', 'VACCINATION', 'MEDICAL_EXAM', 'REHABILITATION');

-- CreateTable
CREATE TABLE "treatment_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "medicalRecordId" UUID,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER,
    "status" "TreatmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "treatmentType" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "exercises" TEXT,
    "progressNotes" TEXT,
    "conductedBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "treatment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "treatment_sessions_tenantId_idx" ON "treatment_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "treatment_sessions_playerId_idx" ON "treatment_sessions"("playerId");

-- CreateIndex
CREATE INDEX "treatment_sessions_medicalRecordId_idx" ON "treatment_sessions"("medicalRecordId");

-- CreateIndex
CREATE INDEX "treatment_sessions_sessionDate_idx" ON "treatment_sessions"("sessionDate");

-- CreateIndex
CREATE INDEX "treatment_sessions_status_idx" ON "treatment_sessions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "treatment_sessions_id_tenantId_key" ON "treatment_sessions"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "treatment_sessions" ADD CONSTRAINT "treatment_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_sessions" ADD CONSTRAINT "treatment_sessions_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_sessions" ADD CONSTRAINT "treatment_sessions_medicalRecordId_tenantId_fkey" FOREIGN KEY ("medicalRecordId", "tenantId") REFERENCES "medical_records"("id", "tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "treatment_sessions" ADD CONSTRAINT "treatment_sessions_conductedBy_tenantId_fkey" FOREIGN KEY ("conductedBy", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
