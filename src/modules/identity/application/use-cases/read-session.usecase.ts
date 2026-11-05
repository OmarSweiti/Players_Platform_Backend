import { Injectable } from '@nestjs/common';
import { AuthenticationRequiredError } from '../../../../common/errors/domain-error';
import { CsrfTokens } from '../../../../common/security/csrf-tokens';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { type SessionView, SessionViews } from '../ports/session-views.port';

/** What `GET /api/v1/auth/session` answers (0.5.6). */
export interface CurrentSession {
  readonly member: SessionView['member'];
  readonly tenant: SessionView['tenant'];
  /** Sent back in `X-CSRF-Token` with every write. */
  readonly csrfToken: string;
}

/**
 * The signed-in member's own session (0.5.6): who they are, which tenant, and
 * the CSRF token their writes carry — derived from the session, never stored,
 * so every tab reads the same one until the session rotates (ADR-0003). The
 * web app asks here; it never reads a cookie, which its scripts cannot see.
 */
@Injectable()
export class ReadSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly views: SessionViews,
    private readonly csrf: CsrfTokens,
  ) {}

  async execute(ctx: AuthorizedTenantContext): Promise<CurrentSession> {
    const view = await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.views.ofContext(tx, ctx),
    );
    // The guard has just found it; gone since, it signs nobody in.
    if (!view) throw new AuthenticationRequiredError('the session is gone');
    return {
      member: view.member,
      tenant: view.tenant,
      csrfToken: this.csrf.issue(view.tokenHash),
    };
  }
}
