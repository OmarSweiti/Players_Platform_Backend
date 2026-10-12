/** How many requests one client may make in a window, counted from its first. */
export interface RateLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The rate-limit categories (SR-API-008): every route counts its requests
 * against one, `default` unless it declares another with @RateLimit(). Each
 * is stricter than `default`. These are initial engineering defaults, to be
 * reviewed against measured traffic; docs/reference/api.md lists them.
 */
export const RATE_LIMITS = {
  /** Sign-in start and callback, invitation acceptance. */
  auth: { limit: 20, windowSeconds: 15 * 60 },
  /** Starting an upload. */
  upload: { limit: 60, windowSeconds: 10 * 60 },
  /** Requesting an export. */
  export: { limit: 10, windowSeconds: 60 * 60 },
  /** Sending a message. */
  message: { limit: 60, windowSeconds: 60 },
  /** Approvals, signature initiation, permission changes, support access. */
  privileged: { limit: 30, windowSeconds: 10 * 60 },
  /** Every other route. */
  default: { limit: 300, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>;

export type RateLimitCategory = keyof typeof RATE_LIMITS;
