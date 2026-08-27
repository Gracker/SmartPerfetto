// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { runClaimVerification } from '../claimVerificationRunner';
import { runDeterministicClaimVerifier } from '../deterministicClaimVerifier';
import { createDataEnvelope } from '../../../types/dataContract';
import type { ConclusionContract } from '../../../agent/core/conclusionContract';
import type { IdentityResolutionV1 } from '../../../types/identityContract';

function contract(value: number): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [{
      id: 'claim-main-thread-blocked',
      kind: 'numeric',
      text: '主线程 blocked_ms 为 120',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'blocked_ms',
        value,
      }],
    }],
    uncertainties: [],
    nextSteps: [],
    metadata: {},
  };
}

function contractWithoutKind(value: number): ConclusionContract {
  const base = contract(value);
  delete base.claims![0].kind;
  return base;
}

describe('runClaimVerification', () => {
  it('strictly evaluates only explicitly activated causal claims', () => {
    const activated = contract(120);
    activated.claims![0].id = 'activated';
    activated.claims![0].kind = 'causal';
    activated.claims![0].relationRefs = ['model-invented-relation'];
    activated.claims!.push({
      id: 'unmatched',
      kind: 'causal',
      text: 'unmatched causal claim',
      references: [{
        evidenceRefId: 'data:skill:test',
        rowIndex: 0,
        column: 'blocked_ms',
        value: 120,
      }],
      relationRefs: ['model-invented-relation'],
    });
    const envelope = createDataEnvelope({columns: ['blocked_ms', 'ts', 'dur'], rows: [[120, 100, 50]]}, {
      type: 'skill_result',
      source: 'startup_analysis',
      title: 'Binder row',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const checked = runClaimVerification({
      conclusionContract: activated,
      dataEnvelopes: [envelope],
      relationCandidates: [],
      relationActivationClaimIds: ['activated'],
    });

    expect(checked.claimSupport.find(item => item.claimId === 'activated')?.relationEvaluation).toBe('missing');
    expect(checked.claimSupport.find(item => item.claimId === 'unmatched')?.relationEvaluation).toBe('not_configured');
    expect(checked.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'activated', code: 'causal_relation_missing'}),
    ]));
    expect(checked.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({claimId: 'unmatched', code: 'causal_relation_missing'}),
    ]));
  });

  it('treats an explicit empty relation candidate list as strict missing causal support', () => {
    const causal = contract(120);
    causal.claims![0].kind = 'causal';
    causal.claims![0].relationRefs = ['model-invented-relation'];
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const verified = runClaimVerification({
      conclusionContract: causal,
      dataEnvelopes: [envelope],
      relationCandidates: [],
    } as any);

    expect(verified.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'missing',
      relations: [],
    }));
    expect(verified.claimSupport[0].supportLevel).not.toBe('verified');
    expect(verified.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'causal_relation_missing'}),
    ]));
  });

  it('only promotes verified mechanism relations and keeps verified overlap at inference', () => {
    const relationContract = (relationRefs: string[]): ConclusionContract => ({
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-causal-relation',
        kind: 'causal',
        text: 'subject overlaps object and causes blocking',
        references: [{
          evidenceRefId: 'data:relation-transition',
          rowSelector: {name: 'subject'},
          column: 'blocked_ms',
          value: 120,
        }],
        relationRefs,
      }],
      uncertainties: [],
      nextSteps: [],
    });
    const envelope = createDataEnvelope({
      columns: ['name', 'ts', 'dur', 'blocked_ms', 'utid', 'subject_utid', 'object_utid'],
      rows: [
        ['subject', 100, 50, 120, 11, null, null],
        ['verified', 125, 20, 0, 22, null, null],
        ['candidate', 125, null, 0, null, null, null],
        ['rejected', 300, 20, 0, null, null, null],
        ['proof', null, null, 0, null, 11, 22],
      ],
    }, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'Relation transitions',
      evidenceRefId: 'data:relation-transition',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: 'identity:relation-transition',
      identityStatus: 'verified',
    });
    const relation = (id: string, objectName: string) => ({
      schemaVersion: 'evidence_relation_candidate@1',
      id,
      kind: 'overlap',
      direction: 'symmetric',
      subject: {evidenceRefId: 'data:relation-transition', rowSelector: {name: 'subject'}},
      object: {evidenceRefId: 'data:relation-transition', rowSelector: {name: objectName}},
    });

    const mechanism = {
      schemaVersion: 'evidence_relation_candidate@1',
      id: 'relation:mechanism',
      kind: 'blocking_state',
      direction: 'subject_to_object',
      subject: {evidenceRefId: 'data:relation-transition', rowSelector: {name: 'subject'}},
      object: {evidenceRefId: 'data:relation-transition', rowSelector: {name: 'verified'}},
      proof: {evidenceRefId: 'data:relation-transition', rowSelector: {name: 'proof'}},
      proofBindings: {
        subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
        object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
      },
    };
    const verified = runClaimVerification({
      conclusionContract: relationContract(['relation:mechanism']),
      dataEnvelopes: [envelope],
      relationCandidates: [mechanism],
    } as any);
    const overlap = runClaimVerification({
      conclusionContract: relationContract(['relation:overlap']),
      dataEnvelopes: [envelope],
      relationCandidates: [relation('relation:overlap', 'verified')],
    } as any);
    const candidate = runClaimVerification({
      conclusionContract: relationContract(['relation:candidate']),
      dataEnvelopes: [envelope],
      relationCandidates: [relation('relation:candidate', 'candidate')],
    } as any);
    const rejected = runClaimVerification({
      conclusionContract: relationContract(['relation:rejected']),
      dataEnvelopes: [envelope],
      relationCandidates: [relation('relation:rejected', 'rejected')],
    } as any);

    expect(verified.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'verified',
      supportLevel: 'verified',
    }));
    expect(verified.claimVerificationResult.status).toBe('passed');
    expect(verified.claimVerificationResult.claimResults[0].status).toBe('verified');
    expect(overlap.evidenceContract.relations[0].verificationStatus).toBe('verified');
    expect(overlap.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate',
      supportLevel: 'inference',
    }));
    expect(overlap.claimVerificationResult.status).toBe('partial');
    expect(overlap.claimVerificationResult.claimResults[0].status).toBe('inference');
    expect(candidate.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'candidate',
      supportLevel: 'inference',
    }));
    expect(candidate.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'causal_relation_candidate', severity: 'warning'}),
    ]));
    expect(rejected.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'rejected',
      supportLevel: 'unsupported',
    }));
    expect(rejected.claimVerificationResult.status).toBe('failed');
    expect(rejected.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'causal_relation_rejected', severity: 'error'}),
    ]));

    const mixed = runClaimVerification({
      conclusionContract: relationContract(['relation:mechanism', 'relation:overlap']),
      dataEnvelopes: [envelope],
      relationCandidates: [mechanism, relation('relation:overlap', 'verified')],
    } as any);
    expect(mixed.claimSupport[0].relationEvaluation).toBe('candidate');
    const mixedRejected = runClaimVerification({
      conclusionContract: relationContract(['relation:mechanism', 'relation:rejected']),
      dataEnvelopes: [envelope],
      relationCandidates: [mechanism, relation('relation:rejected', 'rejected')],
    } as any);
    expect(mixedRejected.claimSupport[0].relationEvaluation).toBe('rejected');
    const derived = runClaimVerification({
      conclusionContract: relationContract(['relation:derived']),
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:derived',
        kind: 'derived',
        direction: 'subject_to_object',
        subject: {evidenceRefId: 'data:relation-transition', rowSelector: {name: 'subject'}},
      }],
    } as any);
    expect(derived.claimSupport[0].relationEvaluation).toBe('candidate');

    const forged = {
      ...overlap.evidenceContract.claimSupport[0],
      relationEvaluation: 'verified',
    } as any;
    const defensive = runDeterministicClaimVerifier({claimSupport: [forged]});
    expect(defensive.status).toBe('partial');
    expect(defensive.claimResults[0].status).toBe('inference');
    expect(defensive.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'causal_relation_candidate'}),
    ]));
  });

  it('keeps a verified comparison delta at candidate causal support', () => {
    const current = createDataEnvelope({columns: ['blocked_ms'], rows: [[150]]}, {
      type: 'sql_result',
      source: 'execute_sql_on',
      title: 'Current metric',
      evidenceRefId: 'data:current-metric',
      traceId: 'trace-current',
      traceSide: 'current',
    });
    const reference = createDataEnvelope({columns: ['blocked_ms'], rows: [[100]]}, {
      type: 'sql_result',
      source: 'execute_sql_on',
      title: 'Reference metric',
      evidenceRefId: 'data:reference-metric',
      traceId: 'trace-reference',
      traceSide: 'reference',
    });
    const causal: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-delta-is-cause',
        kind: 'causal',
        text: 'the delta causes the regression',
        references: [{
          evidenceRefId: 'data:current-metric',
          rowIndex: 0,
          column: 'blocked_ms',
          value: 150,
        }],
        relationRefs: ['relation:verified-delta'],
      }],
      uncertainties: [],
      nextSteps: [],
    };

    const checked = runClaimVerification({
      conclusionContract: causal,
      dataEnvelopes: [current, reference],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:verified-delta',
        kind: 'comparison_delta',
        direction: 'subject_to_object',
        deltaDirection: 'current_minus_reference',
        subject: {evidenceRefId: 'data:current-metric', rowIndex: 0, column: 'blocked_ms'},
        object: {evidenceRefId: 'data:reference-metric', rowIndex: 0, column: 'blocked_ms'},
        metricColumn: 'blocked_ms',
        value: 50,
        unit: 'ms',
      }],
    });

    expect(checked.evidenceContract.relations[0].verificationStatus).toBe('verified');
    expect(checked.claimSupport[0].relationEvaluation).toBe('candidate');
    expect(checked.claimVerificationResult.claimResults[0].status).toBe('inference');
  });

  it('allows the model to select only producer-authored relation ids', () => {
    const causal = contract(120);
    causal.claims![0].kind = 'causal';
    causal.claims![0].relationRefs = ['model-invented-relation'];
    const envelope = createDataEnvelope({
      columns: ['blocked_ms', 'ts', 'dur'],
      rows: [[120, 100, 50], [0, 125, 20]],
    }, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'Producer relation',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const verified = runClaimVerification({
      conclusionContract: causal,
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'producer-relation',
        kind: 'overlap',
        direction: 'symmetric',
        subject: {evidenceRefId: 'data:skill:test', rowIndex: 0},
        object: {evidenceRefId: 'data:skill:test', rowIndex: 1},
      }],
    } as any);

    expect(verified.evidenceContract.relations).toHaveLength(1);
    expect(verified.claimSupport[0]).toEqual(expect.objectContaining({
      relations: [],
      relationEvaluation: 'missing',
    }));
    expect(verified.claimSupport[0].supportLevel).not.toBe('verified');
  });

  it('keeps legacy no-candidate causal behavior explicit without changing non-causal claim shape', () => {
    const causal = contract(120);
    causal.claims![0].kind = 'causal';
    const numeric = contract(120);
    const envelope = createDataEnvelope({columns: ['blocked_ms'], rows: [[120]]}, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const legacy = runClaimVerification({conclusionContract: causal, dataEnvelopes: [envelope]});
    const unchanged = runClaimVerification({conclusionContract: numeric, dataEnvelopes: [envelope]});

    expect(legacy.claimSupport[0]).toEqual(expect.objectContaining({
      relationEvaluation: 'not_configured',
      supportLevel: 'inference',
    }));
    expect(unchanged.claimSupport[0]).not.toHaveProperty('relationEvaluation');
    expect(unchanged.claimSupport[0]).not.toHaveProperty('relations');
    expect(unchanged.claimVerificationResult.status).toBe('passed');
  });

  it('builds claim support and passes deterministic verifier for matching cells', () => {
    const identityResolution: IdentityResolutionV1 = {
      version: 'identity_contract@1',
      identityRefId: 'identity:test',
      target: { traceId: 'trace-a', traceSide: 'current', processName: 'com.example', source: 'skill_param' },
      status: 'verified',
      processes: [],
      threads: [],
      warnings: [],
    };
    const envelope = createDataEnvelope({
      columns: ['blocked_ms', 'upid', 'utid', 'process_name', 'thread_name'],
      rows: [[120, 1, 2, 'com.example', 'main']],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: identityResolution.identityRefId,
      identityStatus: identityResolution.status,
      identityResolution,
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport).toHaveLength(1);
    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimSupport[0].anchors[0].identity?.identityRefId).toBe('identity:test');
    expect(result.claimVerificationResult.status).toBe('passed');
    expect(result.identityResolutions).toHaveLength(1);
  });

  it('treats small floating point drift as a verified numeric reference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120.0000000001]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('fails deterministic verifier when a cited cell value does not match the claim reference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimSupport[0].supportLevel).toBe('unsupported');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
      severity: 'error',
    }));
  });

  it('checks references even when claim kind is omitted', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contractWithoutKind(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].kind).toBe('numeric');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('checks references even when the model labels a cited claim as inference', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[12]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].kind = 'inference';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].kind).toBe('numeric');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('fails when the cited column exists but has no actual value', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].cells?.[0]).toEqual(expect.objectContaining({
      value: 120,
    }));
    expect(result.claimSupport[0].anchors[0].cells?.[0]).not.toHaveProperty('actualValue');
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_value_mismatch',
    }));
  });

  it('marks out-of-range rows as missing instead of matching the claimed value', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references[0].rowIndex = 9;

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
    expect(result.claimVerificationResult.issues[0]).toEqual(expect.objectContaining({
      code: 'claim_reference_missing',
    }));
  });

  it('marks missing columns as missing instead of matching the claimed value', () => {
    const envelope = createDataEnvelope({
      columns: ['other_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
      missingReason: expect.stringContaining('column'),
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
  });

  it('fails when explicit evidence identifiers do not resolve to the same envelope', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:actual',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references[0].sourceToolCallId = 'invoke_skill:wrong';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      missing: true,
      missingReason: expect.stringContaining('identifiers'),
    }));
    expect(result.claimVerificationResult.status).toBe('failed');
  });

  it('anchors artifact-only claims without treating row existence as value verification', () => {
    const envelope = createDataEnvelope({
      columns: ['artifact_metric'],
      rows: [[1]],
    }, {
      type: 'skill_result',
      source: 'artifact_backed_rows',
      title: 'Artifact backed rows',
      layer: 'overview',
      format: 'table',
      artifactId: 'art-1',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-artifact-only',
      text: 'artifact row is available',
      references: [],
      artifactRefs: [{ artifactId: 'art-1', rowIndex: 0 }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].evidenceRefId).toBe('art-1');
    expect(result.claimSupport[0].anchors[0].missing).toBeUndefined();
    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-1');
    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('not_checked');
    expect(result.claimVerificationResult.claimResults[0]).toEqual(expect.objectContaining({
      status: 'not_checked',
    }));
  });

  it('does not verify column-only references that omit expected values', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[90]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    delete c.claims![0].references[0].value;

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('not_checked');
    expect(result.claimVerificationResult.claimResults[0].referenceResults?.[0]).toEqual(expect.objectContaining({
      status: 'not_checked',
    }));
  });

  it('resolves source_ref-only claims using table ordinals', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].references = [{
      sourceRef: '表 1',
      rowIndex: 0,
      column: 'blocked_ms',
      value: 120,
    }];

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].missing).toBeUndefined();
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('treats artifact ids in evidence_ref_id as aliases and accepts display-title source refs', () => {
    const envelope = createDataEnvelope({
      columns: ['type_display', 'ttid_ms'],
      rows: [['冷启动', 1912.202655]],
    }, {
      type: 'skill_result',
      source: 'startup_events_in_range',
      title: '检测到的启动事件',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:startup_events_in_range',
      artifactId: 'art-2',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-startup-type',
      kind: 'categorical',
      text: '启动类型为冷启动',
      references: [{
        evidenceRefId: 'data:art-2',
        sourceRef: '检测到的启动事件',
        rowIndex: 0,
        column: 'type_display',
        value: '冷启动',
      }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].evidenceRefId).toBe('data:skill:startup_events_in_range');
    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-2');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('treats ev_art ids as artifact aliases from narrative claim refs', () => {
    const envelope = createDataEnvelope({
      columns: ['jank_type', 'count'],
      rows: [['App Deadline Missed', 6]],
    }, {
      type: 'skill_result',
      source: 'jank_type_stats',
      title: '掉帧类型分布',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:scrolling_analysis:jank_type_stats',
      artifactId: 'art-6',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-jank-type',
      kind: 'numeric',
      text: 'App Deadline Missed 有 6 帧',
      references: [{
        evidenceRefId: 'ev_art-6',
        sourceRef: '掉帧类型分布',
        rowIndex: 0,
        column: 'count',
        value: 6,
      }],
    };

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].anchors[0].context.artifactId).toBe('art-6');
    expect(result.claimVerificationResult.status).toBe('passed');
  });

  it('does not fully verify matched cells when trace provenance is missing', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
    });

    const result = runClaimVerification({
      conclusionContract: contract(120),
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'evidence_trace_unknown',
        severity: 'warning',
      }),
    ]));
  });

  it('requires verified identity sidecars for identity claims', () => {
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-identity',
      kind: 'identity',
      text: '目标进程是 com.example',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'process_name',
        value: 'com.example',
      }],
    };
    const envelope = createDataEnvelope({
      columns: ['process_name'],
      rows: [['com.example']],
    }, {
      type: 'skill_result',
      source: 'process_identity_probe',
      title: 'Process identity',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'identity_not_verified',
        severity: 'warning',
      }),
    ]));
  });

  it('downgrades ambiguous identity sidecars for identity claims', () => {
    const c = contract(120);
    c.claims![0] = {
      id: 'claim-identity',
      kind: 'identity',
      text: '目标进程是 com.example',
      references: [{
        evidenceRefId: 'data:skill:test',
        sourceToolCallId: 'invoke_skill:test',
        rowIndex: 0,
        column: 'process_name',
        value: 'com.example',
      }],
    };
    const envelope = createDataEnvelope({
      columns: ['process_name'],
      rows: [['com.example']],
    }, {
      type: 'skill_result',
      source: 'process_identity_probe',
      title: 'Process identity',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId: 'identity:ambiguous',
      identityStatus: 'ambiguous',
    });

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('partial');
    expect(result.claimVerificationResult.status).toBe('partial');
    expect(result.claimVerificationResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'identity_not_verified' }),
    ]));
  });

  it('ignores model-produced supportLevel when deterministic evidence disagrees', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const c = contract(120);
    c.claims![0].supportLevel = 'unsupported';

    const result = runClaimVerification({
      conclusionContract: c,
      dataEnvelopes: [envelope],
    });

    expect(result.claimSupport[0].supportLevel).toBe('verified');
    expect(result.claimVerificationResult.status).toBe('passed');
    expect(result.verifiedTraceEvidenceRefIdsByClaimId).toEqual({
      'claim-main-thread-blocked': ['data:skill:test'],
    });
  });
});
