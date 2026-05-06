import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { LoginUseCase } from '../../application/use-cases/login.usecase';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private loginUseCase: LoginUseCase) {
    super({
      usernameField: 'email',
    });
  }

  async validate(email: string, password: string): Promise<any> {
    // Note: tenantId will be extracted from request context in actual implementation
    const tenantId = 'default-tenant'; // Temporary fallback
    const user = await this.loginUseCase.validateUser(email, password, tenantId);
    
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    
    return user;
  }
}
