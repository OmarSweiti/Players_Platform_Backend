import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { API_VERSION } from '../../../app.setup';
import { Public } from '../../../common/decorators/public.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import { Raises, Redirects, Returns } from '../../../common/openapi/responses';
import { RateLimit } from '../../../common/rate-limit/rate-limit.decorator';
import {
  COOKIE_ATTRIBUTES,
  PREAUTH_COOKIE,
  SESSION_COOKIE,
} from '../../../common/security/session-cookies';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import type { Env } from '../../../config/env.schema';
import {
  type CurrentSession,
  ReadSessionUseCase,
} from '../application/use-cases/read-session.usecase';
import { SignInUseCase } from '../application/use-cases/sign-in.usecase';
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
 * Sign-in through the API (0.5.5), and the session it opens (0.5.6). The
 * browser navigates to sign-in's two routes: they answer with redirects and
 * cookies, not `{ data }`, are public, and are in the `auth` rate-limit
 * category (0.3.8). The session's own route needs the session.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly callbackPath: string;

  constructor(
    private readonly signIn: SignInUseCase,
    private readonly readSession: ReadSessionUseCase,
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
}
