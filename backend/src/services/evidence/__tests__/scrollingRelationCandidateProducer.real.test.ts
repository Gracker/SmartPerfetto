// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {resolveTraceCase} from '../../../utils/traceCorpus';
import {SkillEvaluator} from '../../../../tests/skill-eval/runner';
import {produceScrollingRelationCandidates} from '../scrollingRelationCandidateProducer';

const PACKAGE = 'com.example.wechatfriendforcustomscroller';

function envelope(traceId: string, rows: Record<string, unknown>[]): DataEnvelope {
  return createDataEnvelope({rows: rows as any}, {
    type: 'skill_result', source: 'scrolling_analysis', title: 'batch frame root cause',
    skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
    executionStatus: rows.length > 0 ? 'observed' : 'empty',
    evidenceRefId: `data:real:${traceId}:batch_frame_root_cause`,
    sourceToolCallId: `invoke_skill:real:${traceId}:batch_frame_root_cause`,
    traceId, traceSide: 'current',
  });
}

describe('scrollingRelationCandidateProducer real traces', () => {
  it('produces customer-scroll candidates and safely allows an empty standard trace', async () => {
    for (const traceId of ['android-scroll-customer', 'android-scroll-standard']) {
      const evaluator = new SkillEvaluator('scrolling_analysis');
      try {
        await evaluator.loadTrace(resolveTraceCase(traceId));
        const result = await evaluator.executeStep('batch_frame_root_cause', {
          package: PACKAGE,
          max_frames_per_session: 50,
        });
        expect(result.success).toBe(true);

        const candidates = produceScrollingRelationCandidates([envelope(traceId, result.data)]);
        expect(candidates.length).toBeLessThanOrEqual(50);
        expect(candidates.every(candidate =>
          candidate.kind === 'derived' &&
          candidate.subject.column === 'frame_id' &&
          candidate.object?.column === 'reason_code')).toBe(true);

        if (traceId === 'android-scroll-customer') {
          expect(result.data.length).toBeGreaterThan(0);
          expect(candidates.length).toBeGreaterThan(0);
        } else if (result.data.length === 0) {
          expect(candidates).toEqual([]);
        } else {
          expect(candidates.length).toBeGreaterThan(0);
        }
      } finally {
        await evaluator.cleanup();
      }
    }
  }, 240_000);

  it('keeps the production batch frame budget on trace timing when the selected range has no local VSync tick', async () => {
    const evaluator = new SkillEvaluator('scrolling_analysis');
    try {
      await evaluator.loadTrace(resolveTraceCase('android-scroll-customer'));
      const result = await evaluator.executeStep('batch_frame_root_cause', {
        package: PACKAGE,
        start_ts: '506731768732822',
        end_ts: '506731773000000',
        max_frames_per_session: 10,
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        frame_id: '59665037',
        frame_budget_ms: 8.33,
      });
      expect(String(result.data[0].vsync_source)).toMatch(/^(?:scoped|trace_wide)_vsync_counter$/);
    } finally {
      await evaluator.cleanup();
    }
  }, 240_000);
});
