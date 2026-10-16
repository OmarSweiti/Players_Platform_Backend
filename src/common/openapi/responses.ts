import { SetMetadata } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { z } from 'zod';
import type { ErrorCode } from '../errors/error-codes';

export const RAISES_KEY = 'sadara:raises';

const DESCRIPTION = { 200: 'OK', 201: 'Created', 202: 'Accepted' } as const;

/**
 * What a route answers on success: its resource, inside the `{ data }` every
 * success shares (envelope.interceptor.ts). Every operation declares one, or
 * the contract is not generated (contract.ts). A command with nothing to
 * return answers `{ data: null }`: `@Returns(z.null())`. `202` means a job
 * was accepted, not that its effect happened.
 */
export function Returns(
  schema: z.ZodType,
  { status = 200 }: { status?: keyof typeof DESCRIPTION } = {},
) {
  return ApiResponse({
    status,
    description: DESCRIPTION[status],
    standardSchema: z.strictObject({ data: schema }),
  });
}

/** What a list route answers: one page of its items (paginate.ts). */
export function ReturnsPage(item: z.ZodType) {
  return ApiResponse({
    status: 200,
    description: DESCRIPTION[200],
    standardSchema: z.strictObject({
      data: z.array(item),
      page: z.strictObject({
        nextCursor: z
          .string()
          .nullable()
          .describe('Passed as `cursor` for the next page'),
        hasMore: z.boolean(),
      }),
    }),
  });
}

/**
 * The problems this route raises itself, beyond those the HTTP pipeline adds
 * to every route that can meet them (contract.ts): a conflict, an invalid
 * transition, a dependency it checks. The contract declares each with its
 * status and its code.
 */
export function Raises(...codes: [ErrorCode, ...ErrorCode[]]) {
  return SetMetadata(RAISES_KEY, codes);
}
