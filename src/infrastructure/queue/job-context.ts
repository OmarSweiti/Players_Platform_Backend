import {
  type AuthorizedTenantContext,
  mintTenantContext,
} from '../../common/tenancy/tenant-context';
import { isRequestId, newRequestId } from '../logging/correlation';

/**
 * The context a job runs in (0.7.6): the tenant the job names, the system as
 * the actor doing `job`, and the request the job carries on — or a new id,
 * when it carries none. The job loader is one of the few minters
 * (eslint.config.mjs): a job's tenant is the one its data names, and every
 * read it makes is checked against that tenant under row-level security, so a
 * job naming another tenant's record finds nothing.
 */
export function jobContext(
  tenantId: string,
  job: string,
  requestId?: string | null,
): AuthorizedTenantContext {
  return mintTenantContext({
    tenantId,
    actor: { kind: 'SYSTEM', job },
    requestId: isRequestId(requestId) ? requestId : newRequestId(),
    locale: 'en',
  });
}
