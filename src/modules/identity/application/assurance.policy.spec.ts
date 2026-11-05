import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../common/time/clock';
import {
  admits,
  AssurancePolicy,
  assertsSecondFactor,
  needsSecondFactor,
  PRIVILEGED_ROLES,
} from './assurance.policy';

describe('the assurance policy', () => {
  it('privileged_roles_need_a_second_factor', () => {
    expect([...PRIVILEGED_ROLES].sort()).toEqual([
      'ADMIN',
      'FINANCE_MANAGER',
      'LEGAL',
      'MEDICAL',
      'OWNER',
      'PHYSIOTHERAPIST',
      'SPORTING_DIRECTOR',
      'SUPER_ADMIN',
    ]);
    expect(needsSecondFactor('COACH')).toBe(false);
    expect(needsSecondFactor('SCOUT')).toBe(false);
    for (const [acr, second] of [
      ['2', true],
      ['3', true],
      ['1', false],
      ['0', false],
      ['', false],
      ['silver', false],
      ['2.5', false],
      [null, false],
      [undefined, false],
    ] as const) {
      expect([acr, assertsSecondFactor(acr)]).toEqual([acr, second]);
    }
    expect(admits('ADMIN', '1')).toBe(false);
    expect(admits('ADMIN', '2')).toBe(true);
    expect(admits('COACH', '1')).toBe(true);
    expect(admits('COACH', undefined)).toBe(true);
  });

  it('recent_means_within_five_minutes', () => {
    const policy = new AssurancePolicy(fixedClock('2026-11-05T12:00:00Z'));
    expect(policy.isRecent(new Date('2026-11-05T11:55:00Z'))).toBe(true);
    expect(policy.isRecent(new Date('2026-11-05T11:54:59.999Z'))).toBe(false);
  });
});
