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
import {evidenceValuesMatch} from '../valueComparison';
import type {EvidenceScopeProvenanceV1, IdentityResolutionV1} from '../../../types/identityContract';

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
  it('matches SQL null only to explicit null while keeping non-null legacy comparisons', () => {
    expect(evidenceValuesMatch(null, null)).toBe(true);
    for (const value of [undefined, 0, false, '', 'null']) {
      expect(evidenceValuesMatch(null, value)).toBe(false);
      expect(evidenceValuesMatch(value, null)).toBe(false);
    }
    expect(evidenceValuesMatch('54', 54)).toBe(true);
    expect(evidenceValuesMatch(1, 1.00000001)).toBe(true);
  });

  it('retains nullable relation endpoint cells and rejects non-null substitutions in either direction', () => {
    const cases = [
      {expected: null, actual: null},
      ...[0, false, '', 'null'].flatMap(value => [
        {expected: null, actual: value}, {expected: value, actual: null},
      ]),
    ];
    for (const {expected, actual} of cases) {
      const envelope = createDataEnvelope({columns: ['io_wait'], rows: [[actual]]}, {
        type: 'sql_result', source: 'execute_sql', title: 'Nullable scheduler evidence',
        evidenceRefId: 'data:null-state', traceId: 'trace-null', traceSide: 'current',
      });
      const built = buildEvidenceContract({dataEnvelopes: [envelope], relationCandidates: [{
        schemaVersion: 'evidence_relation_candidate@1', id: 'relation:null-state',
        kind: 'derived', direction: 'subject_to_object',
        subject: {evidenceRefId: 'data:null-state', rowIndex: 0, column: 'io_wait', value: expected},
      }]});
      expect(built.warnings).toEqual([]);
      expect(built.anchors[0].cells![0]).toMatchObject({value: expected, actualValue: actual});
      expect(built.relations[0]).toMatchObject(expected === actual
        ? {verificationStatus: 'candidate', reasonCode: 'derived_not_verified'}
        : {verificationStatus: 'rejected', reasonCode: 'relation_endpoint_value_mismatch'});
    }
  });

  it('still rejects null relation selectors and aggregate proposal values', () => {
    const base = {schemaVersion: 'evidence_relation_candidate@1', id: 'relation:null-schema',
      kind: 'derived', direction: 'subject_to_object',
      subject: {evidenceRefId: 'data:null-state', rowIndex: 0, column: 'io_wait', value: null}};
    for (const candidate of [
      {...base, subject: {evidenceRefId: 'data:null-state', rowSelector: {io_wait: null}}},
      {...base, value: null},
    ]) {
      const built = buildEvidenceContract({relationCandidates: [candidate]} as any);
      expect(built.relations).toEqual([]);
      expect(built.warnings.length).toBeGreaterThan(0);
    }
  });

  describe('field scope provenance', () => {
    const target = {mode: 'exact_upid' as const, upid: 42, traceId: 'trace-a',
      traceSide: 'current' as const, identityRefId: 'identity:42'};
    const resolution: IdentityResolutionV1 = {
      version: 'identity_contract@1', identityRefId: target.identityRefId, status: 'verified',
      target: {...target, source: 'user_param'}, processes: [{upid: 42, confidence: 1, matchSources: ['upid']}],
      threads: [], warnings: [],
    };
    const mixed: EvidenceScopeProvenanceV1 = {version: 'process_scope_evidence@1', entries: [
      {role: 'target', scope: target, fields: ['upid', 'metric'], availability: 'available'},
      {role: 'global_context', scope: {mode: 'unscoped', traceId: 'trace-a', traceSide: 'current'},
        fields: ['vsync'], relativeTo: target},
      {role: 'peer_context', scope: {mode: 'unscoped', traceId: 'trace-a', traceSide: 'current'},
        fields: ['peer_duration'], relativeTo: target},
    ]};
    function build(column?: string, provenance: EvidenceScopeProvenanceV1 = mixed,
      rowUpid = 42, identity = resolution) {
      const envelope = createDataEnvelope({columns: ['upid', 'metric', 'vsync', 'peer_duration', 'undeclared'],
        rows: [[rowUpid, 0, 16, 5, 99]]}, {
        type: 'skill_result', source: 'scoped', title: 'Mixed observations', traceId: 'trace-a', traceSide: 'current',
        evidenceRefId: 'data:mixed', scopeProvenance: provenance,
        identityRefId: target.identityRefId, identityStatus: 'verified', identityResolution: identity,
      });
      return buildEvidenceContract({dataEnvelopes: [envelope], conclusionContract: {
        schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
        clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
        claims: [{id: 'claim:scoped', kind: 'numeric', text: 'An observed value', references: [
          {evidenceRefId: 'data:mixed', rowIndex: 0, ...(column ? {column} : {})},
        ]}],
      }});
    }
    it('selects target, global and peer cells independently within one row', () => {
      expect(build('metric').anchors[0].identity?.status).toBe('verified');
      for (const [column, role] of [['vsync', 'global_context'], ['peer_duration', 'peer_context']]) {
        const anchor = build(column).anchors[0];
        expect(anchor.identity).toBeUndefined();
        expect(anchor.missing).not.toBe(true);
        expect(anchor.scopeProvenance?.entries.map(entry => entry.role)).toEqual([role]);
        expect(anchor.scopeProvenance?.entries[0].relativeTo?.upid).toBe(42);
      }
      expect(build().anchors[0].identity).toBeUndefined();
      expect(build().anchors[0].scopeProvenance?.entries).toHaveLength(3);
    });
    it('does not verify a residual zero when that selected scope is unavailable', () => {
      const unavailable = structuredClone(mixed);
      unavailable.entries[0].availability = 'unavailable';
      const result = build('metric', unavailable);
      expect(result.anchors[0]).toMatchObject({missing: true, confidence: 0});
      expect(result.claimSupport[0].supportLevel).not.toBe('verified');
      expect(build('vsync', unavailable).anchors[0].missing).not.toBe(true);
    });
    it('rejects undeclared fields and mismatched scope trace or side', () => {
      expect(build('undeclared').anchors[0].missing).toBe(true);
      for (const change of [{traceId: 'another'}, {traceSide: 'reference' as const}]) {
        const wrong = structuredClone(mixed);
        Object.assign(wrong.entries[0].scope, change);
        expect(build('metric', wrong).anchors[0].missing).toBe(true);
      }
    });
    it('cannot transfer target identity from a different row instance or root side', () => {
      expect(build('metric', mixed, 43).anchors[0].identity).toBeUndefined();
      const otherSide = {...resolution, target: {...resolution.target, traceSide: 'reference' as const}};
      expect(build('metric', mixed, 42, otherSide).anchors[0].identity).toBeUndefined();
      const ambiguous = {...resolution, status: 'ambiguous' as const};
      expect(build('metric', mixed, 42, ambiguous).anchors[0].identity).toBeUndefined();
      const wrongTarget = {...resolution, target: {...resolution.target, upid: 43}};
      expect(build('metric', mixed, 42, wrongTarget).anchors[0].identity).toBeUndefined();
      const wrongProcess = {...resolution, processes: [{...resolution.processes[0], upid: 43}]};
      expect(build('metric', mixed, 42, wrongProcess).anchors[0].identity).toBeUndefined();
    });
    it('preserves pure global context without borrowing a verified target', () => {
      const global = {version: mixed.version, entries: [mixed.entries[1]]};
      const anchor = build('vsync', global).anchors[0];
      expect(anchor.identity).toBeUndefined();
      expect(anchor.scopeProvenance?.entries[0].role).toBe('global_context');
    });
  });

  it('preserves canonical legacy ns ranges while precise aliases remain strict', () => {
    const envelope = createDataEnvelope({
      columns: ['start_ts', 'ts', 'end_ts', 'dur', 'ts_str', 'dur_str'],
      rows: [
        ['10', null, null, '20', null, null],
        [null, '15', '20', null, null, null],
        [null, '15', null, '5', 'bad', '5'],
      ],
    }, {
      type: 'sql_result', source: 'execute_sql', title: 'Legacy exact ranges',
      evidenceRefId: 'data:legacy-ranges', traceId: 'trace-a', traceSide: 'current',
    });
    const relation = (id: string, subjectRow: number, objectRow: number) => ({
      schemaVersion: 'evidence_relation_candidate@1' as const,
      id,
      kind: 'overlap' as const,
      direction: 'symmetric' as const,
      subject: {evidenceRefId: 'data:legacy-ranges', rowIndex: subjectRow},
      object: {evidenceRefId: 'data:legacy-ranges', rowIndex: objectRow},
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [
        relation('relation:legacy-exact', 0, 1),
        relation('relation:malformed-precise', 0, 2),
      ],
    });

    expect(built.relations.find(item => item.id === 'relation:legacy-exact')).toEqual(expect.objectContaining({
      verificationStatus: 'candidate', reasonCode: 'overlap_range_missing',
    }));
    expect(built.anchors.find(anchor => anchor.timeRange?.startTs === '10')?.timeRange).toEqual({
      startTs: '10', endTs: '30', unit: 'ns', source: 'row',
    });
    expect(built.relations.find(item => item.id === 'relation:malformed-precise')).toEqual(expect.objectContaining({
      verificationStatus: 'candidate', reasonCode: 'overlap_range_missing',
    }));
  });

  it('derives strict event_ts/event_end_ts ranges without falling back around malformed aliases', () => {
    const envelope = createDataEnvelope({
      columns: ['frame_id', 'main_bottleneck', 'event_ts', 'event_end_ts', 'start_ts', 'end_ts'],
      rows: [
        ['1', 'ACK', '100', '200', null, null],
        ['2', 'ACK', '0100', '200', '10', '20'],
        ['3', 'ACK', '100', '9223372036854775808', '10', '20'],
        ['4', 'ACK', null, null, '10', '20'],
        ['5', 'ACK', '100', null, '10', '20'],
        ['6', 'ACK', '200', '100', null, null],
      ],
    }, {
      type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
      skillId: 'click_response_analysis', stepId: 'slow_input_events', executionStatus: 'observed',
      evidenceRefId: 'data:event-ranges', sourceToolCallId: 'invoke_skill:event-ranges',
      traceId: 'trace-a', traceSide: 'current',
    });
    const relation = (rowIndex: number) => ({
      schemaVersion: 'evidence_relation_candidate@1' as const,
      id: `relation:event-range:${rowIndex}`,
      kind: 'derived' as const,
      direction: 'subject_to_object' as const,
      subject: {evidenceRefId: 'data:event-ranges', rowIndex, column: 'frame_id'},
      object: {evidenceRefId: 'data:event-ranges', rowIndex, column: 'main_bottleneck'},
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [0, 1, 2, 3, 4, 5].map(relation),
    });
    const subjectRanges = new Map(built.anchors
      .filter(anchor => anchor.cells?.[0]?.column === 'frame_id')
      .map(anchor => [anchor.cells?.[0]?.actualValue, anchor.timeRange]));

    expect(subjectRanges.get('1')).toEqual({startTs: '100', endTs: '200', unit: 'ns', source: 'row'});
    expect(subjectRanges.get('2')).toBeUndefined();
    expect(subjectRanges.get('3')).toBeUndefined();
    expect(subjectRanges.get('4')).toEqual({startTs: '10', endTs: '20', unit: 'ns', source: 'row'});
    expect(subjectRanges.get('5')).toBeUndefined();
    expect(subjectRanges.get('6')).toBeUndefined();
  });

  it('derives strict perfetto_start/anr_ts ranges without falling back around malformed aliases', () => {
    const envelope = createDataEnvelope({
      columns: ['error_id', 'trigger_type', 'perfetto_start', 'anr_ts', 'start_ts', 'end_ts'],
      rows: [
        ['anr-1', 'input_dispatching_timeout', '100', '200', null, null],
        ['anr-2', 'input_dispatching_timeout', '0100', '200', '10', '20'],
        ['anr-3', 'input_dispatching_timeout', '100', '9223372036854775808', '10', '20'],
        ['anr-4', 'input_dispatching_timeout', null, null, '10', '20'],
        ['anr-5', 'input_dispatching_timeout', '100', null, '10', '20'],
        ['anr-6', 'input_dispatching_timeout', null, '200', '10', '20'],
        ['anr-7', 'input_dispatching_timeout', '200', '100', null, null],
      ],
    }, {
      type: 'skill_result', source: 'anr_analysis', title: 'ANR events',
      skillId: 'anr_analysis', stepId: 'get_anr_events', executionStatus: 'observed',
      evidenceRefId: 'data:anr-ranges', sourceToolCallId: 'invoke_skill:anr-ranges',
      traceId: 'trace-a', traceSide: 'current',
    });
    const relation = (rowIndex: number) => ({
      schemaVersion: 'evidence_relation_candidate@1' as const,
      id: `relation:anr-range:${rowIndex}`,
      kind: 'derived' as const,
      direction: 'subject_to_object' as const,
      subject: {evidenceRefId: 'data:anr-ranges', rowIndex, column: 'error_id'},
      object: {evidenceRefId: 'data:anr-ranges', rowIndex, column: 'trigger_type'},
    });

    const built = buildEvidenceContract({
      dataEnvelopes: [envelope],
      relationCandidates: [0, 1, 2, 3, 4, 5, 6].map(relation),
    });
    const subjectRanges = new Map(built.anchors
      .filter(anchor => anchor.cells?.[0]?.column === 'error_id')
      .map(anchor => [anchor.cells?.[0]?.actualValue, anchor.timeRange]));

    expect(subjectRanges.get('anr-1')).toEqual({startTs: '100', endTs: '200', unit: 'ns', source: 'row'});
    expect(subjectRanges.get('anr-2')).toBeUndefined();
    expect(subjectRanges.get('anr-3')).toBeUndefined();
    expect(subjectRanges.get('anr-4')).toEqual({startTs: '10', endTs: '20', unit: 'ns', source: 'row'});
    expect(subjectRanges.get('anr-5')).toBeUndefined();
    expect(subjectRanges.get('anr-6')).toBeUndefined();
    expect(subjectRanges.get('anr-7')).toBeUndefined();
  });

  it('builds distinct producer-authored overlap anchors without granting inferred clock authority', () => {
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
        verificationStatus: 'candidate',
        reasonCode: 'overlap_range_missing',
      }),
    ]);
    expect(contract.anchors).toHaveLength(2);
    expect(new Set(contract.anchors.map(anchor => anchor.anchorId)).size).toBe(2);
    expect((contract.relations[0] as any).directEvidenceAnchorIds).toEqual(
      expect.arrayContaining(contract.anchors.map(anchor => anchor.anchorId)),
    );
  });

  it('retains missing and disjoint legacy ranges as candidates without a captured clock', () => {
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
        verificationStatus: 'candidate',
        reasonCode: 'overlap_range_missing',
      }),
      expect.objectContaining({
        id: 'relation:overlap:missing',
        verificationStatus: 'candidate',
        reasonCode: 'overlap_range_missing',
      }),
    ]));
    const disjoint = built.relations.find(relation => relation.id === 'relation:overlap:disjoint')!;
    expect(built.anchors.find(anchor => anchor.anchorId === disjoint.subjectAnchorId)?.timeRange).toEqual({
      startTs: '100', endTs: '110', unit: 'ns', source: 'row',
    });
    expect(built.anchors.find(anchor => anchor.anchorId === disjoint.objectAnchorId)?.timeRange).toEqual({
      startTs: '200', endTs: '210', unit: 'ns', source: 'row',
    });
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

  it('preserves canonical nanosecond strings precisely without granting replay clock authority', () => {
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
      verificationStatus: 'candidate',
      reasonCode: 'overlap_range_missing',
    }));
    expect(built.anchors.map(anchor => anchor.timeRange)).toEqual([
      {startTs: '9007199254740993', endTs: '9007199254740994', unit: 'ns', source: 'row'},
      {startTs: '9007199254740993', endTs: '9007199254740994', unit: 'ns', source: 'row'},
    ]);
  });

  it('retains both binary bindings but never treats matching endpoint values as mechanism proof', () => {
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
        verificationStatus: 'candidate',
        reasonCode: 'proof_binding_missing',
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

  it('retains distinct client, server, and proof identities without upgrading a binary candidate', () => {
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
      verificationStatus: 'candidate',
      reasonCode: 'proof_binding_missing',
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
    ['error', 'candidate', 'relation_anchor_missing'],
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
      if (identityStatus === 'error') {
        expect(built.anchors).toEqual(expect.arrayContaining([
          expect.objectContaining({missing: true, missingReason: 'captured_identity_conflict',
            identity: expect.objectContaining({status: 'error'})}),
        ]));
      }
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

  it('retains declared deltas as candidates without metric authority and still rejects wrong sides', () => {
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
        verificationStatus: 'candidate',
        reasonCode: 'comparison_metric_missing',
        value: 50,
      }),
      expect.objectContaining({
        id: 'relation:delta:wrong-side',
        verificationStatus: 'rejected',
        reasonCode: 'comparison_side_mismatch',
      }),
      expect.objectContaining({
        id: 'relation:delta:wrong-value',
        verificationStatus: 'candidate',
        reasonCode: 'comparison_metric_missing',
        value: 40,
      }),
    ]));
    // Keep the conflicting proposal and its actual operands visible. Neither
    // arithmetic result has a captured unit/population definition in this replay.
    const wrongValue = built.relations.find(relation => relation.id === 'relation:delta:wrong-value')!;
    expect(built.anchors.find(anchor => anchor.anchorId === wrongValue.subjectAnchorId)?.cells?.[0].actualValue).toBe(150);
    expect(built.anchors.find(anchor => anchor.anchorId === wrongValue.objectAnchorId)?.cells?.[0].actualValue).toBe(100);
  });

  it('keeps a within-trace delta candidate, so a causal claim citing it is not made unsupported', () => {
    const envelope = (evidenceRefId: string, traceId: string, traceSide: 'current' | 'reference') =>
      createDataEnvelope({columns: ['blocked_ms'], rows: [[10]]}, {type: 'sql_result', source: 'execute_sql',
        title: evidenceRefId, evidenceRefId, traceId, traceSide});
    const ref = (evidenceRefId: string) => ({evidenceRefId, rowIndex: 0, column: 'blocked_ms'});
    const delta = (id: string, subject: string, object: string) => ({schemaVersion: 'evidence_relation_candidate@1', id,
      kind: 'comparison_delta', direction: 'subject_to_object', deltaDirection: 'current_minus_reference',
      subject: ref(subject), object: ref(object), metricColumn: 'blocked_ms', value: 0, unit: 'ms'});
    const citing = (relationRef: string): ConclusionContract => ({schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'causal', kind: 'causal', text: 'the first wait causes the second',
        references: [ref('data:a')], relationRefs: [relationRef]}]});
    const build = (relationRef: string) => buildEvidenceContract({
      dataEnvelopes: [envelope('data:a', 'trace', 'current'), envelope('data:b', 'trace', 'current'),
        envelope('data:other', 'trace-other', 'current')],
      relationCandidates: [delta('relation:within', 'data:a', 'data:b'), delta('relation:other', 'data:a', 'data:other')],
      conclusionContract: citing(relationRef),
    } as any);

    const within = build('relation:within');
    expect(within.relations.find(relation => relation.id === 'relation:within')).toMatchObject({
      verificationStatus: 'candidate', reasonCode: 'comparison_not_cross_trace'});
    expect(within.claimSupport[0]).toMatchObject({relationEvaluation: 'candidate'});
    expect(within.claimSupport[0].supportLevel).not.toBe('unsupported');
    // Current cells of two different traces remain a side contradiction.
    const other = build('relation:other');
    expect(other.relations.find(relation => relation.id === 'relation:other')).toMatchObject({
      verificationStatus: 'rejected', reasonCode: 'comparison_side_mismatch'});
    expect(other.claimSupport[0]).toMatchObject({relationEvaluation: 'rejected', supportLevel: 'unsupported'});
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

describe('evidence rows carry their declared boundary onto the claims citing them', () => {
  it('attaches claim_boundary from the cited row to the anchor', () => {
    // Skills declare limits like "this count is not a frame count". Dropping
    // them left the limit visible only inside the raw row, so honouring it
    // depended on the model noticing, and nothing downstream could audit it.
    const envelope = createDataEnvelope({
      columns: ['signal_type', 'event_count', 'claim_boundary'],
      rows: [['onFrameAvailable', '2716', 'event_count_is_not_frame_count_or_jank_count']],
    }, {
      type: 'skill_result',
      source: 'textureview_producer_frame_timing',
      title: 'signals',
      skillId: 'textureview_producer_frame_timing',
      stepId: 'signal_inventory',
      executionStatus: 'observed',
      evidenceRefId: 'data:tv',
      sourceToolCallId: 'invoke_skill:tv',
      traceId: 'trace-a',
      traceSide: 'current',
    } as never);

    const contract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{
        id: 'c1',
        text: 'onFrameAvailable 信号 2716 次',
        references: [{
          evidenceRefId: 'data:tv',
          sourceToolCallId: 'invoke_skill:tv',
          rowIndex: 0,
          column: 'event_count',
          value: '2716',
        }],
      }],
    } as never;

    const built = buildEvidenceContract({conclusionContract: contract, dataEnvelopes: [envelope]});

    expect(built.claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
      claimBoundary: 'event_count_is_not_frame_count_or_jank_count',
    }));
  });

  it('carries scope and root-cause boundaries the row declares', () => {
    // `needs_peer_evidence` is a producer saying the root cause is not
    // established. Dropping it let a claim assert a root cause while its own
    // evidence disclaimed one.
    const envelope = createDataEnvelope({
      columns: ['signal_type', 'event_count', 'evidence_scope', 'root_cause_boundary'],
      rows: [['onFrameAvailable', '2716', 'observed_callback_execution_only', 'needs_peer_evidence']],
    }, {
      type: 'skill_result',
      source: 'textureview_producer_frame_timing',
      title: 'signals',
      executionStatus: 'observed',
      evidenceRefId: 'data:tv',
      sourceToolCallId: 'invoke_skill:tv',
      traceId: 'trace-a',
      traceSide: 'current',
    } as never);

    const contract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{
        id: 'c1',
        text: 'onFrameAvailable 信号 2716 次导致掉帧',
        references: [{
          evidenceRefId: 'data:tv',
          sourceToolCallId: 'invoke_skill:tv',
          rowIndex: 0,
          column: 'event_count',
          value: '2716',
        }],
      }],
    } as never;

    expect(buildEvidenceContract({conclusionContract: contract, dataEnvelopes: [envelope]})
      .claimSupport[0].anchors[0]).toEqual(expect.objectContaining({
        evidenceScope: 'observed_callback_execution_only',
        rootCauseBoundary: 'needs_peer_evidence',
      }));
  });

  it('omits the field when the row declares no boundary', () => {
    const envelope = createDataEnvelope({
      columns: ['signal_type', 'event_count'],
      rows: [['onFrameAvailable', '2716']],
    }, {
      type: 'skill_result',
      source: 'textureview_producer_frame_timing',
      title: 'signals',
      executionStatus: 'observed',
      evidenceRefId: 'data:tv',
      sourceToolCallId: 'invoke_skill:tv',
      traceId: 'trace-a',
      traceSide: 'current',
    } as never);

    const contract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{
        id: 'c1',
        text: 'onFrameAvailable 信号 2716 次',
        references: [{
          evidenceRefId: 'data:tv',
          sourceToolCallId: 'invoke_skill:tv',
          rowIndex: 0,
          column: 'event_count',
          value: '2716',
        }],
      }],
    } as never;

    const built = buildEvidenceContract({conclusionContract: contract, dataEnvelopes: [envelope]});

    expect(built.claimSupport[0].anchors[0]).not.toHaveProperty('claimBoundary');
  });
});
