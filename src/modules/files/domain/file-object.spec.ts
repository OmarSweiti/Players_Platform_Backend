import {
  FileClassification as DbClassification,
  FileStatus as DbStatus,
  ScanVerdict as DbVerdict,
} from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canMove,
  FILE_CLASSIFICATIONS,
  FILE_STATUSES,
  type FileStatus,
  isEnded,
  isServable,
  nextStatuses,
  SCAN_VERDICTS,
} from './file-object';
import { OWNER_KIND, uploadStateOf } from './upload-session';

describe('a file’s life', () => {
  it('names the states, verdicts and classes the database holds', () => {
    expect([...FILE_STATUSES]).toEqual(Object.values(DbStatus));
    expect([...SCAN_VERDICTS]).toEqual(Object.values(DbVerdict));
    expect([...FILE_CLASSIFICATIONS]).toEqual(Object.values(DbClassification));
  });

  it('moves forward only: pinned before scanned, scanned before READY, an end an end', () => {
    const path: FileStatus[] = [
      'CREATED',
      'UPLOADING',
      'UPLOADED',
      'SCANNING',
      'READY',
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(canMove(path[i - 1], path[i])).toBe(true);
    }
    // Derivatives sit between the scan and READY, once they exist (1.3.3).
    expect(canMove('SCANNING', 'PROCESSING')).toBe(true);
    expect(canMove('PROCESSING', 'READY')).toBe(true);
    // No skipping the pin or the scan, no going back, no leaving an end.
    for (const [from, to] of [
      ['CREATED', 'READY'],
      ['UPLOADING', 'SCANNING'],
      ['UPLOADED', 'READY'],
      ['READY', 'SCANNING'],
      ['REJECTED', 'READY'],
      ['ABORTED', 'UPLOADING'],
      ['SCANNING', 'ABORTED'],
    ] as const) {
      expect([from, to, canMove(from, to)]).toEqual([from, to, false]);
    }
    for (const status of FILE_STATUSES) {
      expect([status, isEnded(status)]).toEqual([
        status,
        ['READY', 'FAILED', 'REJECTED', 'ABORTED'].includes(status),
      ]);
      expect(nextStatuses(status).every((to) => to !== status)).toBe(true);
    }
  });

  it('is served only READY and CLEAN', () => {
    expect(isServable({ status: 'READY', scanVerdict: 'CLEAN' })).toBe(true);
    for (const [status, scanVerdict] of [
      ['READY', 'PENDING'],
      ['READY', 'ERROR'],
      ['SCANNING', 'CLEAN'],
      ['REJECTED', 'INFECTED'],
    ] as const) {
      expect(isServable({ status, scanVerdict })).toBe(false);
    }
  });
});

describe('an upload', () => {
  it('is open until it expires, and closes once', () => {
    const at = new Date('2026-11-11T10:00:00Z');
    const later = new Date('2026-11-11T10:15:00Z');
    const open = { expiresAt: later, finalizedAt: null, abortedAt: null };
    expect(uploadStateOf(open, at)).toBe('open');
    expect(uploadStateOf(open, later)).toBe('expired');
    expect(uploadStateOf({ ...open, finalizedAt: at }, later)).toBe(
      'finalized',
    );
    expect(uploadStateOf({ ...open, abortedAt: at }, at)).toBe('aborted');
  });

  it('declares its owner by a kind of lower-case words', () => {
    for (const kind of ['player-document', 'contract-version', 'avatar']) {
      expect(OWNER_KIND.test(kind)).toBe(true);
    }
    for (const kind of ['Player', 'player_document', '-x', 'a--b', '']) {
      expect([kind, OWNER_KIND.test(kind)]).toEqual([kind, false]);
    }
  });
});
