// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {resolveTraceCase} from '../../../utils/traceCorpus';
import {SkillEvaluator} from '../../../../tests/skill-eval/runner';
import {produceInputRelationCandidates} from '../inputRelationCandidateProducer';

function envelope(traceId: string, rows: Record<string, unknown>[]): DataEnvelope {
  return createDataEnvelope({rows: rows as any}, {
    type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
    skillId: 'click_response_analysis', stepId: 'slow_input_events',
    executionStatus: rows.length > 0 ? 'observed' : 'empty',
    evidenceRefId: `data:real:${traceId}:slow_input_events`,
    sourceToolCallId: `invoke_skill:real:${traceId}:slow_input_events`,
    traceId, traceSide: 'current',
  });
}

describe('inputRelationCandidateProducer real traces', () => {
  it('does not crash or invent relations for current empty customer and constructed slow-event rows', async () => {
    const fixtures = [
      {traceId: 'android-scroll-customer', package: 'com.example.wechatfriendforcustomscroller'},
      {traceId: 'input-interaction-latency', package: ''},
    ];

    for (const fixture of fixtures) {
      const evaluator = new SkillEvaluator('click_response_analysis');
      try {
        await evaluator.loadTrace(resolveTraceCase(fixture.traceId));
        const result = await evaluator.executeStep('slow_input_events', {
          package: fixture.package,
          slow_event_threshold_ms: 100,
          critical_event_threshold_ms: 200,
          enable_per_event_detail: false,
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
        expect(produceInputRelationCandidates([envelope(fixture.traceId, result.data)])).toEqual([]);
      } finally {
        await evaluator.cleanup();
      }
    }
  }, 240_000);
});
