// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { CaseLibrary } from '../../caseLibrary';
import { parsePromoteCliArgs } from '../caseEvolutionPromoteCli';
import { promoteCaseCandidate } from '../caseEvolutionPromotion';

let tmpDir: string;
let library: CaseLibrary;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-promote-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
  library.saveCase({
    schemaVersion: 1,
    source: 'runtime_analysis_candidate',
    createdAt: 1,
    caseId: 'learned:cand-promote',
    title: 'Promotable learned case',
    status: 'draft',
    redactionState: 'redacted',
    tags: ['scrolling'],
    findings: [
      {
        id: 'f1',
        severity: 'critical',
        title: 'Shader compile frames',
        evidence: { externalRef: 'data-envelope:ev-1' },
      },
    ],
    knowledge: {
      sourceFile: 'logs/case_candidates/cand-promote.json',
      body: 'body',
      quality: 'imported',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      // Learned before the app_architecture contract: the detected type sits under the legacy key.
      context: {
        architectureType: 'FLUTTER',
        'caseEvolution.v1': { candidateId: 'cand-promote', supportingEvidence: 3, contradictingEvidence: 0, supported: true },
      },
      evidenceSignatures: { required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }], supportive: [] },
      recommendations: { app: [], oem: [] },
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('promoteCaseCandidate', () => {
  it('promotes a learned draft to reviewed without publishing', () => {
    const publishSpy = jest.spyOn(library, 'publishCase');

    const result = promoteCaseCandidate('cand-promote', { to: 'reviewed', library });

    expect(result).toMatchObject({ ok: true, caseId: 'learned:cand-promote', status: 'reviewed' });
    expect(library.getCase('learned:cand-promote')?.status).toBe('reviewed');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes only through CaseLibrary.publishCase with a reviewer', () => {
    const publishSpy = jest.spyOn(library, 'publishCase');

    expect(promoteCaseCandidate('cand-promote', { to: 'published', library })).toMatchObject({
      ok: false,
      reason: 'missing_reviewer',
    });

    const result = promoteCaseCandidate('cand-promote', {
      to: 'published',
      reviewer: 'chris',
      library,
    });

    expect(result).toMatchObject({ ok: true, status: 'published' });
    expect(publishSpy).toHaveBeenCalledWith('learned:cand-promote', { reviewer: 'chris' }, undefined);
  });

  it('renders reviewed learned cases to Markdown only when explicitly requested', () => {
    promoteCaseCandidate('cand-promote', { to: 'reviewed', library });
    const markdownRoot = path.join(tmpDir, 'knowledge', 'cases');

    const result = promoteCaseCandidate('cand-promote', {
      to: 'markdown',
      library,
      markdownRoot,
    });

    expect(result.ok).toBe(true);
    const target = path.join(markdownRoot, 'scrolling', 'learned:cand-promote.md');
    const emitted = fs.readFileSync(target, 'utf-8');
    expect(emitted).toContain('case_id: learned:cand-promote');
    // MINOR-1: the emitted Markdown must carry real findings data
    // (confidence derived from severity, evidence_refs from the link) so it
    // passes validate:cases on re-ingest, and must NOT re-export the
    // runtime-only caseEvolution.v1 marker.
    expect(emitted).toContain('confidence: high');
    expect(emitted).toContain('evidence_refs: ["data-envelope:ev-1"]');
    expect(emitted).not.toContain('caseEvolution.v1');
    expect(emitted).toContain('  app_architecture: flutter\n');
    expect(emitted).not.toContain('architectureType');
  });

  it('refuses to render a learned case whose architecture was never established', () => {
    const stored = library.getCase('learned:cand-promote')!;
    library.saveCase({
      ...stored,
      knowledge: { ...stored.knowledge!, context: { architectureType: 'unknown' } },
    });
    const markdownRoot = path.join(tmpDir, 'knowledge', 'cases');

    const result = promoteCaseCandidate('cand-promote', { to: 'markdown', library, markdownRoot });

    expect(result).toMatchObject({ ok: false, reason: 'io_error' });
    expect(fs.existsSync(path.join(markdownRoot, 'scrolling', 'learned:cand-promote.md'))).toBe(false);
  });
});

describe('parsePromoteCliArgs', () => {
  it('accepts the manual --to-markdown shorthand without enabling publish', () => {
    expect(parsePromoteCliArgs(['cand-promote', '--to-markdown'])).toEqual({
      ok: true,
      candidateId: 'cand-promote',
      to: 'markdown',
      reviewer: undefined,
    });
  });

  it('keeps published promotion reviewer-gated at the service boundary', () => {
    expect(parsePromoteCliArgs(['cand-promote', '--to', 'published'])).toEqual({
      ok: true,
      candidateId: 'cand-promote',
      to: 'published',
      reviewer: undefined,
    });
  });
});
