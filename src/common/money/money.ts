import { Prisma } from '@prisma/client';
import { type FieldIssue, ValidationFailedError } from '../errors/domain-error';
import type { FieldErrorCode } from '../errors/error-codes';
import { type CurrencyCode, ISO_4217_MINOR_UNITS } from './iso-4217';

export type { CurrencyCode } from './iso-4217';

/** An amount as it crosses the API: an exact decimal string, and its currency. */
export interface MoneyWire {
  amount: string;
  currency: CurrencyCode;
}

// Digits with at most one point: no sign, no exponent, no NaN or Infinity, no
// leading zero, no space. Anything else is refused, never coerced.
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
// NUMERIC(19,4) keeps four places, so fifteen digits before the point.
const MAX_WHOLE_DIGITS = 15;

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(ISO_4217_MINOR_UNITS, value);
}

/** The currency's official number of decimals (ISO 4217). */
export function minorUnitsOf(currency: CurrencyCode): number {
  return ISO_4217_MINOR_UNITS[currency];
}

// The message names the rule, never the amount: money is a finance field, and
// an error can reach a log (the security never-list).
function refused(
  field: string,
  code: FieldErrorCode,
  message: string,
): ValidationFailedError {
  const issue: FieldIssue = { field, code };
  return new ValidationFailedError(message, [issue]);
}

/**
 * An exact amount in one currency (0.4.7; ADR-0006). The amount is Prisma's
 * decimal, written to and read from NUMERIC(19,4) as it is; no JavaScript
 * floating-point value ever holds it. A payable amount is finite, not negative,
 * and has no more decimals than its currency: anything else is refused before
 * PostgreSQL could round it. Amounts in two currencies are never added; that
 * needs a recorded exchange rate, which does not exist yet (OPEN-09).
 */
export class Money {
  private constructor(
    readonly amount: Prisma.Decimal,
    readonly currency: CurrencyCode,
  ) {}

  /**
   * An amount from its wire form. `at` locates the pair in the input for the
   * field errors, as in `Money.parse(salary.amount, salary.currency, '/salary')`.
   */
  static parse(amount: string, currency: string, at = ''): Money {
    if (!isCurrencyCode(currency)) {
      throw refused(
        `${at}/currency`,
        'INVALID_VALUE',
        'not an ISO 4217 currency with defined minor units',
      );
    }
    const decimal = DECIMAL.exec(amount);
    if (!decimal) {
      throw refused(
        `${at}/amount`,
        amount.startsWith('-') ? 'OUT_OF_RANGE' : 'INVALID_FORMAT',
        'an amount is a plain, non-negative decimal string',
      );
    }
    const decimals = decimal[1]?.length ?? 0;
    if (decimals > minorUnitsOf(currency)) {
      throw refused(
        `${at}/amount`,
        'INVALID_FORMAT',
        `${currency} has ${minorUnitsOf(currency)} decimals: the amount is refused, not rounded`,
      );
    }
    if (amount.length - (decimals > 0 ? decimals + 1 : 0) > MAX_WHOLE_DIGITS) {
      throw refused(
        `${at}/amount`,
        'TOO_BIG',
        `an amount has at most ${MAX_WHOLE_DIGITS} digits before the point`,
      );
    }
    return new Money(new Prisma.Decimal(amount), currency);
  }

  /** An amount as PostgreSQL returned it, held to the same rules. */
  static fromDatabase(amount: Prisma.Decimal, currency: string): Money {
    return Money.parse(amount.toFixed(), currency);
  }

  /** The sum of two amounts in one currency. */
  add(other: Money): Money {
    if (other.currency !== this.currency) {
      throw refused(
        '',
        'INVALID_VALUE',
        `${this.currency} and ${other.currency} are not added without a recorded exchange rate`,
      );
    }
    return Money.parse(this.amount.plus(other.amount).toFixed(), this.currency);
  }

  /** The decimal to write to a NUMERIC(19,4) column. */
  toDecimal(): Prisma.Decimal {
    return this.amount;
  }

  /** The wire form, with exactly the currency's decimals: `{ amount: '1250.500', currency: 'JOD' }`. */
  toWire(): MoneyWire {
    return {
      amount: this.amount.toFixed(minorUnitsOf(this.currency)),
      currency: this.currency,
    };
  }

  /**
   * The amount as a reader sees it, in their language. Intl formats the
   * decimal string exactly; the cast only names that string's type for the
   * compiler.
   */
  format(locale: 'ar' | 'en'): string {
    const decimals = minorUnitsOf(this.currency);
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(this.amount.toFixed(decimals) as Intl.StringNumericLiteral);
  }
}
