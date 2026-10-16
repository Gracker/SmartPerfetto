// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, it, expect, beforeEach, afterEach} from '@jest/globals';
import {warningsDuring} from '../../../tests/helpers/consoleWarnings';

import {CaseLibrary} from '../caseLibrary';
import {
  type CaseNode,
  makeSparkProvenance,
} from '../../types/sparkContracts';
import {caseCurationGrantForMarkdownIngest} from '../security/caseCuration';

const curator = caseCurationGrantForMarkdownIngest();

let tmpDir: string;
let storagePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-library-test-'));
  storagePath = path.join(tmpDir, 'cases.json');
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

function makeCase(overrides: Partial<CaseNode> = {}): CaseNode {
  return {
    ...makeSparkProvenance({source: 'case-library-test'}),
    caseId: 'case-001',
    title: 'Heavy mixed scrolling — first-jank chain',
    status: 'draft',
    redactionState: 'raw',
    traceArtifactId: 'artifact-trace-001',
    tags: ['scrolling', 'binder'],
    findings: [
      {id: 'f1', severity: 'critical', title: 'Binder S>5ms before Choreographer'},
    ],
    ...overrides,
  };
}

describe('CaseLibrary — basic CRUD', () => {
  it('saves and reads back a draft case', () => {
    const lib = new CaseLibrary(storagePath);
    const c = makeCase();
    lib.saveCase(c, curator);
    expect(lib.getCase(c.caseId)).toEqual(c);
  });

  it('returns undefined for an unknown caseId', () => {
    const lib = new CaseLibrary(storagePath);
    expect(lib.getCase('nope')).toBeUndefined();
  });

  it('removeCase returns true when present', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a'}), curator);
    expect(lib.removeCase('a')).toBe(true);
    expect(lib.removeCase('a')).toBe(false);
  });

  it('replaces a case on re-save with the same id', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a', title: 'old'}), curator);
    lib.saveCase(makeCase({caseId: 'a', title: 'new'}), curator);
    expect(lib.getCase('a')?.title).toBe('new');
  });

  it('preserves writes from library instances created before either mutation', () => {
    const first = new CaseLibrary(storagePath);
    const second = new CaseLibrary(storagePath);

    first.saveCase(makeCase({caseId: 'a'}), curator);
    second.saveCase(makeCase({caseId: 'b'}), curator);

    expect(new CaseLibrary(storagePath).listCases().map(item => item.caseId)).toEqual(['a', 'b']);
  });
});

describe('CaseLibrary — saveCase rejects status=published', () => {
  it("rejects saveCase with status='published' regardless of redaction", () => {
    const lib = new CaseLibrary(storagePath);
    expect(() =>
      lib.saveCase(
        makeCase({
          status: 'published',
          redactionState: 'redacted',
          curatedBy: 'someone',
        }),
        curator,
      ),
    ).toThrow(/publishCase/);
  });
});

describe('CaseLibrary — publishCase double-control gate', () => {
  it('rejects publish without an existing case', () => {
    const lib = new CaseLibrary(storagePath);
    expect(() =>
      lib.publishCase('missing', {reviewer: 'chris'}, curator),
    ).toThrow(/not found/);
  });

  it('rejects publish without reviewer name', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a'}), curator);
    expect(() => lib.publishCase('a', {reviewer: '   '}, curator)).toThrow(
      /reviewer signoff/,
    );
  });

  it('rejects publish when redactionState is not redacted', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a', redactionState: 'partial'}), curator);
    expect(() => lib.publishCase('a', {reviewer: 'chris'}, curator)).toThrow(
      /redactionState/,
    );
  });

  it('publishes successfully when redacted + reviewer supplied', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(
      makeCase({caseId: 'a', redactionState: 'redacted'}),
      curator,
    );
    const published = lib.publishCase('a', {reviewer: 'chris'}, curator);
    expect(published.status).toBe('published');
    expect(published.curatedBy).toBe('chris');
    expect(published.curatedAt).toBeGreaterThan(0);
    // Persisted state matches return value.
    expect(lib.getCase('a')?.status).toBe('published');
    expect(lib.getCase('a')?.curatedBy).toBe('chris');
  });

  it('publishCase trims whitespace around the reviewer name', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(
      makeCase({caseId: 'a', redactionState: 'redacted'}),
      curator,
    );
    const published = lib.publishCase('a', {reviewer: '  chris  '}, curator);
    expect(published.curatedBy).toBe('chris');
  });
});

describe('CaseLibrary — archiveCase', () => {
  it('drops traceArtifactId and records reason', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(
      makeCase({caseId: 'a', traceArtifactId: 'artifact-001'}),
      curator,
    );
    const archived = lib.archiveCase('a', {
      reason: 'archived after 90 days',
    }, curator);
    expect(archived.traceArtifactId).toBeUndefined();
    expect(archived.traceUnavailableReason).toBe(
      'archived after 90 days',
    );
    // Stored state matches.
    const stored = lib.getCase('a')!;
    expect(stored.traceArtifactId).toBeUndefined();
    expect(stored.traceUnavailableReason).toBe('archived after 90 days');
  });

  it('rejects archive without a reason', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a'}), curator);
    expect(() => lib.archiveCase('a', {reason: '  '}, curator)).toThrow(
      /reason/,
    );
  });

  it('rejects archive when case is missing', () => {
    const lib = new CaseLibrary(storagePath);
    expect(() => lib.archiveCase('missing', {reason: 'x'}, curator)).toThrow(
      /not found/,
    );
  });

  it('preserves other fields on archive', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a', tags: ['scrolling']}), curator);
    const archived = lib.archiveCase('a', {reason: 'x'}, curator);
    expect(archived.tags).toEqual(['scrolling']);
    expect(archived.findings).toHaveLength(1);
  });
});

describe('CaseLibrary — listing', () => {
  function seed(lib: CaseLibrary): void {
    lib.saveCase(
      makeCase({caseId: 'a', tags: ['scrolling'], educationalLevel: 'novice'}),
      curator,
    );
    lib.saveCase(
      makeCase({
        caseId: 'b',
        tags: ['anr'],
        educationalLevel: 'intermediate',
      }),
      curator,
    );
    lib.saveCase(
      makeCase({
        caseId: 'c',
        redactionState: 'redacted',
        tags: ['memory'],
      }),
      curator,
    );
    lib.publishCase('c', {reviewer: 'chris'}, curator);
  }

  it('lists everything sorted by id by default', () => {
    const lib = new CaseLibrary(storagePath);
    seed(lib);
    expect(lib.listCases().map(c => c.caseId)).toEqual(['a', 'b', 'c']);
  });

  it('respects status filter', () => {
    const lib = new CaseLibrary(storagePath);
    seed(lib);
    expect(
      lib.listCases({status: 'published'}).map(c => c.caseId),
    ).toEqual(['c']);
  });

  it('respects educationalLevel filter', () => {
    const lib = new CaseLibrary(storagePath);
    seed(lib);
    expect(
      lib.listCases({educationalLevel: 'novice'}).map(c => c.caseId),
    ).toEqual(['a']);
  });

  it('respects anyOfTags filter', () => {
    const lib = new CaseLibrary(storagePath);
    seed(lib);
    expect(
      lib.listCases({anyOfTags: ['scrolling', 'memory']}).map(c => c.caseId),
    ).toEqual(['a', 'c']);
  });
});

describe('CaseLibrary — persistence', () => {
  it('persists across instances', () => {
    const lib1 = new CaseLibrary(storagePath);
    lib1.saveCase(makeCase({caseId: 'a'}), curator);
    const lib2 = new CaseLibrary(storagePath);
    expect(lib2.getCase('a')).toBeDefined();
  });

  it('preserves corrupted JSON and refuses to overwrite it, quoting none of it', () => {
    // Unquoted, so the parser quotes the text around it: another workspace's case.
    const corrupt = '{"cases":[{"title":[CASE-CANARY-4b8e x]}]}';
    fs.writeFileSync(storagePath, corrupt, 'utf-8');
    const warnings = warningsDuring(() => {
      const lib = new CaseLibrary(storagePath);
      expect(lib.getCase('a')).toBeUndefined();
      expect(fs.existsSync(storagePath)).toBe(true);
      expect(() => lib.saveCase(makeCase({caseId: 'a'}), curator)).toThrow(/^Case library is unreadable$/);
    });
    expect(JSON.stringify(warnings)).not.toContain('CASE-CANARY');
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe(corrupt);
  });

  it('getStats counts cases by status', () => {
    const lib = new CaseLibrary(storagePath);
    lib.saveCase(makeCase({caseId: 'a', status: 'draft'}), curator);
    lib.saveCase(makeCase({caseId: 'b', status: 'reviewed'}), curator);
    lib.saveCase(
      makeCase({caseId: 'c', redactionState: 'redacted'}),
      curator,
    );
    lib.publishCase('c', {reviewer: 'chris'}, curator);
    expect(lib.getStats()).toEqual({
      draft: 1,
      reviewed: 1,
      published: 1,
      private: 0,
    });
  });
});
