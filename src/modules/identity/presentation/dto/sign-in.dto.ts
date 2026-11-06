import { z } from 'zod';
import { isReturnPath, MAX_RETURN_PATH } from '../../domain/return-path';
import { isSecret } from '../../domain/secrets';

const returnTo = z
  .string()
  .max(MAX_RETURN_PATH)
  .refine(isReturnPath, {
    message: 'a path on this origin',
    params: { code: 'INVALID_FORMAT' },
  })
  .optional()
  .describe('Where to return once signed in: a path on this origin');

export const LoginQuery = z.strictObject({
  returnTo,
  invitation: z
    .string()
    .refine(isSecret, {
      message: "an invitation's token",
      params: { code: 'INVALID_FORMAT' },
    })
    .optional()
    .describe(
      "The token of an invitation's link (0.5.10): this sign-in accepts it",
    ),
});
export type LoginQuery = z.infer<typeof LoginQuery>;

/** A step-up returns where it began; it carries nothing else (0.5.8). */
export const StepUpQuery = z.strictObject({ returnTo });
export type StepUpQuery = z.infer<typeof StepUpQuery>;

const answer = z.string().max(2048).optional();

/**
 * The identity provider's answer. The provider writes this query, not a
 * client of this API: what it adds beyond these is passed on to the
 * exchange, never refused (RFC 6749, section 4.1.2). Each value is bounded;
 * the exchange checks them.
 */
export const CallbackQuery = z.looseObject({
  code: answer,
  state: answer,
  iss: answer,
  session_state: answer,
  error: answer,
  error_description: answer,
  error_uri: answer,
});
export type CallbackQuery = z.infer<typeof CallbackQuery>;
