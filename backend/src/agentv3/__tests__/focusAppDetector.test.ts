// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import {
  detectFocusApps,
  focusAppTimeRangeFromSelection,
  rankFocusAppCandidates,
  type FocusAppProcessActivity,
} from '../focusAppDetector';
import type { TraceProcessorService } from '../../services/traceProcessorService';

const ACTIVITY_COLUMNS = [
  'upid', 'pid', 'package_name', 'process_name', 'app_id', 'foreground_ns', 'foreground_count',
  'foreground_like_ns', 'max_score', 'frame_count', 'running_ns', 'main_running_ns', 'slice_count',
];

type ProcessFixture = Partial<FocusAppProcessActivity> & {upid: number; packageName: string};

function proc(fixture: ProcessFixture): FocusAppProcessActivity {
  return {
    appId: 10100,
    foregroundNs: 0,
    foregroundCount: 0,
    foregroundLikeNs: fixture.foregroundNs ?? 0,
    frameCount: 0,
    runningNs: 0,
    mainThreadRunningNs: 0,
    threadSliceCount: 0,
    ...fixture,
  };
}

function activityRow(process: FocusAppProcessActivity): unknown[] {
  return [
    process.upid, process.pid ?? null, process.packageName, process.processName ?? process.packageName,
    process.appId ?? null, process.foregroundNs, process.foregroundCount, process.foregroundLikeNs,
    process.maxOomScore ?? null, process.frameCount, process.runningNs, process.mainThreadRunningNs,
    process.threadSliceCount,
  ];
}

interface ServiceFixture {
  processes?: ProcessFixture[];
  battery?: Array<[string, number, number]>;
  startups?: Array<[string, number]>;
  activityError?: string;
  batteryError?: string;
}

function mockTraceProcessor(fixture: ServiceFixture): TraceProcessorService {
  const query = jest.fn(async (_traceId: string, sql: string) => {
    if (sql.includes('android_oom_adj_intervals')) {
      if (fixture.activityError) return {columns: [], rows: [], error: fixture.activityError};
      return {columns: ACTIVITY_COLUMNS, rows: (fixture.processes ?? []).map(p => activityRow(proc(p)))};
    }
    if (sql.includes('battery_stats.top')) {
      if (fixture.batteryError) return {columns: [], rows: [], error: fixture.batteryError};
      return {columns: ['package_name', 'total_duration_ns', 'switch_count'], rows: fixture.battery ?? []};
    }
    if (sql.includes('android_startups')) {
      return {columns: ['package_name', 'launch_count'], rows: fixture.startups ?? []};
    }
    return {columns: [], rows: []};
  });
  return { query } as unknown as TraceProcessorService;
}

function sqlCalls(service: TraceProcessorService): string[] {
  return (service.query as jest.Mock).mock.calls.map(call => String(call[1]));
}

describe('detectFocusApps', () => {
  it('requires complete selection bounds before deriving a focus app time range', () => {
    expect(focusAppTimeRangeFromSelection({
      kind: 'area',
      endNs: 2_000_000_000,
    })).toBeUndefined();
    expect(focusAppTimeRangeFromSelection({
      kind: 'area',
      startNs: 1_000_000_000,
      endNs: 2_000_000_000,
    })).toEqual({ startNs: 1_000_000_000, endNs: 2_000_000_000 });
  });

  // device_lock_contention: media.module (-700, two Android users, no thread
  // activity) out-summed the real foreground app under the old ladder.
  it('never sums a package across users and reports foreground-like processes without activity', async () => {
    const service = mockTraceProcessor({processes: [
      {upid: 599, packageName: 'com.android.media.module', foregroundNs: 0, foregroundLikeNs: 11_800_000_000,
        maxOomScore: -700, appId: 10200},
      {upid: 619, packageName: 'com.android.media.module', foregroundNs: 0, foregroundLikeNs: 11_800_000_000,
        maxOomScore: -700, appId: 10200},
      {upid: 13, packageName: 'com.tracedemo.stress', foregroundNs: 11_814_451_991, foregroundCount: 3,
        maxOomScore: 0, runningNs: 180_000_000, mainThreadRunningNs: 151_000_000, threadSliceCount: 165},
    ]});

    const result = await detectFocusApps(service, 'trace-lock');

    expect(result.primaryApp).toBe('com.tracedemo.stress');
    expect(result.confidence).toBe('high');
    expect(result.method).toBe('oom_adj');
    expect(result.apps.map(app => app.packageName)).toEqual(['com.tracedemo.stress']);
    expect(result.apps[0]).toMatchObject({upid: 13, totalDurationNs: 11_814_451_991, switchCount: 3,
      signals: {foregroundNs: 11_814_451_991, runningNs: 180_000_000, threadSliceCount: 165}});
    expect(result.excludedNoActivity?.map(entry => [entry.packageName, entry.upid, entry.reason]))
      .toEqual([['com.android.media.module', 599, 'no_activity'], ['com.android.media.module', 619, 'no_activity']]);
  });

  it('excludes vendor, provider, path and isolated processes before ranking (no reverse-alpha tie win)', () => {
    const tied = {foregroundNs: 5_000_000_000, maxOomScore: 0, runningNs: 10_000_000, threadSliceCount: 5};
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'vendor.qti.hardware.cacert.server', ...tied, appId: 2918}),
      proc({upid: 2, packageName: 'com.google.android.providers.media.module', ...tied}),
      proc({upid: 3, packageName: '/vendor/bin/hw/android.hardware.sensors', ...tied}),
      proc({upid: 4, packageName: 'com.android.chrome', processName: 'com.android.chrome:sandboxed_process0',
        ...tied, runningNs: 900_000_000, appId: 99001}),
      proc({upid: 5, packageName: 'com.tracedemo.stress', ...tied, runningNs: 200_000_000, threadSliceCount: 208}),
    ]});

    expect(result.primaryApp).toBe('com.tracedemo.stress');
    expect(result.apps.map(app => app.packageName)).toEqual(['com.tracedemo.stress']);
  });

  // WeChat Moments trace: zygote and vendor.qti.qesdk.sysservice outranked
  // com.tencent.mm (781 frames) under the old ladder.
  it('finds the rendering app on a trace without package metadata and folds :subprocesses into it', () => {
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'zygote64', foregroundNs: 9_000_000_000, maxOomScore: 0, runningNs: 1_000_000}),
      proc({upid: 2, packageName: 'sh', foregroundNs: 0, runningNs: 3_000_000, appId: 2000}),
      proc({upid: 3, packageName: 'vendor.qti.qesdk.sysservice', foregroundNs: 9_000_000_000, maxOomScore: -800,
        runningNs: 60_000_000, appId: 1000}),
      proc({upid: 4, packageName: 'com.tencent.mm', foregroundNs: 8_852_487_705, maxOomScore: 0, frameCount: 781,
        runningNs: 7_154_943_467, threadSliceCount: 77_673}),
      proc({upid: 5, packageName: 'com.tencent.mm', processName: 'com.tencent.mm:appbrand1',
        foregroundNs: 8_852_487_705, maxOomScore: 0, runningNs: 294_921_979, threadSliceCount: 171}),
    ]});

    expect(result.primaryApp).toBe('com.tencent.mm');
    expect(result.confidence).toBe('high');
    expect(result.method).toBe('frame_timeline');
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]).toMatchObject({upid: 4, switchCount: 781});
  });

  it('keeps a rendering app that sits behind more than ten foreground ties', () => {
    const ties = Array.from({length: 26}, (_, index) => proc({
      upid: 100 + index, packageName: `com.zz.tied${String(index).padStart(2, '0')}`,
      foregroundNs: 14_000_000_000, maxOomScore: 0, runningNs: 1_000_000, threadSliceCount: 2,
    }));
    const result = rankFocusAppCandidates({processes: [
      ...ties,
      proc({upid: 7, packageName: 'com.example.wechatfriendforvideo', foregroundNs: 14_000_000_000,
        maxOomScore: 0, frameCount: 153, runningNs: 1_346_781_766, threadSliceCount: 14_370}),
    ]});

    expect(result.primaryApp).toBe('com.example.wechatfriendforvideo');
    expect(result.confidence).toBe('high');
    expect(result.apps).toHaveLength(5);
  });

  it('penalises system uids and persistent-only processes without excluding them', () => {
    const competing = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'com.android.settings', appId: 1000, foregroundNs: 6_000_000_000,
        maxOomScore: 0, runningNs: 400_000_000, threadSliceCount: 900}),
      proc({upid: 2, packageName: 'com.example.app', foregroundNs: 5_000_000_000, maxOomScore: 0,
        runningNs: 300_000_000, threadSliceCount: 700}),
    ]});
    expect(competing.primaryApp).toBe('com.example.app');
    expect(competing.apps.find(app => app.packageName === 'com.android.settings')?.penalties).toEqual(['system_uid']);

    const lone = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'com.android.settings', appId: 1000, foregroundNs: 6_000_000_000,
        maxOomScore: 0, runningNs: 400_000_000, frameCount: 90, threadSliceCount: 900}),
      proc({upid: 2, packageName: 'com.android.nfc', appId: 1027, foregroundLikeNs: 6_000_000_000,
        maxOomScore: -800, runningNs: 1_000_000}),
    ]});
    expect(lone.primaryApp).toBe('com.android.settings');
    expect(lone.confidence).toBe('high');
  });

  it('leaves the primary unset when two apps cannot be separated', () => {
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'com.example.a', foregroundNs: 5_000_000_000, maxOomScore: 0,
        runningNs: 300_000_000, threadSliceCount: 100}),
      proc({upid: 2, packageName: 'com.example.b', foregroundNs: 4_800_000_000, maxOomScore: 0,
        runningNs: 290_000_000, threadSliceCount: 100}),
    ]});

    expect(result.confidence).toBe('ambiguous');
    expect(result.primaryApp).toBeUndefined();
    expect(result.apps.map(app => app.packageName)).toEqual(['com.example.a', 'com.example.b']);
  });

  // rooted_doze_sequence: a home overlay held oom score 0 for the whole trace
  // with a few milliseconds of CPU; a foreground-only guess is not a target.
  it('does not trust a foreground-only process without substantive activity', () => {
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'obric.home.flow', foregroundNs: 59_855_876_539, maxOomScore: 0,
        runningNs: 5_409_634, threadSliceCount: 6}),
      proc({upid: 2, packageName: 'com.obric.aikernel', foregroundNs: 13_304_948, maxOomScore: 0,
        runningNs: 230_849_787, threadSliceCount: 13}),
    ]});

    expect(result.apps[0].packageName).toBe('obric.home.flow');
    expect(result.confidence).toBe('ambiguous');
    expect(result.primaryApp).toBeUndefined();
  });

  it('does not let a penalised CPU-heavy service set the activity scale', () => {
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: 'com.example.renderstress', foregroundNs: 17_925_501_660, maxOomScore: 0,
        runningNs: 57_804_007, threadSliceCount: 698}),
      proc({upid: 2, packageName: 'com.bytedance.os.mermaid', appId: 1000, foregroundLikeNs: 1_000_000_000,
        maxOomScore: -800, runningNs: 1_015_504_901, threadSliceCount: 52}),
    ]});

    expect(result.primaryApp).toBe('com.example.renderstress');
    expect(result.confidence).toBe('high');
  });

  it('falls back to CPU activity of app uids when no focus signal exists, capped at medium', () => {
    const result = rankFocusAppCandidates({processes: [
      proc({upid: 1, packageName: '/system/bin/traced_probes', appId: 9999, runningNs: 5_000_000_000}),
      proc({upid: 2, packageName: 'system_server', appId: 1000, runningNs: 3_000_000_000}),
      proc({upid: 3, packageName: 'com.tencent.mm', runningNs: 2_411_938_838, mainThreadRunningNs: 169_912_330,
        threadSliceCount: 17_058}),
      proc({upid: 4, packageName: 'com.xingin.xhs', runningNs: 350_826_151, threadSliceCount: 666}),
    ]});

    expect(result.primaryApp).toBe('com.tencent.mm');
    expect(result.method).toBe('sched_activity');
    expect(result.confidence).toBe('medium');
    expect(result.apps[0]).toMatchObject({totalDurationNs: 2_411_938_838});
  });

  // Late start: the launcher owns most top/foreground/frames in a window that
  // ends with the app's launch; the launch is the user's action on the app.
  it('lets an activity launch in the window outrank an app that owns the rest of the window', () => {
    const result = rankFocusAppCandidates({
      processes: [
        proc({upid: 1, packageName: 'com.oem.home', foregroundNs: 7_000_000_000, maxOomScore: 0,
          frameCount: 300, runningNs: 400_000_000, threadSliceCount: 10_000}),
        proc({upid: 2, packageName: 'com.tracedemo.stress', foregroundNs: 100_000_000, maxOomScore: 0,
          frameCount: 3, runningNs: 150_000_000, threadSliceCount: 900}),
      ],
      batteryTop: new Map([['com.oem.home', {durationNs: 7_000_000_000, count: 1}],
        ['com.tracedemo.stress', {durationNs: 100_000_000, count: 1}]]),
      launches: new Map([['com.tracedemo.stress', 1]]),
    });

    expect(result.primaryApp).toBe('com.tracedemo.stress');
    expect(result.apps[0].signals?.launchCount).toBe(1);
  });

  it('uses battery_stats.top when present and reports it as the method', async () => {
    const service = mockTraceProcessor({
      processes: [
        {upid: 1, packageName: 'com.example.app', foregroundNs: 12_000_000_000, maxOomScore: 0,
          runningNs: 2_000_000_000, frameCount: 700, threadSliceCount: 50_000},
        {upid: 2, packageName: 'com.android.launcher3', foregroundNs: 7_000_000_000, maxOomScore: 0,
          runningNs: 400_000_000, frameCount: 300, threadSliceCount: 10_000},
      ],
      battery: [['com.example.app', 12_600_000_000, 1], ['com.android.launcher3', 7_300_000_000, 1]],
    });

    const result = await detectFocusApps(service, 'trace-battery');

    expect(result.primaryApp).toBe('com.example.app');
    expect(result.method).toBe('battery_stats');
    expect(result.apps.map(app => app.packageName)).toEqual(['com.example.app']);
    expect(result.apps[0]).toMatchObject({totalDurationNs: 12_600_000_000, switchCount: 1});
  });

  it('scopes every query to the selected time range', async () => {
    const service = mockTraceProcessor({processes: [
      {upid: 1, packageName: 'com.example.app', foregroundNs: 800_000_000, maxOomScore: 0,
        runningNs: 50_000_000, threadSliceCount: 30},
    ]});

    const result = await detectFocusApps(service, 'trace-scoped', {
      timeRange: { startNs: 1_000_000_000, endNs: 2_000_000_000 },
    });
    const [activitySql, batterySql, startupSql] = sqlCalls(service);

    expect(result.timeRange).toEqual({ startNs: 1_000_000_000, endNs: 2_000_000_000 });
    expect(result.apps[0]).toMatchObject({scopeStartNs: 1_000_000_000, scopeEndNs: 2_000_000_000});
    expect(activitySql).toContain('MAX(0, MIN((oa.ts) + (oa.dur), 2000000000) - MAX((oa.ts), 1000000000))');
    expect(activitySql).toContain('MAX(0, MIN((s.ts) + (s.dur), 2000000000) - MAX((s.ts), 1000000000))');
    expect(activitySql).toContain('(a.ts) <= 2000000000');
    expect(activitySql).toContain('(sl.ts) <= 2000000000');
    expect(batterySql).toContain('SUM(MAX(0, MIN((ts) + (safe_dur), 2000000000) - MAX((ts), 1000000000)))');
    expect(startupSql).toContain('(ts) <= 2000000000');
    // The ordinary stdlib INCLUDE is part of the contract: it taints native
    // raw-SQL provenance (rawSqlCapture.real.test.ts).
    expect(activitySql).toContain('INCLUDE PERFETTO MODULE android.oom_adjuster');
    expect(activitySql).toContain('INCLUDE PERFETTO MODULE android.process_metadata');
  });

  it('keeps ranking when an enrichment query fails', async () => {
    const service = mockTraceProcessor({
      processes: [{upid: 1, packageName: 'com.example.app', foregroundNs: 5_000_000_000, maxOomScore: 0,
        runningNs: 100_000_000, threadSliceCount: 10}],
      batteryError: 'no such table: android_battery_stats_event_slices',
    });

    const result = await detectFocusApps(service, 'trace-enrich');

    expect(result.primaryApp).toBe('com.example.app');
    expect(result.method).toBe('oom_adj');
  });

  // Bounded turns run this preflight too, so a second question about the same
  // trace must not repeat the queries. The scope is part of the key: a
  // different selected range is a different answer.
  it('reuses a detected focus app per trace and scope without re-querying', async () => {
    const fixture: ServiceFixture = {processes: [{upid: 1, packageName: 'com.example.app',
      foregroundNs: 4_000_000_000, maxOomScore: 0, runningNs: 10_000_000, threadSliceCount: 3}]};
    const service = mockTraceProcessor(fixture);
    const queryMock = service.query as jest.Mock;

    expect((await detectFocusApps(service, 'trace-1')).primaryApp).toBe('com.example.app');
    const perDetection = queryMock.mock.calls.length;
    expect((await detectFocusApps(service, 'trace-1')).primaryApp).toBe('com.example.app');
    expect(queryMock).toHaveBeenCalledTimes(perDetection);

    await detectFocusApps(service, 'trace-1', { timeRange: { startNs: 1, endNs: 2 } });
    expect(queryMock).toHaveBeenCalledTimes(perDetection * 2);
    await detectFocusApps(service, 'trace-2');
    expect(queryMock).toHaveBeenCalledTimes(perDetection * 3);
    await detectFocusApps(service, 'trace-1', { timeRange: { startNs: 1, endNs: 2 } });
    expect(queryMock).toHaveBeenCalledTimes(perDetection * 3);

    // A different processor service is a different trace world.
    const other = mockTraceProcessor({processes: [{upid: 1, packageName: 'com.other.app',
      foregroundNs: 4_000_000_000, maxOomScore: 0, runningNs: 10_000_000, threadSliceCount: 3}]});
    expect((await detectFocusApps(other, 'trace-1')).primaryApp).toBe('com.other.app');
  });

  // `none` cannot tell an empty trace from a transient failure, so caching it
  // would pin that failure to the trace for the life of the process. A failed
  // query is reported through `error`, not an exception, and must not read as
  // an empty trace either.
  it('does not cache a failed or empty detection', async () => {
    const fixture: ServiceFixture = {activityError: 'transient worker failure'};
    const service = mockTraceProcessor(fixture);

    expect((await detectFocusApps(service, 'trace-none')).method).toBe('none');
    fixture.activityError = undefined;
    fixture.processes = [{upid: 1, packageName: 'com.example.app', foregroundNs: 4_000_000_000,
      maxOomScore: 0, runningNs: 10_000_000, threadSliceCount: 3}];
    expect((await detectFocusApps(service, 'trace-none')).primaryApp).toBe('com.example.app');
  });
});
