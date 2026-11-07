import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { catalogDifferences } from '../../modules/users/domain/catalog-differences';

const SHOWN = 20;

/** The database's permission catalog or default matrix is not the code's: the API does not start. */
export class PermissionCatalogMismatch extends Error {
  constructor(readonly differences: readonly string[]) {
    const shown = differences.slice(0, SHOWN).join('; ');
    const more =
      differences.length > SHOWN
        ? `; and ${differences.length - SHOWN} more`
        : '';
    super(
      `The database's permissions are not the code's: ${shown}${more}. ` +
        'Apply the migrations (just migrate); a change to the catalog or the matrix ships a migration ' +
        "carrying scripts/generate-permission-sync.ts's output.",
    );
    this.name = new.target.name;
  }
}

/**
 * Refuses to start the API when `permissions` and `role_permissions` are not
 * the catalog and the default matrix in code (0.6.1; ADR-0005): every
 * permission check reads them, so a database the code does not describe would
 * answer some other matrix. It reads, as the runtime role, before any request
 * is served; it writes nothing.
 */
@Injectable()
export class PermissionCatalogCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(PermissionCatalogCheck.name);

  constructor(
    @Inject(PrismaService)
    private readonly prisma: Pick<
      PrismaClient,
      'permission' | 'rolePermission'
    >,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const [permissions, grants] = await Promise.all([
      this.prisma.permission.findMany({
        select: { name: true, category: true, action: true, description: true },
      }),
      this.prisma.rolePermission.findMany({
        select: { roleId: true, permission: { select: { name: true } } },
      }),
    ]);
    const differences = catalogDifferences(
      permissions,
      grants.map(({ roleId, permission }) => ({
        role: roleId,
        permission: permission.name,
      })),
    );
    if (differences.length === 0) return;
    const mismatch = new PermissionCatalogMismatch(differences);
    this.logger.error(mismatch.message);
    throw mismatch;
  }
}
