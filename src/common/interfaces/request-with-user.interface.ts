import { User } from '@prisma/client';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';

export interface RequestWithUser extends Request {
  user: User & { tenantId: string };
  tenantId?: string;
  /** Minted by the session guard for the signed-in member (0.4.12; 0.5.6). */
  tenantContext?: AuthorizedTenantContext;
}
