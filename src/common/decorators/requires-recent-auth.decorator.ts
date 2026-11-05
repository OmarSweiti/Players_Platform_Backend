import { SetMetadata } from '@nestjs/common';

export const RECENT_AUTH_KEY = 'sadara:recent-auth';

/**
 * A sensitive action (0.5.8; SR-AUTH-002): role and permission changes,
 * approvals, signature evidence, confidential exports, support grants. It
 * needs an authentication within the last five minutes, or answers
 * `403 STEP_UP_REQUIRED` with where to authenticate again (RecentAuthGuard).
 */
export const RequiresRecentAuth = () => SetMetadata(RECENT_AUTH_KEY, true);
