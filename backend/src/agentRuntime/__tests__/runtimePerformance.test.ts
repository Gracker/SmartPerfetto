// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {describe, expect, it} from '@jest/globals';

import {
  createRuntimePerformanceRecorder,
  createRuntimePerformanceRun,
} from '../runtimePerformance';

function expectedRuntimeHash(value: string, salt = ''): string {
  return `sha256:${createHash('sha256')
    .update(salt)
    .update('\0')
    .update(value.trim())
    .digest('hex')
    .slice(0, 32)}`;
}

describe('runtime performance receipt', () => {
  it('records overlapping phases as separate bounded immutable spans', () => {
    let now = 100;
    const recorder = createRuntimePerformanceRecorder({now: () => now});

    const classification = recorder.startPhase('classification');
    now = 110;
    const provider = recorder.startPhase('provider');
    now = 140;
    classification.end();
    now = 160;
    provider.end();

    const receipt = recorder.seal();

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      phases: [
        {
          name: 'classification',
          startOffsetMs: 0,
          durationMs: 40,
          outcome: 'ok',
        },
        {
          name: 'provider',
          startOffsetMs: 10,
          durationMs: 50,
          outcome: 'ok',
        },
      ],
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.phases)).toBe(true);
    expect(receipt.tools).toEqual([]);
    expect(receipt.sql).toEqual([]);
  });

  it('does not fabricate unobserved runtime phases during finalization', () => {
    let now = 10;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 20;
    run.finishClassification();
    now = 30;
    run.finalize('ok');

    expect(recorder.seal().phases.map(phase => phase.name)).toEqual([
      'classification',
    ]);
  });

  it('records real finalization span duration only when the runtime starts and ends it', () => {
    let now = 100;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 105;
    run.finishClassification();
    now = 110;
    const finalization = run.startPhase('finalization');
    now = 145;
    finalization.end('cancelled');
    now = 200;
    run.finalize('cancelled');

    expect(recorder.seal().phases).toEqual([
      expect.objectContaining({
        name: 'classification',
        startOffsetMs: 0,
        durationMs: 5,
        outcome: 'ok',
      }),
      expect.objectContaining({
        name: 'finalization',
        startOffsetMs: 10,
        durationMs: 35,
        outcome: 'cancelled',
      }),
    ]);
  });

  it('finalize closes an already-started classification span with terminal outcome only', () => {
    let now = 50;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 75;
    run.finalize('error');

    expect(recorder.seal().phases).toEqual([
      {
        name: 'classification',
        startOffsetMs: 0,
        durationMs: 25,
        outcome: 'error',
      },
    ]);
  });

  it('assigns first output once and records phase outcomes', () => {
    let now = 1_000;
    const recorder = createRuntimePerformanceRecorder({now: () => now});

    const verification = recorder.startPhase('verification');
    now = 1_025;
    recorder.recordFirstOutput();
    now = 1_080;
    recorder.recordFirstOutput();
    verification.end('error');
    const finalization = recorder.startPhase('finalization');
    finalization.end('cancelled');

    expect(recorder.seal()).toMatchObject({
      firstOutputMs: 25,
      phases: [
        expect.objectContaining({name: 'verification', outcome: 'error'}),
        expect.objectContaining({name: 'finalization', outcome: 'cancelled'}),
      ],
    });
  });

  it('rejects privacy-bearing fields and hashes raw tool ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'raw-tool-id-123',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 2,
      outcome: 'ok',
    });
    expect(() => recorder.recordTool({
      toolCallId: 'safe',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 2,
      outcome: 'ok',
      prompt: 'must-not-leak',
    } as any)).toThrow('runtime_performance_privacy_field:prompt');
    expect(() => recorder.recordSql({
      processorKey: 'processor-a',
      priority: 'p1',
      queueWaitMs: 1,
      executionMs: 2,
      outcome: 'ok',
      sql: 'SELECT secret',
    } as any)).toThrow('runtime_performance_privacy_field:sql');

    const receipt = recorder.seal();

    expect(receipt.tools).toHaveLength(1);
    expect(receipt.tools[0].toolCallIdHash).toMatch(/^sha256:/);
    expect(JSON.stringify(receipt)).not.toContain('raw-tool-id-123');
  });

  it('records bounded tool concurrency fallback reasons without leaking raw ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'raw-fallback-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 12,
      durationMs: 2,
      outcome: 'ok',
      fallbackReason: 'disabled_by_env',
    } as any);
    recorder.recordTool({
      toolCallId: 'raw-demoted-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 1,
      durationMs: 3,
      outcome: 'error',
      fallbackReason: 'commutative_read_not_admitted',
    } as any);
    expect(() => recorder.recordTool({
      toolCallId: 'bad-fallback-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
      fallbackReason: 'raw_query_disabled_by_secret',
    } as any)).toThrow('runtime_performance_invalid_tool_fallback_reason');

    const receipt = recorder.seal();

    expect(receipt.tools).toEqual([
      expect.objectContaining({
        fallbackReason: 'disabled_by_env',
        schedulerWaitMs: 12,
      }),
      expect.objectContaining({
        fallbackReason: 'commutative_read_not_admitted',
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain('raw-fallback-tool-id');
    expect(JSON.stringify(receipt)).not.toContain('raw-demoted-tool-id');
    expect(JSON.stringify(receipt)).not.toContain('raw_query_disabled_by_secret');
  });

  it('omits fallbackReason for older exclusive tool receipts', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});

    recorder.recordTool({
      toolCallId: 'legacy-tool-id',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    });

    expect(recorder.seal().tools[0]).not.toHaveProperty('fallbackReason');
  });

  it('hashes the exact canonical SQL processor key without leaking trace or lease ids', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});
    const processorKey = 'trace-a:lease:lease-a';

    recorder.recordSql({
      processorKey,
      priority: 'p0',
      queueWaitMs: 7,
      executionMs: 13,
      outcome: 'ok',
    });

    expect(recorder.seal().sql).toEqual([{
      processorKeyHash: expectedRuntimeHash(processorKey),
      priority: 'p0',
      queueWaitMs: 7,
      executionMs: 13,
      outcome: 'ok',
    }]);
    expect(JSON.stringify(recorder.seal())).not.toContain('trace-a');
    expect(JSON.stringify(recorder.seal())).not.toContain('lease-a');
  });

  it('rejects over-cap hash inputs instead of truncating into collisions', () => {
    const recorder = createRuntimePerformanceRecorder({
      now: () => 0,
      maxHashInputBytes: 8,
    });

    expect(() => recorder.recordTool({
      toolCallId: 'abcdefgh-collision-a',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(() => recorder.recordTool({
      toolCallId: 'abcdefgh-collision-b',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 1,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(() => recorder.recordSql({
      processorKey: 'abcdefgh:lease:collision-a',
      priority: 'p1',
      queueWaitMs: 1,
      executionMs: 2,
      outcome: 'ok',
    })).toThrow('runtime_performance_hash_input_too_large');
    expect(recorder.seal().tools).toEqual([]);
    expect(recorder.seal().sql).toEqual([]);
  });

  it('hard-caps phase, tool, sql arrays and records dropped counts', () => {
    let now = 0;
    const recorder = createRuntimePerformanceRecorder({
      now: () => now,
      maxPhases: 1,
      maxTools: 1,
      maxSql: 1,
      maxHashInputBytes: 64,
    });

    const first = recorder.startPhase('classification');
    now = 1;
    first.end();
    const droppedPhase = recorder.startPhase('provider');
    now = 2;
    droppedPhase.end();
    recorder.recordTool({
      toolCallId: 'tool-call-id-one',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 3,
      outcome: 'ok',
    });
    recorder.recordTool({
      toolCallId: 'tool-call-id-two',
      mode: 'exclusive',
      schedulerWaitMs: 0,
      durationMs: 4,
      outcome: 'error',
    });
    recorder.recordSql({
      processorKey: 'trace-a',
      priority: 'p1',
      queueWaitMs: 5,
      executionMs: 6,
      outcome: 'ok',
    });
    recorder.recordSql({
      processorKey: 'trace-b',
      priority: 'p2',
      queueWaitMs: 7,
      executionMs: 8,
      outcome: 'error',
    });

    const receipt = recorder.seal();

    expect(receipt.phases).toHaveLength(1);
    expect(receipt.tools).toHaveLength(1);
    expect(receipt.sql).toHaveLength(1);
    expect(receipt.truncated).toEqual({
      phases: 1,
      tools: 1,
      sql: 1,
    });
    expect(receipt.tools[0].toolCallIdHash).toMatch(/^sha256:/);
    expect(JSON.stringify(receipt)).not.toContain('tool-call-id-one');
  });

  it('rejects late writes after seal', () => {
    const recorder = createRuntimePerformanceRecorder({now: () => 0});
    const phase = recorder.startPhase('classification');
    phase.end();
    recorder.seal();

    expect(() => recorder.startPhase('provider')).toThrow(
      'runtime_performance_already_sealed:start_phase',
    );
    expect(() => recorder.recordFirstOutput()).toThrow(
      'runtime_performance_already_sealed:record_first_output',
    );
  });

  it('records the runtime five-phase spine without public output content', () => {
    let now = 10;
    const recorder = createRuntimePerformanceRecorder({now: () => now});
    const run = createRuntimePerformanceRun({runtimePerformanceRecorder: recorder});

    now = 20;
    run.finishClassification();
    now = 30;
    const quickEvidence = run.startPhase('quick_evidence');
    now = 40;
    quickEvidence.end();
    now = 50;
    const provider = run.startPhase('provider');
    now = 65;
    run.recordFirstOutput();
    now = 80;
    provider.end();
    now = 90;
    const verification = run.startPhase('verification');
    now = 95;
    verification.end();
    now = 100;
    run.finalize('ok');

    const receipt = recorder.seal();

    expect(receipt.firstOutputMs).toBe(55);
    expect(receipt.phases.map(phase => phase.name)).toEqual([
      'classification',
      'quick_evidence',
      'provider',
      'verification',
    ]);
    expect(JSON.stringify(receipt)).not.toContain('SELECT');
  });
});
