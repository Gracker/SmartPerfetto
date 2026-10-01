// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import type { ConclusionContract } from '../../../agent/core/conclusionContract';
import type { CaseKnowledgeReportRecommendation } from '../../../types/caseKnowledge';
import type { CaseRecommendationQuery } from '../caseRecommendationRetriever';
import {
  attachCaseHitsToContractSync,
  verifyAndPruneCaseRecommendations,
} from '../attachCaseHitsToContract';

function contract(): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'initial_report',
    conclusions: [{ rank: 1, statement: 'Shader compile causes jank' }],
    clusters: [{ cluster: 'shader_compile', frames: 4, percentage: 20 }],
    evidenceChain: [],
    claims: [{ id: 'claim-1', text: 'Warm shaders', kind: 'recommendation', references: [] }],
    uncertainties: [],
    nextSteps: [],
    metadata: { sceneId: 'scrolling' },
  };
}

function rec(caseId: string, matchStrength: CaseKnowledgeReportRecommendation['matchStrength']): CaseKnowledgeReportRecommendation {
  return {
    caseId,
    title: caseId,
    scene: 'scrolling',
    primaryRootCause: 'shader_compile',
    matchStrength,
    recommendations: { app: [], oem: [] },
  };
}

describe('attachCaseHitsToContractSync', () => {
  it('leaves the contract untouched when the retriever has no hits', () => {
    const input = contract();
    const result = attachCaseHitsToContractSync({
      conclusionContract: input,
      dataEnvelopes: [],
      sceneType: 'scrolling',
      architectureType: 'unknown',
      retrieve: () => [],
    });

    expect(result.contract).toBe(input);
    expect(result.hits).toEqual([]);
    expect(input.caseRecommendations).toBeUndefined();
  });

  it('caps attached recommendations at eight and returns a new contract', () => {
    const hits = Array.from({ length: 10 }, (_, index) => rec(`case-${index}`, 'partial'));
    const input = contract();
    const result = attachCaseHitsToContractSync({
      conclusionContract: input,
      dataEnvelopes: [],
      sceneType: 'scrolling',
      architectureType: 'unknown',
      retrieve: () => hits,
    });

    expect(result.contract).not.toBe(input);
    expect(result.contract.caseRecommendations).toHaveLength(8);
    expect(result.contract.caseRecommendations?.[0].caseId).toBe('case-0');
  });

  it('retrieves for the trace architecture the run detected', () => {
    const queries: CaseRecommendationQuery[] = [];
    attachCaseHitsToContractSync({
      conclusionContract: contract(),
      dataEnvelopes: [],
      sceneType: 'scrolling',
      architectureType: 'FLUTTER',
      retrieve: query => {
        queries.push(query);
        return [];
      },
    });

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(query => query.architectureType === 'FLUTTER')).toBe(true);
  });
});

describe('verifyAndPruneCaseRecommendations', () => {
  it('drops strong hits whose required signatures are not supported by current evidence', () => {
    const strong = rec('case-strong', 'strong');
    const pruned = verifyAndPruneCaseRecommendations({
      contract: { ...contract(), caseRecommendations: [strong] },
      narrative: 'This resembles case-strong but recommendations stay typed.',
      evidenceSignaturesByCluster: {
        shader_compile: { reason_code: 'gc_jank' },
      },
      getCase: () => ({
        schemaVersion: 1,
        source: 'curated_markdown_case',
        createdAt: 1,
        caseId: 'case-strong',
        title: 'case-strong',
        status: 'published',
        redactionState: 'redacted',
        tags: [],
        findings: [],
        knowledge: {
          sourceFile: 'cases/case-strong.md',
          body: '',
          quality: 'curated',
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
            required: [{ field: 'reason_code', op: 'eq', value: 'shader_compile' }],
            supportive: [],
          },
          recommendations: { app: [], oem: [] },
        },
      }),
    });

    expect(pruned.contract.caseRecommendations).toEqual([]);
    expect(pruned.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'case_recommendation_pruned',
      }),
    ]);
  });
});
