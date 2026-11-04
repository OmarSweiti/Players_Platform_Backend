import type { Clock } from './clock';
import type { TimeZone } from './time-zone';

/**
 * A calendar day, `YYYY-MM-DD`: a birth date, a passport's expiry, a contract's
 * last day (0.4.8; ADR-0007). It is the same day for every reader, wherever
 * they are; it is never an instant, and never midnight in some zone.
 */
export type CivilDate = string & { readonly __brand: 'CivilDate' };

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day in `YYYY-MM-DD`; anything else, such as 2026-02-30, is refused. */
export function parseCivilDate(value: string): CivilDate {
  const parts = SHAPE.exec(value);
  if (!parts) throw new RangeError('a civil date is YYYY-MM-DD');
  const [year, month, day] = parts.slice(1).map((part) => parseInt(part, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError('not a day of the calendar');
  }
  return value as CivilDate;
}

/**
 * Prisma reads and writes a DATE column as a Date at midnight UTC of that day;
 * these two convert at that boundary and nowhere else, so no local time zone
 * ever moves a day.
 */
export function civilDateToDatabase(date: CivilDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function civilDateFromDatabase(stored: Date): CivilDate {
  return stored.toISOString().slice(0, 10) as CivilDate;
}

/** The calendar day it is now in `zone`. */
export function todayIn(zone: TimeZone, clock: Clock): CivilDate {
  // en-CA writes YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(clock.now()) as CivilDate;
}
