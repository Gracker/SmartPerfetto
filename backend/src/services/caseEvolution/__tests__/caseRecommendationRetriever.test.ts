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
import {caseCurationGrantForMarkdownIngest} from '../../security/caseCuration';
import {writeCaseFileWithoutAttestations} from '../../../../tests/helpers/caseStoreFixture';

const curator = caseCurationGrantForMarkdownIngest();

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

type CaseInput = {
  caseId: string;
  status?: CaseKnowledgeStatus;
  quality?: CaseKnowledgeQuality;
  redactionState?: CaseNode['redactionState'];
  required?: Array<{ field: string; op: 'eq' | 'contains_any' | 'gte' | 'lte'; value: unknown }>;
  supportive?: Array<{ field: string; op: 'eq' | 'contains_any' | 'gte' | 'lte'; value: unknown }>;
};

function caseRecord(input: CaseInput): CaseNode {
  return {
    schemaVersion: 1,
    source: 'curated_markdown_case',
    createdAt: 1,
    caseId: input.caseId,
    title: input.caseId,
    status: input.status ?? 'published',
    redactionState: input.redactionState ?? 'redacted',
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
      context: {},
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
}

function addCase(input: CaseInput) {
  const record = caseRecord(input);
  if (record.status === 'published') {
    library.saveCase({ ...record, status: 'reviewed' }, curator);
    library.publishCase(record.caseId, {reviewer: 'test'}, curator);
  } else {
    library.saveCase(record, curator);
  }
  const chunk: RagChunk = {
    chunkId: `case:${input.caseId}:summary`,
    kind: 'case_library',
    uri: `case://${input.caseId}`,
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

  it('cites the trace evidence the signatures were read from, and signature names only as matches', () => {
    addCase({ caseId: 'case-strong', supportive: [{ field: 'render_slices', op: 'contains_any', value: ['makePipeline'] }] });
    const query = {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      audiences: ['app' as const],
      evidenceSignatures: { reason_code: 'shader_compile', render_slices: ['makePipeline'] },
      includeStatuses: ['published' as const],
    };
    const retriever = createCaseRetriever({ library, ragStore });

    const [fromTrace] = retriever.retrieve({ ...query, evidenceRefIds: ['data:scrolling:root-causes'] });
    expect(fromTrace).toMatchObject({
      evidenceRefs: ['data:scrolling:root-causes'],
      matchedSignatures: ['reason_code', 'render_slices'],
    });
    // Values a caller typed in are matched, but they are no trace evidence.
    const [supplied] = retriever.retrieve(query);
    expect(supplied.matchedSignatures).toEqual(['reason_code', 'render_slices']);
    expect(supplied).not.toHaveProperty('evidenceRefs');
  });

  it('recalls only cases analyses may read', () => {
    writeCaseFileWithoutAttestations(path.join(tmpDir, 'case_library.json'), caseRecord({ caseId: 'legacy', status: 'reviewed' }));
    addCase({ caseId: 'attested', status: 'reviewed' });
    addCase({ caseId: 'undeclared', status: 'reviewed', redactionState: 'raw' });

    const hits = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile' },
      includeStatuses: ['reviewed'],
    });
    expect(hits.map(hit => hit.caseId)).toEqual(['attested']);
  });

  it('honors includeStatuses, never recalls a draft, and ranks curated above imported at equal strength', () => {
    addCase({ caseId: 'imported-reviewed', status: 'reviewed', quality: 'imported' });
    addCase({ caseId: 'curated-reviewed', status: 'reviewed', quality: 'curated' });
    addCase({ caseId: 'curated-draft', status: 'draft', quality: 'curated' });
    const query = {
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      audiences: ['app' as const],
      evidenceSignatures: { reason_code: 'shader_compile' },
    };

    expect(createCaseRetriever({ library, ragStore }).retrieve({ ...query, includeStatuses: ['published'] })).toEqual([]);
    const reviewed = createCaseRetriever({ library, ragStore }).retrieve({
      ...query,
      includeStatuses: ['published', 'reviewed'],
    });
    expect(reviewed.map(hit => hit.caseId)).toEqual(['curated-reviewed', 'imported-reviewed']);
    // Learned cases are retired: no hit carries learned provenance.
    expect(reviewed.some(hit => 'learnedProvenance' in hit)).toBe(false);
  });

  it('ranks a curated published case above an imported published case at equal strength', () => {
    addCase({ caseId: 'imported-pub', status: 'published', quality: 'imported' });
    addCase({ caseId: 'curated-pub', status: 'published', quality: 'curated' });

    const hits = createCaseRetriever({ library, ragStore }).retrieve({
      scene: 'scrolling',
      domainPack: 'scrolling.v1',
      rootCause: 'shader_compile',
      responsibility: 'app',
      audiences: ['app'],
      evidenceSignatures: { reason_code: 'shader_compile' },
      includeStatuses: ['published'],
    });

    expect(hits.map(hit => hit.caseId)).toEqual(['curated-pub', 'imported-pub']);
  });
});
