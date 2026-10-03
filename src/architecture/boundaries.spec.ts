import { describe, expect, it } from 'vitest';

// The real rules of .dependency-cruiser.cjs, run over a fixture tree in which
// each rule is broken exactly once, next to imports they must allow
// (test/architecture/fixtures). The package is ES-module only, hence the
// dynamic imports.
const FIXTURES = 'test/architecture/fixtures';

describe('the module boundary gate', () => {
  it('module_boundary_gate_rejects_repository_and_framework_leaks', async () => {
    const { cruise } = await import('dependency-cruiser');
    const { default: extractDepcruiseOptions } =
      await import('dependency-cruiser/config-utl/extract-depcruise-options');
    const { default: extractTSConfig } =
      await import('dependency-cruiser/config-utl/extract-ts-config');
    const options = await extractDepcruiseOptions('./.dependency-cruiser.cjs');

    const { output } = await cruise(
      ['src'],
      { ...options, baseDir: FIXTURES },
      undefined,
      { tsConfig: extractTSConfig('tsconfig.json') },
    );
    if (typeof output === 'string') throw new Error('expected a cruise result');

    const violations = output.summary.violations
      .map(({ rule, from }) => `${rule.name}: ${from}`)
      .sort();
    expect(violations).toEqual([
      'adapters-are-wired-by-composition-roots: src/modules/alpha/application/alpha.usecase.ts',
      'domain-is-framework-free: src/modules/alpha/domain/uses-nest.ts',
      'domain-is-innermost: src/modules/alpha/domain/uses-application.ts',
      'modules-meet-through-their-application: src/modules/alpha/alpha.module.ts',
      'presentation-skips-infrastructure: src/modules/alpha/presentation/alpha.controller.ts',
      'shared-code-reaches-modules-through-their-application: src/common/reaches-in.ts',
    ]);
  });
});
