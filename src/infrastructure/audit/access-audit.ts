import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import {
  ACCESS_AUDITED_CLASSES,
  type ConfidentialClass,
} from '../../common/policy/confidential-class';
import { projectAndRecord } from '../../common/policy/projection';
import type { AuthorizedTenantContext } from '../../common/tenancy/tenant-context';
import type { TenantTx } from '../../common/tenancy/tenant-transaction';
import { AuditService } from './audit.service';
import type { AuditAction } from './audited-actions';

/** An access event's action: a readable entity's `<entity>.read`. */
export type AccessAction = Extract<AuditAction, `${string}.read`>;

/** The record a response is read from: its access action and its id. */
export interface AccessedRecord {
  readonly action: AccessAction;
  readonly id: string;
}

/**
 * Access audit for confidential reads (0.7.4; I-5, docs/implementation/
 * 01-conventions.md). A response that carries a field of an access-audited
 * class — `IDENTITY`, `MEDICAL`, `LEGAL_INTERNAL` or `FINANCE` — is released
 * only through `release`: the projection is built, an access event records
 * who read which record's which classes, on the caller's transaction, and
 * only then is the response returned. If the event cannot be written, the
 * read fails and nothing is released; the transaction rolls back with it.
 *
 * The event is an audit row (`AuditService`, 0.7.2): the member, their role
 * and session, the request and its client, the record's entity and id, and
 * the classes' names — identifiers, never the content. A response that
 * carries no such field — none disclosed to this member — records nothing.
 * `project` refuses to release one (UnauditedRelease), so a use case cannot
 * skip this by projecting on its own. A list releases each record through
 * `release`, one event each.
 */
@Injectable()
export class AccessAudit {
  constructor(private readonly audit: AuditService) {}

  /** The response `schema` describes, released after its access event, if it needs one. */
  release<V>(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    record: AccessedRecord,
    response: { schema: z.ZodType; value: V },
    disclosed: ReadonlySet<ConfidentialClass>,
  ): Promise<V> {
    return projectAndRecord(
      response.schema,
      response.value,
      disclosed,
      (classes) =>
        this.audit.record(tx, ctx, {
          action: record.action,
          entityId: record.id,
          after: { classes },
        }),
    );
  }

  /**
   * A value wholly of one class, rather than of fields — a file's bytes,
   * through the link that serves them (0.8.5) — released after its access
   * event when that class is access-audited, on the caller's transaction, as
   * `release` does; an operational one, or `MINOR_POLICY`, as it is. The
   * policy has already disclosed the class to this member: this records the
   * release, it does not decide it.
   */
  async releaseWhole<V>(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    record: AccessedRecord,
    dataClass: ConfidentialClass | 'OPERATIONAL',
    value: V,
  ): Promise<V> {
    if (
      dataClass !== 'OPERATIONAL' &&
      ACCESS_AUDITED_CLASSES.includes(dataClass)
    ) {
      await this.audit.record(tx, ctx, {
        action: record.action,
        entityId: record.id,
        after: { classes: [dataClass] },
      });
    }
    return value;
  }
}
