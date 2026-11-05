import { UserRole } from '@prisma/client';
import { z } from 'zod';

/** The signed-in member's own session (0.5.6): `GET /api/v1/auth/session`. */
export const CurrentSessionResponse = z
  .strictObject({
    member: z.strictObject({
      id: z.uuid(),
      role: z.enum(UserRole),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
    }),
    tenant: z.strictObject({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      locale: z.enum(['ar', 'en']).describe('The language members start in'),
    }),
    csrfToken: z
      .string()
      .describe('Sent back in X-CSRF-Token with every write of this session'),
  })
  .meta({ id: 'CurrentSession' });
