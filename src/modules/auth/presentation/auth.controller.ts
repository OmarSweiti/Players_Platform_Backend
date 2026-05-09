import { Controller, Post, Body, HttpCode, HttpStatus, Req, Get, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RequestWithUser } from '../../../common/interfaces/request-with-user.interface';
import { Public } from '../../../common/decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { Verify2FADto } from './dto/verify-2fa.dto';
import { LoginUseCase } from '../application/use-cases/login.usecase';
import { RegisterUseCase } from '../application/use-cases/register.usecase';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.usecase';
import { ForgotPasswordUseCase } from '../application/use-cases/forgot-password.usecase';
import { ResetPasswordUseCase } from '../application/use-cases/reset-password.usecase';
import { ChangePasswordUseCase } from '../application/use-cases/change-password.usecase';
import { VerifyEmailUseCase } from '../application/use-cases/verify-email.usecase';
import { ResendVerificationUseCase } from '../application/use-cases/resend-verification.usecase';
import { GetCurrentUserUseCase } from '../application/use-cases/get-current-user.usecase';
import { Enable2FAUseCase } from '../application/use-cases/enable-2fa.usecase';
import { Verify2FAUseCase } from '../application/use-cases/verify-2fa.usecase';
import { Disable2FAUseCase } from '../application/use-cases/disable-2fa.usecase';
import { GetActiveSessionsUseCase } from '../application/use-cases/get-active-sessions.usecase';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private loginUseCase: LoginUseCase,
    private registerUseCase: RegisterUseCase,
    private refreshTokenUseCase: RefreshTokenUseCase,
    private forgotPasswordUseCase: ForgotPasswordUseCase,
    private resetPasswordUseCase: ResetPasswordUseCase,
    private changePasswordUseCase: ChangePasswordUseCase,
    private verifyEmailUseCase: VerifyEmailUseCase,
    private resendVerificationUseCase: ResendVerificationUseCase,
    private getCurrentUserUseCase: GetCurrentUserUseCase,
    private enable2FAUseCase: Enable2FAUseCase,
    private verify2FAUseCase: Verify2FAUseCase,
    private disable2FAUseCase: Disable2FAUseCase,
    private getActiveSessionsUseCase: GetActiveSessionsUseCase,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many login attempts' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(@Body() loginDto: LoginDto, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant'; // Fallback for initial setup
    return this.loginUseCase.execute(loginDto, tenantId);
  }

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  async register(@Body() registerDto: RegisterDto, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant'; // Fallback for initial setup
    return this.registerUseCase.execute(registerDto, tenantId);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(@Body() refreshTokenDto: RefreshTokenDto) {
    return this.refreshTokenUseCase.execute(refreshTokenDto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout (client should discard tokens)' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  logout() {
    // Stateless JWT - client should discard tokens
    return { message: 'Logout successful' };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  async forgotPassword(@Body() forgotPasswordDto: ForgotPasswordDto, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.forgotPasswordUseCase.execute(forgotPasswordDto, tenantId);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() resetPasswordDto: ResetPasswordDto, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.resetPasswordUseCase.execute(resetPasswordDto, tenantId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password for logged-in user' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(@Body() changePasswordDto: ChangePasswordDto, @Req() req: RequestWithUser) {
    return this.changePasswordUseCase.execute(changePasswordDto, req);
  }

  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email with token' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async verifyEmail(@Query('token') token: string, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.verifyEmailUseCase.execute(token, tenantId);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend verification email' })
  @ApiResponse({ status: 200, description: 'Verification email sent' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async resendVerification(@Body() resendVerificationDto: ResendVerificationDto, @Req() req: RequestWithUser) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.resendVerificationUseCase.execute(resendVerificationDto.email, tenantId);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@Req() req: RequestWithUser) {
    return this.getCurrentUserUseCase.execute(req);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable 2FA - generates QR code' })
  @ApiResponse({ status: 200, description: 'QR code generated' })
  async enable2FA(@Req() req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;
    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.enable2FAUseCase.execute(userId, tenantId);
  }

  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify and enable 2FA' })
  @ApiResponse({ status: 200, description: '2FA enabled successfully' })
  @ApiResponse({ status: 400, description: 'Invalid 2FA code' })
  async verify2FA(@Body() verify2FADto: Verify2FADto, @Req() req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;
    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.verify2FAUseCase.execute(userId, tenantId, verify2FADto.token);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable 2FA' })
  @ApiResponse({ status: 200, description: '2FA disabled successfully' })
  @ApiResponse({ status: 400, description: 'Invalid 2FA code' })
  async disable2FA(@Body() verify2FADto: Verify2FADto, @Req() req: RequestWithUser) {
    const userId = req.user?.id;
    const tenantId = req.tenantId;
    if (!userId || !tenantId) {
      throw new UnauthorizedException('User not authenticated');
    }
    return this.disable2FAUseCase.execute(userId, tenantId, verify2FADto.token);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get active sessions' })
  @ApiResponse({ status: 200, description: 'List of active sessions' })
  async getActiveSessions(@Req() req: RequestWithUser) {
    return this.getActiveSessionsUseCase.execute(req);
  }
}
