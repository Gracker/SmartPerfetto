// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {produceScrollingRelationCandidates} from '../scrollingRelationCandidateProducer';

function envelope(
  rows: unknown[][],
  overrides: Record<string, unknown> = {},
  columns = ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code', 'primary_cause'],
): DataEnvelope {
  return createDataEnvelope({columns, rows}, {
    type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
    skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause',
    executionStatus: 'observed', evidenceRefId: 'data:scrolling',
    sourceToolCallId: 'invoke_skill:scrolling', traceId: 'trace-a', traceSide: 'current',
    ...overrides,
  } as any);
}

describe('scrollingRelationCandidateProducer', () => {
  it('emits stable frame-to-reason derived candidates from exact rows', () => {
    const input = envelope([
      ['9007199254740993', '200', '1500000', '1.5', 'workload_heavy', 'long task'],
    ]);

    const first = produceScrollingRelationCandidates([input]);
    const second = produceScrollingRelationCandidates([input]);

    expect(first).toEqual(second);
    expect(first).toEqual([{
      schemaVersion: 'evidence_relation_candidate@1',
      id: expect.stringMatching(/^relation:scrolling-frame-root-cause:[0-9a-f]{16}$/),
      kind: 'derived',
      direction: 'subject_to_object',
      subject: {
        evidenceRefId: 'data:scrolling', sourceToolCallId: 'invoke_skill:scrolling',
        rowIndex: 0, column: 'frame_id', value: '9007199254740993',
      },
      object: {
        evidenceRefId: 'data:scrolling', sourceToolCallId: 'invoke_skill:scrolling',
        rowIndex: 0, column: 'reason_code', value: 'workload_heavy',
      },
    }]);
    expect(JSON.stringify(first)).not.toContain('primary_cause');

    const relation = buildEvidenceContract({dataEnvelopes: [input], relationCandidates: first}).relations[0];
    expect(relation).toEqual(expect.objectContaining({
      kind: 'derived', verificationStatus: 'candidate', reasonCode: 'derived_not_verified',
      supportLevel: 'inference',
    }));
  });

  it('requires an observed skill-result envelope with stable evidence and trace identity', () => {
    const valid = [['1', '200', '1000000', '1', 'workload_heavy', 'long task']];
    const invalid = [
      envelope(valid, {type: 'sql_result'}),
      envelope(valid, {executionStatus: undefined}),
      envelope(valid, {executionStatus: 'empty'}),
      envelope(valid, {executionStatus: 'optional_error'}),
      envelope(valid, {skillId: 'other'}),
      envelope(valid, {stepId: 'other'}),
      envelope(valid, {evidenceRefId: ''}),
      envelope(valid, {evidenceRefId: ' data:scrolling'}),
      envelope(valid, {traceId: ''}),
      envelope(valid, {traceSide: 'unknown'}),
      envelope(valid, {sourceToolCallId: ' bad'}),
    ];

    for (const candidate of invalid) {
      expect(produceScrollingRelationCandidates([candidate])).toEqual([]);
    }
    expect(produceScrollingRelationCandidates([
      envelope(valid, {source: 'unrelated display source', title: 'unrelated title'}),
    ])).toHaveLength(1);
  });

  it.each([
    ['leading-zero frame', ['01', '200', '1000000', 'workload_heavy']],
    ['negative frame', ['-1', '200', '1000000', 'workload_heavy']],
    ['unsafe numeric frame', [9_007_199_254_740_992, '200', '1000000', 'workload_heavy']],
    ['overflow frame', ['9223372036854775808', '200', '1000000', 'workload_heavy']],
    ['leading-zero timestamp', ['1', '0200', '1000000', 'workload_heavy']],
    ['negative duration', ['1', '200', '-1', 'workload_heavy']],
    ['exponent duration', ['1', '200', '1e3', 'workload_heavy']],
    ['empty reason', ['1', '200', '1000000', '']],
    ['uppercase reason', ['1', '200', '1000000', 'WorkloadHeavy']],
    ['unsafe reason punctuation', ['1', '200', '1000000', 'workload-heavy']],
    ['overlong reason', ['1', '200', '1000000', 'a'.repeat(65)]],
  ])('rejects malformed row input: %s', (_name, row) => {
    expect(produceScrollingRelationCandidates([
      envelope([row], {}, ['frame_id', 'start_ts', 'dur', 'reason_code']),
    ])).toEqual([]);
  });

  it('requires producer-owned start/duration fields, prefers exact dur, and fails closed', () => {
    expect(produceScrollingRelationCandidates([
      envelope([['1', '200', '1', 'workload_heavy']], {}, ['frame_id', 'ts', 'dur', 'reason_code']),
    ])).toEqual([]);
    expect(produceScrollingRelationCandidates([
      envelope([['1', '200', 'bad', '1', 'workload_heavy']], {},
        ['frame_id', 'start_ts', 'dur', 'dur_ms', 'reason_code']),
    ])).toEqual([]);

    expect(produceScrollingRelationCandidates([
      envelope([['1', '200', '1000000', 'workload_heavy']], {},
        ['frame_id', 'start_ts', 'dur', 'reason_code']),
    ])).toHaveLength(1);
    expect(produceScrollingRelationCandidates([
      envelope([['1', '200', '1000000', 'workload_heavy']], {},
        ['frame_id', 'start_ts', 'dur_str', 'reason_code']),
    ])).toHaveLength(1);
    expect(produceScrollingRelationCandidates([
      envelope([['1', '200', '1', 'workload_heavy']], {},
        ['frame_id', 'start_ts', 'dur_ms', 'reason_code']),
    ])).toHaveLength(1);
  });

  it('accepts object rows, optional tool ids, and caps candidates deterministically at 50', () => {
    const objectEnvelope = createDataEnvelope({
      rows: [{frame_id: '2', start_ts: '10', dur: '1000000', dur_ms: '1', reason_code: 'gc_jank'}] as any,
    }, {
      type: 'skill_result', source: 'scrolling_analysis', title: 'root causes',
      skillId: 'scrolling_analysis', stepId: 'batch_frame_root_cause', executionStatus: 'observed',
      evidenceRefId: 'data:object', traceId: 'trace-a', traceSide: 'current',
    });
    expect(produceScrollingRelationCandidates([objectEnvelope])[0]).toEqual(expect.objectContaining({
      subject: expect.not.objectContaining({sourceToolCallId: expect.anything()}),
      object: expect.not.objectContaining({sourceToolCallId: expect.anything()}),
    }));

    const rows = Array.from({length: 60}, (_, index) => [
      String(index + 1), String(index * 2_000_000), '1000000', '1', 'workload_heavy', 'ignored',
    ]);
    const capped = produceScrollingRelationCandidates([envelope(rows)]);
    expect(capped).toHaveLength(50);
    expect(capped.every(candidate => Number(candidate.subject.rowIndex) < 50)).toBe(true);
  });
});
