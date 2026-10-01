// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {ENTERPRISE_FEATURE_FLAG_ENV} from '../../config';
import type {CaseNode} from '../../types/sparkContracts';
import {consoleCallsDuring} from '../../../tests/helpers/consoleWarnings';
import {curatedCaseNode, writeCaseFileWithoutAttestations} from '../../../tests/helpers/caseStoreFixture';
import {CaseLibrary} from '../caseLibrary';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {ENTERPRISE_MIGRATION_PHASE_ENV} from '../enterpriseMigration';
import {
  getScopedKnowledgeRecord,
  mutateScopedKnowledgeRecordWithSideEffect,
  upsertScopedKnowledgeRecord,
  type KnowledgeScope,
} from '../scopedKnowledgeStore';
import {attestCaseCuration, caseCurationGrantForMarkdownIngest} from '../security/caseCuration';

const ENV_KEYS = [ENTERPRISE_FEATURE_FLAG_ENV, ENTERPRISE_DB_PATH_ENV, ENTERPRISE_MIGRATION_PHASE_ENV] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const scope: KnowledgeScope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const curator = caseCurationGrantForMarkdownIngest();

const PHASES = [
  {name: 'file-only (legacy)', phase: undefined, writesFile: true, writesDb: false},
  {name: 'dual-write', phase: 'dual-write', writesFile: true, writesDb: true},
  {name: 'DB-only (retired)', phase: 'retired', writesFile: false, writesDb: true},
] as const;
type Phase = (typeof PHASES)[number];

let tmpDir: string;
let libraryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-curation-'));
  libraryPath = path.join(tmpDir, 'case_library.json');
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function usePhase(phase: Phase['phase']): void {
  if (!phase) return;
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_MIGRATION_PHASE_ENV] = phase;
}

/**
 * Write a case the way a release before attestations did, in each copy the
 * phase writes: the knowledge row envelope rebuilt from its fixed fields, and
 * the case file persisted without attestations.
 */
function writeAsBeforeAttestations(phase: Phase, record: CaseNode, {file = phase.writesFile, db = phase.writesDb} = {}): void {
  if (db) upsertScopedKnowledgeRecord('case_node', record.caseId, `case:${record.status}`, record, scope);
  if (file) writeCaseFileWithoutAttestations(libraryPath, record);
}

const admittedIds = (library: CaseLibrary, status: 'published' | 'reviewed' = 'reviewed') =>
  library.listAdmittedCases([status], scope).map(c => c.caseId);

describe.each(PHASES)('case curation in $name storage', phase => {
  beforeEach(() => usePhase(phase.phase));

  it('lets analyses read a case a curator saved or published, and shows curators why', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    library.saveCase(curatedCaseNode('case-b'), curator, scope);
    library.publishCase('case-b', {reviewer: 'perf-team'}, curator, scope);

    expect(admittedIds(library)).toEqual(['case-a']);
    expect(admittedIds(library, 'published')).toEqual(['case-b']);
    expect(library.getCaseForCuration('case-b', scope)).toMatchObject({
      status: 'published',
      curatedBy: 'perf-team',
      analysisAdmitted: true,
      curation: {issuer: 'markdown_ingest', issuedAt: expect.any(Number)},
    });
  });

  it('never lets analyses read a draft, a private case or one its author did not declare shareable', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-draft', {status: 'draft'}), curator, scope);
    library.saveCase(curatedCaseNode('case-private', {status: 'private'}), curator, scope);
    library.saveCase(curatedCaseNode('case-raw', {redactionState: 'raw'}), curator, scope);

    expect(admittedIds(library)).toEqual([]);
    expect(library.listCasesForCuration({}, scope).map(c => [c.caseId, c.analysisAdmitted, c.curation?.issuer]))
      .toEqual([
        ['case-draft', false, 'markdown_ingest'],
        ['case-private', false, 'markdown_ingest'],
        ['case-raw', false, 'markdown_ingest'],
      ]);
  });

  it('stops reading a case an older version rewrote, even one carrying a well-formed attestation inside it', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    library.saveCase(curatedCaseNode('case-b'), curator, scope);
    const edited = curatedCaseNode('case-b', {title: 'case-b edited by a viewer'});
    const forged = {
      ...edited,
      attestation: attestCaseCuration(curator, edited),
      analysisAdmitted: true,
      curation: {issuer: 'curator_api', actor: 'admin', issuedAt: 1},
    } as CaseNode;

    writeAsBeforeAttestations(phase, curatedCaseNode('case-a'));
    writeAsBeforeAttestations(phase, forged);

    expect(admittedIds(library)).toEqual([]);
    expect(library.getCaseForCuration('case-b', scope)).toMatchObject({
      title: 'case-b edited by a viewer',
      analysisAdmitted: false,
    });
    expect(library.getCaseForCuration('case-b', scope)).not.toHaveProperty('curation');
  });

  it('keeps a case readable when it is archived, and never makes one readable by archiving it', () => {
    const library = new CaseLibrary(libraryPath);
    writeAsBeforeAttestations(phase, curatedCaseNode('case-legacy'));
    library.saveCase(curatedCaseNode('case-attested'), curator, scope);

    library.archiveCase('case-attested', {reason: 'archived after 90 days'}, curator, scope);
    library.archiveCase('case-legacy', {reason: 'archived after 90 days'}, curator, scope);

    expect(admittedIds(library)).toEqual(['case-attested']);
    expect(library.getCase('case-legacy', scope)?.traceUnavailableReason).toBe('archived after 90 days');
  });

  it('makes a legacy case readable once a reviewer publishes it', () => {
    const library = new CaseLibrary(libraryPath);
    writeAsBeforeAttestations(phase, curatedCaseNode('case-legacy', {status: 'published', curatedBy: 'someone'}));
    expect(admittedIds(library, 'published')).toEqual([]);

    library.publishCase('case-legacy', {reviewer: 'reviewer-b'}, curator, scope);

    expect(admittedIds(library, 'published')).toEqual(['case-legacy']);
    expect(library.getCase('case-legacy', scope)?.curatedBy).toBe('reviewer-b');
  });

  it('reads the same admission from a fresh library after publish and archive', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    library.publishCase('case-a', {reviewer: 'perf-team'}, curator, scope);
    library.archiveCase('case-a', {reason: 'trace evicted'}, curator, scope);

    expect(admittedIds(new CaseLibrary(libraryPath), 'published')).toEqual(['case-a']);
  });

  it('refuses a write without a grant it issued', () => {
    const library = new CaseLibrary(libraryPath);
    const forged = {issuer: 'curator_api', actor: 'someone'} as never;
    expect(() => library.saveCase(curatedCaseNode('case-a'), forged, scope)).toThrow('case_curation_grant_required');
    expect(library.getCase('case-a', scope)).toBeUndefined();
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    expect(() => library.publishCase('case-a', {reviewer: 'perf-team'}, forged, scope)).toThrow('case_curation_grant_required');
    expect(() => library.archiveCase('case-a', {reason: 'x'}, forged, scope)).toThrow('case_curation_grant_required');
    expect(library.getCase('case-a', scope)?.status).toBe('reviewed');
  });

  it('removes a case with its attestation', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    expect(library.removeCase('case-a', scope)).toBe(true);
    writeAsBeforeAttestations(phase, curatedCaseNode('case-a'));
    expect(admittedIds(library)).toEqual([]);
  });
});

describe('case curation across the dual-write copies', () => {
  beforeEach(() => usePhase('dual-write'));
  const dualWrite = PHASES[1];

  it('does not let a DB attestation stand in for the file copy analyses read', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    // An older version persisting the file drops every file attestation and leaves the DB rows alone.
    writeAsBeforeAttestations(dualWrite, curatedCaseNode('case-a'), {db: false});
    expect(admittedIds(library)).toEqual([]);

    library.archiveCase('case-a', {reason: 'archived after 90 days'}, curator, scope);

    expect(admittedIds(library)).toEqual([]);
    usePhase('retired');
    expect(admittedIds(new CaseLibrary(libraryPath))).toEqual([]);
  });

  it('does not let a file attestation stand in for the DB copy either', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    writeAsBeforeAttestations(dualWrite, curatedCaseNode('case-a'), {file: false});

    library.archiveCase('case-a', {reason: 'archived after 90 days'}, curator, scope);

    expect(admittedIds(library)).toEqual([]);
  });

  it('rolls the database back and releases the file lock when the file write fails', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => library.archiveCase('case-a', {reason: 'stale'}, curator, scope)).toThrow('disk full');
    } finally {
      rename.mockRestore();
    }

    expect(fs.existsSync(`${libraryPath}.lock`)).toBe(false);
    expect(library.getCase('case-a', scope)?.traceUnavailableReason).toBeUndefined();
    usePhase('retired');
    expect(new CaseLibrary(libraryPath).getCase('case-a', scope)?.traceUnavailableReason).toBeUndefined();
    usePhase('dual-write');
    library.archiveCase('case-a', {reason: 'stale'}, curator, scope);
    expect(admittedIds(library)).toEqual(['case-a']);
  });

  it('leaves the copies diverged when the database commit fails after the file write, and refuses the next write', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    // The transaction body runs inside the file lock; failing right after it stands in for a failed COMMIT.
    const files = CaseLibrary.prototype as unknown as {mutateFilesystem<T>(mutation: () => T): T};
    const persistThenFail = files.mutateFilesystem;
    const commit = jest.spyOn(files, 'mutateFilesystem').mockImplementationOnce(function (this: unknown, mutation) {
      persistThenFail.call(this, mutation);
      throw new Error('commit failed');
    });
    try {
      expect(() => library.archiveCase('case-a', {reason: 'stale'}, curator, scope)).toThrow('commit failed');
    } finally {
      commit.mockRestore();
    }

    expect(library.getCase('case-a', scope)?.traceUnavailableReason).toBe('stale');
    expect(admittedIds(library)).toEqual(['case-a']);
    expect(() => library.publishCase('case-a', {reviewer: 'perf-team'}, curator, scope))
      .toThrow(/diverged database and filesystem replicas/);
    usePhase('retired');
    expect(new CaseLibrary(libraryPath).getCase('case-a', scope)?.traceUnavailableReason).toBeUndefined();
    expect(admittedIds(new CaseLibrary(libraryPath))).toEqual(['case-a']);
  });

  it('reads a dual-write attestation from the database after the move to it', () => {
    const library = new CaseLibrary(libraryPath);
    library.saveCase(curatedCaseNode('case-a'), curator, scope);
    usePhase('retired');
    expect(admittedIds(new CaseLibrary(libraryPath))).toEqual(['case-a']);
  });
});

describe('the knowledge store envelope', () => {
  beforeEach(() => usePhase('retired'));

  it('keeps an attestation only through a write that sets it again', () => {
    const record = curatedCaseNode('case-a');
    upsertScopedKnowledgeRecord('case_node', 'case-a', 'case:reviewed', record, scope, {attestation: {mark: 1}});
    expect(getScopedKnowledgeRecord('case_node', 'case-a', scope)?.attestation).toEqual({mark: 1});

    mutateScopedKnowledgeRecordWithSideEffect<CaseNode>('case_node', 'case-a', scope,
      current => ({record: current!, rowScope: 'case:reviewed'}), () => undefined);

    expect(getScopedKnowledgeRecord('case_node', 'case-a', scope)).toMatchObject({record});
    expect(getScopedKnowledgeRecord('case_node', 'case-a', scope)).not.toHaveProperty('attestation');
  });
});

describe('unread curated cases', () => {
  it('are reported once per process, by count only', () => {
    writeAsBeforeAttestations(PHASES[0], curatedCaseNode('case-legacy-secret-title'));
    jest.isolateModules(() => {
      const {CaseLibrary: FreshLibrary} = require('../caseLibrary') as typeof import('../caseLibrary');
      const library = new FreshLibrary(libraryPath);
      const first = consoleCallsDuring('warn', () => library.listAdmittedCases());
      const second = consoleCallsDuring('warn', () => library.listAdmittedCases());
      expect(first).toEqual([[expect.stringContaining('[CaseLibrary]'), {count: 1}]]);
      expect(JSON.stringify(first)).not.toContain('secret');
      expect(second).toEqual([]);
    });
  });
});
