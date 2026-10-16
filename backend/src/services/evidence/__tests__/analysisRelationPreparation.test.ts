// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {createDataEnvelope} from '../../../types/dataContract';
import type {EvidenceRelationCandidateV1} from '../../../types/evidenceContract';
import * as claimRunner from '../../verifier/claimVerificationRunner';
import {prepareClaimEvidence, type PreparedClaimEvidence} from '../claimEvidencePreparation';
import * as startupProducer from '../startupRelationCandidateProducer';
import * as scrollingProducer from '../scrollingRelationCandidateProducer';
import * as inputProducer from '../inputRelationCandidateProducer';
import * as anrProducer from '../anrRelationCandidateProducer';
import {prepareAnalysisRelations, runPreparedAnalysisClaimVerification} from '../analysisRelationPreparation';

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

function inputEvidence() {
  return createDataEnvelope({
    columns: ['frame_id', 'event_ts', 'event_end_ts', 'main_bottleneck', 'severity', 'total_ms', 'frame_association'],
    rows: [
      ['301', '1000', '2000', '应用处理', 'critical', 250, 'exact'],
      ['302', '3000', '4000', 'unknown', 'warning', 150, 'exact'],
    ],
  }, {
    type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
    skillId: 'click_response_analysis', stepId: 'slow_input_events', executionStatus: 'observed',
    evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
    traceId: 'trace-a', traceSide: 'current',
  });
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

function modelProposal(id = 'model-relation'): EvidenceRelationCandidateV1 {
  return {schemaVersion: 'evidence_relation_candidate@1', id, kind: 'overlap', direction: 'subject_to_object',
    subject: {evidenceRefId: 'data:startup', rowIndex: 0}, object: {evidenceRefId: 'data:binder', rowIndex: 0}};
}

describe('analysisRelationPreparation', () => {
  it('keeps all four producer outputs as candidates without inventing claims', () => {
    const prepared = prepareAnalysisRelations({dataEnvelopes: [...evidence(), scrollingEvidence(), inputEvidence(), anrEvidence()]});
    expect(prepared.relationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({kind: 'overlap'}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'reason_code'})}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'main_bottleneck'})}),
      expect.objectContaining({kind: 'derived', object: expect.objectContaining({column: 'trigger_type'})}),
    ]));
    expect(prepared.conclusionContract).toBeUndefined();
    expect(prepared.relationActivationClaimIds).toEqual([]);
  });

  it('merges original proposals, supplied candidates, and producer candidates without changing declarations', () => {
    const original = contract();
    original.relationProposals = [modelProposal()];
    original.claims![0].relationRefs = ['model-relation', 'unknown-ref'];
    const before = structuredClone(original);
    const supplied = modelProposal('supplied-relation');
    const prepared = prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: evidence(), relationCandidates: [supplied]});

    expect(prepared.relationCandidates).toHaveLength(3);
    expect(prepared.relationCandidates?.slice(0, 2)).toEqual([modelProposal(), supplied]);
    expect(prepared.relationCandidates?.[2].id).not.toBe('model-relation');
    expect(prepared.relationActivationClaimIds).toEqual(['causal-object']);
    expect(prepared.conclusionContract).toEqual(before);
    expect(prepared.conclusionContract).not.toBe(original);
    expect(original).toEqual(before);
  });

  it('processes model proposals even when no data producer matches', () => {
    const original = contract();
    original.relationProposals = [modelProposal()];
    original.claims![0].relationRefs = ['model-relation'];
    const prepared = prepareAnalysisRelations({conclusionContract: original});
    expect(prepared.relationCandidates).toEqual(original.relationProposals);
    expect(prepared.relationActivationClaimIds).toEqual(['causal-object']);
    expect(prepared.conclusionContract).toEqual(original);
  });

  it('preserves causal, numeric, subject, and object claims without adding any implicit refs', () => {
    const original = contract();
    const prepared = prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: evidence()});
    expect(prepared.relationCandidates).toHaveLength(1);
    expect(prepared.relationActivationClaimIds).toEqual([]);
    expect(prepared.conclusionContract).toEqual(original);
    expect(prepared.conclusionContract?.claims?.every(claim => claim.relationRefs === undefined)).toBe(true);
  });

  it('activates an explicitly referenced producer candidate without changing the claim', () => {
    const candidate = prepareAnalysisRelations({dataEnvelopes: evidence()}).relationCandidates![0];
    const original = contract();
    original.claims![0].relationRefs = [candidate.id];
    const prepared = prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: evidence()});
    expect(prepared.relationActivationClaimIds).toEqual(['causal-object']);
    expect(prepared.conclusionContract).toEqual(original);
  });

  it('retains identical candidate declarations and any ID conflict without selecting a winner', () => {
    const proposal = modelProposal();
    const original = contract();
    original.relationProposals = [proposal];
    original.claims![0].relationRefs = [proposal.id];
    const repeated = prepareAnalysisRelations({conclusionContract: original, relationCandidates: [structuredClone(proposal)]});
    expect(repeated.relationCandidates).toEqual([proposal, proposal]);
    expect(repeated.relationActivationClaimIds).toEqual(['causal-object']);
    const conflict = {...proposal, object: {evidenceRefId: 'different-result', rowIndex: 9}};
    const ambiguous = prepareAnalysisRelations({conclusionContract: original, relationCandidates: [conflict]});
    expect(ambiguous.relationCandidates).toEqual([proposal, conflict]);
    expect(ambiguous.relationActivationClaimIds).toEqual([]);
    expect(ambiguous.conclusionContract).toEqual(original);
  });

  it('returns the unchanged contract when no proposal or producer candidate exists', () => {
    const original = contract();
    expect(prepareAnalysisRelations({conclusionContract: original, dataEnvelopes: [evidence()[0]]}))
      .toEqual({conclusionContract: original});
  });

  it('passes binding eligibility with merged candidates to the runner when evidence has not been prepared', () => {
    const runner = jest.spyOn(claimRunner, 'runClaimVerification');
    const boundary = new Error('runner boundary');
    runner.mockImplementation(() => {throw boundary;});
    try {
      const original = contract();
      original.relationProposals = [modelProposal()];
      const supplied = modelProposal('supplied');
      const input: claimRunner.ClaimVerificationRunnerInput = {conclusionContract: original, dataEnvelopes: evidence(),
        relationCandidates: [supplied], bindingEligibility: 'ineligible', policy: 'record_only'};
      expect(() => runPreparedAnalysisClaimVerification(input)).toThrow(boundary);
      expect(runner).toHaveBeenCalledTimes(1);
      const received = runner.mock.calls[0][0];
      expect(received.bindingEligibility).toBe('ineligible');
      expect(received.conclusionContract).toEqual(original);
      expect(received.relationCandidates).toHaveLength(3);
      expect(received.relationCandidates?.slice(0, 2)).toEqual([modelProposal(), supplied]);
      expect(received.dataEnvelopes).toBe(input.dataEnvelopes);
    } finally {
      runner.mockRestore();
    }
  });

  it.each(['issued', 'null', 'forged'] as const)('passes a supplied %s prepared handle unchanged without producing preview candidates', async mode => {
    const original = contract();
    const relations = [modelProposal()];
    const preparedEvidence = mode === 'issued'
      ? await prepareClaimEvidence({conclusionContract: original, relationCandidates: relations, bindingEligibility: 'eligible'})
      : mode === 'null' ? null as unknown as PreparedClaimEvidence
      : {kind: 'prepared_claim_evidence' as const, fingerprint: 'forged-handle'};
    const input: claimRunner.ClaimVerificationRunnerInput = {conclusionContract: original, dataEnvelopes: evidence(),
      relationCandidates: relations, relationActivationClaimIds: ['original-activation'],
      preparedEvidence, bindingEligibility: 'ineligible', policy: 'record_only'};
    const producers = [
      jest.spyOn(startupProducer, 'produceStartupRelationCandidates'),
      jest.spyOn(scrollingProducer, 'produceScrollingRelationCandidates'),
      jest.spyOn(inputProducer, 'produceInputRelationCandidates'),
      jest.spyOn(anrProducer, 'produceAnrRelationCandidates'),
    ];
    const runner = jest.spyOn(claimRunner, 'runClaimVerification');
    const boundary = new Error('runner owns prepared validation');
    runner.mockImplementation(() => {throw boundary;});
    try {
      expect(() => runPreparedAnalysisClaimVerification(input)).toThrow(boundary);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0]).toBe(input);
      expect(runner.mock.calls[0][0].preparedEvidence).toBe(preparedEvidence);
      expect(runner.mock.calls[0][0].relationCandidates).toBe(relations);
      for (const producer of producers) expect(producer).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
      for (const producer of producers) producer.mockRestore();
    }
  });


});
