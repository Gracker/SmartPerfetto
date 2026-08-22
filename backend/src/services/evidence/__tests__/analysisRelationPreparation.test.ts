// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';

import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {createDataEnvelope} from '../../../types/dataContract';
import {assessFinalResultQuality} from '../../finalResultQualityGate';
import {runClaimVerification} from '../../verifier/claimVerificationRunner';
import {
  prepareAnalysisRelations,
  runPreparedAnalysisClaimVerification,
} from '../analysisRelationPreparation';

function evidence() {
  return [
    createDataEnvelope({columns: ['start_ts', 'end_ts'], rows: [['10', '100']]}, {
      type: 'skill_result', source: 'startup_analysis', title: 'startups', skillId: 'startup_analysis',
      stepId: 'get_startups', evidenceRefId: 'data:startup', sourceToolCallId: 'invoke_skill:startups',
      traceId: 'trace-a', traceSide: 'current',
    }),
    createDataEnvelope({columns: ['ts_str', 'dur_str', 'server_process'], rows: [['20', '10', 'system_server']]}, {
      type: 'skill_result', source: 'startup_analysis', title: 'binder', skillId: 'startup_analysis',
      stepId: 'main_thread_binder_blocking', evidenceRefId: 'data:binder', sourceToolCallId: 'invoke_skill:binder',
      traceId: 'trace-a', traceSide: 'current',
    }),
  ];
}

function contract(): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1', mode: 'initial_report', conclusions: [], clusters: [], evidenceChain: [],
    claims: [{
      id: 'causal-object', kind: 'causal', text: 'Binder overlaps startup',
      references: [{
        evidenceRefId: 'data:binder', sourceToolCallId: 'invoke_skill:binder',
        rowIndex: 0, column: 'server_process', value: 'system_server',
      }],
    }, {
      id: 'causal-subject', kind: 'causal', text: 'Startup window exists',
      references: [{evidenceRefId: 'data:startup', rowIndex: 0, column: 'start_ts', value: '10'}],
    }, {
      id: 'causal-source-ref-only', kind: 'causal', text: 'Binder by title',
      references: [{sourceRef: 'binder', rowIndex: 0, column: 'server_process', value: 'system_server'}],
    }, {
      id: 'numeric', kind: 'numeric', text: 'one server',
      references: [{evidenceRefId: 'data:binder', rowIndex: 0, column: 'server_process', value: 'system_server'}],
    }],
    uncertainties: [], nextSteps: [],
  };
}

function scrollingEvidence() {
  return createDataEnvelope({
    columns: ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code', 'primary_cause'],
    rows: [
      ['101', '200', '1500000', '1.5', 'workload_heavy', 'long task'],
      ['102', '400', '2000000', '2', 'Invalid', 'garbage collection'],
    ],
  }, {
    type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
    skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause', executionStatus: 'observed',
    evidenceRefId: 'data:scrolling', sourceToolCallId: 'invoke_skill:scrolling',
    traceId: 'trace-a', traceSide: 'current',
  });
}

function scrollingContract(): ConclusionContract {
  const reference = (column: string, value: string | number, overrides: Record<string, unknown> = {}) => ({
    evidenceRefId: 'data:scrolling', sourceToolCallId: 'invoke_skill:scrolling',
    rowIndex: 0, column, value, ...overrides,
  });
  return {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
    claims: [
      {id: 'reason', kind: 'causal', text: 'reason caused jank', references: [reference('reason_code', 'workload_heavy')]},
      {id: 'primary', kind: 'causal', text: 'primary cause caused jank', references: [reference('primary_cause', 'long task')]},
      {id: 'duration', kind: 'causal', text: 'duration proves cause', references: [reference('dur_ms', 1.5)]},
      {id: 'frame-and-primary', kind: 'causal', text: 'frame and primary cause', references: [
        reference('frame_id', '101'), reference('primary_cause', 'long task'),
      ]},
      {id: 'different-row', kind: 'causal', text: 'other row', references: [reference('reason_code', 'gc_jank', {rowIndex: 1})]},
      {id: 'subject-only', kind: 'causal', text: 'frame exists', references: [reference('frame_id', '101')]},
      {id: 'source-ref-only', kind: 'causal', text: 'title only', references: [{sourceRef: 'root causes', rowIndex: 0, column: 'reason_code', value: 'workload_heavy'}]},
      {id: 'wrong-tool', kind: 'causal', text: 'wrong tool', references: [reference('reason_code', 'workload_heavy', {sourceToolCallId: 'invoke_skill:wrong'})]},
      {id: 'wrong-envelope', kind: 'causal', text: 'wrong envelope', references: [reference('reason_code', 'workload_heavy', {evidenceRefId: 'data:wrong'})]},
    ],
    uncertainties: [], nextSteps: [],
  };
}

describe('analysisRelationPreparation', () => {
  it('combines scrolling derived candidates with startup candidates', () => {
    const scrolling = createDataEnvelope({
      columns: ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code'],
      rows: [['9007199254740993', '200', '1500000', '1.5', 'workload_heavy']],
    }, {
      type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
      skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
      executionStatus: 'observed', evidenceRefId: 'data:scrolling',
      sourceToolCallId: 'invoke_skill:scrolling', traceId: 'trace-a', traceSide: 'current',
    });

    const prepared = prepareAnalysisRelations({dataEnvelopes: [...evidence(), scrolling]});

    expect(prepared.relationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: 'overlap'}),
      expect.objectContaining({kind: 'derived'}),
    ]));
  });

  it('binds heuristic causal claims at row level except subject-only and mismatched references', () => {
    const prepared = prepareAnalysisRelations({
      conclusionContract: scrollingContract(), dataEnvelopes: [scrollingEvidence()],
    });

    expect(prepared.relationCandidates).toHaveLength(1);
    expect(prepared.relationActivationClaimIds).toEqual(['reason', 'primary', 'duration', 'frame-and-primary']);
    for (const index of [0, 1, 2, 3]) {
      expect(prepared.conclusionContract?.claims?.[index].relationRefs).toHaveLength(1);
    }
    for (const index of [4, 5, 6, 7, 8]) {
      expect(prepared.conclusionContract?.claims?.[index].relationRefs).toBeUndefined();
    }
  });

  it('keeps heuristic causal claims at candidate/inference and blocked by the final quality gate', () => {
    const prepared = prepareAnalysisRelations({
      conclusionContract: scrollingContract(), dataEnvelopes: [scrollingEvidence()],
    });
    const result = runPreparedAnalysisClaimVerification({
      conclusionContract: scrollingContract(), dataEnvelopes: [scrollingEvidence()], policy: 'record_only',
    });
    expect(result.claimSupport.find(item => item.claimId === 'primary')).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate', supportLevel: 'inference',
    }));
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'primary', code: 'causal_relation_candidate'}),
    ]));
    expect(assessFinalResultQuality({
      result: {
        sessionId: 'session', success: true, findings: [], hypotheses: [],
        conclusion: 'The row classifies frame 101 as workload_heavy.', confidence: 0.5,
        rounds: 1, totalDurationMs: 1, conclusionContract: prepared.conclusionContract || undefined,
        claimSupport: result.claimSupport, claimVerificationResult: result.claimVerificationResult,
      },
      query: 'analyze why this scroll trace is janky',
    })).toBeDefined();
  });

  it('binds only causal claims with explicit object-row references without mutating the model contract', () => {
    const original = contract();
    const before = structuredClone(original);
    const prepared = prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: evidence()});

    expect(original).toEqual(before);
    expect(prepared.conclusionContract).not.toBe(original);
    expect(prepared.relationCandidates).toHaveLength(1);
    expect(prepared.relationActivationClaimIds).toEqual(['causal-object']);
    expect(prepared.conclusionContract?.claims?.[0].relationRefs).toEqual([prepared.relationCandidates?.[0].id]);
    expect(prepared.conclusionContract?.claims?.[1].relationRefs).toBeUndefined();
    expect(prepared.conclusionContract?.claims?.[2].relationRefs).toBeUndefined();
    expect(prepared.conclusionContract?.claims?.[3].relationRefs).toBeUndefined();
  });

  it('keeps unmatched causal claims not_configured and matched overlap causal claims inference', () => {
    const prepared = prepareAnalysisRelations({conclusionContract: contract(), dataEnvelopes: evidence()});
    const result = runClaimVerification({...prepared, dataEnvelopes: evidence(), policy: 'record_only'});

    expect(result.claimSupport.find(item => item.claimId === 'causal-object')).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate', supportLevel: 'inference',
    }));
    expect(result.claimSupport.find(item => item.claimId === 'causal-subject')?.relationEvaluation).toBe('not_configured');
    expect(result.claimSupport.find(item => item.claimId === 'causal-source-ref-only')?.relationEvaluation).toBe('not_configured');
    expect(result.claimSupport.find(item => item.claimId === 'numeric')?.relationEvaluation).toBeUndefined();
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'causal-object', code: 'causal_relation_candidate'}),
    ]));
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'causal-subject', code: 'causal_relation_missing'}),
    ]));
  });

  it('returns original contract and undefined candidates when no exact producer match exists', () => {
    const original = contract();
    expect(prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: [evidence()[0]]}))
      .toEqual({conclusionContract: original});
  });

  it('runs transient preparation through the shared verifier seam', () => {
    const original = contract();
    const before = structuredClone(original);

    const result = runPreparedAnalysisClaimVerification({
      conclusionContract: original,
      dataEnvelopes: evidence(),
      policy: 'record_only',
    });

    expect(original).toEqual(before);
    expect(result.evidenceContract.relations).toHaveLength(1);
    expect(result.claimSupport.find(item => item.claimId === 'causal-object')).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate', supportLevel: 'inference',
    }));
  });

  it('keeps HTTP, CLI, and replay on the same preparation seam', () => {
    const sources = [
      path.resolve(__dirname, '../../../routes/agentRoutes.ts'),
      path.resolve(__dirname, '../../../cli-user/services/cliAnalyzeService.ts'),
      path.resolve(__dirname, '../../selfEvolution/orchestratorReplayExecutor.ts'),
    ].map(file => fs.readFileSync(file, 'utf8'));

    for (const source of sources) {
      expect(source).toContain('runPreparedAnalysisClaimVerification');
    }
  });
});
