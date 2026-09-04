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

function inputEvidence() {
  return createDataEnvelope({
    columns: ['frame_id', 'event_ts', 'event_end_ts', 'main_bottleneck', 'severity', 'total_ms'],
    rows: [
      ['301', '1000', '2000', '应用处理', 'critical', 250],
      ['302', '3000', '4000', 'unknown', 'warning', 150],
    ],
  }, {
    type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
    skillId: 'click_response_analysis', stepId: 'slow_input_events', executionStatus: 'observed',
    evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
    traceId: 'trace-a', traceSide: 'current',
  });
}

function inputContract(): ConclusionContract {
  const reference = (column: string, value: string | number, overrides: Record<string, unknown> = {}) => ({
    evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
    rowIndex: 0, column, value, ...overrides,
  });
  return {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
    claims: [
      {id: 'bottleneck', kind: 'causal', text: 'application handling caused the delay', references: [reference('main_bottleneck', '应用处理')]},
      {id: 'latency', kind: 'causal', text: 'latency proves the cause', references: [reference('total_ms', 250)]},
      {id: 'severity', kind: 'causal', text: 'severity proves the cause', references: [reference('severity', 'critical')]},
      {id: 'frame-and-latency', kind: 'causal', text: 'frame and latency', references: [
        reference('frame_id', '301'), reference('total_ms', 250),
      ]},
      {id: 'frame-only', kind: 'causal', text: 'frame exists', references: [reference('frame_id', '301')]},
      {id: 'different-row', kind: 'causal', text: 'other row', references: [reference('total_ms', 150, {rowIndex: 1})]},
      {id: 'wrong-tool', kind: 'causal', text: 'wrong tool', references: [reference('main_bottleneck', '应用处理', {sourceToolCallId: 'invoke_skill:wrong'})]},
      {id: 'wrong-envelope', kind: 'causal', text: 'wrong envelope', references: [reference('main_bottleneck', '应用处理', {evidenceRefId: 'data:wrong'})]},
    ],
    uncertainties: [], nextSteps: [],
  };
}

function anrEvidence() {
  return createDataEnvelope({
    columns: ['error_id', 'trigger_type', 'perfetto_start', 'anr_ts', 'root_cause_pattern_hints', 'subject_preview'],
    rows: [
      ['smartperfetto-synthetic-anr', 'input_dispatching_timeout', '100', '200', 'deadlock,memory', 'blocked prose'],
      ['anr-2', '输入超时', '300', '400', 'io', 'other prose'],
    ],
  }, {
    type: 'skill_result', source: 'anr_analysis', title: 'ANR events',
    skillId: 'anr_analysis', stepId: 'get_anr_events', executionStatus: 'observed',
    evidenceRefId: 'data:anr', sourceToolCallId: 'invoke_skill:anr',
    traceId: 'trace-a', traceSide: 'current',
  });
}

function anrContract(): ConclusionContract {
  const reference = (column: string, value: string | number, overrides: Record<string, unknown> = {}) => ({
    evidenceRefId: 'data:anr', sourceToolCallId: 'invoke_skill:anr',
    rowIndex: 0, column, value, ...overrides,
  });
  return {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
    claims: [
      {id: 'trigger', kind: 'causal', text: 'input dispatching timeout caused the ANR', references: [reference('trigger_type', 'input_dispatching_timeout')]},
      {id: 'hint', kind: 'causal', text: 'root cause hint proves deadlock', references: [reference('root_cause_pattern_hints', 'deadlock,memory')]},
      {id: 'subject', kind: 'causal', text: 'subject prose proves blocking', references: [reference('subject_preview', 'blocked prose')]},
      {id: 'error-and-hint', kind: 'causal', text: 'error and hint', references: [
        reference('error_id', 'smartperfetto-synthetic-anr'), reference('root_cause_pattern_hints', 'deadlock,memory'),
      ]},
      {id: 'error-only', kind: 'causal', text: 'error exists', references: [reference('error_id', 'smartperfetto-synthetic-anr')]},
      {id: 'different-row', kind: 'causal', text: 'other ANR', references: [reference('trigger_type', 'broadcast_timeout', {rowIndex: 1})]},
      {id: 'wrong-tool', kind: 'causal', text: 'wrong tool', references: [reference('trigger_type', 'input_dispatching_timeout', {sourceToolCallId: 'invoke_skill:wrong'})]},
      {id: 'wrong-envelope', kind: 'causal', text: 'wrong envelope', references: [reference('trigger_type', 'input_dispatching_timeout', {evidenceRefId: 'data:wrong'})]},
    ],
    uncertainties: [], nextSteps: [],
  };
}

describe('analysisRelationPreparation', () => {
  it('combines input, scrolling, and ANR derived candidates with startup candidates', () => {
    const scrolling = createDataEnvelope({
      columns: ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code'],
      rows: [['9007199254740993', '200', '1500000', '1.5', 'workload_heavy']],
    }, {
      type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
      skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
      executionStatus: 'observed', evidenceRefId: 'data:scrolling',
      sourceToolCallId: 'invoke_skill:scrolling', traceId: 'trace-a', traceSide: 'current',
    });

    const prepared = prepareAnalysisRelations({dataEnvelopes: [...evidence(), scrolling, inputEvidence(), anrEvidence()]});

    expect(prepared.relationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: 'overlap'}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'reason_code'})}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'main_bottleneck'})}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'trigger_type'})}),
    ]));
  });

  it('binds only the ANR trigger object cell and ignores same-row hints or prose', () => {
    const prepared = prepareAnalysisRelations({
      conclusionContract: anrContract(), dataEnvelopes: [anrEvidence()],
    });

    expect(prepared.relationCandidates).toHaveLength(1);
    expect(prepared.relationActivationClaimIds).toEqual(['trigger']);
    expect(prepared.conclusionContract?.claims?.[0].relationRefs).toHaveLength(1);
    for (const index of [1, 2, 3, 4, 5, 6, 7]) {
      expect(prepared.conclusionContract?.claims?.[index].relationRefs).toBeUndefined();
    }
  });

  it('keeps ANR trigger causality at inference and blocked by the final quality gate', () => {
    const triggerOnly = anrContract();
    triggerOnly.claims = triggerOnly.claims?.slice(0, 1);
    const prepared = prepareAnalysisRelations({
      conclusionContract: triggerOnly, dataEnvelopes: [anrEvidence()],
    });
    const result = runPreparedAnalysisClaimVerification({
      conclusionContract: triggerOnly, dataEnvelopes: [anrEvidence()], policy: 'record_only',
    });

    expect(result.claimSupport.find(item => item.claimId === 'trigger')).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate', supportLevel: 'inference',
      relationAnchors: expect.arrayContaining([
        expect.objectContaining({timeRange: {startTs: '100', endTs: '200', unit: 'ns', source: 'row'}}),
      ]),
    }));
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'trigger', code: 'causal_relation_candidate'}),
    ]));
    expect(assessFinalResultQuality({
      result: {
        sessionId: 'session', success: true, findings: [], hypotheses: [],
        conclusion: 'The ANR event is classified as input_dispatching_timeout.', confidence: 0.5,
        rounds: 1, totalDurationMs: 1, conclusionContract: prepared.conclusionContract || undefined,
        claimSupport: result.claimSupport, claimVerificationResult: result.claimVerificationResult,
      },
      query: 'analyze why this ANR happened',
    })).toBeDefined();
  });

  it('binds same-row input causal claims except frame-only and mismatched references', () => {
    const prepared = prepareAnalysisRelations({
      conclusionContract: inputContract(), dataEnvelopes: [inputEvidence()],
    });

    expect(prepared.relationCandidates).toHaveLength(1);
    expect(prepared.relationActivationClaimIds).toEqual([
      'bottleneck', 'latency', 'severity', 'frame-and-latency',
    ]);
    for (const index of [0, 1, 2, 3]) {
      expect(prepared.conclusionContract?.claims?.[index].relationRefs).toHaveLength(1);
    }
    for (const index of [4, 5, 6, 7]) {
      expect(prepared.conclusionContract?.claims?.[index].relationRefs).toBeUndefined();
    }
  });

  it('keeps synthetic input bottleneck causality at inference and blocked by the final quality gate', () => {
    const bottleneckOnly = inputContract();
    bottleneckOnly.claims = bottleneckOnly.claims?.slice(0, 1);
    const prepared = prepareAnalysisRelations({
      conclusionContract: bottleneckOnly, dataEnvelopes: [inputEvidence()],
    });
    const result = runPreparedAnalysisClaimVerification({
      conclusionContract: bottleneckOnly, dataEnvelopes: [inputEvidence()], policy: 'record_only',
    });

    expect(result.claimSupport.find(item => item.claimId === 'bottleneck')).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate', supportLevel: 'inference',
      relationAnchors: expect.arrayContaining([
        expect.objectContaining({timeRange: {startTs: '1000', endTs: '2000', unit: 'ns', source: 'row'}}),
      ]),
    }));
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'bottleneck', code: 'causal_relation_candidate'}),
    ]));
    expect(assessFinalResultQuality({
      result: {
        sessionId: 'session', success: true, findings: [], hypotheses: [],
        conclusion: 'Frame 301 is classified with application handling as its main bottleneck.', confidence: 0.5,
        rounds: 1, totalDurationMs: 1, conclusionContract: prepared.conclusionContract || undefined,
        claimSupport: result.claimSupport, claimVerificationResult: result.claimVerificationResult,
      },
      query: 'analyze why this input event is slow',
    })).toBeDefined();
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

describe('a root-cause sentence reaches relation binding without declaring its kind', () => {
  const scrollingEvidence = () => createDataEnvelope({
    columns: ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code'],
    rows: [['9007199254740993', '200', '1500000', '1.5', 'workload_heavy']],
  }, {
    type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
    skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
    executionStatus: 'observed', evidenceRefId: 'data:scrolling',
    sourceToolCallId: 'invoke_skill:scrolling', traceId: 'trace-a', traceSide: 'current',
  });

  function contractFor(text: string): ConclusionContract {
    // No `kind` field: conclusions reach the contract through the markdown
    // citation block, which has never carried one.
    return {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{
        id: 'claim-root-cause',
        text,
        references: [{
          evidenceRefId: 'data:scrolling',
          sourceToolCallId: 'invoke_skill:scrolling',
          rowIndex: 0,
          column: 'reason_code',
          value: 'workload_heavy',
        }],
      }],
    } as ConclusionContract;
  }

  it('binds a producer relation to a causal sentence the model never labelled', () => {
    // Relation producers ran in production all along, but binding requires a
    // causal claim and nothing ever produced one — the whole causal branch of
    // verification sat unreachable behind a field the prompt never asks for.
    const prepared = prepareAnalysisRelations({
      conclusionContract: contractFor('workload_heavy 导致该帧掉帧'),
      dataEnvelopes: [scrollingEvidence()],
    });

    expect(prepared.relationActivationClaimIds).toEqual(['claim-root-cause']);
    expect(prepared.conclusionContract?.claims?.[0].relationRefs?.length).toBeGreaterThan(0);
  });

  it('leaves a plain measurement unbound', () => {
    const prepared = prepareAnalysisRelations({
      conclusionContract: contractFor('该帧 reason_code 为 workload_heavy'),
      dataEnvelopes: [scrollingEvidence()],
    });

    expect(prepared.relationActivationClaimIds).toEqual([]);
  });
});
