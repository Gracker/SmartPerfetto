// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';

import {FeedbackPipeline} from '../feedbackPipeline';

let tmpDir: string;
let storagePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-pipeline-test-'));
  storagePath = path.join(tmpDir, 'pipeline.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

describe('FeedbackPipeline — createEntry', () => {
  it('starts every new entry at stage=feedback', () => {
    const fp = new FeedbackPipeline(storagePath);
    const entry = fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(entry.stage).toBe('feedback');
    expect(entry.updatedAt).toBeGreaterThan(0);
  });

  it('rejects duplicate entryIds', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(() =>
      fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'}),
    ).toThrow(/already exists/);
  });
});

describe('FeedbackPipeline — advance happy path', () => {
  it('walks the full pipeline feedback → merged', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});

    fp.advance('e1', {
      stage: 'case_draft',
      case: {caseId: 'case-draft-001', status: 'draft'},
    });
    expect(fp.getEntry('e1')?.stage).toBe('case_draft');
    expect(fp.getEntry('e1')?.case?.caseId).toBe('case-draft-001');

    fp.advance('e1', {stage: 'skill_draft', skillDraftId: 'sd-001'});
    expect(fp.getEntry('e1')?.stage).toBe('skill_draft');
    expect(fp.getEntry('e1')?.skillDraftId).toBe('sd-001');

    fp.advance('e1', {stage: 'reviewed', reviewer: 'chris'});
    expect(fp.getEntry('e1')?.stage).toBe('reviewed');
    expect(fp.getEntry('e1')?.reviewer).toBe('chris');

    fp.advance('e1', {stage: 'merged', reviewer: 'chris'});
    expect(fp.getEntry('e1')?.stage).toBe('merged');
  });

  it('preserves prior fields when advancing without overrides', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {
      stage: 'case_draft',
      case: {caseId: 'case-001', status: 'draft'},
    });
    fp.advance('e1', {stage: 'skill_draft', skillDraftId: 'sd-001'});
    // After skill_draft, the case ref should still be there.
    expect(fp.getEntry('e1')?.case?.caseId).toBe('case-001');
  });

  it("rejects with reviewer when going to 'rejected'", () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'rejected', reviewer: 'chris'});
    expect(fp.getEntry('e1')?.stage).toBe('rejected');
  });
});

describe('FeedbackPipeline — illegal transitions', () => {
  it('blocks skipping stages (feedback → reviewed)', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(() =>
      fp.advance('e1', {stage: 'reviewed', reviewer: 'chris'}),
    ).toThrow(/Illegal transition/);
  });

  it('blocks back-edges (skill_draft → case_draft)', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'case_draft'});
    fp.advance('e1', {stage: 'skill_draft'});
    expect(() => fp.advance('e1', {stage: 'case_draft'})).toThrow(
      /Illegal transition/,
    );
  });

  it("blocks any transition out of terminal 'merged'", () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'case_draft'});
    fp.advance('e1', {stage: 'skill_draft'});
    fp.advance('e1', {stage: 'reviewed', reviewer: 'chris'});
    fp.advance('e1', {stage: 'merged', reviewer: 'chris'});
    expect(() =>
      fp.advance('e1', {stage: 'rejected', reviewer: 'chris'}),
    ).toThrow(/Illegal transition/);
  });

  it("blocks any transition out of terminal 'rejected'", () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'rejected', reviewer: 'chris'});
    expect(() =>
      fp.advance('e1', {stage: 'case_draft'}),
    ).toThrow(/Illegal transition/);
  });

  it('rejects advance on missing entry', () => {
    const fp = new FeedbackPipeline(storagePath);
    expect(() => fp.advance('missing', {stage: 'case_draft'})).toThrow(
      /not found/,
    );
  });
});

describe('FeedbackPipeline — reviewer requirement', () => {
  it('requires reviewer at reviewed', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'case_draft'});
    fp.advance('e1', {stage: 'skill_draft'});
    expect(() => fp.advance('e1', {stage: 'reviewed'})).toThrow(
      /reviewer/,
    );
  });

  it('requires reviewer at merged', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp.advance('e1', {stage: 'case_draft'});
    fp.advance('e1', {stage: 'skill_draft'});
    fp.advance('e1', {stage: 'reviewed', reviewer: 'chris'});
    expect(() => fp.advance('e1', {stage: 'merged'})).toThrow(
      /reviewer/,
    );
  });

  it('requires reviewer at rejected (whitespace counts as missing)', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(() =>
      fp.advance('e1', {stage: 'rejected', reviewer: '   '}),
    ).toThrow(/reviewer/);
  });

  it('does NOT require reviewer at case_draft / skill_draft', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(() => fp.advance('e1', {stage: 'case_draft'})).not.toThrow();
    expect(() => fp.advance('e1', {stage: 'skill_draft'})).not.toThrow();
  });
});

describe('FeedbackPipeline — listing + stats', () => {
  function seed(fp: FeedbackPipeline): void {
    fp.createEntry({entryId: 'a', feedbackId: 'fb-a'});
    fp.createEntry({entryId: 'b', feedbackId: 'fb-b'});
    fp.advance('b', {stage: 'case_draft'});
    fp.createEntry({entryId: 'c', feedbackId: 'fb-c'});
    fp.advance('c', {stage: 'rejected', reviewer: 'chris'});
  }

  it('list returns most-recently-updated first', () => {
    const fp = new FeedbackPipeline(storagePath);
    seed(fp);
    const list = fp.listEntries();
    expect(list[0].entryId).toBe('c');
    expect(list).toHaveLength(3);
  });

  it('list filters by stage', () => {
    const fp = new FeedbackPipeline(storagePath);
    seed(fp);
    expect(fp.listEntries({stage: 'feedback'}).map(e => e.entryId)).toEqual([
      'a',
    ]);
  });

  it('getStats reflects per-stage counts', () => {
    const fp = new FeedbackPipeline(storagePath);
    seed(fp);
    expect(fp.getStats()).toEqual({
      feedback: 1,
      case_draft: 1,
      skill_draft: 0,
      reviewed: 0,
      merged: 0,
      rejected: 1,
    });
  });
});

describe('FeedbackPipeline — persistence', () => {
  it('persists entries across instances', () => {
    const fp1 = new FeedbackPipeline(storagePath);
    fp1.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    fp1.advance('e1', {stage: 'case_draft'});

    const fp2 = new FeedbackPipeline(storagePath);
    expect(fp2.getEntry('e1')?.stage).toBe('case_draft');
  });

  it('survives corrupted JSON without losing the file', () => {
    fs.writeFileSync(storagePath, 'not-json{', 'utf-8');
    const fp = new FeedbackPipeline(storagePath);
    expect(fp.getEntry('e1')).toBeUndefined();
    expect(fs.existsSync(storagePath)).toBe(true);
  });

  it('removeEntry returns true when present, false otherwise', () => {
    const fp = new FeedbackPipeline(storagePath);
    fp.createEntry({entryId: 'e1', feedbackId: 'fb-001'});
    expect(fp.removeEntry('e1')).toBe(true);
    expect(fp.removeEntry('e1')).toBe(false);
  });
});
