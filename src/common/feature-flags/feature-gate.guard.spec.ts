import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.schema';
import { behindFeature, FeatureGateGuard } from './feature-gate.guard';

class MedicalLikeController {}
class OpenController {}
behindFeature('medical', [MedicalLikeController]);

const gate = (flags: Partial<Env>) =>
  new FeatureGateGuard(new Reflector(), {
    get: (key: keyof Env) => flags[key] ?? false,
  } as unknown as ConfigService<Env, true>);

const httpContext = (controller: object): ExecutionContext =>
  ({
    getType: () => 'http',
    getClass: () => controller,
  }) as unknown as ExecutionContext;

describe('FeatureGateGuard', () => {
  it('lets a route through when its module is enabled', () => {
    expect(
      gate({ FEATURE_MEDICAL: true }).canActivate(
        httpContext(MedicalLikeController),
      ),
    ).toBe(true);
  });

  it('answers what an unknown route answers when its module is disabled', () => {
    const attempt = () =>
      gate({}).canActivate(httpContext(MedicalLikeController));
    // An unknown route raises NotFoundException too; the problem filter
    // answers both alike (test/platform/feature-flags.e2e-spec.ts).
    expect(attempt).toThrow(NotFoundException);
  });

  it('never gates a route outside a feature', () => {
    expect(gate({}).canActivate(httpContext(OpenController))).toBe(true);
  });
});
