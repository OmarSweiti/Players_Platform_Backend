import type { UserRole } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

/** The signed-in member's own session, as the web app shows it (0.5.6). */
export interface SessionView {
  readonly member: {
    readonly id: string;
    readonly role: UserRole;
    readonly firstName: string | null;
    readonly lastName: string | null;
  };
  readonly tenant: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly locale: 'ar' | 'en';
  };
  /** SHA-256 of the session cookie's value: its CSRF token is derived from it. */
  readonly tokenHash: Uint8Array;
}

/**
 * The context's own session (0.5.6): a port the module wires to
 * SessionViewRepository. It reads the session the context was minted for,
 * never one a caller names.
 */
export abstract class SessionViews {
  abstract ofContext(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
  ): Promise<SessionView | null>;
}
