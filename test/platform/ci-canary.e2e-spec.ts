import { describe, expect, it } from 'vitest';

// Deliberately failing: proves that a red API test turns the required `test`
// check red (0.2.8). Removed by the next commit of the same pull request.
describe('the CI canary', () => {
  it('a_failing_e2e_test_turns_the_required_check_red', () => {
    expect('red').toBe('green');
  });
});
