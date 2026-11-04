import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationFailedError } from '../errors/domain-error';
import { ISO_4217_MINOR_UNITS } from './iso-4217';
import { Money } from './money';

/** The field errors a parse is refused with, or 'accepted'. */
function refusalOf(parse: () => unknown) {
  try {
    parse();
    return 'accepted';
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationFailedError);
    return (error as ValidationFailedError).fieldIssues;
  }
}

describe('Money', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('jod_amounts_keep_three_decimals', () => {
    expect(Money.parse('1.255', 'JOD').toWire()).toEqual({
      amount: '1.255',
      currency: 'JOD',
    });
    // The wire always carries the currency's decimals, padded, never trimmed.
    expect(Money.parse('1250.5', 'JOD').toWire()).toEqual({
      amount: '1250.500',
      currency: 'JOD',
    });
    expect(Money.parse('0', 'JOD').toWire().amount).toBe('0.000');
    // Every three-decimal currency is held the same way.
    for (const currency of ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']) {
      expect(ISO_4217_MINOR_UNITS[currency as 'JOD']).toBe(3);
      expect(Money.parse('7.125', currency).toWire().amount).toBe('7.125');
    }
    // A wire amount parses back to the same money.
    const salary = Money.parse('3250.75', 'JOD');
    const { amount, currency } = salary.toWire();
    expect(Money.parse(amount, currency).toWire()).toEqual(salary.toWire());
    expect(salary.format('en')).toBe('JOD\u00a03,250.750'); // a no-break space, as Intl writes it
  });

  it('excess_scale_is_refused_not_rounded', () => {
    const amount = [{ field: '/amount', code: 'INVALID_FORMAT' }];
    expect(refusalOf(() => Money.parse('1.255', 'USD'))).toEqual(amount);
    expect(refusalOf(() => Money.parse('1.250', 'USD'))).toEqual(amount); // equal in value, too precise as written
    expect(refusalOf(() => Money.parse('1.5', 'JPY'))).toEqual(amount);
    expect(refusalOf(() => Money.parse('1.25555', 'CLF'))).toEqual(amount);
    expect(refusalOf(() => Money.parse('1.2555', 'CLF'))).toBe('accepted'); // four decimals

    // Not a plain decimal: never coerced.
    for (const bad of [
      'NaN',
      'Infinity',
      '1e3',
      '1.',
      '.5',
      '01',
      ' 1',
      '+1',
      '',
      '1,000',
    ]) {
      expect([bad, refusalOf(() => Money.parse(bad, 'USD'))]).toEqual([
        bad,
        [{ field: '/amount', code: 'INVALID_FORMAT' }],
      ]);
    }
    expect(refusalOf(() => Money.parse('-1.00', 'USD'))).toEqual([
      { field: '/amount', code: 'OUT_OF_RANGE' },
    ]);
    expect(refusalOf(() => Money.parse('-Infinity', 'USD'))).toEqual([
      { field: '/amount', code: 'OUT_OF_RANGE' },
    ]);
    // NUMERIC(19,4) holds fifteen digits before the point.
    expect(refusalOf(() => Money.parse('999999999999999.99', 'USD'))).toBe(
      'accepted',
    );
    expect(refusalOf(() => Money.parse('1000000000000000', 'USD'))).toEqual([
      { field: '/amount', code: 'TOO_BIG' },
    ]);
    // A currency that is not ISO 4217's, or has no minor units, is refused.
    for (const currency of ['XYZ', 'jod', 'XAU', 'XXX']) {
      expect(refusalOf(() => Money.parse('1', currency))).toEqual([
        { field: '/currency', code: 'INVALID_VALUE' },
      ]);
    }
    // The field errors point into the input; the message never carries the amount.
    const salary = () => Money.parse('12345.678', 'USD', '/salary');
    expect(refusalOf(salary)).toEqual([
      { field: '/salary/amount', code: 'INVALID_FORMAT' },
    ]);
    expect(salary).toThrow(
      'USD has 2 decimals: the amount is refused, not rounded',
    );
    // Two currencies are never added.
    expect(
      refusalOf(() => Money.parse('1', 'JOD').add(Money.parse('1', 'USD'))),
    ).toEqual([{ field: '', code: 'INVALID_VALUE' }]);
  });

  it('money_never_passes_through_a_javascript_number', () => {
    const parseFloat = vi.spyOn(globalThis, 'parseFloat');
    const toNumber = vi.spyOn(Prisma.Decimal.prototype, 'toNumber');

    // Nineteen significant digits: more than a double holds.
    const largest = Money.parse('999999999999999.9999', 'CLF');
    expect(largest.toWire().amount).toBe('999999999999999.9999');
    expect(largest.toDecimal().toFixed(4)).toBe('999999999999999.9999');
    // Sums a double would get wrong come out exact.
    expect(
      Money.parse('0.10', 'USD').add(Money.parse('0.20', 'USD')).toWire(),
    ).toEqual({ amount: '0.30', currency: 'USD' });
    const sum = Money.parse('123456789012345.67', 'USD').add(
      Money.parse('0.01', 'USD'),
    );
    expect(sum.toWire().amount).toBe('123456789012345.68');
    // So does the reader's form, in both languages.
    expect(sum.format('en')).toBe('$123,456,789,012,345.68');
    expect(sum.format('ar').replace(/\D/g, '')).toBe('12345678901234568');
    // And an amount read back from PostgreSQL.
    expect(
      Money.fromDatabase(new Prisma.Decimal('1250.1250'), 'JOD').toWire(),
    ).toEqual({ amount: '1250.125', currency: 'JOD' });

    expect(parseFloat).not.toHaveBeenCalled();
    expect(toNumber).not.toHaveBeenCalled();
    // Nor does the module's code convert one: no Number, parseFloat,
    // parseInt or toNumber outside its comments.
    const code = readFileSync(join(__dirname, 'money.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bNumber\b|parseFloat|parseInt|toNumber/);
  });
});
