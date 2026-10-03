import { describe, expect, it } from 'vitest';
import { localeOf } from './locale';

describe('localeOf', () => {
  it.each([
    ['ar', 'ar'],
    ['ar-JO,ar;q=0.9,en;q=0.8', 'ar'],
    ['en-GB,en;q=0.9,ar;q=0.8', 'en'],
    ['fr-FR,fr;q=0.9,ar;q=0.5', 'ar'],
    ['en;q=0.3, ar;q=0.7', 'ar'],
    ['ar, en', 'ar'], // a tie goes to the first listed
    ['en, ar', 'en'],
  ])('answers %j in %s', (header, locale) => {
    expect(localeOf(header)).toBe(locale);
  });

  it.each([undefined, '', 'fr', '*', 'ar;q=0', 'ar;q=abc', 'arabic'])(
    'falls back to English for %j',
    (header) => {
      expect(localeOf(header)).toBe('en');
    },
  );
});
