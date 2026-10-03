// What an error may contribute to a log line: its class, a provider's error
// code, and where it was thrown. Never its message: a message carries the
// values that caused it — PostgreSQL quotes the input it rejected, Prisma
// prints the failing call — and those values are tokens, addresses, ids.

const PLAIN_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const FRAME = /^\s+at /;

/** `PrismaClientKnownRequestError P2007`, `TypeError`, `a thrown string`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const name = error.constructor.name || 'Error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PLAIN_CODE.test(code)
    ? `${name} ${code}`
    : name;
}

/**
 * The stack's frames without the message it starts with. The message is cut
 * out whole first, so a value that spans lines — even one shaped like a frame
 * — goes with it.
 */
export function stackFramesOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return undefined;
  }
  const stack = error.message
    ? error.stack.split(error.message).join('')
    : error.stack;
  const frames = stack.split('\n').filter((line) => FRAME.test(line));
  return frames.length > 0 ? frames.join('\n') : undefined;
}
