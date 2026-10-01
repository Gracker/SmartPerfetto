// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { CaseKnowledgeQuality, CaseKnowledgeStatus } from '../../../types/caseKnowledge';
import type { CaseNode, RagChunk } from '../../../types/sparkContracts';
import { CaseLibrary } from '../../caseLibrary';
import { RagStore } from '../../ragStore';
import {
  createCaseRetriever,
  evaluateCaseEvidenceSignature,
} from '../caseRecommendationRetriever';

let tmpDir: string;
let library: CaseLibrary;
let ragStore: RagStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-case-retriever-'));
  library = new CaseLibrary(path.join(tmpDir, 'case_library.json'));
  ragStore = new RagStore(path.join(tmpDir, 'rag_store.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function addCase(input: {
  caseId: string;
  status?: CaseKnowledgeStatus;
  quality?: CaseKnowledgeQuality;
  required?: Array<{ field: string; op: 'eq' | 'contains_any' | 'gte' | 'lte'; value: unknown }>;
  supportive?: Array<{ field: string; op: 'eq' | 'contains_any' | 'gte' | 'lte'; value: unknown }>;
  supported?: boolean;
  appArchitecture?: string | string[];
}) {
  const record: CaseNode = {
    schemaVersion: 1,
    source: input.quality === 'imported' ? 'runtime_analysis_candidate' : 'curated_markdown_case',
    createdAt: 1,
    caseId: input.caseId,
    title: input.caseId,
    status: input.status ?? 'published',
    redactionState: 'redacted',
    tags: ['scrolling', 'shader_compile'],
    findings: [],
    knowledge: {
      sourceFile: `cases/${input.caseId}.md`,
      body: 'body',
      quality: input.quality ?? 'curated',
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      taxonomy: {
        primary_root_cause: 'shader_compile',
        secondary_root_causes: [],
        responsibility: 'app',
        severity: 'warning',
      },
      context: {
        app_architecture: input.appArchitecture ?? 'any',
        ...(input.supported
          ? {'caseEvolution.v1': { candidateId: 'cand-supported', supportingEvidence: 3, contradictingEvidence: 0, supported: true }}
          : {}),
      },
      evidenceSignatures: {
        required: input.required ?? [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }],
        supportive: input.supportive ?? [],
      },
      recommendations: {
        app: [{ id: 'r1', priority: 'P1', action: 'Warm shaders', applies_when: 'shader_compile', risks: 'Startup cost' }],
        oem: [],
      },
    },
  };
  if (record.status === 'published') {
    library.saveCase({ ...record, status: 'reviewed' });
    library.publishCase(record.caseId, { reviewer: 'test' });
  } else {
    library.saveCase(record);
  }
  const chunk: RagChunk = {
    chunkId: `case:${input.caseId}:summary`,
    kind: 'case_library',
    uri: input.quality === 'imported' ? `case://learned/${input.caseId}` : `case://${input.caseId}`,
    title: input.caseId,
    snippet: `${input.caseId} shader compile makePipeline`,
    indexedAt: 1,
    registryOrigin: 'plan54_cases',
  };
  ragStore.addChunk(chunk);
  ragStore.flush();
}

describe('caseRecommendationRetriever', () => {
  it('evaluates signatures with strict fail-closed coercion', () => {
    expect(evaluateCaseEvidenceSignature({ field: 'reason_code', op: 'eq', value: 'shader_compile' }, { reason_code: 'shader_compile' })).toMatchObject({ satisfied: true });
    expect(evaluateCaseEvidenceSignature({ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }, { render_slices: ['doFrame', 'makePipeline'] })).toMatchObject({ satisfied: true });
    expect(evaluateCaseEvidenceSignature({ field: 'vsync_missed', op: 'gte', value: 3 }, { vsync_missed: '4' })).toMatchObject({ satisfied: false, reason: 'type_mismatch' });
    expect(evaluateCaseEvidenceSignature({ field: 'missing', op: 'eq', value: 'x' }, {})).toMatchObject({ satisfied: false, reason: 'missing' });
  });

  it('classifies strong, partial, and background matches by required/supportive evidence', () => {
    addCase({ caseId: 'case-strong', supportive: [{ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }] });
    addCase({ caseId: 'case-partial' });
    addCase({ caseId: 'case-background', required: [{ field: 'reason_code', op: 'eq', value: 'gc_jank' }] });

    const hits = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      architectureType: undefined,
      responsibility: 'app',
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile', render_slices: ['makePipeline'] },
      textQuery: 'shader compile',
      includeStatuses: ['published'],
    });

    expect(hits.map(hit => [hit.caseId, hit.matchStrength])).toEqual([
      ['case-strong', 'strong'],
      ['case-partial', 'partial'],
      ['case-background', 'background'],
    ]);
    expect(hits[2].missingRequiredSignatures).toEqual(['reason_code']);
  });

  it('honors includeStatuses and ranks curated above imported at equal strength', () => {
    addCase({ caseId: 'learned-draft', status: 'draft', quality: 'imported', supported: true });
    addCase({ caseId: 'curated-reviewed', status: 'reviewed', quality: 'curated' });

    const publishedOnly = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      architectureType: undefined,
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile' },
      includeStatuses: ['published'],
    });
    expect(publishedOnly).toEqual([]);

    const withDrafts = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      architectureType: undefined,
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile' },
      includeStatuses: ['draft', 'reviewed'],
    });
    expect(withDrafts.map(hit => hit.caseId)).toEqual(['curated-reviewed', 'learned-draft']);
    expect(withDrafts[1].learnedProvenance).toMatchObject({ candidateId: 'cand-supported', supported: true });
  });

  // MAJOR-3 regression: at EQUAL matchStrength AND EQUAL status, a curated
  // case must outrank a supported learned case. The original comparator ran
  // learnedSupported before quality, letting a supported learned published
  // case outrank a curated published case — contrary to §4.2 Stage C.
  it('ranks a curated published case above a supported learned published case at equal strength', () => {
    addCase({ caseId: 'curated-pub', status: 'published', quality: 'curated' });
    addCase({ caseId: 'learned-pub', status: 'published', quality: 'imported', supported: true });

    const hits = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      architectureType: undefined,
      responsibility: 'app',
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile' },
      includeStatuses: ['published'],
    });

    expect(hits.map(hit => hit.caseId)).toEqual(['curated-pub', 'learned-pub']);
  });

  it('retrieves only cases declared for the trace architecture, and every case when it is unknown', () => {
    addCase({ caseId: 'case-view', appArchitecture: 'standard' });
    addCase({ caseId: 'case-flutter', appArchitecture: ['flutter'] });
    addCase({ caseId: 'case-any', appArchitecture: 'any' });
    const retriever = createCaseRetriever({ library, ragStore });
    const retrieve = (architectureType?: string) => retriever.retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      audiences: ['app'],
      architectureType,
      evidenceSignatures: { reason_code: 'shader_compile' },
    }).map(hit => hit.caseId).sort();

    expect(retrieve('FLUTTER')).toEqual(['case-any', 'case-flutter']);
    expect(retrieve('STANDARD')).toEqual(['case-any', 'case-view']);
    expect(retrieve(undefined)).toEqual(['case-any', 'case-flutter', 'case-view']);
  });
});
