-- CreateEnum
CREATE TYPE "ScoutReportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RecommendationLevel" AS ENUM ('STRONG_SIGN', 'SIGN', 'MONITOR', 'NOT_SUITABLE');

-- CreateTable
CREATE TABLE "scouting_reports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scoutId" UUID NOT NULL,
    "playerId" UUID,
    "prospectName" VARCHAR(255),
    "prospectAge" INTEGER,
    "prospectClub" VARCHAR(255),
    "prospectPosition" "PlayerPosition",
    "prospectNationality" VARCHAR(100),
    "status" "ScoutReportStatus" NOT NULL DEFAULT 'DRAFT',
    "recommendation" "RecommendationLevel",
    "technicalScore" DECIMAL(3,1),
    "physicalScore" DECIMAL(3,1),
    "tacticalScore" DECIMAL(3,1),
    "mentalScore" DECIMAL(3,1),
    "strengths" TEXT,
    "weaknesses" TEXT,
    "personalityNotes" TEXT,
    "tacticalFit" TEXT,
    "overallRating" DECIMAL(3,1),
    "potentialRating" DECIMAL(3,1),
    "reportDate" TIMESTAMP(3) NOT NULL,
    "matchObserved" VARCHAR(255),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scouting_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_watchlists" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "priority" VARCHAR(50),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scouting_assignments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "assignedToId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "region" VARCHAR(100),
    "competition" VARCHAR(150),
    "targetPosition" "PlayerPosition",
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "dueDate" TIMESTAMP(3),
    "status" VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scouting_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scouting_reports_tenantId_idx" ON "scouting_reports"("tenantId");

-- CreateIndex
CREATE INDEX "scouting_reports_scoutId_idx" ON "scouting_reports"("scoutId");

-- CreateIndex
CREATE INDEX "scouting_reports_playerId_idx" ON "scouting_reports"("playerId");

-- CreateIndex
CREATE INDEX "scouting_reports_status_idx" ON "scouting_reports"("status");

-- CreateIndex
CREATE INDEX "scouting_reports_recommendation_idx" ON "scouting_reports"("recommendation");

-- CreateIndex
CREATE UNIQUE INDEX "scouting_reports_id_tenantId_key" ON "scouting_reports"("id", "tenantId");

-- CreateIndex
CREATE INDEX "player_watchlists_tenantId_idx" ON "player_watchlists"("tenantId");

-- CreateIndex
CREATE INDEX "player_watchlists_userId_idx" ON "player_watchlists"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "player_watchlists_userId_playerId_key" ON "player_watchlists"("userId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "player_watchlists_id_tenantId_key" ON "player_watchlists"("id", "tenantId");

-- CreateIndex
CREATE INDEX "scouting_assignments_tenantId_idx" ON "scouting_assignments"("tenantId");

-- CreateIndex
CREATE INDEX "scouting_assignments_assignedToId_idx" ON "scouting_assignments"("assignedToId");

-- CreateIndex
CREATE INDEX "scouting_assignments_status_idx" ON "scouting_assignments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "scouting_assignments_id_tenantId_key" ON "scouting_assignments"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "scouting_reports" ADD CONSTRAINT "scouting_reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scouting_reports" ADD CONSTRAINT "scouting_reports_scoutId_tenantId_fkey" FOREIGN KEY ("scoutId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scouting_reports" ADD CONSTRAINT "scouting_reports_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_watchlists" ADD CONSTRAINT "player_watchlists_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_watchlists" ADD CONSTRAINT "player_watchlists_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_watchlists" ADD CONSTRAINT "player_watchlists_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scouting_assignments" ADD CONSTRAINT "scouting_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scouting_assignments" ADD CONSTRAINT "scouting_assignments_assignedToId_tenantId_fkey" FOREIGN KEY ("assignedToId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scouting_assignments" ADD CONSTRAINT "scouting_assignments_assignedById_tenantId_fkey" FOREIGN KEY ("assignedById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
