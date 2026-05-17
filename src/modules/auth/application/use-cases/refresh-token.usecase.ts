import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RefreshTokenUseCase {
  private readonly logger = new Logger(RefreshTokenUseCase.name);

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async execute(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      const newAccessToken = this.jwtService.sign({
        sub: payload.sub,
        email: payload.email,
        role: payload.role,
        tenantId: payload.tenantId,
      });

      this.logger.log(`Access token refreshed for user: ${payload.email} (${payload.sub})`);

      return {
        accessToken: newAccessToken,
      };
    } catch (error) {
      this.logger.warn(`Invalid refresh token used`);
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}
