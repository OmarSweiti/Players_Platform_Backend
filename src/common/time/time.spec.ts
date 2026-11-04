import { describe, expect, it } from 'vitest';
import {
  civilDateFromDatabase,
  civilDateToDatabase,
  parseCivilDate,
  todayIn,
} from './civil-date';
import { fixedClock } from './clock';
import { isTimeZone, parseTimeZone } from './time-zone';

describe('time', () => {
  it('names only IANA zones, spelled as the zone database spells them', () => {
    for (const zone of [
      'Asia/Amman',
      'UTC',
      'Etc/UTC',
      'Pacific/Kiritimati',
      'Asia/Calcutta',
    ]) {
      expect([zone, isTimeZone(zone)]).toEqual([zone, true]);
    }
    for (const zone of [
      'Mars/Olympus',
      '+03:00',
      'UTC+3',
      'GMT-2',
      'asia/amman',
      ' Asia/Amman',
      '',
    ]) {
      expect([zone, isTimeZone(zone)]).toEqual([zone, false]);
    }
    expect(() => parseTimeZone('Mars/Olympus')).toThrow(RangeError);
  });

  it('keeps a calendar day a day', () => {
    expect(parseCivilDate('2024-02-29')).toBe('2024-02-29');
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-1-01',
      '2026-01-01T00:00:00Z',
      '',
    ]) {
      expect(() => parseCivilDate(bad)).toThrow(RangeError);
    }
    const day = parseCivilDate('1998-05-12');
    expect(civilDateToDatabase(day).toISOString()).toBe(
      '1998-05-12T00:00:00.000Z',
    );
    expect(civilDateFromDatabase(civilDateToDatabase(day))).toBe(day);
  });

  it('knows which day it is in a zone, from the clock it is given', () => {
    // 22:30 UTC on the 4th is already the 5th in Amman (UTC+3).
    const clock = fixedClock('2026-11-04T22:30:00Z');
    expect(todayIn(parseTimeZone('UTC'), clock)).toBe('2026-11-04');
    expect(todayIn(parseTimeZone('Asia/Amman'), clock)).toBe('2026-11-05');
    expect(todayIn(parseTimeZone('Pacific/Honolulu'), clock)).toBe(
      '2026-11-04',
    );
    expect(() => fixedClock('not a time')).toThrow(RangeError);
  });
});
