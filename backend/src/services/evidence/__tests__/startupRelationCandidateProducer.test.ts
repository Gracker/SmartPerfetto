// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createDataEnvelope, type DataEnvelope} from '../../../types/dataContract';
import {buildEvidenceContract} from '../evidenceContractBuilder';
import {produceStartupRelationCandidates} from '../startupRelationCandidateProducer';

function envelope(
  stepId: string,
  evidenceRefId: string,
  columns: string[],
  rows: unknown[][],
  overrides: Record<string, unknown> = {},
): DataEnvelope {
  return createDataEnvelope({columns, rows}, {
    type: 'skill_result',
    source: 'startup_analysis',
    title: stepId,
    skillId: 'startup_analysis',
    stepId,
    evidenceRefId,
    sourceToolCallId: `invoke_skill:${stepId}`,
    traceId: 'trace-a',
    traceSide: 'current',
    ...overrides,
  } as any);
}

describe('startupRelationCandidateProducer', () => {
  it('emits stable verified overlap candidates from exact startup and Binder rows', () => {
    const startups = envelope(
      'get_startups', 'data:startup', ['start_ts', 'end_ts'],
      [['9007199254740993', '9007199254741093']],
    );
    const binder = envelope(
      'main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str', 'dur_ms'],
      [['9007199254741000', '10', 999]],
    );

    const first = produceStartupRelationCandidates([binder, startups]);
    const second = produceStartupRelationCandidates([startups, binder]);

    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({
        schemaVersion: 'evidence_relation_candidate@1',
        id: expect.stringMatching(/^relation:startup-binder-overlap:[0-9a-f]{16}$/),
        kind: 'overlap',
        direction: 'subject_to_object',
        subject: expect.objectContaining({evidenceRefId: 'data:startup', rowIndex: 0}),
        object: expect.objectContaining({evidenceRefId: 'data:binder', rowIndex: 0}),
      }),
    ]);
    expect(buildEvidenceContract({
      dataEnvelopes: [startups, binder], relationCandidates: first,
    }).relations[0]).toEqual(expect.objectContaining({
      verificationStatus: 'verified', reasonCode: 'overlap_verified',
    }));
  });

  it('falls back to exact decimal dur_ms without floating-point multiplication', () => {
    const startups = envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], [['10', '20']]);
    const binder = envelope(
      'main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_ms'], [['19', '0.000001']],
    );
    const candidates = produceStartupRelationCandidates([startups, binder]);
    const built = buildEvidenceContract({dataEnvelopes: [startups, binder], relationCandidates: candidates});

    expect(candidates).toHaveLength(1);
    expect(built.anchors.find(anchor => anchor.evidenceRefId === 'data:binder')?.timeRange).toEqual({
      startTs: '19', endTs: '20', unit: 'ns', source: 'row',
    });
    expect(built.relations[0]?.verificationStatus).toBe('verified');
  });

  it.each([
    ['negative ns', '-1', undefined, '1'],
    ['exponent ms', '15', undefined, '1e-3'],
    ['over-precision ms', '15', undefined, '0.0000001'],
    ['non-canonical ns', '015', undefined, '1'],
    ['invalid preferred dur_str', '15', 'bad', '1'],
    ['overflowing duration', '9223372036854775807', '1', undefined],
  ])('rejects hostile time input: %s', (_name, tsStr, durStr, durMs) => {
    const startups = envelope(
      'get_startups', 'data:startup', ['start_ts', 'end_ts'], [['0', '9223372036854775807']],
    );
    const columns = ['ts_str', ...(durStr === undefined ? [] : ['dur_str']), ...(durMs === undefined ? [] : ['dur_ms'])];
    const row = [tsStr, ...(durStr === undefined ? [] : [durStr]), ...(durMs === undefined ? [] : [durMs])];
    const binder = envelope('main_thread_binder_blocking', 'data:binder', columns, [row]);

    expect(produceStartupRelationCandidates([startups, binder])).toEqual([]);
  });

  it('requires exact skill, step, execution, evidence and trace-side admission', () => {
    const validStartup = envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], [['10', '30']]);
    const validBinder = envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']]);
    const mutations = [
      [envelope('get_startups_other', 'data:startup', ['start_ts', 'end_ts'], [['10', '30']]), validBinder],
      [validStartup, envelope('main_thread_binder_blocking_other', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']])],
      [envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], [['10', '30']], {skillId: 'other'}), validBinder],
      [envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], [['10', '30']], {executionStatus: 'empty'}), validBinder],
      [validStartup, envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']], {executionStatus: 'optional_error'})],
      [envelope('get_startups', '', ['start_ts', 'end_ts'], [['10', '30']]), validBinder],
      [validStartup, envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']], {traceId: 'trace-b'})],
      [validStartup, envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']], {traceSide: 'reference'})],
    ];

    for (const pair of mutations) expect(produceStartupRelationCandidates(pair as DataEnvelope[])).toEqual([]);
  });

  it('does not emit disjoint windows and bounds rows/candidates deterministically', () => {
    const startupRows = Array.from({length: 60}, (_, index) => [String(index * 100), String(index * 100 + 50)]);
    const binderRows = Array.from({length: 60}, (_, index) => [String(index * 100 + 10), '5']);
    const startups = envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], startupRows);
    const binder = envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], binderRows);

    const candidates = produceStartupRelationCandidates([startups, binder]);

    expect(candidates).toHaveLength(50);
    expect(candidates.every(candidate => Number(candidate.subject.rowIndex) < 50)).toBe(true);
    expect(candidates.every(candidate => Number(candidate.object?.rowIndex) < 50)).toBe(true);
    expect(produceStartupRelationCandidates([
      envelope('get_startups', 'data:s', ['start_ts', 'end_ts'], [['0', '10']]),
      envelope('main_thread_binder_blocking', 'data:b', ['ts_str', 'dur_str'], [['10', '1']]),
    ])).toEqual([]);
  });

  it('accepts object-shaped rows and retains stable tool-call endpoints', () => {
    const startups = createDataEnvelope({
      rows: [{start_ts: '10', end_ts: '30'}] as any,
    }, {
      type: 'skill_result', source: 'startup_analysis', title: 'startups', skillId: 'startup_analysis',
      stepId: 'get_startups', evidenceRefId: 'data:startup', sourceToolCallId: 'invoke_skill:startups',
      traceId: 'trace-a', traceSide: 'current',
    });
    const binder = createDataEnvelope({
      rows: [{ts_str: '15', dur_str: '5'}] as any,
    }, {
      type: 'skill_result', source: 'startup_analysis', title: 'binder', skillId: 'startup_analysis',
      stepId: 'main_thread_binder_blocking', evidenceRefId: 'data:binder', sourceToolCallId: 'invoke_skill:binder',
      traceId: 'trace-a', traceSide: 'current',
    });

    expect(produceStartupRelationCandidates([startups, binder])).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({
          evidenceRefId: 'data:startup', sourceToolCallId: 'invoke_skill:startups', rowIndex: 0,
        }),
        object: expect.objectContaining({
          evidenceRefId: 'data:binder', sourceToolCallId: 'invoke_skill:binder', rowIndex: 0,
        }),
      }),
    ]);
  });

  it('does not relax exact producer fields to legacy duration aliases', () => {
    expect(produceStartupRelationCandidates([
      envelope('get_startups', 'data:startup', ['start_ts', 'dur'], [['10', '20']]),
      envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur_str'], [['15', '5']]),
    ])).toEqual([]);
    expect(produceStartupRelationCandidates([
      envelope('get_startups', 'data:startup', ['start_ts', 'end_ts'], [['10', '30']]),
      envelope('main_thread_binder_blocking', 'data:binder', ['ts_str', 'dur'], [['15', '5']]),
    ])).toEqual([]);
  });
});
