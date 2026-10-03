import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';

@Injectable()
export class RefreshTokenUseCase {
  private readonly logger = new Logger(RefreshTokenUseCase.name);

  constructor(
    private jwtService: JwtService,
    private config: ConfigService<Env, true>,
  ) {}

  execute(refreshToken: string): Promise<{ accessToken: string }> {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });

      const newAccessToken = this.jwtService.sign({
        sub: payload.sub,
        email: payload.email,
        role: payload.role,
        tenantId: payload.tenantId,
      });

      this.logger.log(`Access token refreshed for user ${payload.sub}`);

      return Promise.resolve({
        accessToken: newAccessToken,
      });
    } catch {
      this.logger.warn(`Invalid refresh token used`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}
