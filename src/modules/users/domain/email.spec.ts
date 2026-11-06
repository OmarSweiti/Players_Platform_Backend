import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email';

// An address's normal form (0.4.9; DB-10), as the database's CHECK computes
// it: lower(btrim(normalize(email, NFKC), E' \t\r\n')).

describe('normalizeEmail', () => {
  it('an_address_is_compatibility_normalised_trimmed_and_lower_cased', () => {
    expect(normalizeEmail(' \t\r\nMember@Agency.TEST\n\r\t ')).toBe(
      'member@agency.test',
    );
    // NFKC: a fullwidth letter is its ASCII letter.
    expect(normalizeEmail('ｍember@agency.test')).toBe('member@agency.test');
    // A no-break space is a space once normalised, and so trimmed, as the
    // database's rule trims it.
    expect(normalizeEmail('\u00a0member@agency.test')).toBe(
      'member@agency.test',
    );
    // Only those four spaces, and only at the ends: a vertical tab stays.
    expect(normalizeEmail('\vmember@agency.test')).toBe('\vmember@agency.test');
    expect(normalizeEmail('mem \tber@agency.test')).toBe(
      'mem \tber@agency.test',
    );
    expect(normalizeEmail(' \t ')).toBe('');
  });

  it('normalising_takes_linear_time_on_runs_of_spaces', () => {
    // Spaces inside, not at the end: an anchored regular expression retries
    // the run from each of its positions, about 2·10¹⁰ steps here, far past
    // the test's time limit. A scan from each end reads it once.
    const hostile = `a${'\t'.repeat(200_000)}a`;
    expect(normalizeEmail(hostile)).toBe(hostile);
    expect(normalizeEmail(`${' '.repeat(200_000)}a`)).toBe('a');
  });
});
