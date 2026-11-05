import { z } from 'zod';
import {
  cursorPaging,
  id,
  instant,
} from '../../../../common/validation/schemas';

/** What signing out answers (0.5.7). */
export const SignedOutResponse = z
  .strictObject({
    revoked: z.int().min(0).describe('How many sessions it ended'),
    endSessionUrl: z
      .url()
      .nullable()
      .describe(
        'Where the browser goes to sign out at the identity provider too; null when it did not answer',
      ),
  })
  .meta({ id: 'SignedOut' });

/** One of the member's own live sessions (0.5.7). */
export const SessionSummaryResponse = z
  .strictObject({
    id,
    createdAt: instant.describe('When it was signed in'),
    lastSeenAt: instant,
    idleExpiresAt: instant,
    absoluteExpiresAt: instant,
    acr: z.string().nullable().describe('The assurance asserted at sign-in'),
    current: z.boolean().describe("Whether it is this browser's"),
  })
  .meta({ id: 'SessionSummary' });

export const SessionsQuery = z.strictObject(cursorPaging);
export type SessionsQuery = z.infer<typeof SessionsQuery>;

/**
 * The identity provider's back-channel logout (OpenID Connect Back-Channel
 * Logout 1.0, section 2.5): one form-encoded `logout_token`. The provider
 * writes it, so what it may add is ignored, never refused.
 */
export const BackchannelLogoutBody = z.looseObject({
  logout_token: z.string().min(1).max(16_384),
});
export type BackchannelLogoutBody = z.infer<typeof BackchannelLogoutBody>;
