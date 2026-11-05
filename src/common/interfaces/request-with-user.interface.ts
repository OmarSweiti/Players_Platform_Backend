import type { UserRole } from '@prisma/client';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';

/** The signed-in member, as the session guard found them: authentication fields only (0.5.6). */
export interface SessionMember {
  readonly id: string;
  readonly tenantId: string;
  readonly role: UserRole;
}

/**
 * The session a request was authenticated by: its id, its token's digest, and
 * when and how strongly its member last authenticated (0.5.8).
 */
export interface RequestSession {
  readonly id: string;
  readonly tokenHash: Uint8Array;
  readonly authTime: Date;
  readonly acr: string | null;
}

export interface RequestWithUser extends Request {
  user: SessionMember;
  tenantId?: string;
  session?: RequestSession;
  /** Minted by the session guard for the signed-in member (0.4.12; 0.5.6). */
  tenantContext?: AuthorizedTenantContext;
}
