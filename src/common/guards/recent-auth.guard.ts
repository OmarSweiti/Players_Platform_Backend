import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { API_VERSION } from '../../app.setup';
import type { Env } from '../../config/env.schema';
import { AssurancePolicy } from '../../modules/identity/application/assurance.policy';
import { RECENT_AUTH_KEY } from '../decorators/requires-recent-auth.decorator';
import { StepUpRequiredError } from '../errors/domain-error';
import type { RequestSession } from '../interfaces/request-with-user.interface';

/**
 * A route marked @RequiresRecentAuth() runs only for a session whose member
 * authenticated within the last five minutes (0.5.8); otherwise it answers
 * `403 STEP_UP_REQUIRED`, naming the step-up route, where the browser goes —
 * with `returnTo` — to authenticate again and come back. A global guard,
 * after permissions: a member who may not act at all is not asked to
 * authenticate first.
 */
@Injectable()
export class RecentAuthGuard implements CanActivate {
  private readonly stepUpUrl: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly assurance: AssurancePolicy,
    config: ConfigService<Env, true>,
  ) {
    const prefix = config.get('API_PREFIX', { infer: true });
    this.stepUpUrl = `/${prefix}/v${API_VERSION}/auth/step-up`;
  }

  canActivate(context: ExecutionContext): boolean {
    const sensitive = this.reflector.getAllAndOverride<boolean>(
      RECENT_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!sensitive) return true;
    const { session } = context
      .switchToHttp()
      .getRequest<{ session?: RequestSession }>();
    if (session && this.assurance.isRecent(session.authTime)) return true;
    throw new StepUpRequiredError(this.stepUpUrl);
  }
}
