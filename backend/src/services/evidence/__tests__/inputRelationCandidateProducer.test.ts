// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {produceInputRelationCandidates} from '../inputRelationCandidateProducer';

const COLUMNS = [
  'frame_id', 'event_ts', 'event_end_ts', 'main_bottleneck', 'severity', 'total_ms', 'diagnosis',
];

function envelope(
  rows: unknown[][],
  overrides: Record<string, unknown> = {},
  columns = COLUMNS,
): DataEnvelope {
  return createDataEnvelope({columns, rows}, {
    type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
    skillId: 'click_response_analysis', stepId: 'slow_input_events', executionStatus: 'observed',
    evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
    traceId: 'trace-a', traceSide: 'current', ...overrides,
  } as any);
}

describe('inputRelationCandidateProducer', () => {
  it.each(['系统分发', '应用处理', 'ACK'])('emits a stable frame-to-%s derived candidate from an exact row', bottleneck => {
    const input = envelope([
      ['9007199254740993', '100', '200', bottleneck, 'critical', 123.4, 'prose must not bind'],
    ]);

    const first = produceInputRelationCandidates([input]);
    const second = produceInputRelationCandidates([input]);

    expect(first).toEqual(second);
    expect(first).toEqual([{
      schemaVersion: 'evidence_relation_candidate@1',
      id: expect.stringMatching(/^relation:input-frame-bottleneck:[0-9a-f]{16}$/),
      kind: 'derived',
      direction: 'subject_to_object',
      subject: {
        evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
        rowIndex: 0, column: 'frame_id', value: '9007199254740993',
      },
      object: {
        evidenceRefId: 'data:input', sourceToolCallId: 'invoke_skill:input',
        rowIndex: 0, column: 'main_bottleneck', value: bottleneck,
      },
    }]);
    expect(JSON.stringify(first)).not.toMatch(/severity|total_ms|diagnosis|critical|123\.4|prose/);

    const relation = buildEvidenceContract({dataEnvelopes: [input], relationCandidates: first}).relations[0];
    expect(relation).toEqual(expect.objectContaining({
      kind: 'derived', verificationStatus: 'candidate', reasonCode: 'derived_not_verified',
      supportLevel: 'inference',
    }));
  });

  it('requires an observed exact skill-result envelope with stable evidence, tool, and trace context', () => {
    const valid = [['1', '100', '200', 'ACK', 'warning', 101, 'ignored']];
    const invalid = [
      envelope(valid, {type: 'sql_result'}),
      envelope(valid, {executionStatus: undefined}),
      envelope(valid, {executionStatus: 'empty'}),
      envelope(valid, {executionStatus: 'optional_error'}),
      envelope(valid, {skillId: 'input_module'}),
      envelope(valid, {stepId: 'slow_events'}),
      envelope(valid, {evidenceRefId: ''}),
      envelope(valid, {evidenceRefId: ' data:input'}),
      envelope(valid, {sourceToolCallId: undefined}),
      envelope(valid, {sourceToolCallId: ''}),
      envelope(valid, {sourceToolCallId: ' invoke_skill:input'}),
      envelope(valid, {traceId: ''}),
      envelope(valid, {traceId: ' trace-a'}),
      envelope(valid, {traceSide: 'unknown'}),
    ];

    for (const candidate of invalid) {
      expect(produceInputRelationCandidates([candidate])).toEqual([]);
    }
    expect(produceInputRelationCandidates([
      envelope(valid, {source: 'display alias', title: 'localized display title'}),
    ])).toHaveLength(1);
  });

  it.each([
    ['leading-zero frame', ['01', '100', '200', 'ACK']],
    ['negative frame', ['-1', '100', '200', 'ACK']],
    ['unsafe numeric frame', [9_007_199_254_740_992, '100', '200', 'ACK']],
    ['overflow frame', ['9223372036854775808', '100', '200', 'ACK']],
    ['leading-zero start', ['1', '0100', '200', 'ACK']],
    ['negative start', ['1', '-1', '200', 'ACK']],
    ['unsafe numeric start', ['1', 9_007_199_254_740_992, '9223372036854775807', 'ACK']],
    ['leading-zero end', ['1', '100', '0200', 'ACK']],
    ['equal end', ['1', '100', '100', 'ACK']],
    ['end before start', ['1', '200', '100', 'ACK']],
    ['overflow end', ['1', '100', '9223372036854775808', 'ACK']],
    ['translated bottleneck', ['1', '100', '200', 'system dispatch']],
    ['decorated bottleneck', ['1', '100', '200', 'ACK slow']],
    ['empty bottleneck', ['1', '100', '200', '']],
  ])('rejects malformed or inferred row input: %s', (_name, row) => {
    expect(produceInputRelationCandidates([
      envelope([row], {}, ['frame_id', 'event_ts', 'event_end_ts', 'main_bottleneck']),
    ])).toEqual([]);
  });

  it('requires all producer-owned exact cells and never infers from severity, latency, thresholds, or prose', () => {
    const columns = ['frame_id', 'event_ts', 'event_end_ts', 'main_bottleneck', 'severity', 'total_ms', 'diagnosis'];
    const valid = ['1', '100', '200', 'ACK', 'critical', 999, 'ACK is slow'];
    for (const missingIndex of [0, 1, 2, 3]) {
      const row: unknown[] = [...valid];
      row[missingIndex] = null;
      expect(produceInputRelationCandidates([envelope([row], {}, columns)])).toEqual([]);
    }
    expect(produceInputRelationCandidates([
      envelope([['1', '100', '200', 'warning', 999, 'ACK']], {},
        ['frame_id', 'event_ts', 'event_end_ts', 'severity', 'total_ms', 'diagnosis']),
    ])).toEqual([]);
  });

  it('accepts object rows, caps output at 50, and orders candidates independently of envelope order', () => {
    const objectEnvelope = createDataEnvelope({
      rows: [{frame_id: '2', event_ts: '10', event_end_ts: '20', main_bottleneck: '应用处理'}] as any,
    }, {
      type: 'skill_result', source: 'click_response_analysis', title: 'slow input events',
      skillId: 'click_response_analysis', stepId: 'slow_input_events', executionStatus: 'observed',
      evidenceRefId: 'data:object', sourceToolCallId: 'invoke_skill:object',
      traceId: 'trace-b', traceSide: 'reference',
    });
    expect(produceInputRelationCandidates([objectEnvelope])).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({value: '2'}),
        object: expect.objectContaining({value: '应用处理'}),
      }),
    ]);
    const rows = Array.from({length: 60}, (_, index) => [
      String(index + 1), String(index * 10 + 1), String(index * 10 + 2), '系统分发', 'warning', 101, 'ignored',
    ]);
    const rowEnvelope = envelope(rows, {evidenceRefId: 'data:rows', traceId: 'trace-a'});

    const first = produceInputRelationCandidates([objectEnvelope, rowEnvelope]);
    const second = produceInputRelationCandidates([rowEnvelope, objectEnvelope]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
    expect(first.every(candidate => candidate.subject.column === 'frame_id' &&
      candidate.object?.column === 'main_bottleneck')).toBe(true);
  });
});
