// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import {createDataEnvelope} from '../../../types/dataContract';
import {
  QUERY_REVIEW_SCHEMA_VERSION,
  type QueryReviewV1,
} from '../../../types/queryReviewContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';

const queryReview: QueryReviewV1 = {
  schemaVersion: QUERY_REVIEW_SCHEMA_VERSION,
  id: 'qr:execute_sql:anchor',
  producer: {kind: 'execute_sql', sourceToolCallId: 'execute_sql:1'},
  title: 'SQL review',
  purpose: 'Review SQL',
  source: {evidenceRefId: 'data:sql:anchor', queryHash: 'hash-anchor'},
  reads: [{table: 'slice', confidence: 'observed'}],
  filters: [],
  outputShape: [{name: 'dur', type: 'duration', required: true}],
  guardrails: [],
  limitations: [],
  observedExecution: {executed: true, rowCount: 1},
  allowedUse: 'review_metadata_only',
};

describe('evidenceContractBuilder', () => {
  it('builds and deduplicates producer-authored overlap relation anchors', () => {
    const envelope = createDataEnvelope(
      {
        columns: ['ts', 'dur', 'name'],
        rows: [[100, 50, 'subject'], [125, 20, 'object']],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Overlapping slices',
        evidenceRefId: 'data:sql:overlap',
        sourceToolCallId: 'execute_sql:overlap',
        traceId: 'trace-current',
        traceSide: 'current',
      },
    );

    const contract = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:overlap:1',
        kind: 'overlap',
        direction: 'symmetric',
        subject: {
          evidenceRefId: 'data:sql:overlap',
          rowSelector: {name: 'subject'},
        },
        object: {
          evidenceRefId: 'data:sql:overlap',
          rowSelector: {name: 'object'},
        },
      }],
    } as any);

    expect(contract.relations).toEqual([
      expect.objectContaining({
        schemaVersion: 'evidence_relation@1',
        id: 'relation:overlap:1',
        verificationStatus: 'verified',
        reasonCode: 'overlap_verified',
      }),
    ]);
    expect(contract.anchors).toHaveLength(2);
    expect(new Set(contract.anchors.map(anchor => anchor.anchorId)).size).toBe(2);
    expect((contract.relations[0] as any).directEvidenceAnchorIds).toEqual(
      expect.arrayContaining(contract.anchors.map(anchor => anchor.anchorId)),
    );
  });

  it('keeps missing overlap ranges as candidates and rejects disjoint ranges', () => {
    const envelope = createDataEnvelope(
      {
        columns: ['ts', 'dur', 'name'],
        rows: [[100, 10, 'subject'], [200, 10, 'object'], [300, null, 'missing']],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Overlap states',
        evidenceRefId: 'data:sql:overlap-states',
        traceId: 'trace-current',
        traceSide: 'current',
      },
    );
    const endpoint = (name: string) => ({
      evidenceRefId: 'data:sql:overlap-states',
      rowSelector: {name},
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:overlap:disjoint',
        kind: 'overlap',
        direction: 'symmetric',
        subject: endpoint('subject'),
        object: endpoint('object'),
      }, {
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:overlap:missing',
        kind: 'overlap',
        direction: 'symmetric',
        subject: endpoint('subject'),
        object: endpoint('missing'),
      }],
    } as any);

    expect(built.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'relation:overlap:disjoint',
        verificationStatus: 'rejected',
        reasonCode: 'overlap_disjoint',
      }),
      expect.objectContaining({
        id: 'relation:overlap:missing',
        verificationStatus: 'candidate',
        reasonCode: 'overlap_range_missing',
      }),
    ]));
  });

  it('never verifies a relation whose endpoint expected value mismatches the resolved cell', () => {
    const envelope = createDataEnvelope(
      {columns: ['name', 'ts', 'dur'], rows: [['subject', 100, 50], ['object', 125, 20]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Endpoint values',
        evidenceRefId: 'data:sql:endpoint-values',
        traceId: 'trace-a',
        traceSide: 'current',
      },
    );
    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:endpoint-mismatch',
        kind: 'overlap',
        direction: 'symmetric',
        subject: {
          evidenceRefId: 'data:sql:endpoint-values',
          rowIndex: 0,
          column: 'name',
          value: 'not-subject',
        },
        object: {evidenceRefId: 'data:sql:endpoint-values', rowIndex: 1},
      }],
    } as any);

    expect(built.relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'rejected',
      reasonCode: 'relation_endpoint_value_mismatch',
    }));
  });

  it('compares canonical nanosecond string ranges without losing integer precision', () => {
    const envelope = createDataEnvelope(
      {
        columns: ['name', 'ts', 'dur'],
        rows: [
          ['subject', '9007199254740993', '1'],
          ['object', '9007199254740993', '1'],
        ],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Canonical ns overlap',
        evidenceRefId: 'data:sql:canonical-ns',
        traceId: 'trace-a',
        traceSide: 'current',
      },
    );
    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:canonical-ns-overlap',
        kind: 'overlap',
        direction: 'symmetric',
        subject: {evidenceRefId: 'data:sql:canonical-ns', rowIndex: 0},
        object: {evidenceRefId: 'data:sql:canonical-ns', rowIndex: 1},
      }],
    } as any);

    expect(built.relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'verified',
      reasonCode: 'overlap_verified',
    }));
  });

  it('verifies binary causal relations only when one proof row binds both endpoints', () => {
    const envelope = createDataEnvelope(
      {
        columns: ['row_kind', 'utid', 'subject_utid', 'object_utid'],
        rows: [
          ['subject', 11, null, null],
          ['object', 22, null, null],
          ['proof', null, 11, 22],
          ['subject_only', null, 11, 99],
        ],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Blocking relation proof',
        evidenceRefId: 'data:sql:blocking-proof',
        traceId: 'trace-current',
        traceSide: 'current',
        identityRefId: 'identity:current-app',
        identityStatus: 'verified',
      },
    );
    const endpoint = (row_kind: string) => ({
      evidenceRefId: 'data:sql:blocking-proof',
      rowSelector: {row_kind},
    });
    const candidate = (id: string, proofRow: string) => ({
      schemaVersion: 'evidence_relation_candidate@1',
      id,
      kind: 'blocking_state',
      direction: 'subject_to_object',
      subject: endpoint('subject'),
      object: endpoint('object'),
      proof: endpoint(proofRow),
      proofBindings: {
        subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
        object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
      },
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [
        candidate('relation:blocking:verified', 'proof'),
        candidate('relation:blocking:mismatch', 'subject_only'),
        candidate('relation:blocking:missing', 'absent'),
      ],
    } as any);

    expect(built.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'relation:blocking:verified',
        verificationStatus: 'verified',
        reasonCode: 'binary_proof_verified',
      }),
      expect.objectContaining({
        id: 'relation:blocking:mismatch',
        verificationStatus: 'rejected',
        reasonCode: 'proof_binding_mismatch',
      }),
      expect.objectContaining({
        id: 'relation:blocking:missing',
        verificationStatus: 'candidate',
        reasonCode: 'proof_anchor_missing',
      }),
    ]));
    const verifiedRelation = built.relations.find(relation => relation.id === 'relation:blocking:verified')!;
    const subjectAnchor = built.anchors.find(anchor => anchor.anchorId === verifiedRelation.subjectAnchorId)!;
    const objectAnchor = built.anchors.find(anchor => anchor.anchorId === verifiedRelation.objectAnchorId)!;
    const proofAnchor = built.anchors.find(anchor => anchor.anchorId === verifiedRelation.proofAnchorId)!;
    expect(subjectAnchor.cells).toEqual([expect.objectContaining({
      rowSelector: {row_kind: 'subject'},
      column: 'utid',
      actualValue: 11,
    })]);
    expect(objectAnchor.cells).toEqual([expect.objectContaining({
      rowSelector: {row_kind: 'object'},
      column: 'utid',
      actualValue: 22,
    })]);
    expect(proofAnchor.cells).toEqual([
      expect.objectContaining({
        rowSelector: {row_kind: 'proof'},
        column: 'subject_utid',
        value: 11,
        actualValue: 11,
      }),
      expect.objectContaining({
        rowSelector: {row_kind: 'proof'},
        column: 'object_utid',
        value: 22,
        actualValue: 22,
      }),
    ]);
    expect(verifiedRelation.directEvidenceAnchorIds).toEqual([
      subjectAnchor.anchorId,
      objectAnchor.anchorId,
      proofAnchor.anchorId,
    ]);
    expect((verifiedRelation as any).proofBindings).toEqual({
      subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
      object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
    });
  });

  it('keeps separate proof cells when relations share one proof row with different bindings', () => {
    const envelope = createDataEnvelope(
      {
        columns: [
          'row_kind', 'utid',
          'subject_utid', 'object_utid',
          'client_utid', 'server_utid',
        ],
        rows: [
          ['subject', 11, null, null, null, null],
          ['object', 22, null, null, null, null],
          ['proof', null, 11, 22, 11, 22],
        ],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Shared proof row',
        evidenceRefId: 'data:sql:shared-proof',
        traceId: 'trace-a',
        traceSide: 'current',
        identityRefId: 'identity:shared-proof',
        identityStatus: 'verified',
      },
    );
    const endpoint = (row_kind: string) => ({
      evidenceRefId: 'data:sql:shared-proof',
      rowSelector: {row_kind},
    });
    const candidate = (
      id: string,
      subjectProofColumn: string,
      objectProofColumn: string,
    ) => ({
      schemaVersion: 'evidence_relation_candidate@1',
      id,
      kind: 'binder_peer',
      direction: 'subject_to_object',
      subject: endpoint('subject'),
      object: endpoint('object'),
      proof: endpoint('proof'),
      proofBindings: {
        subject: {endpointColumn: 'utid', proofColumn: subjectProofColumn},
        object: {endpointColumn: 'utid', proofColumn: objectProofColumn},
      },
    });
    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [
        candidate('relation:shared-proof:a', 'subject_utid', 'object_utid'),
        candidate('relation:shared-proof:b', 'client_utid', 'server_utid'),
      ],
    } as any);
    const relationA = built.relations.find(relation => relation.id === 'relation:shared-proof:a')!;
    const relationB = built.relations.find(relation => relation.id === 'relation:shared-proof:b')!;
    const anchors = new Map(built.anchors.map(anchor => [anchor.anchorId, anchor]));

    expect(relationA.proofAnchorId).not.toBe(relationB.proofAnchorId);
    expect(anchors.get(relationA.proofAnchorId!)?.cells?.map(cell => cell.column)).toEqual([
      'subject_utid',
      'object_utid',
    ]);
    expect(anchors.get(relationB.proofAnchorId!)?.cells?.map(cell => cell.column)).toEqual([
      'client_utid',
      'server_utid',
    ]);
    expect((relationA as any).proofBindings).toEqual({
      subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
      object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
    });
    expect((relationB as any).proofBindings).toEqual({
      subject: {endpointColumn: 'utid', proofColumn: 'client_utid'},
      object: {endpointColumn: 'utid', proofColumn: 'server_utid'},
    });
  });

  it('does not verify non-primitive binary proof bindings', () => {
    const objectValue = {utid: 11};
    const envelope = createDataEnvelope(
      {
        columns: ['row_kind', 'utid', 'subject_utid', 'object_utid'],
        rows: [
          ['subject', objectValue, null, null],
          ['object', 22, null, null],
          ['proof', null, objectValue, 22],
        ],
      },
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'Non primitive proof',
        evidenceRefId: 'data:sql:non-primitive-proof',
        traceId: 'trace-a',
        traceSide: 'current',
        identityRefId: 'identity:proof',
        identityStatus: 'verified',
      },
    );
    const endpoint = (row_kind: string) => ({
      evidenceRefId: 'data:sql:non-primitive-proof',
      rowSelector: {row_kind},
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:non-primitive-proof',
        kind: 'binder_peer',
        direction: 'subject_to_object',
        subject: endpoint('subject'),
        object: endpoint('object'),
        proof: endpoint('proof'),
        proofBindings: {
          subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
          object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
        },
      }],
    } as any);

    expect(built.relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'candidate',
      reasonCode: 'proof_binding_missing',
    }));
  });

  it('allows distinct verified client, server, and proof identities in a binary relation', () => {
    const makeEnvelope = (
      evidenceRefId: string,
      identityRefId: string,
      columns: string[],
      row: Array<string | number | null>,
    ) => createDataEnvelope({columns, rows: [row]}, {
      type: 'sql_result',
      source: 'execute_sql',
      title: evidenceRefId,
      evidenceRefId,
      traceId: 'trace-a',
      traceSide: 'current',
      identityRefId,
      identityStatus: 'verified',
    });
    const ref = (evidenceRefId: string) => ({evidenceRefId, rowIndex: 0});
    const built = buildEvidenceContract({
      dataEnvelopes: [
        makeEnvelope('data:binder-client', 'identity:binder-client', ['utid'], [11]),
        makeEnvelope('data:binder-server', 'identity:binder-server', ['utid'], [22]),
        makeEnvelope('data:binder-proof', 'identity:binder-proof', ['client_utid', 'server_utid'], [11, 22]),
      ],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:distinct-binder-identities',
        kind: 'binder_peer',
        direction: 'subject_to_object',
        subject: ref('data:binder-client'),
        object: ref('data:binder-server'),
        proof: ref('data:binder-proof'),
        proofBindings: {
          subject: {endpointColumn: 'utid', proofColumn: 'client_utid'},
          object: {endpointColumn: 'utid', proofColumn: 'server_utid'},
        },
      }],
    } as any);

    expect(built.relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'verified',
      reasonCode: 'binary_proof_verified',
    }));
    expect(built.identityRefIds).toEqual(expect.arrayContaining([
      'identity:binder-client',
      'identity:binder-server',
      'identity:binder-proof',
    ]));
  });

  it.each([
    ['ambiguous', 'candidate', 'identity_evidence_missing'],
    ['weak', 'candidate', 'identity_evidence_missing'],
    ['missing', 'candidate', 'identity_evidence_missing'],
    ['not_required', 'candidate', 'identity_evidence_missing'],
    ['error', 'rejected', 'identity_conflict'],
    [undefined, 'candidate', 'identity_evidence_missing'],
  ] as const)(
    'maps %s binary identity state to %s',
    (identityStatus, verificationStatus, reasonCode) => {
      const envelope = createDataEnvelope(
        {
          columns: ['row_kind', 'utid', 'subject_utid', 'object_utid'],
          rows: [
            ['subject', 11, null, null],
            ['object', 22, null, null],
            ['proof', null, 11, 22],
          ],
        },
        {
          type: 'sql_result',
          source: 'execute_sql',
          title: 'Uncertain identity proof',
          evidenceRefId: 'data:sql:uncertain-identity',
          traceId: 'trace-a',
          traceSide: 'current',
          ...(identityStatus === undefined ? {} : {
            identityRefId: 'identity:uncertain',
            identityStatus,
          }),
        },
      );
      const endpoint = (row_kind: string) => ({
        evidenceRefId: 'data:sql:uncertain-identity',
        rowSelector: {row_kind},
      });
      const built = buildEvidenceContract({
        dataEnvelopes: [envelope],
        relationCandidates: [{
          schemaVersion: 'evidence_relation_candidate@1',
          id: `relation:identity:${identityStatus}`,
          kind: 'blocking_state',
          direction: 'subject_to_object',
          subject: endpoint('subject'),
          object: endpoint('object'),
          proof: endpoint('proof'),
          proofBindings: {
            subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
            object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
          },
        }],
      } as any);

      expect(built.relations[0]).toEqual(expect.objectContaining({
        verificationStatus,
        reasonCode,
      }));
    },
  );

  it('rejects binary proof whose endpoints do not share trace and side', () => {
    const makeEnvelope = (
      evidenceRefId: string,
      traceId: string,
      traceSide: 'current' | 'reference',
      columns: string[],
      row: Array<string | number | null>,
    ) => createDataEnvelope({columns, rows: [row]}, {
      type: 'sql_result',
      source: 'execute_sql',
      title: evidenceRefId,
      evidenceRefId,
      traceId,
      traceSide,
      identityRefId: 'identity:relation',
      identityStatus: 'verified',
    });
    const ref = (evidenceRefId: string) => ({evidenceRefId, rowIndex: 0});
    const built = buildEvidenceContract({
      dataEnvelopes: [
        makeEnvelope('data:subject', 'trace-a', 'current', ['utid'], [11]),
        makeEnvelope('data:object', 'trace-b', 'current', ['utid'], [22]),
        makeEnvelope('data:proof', 'trace-a', 'reference', ['subject_utid', 'object_utid'], [11, 22]),
      ],
      relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1',
        id: 'relation:blocking:context-mismatch',
        kind: 'blocking_state',
        direction: 'subject_to_object',
        subject: ref('data:subject'),
        object: ref('data:object'),
        proof: ref('data:proof'),
        proofBindings: {
          subject: {endpointColumn: 'utid', proofColumn: 'subject_utid'},
          object: {endpointColumn: 'utid', proofColumn: 'object_utid'},
        },
      }],
    } as any);

    expect(built.relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'rejected',
      reasonCode: 'trace_context_mismatch',
    }));
  });

  it('recomputes comparison delta as current minus reference and rejects wrong sides or values', () => {
    const makeEnvelope = (evidenceRefId: string, traceSide: 'current' | 'reference', value: number) =>
      createDataEnvelope({columns: ['blocked_ms'], rows: [[value]]}, {
        type: 'sql_result',
        source: 'execute_sql_on',
        title: evidenceRefId,
        evidenceRefId,
        traceId: `${traceSide}-trace`,
        traceSide,
      });
    const ref = (evidenceRefId: string) => ({evidenceRefId, rowIndex: 0, column: 'blocked_ms'});
    const candidate = (id: string, subject: string, object: string, value: number) => ({
      schemaVersion: 'evidence_relation_candidate@1',
      id,
      kind: 'comparison_delta',
      direction: 'subject_to_object',
      deltaDirection: 'current_minus_reference',
      subject: ref(subject),
      object: ref(object),
      metricColumn: 'blocked_ms',
      value,
      unit: 'ms',
    });
    const built = buildEvidenceContract({
      dataEnvelopes: [
        makeEnvelope('data:current', 'current', 150),
        makeEnvelope('data:reference', 'reference', 100),
      ],
      relationCandidates: [
        candidate('relation:delta:verified', 'data:current', 'data:reference', 50),
        candidate('relation:delta:wrong-side', 'data:reference', 'data:current', -50),
        candidate('relation:delta:wrong-value', 'data:current', 'data:reference', 40),
      ],
    } as any);

    expect(built.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'relation:delta:verified',
        deltaDirection: 'current_minus_reference',
        verificationStatus: 'verified',
        reasonCode: 'comparison_delta_verified',
      }),
      expect.objectContaining({
        id: 'relation:delta:wrong-side',
        verificationStatus: 'rejected',
        reasonCode: 'comparison_side_mismatch',
      }),
      expect.objectContaining({
        id: 'relation:delta:wrong-value',
        verificationStatus: 'rejected',
        reasonCode: 'comparison_delta_mismatch',
      }),
    ]));
  });

  it('excludes hostile candidates, conflicting duplicate ids, and invalid envelopes defensively', () => {
    const valid = createDataEnvelope({columns: ['ts', 'dur'], rows: [[0, 10]]}, {
      type: 'sql_result',
      source: 'execute_sql',
      title: 'valid',
      evidenceRefId: 'data:valid',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const endpoint = {evidenceRefId: 'data:valid', rowIndex: 0};
    const base = {
      schemaVersion: 'evidence_relation_candidate@1',
      id: 'relation:duplicate',
      kind: 'overlap',
      direction: 'symmetric',
      subject: endpoint,
      object: endpoint,
    };
    const invalidEnvelope = {
      ...valid,
      meta: {...valid.meta, type: 'hostile_type'},
    };
    const built = buildEvidenceContract({
      dataEnvelopes: [invalidEnvelope as any],
      relationCandidates: [
        {...base, sql: 'select * from slice'},
        base,
        {...base, object: {evidenceRefId: 'data:other', rowIndex: 0}},
        ...Array.from({length: 40}, (_, index) => ({id: `invalid-${index}`})),
      ],
    } as any);

    expect(built.relations).toEqual([]);
    expect(built.anchors).toEqual([]);
    expect(built.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('data_envelope_skipped:0:invalid'),
      expect.stringContaining('unknown_field'),
      expect.stringContaining('duplicate_conflict'),
    ]));
    expect(built.warnings.length).toBeLessThanOrEqual(32);

    const invalidContainer = buildEvidenceContract({relationCandidates: {id: 'not-an-array'}} as any);
    expect(invalidContainer.relations).toEqual([]);
    expect(invalidContainer.warnings).toContain('relation_candidates_skipped:invalid_container');
  });

  it('preserves queryReviewId in evidence anchor context', () => {
    const envelope = createDataEnvelope(
      {columns: ['dur'], rows: [[10]]},
      {
        type: 'sql_result',
        source: 'execute_sql',
        title: 'SQL',
        evidenceRefId: 'data:sql:anchor',
        queryHash: 'hash-anchor',
        traceId: 'trace-reference',
        traceSide: 'reference',
        paneSide: 'right',
        queryReview,
      },
    );
    const conclusionContract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-1',
        text: 'Duration is 10',
        kind: 'numeric',
        references: [{
          evidenceRefId: 'data:sql:anchor',
          rowIndex: 0,
          column: 'dur',
          value: 10,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
    };

    const contract = buildEvidenceContract({
      conclusionContract,
      dataEnvelopes: [envelope],
    });

    expect(contract.anchors[0].context.queryReviewId).toBe('qr:execute_sql:anchor');
    expect(contract.anchors[0].context.traceSide).toBe('reference');
    expect(contract.anchors[0].context.paneSide).toBe('right');
    expect('queryReview' in contract.anchors[0].context).toBe(false);
  });

  it('does not treat the raw Trace comparison appendix as a conclusion claim', () => {
    const contract = buildEvidenceContract({
      conclusionContract: {
        schemaVersion: 'conclusion_contract_v1',
        mode: 'focused_answer',
        conclusions: [],
        clusters: [],
        evidenceChain: [],
        claims: [],
        uncertainties: [],
        nextSteps: [],
      },
      comparisonReportSection: {
        source: 'raw_trace_pair',
        title: 'Raw Trace comparison',
        markdown: 'Comparison appendix',
        html: '<p>Comparison appendix</p>',
        evidencePack: {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'},
      },
    });

    expect(contract.claimSupport).toEqual([]);
    expect(contract.anchors).toEqual([]);
  });
});
