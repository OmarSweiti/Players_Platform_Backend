import { SetMetadata } from '@nestjs/common';

export const SIGNED_IN_KEY = 'signedIn';

/**
 * Any signed-in member, acting only on their own session (0.6.2): signing
 * out, re-authenticating, reading or ending one's own sessions. No role's
 * permissions can take these away, so a member can always leave. A route
 * that touches anyone else's data requires a permission instead.
 */
export const SignedIn = () => SetMetadata(SIGNED_IN_KEY, true);
