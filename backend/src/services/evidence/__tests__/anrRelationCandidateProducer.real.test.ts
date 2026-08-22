// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {resolveTraceCase} from '../../../utils/traceCorpus';
import {SkillEvaluator} from '../../../../tests/skill-eval/runner';
import {produceAnrRelationCandidates} from '../anrRelationCandidateProducer';

function envelope(traceId: string, rows: Record<string, unknown>[]): DataEnvelope {
  return createDataEnvelope({rows: rows as any}, {
    type: 'skill_result', source: 'anr_analysis', title: 'ANR events',
    skillId: 'anr_analysis', stepId: 'get_anr_events',
    executionStatus: rows.length > 0 ? 'observed' : 'empty',
    evidenceRefId: `data:real:${traceId}:get_anr_events`,
    sourceToolCallId: `invoke_skill:real:${traceId}:get_anr_events`,
    traceId, traceSide: 'current',
  });
}

describe('anrRelationCandidateProducer real traces', () => {
  it('emits one auditable relation from the constructed ANR trace and none from a current no-ANR trace', async () => {
    const positive = new SkillEvaluator('anr_analysis');
    try {
      await positive.loadTrace(resolveTraceCase('binder-io-blocking'));
      const result = await positive.executeStep('get_anr_events', {
        multi_anr_threshold: 3,
        multi_anr_span_seconds: 10,
        enable_detail_analysis: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          error_id: 'smartperfetto-synthetic-anr',
          trigger_type: 'input_dispatching_timeout',
          anr_ts: expect.any(String),
          perfetto_start: expect.any(String),
        }),
      ]));
      const candidates = produceAnrRelationCandidates([envelope('binder-io-blocking', result.data)]);
      expect(candidates).toEqual([
        expect.objectContaining({
          kind: 'derived',
          subject: expect.objectContaining({column: 'error_id', value: 'smartperfetto-synthetic-anr'}),
          object: expect.objectContaining({column: 'trigger_type', value: 'input_dispatching_timeout'}),
        }),
      ]);
    } finally {
      await positive.cleanup();
    }

    const empty = new SkillEvaluator('anr_analysis');
    try {
      await empty.loadTrace(resolveTraceCase('android-startup-light'));
      const result = await empty.executeStep('get_anr_events', {
        multi_anr_threshold: 3,
        multi_anr_span_seconds: 10,
        enable_detail_analysis: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Condition not met');
      expect(result.data).toEqual([]);
      expect(produceAnrRelationCandidates([envelope('android-startup-light', result.data)])).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  }, 240_000);
});
