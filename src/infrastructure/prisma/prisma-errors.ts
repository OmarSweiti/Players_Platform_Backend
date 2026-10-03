import { Prisma } from '@prisma/client';
import type { ErrorCode } from '../../common/errors/error-codes';

// The Prisma request errors a client can act on. Every other Prisma error is
// unexpected: a 500 that carries nothing of it.
const CODE_OF_PRISMA_ERROR = new Map<string, ErrorCode>([
  ['P2002', 'CONFLICT'], // a unique constraint would be violated
  ['P2003', 'CONFLICT'], // a foreign key would be violated
  ['P2025', 'NOT_FOUND'], // a record the operation needs does not exist
]);

/** The problem code of a Prisma error a client can act on, if it is one. */
export function problemCodeOfPrismaError(
  error: unknown,
): ErrorCode | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? CODE_OF_PRISMA_ERROR.get(error.code)
    : undefined;
}
