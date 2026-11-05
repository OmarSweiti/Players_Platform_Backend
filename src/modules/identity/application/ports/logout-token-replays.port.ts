/**
 * The back-channel logout tokens already honoured (0.5.7), by issuer and
 * `jti`, so that a replayed token is refused. A token is accepted only within
 * a bounded age (the adapter's), so each needs remembering only that long.
 */
export abstract class LogoutTokenReplays {
  /**
   * Records the token for `seconds`: true the first time, false when it was
   * already recorded — a replay.
   */
  abstract claim(
    issuer: string,
    jti: string,
    seconds: number,
  ): Promise<boolean>;

  /** Forgets the token, when honouring it failed, so the provider may retry. */
  abstract release(issuer: string, jti: string): Promise<void>;
}
