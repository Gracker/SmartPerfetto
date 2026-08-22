// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {produceAnrRelationCandidates} from '../anrRelationCandidateProducer';

const COLUMNS = [
  'error_id', 'process_name', 'pid', 'anr_type', 'trigger_type', 'anr_ts', 'perfetto_start',
  'root_cause_pattern_hints', 'subject_preview',
];

function envelope(
  rows: unknown[][],
  overrides: Record<string, unknown> = {},
  columns = COLUMNS,
): DataEnvelope {
  return createDataEnvelope({columns, rows}, {
    type: 'skill_result', source: 'anr_analysis', title: 'ANR events',
    skillId: 'anr_analysis', stepId: 'get_anr_events', executionStatus: 'observed',
    evidenceRefId: 'data:anr', sourceToolCallId: 'invoke_skill:anr',
    traceId: 'trace-a', traceSide: 'current', ...overrides,
  } as any);
}

describe('anrRelationCandidateProducer', () => {
  it.each([
    'input_dispatching_timeout',
    'broadcast_timeout',
    'service_timeout',
    'content_provider_timeout',
    'job_scheduler_timeout',
    'system_watchdog_swt',
    'unknown',
  ])('emits a stable error-to-%s derived candidate from an exact ANR row', triggerType => {
    const input = envelope([
      ['smartperfetto-synthetic-anr', 'com.example', 123, 'INPUT_DISPATCHING_TIMEOUT', triggerType, '200', '100',
        'deadlock,memory_leak_oom_pressure', 'prose must not bind'],
    ]);

    const first = produceAnrRelationCandidates([input]);
    const second = produceAnrRelationCandidates([input]);

    expect(first).toEqual(second);
    expect(first).toEqual([{
      schemaVersion: 'evidence_relation_candidate@1',
      id: expect.stringMatching(/^relation:anr-error-trigger:[0-9a-f]{16}$/),
      kind: 'derived',
      direction: 'subject_to_object',
      subject: {
        evidenceRefId: 'data:anr', sourceToolCallId: 'invoke_skill:anr',
        rowIndex: 0, column: 'error_id', value: 'smartperfetto-synthetic-anr',
      },
      object: {
        evidenceRefId: 'data:anr', sourceToolCallId: 'invoke_skill:anr',
        rowIndex: 0, column: 'trigger_type', value: triggerType,
      },
    }]);
    expect(JSON.stringify(first)).not.toMatch(/root_cause_pattern_hints|subject_preview|deadlock|memory|prose|process_name|pid/);

    const relation = buildEvidenceContract({dataEnvelopes: [input], relationCandidates: first}).relations[0];
    expect(relation).toEqual(expect.objectContaining({
      kind: 'derived', verificationStatus: 'candidate', reasonCode: 'derived_not_verified',
      supportLevel: 'inference',
    }));
  });

  it('requires an observed exact get_anr_events envelope with stable evidence, tool, and trace context', () => {
    const valid = [['anr-1', 'com.example', 123, 'INPUT_DISPATCHING_TIMEOUT', 'input_dispatching_timeout', '200', '100']];
    const invalid = [
      envelope(valid, {type: 'sql_result'}),
      envelope(valid, {executionStatus: undefined}),
      envelope(valid, {executionStatus: 'empty'}),
      envelope(valid, {executionStatus: 'optional_error'}),
      envelope(valid, {skillId: 'anr_detail'}),
      envelope(valid, {stepId: 'trigger_classification'}),
      envelope(valid, {evidenceRefId: ''}),
      envelope(valid, {evidenceRefId: ' data:anr'}),
      envelope(valid, {sourceToolCallId: undefined}),
      envelope(valid, {sourceToolCallId: ''}),
      envelope(valid, {sourceToolCallId: ' invoke_skill:anr'}),
      envelope(valid, {traceId: ''}),
      envelope(valid, {traceId: ' trace-a'}),
      envelope(valid, {traceSide: 'unknown'}),
    ];

    for (const candidate of invalid) {
      expect(produceAnrRelationCandidates([candidate])).toEqual([]);
    }
    expect(produceAnrRelationCandidates([
      envelope(valid, {source: 'display alias', title: 'localized display title'}),
    ])).toHaveLength(1);
  });

  it.each([
    ['empty error id', ['', 'input_dispatching_timeout', '100', '10']],
    ['blank error id', ['   ', 'input_dispatching_timeout', '100', '10']],
    ['object error id', [{id: 'anr-1'}, 'input_dispatching_timeout', '100', '10']],
    ['decorated trigger', ['anr-1', 'input_dispatching_timeout slow', '100', '10']],
    ['translated trigger', ['anr-1', '输入超时', '100', '10']],
    ['leading-zero start', ['anr-1', 'input_dispatching_timeout', '100', '010']],
    ['leading-zero end', ['anr-1', 'input_dispatching_timeout', '0100', '10']],
    ['equal window', ['anr-1', 'input_dispatching_timeout', '100', '100']],
    ['end before start', ['anr-1', 'input_dispatching_timeout', '100', '200']],
    ['overflow start', ['anr-1', 'input_dispatching_timeout', '200', '9223372036854775808']],
    ['overflow end', ['anr-1', 'input_dispatching_timeout', '9223372036854775808', '100']],
  ])('rejects malformed or inferred ANR input: %s', (_name, row) => {
    expect(produceAnrRelationCandidates([
      envelope([row], {}, ['error_id', 'trigger_type', 'anr_ts', 'perfetto_start']),
    ])).toEqual([]);
  });

  it('accepts stable string or numeric error ids, object rows, caps output at 50, and orders deterministically', () => {
    const objectEnvelope = createDataEnvelope({
      rows: [{error_id: 42, trigger_type: 'broadcast_timeout', anr_ts: '20', perfetto_start: '10'}] as any,
    }, {
      type: 'skill_result', source: 'anr_analysis', title: 'ANR events',
      skillId: 'anr_analysis', stepId: 'get_anr_events', executionStatus: 'observed',
      evidenceRefId: 'data:object', sourceToolCallId: 'invoke_skill:object',
      traceId: 'trace-b', traceSide: 'reference',
    });
    expect(produceAnrRelationCandidates([objectEnvelope])).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({value: '42'}),
        object: expect.objectContaining({value: 'broadcast_timeout'}),
      }),
    ]);
    const rows = Array.from({length: 60}, (_, index) => [
      `anr-${index + 1}`, 'com.example', 123, 'INPUT_DISPATCHING_TIMEOUT', 'input_dispatching_timeout',
      String(index * 10 + 2), String(index * 10 + 1),
    ]);
    const rowEnvelope = envelope(rows, {evidenceRefId: 'data:rows', traceId: 'trace-a'});

    const first = produceAnrRelationCandidates([objectEnvelope, rowEnvelope]);
    const second = produceAnrRelationCandidates([rowEnvelope, objectEnvelope]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
    expect(first.every(candidate => candidate.subject.column === 'error_id' &&
      candidate.object?.column === 'trigger_type')).toBe(true);
  });
});
