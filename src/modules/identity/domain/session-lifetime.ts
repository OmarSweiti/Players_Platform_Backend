/**
 * How long a session lasts (ADR-0003; provisional, OPEN-02): 30 minutes
 * without a request, and 12 hours whatever happens. Renewal moves the idle
 * expiry and never the absolute one (0.5.6).
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

/** The expiries of a session opened at `openedAt`. */
export function lifetimesFrom(openedAt: Date): {
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
} {
  const at = openedAt.getTime();
  return {
    idleExpiresAt: new Date(at + SESSION_IDLE_MS),
    absoluteExpiresAt: new Date(at + SESSION_ABSOLUTE_MS),
  };
}
