import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { PlayerWatchlist } from '@prisma/client';

@Injectable()
export class WatchlistRepository {
  constructor(private prisma: PrismaService) {}

  async addToWatchlist(
    userId: string,
    tenantId: string,
    playerId: string,
    priority?: string,
    notes?: string,
  ): Promise<PlayerWatchlist> {
    return this.prisma.playerWatchlist.upsert({
      where: {
        userId_playerId: {
          userId,
          playerId,
        },
      },
      update: {
        priority,
        notes,
        updatedAt: new Date(),
      },
      create: {
        userId,
        tenantId,
        playerId,
        priority,
        notes,
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
            currentClub: true,
          },
        },
      },
    });
  }

  async removeFromWatchlist(
    userId: string,
    tenantId: string,
    playerId: string,
  ): Promise<PlayerWatchlist> {
    return this.prisma.playerWatchlist.delete({
      where: {
        userId_playerId: {
          userId,
          playerId,
        },
        tenantId,
      },
    });
  }

  async getUserWatchlist(
    userId: string,
    tenantId: string,
  ): Promise<PlayerWatchlist[]> {
    return this.prisma.playerWatchlist.findMany({
      where: {
        userId,
        tenantId,
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
            dateOfBirth: true,
            nationality: true,
            currentClub: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async isInWatchlist(
    userId: string,
    tenantId: string,
    playerId: string,
  ): Promise<boolean> {
    const count = await this.prisma.playerWatchlist.count({
      where: {
        userId,
        playerId,
        tenantId,
      },
    });
    return count > 0;
  }
}
