import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Req,
  Get,
  Query,
  UnauthorizedException,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiBearerAuth,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
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
import { RevokeSessionUseCase } from '../application/use-cases/revoke-session.usecase';
import { LogoutAllDevicesUseCase } from '../application/use-cases/logout-all-devices.usecase';

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
    private revokeSessionUseCase: RevokeSessionUseCase,
    private logoutAllDevicesUseCase: LogoutAllDevicesUseCase,
    private config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Authenticate user and return JWT tokens',
    description: `
      Authenticates a user with email and password.
      Returns access token (15min expiry) and refresh token (7 days expiry).
      
      Failed login attempts are tracked. Account locks after 5 failures for 30 minutes.
      Rate limited to 5 requests per minute.
    `,
  })
  @ApiBody({
    type: LoginDto,
    description: 'User credentials for authentication',
  })
  @ApiOkResponse({
    description: 'Login successful - returns user profile and tokens',
    schema: {
      example: {
        user: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          email: 'user@example.com',
          firstName: 'John',
          lastName: 'Doe',
          role: 'COACH',
          tenantId: '550e8400-e29b-41d4-a716-446655440001',
        },
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials or account locked',
    schema: {
      example: {
        statusCode: 401,
        message: 'Invalid credentials',
        error: 'Unauthorized',
      },
    },
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate limit exceeded (max 5 requests per minute)',
  })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenantId = req.tenantId || 'default-tenant'; // Fallback for initial setup
    const result = await this.loginUseCase.execute(loginDto, tenantId);

    // Set HTTP-only cookies for tokens (more secure than localStorage)
    const isProduction =
      this.config.get('NODE_ENV', { infer: true }) === 'production';

    // Access token cookie (15 minutes expiry)
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: isProduction, // HTTPS only in production
      sameSite: isProduction ? 'none' : 'lax', // CORS support
      maxAge: 15 * 60 * 1000, // 15 minutes
      path: '/',
    });

    // Refresh token cookie (7 days expiry)
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    // Return user profile without tokens
    const { accessToken, refreshToken, ...userProfile } = result;
    return { user: userProfile, message: 'Login successful' };
  }

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Register a new user account',
    description: `
      Creates a new user account with email verification.
      A verification email will be sent automatically.
      Password must meet security requirements (8+ chars, uppercase, lowercase, number, special char).
    `,
  })
  @ApiBody({ type: RegisterDto })
  @ApiOkResponse({
    description: 'User registered successfully - verification email sent',
    schema: {
      example: {
        message:
          'Registration successful. Please check your email to verify your account.',
        userId: '550e8400-e29b-41d4-a716-446655440000',
      },
    },
  })
  @ApiConflictResponse({
    description: 'User with this email already exists',
    schema: {
      example: {
        statusCode: 409,
        message: 'User with this email already exists',
        error: 'Conflict',
      },
    },
  })
  async register(
    @Body() registerDto: RegisterDto,
    @Req() req: RequestWithUser,
  ) {
    const tenantId = req.tenantId || 'default-tenant'; // Fallback for initial setup
    return this.registerUseCase.execute(registerDto, tenantId);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Exchanges a valid refresh token for a new access token (15min expiry)',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({
    description: 'New access token generated',
    schema: {
      example: {
        accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or expired refresh token',
  })
  async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.refreshTokenUseCase.execute(
      refreshTokenDto.refreshToken,
    );

    // Set new access token cookie
    const isProduction =
      this.config.get('NODE_ENV', { infer: true }) === 'production';
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    return { message: 'Token refreshed successfully' };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Logout user',
    description: 'Invalidates current session. Client should discard tokens.',
  })
  @ApiOkResponse({
    description: 'Logout successful',
    schema: {
      example: {
        message: 'Logout successful',
      },
    },
  })
  logout(@Res({ passthrough: true }) res: Response) {
    // Clear cookies
    res.clearCookie('accessToken', { path: '/' });
    res.clearCookie('refreshToken', { path: '/' });

    // Stateless JWT - client should discard tokens
    return { message: 'Logout successful' };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  @ApiResponse({ status: 200, description: 'Password reset email sent' })
  async forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
    @Req() req: RequestWithUser,
  ) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.forgotPasswordUseCase.execute(forgotPasswordDto, tenantId);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password with token' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
    @Req() req: RequestWithUser,
  ) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.resetPasswordUseCase.execute(resetPasswordDto, tenantId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password for logged-in user' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @Body() changePasswordDto: ChangePasswordDto,
    @Req() req: RequestWithUser,
  ) {
    return this.changePasswordUseCase.execute(changePasswordDto, req);
  }

  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email with token' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async verifyEmail(
    @Query('token') token: string,
    @Req() req: RequestWithUser,
  ) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.verifyEmailUseCase.execute(token, tenantId);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend verification email' })
  @ApiResponse({ status: 200, description: 'Verification email sent' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async resendVerification(
    @Body() resendVerificationDto: ResendVerificationDto,
    @Req() req: RequestWithUser,
  ) {
    const tenantId = req.tenantId || 'default-tenant';
    return this.resendVerificationUseCase.execute(
      resendVerificationDto.email,
      tenantId,
    );
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
  async verify2FA(
    @Body() verify2FADto: Verify2FADto,
    @Req() req: RequestWithUser,
  ) {
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
  async disable2FA(
    @Body() verify2FADto: Verify2FADto,
    @Req() req: RequestWithUser,
  ) {
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

  @Post('sessions/:sessionId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a specific session',
    description:
      'Revokes access for a specific session/device. Note: Requires token blacklisting implementation for stateless JWT.',
  })
  @ApiResponse({ status: 200, description: 'Session revoked successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid request or session not found',
  })
  async revokeSession(@Req() req: RequestWithUser, sessionId: string) {
    return this.revokeSessionUseCase.execute(req, sessionId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout from all devices',
    description:
      'Invalidates all active sessions by updating passwordChangedAt timestamp. All existing tokens will be rejected.',
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out from all devices successfully',
  })
  async logoutAllDevices(@Req() req: RequestWithUser) {
    return this.logoutAllDevicesUseCase.execute(req);
  }
}
