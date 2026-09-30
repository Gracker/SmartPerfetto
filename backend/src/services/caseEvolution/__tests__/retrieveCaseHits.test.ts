// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';

import { createDataEnvelope } from '../../../types/dataContract';
import type { CaseKnowledgeReportRecommendation } from '../../../types/caseKnowledge';
import type { CaseRecommendationQuery } from '../caseRecommendationRetriever';
import { retrieveCaseHits } from '../retrieveCaseHits';

function rec(caseId: string): CaseKnowledgeReportRecommendation {
  return { caseId, title: caseId, scene: 'scrolling', primaryRootCause: 'shader_compile',
    matchStrength: 'partial', recommendations: { app: [], oem: [] } };
}

function clusterEnvelope(rows: unknown[][]) {
  return createDataEnvelope({
    columns: ['reason_code', 'frame_count', 'percentage', 'jank_responsibility', 'vsync_missed', 'render_slices_json'],
    rows,
  }, { type: 'skill_result', source: 'scrolling_analysis', skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
    title: 'Frame root causes', evidenceRefId: 'data:scrolling:root-causes' });
}

describe('retrieveCaseHits', () => {
  it('queries with each qualifying cluster of trace data and its evidence reference', () => {
    const retrieve = jest.fn((_query: CaseRecommendationQuery) => [rec('case-shader')]);
    const hits = retrieveCaseHits({
      dataEnvelopes: [clusterEnvelope([
        ['shader_compile', 4, 20, 'APP', 2, '["DrawFrame"]'],
        ['gc_jank', 1, 2, 'APP', 1, '[]'],
      ])],
      sceneType: 'scrolling',
      retrieve,
    });

    expect(hits.map(hit => hit.caseId)).toEqual(['case-shader']);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0]).toMatchObject({
      rootCause: 'shader_compile',
      evidenceSignatures: { reason_code: 'shader_compile', vsync_missed: 2, render_slices: ['DrawFrame'] },
      evidenceRefIds: ['data:scrolling:root-causes'],
    });
  });

  it('retrieves nothing without trace clusters, whatever the answer concluded', () => {
    const retrieve = jest.fn(() => [rec('case-shader')]);
    expect(retrieveCaseHits({ dataEnvelopes: [], sceneType: 'scrolling', retrieve })).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('retrieves nothing for another scene', () => {
    const retrieve = jest.fn(() => [rec('case-shader')]);
    const dataEnvelopes = [clusterEnvelope([['shader_compile', 4, 20, 'APP', 2, '[]']])];
    expect(retrieveCaseHits({ dataEnvelopes, sceneType: 'startup', retrieve })).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('deduplicates across clusters and caps at eight hits', () => {
    const dataEnvelopes = [clusterEnvelope([
      ['shader_compile', 4, 20, 'APP', 2, '[]'],
      ['gc_jank', 5, 25, 'APP', 1, '[]'],
    ])];
    const hits = retrieveCaseHits({
      dataEnvelopes,
      sceneType: 'scrolling',
      retrieve: query => Array.from({ length: 6 }, (_, index) => rec(`case-${query.rootCause === 'gc_jank' ? index + 3 : index}`)),
    });
    expect(hits.map(hit => hit.caseId)).toEqual(['case-0', 'case-1', 'case-2', 'case-3', 'case-4', 'case-5', 'case-6', 'case-7']);
  });
});
