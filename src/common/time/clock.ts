/**
 * The time a rule reads (0.4.8; ADR-0007). A rule takes a Clock rather than
 * calling `new Date()`, so a test can fix the moment and a rule about "today"
 * or "expired" is decided by its input, not by when the suite runs.
 */
export interface Clock {
  now(): Date;
}

/** The token a Clock is injected by. */
export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };

/** A clock stopped at one instant, for tests. */
export function fixedClock(at: Date | string): Clock {
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('fixedClock needs a valid instant');
  }
  return { now: () => new Date(instant) };
}
