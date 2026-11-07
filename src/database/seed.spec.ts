import { describe, expect, it } from 'vitest';
import { run } from './seed';

/** Runs the command with `env`, collecting what it writes. */
async function seedWith(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await run(
    argv,
    env,
    (text) => (out += text),
    (text) => (err += text),
  );
  return { code, out, err };
}

describe('the seed command', () => {
  it('the_seed_refuses_a_staging_or_production_database', async () => {
    for (const NODE_ENV of ['staging', 'production', '']) {
      const { code, out, err } = await seedWith([], { NODE_ENV });
      expect(code).toBe(2);
      expect(out).toBe('');
      expect(err).toContain('only into a development or test database');
    }
  });

  it('the_seed_takes_no_arguments', async () => {
    const { code, err } = await seedWith(['--tenant', 'sadara'], {
      NODE_ENV: 'development',
    });
    expect(code).toBe(2);
    expect(err).toContain('it takes no arguments');
  });
});
