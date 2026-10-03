import { Injectable } from '@nestjs/common';
import { WatchlistRepository } from '../../infrastructure/repositories/watchlist.repository';

@Injectable()
export class ManageWatchlistUseCase {
  constructor(private readonly watchlistRepo: WatchlistRepository) {}

  /**
   * Add player to watchlist
   */
  async addToWatchlist(
    userId: string,
    tenantId: string,
    playerId: string,
    priority?: string,
    notes?: string,
  ) {
    // Validate priority if provided
    if (priority && !['HIGH', 'MEDIUM', 'LOW'].includes(priority)) {
      throw new Error('Priority must be HIGH, MEDIUM, or LOW');
    }

    return await this.watchlistRepo.addToWatchlist(
      userId,
      tenantId,
      playerId,
      priority,
      notes,
    );
  }

  /**
   * Remove player from watchlist
   */
  async removeFromWatchlist(
    userId: string,
    tenantId: string,
    playerId: string,
  ) {
    return await this.watchlistRepo.removeFromWatchlist(
      userId,
      tenantId,
      playerId,
    );
  }

  /**
   * Get user's watchlist
   */
  async getWatchlist(userId: string, tenantId: string) {
    return await this.watchlistRepo.getUserWatchlist(userId, tenantId);
  }

  /**
   * Check if player is in watchlist
   */
  async isInWatchlist(userId: string, tenantId: string, playerId: string) {
    return await this.watchlistRepo.isInWatchlist(userId, tenantId, playerId);
  }
}
