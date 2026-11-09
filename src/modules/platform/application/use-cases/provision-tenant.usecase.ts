import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import type { ProvisioningEnv } from '../../../../config/env.schema';
import { AuditService } from '../../../../infrastructure/audit/audit.service';
import {
  AccountExistsError,
  IdentityProviderPort,
  type Locale,
} from '../../../identity/application/ports/identity-provider.port';
import { ProviderClients } from '../../../identity/application/ports/provider-clients.port';
import { normalizeEmail } from '../../../users/domain/email';
import { ProvisioningRecords } from '../ports/provisioning-records.port';

/** What the operator asks for: validated, lower case where it must be. */
export interface ProvisionTenant {
  readonly slug: string;
  readonly name: string;
  readonly domain?: string;
  readonly ownerEmail: string;
  readonly locale: Locale;
  /** Send the owner's setup email again, if their setup is still pending. */
  readonly resendSetupEmail: boolean;
}

/** What a run did. It never names the owner's address. */
export interface ProvisioningReport {
  readonly tenant: { id: string; slug: string; created: boolean };
  readonly hosts: ReadonlyArray<{ host: string; added: boolean }>;
  readonly owner: {
    membershipId: string;
    created: boolean;
    accountCreated: boolean;
  };
  readonly setupEmail: 'sent' | 'not-sent';
}

/** A tenant context for `tenantId`, minted by the operation's entry point. */
export type ContextFor = (tenantId: string) => AuthorizedTenantContext;

/**
 * Tenant provisioning (0.5.9; BR-OBJ-08): an audited platform operation, run
 * by an operator as a command, never an endpoint. It creates the tenant and
 * its domain; registers its hosts — the domain, and `{slug}.APEX_DOMAIN` —
 * with the identity provider; creates the owner's provider account with the
 * actions that make them verify their address, choose a password and set up
 * a second factor (an owner is privileged, 0.5.8); links that identity to an
 * `OWNER` membership; and has the provider send the setup email.
 *
 * It never takes a password: the owner chooses one at the provider. It is
 * idempotent per slug: a second run finds what the first made and changes
 * nothing, so a run that stopped part-way is finished by running it again.
 * Every run that changes something leaves one audit entry.
 */
@Injectable()
export class ProvisionTenantUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: ProvisioningRecords,
    private readonly provider: IdentityProviderPort,
    private readonly clients: ProviderClients,
    private readonly config: ConfigService<ProvisioningEnv, true>,
    private readonly audit: AuditService,
  ) {}

  async execute(
    input: ProvisionTenant,
    contextFor: ContextFor,
  ): Promise<ProvisioningReport> {
    const hosts = this.hostsOf(input);

    // The tenant: the one with this slug, or a new one.
    const probe = contextFor(randomUUID());
    const existing = await this.transactions.withTenantTransaction(
      probe,
      (tx) => this.records.tenantBySlug(tx, input.slug),
    );
    if (existing && (input.domain ?? null) !== existing.domain) {
      throw new ConflictError('the slug is a tenant with another domain');
    }
    const ctx = existing ? contextFor(existing.id) : probe;
    if (!existing) {
      await this.transactions.withTenantTransaction(ctx, (tx) =>
        this.records.createTenant(tx, ctx, {
          name: input.name,
          slug: input.slug,
          domain: input.domain ?? null,
          locale: input.locale,
        }),
      );
    }

    // A membership with the owner's address must already be this owner's:
    // checked before anything is made at the provider, so that a refusal
    // leaves nothing there. Never linked by address alone (0.5.3).
    const email = input.ownerEmail.trim().toLowerCase();
    const normalizedEmail = normalizeEmail(email);
    if (existing) {
      const member = await this.transactions.withTenantTransaction(ctx, (tx) =>
        this.records.memberByEmail(tx, ctx, normalizedEmail),
      );
      if (member) this.assertOwnerMembership(member);
    }

    // Its hosts, at the provider: exact addresses, never a wildcard.
    const registered: Array<{ host: string; added: boolean }> = [];
    for (const host of hosts) {
      registered.push({ host, ...(await this.clients.registerHost(host)) });
    }

    // The owner's account at the provider: found, or created with its
    // required actions — and never a password.
    let account = await this.provider.findAccount(email);
    let accountCreated = false;
    if (!account) {
      try {
        account = await this.provider.createAccount(email, input.locale, [
          'VERIFY_EMAIL',
          'SET_PASSWORD',
          'CONFIGURE_OTP',
        ]);
        accountCreated = true;
      } catch (error) {
        if (!(error instanceof AccountExistsError)) throw error;
        account = await this.provider.findAccount(email);
        if (!account) throw error;
      }
    }
    const subject = account.subject;

    // The identity, the OWNER membership and the audit, in one transaction.
    const issuer = this.config.get('OIDC_ISSUER', { infer: true });
    const owner = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) => {
        const identityId = await this.records.identityFor(tx, issuer, subject);
        const member = await this.records.memberByEmail(
          tx,
          ctx,
          normalizedEmail,
        );
        if (member) this.assertOwnerMembership(member, identityId);
        const membershipId =
          member?.id ??
          (await this.records.addOwner(tx, ctx, {
            email,
            normalizedEmail,
            identityId,
          }));
        const changed = {
          tenant: !existing,
          hosts: registered
            .filter(({ added }) => added)
            .map(({ host }) => host),
          account: accountCreated,
          membership: !member,
        };
        if (
          changed.tenant ||
          changed.hosts.length > 0 ||
          changed.account ||
          changed.membership
        ) {
          // What changed, and nothing personal: no address, no name.
          await this.audit.record(tx, ctx, {
            action: 'tenant.provisioned',
            entityId: ctx.tenantId,
            after: {
              slug: input.slug,
              domain: input.domain ?? null,
              ownerMembershipId: membershipId,
              tenantCreated: changed.tenant,
              hostsRegistered: changed.hosts,
              accountCreated: changed.account,
              membershipCreated: changed.membership,
            },
          });
        }
        return { membershipId, created: !member };
      },
    );

    // The setup email: once, when the account is made, or when asked again.
    let setupEmail: ProvisioningReport['setupEmail'] = 'not-sent';
    if (accountCreated || input.resendSetupEmail) {
      await this.provider.sendSetupEmail(subject);
      setupEmail = 'sent';
    }

    return {
      tenant: { id: ctx.tenantId, slug: input.slug, created: !existing },
      hosts: registered,
      owner: { ...owner, accountCreated },
      setupEmail,
    };
  }

  /**
   * An existing membership with the owner's address is acceptable only as
   * this owner's: linked to an identity — to `identityId`, once it is known
   * — and the owner.
   */
  private assertOwnerMembership(
    member: { role: string; identityId: string | null },
    identityId?: string,
  ): void {
    if (member.identityId === null) {
      throw new ConflictError(
        'a membership with this address has no identity, and is never linked by address alone',
      );
    }
    if (identityId !== undefined && member.identityId !== identityId) {
      throw new ConflictError(
        'a membership with this address belongs to another identity',
      );
    }
    if (member.role !== 'OWNER') {
      throw new ConflictError(
        'a membership with this address is not the owner',
      );
    }
  }

  /** The tenant's hosts: its own domain, and its name under APEX_DOMAIN. */
  private hostsOf(input: ProvisionTenant): string[] {
    const apex = this.config.get('APEX_DOMAIN', { infer: true });
    const hosts = [
      ...(input.domain ? [input.domain] : []),
      ...(apex ? [`${input.slug}.${apex}`] : []),
    ];
    if (hosts.length === 0) {
      throw new ValidationFailedError(
        'the tenant would have no host: give --domain, or set APEX_DOMAIN',
        [{ field: '/domain', code: 'REQUIRED' }],
      );
    }
    return [...new Set(hosts)];
  }
}
