import type { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../errors/domain-error';
import type { AuthorizedTenantContext } from '../tenancy/tenant-context';
import {
  ALLOW,
  authorizeChange,
  authorizeRead,
  definePolicy,
  deny,
  disclosedClasses,
} from './policy';

// The policy mechanism (0.6.3) on its own, with a policy of the test's: a
// note its author reads and edits while it is open, that a reviewer reads,
// and that nobody else sees.

interface Note {
  readonly authorId: string;
  readonly open: boolean;
}

const notes = definePolicy<'edit', Note>({
  read: (member, note) =>
    member.userId === note.authorId || member.role === 'ADMIN'
      ? ALLOW
      : deny('UNRELATED'),
  edit: (member, note) =>
    member.userId !== note.authorId
      ? deny('UNRELATED')
      : note.open
        ? ALLOW
        : deny('STATE'),
});

// And a note whose medical narrative its author alone is disclosed (0.6.4).
const clinical = definePolicy<never, Note>(
  { read: () => ALLOW },
  {
    MEDICAL: (member, note) =>
      member.userId === note.authorId ? ALLOW : deny('UNRELATED'),
  },
);

const AUTHOR = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';

/**
 * A context as the session guard mints one. Here a plain object: a policy
 * reads only the actor, and the use case's tenant transaction is what
 * refuses a context that was not minted (0.4.3).
 */
function memberContext(userId: string, role: UserRole) {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    actor: {
      kind: 'USER',
      userId,
      sessionId: '00000000-0000-4000-8000-000000000002',
      role,
    },
    requestId: 'request',
    locale: 'en',
  } as unknown as AuthorizedTenantContext;
}

const job = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  actor: { kind: 'SYSTEM', job: 'a-job' },
  requestId: 'request',
  locale: 'en',
} as unknown as AuthorizedTenantContext;

const note: Note = { authorId: AUTHOR, open: true };

/** What a call threw, for comparing one refusal with another. */
function refusalOf(work: () => unknown) {
  try {
    work();
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected a refusal');
}

describe('object policies', () => {
  it('a_read_denied_by_policy_is_not_found', () => {
    const stranger = memberContext(OTHER, 'COACH');
    const absent = refusalOf(() =>
      authorizeRead(stranger, notes, null, 'No such note'),
    );
    const denied = refusalOf(() =>
      authorizeRead(stranger, notes, note, 'No such note'),
    );

    // Denied and absent are the same answer: same error, same code, same
    // words, so the refusal says nothing of whether the note exists.
    expect(denied).toBeInstanceOf(NotFoundError);
    expect(denied).toEqual(absent);
    expect((denied as NotFoundError).code).toBe('NOT_FOUND');

    // A change by someone who cannot read the note is not found either.
    expect(
      refusalOf(() =>
        authorizeChange(stranger, notes, 'edit', note, 'No such note'),
      ),
    ).toEqual(absent);

    // Those the policy lets read it get the note itself back.
    expect(
      authorizeRead(memberContext(AUTHOR, 'COACH'), notes, note, 'x'),
    ).toBe(note);
    expect(authorizeRead(memberContext(OTHER, 'ADMIN'), notes, note, 'x')).toBe(
      note,
    );
  });

  it('a_change_the_member_may_see_is_refused_for_its_reason', () => {
    const admin = memberContext(OTHER, 'ADMIN');
    const author = memberContext(AUTHOR, 'COACH');
    const closed: Note = { authorId: AUTHOR, open: false };

    // A reviewer sees the note but did not write it: forbidden.
    expect(
      refusalOf(() => authorizeChange(admin, notes, 'edit', note, 'x')),
    ).toBeInstanceOf(ForbiddenError);
    // The author, once it is closed: the state does not allow it.
    expect(
      refusalOf(() => authorizeChange(author, notes, 'edit', closed, 'x')),
    ).toBeInstanceOf(InvalidTransitionError);
    // A use case may name its own error for a reason.
    expect(
      refusalOf(() =>
        authorizeChange(author, notes, 'edit', closed, 'x', {
          STATE: () => new ConflictError('closed'),
        }),
      ),
    ).toBeInstanceOf(ConflictError);
    // And the author edits an open note.
    expect(authorizeChange(author, notes, 'edit', note, 'x')).toBe(note);
  });

  it('a_job_or_an_action_without_a_rule_is_denied', () => {
    expect(notes.authorize(job, 'read', note)).toEqual(deny('NOT_A_MEMBER'));
    expect(
      refusalOf(() => authorizeRead(job, notes, note, 'x')),
    ).toBeInstanceOf(NotFoundError);
    // Missing policy denies (I-2): an action nobody wrote a rule for, even
    // one an object inherits.
    const author = memberContext(AUTHOR, 'OWNER');
    for (const action of ['delete', 'constructor', '__proto__', 'toString']) {
      expect(notes.authorize(author, action as 'edit', note)).toEqual(
        deny('ROLE'),
      );
    }
  });

  it('a_class_is_disclosed_only_with_its_grant_and_the_policys_rule', () => {
    const author = memberContext(AUTHOR, 'MEDICAL');
    const colleague = memberContext(OTHER, 'MEDICAL');
    const all = new Set(['IDENTITY', 'MEDICAL', 'FINANCE'] as const);

    // The author, whose role holds the grant: disclosed — and only the class
    // the policy has a rule for, whatever else the role holds.
    expect([...disclosedClasses(author, clinical, note, all)]).toEqual([
      'MEDICAL',
    ]);
    // The grant without the policy: a colleague the note is not about.
    expect(disclosedClasses(colleague, clinical, note, all).size).toBe(0);
    // The policy without the grant: the author, in a role that lacks it.
    expect(disclosedClasses(author, clinical, note, new Set()).size).toBe(0);
    // A job, and a policy that discloses nothing: nothing.
    expect(disclosedClasses(job, clinical, note, all).size).toBe(0);
    expect(disclosedClasses(author, notes, note, all).size).toBe(0);
    expect(clinical.discloses(author, 'constructor' as 'MEDICAL', note)).toBe(
      false,
    );
  });
});
