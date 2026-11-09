import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { PERMISSION_KEYS } from '../../../users/domain/permission-catalog';

/** The signed-in member's own session (0.5.6, 0.6.6): `GET /api/v1/auth/session`. */
export const CurrentSessionResponse = z
  .strictObject({
    member: z.strictObject({
      id: z.uuid(),
      role: z
        .enum(UserRole)
        .exclude(['SUPER_ADMIN'])
        .describe(
          "The member's tenant role: never SUPER_ADMIN, a platform role no membership holds (0.6.7)",
        ),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
    }),
    tenant: z.strictObject({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      locale: z.enum(['ar', 'en']).describe('The language members start in'),
    }),
    permissions: z
      .array(z.enum(PERMISSION_KEYS))
      .describe(
        "The permissions the member's role holds, in the catalog's order (0.6.6): for shaping navigation only — the API decides every call",
      ),
    csrfToken: z
      .string()
      .describe('Sent back in X-CSRF-Token with every write of this session'),
  })
  .meta({ id: 'CurrentSession' });
