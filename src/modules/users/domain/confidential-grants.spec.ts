import { describe, expect, it } from 'vitest';
import { CONFIDENTIAL_CLASSES } from '../../../common/policy/confidential-class';
import { CONFIDENTIAL_GRANTS } from './confidential-grants';
import { PERMISSION_CATALOG, PERMISSION_KEYS } from './permission-catalog';

describe('the confidential grants', () => {
  it('each_confidential_permission_grants_exactly_one_class', () => {
    const grants = CONFIDENTIAL_CLASSES.map(
      (confidentialClass) => CONFIDENTIAL_GRANTS[confidentialClass],
    ).filter((grant) => grant !== null);
    // A grant is a confidential permission of the catalog, and every
    // confidential permission is the grant of one class, and of one only.
    expect([...grants].sort()).toEqual(
      PERMISSION_KEYS.filter(
        (key) => PERMISSION_CATALOG[key].confidential,
      ).sort(),
    );
    expect(new Set(grants).size).toBe(grants.length);
    expect(Object.keys(CONFIDENTIAL_GRANTS).sort()).toEqual(
      [...CONFIDENTIAL_CLASSES].sort(),
    );
  });
});
