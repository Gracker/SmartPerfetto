// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {DisplayResult} from '../../skillEngine/types';
import {buildTraceProcessorQueryProvenance} from '../../traceProcessorConnectionModel';
import {buildSkillQueryReview, buildSkillQueryReviews} from '../skillQueryReviewBuilder';

function displayResult(overrides: Partial<DisplayResult> = {}): DisplayResult {
  return {
    stepId: 'thread_states',
    title: 'Thread states',
    level: 'detail',
    layer: 'list',
    format: 'table',
    data: {
      columns: ['state', 'dur_ms'],
      rows: [['D', 10]],
    },
    sql: 'SELECT state, dur AS dur_ms FROM thread_state WHERE dur > 0',
    ...overrides,
  };
}

describe('skillQueryReviewBuilder', () => {
  it('builds Skill reviews from display metadata and source SQL', () => {
    const review = buildSkillQueryReview({
      skillId: 'sched_analysis',
      displayResult: displayResult(),
      traceProvenance: buildTraceProcessorQueryProvenance({
        traceId: 'trace-current',
        traceSide: 'current',
        paneSide: 'left',
      }),
      producer: {sourceToolCallId: 'invoke_skill:1', paramsHash: 'params:1'},
      artifactId: 'art-1',
      evidenceRefId: 'data:skill:1',
    });

    expect(review?.producer.kind).toBe('invoke_skill');
    expect(review?.producer.paneSide).toBe('left');
    expect(review?.source.skillId).toBe('sched_analysis');
    expect(review?.source.stepId).toBe('thread_states');
    expect(review?.reads.map(read => read.table)).toContain('thread_state');
    expect(review?.outputShape.map(column => column.name)).toEqual(['state', 'dur_ms']);
    expect(review?.purpose).toContain('Thread states');
    expect(review?.purpose).toContain('thread_state');
    expect(review?.purpose).toContain('dur > 0');
    expect(review?.purpose).toContain('state');
    expect(review?.purpose).toContain('dur_ms');
    expect(review?.purpose).not.toContain('Review the Skill output shape');
  });

  it('skips compare_skill producer contexts', () => {
    const reviews = buildSkillQueryReviews({
      skillId: 'sched_analysis',
      displayResults: [displayResult()],
      producer: {sourceToolCallId: 'compare_skill:1:current'},
    });

    expect(reviews.size).toBe(0);
  });
});
