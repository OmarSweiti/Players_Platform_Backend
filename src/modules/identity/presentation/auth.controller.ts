import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { API_VERSION } from '../../../app.setup';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import type { Page } from '../../../common/pagination/paginate';
import {
  Raises,
  Redirects,
  Returns,
  ReturnsPage,
} from '../../../common/openapi/responses';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import {
  COOKIE_ATTRIBUTES,
  PREAUTH_COOKIE,
  SESSION_COOKIE,
} from '../../../common/security/session-cookies';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { IdParams } from '../../../common/validation/schemas';
import type { Env } from '../../../config/env.schema';
import { BackchannelLogoutUseCase } from '../application/use-cases/backchannel-logout.usecase';
import {
  type ListedSession,
  OwnSessionsUseCase,
} from '../application/use-cases/own-sessions.usecase';
import {
  type CurrentSession,
  ReadSessionUseCase,
} from '../application/use-cases/read-session.usecase';
import { SignInUseCase } from '../application/use-cases/sign-in.usecase';
import {
  type SignedOut,
  SignOutUseCase,
} from '../application/use-cases/sign-out.usecase';
import {
  BackchannelLogoutBody,
  SessionsQuery,
  SessionSummaryResponse,
  SignedOutResponse,
} from './dto/session-management.dto';
import { CurrentSessionResponse } from './dto/session.dto';
import { CallbackQuery, LoginQuery } from './dto/sign-in.dto';

/** The value of one of the browser's cookies, as it sent it. */
function cookieOf(request: Request, name: string): unknown {
  return (request.cookies as Record<string, unknown> | undefined)?.[name];
}

/** The query of the URL the browser asked for, without its `?`. */
function queryOf(request: Request): string {
  return new URL(request.originalUrl, 'https://query.invalid').search.slice(1);
}

/** A redirect nothing may keep: it sets the browser's cookies. */
function navigate(response: Response, to: string): void {
  response.setHeader('Cache-Control', 'no-store');
  response.redirect(303, to);
}

/**
 * Sign-in through the API (0.5.5), the session it opens (0.5.6), and
 * signing out and managing one's sessions (0.5.7). The browser navigates to
 * sign-in's two routes: they answer with redirects and cookies, not
 * `{ data }`, are public, and are in the `auth` rate-limit category (0.3.8).
 * The session routes need the session, and their writes its CSRF token.
 * Back-channel logout is public: the provider's signed token is its proof.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly callbackPath: string;

  constructor(
    private readonly signIn: SignInUseCase,
    private readonly readSession: ReadSessionUseCase,
    private readonly signOut: SignOutUseCase,
    private readonly ownSessions: OwnSessionsUseCase,
    private readonly backchannel: BackchannelLogoutUseCase,
    config: ConfigService<Env, true>,
  ) {
    const prefix = config.get('API_PREFIX', { infer: true });
    this.callbackPath = `/${prefix}/v${API_VERSION}/auth/callback`;
  }

  @Public()
  @RateLimit('auth')
  @Get('login')
  @ApiOperation({
    summary: 'Sign in: to the identity provider, for the tenant of the host',
  })
  @Redirects('To the identity provider', [PREAUTH_COOKIE])
  @Raises('NOT_FOUND')
  async login(
    @Req() request: Request,
    @Res() response: Response,
    @Query({ schema: LoginQuery }) query: LoginQuery,
  ): Promise<void> {
    const started = await this.signIn.begin({
      arrival: request,
      callbackPath: this.callbackPath,
      returnTo: query.returnTo ?? '/',
      preauth: cookieOf(request, PREAUTH_COOKIE),
    });
    response.cookie(PREAUTH_COOKIE, started.preauth, {
      ...COOKIE_ATTRIBUTES,
      maxAge: started.preauthMaxAgeMs,
    });
    navigate(response, started.authorizationUrl.href);
  }

  @Public()
  @RateLimit('auth')
  @Get('callback')
  @ApiOperation({
    summary: "The identity provider's answer: signed in, back where it began",
  })
  @Redirects('Signed in: to where sign-in began', [
    SESSION_COOKIE,
    PREAUTH_COOKIE,
  ])
  @Raises('AUTHENTICATION_REQUIRED', 'NOT_FOUND')
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query({ schema: CallbackQuery }) _answer: CallbackQuery,
  ): Promise<void> {
    const preauth = cookieOf(request, PREAUTH_COOKIE);
    // One callback per pre-auth cookie: it is cleared whatever the outcome,
    // and so is any page that answers here.
    response.clearCookie(PREAUTH_COOKIE, COOKIE_ATTRIBUTES);
    response.setHeader('Cache-Control', 'no-store');
    const signedIn = await this.signIn.complete({
      arrival: request,
      query: queryOf(request),
      preauth,
    });
    response.cookie(SESSION_COOKIE, signedIn.sessionToken, {
      ...COOKIE_ATTRIBUTES,
      maxAge: signedIn.sessionMaxAgeMs,
    });
    navigate(response, signedIn.returnTo);
  }

  @Get('session')
  @ApiOperation({
    summary:
      "The signed-in member's session, and the CSRF token its writes carry",
  })
  @Returns(CurrentSessionResponse)
  session(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentSession> {
    // It carries the CSRF token: no cache may keep it.
    response.setHeader('Cache-Control', 'no-store');
    return this.readSession.execute(ctx);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Sign out: this session ends, and the provider's sign-out page is named",
  })
  @Returns(SignedOutResponse)
  async logout(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedOut> {
    const signedOut = await this.signOut.execute(ctx, {
      arrival: request,
      everywhere: false,
    });
    signedOutOf(response);
    return signedOut;
  }

  @Post('logout-all')
  @HttpCode(200)
  @ApiOperation({
    summary: "Sign out everywhere: every one of the member's sessions ends",
  })
  @Returns(SignedOutResponse)
  async logoutAll(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedOut> {
    const signedOut = await this.signOut.execute(ctx, {
      arrival: request,
      everywhere: true,
    });
    signedOutOf(response);
    return signedOut;
  }

  @Get('sessions')
  @ApiOperation({ summary: "The member's own live sessions, newest first" })
  @ReturnsPage(SessionSummaryResponse)
  sessions(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Query({ schema: SessionsQuery }) query: SessionsQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Page<ListedSession>> {
    response.setHeader('Cache-Control', 'no-store');
    return this.ownSessions.list(ctx, query);
  }

  @Delete('sessions/:id')
  @ApiOperation({ summary: "End one of the member's own sessions" })
  @Returns(z.null())
  async endSession(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Res({ passthrough: true }) response: Response,
  ): Promise<null> {
    const { wasCurrent } = await this.ownSessions.revoke(ctx, id);
    // Ending this browser's own session signs this browser out.
    if (wasCurrent) signedOutOf(response);
    return null;
  }

  @Public()
  @Post('backchannel-logout')
  @HttpCode(200)
  @ApiConsumes('application/x-www-form-urlencoded')
  @ApiOperation({
    summary:
      "The identity provider's back-channel logout: the sessions its token names end",
  })
  @Returns(z.null())
  async backchannelLogout(
    @Body({ schema: BackchannelLogoutBody }) body: BackchannelLogoutBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<null> {
    response.setHeader('Cache-Control', 'no-store');
    await this.backchannel.execute(body.logout_token);
    return null;
  }
}

/** The session cookie cleared, with the attributes it was set with. */
function signedOutOf(response: Response): void {
  response.clearCookie(SESSION_COOKIE, COOKIE_ATTRIBUTES);
  response.setHeader('Cache-Control', 'no-store');
}
