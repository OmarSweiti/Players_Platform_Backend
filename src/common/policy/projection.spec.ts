import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { id } from '../validation/schemas';
import type { ConfidentialClass } from './confidential-class';
import {
  confidential,
  project,
  projectAndRecord,
  UnauditedRelease,
  UnprojectableResponse,
} from './projection';

// The projection (0.6.4) on its own, with a response schema of the test's: a
// treatment note, its clinician, and its exercises. Every value is synthetic.

const Note = z.strictObject({
  id,
  recordedAt: z.iso.datetime({ offset: true }),
  clinician: z.strictObject({ id, name: z.string() }),
  exercises: z.array(z.strictObject({ name: z.string() })),
  diagnosis: confidential('MEDICAL', z.string()),
  findings: confidential('MEDICAL', z.string()).nullable(),
  passport: confidential(
    'IDENTITY',
    z.strictObject({ number: z.string(), expires: z.string() }),
  ),
});

const NOTE_ID = '00000000-0000-4000-8000-0000000000a1';
const CLINICIAN_ID = '00000000-0000-4000-8000-0000000000b1';
const recordedAt = new Date('2026-11-08T10:00:00.000Z');

/** A note as a repository might load it: more than the response names. */
const loaded = {
  id: NOTE_ID,
  tenantId: '00000000-0000-4000-8000-000000000001',
  recordedAt,
  clinician: { id: CLINICIAN_ID, name: 'Clinician', email: 'c@agency.test' },
  exercises: [
    { name: 'Squat', internalCode: 'x1' },
    { name: 'Lunge', internalCode: 'x2' },
  ],
  diagnosis: 'Synthetic strain',
  findings: null,
  passport: { number: 'P-0000', expires: '2030-01-01' },
};

const none = new Set<ConfidentialClass>();

describe('confidential projections', () => {
  it('a_projection_carries_only_the_fields_its_schema_names', () => {
    // What the schema does not name stays behind, at every depth: the
    // tenant, the clinician's address, each exercise's code.
    expect(project(Note, loaded, none)).toEqual({
      id: NOTE_ID,
      recordedAt,
      clinician: { id: CLINICIAN_ID, name: 'Clinician' },
      exercises: [{ name: 'Squat' }, { name: 'Lunge' }],
    });
    // An instant leaves as the Date it is, for serialisation.
    expect(project(Note, loaded, none).recordedAt).toBe(recordedAt);
    // A field the value does not hold is not invented.
    expect(project(Note, { id: NOTE_ID }, none)).toEqual({ id: NOTE_ID });
  });

  it('a_confidential_field_leaves_only_when_its_class_is_disclosed', async () => {
    // Both classes are access-audited (0.7.4): released through
    // projectAndRecord, which records the classes it carries.
    const recorded: Array<readonly ConfidentialClass[]> = [];
    const record = (classes: readonly ConfidentialClass[]) => {
      recorded.push(classes);
      return Promise.resolve();
    };
    // Medical disclosed: the medical fields, null among them — never the
    // identity document.
    const medical = await projectAndRecord(
      Note,
      loaded,
      new Set(['MEDICAL'] as const),
      record,
    );
    expect(medical).toMatchObject({
      diagnosis: 'Synthetic strain',
      findings: null,
    });
    expect(medical).not.toHaveProperty('passport');
    // Identity disclosed: the document, whole and allowlisted, and no
    // medical field.
    const identity = await projectAndRecord(
      Note,
      { ...loaded, passport: { ...loaded.passport, issuer: 'x' } },
      new Set(['IDENTITY'] as const),
      record,
    );
    expect(identity).toMatchObject({
      passport: { number: 'P-0000', expires: '2030-01-01' },
    });
    expect(identity).not.toHaveProperty('diagnosis');
    expect(identity).not.toHaveProperty('findings');
    expect(identity).not.toHaveProperty('passport.issuer');
    expect(recorded).toEqual([['MEDICAL'], ['IDENTITY']]);
  });

  it('project_never_releases_an_access_audited_class', () => {
    // Disclosed or not, a medical, identity, legal or finance field leaves
    // only through the access audit: project refuses, naming where.
    expect(() => project(Note, loaded, new Set(['MEDICAL'] as const))).toThrow(
      new UnauditedRelease('diagnosis', 'MEDICAL'),
    );
    expect(() => project(Note, loaded, new Set(['IDENTITY'] as const))).toThrow(
      UnauditedRelease,
    );
    // A null medical field disclosed is a medical field released.
    expect(() =>
      project(
        Note,
        { id: NOTE_ID, findings: null },
        new Set(['MEDICAL'] as const),
      ),
    ).toThrow(new UnauditedRelease('findings', 'MEDICAL'));
    // Withheld, or not there to release: nothing to refuse.
    expect(project(Note, loaded, none)).not.toHaveProperty('diagnosis');
    expect(
      project(Note, { id: NOTE_ID }, new Set(['MEDICAL'] as const)),
    ).toEqual({ id: NOTE_ID });
    // A class that is not access-audited leaves as before.
    const Minor = z.strictObject({
      id,
      consent: confidential('MINOR_POLICY', z.string()),
    });
    expect(
      project(
        Minor,
        { id: NOTE_ID, consent: 'guardian' },
        new Set(['MINOR_POLICY'] as const),
      ),
    ).toEqual({ id: NOTE_ID, consent: 'guardian' });
  });

  it('the_access_is_recorded_before_the_data_is_released', async () => {
    // A recording that fails: the value never comes back.
    class InsertFailed extends Error {}
    const failing = () =>
      Promise.reject(new InsertFailed('the audit insert failed'));
    await expect(
      projectAndRecord(Note, loaded, new Set(['MEDICAL'] as const), failing),
    ).rejects.toBeInstanceOf(InsertFailed);
    // The record comes first: the value is not returned until it settles.
    let settle!: () => void;
    let released = false;
    const pending = projectAndRecord(
      Note,
      loaded,
      new Set(['MEDICAL', 'IDENTITY'] as const),
      (classes) => {
        expect(classes).toEqual(['IDENTITY', 'MEDICAL']);
        return new Promise<void>((resolve) => (settle = resolve));
      },
    ).then((value) => {
      released = true;
      return value;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    settle();
    expect(await pending).toHaveProperty('diagnosis', 'Synthetic strain');
    // Nothing of an audited class carried: nothing recorded.
    const never = () => expect.unreachable('nothing should be recorded');
    expect(
      await projectAndRecord(Note, loaded, none, never),
    ).not.toHaveProperty('diagnosis');
  });

  it('a_value_without_its_schemas_shape_does_not_leave', () => {
    // A list where the schema wants an object, and the reverse: withheld.
    expect(
      project(
        Note,
        { ...loaded, clinician: [loaded.clinician], exercises: {} },
        none,
      ),
    ).toEqual({ id: NOTE_ID, recordedAt });
    // An object where the schema wants a scalar would leave unexamined:
    // refused, naming where.
    expect(() =>
      project(
        Note,
        { ...loaded, clinician: { ...loaded.clinician, name: { first: 'C' } } },
        none,
      ),
    ).toThrow(new UnprojectableResponse('clinician.name'));
  });

  it('marking_a_field_leaves_the_schema_it_marks_unmarked', () => {
    // `id` is shared by every schema: marking one field with it marks only
    // that field.
    const Pair = z.strictObject({ id, secret: confidential('FINANCE', id) });
    expect(project(Pair, { id: NOTE_ID, secret: CLINICIAN_ID }, none)).toEqual({
      id: NOTE_ID,
    });
    expect(project(z.strictObject({ id }), { id: NOTE_ID }, none)).toEqual({
      id: NOTE_ID,
    });
  });
});
