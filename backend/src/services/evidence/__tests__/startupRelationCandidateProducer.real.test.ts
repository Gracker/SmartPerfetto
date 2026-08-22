// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {resolveTraceCase} from '../../../utils/traceCorpus';
import {SkillEvaluator} from '../../../../tests/skill-eval/runner';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {produceStartupRelationCandidates} from '../startupRelationCandidateProducer';

function envelope(stepId: string, rows: Record<string, unknown>[]): DataEnvelope {
  return createDataEnvelope({rows: rows as any}, {
    type: 'skill_result',
    source: 'startup_analysis',
    title: stepId,
    skillId: 'startup_analysis',
    stepId,
    executionStatus: rows.length > 0 ? 'observed' : 'empty',
    evidenceRefId: `data:real:${stepId}`,
    sourceToolCallId: `invoke_skill:real:${stepId}`,
    traceId: 'android-startup-light',
    traceSide: 'current',
  });
}

describe('startupRelationCandidateProducer real trace', () => {
  it('verifies startup/Binder overlap on android-startup-light without false fallback relations', async () => {
    const evaluator = new SkillEvaluator('startup_analysis');
    try {
      await evaluator.loadTrace(resolveTraceCase('android-startup-light'));
      const [startups, quality, binders] = await evaluator.executeStepSequence([
        'get_startups',
        'startup_quality',
        'main_thread_binder_blocking',
      ], {package: '', analysis_mode: 'full'});
      expect(startups.success).toBe(true);
      expect(quality.success).toBe(true);
      expect(binders.success).toBe(true);

      const dataEnvelopes = [
        envelope('get_startups', startups.data),
        envelope('main_thread_binder_blocking', binders.data),
      ];
      const candidates = produceStartupRelationCandidates(dataEnvelopes);
      const evidence = buildEvidenceContract({dataEnvelopes, relationCandidates: candidates});

      if (binders.data.length > 0) {
        expect(candidates.length).toBeGreaterThan(0);
        expect(evidence.relations.some(relation =>
          relation.kind === 'overlap' && relation.verificationStatus === 'verified')).toBe(true);
      } else {
        expect(candidates).toEqual([]);
        expect(evidence.relations).toEqual([]);
      }

      const deterministicPositive = [
        envelope('get_startups', [{start_ts: '10', end_ts: '100'}]),
        envelope('main_thread_binder_blocking', [{ts_str: '20', dur_str: '10'}]),
      ];
      const positiveCandidates = produceStartupRelationCandidates(deterministicPositive);
      expect(buildEvidenceContract({
        dataEnvelopes: deterministicPositive,
        relationCandidates: positiveCandidates,
      }).relations).toEqual([
        expect.objectContaining({kind: 'overlap', verificationStatus: 'verified'}),
      ]);
    } finally {
      await evaluator.cleanup();
    }
  }, 120_000);
});
