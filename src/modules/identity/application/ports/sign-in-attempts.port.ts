/**
 * A sign-in in flight (0.5.5): what the callback needs to finish what the
 * login route began. It is short-lived protocol state, never a provider token
 * (docs/reference/database.md): losing one only aborts a sign-in.
 */
export interface SignInAttempt {
  /** The tenant of the host sign-in began on. */
  readonly tenantId: string;
  /** The callback the provider was asked to return to, which the exchange repeats. */
  readonly redirectUri: string;
  /** Where the browser goes once signed in: a path on this origin. */
  readonly returnTo: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /**
   * The browser that began it, base64url: the SHA-256 of its pre-auth
   * cookie's value, or, for a step-up, of its session cookie's (0.5.8).
   */
  readonly browserBinding: string;
  /** The assurance asked for: a second factor (0.5.8). */
  readonly acrValues?: string;
  /** The `max_age` asked for, which the answer's `auth_time` must meet. */
  readonly maxAge?: number;
  /** A step-up's: the session it renews, which the browser holds. */
  readonly stepUpSessionId?: string;
}

/**
 * Sign-ins in flight, by their state. Each is taken once: whoever takes it
 * first has it, and nobody can take it again.
 */
export abstract class SignInAttempts {
  /** Keeps `attempt` under `state` for `seconds`. */
  abstract keep(
    state: string,
    attempt: SignInAttempt,
    seconds: number,
  ): Promise<void>;

  /** The attempt under `state`, removed as it is read; null if none is kept. */
  abstract take(state: string): Promise<SignInAttempt | null>;
}
