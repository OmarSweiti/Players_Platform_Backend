import { Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';
import { type ErrorCode, PROBLEMS } from '../errors/error-codes';
import { describeError } from '../logging/describe-error';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../tenancy/tenant-transaction';
import type { IdempotentRequest } from './idempotent-request';
import { keyHashOf, requestHashOf } from './request-hash';

/**
 * How long a claim holds its key, and a record answers retries.
 * - `leaseSeconds`: a command runs well within it; a claim whose execution
 *   died is taken over once it runs out.
 * - `retentionHours`: a retry within it is answered from the record; after
 *   it the key is free again (docs/reference/api.md: at least 24 hours).
 * - `retryAfterSeconds`: what a duplicate sent while the first runs is told.
 */
export interface IdempotencyPolicy {
  readonly leaseSeconds: number;
  readonly retentionHours: number;
  readonly retryAfterSeconds: number;
}

export const IDEMPOTENCY: IdempotencyPolicy = {
  leaseSeconds: 30,
  retentionHours: 24,
  retryAfterSeconds: 1,
};

/** The key's first execution is still running: try again in a moment. */
export class IdempotencyInProgressError extends DomainError {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  constructor(
    override readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
  }
}

/** The key was used for another request: a key names one request only. */
export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';
}

/** A retry of a command its first execution refused: the same refusal. */
export class RefusalReplayed extends DomainError {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(`the first execution of this request was refused: ${code}`);
    this.code = code;
  }
}

/** Only a member's request takes a key: a programming error, answered as a 500. */
export class IdempotencyRefused extends Error {
  constructor(reason: string) {
    super(`idempotency refused: ${reason}`);
    this.name = 'IdempotencyRefused';
  }
}

/** What a command's first execution answers, and what a retry is rebuilt from. */
export interface CommandOutcome<T> {
  readonly result: T;
  /** The id of what it made or changed, if anything: `replay` receives it. */
  readonly resultRef?: string;
}

/**
 * A command a client may retry (docs/reference/api.md, "Idempotency state
 * machine"). The caller has already authorized it and validated its input:
 * a retry is authorized again by the same route and use case before it gets
 * here.
 */
export interface IdempotentCommand<T> {
  /**
   * The first execution: the command's effect, its audit and outbox, on the
   * transaction its outcome commits on. It alone checks the command's
   * preconditions, its `If-Match` among them.
   */
  execute(tx: TenantTx): Promise<CommandOutcome<T>>;
  /**
   * A retry of a success: the response rebuilt from what it made or changed,
   * as the caller may read it now — never the first response kept.
   */
  replay(tx: TenantTx, resultRef: string | null): Promise<T>;
}

/** A claim this execution holds, by its fencing generation. */
interface Claim {
  readonly id: string;
  readonly generation: number;
}

type Claimed =
  | ({ readonly kind: 'execute' } & Claim)
  | { readonly kind: 'replay'; readonly resultRef: string | null };

interface HeldRow {
  id: string;
  state: 'IN_PROGRESS' | 'SUCCEEDED' | 'REJECTED';
  generation: number;
  sameRequest: boolean;
  leased: boolean;
  expired: boolean;
  resultRef: string | null;
  outcomeCode: string | null;
}

const isErrorCode = (code: string | null): code is ErrorCode =>
  code !== null && Object.hasOwn(PROBLEMS, code);

/**
 * Idempotency keys for retried commands (0.7.7; I-10, SR-CORE-010). A
 * command's first execution claims its key, under a bounded lease, in a
 * transaction of its own; it then runs in another, which commits its effect
 * and its outcome together, under the claim's fencing generation. A retry of
 * the same request is answered from the outcome, without a second effect: a
 * success rebuilt by `replay`, a refusal as the same refusal. The same key
 * with another request is `IDEMPOTENCY_KEY_REUSED`; a duplicate while the
 * first runs is `IDEMPOTENCY_IN_PROGRESS`, with `Retry-After`. A claim whose
 * lease ran out is taken over, its generation incremented, so the execution
 * that held it cannot commit; whether an execution committed is never
 * guessed — its outcome commits with it, or not at all.
 */
@Injectable()
export class Idempotency {
  private readonly logger = new Logger('Idempotency');

  constructor(
    private readonly transactions: TenantTransactions,
    private readonly policy: IdempotencyPolicy = IDEMPOTENCY,
  ) {}

  /**
   * Runs `command` once for its key: its first execution, or the answer of
   * that execution to a retry. `input` is the request's validated input,
   * which, with its `If-Match`, a retry must repeat.
   */
  async run<T>(
    ctx: AuthorizedTenantContext,
    request: IdempotentRequest,
    input: unknown,
    command: IdempotentCommand<T>,
  ): Promise<T> {
    const claimed = await this.claim(ctx, request, input);
    if (claimed.kind === 'replay') {
      return this.transactions.withTenantTransaction(ctx, (tx) =>
        command.replay(tx, claimed.resultRef),
      );
    }
    return this.complete(ctx, claimed, command);
  }

  /**
   * Claims the key, or answers why not: the first claim of a key, a claim
   * whose lease ran out (its generation incremented) and the claim of an
   * expired key execute; a finished one replays; anything else is refused.
   * The claim commits before the command runs, so a duplicate sees it.
   */
  async claim(
    ctx: AuthorizedTenantContext,
    request: IdempotentRequest,
    input: unknown,
  ): Promise<Claimed> {
    if (ctx.actor.kind !== 'USER') {
      throw new IdempotencyRefused('only a member’s request takes a key');
    }
    const actorUserId = ctx.actor.userId;
    const keyHash = keyHashOf(request.key);
    const requestHash = requestHashOf(request, input);
    const { leaseSeconds, retentionHours, retryAfterSeconds } = this.policy;
    return this.transactions.withTenantTransaction(ctx, async (tx) => {
      const insert = () =>
        tx.$queryRaw<{ id: string }[]>`
          INSERT INTO idempotency_records
            (id, tenant_id, actor_user_id, method, canonical_path, key_hash,
             request_hash, lease_until, expires_at)
          VALUES (uuidv7(), ${ctx.tenantId}::uuid, ${actorUserId}::uuid,
                  ${request.method}, ${request.canonicalPath}, ${keyHash},
                  ${requestHash}, now() + make_interval(secs => ${leaseSeconds}),
                  now() + make_interval(hours => ${retentionHours}))
          ON CONFLICT (tenant_id, actor_user_id, method, canonical_path, key_hash)
            DO NOTHING
          RETURNING id::text AS id`;
      const [inserted] = await insert();
      if (inserted) return { kind: 'execute', id: inserted.id, generation: 1 };

      // The key is claimed: its record, as last committed. It is locked only
      // to be changed, and SKIP LOCKED then: a record locked is one whose
      // execution is committing now — no request is kept waiting on it.
      const [held] = await tx.$queryRaw<HeldRow[]>`
        SELECT id::text AS id, state::text AS state,
               fencing_generation AS generation,
               request_hash = ${requestHash} AS "sameRequest",
               lease_until > now() AS leased, expires_at <= now() AS expired,
               result_ref::text AS "resultRef", outcome_code AS "outcomeCode"
          FROM idempotency_records
         WHERE tenant_id = ${ctx.tenantId}::uuid
           AND actor_user_id = ${actorUserId}::uuid
           AND method = ${request.method}
           AND canonical_path = ${request.canonicalPath}
           AND key_hash = ${keyHash}`;
      const inProgress = (why: string) =>
        new IdempotencyInProgressError(retryAfterSeconds, why);
      if (!held) throw inProgress('the key is being claimed again');
      if (held.expired) {
        // An expired record answers nothing: the key is free again.
        const removed = await tx.$executeRaw`
          DELETE FROM idempotency_records
           WHERE id IN (
             SELECT id FROM idempotency_records
              WHERE id = ${held.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
                AND expires_at <= now()
              FOR UPDATE SKIP LOCKED)`;
        if (removed !== 1) throw inProgress('the expired key is being claimed');
        const [fresh] = await insert();
        if (!fresh) throw inProgress('the expired key was claimed meanwhile');
        return { kind: 'execute', id: fresh.id, generation: 1 };
      }
      if (!held.sameRequest) {
        throw new IdempotencyKeyReusedError(
          'the key was used for another request',
        );
      }
      if (held.state === 'SUCCEEDED') {
        return { kind: 'replay', resultRef: held.resultRef };
      }
      if (held.state === 'REJECTED') {
        // A code no longer in the contract is answered as a conflict.
        throw new RefusalReplayed(
          isErrorCode(held.outcomeCode) ? held.outcomeCode : 'CONFLICT',
        );
      }
      if (held.leased) throw inProgress('the key’s first execution is running');
      // Its execution died with the lease held: take the claim over, if no
      // one has meanwhile. The effect and the outcome commit together, so a
      // record still IN_PROGRESS is one whose effect never committed.
      const generation = held.generation + 1;
      const taken = await tx.$executeRaw`
        UPDATE idempotency_records
           SET fencing_generation = ${generation},
               lease_until = now() + make_interval(secs => ${leaseSeconds})
         WHERE id IN (
           SELECT id FROM idempotency_records
            WHERE id = ${held.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
              AND state = 'IN_PROGRESS' AND lease_until <= now()
              AND fencing_generation = ${held.generation}
            FOR UPDATE SKIP LOCKED)`;
      if (taken !== 1) throw inProgress('the claim is being taken over');
      return { kind: 'execute', id: held.id, generation };
    });
  }

  /**
   * Executes `command` under `claim`, and commits its outcome with its
   * effect. The record is locked first: if the claim was taken over, this
   * execution has lost it and does nothing. A refusal of the command's own
   * (a 4xx domain error) is recorded, so a retry is refused alike; any other
   * failure committed nothing, and releases the claim for a retry.
   */
  async complete<T>(
    ctx: AuthorizedTenantContext,
    claim: Claim,
    command: IdempotentCommand<T>,
  ): Promise<T> {
    try {
      return await this.transactions.withTenantTransaction(ctx, async (tx) => {
        const [held] = await tx.$queryRaw<
          { state: string; generation: number }[]
        >`
          SELECT state::text AS state, fencing_generation AS generation
            FROM idempotency_records
           WHERE id = ${claim.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
           FOR UPDATE`;
        if (
          held?.state !== 'IN_PROGRESS' ||
          held.generation !== claim.generation
        ) {
          throw new IdempotencyInProgressError(
            this.policy.retryAfterSeconds,
            'the claim was taken over: another execution holds the key',
          );
        }
        const { result, resultRef } = await command.execute(tx);
        // Fenced again: the effect commits only with this claim's outcome.
        const finished = await tx.$executeRaw`
          UPDATE idempotency_records
             SET state = 'SUCCEEDED', result_ref = ${resultRef ?? null}::uuid,
                 lease_until = NULL, completed_at = now()
           WHERE id = ${claim.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
             AND fencing_generation = ${claim.generation}
             AND state = 'IN_PROGRESS'`;
        if (finished !== 1) {
          throw new IdempotencyInProgressError(
            this.policy.retryAfterSeconds,
            'the claim was taken over while it executed',
          );
        }
        return result;
      });
    } catch (error) {
      if (!(error instanceof IdempotencyInProgressError)) {
        await this.settleFailure(ctx, claim, error);
      }
      throw error;
    }
  }

  /** Records a refusal, or releases the claim; never fails the request itself. */
  private async settleFailure(
    ctx: AuthorizedTenantContext,
    claim: Claim,
    error: unknown,
  ): Promise<void> {
    const refusal =
      error instanceof DomainError && PROBLEMS[error.code].status < 500
        ? error.code
        : null;
    try {
      await this.transactions.withTenantTransaction(ctx, (tx) =>
        refusal
          ? tx.$executeRaw`
              UPDATE idempotency_records
                 SET state = 'REJECTED', outcome_code = ${refusal},
                     lease_until = NULL, completed_at = now()
               WHERE id = ${claim.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
                 AND fencing_generation = ${claim.generation}
                 AND state = 'IN_PROGRESS'`
          : tx.$executeRaw`
              UPDATE idempotency_records SET lease_until = now()
               WHERE id = ${claim.id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
                 AND fencing_generation = ${claim.generation}
                 AND state = 'IN_PROGRESS'`,
      );
    } catch (settling) {
      // The lease runs out on its own; the request answers its own failure.
      this.logger.warn(
        `idempotency claim not settled: ${describeError(settling)}; its lease will run out`,
      );
    }
  }
}
