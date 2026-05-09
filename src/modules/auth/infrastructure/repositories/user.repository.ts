import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UserRepository {
  constructor(private prisma: PrismaService) {}

  async findByEmail(email: string, tenantId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: {
        tenantId_email: {
          tenantId,
          email,
        },
      },
    });
  }

  async findById(id: string, tenantId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
    });
  }

  async create(data: {
    email: string;
    passwordHash: string;
    role: any;
    firstName?: string;
    lastName?: string;
    phone?: string;
    tenantId: string;
    emailVerificationToken?: string;
    emailVerificationExpiry?: Date;
  }): Promise<User> {
    return this.prisma.user.create({
      data,
    });
  }

  async updateLastLogin(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
      },
    });
  }

  async incrementFailedLoginAttempts(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: { increment: 1 },
      },
    });
  }

  async lockAccount(userId: string, lockedUntil: Date): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        lockedUntil,
      },
    });
  }

  async update(userId: string, data: {
    passwordHash?: string;
    passwordResetToken?: string | null;
    passwordResetExpiry?: Date | null;
    passwordChangedAt?: Date;
    lastLoginAt?: Date;
    failedLoginAttempts?: number;
    lockedUntil?: Date | null;
    emailVerifiedAt?: Date;
    emailVerificationToken?: string | null;
    emailVerificationExpiry?: Date | null;
    twoFASecret?: string | null;
    is2FAEnabled?: boolean;
  }): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data,
    });
  }

  async findByResetToken(token: string, tenantId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        passwordResetToken: token,
        tenantId,
      },
    });
  }

  async findByVerificationToken(token: string, tenantId: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        emailVerificationToken: token,
        tenantId,
      },
    });
  }
}
