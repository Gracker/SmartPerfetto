// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import type {EvidenceRelationCandidateV1} from '../../../types/evidenceContract';
import {bindRelationCandidatesToClaims} from '../relationCandidateClaimBinder';

function contract(): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [{
      id: 'object-row',
      kind: 'causal',
      text: 'Binder overlaps startup',
      references: [{evidenceRefId: 'data:binder', rowIndex: 3, column: 'server_process'}],
      relationRefs: ['model-invented-relation'],
    }, {
      id: 'subject-row',
      kind: 'causal',
      text: 'Startup exists',
      references: [{evidenceRefId: 'data:startup', rowIndex: 1, column: 'start_ts'}],
    }, {
      id: 'proof-row',
      kind: 'causal',
      text: 'Proof exists',
      references: [{evidenceRefId: 'data:proof', rowIndex: 2, column: 'subject_utid'}],
    }, {
      id: 'source-ref-only',
      kind: 'causal',
      text: 'Title matches',
      references: [{sourceRef: 'data:binder', rowIndex: 3, column: 'server_process'}],
    }, {
      id: 'numeric-object-row',
      kind: 'numeric',
      text: 'Binder duration',
      references: [{evidenceRefId: 'data:binder', rowIndex: 3, column: 'dur_str'}],
    }],
    uncertainties: [],
    nextSteps: [],
  };
}

function candidate(): EvidenceRelationCandidateV1 {
  return {
    schemaVersion: 'evidence_relation_candidate@1',
    id: 'relation:startup-binder-overlap:1234',
    kind: 'overlap',
    direction: 'subject_to_object',
    subject: {evidenceRefId: 'data:startup', rowIndex: 1},
    object: {evidenceRefId: 'data:binder', rowIndex: 3},
    proof: {evidenceRefId: 'data:proof', rowIndex: 2},
  };
}

describe('relationCandidateClaimBinder', () => {
  it('clones and binds only causal object-row references to producer-authored ids', () => {
    const original = contract();
    const before = structuredClone(original);

    const bound = bindRelationCandidatesToClaims(original, [candidate()]);

    expect(original).toEqual(before);
    expect(bound.conclusionContract).not.toBe(original);
    expect(bound.relationActivationClaimIds).toEqual(['object-row']);
    expect(bound.conclusionContract.claims?.[0].relationRefs).toEqual([
      'model-invented-relation',
      candidate().id,
    ]);
    for (const index of [1, 2, 3, 4]) {
      expect(bound.conclusionContract.claims?.[index].relationRefs).toBeUndefined();
    }
  });

  it('returns a clone with no activation when candidates do not match an object row', () => {
    const original = contract();
    const unmatched = {...candidate(), object: {evidenceRefId: 'data:binder', rowIndex: 4}};

    const bound = bindRelationCandidatesToClaims(original, [unmatched]);

    expect(bound.conclusionContract).not.toBe(original);
    expect(bound.relationActivationClaimIds).toEqual([]);
    expect(bound.conclusionContract).toEqual(original);
  });

  it('requires every stable endpoint identifier to match', () => {
    const original = contract();
    original.claims![0].references[0].sourceToolCallId = 'invoke_skill:wrong';
    const identifiedCandidate = {
      ...candidate(),
      object: {
        evidenceRefId: 'data:binder',
        sourceToolCallId: 'invoke_skill:binder',
        rowIndex: 3,
      },
    };

    const bound = bindRelationCandidatesToClaims(original, [identifiedCandidate]);

    expect(bound.relationActivationClaimIds).toEqual([]);
    expect(bound.conclusionContract.claims?.[0].relationRefs).toEqual(['model-invented-relation']);
  });
});
