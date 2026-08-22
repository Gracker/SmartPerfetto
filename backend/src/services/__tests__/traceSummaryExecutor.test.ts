// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import {resolveTraceCase} from '../../utils/traceCorpus';
import {
  executeTraceSummaryV1,
  parseTraceSummaryTextV1,
  type TraceSummaryCommandRunner,
} from '../traceSummaryExecutor';
import {getCoreTraceSummarySpecV1} from '../traceSummarySpecRegistry';
import {getTraceProcessorPath} from '../workingTraceProcessor';

const VALID_TEXT = `metric_bundles {
  bundle_id: "ignored-debug-id"
  specs { id: "smartperfetto_frame_timeline_total_count" unit: COUNT polarity: NOT_APPLICABLE }
  specs { id: "smartperfetto_frame_timeline_jank_count" unit: COUNT polarity: LOWER_IS_BETTER }
  row { values { double_value: 697.000000 } values { double_value: 21.000000 } }
}
metric_bundles {
  bundle_id: "also-ignored"
  specs { id: "smartperfetto_trace_duration_ns" unit: TIME_NANOS polarity: NOT_APPLICABLE }
  row { values { double_value: 7815672705.000000 } }
}`;

describe('traceSummaryExecutor parser', () => {
  it('maps ordered specs[index] to row.values[index] without using bundle_id', () => {
    expect(parseTraceSummaryTextV1(VALID_TEXT, getCoreTraceSummarySpecV1()).metrics).toEqual([
      expect.objectContaining({id: 'smartperfetto_trace_duration_ns', status: 'available', value: 7815672705}),
      expect.objectContaining({id: 'smartperfetto_frame_timeline_total_count', status: 'available', value: 697}),
      expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', status: 'available', value: 21}),
    ]);
  });

  it('marks a declared unique bundle with no row as missing, never zero', () => {
    const text = VALID_TEXT.replace(
      '  row { values { double_value: 697.000000 } values { double_value: 21.000000 } }\n',
      '',
    );
    expect(parseTraceSummaryTextV1(text, getCoreTraceSummarySpecV1()).metrics).toEqual([
      expect.objectContaining({id: 'smartperfetto_trace_duration_ns', status: 'available'}),
      expect.objectContaining({id: 'smartperfetto_frame_timeline_total_count', status: 'missing', missingReason: 'no_rows'}),
      expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', status: 'missing', missingReason: 'no_rows'}),
    ]);
  });

  it.each([
    ['unknown id', VALID_TEXT.replace('smartperfetto_trace_duration_ns', 'unknown_metric')],
    ['duplicate id', VALID_TEXT.replace('smartperfetto_frame_timeline_jank_count', 'smartperfetto_frame_timeline_total_count')],
    ['missing value', VALID_TEXT.replace(' values { double_value: 21.000000 }', '')],
    ['extra value', VALID_TEXT.replace('double_value: 21.000000 }', 'double_value: 21.000000 } values { double_value: 1 }')],
    ['non-finite value', VALID_TEXT.replace('double_value: 21.000000', 'double_value: nan')],
    ['multiple unique rows', VALID_TEXT.replace(
      'row { values { double_value: 7815672705.000000 } }',
      'row { values { double_value: 7815672705.000000 } } row { values { double_value: 1 } }',
    )],
    ['unit mismatch', VALID_TEXT.replace('unit: TIME_NANOS', 'unit: COUNT')],
    ['polarity mismatch', VALID_TEXT.replace('polarity: LOWER_IS_BETTER', 'polarity: NOT_APPLICABLE')],
  ])('fails closed on %s', (_name, text) => {
    expect(() => parseTraceSummaryTextV1(text, getCoreTraceSummarySpecV1())).toThrow(/trace_summary_/);
  });
});

describe('traceSummaryExecutor command', () => {
  let directory: string;
  let tracePath: string;
  let binaryPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-summary-test-'));
    tracePath = path.join(directory, 'trace.pftrace');
    binaryPath = path.join(directory, process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell');
    fs.writeFileSync(tracePath, 'trace');
    fs.writeFileSync(binaryPath, 'binary');
  });

  afterEach(() => {
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('uses exact argv, keeps paths out of the attestation, and removes its temp spec', async () => {
    let observedSpecPath = '';
    const runner: TraceSummaryCommandRunner = async input => {
      expect(input.args.slice(0, 5)).toEqual([
        'summarize', '--format', 'text', '--metrics-v2',
        'smartperfetto_trace_duration_ns,smartperfetto_frame_timeline_total_count,smartperfetto_frame_timeline_jank_count',
      ]);
      expect(input.args[5]).toBe(tracePath);
      observedSpecPath = input.args[6];
      expect(fs.readFileSync(observedSpecPath, 'utf8')).toContain('metric_template_spec');
      return {exitCode: 0, stdout: VALID_TEXT, stderr: ''};
    };

    const result = await executeTraceSummaryV1({tracePath, traceSide: 'current'}, {
      binaryPath, commandRunner: runner,
    });

    expect(result.status).toBe('ready');
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(observedSpecPath).not.toBe('');
    expect(fs.existsSync(observedSpecPath)).toBe(false);
    if (result.status === 'ready') {
      expect(result.spec.digestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.resultDigestSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.trace.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.traceProcessor).toEqual(expect.objectContaining({source: 'custom'}));
    }
  });

  it.each([
    ['timeout', {exitCode: null, stdout: '', stderr: '', timedOut: true}, 'timeout'],
    ['stdout limit', {exitCode: null, stdout: '', stderr: '', outputLimitExceeded: 'stdout' as const}, 'output_limit'],
    ['stderr limit', {exitCode: null, stdout: '', stderr: '', outputLimitExceeded: 'stderr' as const}, 'output_limit'],
    ['nonzero', {exitCode: 2, stdout: '', stderr: 'private path must not escape'}, 'process_failed'],
    ['invalid output', {exitCode: 0, stdout: 'garbage', stderr: ''}, 'invalid_output'],
  ])('returns a path-free error for %s', async (_name, command, reason) => {
    const result = await executeTraceSummaryV1({tracePath, traceSide: 'current'}, {
      binaryPath, commandRunner: async () => command,
    });
    expect(result).toEqual(expect.objectContaining({status: 'error', reason}));
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain('private path');
  });

  it('returns a structured path-free error when exact temp cleanup fails', async () => {
    let failedRoot = '';
    try {
      const result = await executeTraceSummaryV1({tracePath, traceSide: 'current'}, {
        binaryPath,
        commandRunner: async () => ({exitCode: 0, stdout: VALID_TEXT, stderr: ''}),
        removeTemporaryRoot: async root => {
          failedRoot = root;
          throw new Error(`must not escape ${root}`);
        },
      });
      expect(result).toEqual(expect.objectContaining({
        status: 'error', reason: 'temp_cleanup_failed',
      }));
      expect(JSON.stringify(result)).not.toContain(directory);
      expect(JSON.stringify(result)).not.toContain('must not escape');
    } finally {
      if (failedRoot) fs.rmSync(failedRoot, {recursive: true, force: true});
    }
  });
});

describe('traceSummaryExecutor real traces', () => {
  it('is deterministic on the customer trace and keeps absent FrameTimeline metrics missing', async () => {
    const tracePath = resolveTraceCase('android-scroll-customer');
    const first = await executeTraceSummaryV1({tracePath, traceSide: 'current'});
    const second = await executeTraceSummaryV1({tracePath, traceSide: 'current'});

    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (first.status === 'ready' && second.status === 'ready') {
      expect(first.spec.digestSha256).toBe(second.spec.digestSha256);
      expect(first.resultDigestSha256).toBe(second.resultDigestSha256);
      expect(first.trace.fingerprintSha256).toBe(second.trace.fingerprintSha256);
      expect(first.traceProcessor).toEqual(second.traceProcessor);
      expect(first.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({id: 'smartperfetto_frame_timeline_total_count', status: 'available', value: 697}),
        expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', status: 'available', value: 21}),
      ]));
    }

    const absent = await executeTraceSummaryV1({
      tracePath: path.resolve(process.cwd(), '../Trace/constructed/input-interaction-latency/trace.overlay.pftrace'),
      traceSide: 'current',
    }, {binaryPath: getTraceProcessorPath()});
    expect(absent.status).toBe('ready');
    if (absent.status === 'ready') {
      expect(absent.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({id: 'smartperfetto_frame_timeline_total_count', status: 'missing', missingReason: 'no_rows'}),
        expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', status: 'missing', missingReason: 'no_rows'}),
      ]));
      expect(absent.metrics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({id: 'smartperfetto_frame_timeline_jank_count', value: 0}),
      ]));
    }
  }, 240_000);
});
