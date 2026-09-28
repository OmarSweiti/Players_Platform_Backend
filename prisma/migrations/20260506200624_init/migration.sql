-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'LEGAL', 'COACH', 'MEDICAL', 'TRAINING_MANAGER', 'SCOUT', 'PLAYER');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SIGNED', 'EXPIRED', 'TERMINATED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('PROFESSIONAL', 'AMATEUR', 'LOAN', 'SPONSORSHIP', 'COACHING', 'OTHER');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WAITLISTED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'PARTIAL', 'REFUNDED', 'WAIVED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'FILE', 'IMAGE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConversationMemberRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "LegalTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PENDING_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LegalTicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PlayerPosition" AS ENUM ('GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST');

-- CreateEnum
CREATE TYPE "PlayerStatus" AS ENUM ('ACTIVE', 'INJURED', 'SUSPENDED', 'LOANED_OUT', 'RETIRED', 'FREE_AGENT');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('CONTRACT_APPROVED', 'CONTRACT_REJECTED', 'CONTRACT_EXPIRING', 'NEW_MESSAGE', 'TRAINING_REMINDER', 'ENROLLMENT_APPROVED', 'ENROLLMENT_REJECTED', 'LEGAL_TICKET_CREATED', 'LEGAL_TICKET_UPDATED', 'MEDICAL_RECORD_ADDED', 'SYSTEM_ALERT');

-- CreateEnum
CREATE TYPE "DocumentEntityType" AS ENUM ('PLAYER', 'CONTRACT', 'TRAINING', 'LEGAL_TICKET', 'MEDICAL_RECORD', 'USER', 'MESSAGE', 'CONTRACT_VERSION', 'TRAINING_SESSION', 'ENROLLMENT', 'LEGAL_NOTE', 'PLAYER_MEDIA', 'SEASON', 'PERFORMANCE_RECORD', 'RATING');

-- CreateEnum
CREATE TYPE "FootPreference" AS ENUM ('LEFT', 'RIGHT', 'BOTH');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'EUR', 'GBP', 'JOD');

-- CreateEnum
CREATE TYPE "SalaryPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'ANNUAL');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "domain" VARCHAR(255),
    "logoUrl" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL,
    "firstName" VARCHAR(100),
    "lastName" VARCHAR(100),
    "avatarUrl" VARCHAR(500),
    "phone" VARCHAR(20),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3),
    "emailVerifiedAt" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "is2FAEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFASecret" VARCHAR(255),
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "entityType" "DocumentEntityType" NOT NULL,
    "entityId" UUID NOT NULL,
    "fileUrl" VARCHAR(500) NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "fileSize" INTEGER,
    "mimeType" VARCHAR(100),
    "description" VARCHAR(500),
    "uploadedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fullName" VARCHAR(255) NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "nationality" VARCHAR(100),
    "secondNationality" VARCHAR(100),
    "position" "PlayerPosition",
    "secondaryPosition" "PlayerPosition",
    "footPreference" "FootPreference",
    "status" "PlayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentClub" VARCHAR(150),
    "jerseyNumber" INTEGER,
    "height" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "passportNumber" VARCHAR(20),
    "passportExpiry" TIMESTAMP(3),
    "agentName" VARCHAR(150),
    "agentEmail" VARCHAR(255),
    "agentPhone" VARCHAR(20),
    "emergencyContact" VARCHAR(150),
    "emergencyPhone" VARCHAR(20),
    "bio" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_media" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "fileUrl" VARCHAR(500) NOT NULL,
    "fileName" VARCHAR(255),
    "fileSize" INTEGER,
    "mimeType" VARCHAR(100),
    "caption" VARCHAR(255),
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "player_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "injuryType" VARCHAR(255) NOT NULL,
    "bodyPart" VARCHAR(100),
    "severity" VARCHAR(50),
    "description" TEXT,
    "treatment" TEXT,
    "injuryDate" TIMESTAMP(3),
    "recoveryDate" TIMESTAMP(3),
    "returnToPlayDate" TIMESTAMP(3),
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "seasonId" UUID,
    "title" VARCHAR(255) NOT NULL,
    "type" "ContractType" NOT NULL DEFAULT 'PROFESSIONAL',
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "salaryAmount" DECIMAL(16,2),
    "salaryCurrency" "Currency" NOT NULL DEFAULT 'USD',
    "salaryPeriod" "SalaryPeriod",
    "bonusDetails" JSONB,
    "signingFee" DECIMAL(14,2),
    "fileUrl" VARCHAR(500),
    "signedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "expiresNotifiedAt" TIMESTAMP(3),
    "terminationDate" TIMESTAMP(3),
    "terminationReason" VARCHAR(500),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "changeNote" VARCHAR(500),
    "fileUrl" VARCHAR(500) NOT NULL,
    "fileName" VARCHAR(255),
    "fileSize" INTEGER,
    "mimeType" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "contract_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_approvals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "approvedById" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "comment" VARCHAR(1000),
    "stepOrder" INTEGER NOT NULL DEFAULT 1,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "contract_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "seasonId" UUID,
    "matchDate" TIMESTAMP(3) NOT NULL,
    "opponent" VARCHAR(150),
    "venue" VARCHAR(200),
    "competition" VARCHAR(200),
    "isStarting" BOOLEAN,
    "goals" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "minutesPlayed" INTEGER NOT NULL DEFAULT 0,
    "yellowCards" INTEGER NOT NULL DEFAULT 0,
    "redCards" INTEGER NOT NULL DEFAULT 0,
    "shots" INTEGER NOT NULL DEFAULT 0,
    "shotsOnTarget" INTEGER NOT NULL DEFAULT 0,
    "passAccuracy" DECIMAL(5,2),
    "rating" DECIMAL(3,1),
    "extraStats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "technicalScore" DECIMAL(5,2) NOT NULL,
    "physicalScore" DECIMAL(5,2) NOT NULL,
    "mentalScore" DECIMAL(5,2) NOT NULL,
    "totalScore" DECIMAL(5,2) NOT NULL,
    "notes" TEXT,
    "extraScores" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trainings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "seasonId" UUID,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "location" VARCHAR(255),
    "capacity" INTEGER,
    "price" DECIMAL(10,2),
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "trainings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "trainingId" UUID NOT NULL,
    "title" VARCHAR(255),
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "location" VARCHAR(255),
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "trainingId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "rejectionReason" VARCHAR(500),
    "notes" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidAmount" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "trainingSessionId" UUID NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_tickets" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "assignedToId" UUID,
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "status" "LegalTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "LegalTicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "legal_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_notes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "legal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "name" VARCHAR(255),
    "imageUrl" VARCHAR(500),
    "description" VARCHAR(500),
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "ConversationMemberRole" NOT NULL DEFAULT 'MEMBER',
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "senderId" UUID,
    "content" TEXT,
    "fileUrl" VARCHAR(500),
    "fileName" VARCHAR(255),
    "fileSize" INTEGER,
    "mimeType" VARCHAR(100),
    "type" "MessageType" NOT NULL,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255),
    "content" TEXT NOT NULL,
    "referenceType" VARCHAR(100),
    "referenceId" UUID,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(100) NOT NULL,
    "entityId" UUID NOT NULL,
    "oldValues" JSONB,
    "newValues" JSONB,
    "ipAddress" VARCHAR(45),
    "userAgent" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_domain_key" ON "tenants"("domain");

-- CreateIndex
CREATE INDEX "tenants_isActive_idx" ON "tenants"("isActive");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenantId_role_idx" ON "users"("tenantId", "role");

-- CreateIndex
CREATE INDEX "users_tenantId_isActive_idx" ON "users"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_tenantId_key" ON "users"("id", "tenantId");

-- CreateIndex
CREATE INDEX "seasons_tenantId_idx" ON "seasons"("tenantId");

-- CreateIndex
CREATE INDEX "seasons_tenantId_isCurrent_idx" ON "seasons"("tenantId", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_id_tenantId_key" ON "seasons"("id", "tenantId");

-- CreateIndex
CREATE INDEX "documents_tenantId_idx" ON "documents"("tenantId");

-- CreateIndex
CREATE INDEX "documents_entityType_entityId_idx" ON "documents"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "documents_tenantId_entityType_idx" ON "documents"("tenantId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "documents_id_tenantId_key" ON "documents"("id", "tenantId");

-- CreateIndex
CREATE INDEX "players_tenantId_idx" ON "players"("tenantId");

-- CreateIndex
CREATE INDEX "players_tenantId_fullName_idx" ON "players"("tenantId", "fullName");

-- CreateIndex
CREATE INDEX "players_position_idx" ON "players"("position");

-- CreateIndex
CREATE INDEX "players_tenantId_status_idx" ON "players"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "players_id_tenantId_key" ON "players"("id", "tenantId");

-- CreateIndex
CREATE INDEX "player_media_tenantId_idx" ON "player_media"("tenantId");

-- CreateIndex
CREATE INDEX "player_media_playerId_idx" ON "player_media"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "player_media_id_tenantId_key" ON "player_media"("id", "tenantId");

-- CreateIndex
CREATE INDEX "medical_records_tenantId_idx" ON "medical_records"("tenantId");

-- CreateIndex
CREATE INDEX "medical_records_tenantId_playerId_idx" ON "medical_records"("tenantId", "playerId");

-- CreateIndex
CREATE INDEX "medical_records_createdById_idx" ON "medical_records"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "medical_records_id_tenantId_key" ON "medical_records"("id", "tenantId");

-- CreateIndex
CREATE INDEX "contracts_tenantId_idx" ON "contracts"("tenantId");

-- CreateIndex
CREATE INDEX "contracts_tenantId_playerId_idx" ON "contracts"("tenantId", "playerId");

-- CreateIndex
CREATE INDEX "contracts_tenantId_status_idx" ON "contracts"("tenantId", "status");

-- CreateIndex
CREATE INDEX "contracts_tenantId_startDate_idx" ON "contracts"("tenantId", "startDate");

-- CreateIndex
CREATE INDEX "contracts_tenantId_endDate_idx" ON "contracts"("tenantId", "endDate");

-- CreateIndex
CREATE INDEX "contracts_tenantId_createdAt_idx" ON "contracts"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "contracts_seasonId_idx" ON "contracts"("seasonId");

-- CreateIndex
CREATE INDEX "contracts_tenantId_status_createdAt_idx" ON "contracts"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "contracts_tenantId_playerId_status_idx" ON "contracts"("tenantId", "playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_id_tenantId_key" ON "contracts"("id", "tenantId");

-- CreateIndex
CREATE INDEX "contract_versions_tenantId_idx" ON "contract_versions"("tenantId");

-- CreateIndex
CREATE INDEX "contract_versions_contractId_idx" ON "contract_versions"("contractId");

-- CreateIndex
CREATE INDEX "contract_versions_createdById_idx" ON "contract_versions"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_contractId_version_key" ON "contract_versions"("contractId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "contract_versions_id_tenantId_key" ON "contract_versions"("id", "tenantId");

-- CreateIndex
CREATE INDEX "contract_approvals_tenantId_idx" ON "contract_approvals"("tenantId");

-- CreateIndex
CREATE INDEX "contract_approvals_contractId_idx" ON "contract_approvals"("contractId");

-- CreateIndex
CREATE INDEX "contract_approvals_approvedById_idx" ON "contract_approvals"("approvedById");

-- CreateIndex
CREATE UNIQUE INDEX "contract_approvals_contractId_approvedById_key" ON "contract_approvals"("contractId", "approvedById");

-- CreateIndex
CREATE UNIQUE INDEX "contract_approvals_id_tenantId_key" ON "contract_approvals"("id", "tenantId");

-- CreateIndex
CREATE INDEX "performance_records_tenantId_idx" ON "performance_records"("tenantId");

-- CreateIndex
CREATE INDEX "performance_records_tenantId_playerId_idx" ON "performance_records"("tenantId", "playerId");

-- CreateIndex
CREATE INDEX "performance_records_tenantId_matchDate_idx" ON "performance_records"("tenantId", "matchDate");

-- CreateIndex
CREATE INDEX "performance_records_seasonId_idx" ON "performance_records"("seasonId");

-- CreateIndex
CREATE INDEX "performance_records_tenantId_playerId_matchDate_idx" ON "performance_records"("tenantId", "playerId", "matchDate");

-- CreateIndex
CREATE UNIQUE INDEX "performance_records_id_tenantId_key" ON "performance_records"("id", "tenantId");

-- CreateIndex
CREATE INDEX "ratings_tenantId_idx" ON "ratings"("tenantId");

-- CreateIndex
CREATE INDEX "ratings_tenantId_playerId_idx" ON "ratings"("tenantId", "playerId");

-- CreateIndex
CREATE INDEX "ratings_createdById_idx" ON "ratings"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_id_tenantId_key" ON "ratings"("id", "tenantId");

-- CreateIndex
CREATE INDEX "trainings_tenantId_idx" ON "trainings"("tenantId");

-- CreateIndex
CREATE INDEX "trainings_tenantId_createdAt_idx" ON "trainings"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "trainings_seasonId_idx" ON "trainings"("seasonId");

-- CreateIndex
CREATE INDEX "trainings_tenantId_startDate_endDate_idx" ON "trainings"("tenantId", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "trainings_tenantId_isRecurring_idx" ON "trainings"("tenantId", "isRecurring");

-- CreateIndex
CREATE UNIQUE INDEX "trainings_id_tenantId_key" ON "trainings"("id", "tenantId");

-- CreateIndex
CREATE INDEX "training_sessions_tenantId_idx" ON "training_sessions"("tenantId");

-- CreateIndex
CREATE INDEX "training_sessions_trainingId_idx" ON "training_sessions"("trainingId");

-- CreateIndex
CREATE INDEX "training_sessions_tenantId_date_idx" ON "training_sessions"("tenantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "training_sessions_id_tenantId_key" ON "training_sessions"("id", "tenantId");

-- CreateIndex
CREATE INDEX "enrollments_tenantId_idx" ON "enrollments"("tenantId");

-- CreateIndex
CREATE INDEX "enrollments_trainingId_idx" ON "enrollments"("trainingId");

-- CreateIndex
CREATE INDEX "enrollments_playerId_idx" ON "enrollments"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_trainingId_playerId_key" ON "enrollments"("trainingId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_id_tenantId_key" ON "enrollments"("id", "tenantId");

-- CreateIndex
CREATE INDEX "attendance_tenantId_idx" ON "attendance"("tenantId");

-- CreateIndex
CREATE INDEX "attendance_date_idx" ON "attendance"("date");

-- CreateIndex
CREATE INDEX "attendance_trainingSessionId_idx" ON "attendance"("trainingSessionId");

-- CreateIndex
CREATE INDEX "attendance_tenantId_enrollmentId_status_idx" ON "attendance"("tenantId", "enrollmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_enrollmentId_trainingSessionId_key" ON "attendance"("enrollmentId", "trainingSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_id_tenantId_key" ON "attendance"("id", "tenantId");

-- CreateIndex
CREATE INDEX "legal_tickets_tenantId_idx" ON "legal_tickets"("tenantId");

-- CreateIndex
CREATE INDEX "legal_tickets_tenantId_status_idx" ON "legal_tickets"("tenantId", "status");

-- CreateIndex
CREATE INDEX "legal_tickets_tenantId_priority_idx" ON "legal_tickets"("tenantId", "priority");

-- CreateIndex
CREATE INDEX "legal_tickets_tenantId_createdAt_idx" ON "legal_tickets"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "legal_tickets_assignedToId_idx" ON "legal_tickets"("assignedToId");

-- CreateIndex
CREATE INDEX "legal_tickets_tenantId_status_createdAt_idx" ON "legal_tickets"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "legal_tickets_id_tenantId_key" ON "legal_tickets"("id", "tenantId");

-- CreateIndex
CREATE INDEX "legal_notes_tenantId_idx" ON "legal_notes"("tenantId");

-- CreateIndex
CREATE INDEX "legal_notes_ticketId_idx" ON "legal_notes"("ticketId");

-- CreateIndex
CREATE INDEX "legal_notes_createdById_idx" ON "legal_notes"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "legal_notes_id_tenantId_key" ON "legal_notes"("id", "tenantId");

-- CreateIndex
CREATE INDEX "conversations_tenantId_idx" ON "conversations"("tenantId");

-- CreateIndex
CREATE INDEX "conversations_tenantId_lastMessageAt_idx" ON "conversations"("tenantId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_tenantId_key" ON "conversations"("id", "tenantId");

-- CreateIndex
CREATE INDEX "conversation_members_tenantId_idx" ON "conversation_members"("tenantId");

-- CreateIndex
CREATE INDEX "conversation_members_userId_idx" ON "conversation_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversationId_userId_key" ON "conversation_members"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "messages_tenantId_idx" ON "messages"("tenantId");

-- CreateIndex
CREATE INDEX "messages_tenantId_conversationId_idx" ON "messages"("tenantId", "conversationId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_tenantId_senderId_idx" ON "messages"("tenantId", "senderId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_id_tenantId_key" ON "messages"("id", "tenantId");

-- CreateIndex
CREATE INDEX "notifications_tenantId_idx" ON "notifications"("tenantId");

-- CreateIndex
CREATE INDEX "notifications_tenantId_userId_isRead_idx" ON "notifications"("tenantId", "userId", "isRead");

-- CreateIndex
CREATE INDEX "notifications_referenceType_referenceId_idx" ON "notifications"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_id_tenantId_key" ON "notifications"("id", "tenantId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_id_tenantId_key" ON "audit_logs"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_media" ADD CONSTRAINT "player_media_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_media" ADD CONSTRAINT "player_media_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contractId_tenantId_fkey" FOREIGN KEY ("contractId", "tenantId") REFERENCES "contracts"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_approvals" ADD CONSTRAINT "contract_approvals_contractId_tenantId_fkey" FOREIGN KEY ("contractId", "tenantId") REFERENCES "contracts"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_approvals" ADD CONSTRAINT "contract_approvals_approvedById_tenantId_fkey" FOREIGN KEY ("approvedById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_approvals" ADD CONSTRAINT "contract_approvals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trainings" ADD CONSTRAINT "trainings_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "seasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_trainingId_tenantId_fkey" FOREIGN KEY ("trainingId", "tenantId") REFERENCES "trainings"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_trainingId_tenantId_fkey" FOREIGN KEY ("trainingId", "tenantId") REFERENCES "trainings"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrollmentId_tenantId_fkey" FOREIGN KEY ("enrollmentId", "tenantId") REFERENCES "enrollments"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_trainingSessionId_tenantId_fkey" FOREIGN KEY ("trainingSessionId", "tenantId") REFERENCES "training_sessions"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_tickets" ADD CONSTRAINT "legal_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_tickets" ADD CONSTRAINT "legal_tickets_playerId_tenantId_fkey" FOREIGN KEY ("playerId", "tenantId") REFERENCES "players"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_tickets" ADD CONSTRAINT "legal_tickets_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_tickets" ADD CONSTRAINT "legal_tickets_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notes" ADD CONSTRAINT "legal_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notes" ADD CONSTRAINT "legal_notes_ticketId_tenantId_fkey" FOREIGN KEY ("ticketId", "tenantId") REFERENCES "legal_tickets"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_notes" ADD CONSTRAINT "legal_notes_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversationId_tenantId_fkey" FOREIGN KEY ("conversationId", "tenantId") REFERENCES "conversations"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_tenantId_fkey" FOREIGN KEY ("conversationId", "tenantId") REFERENCES "conversations"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "users"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- canary: editing history must be refused
