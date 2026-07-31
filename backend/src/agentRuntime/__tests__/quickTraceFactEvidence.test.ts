// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { describe, expect, it, jest } from '@jest/globals';

import {
  buildQuickTraceFactEvidence,
  joinRuntimeEvidenceContexts,
  shouldBuildScopedQuickTraceFactEvidence,
  shouldBuildQuickTraceFactEvidence,
  shouldSkipFocusDetectionForQuickTraceFactEvidence,
  shouldUseTraceFactEvidenceOnlyQuickAnalysis,
  type QuickTraceFactEvidenceInput,
} from '../quickTraceFactEvidence';
import { buildQuickTraceFactDirectAnswer } from '../quickTraceFactDirectAnswer';
import { requestedLongestProcessSliceRows } from '../../agentv3/longestProcessSlicesIntent';
import type { DataEnvelope } from '../../types/dataContract';
import { runClaimVerification } from '../../services/verifier/claimVerificationRunner';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { resolveTraceCase } from '../../utils/traceCorpus';

type QueryTrace = QuickTraceFactEvidenceInput['traceProcessor']['query'];

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '../../../..');
const launchLightTracePath = resolveTraceCase('launch_light.pftrace', repoRoot);
const traceProcessorPath = getTraceProcessorPath();
const itWithLaunchLightTraceProcessor = fs.existsSync(traceProcessorPath) && fs.existsSync(launchLightTracePath)
  ? it
  : it.skip;

function traceFactEnvelope(overrides?: {
  columns?: string[];
  rows?: unknown[][];
  evidenceKind?: 'frame_metrics' | 'selection_duration' | 'trace_frame_count' | 'jank_presence' | 'jank_frame_count' | 'trace_jank_presence' | 'frame_timeline_presence' | 'refresh_rate' | 'trace_duration' | 'trace_health_issues' | 'trace_data_inventory' | 'cpu_core_count' | 'cpu_frequency_presence' | 'power_counter_presence' | 'memory_counter_presence' | 'scheduler_data_presence' | 'gpu_data_presence' | 'slice_data_presence' | 'network_packet_presence' | 'logcat_presence' | 'thread_count' | 'app_thread_count' | 'process_count' | 'app_process_count' | 'binder_transaction_count' | 'anr_presence' | 'startup_presence' | 'scroll_gesture_count' | 'input_event_count' | 'device_info';
  traceId?: string;
}): DataEnvelope {
  return {
    meta: {
      type: 'sql_result',
      version: '2.0.0',
      source: `runtime_trace_fact:${overrides?.evidenceKind ?? 'frame_metrics'}`,
      timestamp: 1,
      evidenceRefId: `data:runtime_trace_fact:${overrides?.evidenceKind ?? 'frame_metrics'}:current:abc`,
      sourceToolCallId: `runtime-trace-fact:${overrides?.evidenceKind ?? 'frame_metrics'}:abc`,
      traceId: overrides?.traceId,
    },
    data: {
      columns: overrides?.columns ?? (
        overrides?.evidenceKind === 'cpu_core_count'
          ? ['observed_cpu_count', 'observed_cpus', 'universe_source', 'source_table']
          : overrides?.evidenceKind === 'cpu_frequency_presence'
            ? ['cpufreq_cpu_count', 'cpufreq_sample_count', 'cpufreq_cpus', 'min_freq_khz', 'max_freq_khz', 'first_sample_ts', 'last_sample_ts', 'source_table']
          : overrides?.evidenceKind === 'power_counter_presence'
            ? ['power_counter_track_count', 'power_counter_sample_count', 'power_counter_names', 'power_counter_sample_counts', 'source_table']
          : overrides?.evidenceKind === 'memory_counter_presence'
            ? ['memory_counter_track_count', 'memory_counter_sample_count', 'memory_counter_names', 'memory_counter_sample_counts', 'memory_counter_max_values', 'source_table']
          : overrides?.evidenceKind === 'scheduler_data_presence'
            ? [
              'sched_slice_count',
              'thread_state_count',
              'running_state_count',
              'runnable_state_count',
              'preempted_runnable_state_count',
              'sleeping_state_count',
              'uninterruptible_sleep_state_count',
              'idle_state_count',
              'source_table',
            ]
          : overrides?.evidenceKind === 'gpu_data_presence'
            ? ['gpu_slice_count', 'gpu_counter_track_count', 'gpu_counter_sample_count', 'gpu_counter_names', 'gpu_slice_names', 'source_table']
          : overrides?.evidenceKind === 'slice_data_presence'
            ? ['slice_count', 'track_count', 'process_track_count', 'thread_track_count', 'source_table']
          : overrides?.evidenceKind === 'network_packet_presence'
            ? ['network_packet_event_count', 'network_packet_count', 'network_packet_bytes', 'network_iface_count', 'network_transport_count', 'network_ifaces', 'network_iface_packet_counts', 'network_transports', 'network_transport_packet_counts', 'source_table']
          : overrides?.evidenceKind === 'logcat_presence'
            ? ['logcat_event_count', 'warn_log_count', 'error_log_count', 'fatal_log_count', 'distinct_tag_count', 'sample_tags', 'sample_tag_counts', 'first_log_ts', 'last_log_ts', 'source_table']
          : overrides?.evidenceKind === 'trace_data_inventory'
            ? ['trace_start_ns', 'trace_end_ns', 'duration_s', 'slice_count', 'track_count', 'process_track_count', 'thread_track_count', 'process_count', 'thread_count', 'sched_slice_count', 'thread_state_count', 'counter_track_count', 'process_counter_track_count', 'cpu_counter_track_count', 'gpu_counter_track_count', 'counter_sample_count', 'cpufreq_sample_count', 'actual_frame_timeline_slice_count', 'expected_frame_timeline_slice_count', 'gpu_slice_count', 'gpu_counter_sample_count', 'network_packet_event_count', 'android_log_count', 'source_table']
          : overrides?.evidenceKind === 'frame_timeline_presence'
            ? ['actual_frame_timeline_slice_count', 'expected_frame_timeline_slice_count', 'janky_actual_frame_count', 'actual_frame_upid_count', 'source_table']
          : overrides?.evidenceKind === 'refresh_rate'
            ? ['refresh_rate_hz', 'vsync_period_ns', 'vsync_period_ms', 'detection_method', 'sample_count', 'raw_median_period_ns', 'source_table']
          : overrides?.evidenceKind === 'trace_health_issues'
            ? ['issue_stat_count', 'error_stat_count', 'data_loss_stat_count', 'total_issue_value', 'issue_names', 'issue_values', 'issue_severities', 'source_table']
          : overrides?.evidenceKind === 'trace_jank_presence'
            ? [
              'scope',
              'total_frames',
              'jank_frames',
              'jank_rate_pct',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'jank_types',
              'source_table',
            ]
          : overrides?.evidenceKind === 'trace_frame_count'
            ? [
              'scope',
              'total_frames',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'source_table',
            ]
          : overrides?.evidenceKind === 'jank_presence' || overrides?.evidenceKind === 'jank_frame_count'
            ? [
              'package_name',
              'process_names',
              'total_frames',
              'jank_frames',
              'jank_rate_pct',
              'window_start_ns',
              'window_end_ns',
              'duration_s',
              'fps',
              'jank_types',
              'source_table',
            ]
          : overrides?.evidenceKind === 'thread_count'
            ? ['thread_count', 'process_count', 'sample_thread_names', 'source_table']
          : overrides?.evidenceKind === 'app_thread_count' || overrides?.evidenceKind === 'app_process_count'
            ? ['package_name', 'process_count', 'thread_count', 'process_names', 'process_thread_counts', 'source_table']
          : overrides?.evidenceKind === 'process_count'
            ? ['process_count', 'listed_process_count', 'process_names', 'process_thread_counts', 'omitted_process_count', 'source_table']
          : overrides?.evidenceKind === 'binder_transaction_count'
            ? ['binder_txn_count', 'sync_count', 'async_count', 'total_client_ms', 'max_client_ms', 'source_table']
          : overrides?.evidenceKind === 'anr_presence'
            ? ['total_anr_count', 'affected_process_count', 'first_anr_ts', 'last_anr_ts', 'anr_span_seconds', 'anr_types', 'source_table']
          : overrides?.evidenceKind === 'startup_presence'
            ? ['startup_count', 'packages', 'startup_types', 'first_startup_ts', 'last_startup_ts', 'total_startup_ms', 'max_startup_ms', 'source_table']
          : overrides?.evidenceKind === 'scroll_gesture_count'
            ? ['scroll_gesture_count', 'scroll_start_count', 'first_scroll_ts', 'last_scroll_ts', 'max_move_count', 'process_names', 'source_table', 'heuristic']
          : overrides?.evidenceKind === 'input_event_count'
            ? ['input_event_count', 'motion_event_count', 'key_event_count', 'process_count', 'first_input_ts', 'last_input_ts', 'process_names', 'source_table']
          : overrides?.evidenceKind === 'device_info'
            ? [
              'android_device_manufacturer',
              'android_build_fingerprint',
              'android_sdk_version',
              'android_soc_model',
              'system_name',
              'system_release',
              'system_machine',
              'source_table',
            ]
          : ['package_name', 'total_frames', 'duration_s', 'fps']
      ),
      rows: overrides?.rows ?? (
        overrides?.evidenceKind === 'cpu_core_count'
          ? [[7, '0, 1, 2, 3, 4, 5, 6', 'sched_observed', 'sched_slice/thread_state']]
          : overrides?.evidenceKind === 'cpu_frequency_presence'
            ? [[8, 848, '0, 1, 2, 3, 4, 5, 6, 7', 300000, 3187200, 1_000_000, 2_000_000, 'cpu_counter_track,counter']]
          : overrides?.evidenceKind === 'power_counter_presence'
            ? [[4, 728, 'PowerMode 4630946602912453524,PowerMode 4630946929504945811,BatteryChargeCounter,BatteryCurrent', '365,365,1,1', 'counter_track,counter']]
          : overrides?.evidenceKind === 'memory_counter_presence'
            ? [[5, 1411, 'HWUI All Memory,HWUI CPU Memory,HWUI Misc Memory,Purgeable HWUI Misc Memory,Bitmap Memory', '350,350,350,350,11', '17543280,12783428,14841544,11968316,77992790', 'process_counter_track,counter']]
          : overrides?.evidenceKind === 'scheduler_data_presence'
            ? [[66756, 129368, 44698, 41267, 2743, 71302, 1884, 24, 'sched_slice,thread_state']]
          : overrides?.evidenceKind === 'gpu_data_presence'
            ? [[0, 1, 12, 'gpufreq', '', 'gpu_slice,gpu_counter_track,counter']]
          : overrides?.evidenceKind === 'slice_data_presence'
            ? [[101278, 771, 65, 403, 'slice,track,process_track,thread_track']]
          : overrides?.evidenceKind === 'network_packet_presence'
            ? [[42, 840, 1_234_567, 2, 2, 'wlan0,rmnet_data0', '700,140', 'TCP,UDP', '780,60', 'android_network_packets']]
          : overrides?.evidenceKind === 'logcat_presence'
            ? [[123, 12, 3, 1, 8, 'ActivityManager,InputDispatcher,Choreographer', '70,33,20', 1_000_000, 2_000_000, 'android_logs']]
          : overrides?.evidenceKind === 'trace_data_inventory'
            ? [[100, 5_100_000_000, 5, 101_278, 771, 65, 403, 1031, 12_891, 66_756, 129_368, 303, 227, 70, 0, 90_275, 1255, 697, 697, 0, 0, 0, 123, 'trace_bounds,slice,track,process,thread,sched_slice,thread_state,counter_track,process_counter_track,cpu_counter_track,gpu_counter_track,counter,actual_frame_timeline_slice,expected_frame_timeline_slice,gpu_slice,android_network_packets,android_logs']]
          : overrides?.evidenceKind === 'frame_timeline_presence'
            ? [[697, 697, 21, 3, 'actual_frame_timeline_slice,expected_frame_timeline_slice']]
          : overrides?.evidenceKind === 'refresh_rate'
            ? [[120, 8_333_333, 8.333, 'vsync_sf', 240, 8_330_000, 'counter_track,counter']]
          : overrides?.evidenceKind === 'trace_health_issues'
            ? [[1, 1, 0, 7, 'trace_sorter_negative_timestamp_dropped', '7', 'error', 'stats']]
          : overrides?.evidenceKind === 'trace_jank_presence'
            ? [[
              'trace',
              697,
              21,
              3.01,
              10,
              4_449_374_956,
              4.449375,
              'App Deadline Missed,Buffer Stuffing',
              'actual_frame_timeline_slice',
            ]]
          : overrides?.evidenceKind === 'trace_frame_count'
            ? [['trace', 697, 10, 4_449_374_956, 4.449375, 'actual_frame_timeline_slice']]
          : overrides?.evidenceKind === 'jank_presence' || overrides?.evidenceKind === 'jank_frame_count'
            ? [[
              'com.example.app',
              'com.example.app',
              347,
              21,
              6.05,
              10,
              4_449_374_956,
              4.449375,
              77.99,
              'App Deadline Missed,Buffer Stuffing',
              'actual_frame_timeline_slice',
            ]]
          : overrides?.evidenceKind === 'thread_count'
            ? [[142, 12, 'main, RenderThread, Binder:123_1', 'thread']]
          : overrides?.evidenceKind === 'app_thread_count' || overrides?.evidenceKind === 'app_process_count'
            ? [['com.example.app', 2, 18, 'com.example.app,com.example.app:remote', '15,3', 'process,thread,android_process_metadata']]
          : overrides?.evidenceKind === 'process_count'
            ? [[12, 3, 'system_server,com.example.app,com.android.systemui', '45,12,9', 9, 'process,thread']]
          : overrides?.evidenceKind === 'binder_transaction_count'
            ? [[2930, 912, 2018, 2226.42, 176.38, 'android_binder_txns']]
          : overrides?.evidenceKind === 'anr_presence'
            ? [[1, 1, 1_000_000_000, 1_000_000_000, 0, 'INPUT_DISPATCHING_TIMEOUT', 'android_anrs']]
          : overrides?.evidenceKind === 'startup_presence'
            ? [[1, 'com.example.app', 'cold', 10, 10, 301.84, 301.84, 'android_startups']]
          : overrides?.evidenceKind === 'scroll_gesture_count'
            ? [[2, 2, 506_731_587_003_811, 506_734_643_167_039, 16, 'com.example.app', 'android_input_events', 'scene_reconstruction.user_gestures(move_count>=3)']]
          : overrides?.evidenceKind === 'input_event_count'
            ? [[140, 140, 0, 2, 506_731_587_003_811, 506_734_643_167_039, 'com.example.app,system_server', 'android_input_events']]
          : overrides?.evidenceKind === 'device_info'
            ? [[
              'OPPO',
              'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376:user/release-keys',
              36,
              'SM8750',
              'Linux',
              '6.6.89-android15',
              'aarch64',
              'metadata',
            ]]
          : [['com.example.app', 347, 4.449375, 77.99]]
      ),
    },
    display: {
      layer: 'list',
      format: 'table',
      title: overrides?.evidenceKind === 'trace_duration'
        ? 'Runtime trace duration pre-evidence'
        : overrides?.evidenceKind === 'trace_health_issues'
          ? 'Runtime trace health issue pre-evidence'
        : overrides?.evidenceKind === 'cpu_core_count'
          ? 'Runtime observed CPU core count pre-evidence'
        : overrides?.evidenceKind === 'cpu_frequency_presence'
          ? 'Runtime CPU frequency counter availability pre-evidence'
        : overrides?.evidenceKind === 'power_counter_presence'
          ? 'Runtime power and battery counter availability pre-evidence'
        : overrides?.evidenceKind === 'memory_counter_presence'
          ? 'Runtime memory counter availability pre-evidence'
        : overrides?.evidenceKind === 'scheduler_data_presence'
          ? 'Runtime scheduler and thread-state data availability pre-evidence'
        : overrides?.evidenceKind === 'gpu_data_presence'
          ? 'Runtime GPU slice and counter data availability pre-evidence'
        : overrides?.evidenceKind === 'slice_data_presence'
          ? 'Runtime generic slice and track data availability pre-evidence'
        : overrides?.evidenceKind === 'network_packet_presence'
          ? 'Runtime Android network packet data availability pre-evidence'
        : overrides?.evidenceKind === 'logcat_presence'
          ? 'Runtime Android Logcat data availability pre-evidence'
        : overrides?.evidenceKind === 'trace_data_inventory'
          ? 'Runtime common trace data inventory pre-evidence'
        : overrides?.evidenceKind === 'frame_timeline_presence'
          ? 'Runtime FrameTimeline data availability pre-evidence'
        : overrides?.evidenceKind === 'refresh_rate'
          ? 'Runtime observed VSync refresh rate pre-evidence'
        : overrides?.evidenceKind === 'jank_presence'
          ? 'Runtime FrameTimeline jank presence pre-evidence'
        : overrides?.evidenceKind === 'jank_frame_count'
          ? 'Runtime FrameTimeline janky frame count pre-evidence'
        : overrides?.evidenceKind === 'trace_jank_presence'
          ? 'Runtime trace-wide FrameTimeline jank pre-evidence'
        : overrides?.evidenceKind === 'trace_frame_count'
          ? 'Runtime trace-wide FrameTimeline frame count pre-evidence'
        : overrides?.evidenceKind === 'thread_count'
          ? 'Runtime observed thread count pre-evidence'
        : overrides?.evidenceKind === 'app_thread_count'
          ? 'Runtime focus app thread count pre-evidence'
        : overrides?.evidenceKind === 'process_count'
          ? 'Runtime observed process count pre-evidence'
        : overrides?.evidenceKind === 'app_process_count'
          ? 'Runtime focus app process count pre-evidence'
        : overrides?.evidenceKind === 'binder_transaction_count'
          ? 'Runtime Binder transaction count pre-evidence'
        : overrides?.evidenceKind === 'anr_presence'
          ? 'Runtime ANR presence pre-evidence'
        : overrides?.evidenceKind === 'startup_presence'
          ? 'Runtime app startup presence pre-evidence'
        : overrides?.evidenceKind === 'scroll_gesture_count'
          ? 'Runtime scroll gesture count pre-evidence'
        : overrides?.evidenceKind === 'input_event_count'
          ? 'Runtime input event count pre-evidence'
        : overrides?.evidenceKind === 'device_info'
          ? 'Runtime device and system metadata pre-evidence'
        : 'Runtime frame metrics pre-evidence',
    },
  };
}

describe('shouldBuildQuickTraceFactEvidence', () => {
  it('clamps requested longest-slice row counts to the quick-answer budget', () => {
    expect(requestedLongestProcessSliceRows('longest process slices')).toBe(5);
    expect(requestedLongestProcessSliceRows('top-0 longest process slices')).toBe(1);
    expect(requestedLongestProcessSliceRows('top 999 longest process slices')).toBe(20);
    expect(requestedLongestProcessSliceRows('前 12 个耗时最长的进程 slice')).toBe(12);
  });

  it('selects only bounded trace facts that have deterministic runtime evidence', () => {
    expect(shouldBuildQuickTraceFactEvidence('summarize top-5 longest process slices')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('top 5 long slices in current selection')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('列出前 5 个耗时最长的进程 slice')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('why are these long slices slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is the longest slice slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析最长 slice 的原因')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('滑动 FPS 是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('总帧数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 一共有多少帧？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('当前 trace 总帧数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many frames are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('total frame count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('frame count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace frame count and FPS?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 录制时长多长？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('采样了多久？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('采样了多长时间？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('录屏多久？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('录屏时长？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('录屏时间范围？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('采样长度？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这段性能数据多久？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how long is this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how long was this trace recorded?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('recording length?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('recording time?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('capture duration?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace time range?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace range?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace_bounds?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace bounds?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace_bounds 有吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace bounds table?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 的起止时间是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace 范围？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 什么时候开始？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace 开始？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('录制时间？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('采集范围？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('录制开始时间和结束时间是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what are the trace start and end timestamps?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有采集错误吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有解析错误？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('采集错误？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('解析错误？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace health?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('any trace health issues?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many trace errors?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 采集了哪些数据？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有哪些数据源？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有哪些数据源？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有哪些表？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('表有哪些？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('available data sources?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('available tables?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what data sources are available in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('slice_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('track_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('process_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('process_track_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_track_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('process names?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('show process names')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('list processes')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('进程名有哪些？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有哪些进程名？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter_sample_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('actual_frame_timeline_slice_count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter_track?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter tracks?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counters?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter table?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('counter samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有 FrameTimeline 数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 FrameTimeline 吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 actual_frame_timeline_slice 表？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have FrameTimeline data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there actual_frame_timeline_slice rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('frame_timeline rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('frame timeline count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 观测到的刷新率是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('当前 trace 的 VSync 周期是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what refresh rate is observed in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what VSync period is detected in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('What is the refresh rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('refresh rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('VSync period?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('VSync?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('display refresh rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('screen Hz?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('current refresh rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('observed Hz?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('刷新率是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('屏幕刷新率？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('检测到的刷新率？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('观测到的刷新率？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('推断刷新率？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('CPU 有几核？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('CPU 核心？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('CPU 核？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('cpu cores?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('CPU core?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('cpu count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('cpu rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('cpu table rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有 CPU 频率数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 CPU 频率吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 cpufreq counters?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have CPU frequency data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有功耗数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有电量计数器？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have power counters?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there battery counters?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('power rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('power samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('battery rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('battery samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('energy rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('charge samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('电量样本有多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有内存数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有内存计数器？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have memory counters?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there memory metrics?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('memory rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('memory samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('rss rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('rss samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('内存样本有多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 OOM 数据？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有调度数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 sched_slice 数据？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 thread_state 表？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sched?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('scheduler?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sched_slice?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_state?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_state rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_state count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('runnable thread_state rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many runnable thread states?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('running thread_state count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_state D rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread_state S rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sleeping thread_state rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many R+ thread states?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('preempted runnable thread states count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('D state count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('D-state count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('R+ count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('preempted runnable count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('uninterruptible sleep count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('runnable rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('D 状态行数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('D 状态 thread_state 行数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('睡眠 thread_state 行数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sched_slice rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sched_slice count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('sched rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have scheduler data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there thread_state events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有 GPU 数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 GPU counter？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('GPU 样本？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('GPU 样本数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have GPU data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there GPU slices?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('gpu samples?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('gpu rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有 slice 数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 slice 吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('slice 表有多少行？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have slice rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there track tables?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有网络包数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有网络包吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('网络流量数据有多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have network packets?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many android_network_packets rows are there?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network traffic?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network traffic data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network traffic rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network traffic count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('网络数据？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有网络数据？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network bytes?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('traffic bytes?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network packet bytes?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('网络字节数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android network data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('network rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('packet data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('packets data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('packet rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('packet count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('packets?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有 logcat 数据吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 logcat 吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('logcat 有吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('logcat 有多少条？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 android_logs 表？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('does this trace have logcat logs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many android_logs rows are there?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many logcat errors?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('logcat error count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android_logs error rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('any logcat errors?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('logcat warnings count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('errors in logcat?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there warnings in logcat?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('fatal in android logs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many fatal logs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('error logs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('错误日志？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有错误日志吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有报错日志吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('log rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('logs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('线程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('threads?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('thread table rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('threads count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('线程数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有多少个线程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('一共有多少个线程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many threads are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('焦点应用有多少线程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('当前应用线程数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many threads does the current app have?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('进程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('processes?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('process rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('process table rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('processes count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('进程数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有多少个进程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many processes are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('焦点应用有多少进程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('当前应用进程数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many processes does the current app have?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有哪些进程？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('列出进程')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('which processes are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('list processes')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('Binder 调用次数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android_binder_txns?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 Binder 调用？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 Binder 吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many Binder transactions?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there Binder transactions?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 ANR？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('ANR?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android_anrs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 ANR 吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('ANR 有吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('ANR 数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('应用无响应？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有应用无响应？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('无响应次数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many ANRs are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there any ANRs?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('app not responding?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('app not responding count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有启动事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('启动事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android_startups?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('启动次数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many app launches are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('app launches?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there startup events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('startup events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('startup data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('launch data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('app launch data?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('startup rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('startup table rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('启动时间？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('冷启动时间？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('launch time?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('cold launch time?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('启动耗时是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('启动用了多久？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('launch duration?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('startup duration?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how long did startup take?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有几次滑动？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有滑动？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有滑动吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('scroll gestures?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('scroll rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('scrolls?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many scrolls?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('scroll table rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('swipes?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('swipe rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many scroll gestures are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there scroll gestures?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('输入事件数量是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('input 事件有多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有 input 事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有 input 事件吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有触摸事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('输入事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('触摸事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('触摸次数？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android_input_events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('input rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('touch rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('key rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many input events are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there touch events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('are there key events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('key presses?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('keyboard events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('按键次数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('键盘事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('touches?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('touches count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many touches?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('android input MOTION events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('motion events?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('motion count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('MOTION rows?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('MOTION 事件数量？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many MOTION events are in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有多少个 MOTION 事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有多少个触摸 MOTION 事件？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('设备型号是什么？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('Android 版本是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('Android SDK？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('SDK version?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('安卓版本是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('SDK 版本是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('SoC 是什么？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('SoC?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('芯片型号是什么？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('设备厂商是什么？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('device manufacturer?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what is the SoC model?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('build fingerprint?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('Android build fingerprint?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what is the build fingerprint?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('device fingerprint?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('build fingerprint 是什么？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('内核版本是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('kernel release?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('system release?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('system machine?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('device architecture?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('CPU architecture?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what architecture is this trace from?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这是什么手机？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('哪台手机录的？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what phone model is this trace from?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('which phone is this?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有没有掉帧？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 掉帧吗？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('当前 trace 掉帧数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('overall trace jank rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('有没有掉帧？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('any jank?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('is there jank?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('was there any jank?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank present?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank detected?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('is there any jank in this trace?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('was there jank in the recording?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('掉帧数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('how many dropped frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank frame count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('janky frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('dropped frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('frame drops?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace jank count?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace janky frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace dropped frames?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('trace frame drops?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('卡顿率是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('卡顿比例是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('jank percentage?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what is the jank rate?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('what percentage of frames are janky?')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('dropped frame rate?')).toBe(true);

    expect(shouldBuildQuickTraceFactEvidence('FPS low?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('frame rate low?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('is FPS low?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('帧率低吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('jank rate high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('dropped frame rate high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('jank frames high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('janky frames normal?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('dropped frames high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('frame drops high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('is there serious jank?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('jank count normal?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('卡顿率高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('掉帧率高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('total frames high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('frame count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('多长时间？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('trace_bounds latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('录了多久为什么卡？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('录屏时长异常吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('录屏时长为什么异常？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('Does this device support variable refresh rate?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('display refresh rate policy?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is display refresh rate switching?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('screen refresh rate jank?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析刷新率策略')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么 trace 有采集错误？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('怎么修复 trace health issue?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('这个 trace 有哪些问题？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析这个 trace 的数据源缺失原因')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('数据源有什么问题？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有哪些表为什么缺失？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('counter_track latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are counters high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('counter values high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('counterbalance?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么 FrameTimeline 卡顿？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析 FrameTimeline 掉帧')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is FrameTimeline jank high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('frame_timeline rows slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有多少个线程卡住？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('blocked thread count?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('thread count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('threads count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('too many threads?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('线程数过高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many threads are blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many D thread states are blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many S thread states are blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many I thread states are blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('thread rows blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有多少个进程卡住？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many processes are blocked?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('process count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('processes count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('too many processes?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('进程数过高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('哪些进程卡顿？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('which process is slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('process rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有没有 Binder 阻塞？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many Binder calls are blocking?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('Binder latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('android_binder_txns latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('ANR 原因是什么？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有 ANR 为什么卡死？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('android_anrs why?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析 ANR')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why did this ANR happen?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('应用无响应为什么？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('应用无响应原因是什么？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why did app not responding happen?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('启动开始时间是多少？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('启动结束时间是多少？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('启动时间正常吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup start time?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup end time?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('launch time normal?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('错误日志为什么发生？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('错误日志很多吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('警告日志很多吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('CPU 频率为什么低？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析 DVFS 升频不足')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('CPU?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('CPU 慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('CPU 为什么慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('cpu throttling?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('cpu count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么耗电高？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析功耗')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('power high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('battery drain?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('power consumption high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('energy consumption high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is battery drain high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么内存高？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析内存泄漏')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('memory usage?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('memory high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('memory leak?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('memory pressure?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('rss high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is memory usage high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('OOM 原因是什么？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么调度延迟高？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析调度问题')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scheduler latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is runnable time high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('runnable rows high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('runnable thread_state latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why D state?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('D state blocking?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('high D state count?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scheduling?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('thread_state latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('blocked thread_state reason?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('sched_slice 为什么慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('thread_state rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('sched rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么 GPU 慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析 GPU 瓶颈')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('GPU jank?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is GPU utilization high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('gpu rows high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('GPU 样本异常吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('GPU 利用率高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('gpu samples high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么 slice 很慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析 slice 耗时')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are slices slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么网络慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析网络流量高')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network traffic is high')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network traffic high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network bytes high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('屏幕刷新率异常吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('检测到的刷新率为什么切换？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('刷新率策略？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('网络数据慢吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('网络数据异常吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are requests slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('packet?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network rows slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('丢包?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('packet loss?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('packet drop?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('dropped packets?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('packet retransmission?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network packets cause?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('network packets reason?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么 logcat 报错？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么有 logcat 报错？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('logcat 有什么问题？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('analyze logcat errors')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('diagnose logcat warnings')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are there logcat errors?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why errors in logcat?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('logcat warnings latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('warnings?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('logcat cause?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('log?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('log rows errors?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('ANR cause?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('ANR reason?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('binder cause?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('binder reason?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('process name?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('which process is this trace from?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('what process is this trace?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('进程名是什么？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('启动耗时高吗？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('启动开始时间是多少？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup start time?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('android_startups latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析启动性能')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is startup slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('launches?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('startup duration high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('app launches latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('滑动 FPS 是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('滑动掉帧数是多少？')).toBe(true);
    expect(shouldBuildQuickTraceFactEvidence('为什么滑动卡？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析滑动性能')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is scrolling slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scroll rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scroll count high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why scrolls?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scroll gestures high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('scroll gestures latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('swipe rows high?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are scroll gestures slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('输入延迟是多少？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('分析输入事件')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('input event cause?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('touch event reason?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('motion event latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('motion events latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why motion events?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('motion events delayed?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are motion events slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('analyze input motion latency')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many MOTION events caused dropped frames?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many motion events caused frame drops?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('有多少个 MOTION 事件导致掉帧？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('motion jank?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('android_input_events latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why are touch events slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('input rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('touch rows latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('key rows slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('key presses latency?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why key presses?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('keyboard events slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('touches slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why touches?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('how many touches caused frame drops?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('tap count?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('button press count?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('手机为什么慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('what phone is slow?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('芯片为什么慢？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('Android 版本有什么问题？')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('SDK version issue?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('SoC performance?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('why is the Android version causing jank?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('does build fingerprint affect performance?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('does this SoC support 64-bit?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('architecture bottleneck?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('does this device architecture support 64-bit?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('build fingerprint why?')).toBe(false);
    expect(shouldBuildQuickTraceFactEvidence('为什么卡顿比例高？')).toBe(false);
  });

  it('only allows selected-range scoped pre-evidence for frame timeline facts with time-window SQL support', () => {
    expect(shouldBuildScopedQuickTraceFactEvidence('这个 trace 一共有多少帧？')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('这个 trace 有没有掉帧？')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('滑动 FPS 是多少？')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('掉帧数是多少？')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('is there jank?')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('jank present?')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('jank frames?')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('dropped frames?')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('frame drops?')).toBe(true);
    expect(shouldBuildScopedQuickTraceFactEvidence('CPU 有几核？')).toBe(false);
    expect(shouldBuildScopedQuickTraceFactEvidence('这个 trace 有调度数据吗？')).toBe(false);
    expect(shouldBuildScopedQuickTraceFactEvidence('焦点应用有多少线程？')).toBe(false);
  });

  it('identifies global trace facts that do not need focus detection', () => {
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('CPU 有几核？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有 CPU 频率数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 CPU 频率吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有功耗数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have power counters?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有内存数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have memory counters?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有调度数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sched?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scheduler?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sched_slice?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_state?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_state rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('runnable thread_state rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many runnable thread states?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('running thread_state count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_state D rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_state S rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sleeping thread_state rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many R+ thread states?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('preempted runnable thread states count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('D state count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('D-state count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('R+ count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('preempted runnable count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('uninterruptible sleep count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('runnable rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('D 状态行数？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('D 状态 thread_state 行数？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('睡眠 thread_state 行数？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sched_slice rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sched rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have scheduler data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有 GPU 数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('GPU 样本？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('GPU 样本数？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have GPU data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('gpu samples?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('gpu rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有 slice 数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 slice 吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have slice rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有网络包数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有网络包吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have network packets?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('网络数据？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有网络数据？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packets?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有 logcat 数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 logcat 吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logcat 有吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many android_logs rows are there?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many logcat errors?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logcat error count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android_logs error rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('any logcat errors?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logcat warnings count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('errors in logcat?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('are there warnings in logcat?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('fatal in android logs?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many fatal logs?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('error logs?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('错误日志？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有错误日志吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有报错日志吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('log rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logs?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 录制时长多长？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how long is this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace time range?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('recording length?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('录制时间？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace_bounds?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace bounds table?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 的起止时间是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what are the trace start and end timestamps?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('SDK version?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('SoC?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有采集错误吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('采集错误？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace health?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 采集了哪些数据？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有哪些数据源？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('available data sources?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('slice_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('track_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('process_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('process_track_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread_track_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('counter_sample_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('actual_frame_timeline_slice_count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('counter_track?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('counter samples?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what data sources are available in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有 FrameTimeline 数据吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 FrameTimeline 吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this trace have FrameTimeline data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('frame_timeline rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 观测到的刷新率是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what refresh rate is observed in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('What is the refresh rate?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('refresh rate?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('VSync period?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('VSync?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('display refresh rate?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('screen Hz?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('current refresh rate?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('刷新率是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('屏幕刷新率？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('检测到的刷新率？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('观测到的刷新率？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('推断刷新率？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('线程？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('threads?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('thread rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('线程数量是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有多少个线程？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many threads are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('进程？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('processes?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('process rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('进程数量是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有多少个进程？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有哪些进程？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many processes are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Binder 调用次数是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Binder 调用？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Binder?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android_binder_txns?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有 Binder 调用？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 Binder 吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many Binder transactions?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有 ANR？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('ANR?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android_anrs?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 ANR 吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('应用无响应？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有应用无响应？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('app not responding?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many ANRs are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有启动事件？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动事件？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android_startups?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动次数是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many app launches are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('app launches?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('are there startup events?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup events?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('launch data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('app launch data?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动时间？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('冷启动时间？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('launch time?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('cold launch time?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动耗时是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动用了多久？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('launch duration?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup duration?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how long did startup take?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有几次滑动？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有滑动？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有滑动吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scroll gestures?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scroll rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scrolls?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many scrolls?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scroll table rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('swipes?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('swipe rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many scroll gestures are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('输入事件数量是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 input 事件吗？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有触摸事件？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('输入事件？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android_input_events?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('input rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('touch rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('key rows?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many input events are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('android input MOTION events?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('motion events?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many MOTION events are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有多少个 MOTION 事件？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('设备型号是什么？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Android 版本是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Android SDK？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('SoC 是什么？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('设备厂商是什么？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what is the SoC model?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这是什么手机？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('哪台手机录的？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what phone model is this trace from?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('which phone is this?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('build fingerprint?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what is the build fingerprint?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('kernel release?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('system machine?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('device architecture?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有没有掉帧？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('当前 trace 掉帧数是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('overall trace jank rate?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace jank count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace janky frames?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace dropped frames?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace frame drops?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('is there any jank in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('was there jank in the recording?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('jank frames?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('is there jank?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('jank present?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('dropped frames?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('frame drops?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 一共有多少帧？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('当前 trace 总帧数是多少？')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many frames are in this trace?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('total frame count?')).toBe(true);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('frame count?')).toBe(true);

    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('滑动 FPS 是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('trace frame count and FPS?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what is this trace total frame count and fps?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('焦点应用一共有多少帧？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('current app total frames?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('current app frame count?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('焦点应用有多少线程？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('当前应用线程数量是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many threads does the current app have?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('焦点应用有多少进程？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('当前应用进程数量是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many processes does the current app have?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有掉帧？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('jank percentage?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 的焦点应用有没有掉帧？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('current app jank rate?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Does this device support variable refresh rate?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('display refresh rate policy?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('screen refresh rate jank?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('分析刷新率策略')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('芯片为什么慢？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Android 版本有什么问题？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does build fingerprint affect performance?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('architecture bottleneck?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('does this device architecture support 64-bit?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么 trace 有采集错误？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('这个 trace 有哪些问题？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('分析这个 trace 的数据源缺失原因')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('数据源有什么问题？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有哪些表为什么缺失？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('错误日志为什么发生？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('错误日志很多吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('警告日志很多吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有多少个线程卡住？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('blocked thread count?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many threads are blocked?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many D thread states are blocked?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many S thread states are blocked?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many I thread states are blocked?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why D state?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('D state blocking?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('high D state count?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有多少个进程卡住？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('哪些进程卡顿？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有没有 Binder 阻塞？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many Binder calls are blocking?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('Binder latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('ANR 原因是什么？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有 ANR 为什么卡死？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why did this ANR happen?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('应用无响应为什么？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('应用无响应原因是什么？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why did app not responding happen?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动开始时间是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动结束时间是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动时间正常吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup start time?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup end time?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('launch time normal?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么耗电高？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('power consumption high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么内存高？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('memory leak?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么调度延迟高？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scheduler latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('runnable rows high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('runnable thread_state latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scheduling?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('blocked thread_state reason?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('sched rows latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么 GPU 慢？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('GPU jank?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('gpu rows high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('GPU 样本异常吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('GPU 利用率高吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('gpu samples high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么 slice 很慢？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why are slices slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么网络慢？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network traffic is high')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network traffic high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('网络数据慢吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('网络数据异常吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network rows slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('丢包?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet loss?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet drop?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('dropped packets?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('packet retransmission?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network packets cause?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('network packets reason?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么 logcat 报错？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么有 logcat 报错？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('analyze logcat errors')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('diagnose logcat warnings')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why are there logcat errors?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why errors in logcat?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logcat warnings latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('warnings?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('logcat cause?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('log?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('log rows errors?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('ANR cause?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('ANR reason?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('binder cause?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('binder reason?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('线程为什么卡？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('blocked threads?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('进程为什么卡？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('blocked processes?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动耗时高吗？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('启动开始时间是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup start time?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('app launches latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('分析启动性能')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why is startup slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('launches?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup rows latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('startup duration high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么滑动卡？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('分析滑动性能')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scroll rows latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('scroll count high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why scrolls?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('swipe rows high?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('输入延迟是多少？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('分析输入事件')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('input event cause?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('touch event reason?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('motion event latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('motion events latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why motion events?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('motion events delayed?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('why are motion events slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('how many MOTION events caused dropped frames?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('有多少个 MOTION 事件导致掉帧？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('motion jank?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('input rows latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('touch rows latency?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('key rows slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('手机为什么慢？')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('what phone is slow?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('build fingerprint why?')).toBe(false);
    expect(shouldSkipFocusDetectionForQuickTraceFactEvidence('为什么卡顿比例高？')).toBe(false);
  });
});

describe('buildQuickTraceFactEvidence', () => {
  it('returns frame metrics evidence for focus app FPS questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_frame_metrics');
      expect(sql).toContain("WHERE package_name = 'com.example.app'");
      expect(sql).toContain('GROUP BY package_name, upid, frame_id');
      expect(sql).toContain('FROM per_frame');
      return {
        columns: [
          'package_name',
          'process_names',
          'upid_count',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          1,
          347,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'actual_frame_timeline_slice',
        ]],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '滑动 FPS 是多少？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
      outputLanguage: 'zh-CN',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payload.evidenceKind).toBe('frame_metrics');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      type: 'sql_result',
      source: 'runtime_trace_fact:frame_metrics',
      traceSide: 'current',
      traceId: 'trace-1',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.envelopes[0].meta.evidenceRefId)
      .toMatch(/^data:runtime_trace_fact:frame_metrics:current:[a-f0-9]{12}$/);
    expect(payload.promptContext).toContain('当前 Trace 运行时预证据');
    expect(payload.promptContext).toContain('fps');
    expect(payload.promptContext).toContain('77.99');
  });

  it('keeps mixed frame-count and FPS questions on FPS-capable frame metrics evidence', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_frame_metrics');
      expect(sql).toContain("WHERE package_name = 'com.example.app'");
      expect(sql).toContain('AS fps');
      expect(sql).not.toContain('runtime_trace_frame_count');
      return {
        columns: [
          'package_name',
          'process_names',
          'upid_count',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          1,
          347,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'actual_frame_timeline_slice',
        ]],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'trace frame count and FPS?',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payload.evidenceKind).toBe('frame_metrics');
    expect(payload.envelopes[0].meta.source).toBe('runtime_trace_fact:frame_metrics');
    expect(payload.promptContext).toContain('total_frames');
    expect(payload.promptContext).toContain('fps');
    expect(payload.promptContext).toContain('77.99');
  });

  it('returns trace duration evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_duration');
      expect(sql).toContain('trace_start_s');
      expect(sql).toContain('trace_end_s');
      return {
        columns: ['trace_start_ns', 'trace_end_ns', 'trace_start_s', 'trace_end_s', 'duration_s', 'source_table'],
        rows: [[100, 2_500_000_100, 0.000000, 2.5, 2.5, 'trace_bounds']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 录制时长多长？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('trace_duration');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.promptContext).toContain('trace_start_s');
    expect(payload.promptContext).toContain('trace_end_s');
    expect(payload.promptContext).toContain('duration_s');
    expect(payload.promptContext).toContain('2.5');
  });

  it('returns selected-range duration evidence without SQL when selection time range is available', async () => {
    const query = jest.fn<QueryTrace>();

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个选区多长？',
      timeRange: { startNs: 1_000_000_000, endNs: 3_500_000_000 },
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).not.toHaveBeenCalled();
    expect(payload.evidenceKind).toBe('selection_duration');
    expect(payload.envelopes).toHaveLength(1);
    const envelope = payload.envelopes[0];
    if (!envelope) throw new Error('Expected selected-range duration evidence envelope');
    const rows = envelope.data.rows;
    if (!rows) throw new Error('Expected selected-range duration evidence rows');
    expect(envelope.meta.source).toBe('runtime_trace_fact:selection_duration');
    expect(envelope.data.columns).toEqual([
      'scope',
      'scope_start_ns',
      'scope_end_ns',
      'duration_ns',
      'duration_s',
      'source_table',
    ]);
    expect(rows[0]).toEqual([
      'selection',
      1_000_000_000,
      3_500_000_000,
      2_500_000_000,
      2.5,
      'selection_context',
    ]);
    expect(payload.promptContext).toContain('duration_s');
    expect(payload.promptContext).toContain('2.5');
  });

  it('does not return selected-range duration evidence for non-positive selection ranges', async () => {
    const query = jest.fn<QueryTrace>();

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个选区多长？',
      timeRange: { startNs: 3_500_000_000, endNs: 1_000_000_000 },
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).not.toHaveBeenCalled();
    expect(payload.evidenceKind).toBe('selection_duration');
    expect(payload.envelopes).toHaveLength(0);
    expect(payload.promptContext).toBeUndefined();
  });

  it.each([
    'recording duration?',
    'recording time?',
    'capture duration?',
    'trace time range?',
    'trace range?',
    '这个 trace 的时间范围是多少？',
    'trace 时间范围？',
    'trace 范围？',
    '录制时间？',
    '采集范围？',
  ])('returns trace duration evidence for timing synonym %p', async (queryText) => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_duration');
      return {
        columns: ['trace_start_ns', 'trace_end_ns', 'trace_start_s', 'trace_end_s', 'duration_s', 'source_table'],
        rows: [[100, 2_500_000_100, 0.000000, 2.5, 2.5, 'trace_bounds']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: queryText,
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payload.evidenceKind).toBe('trace_duration');
    expect(payload.envelopes[0].meta.source).toBe('runtime_trace_fact:trace_duration');
    expect(payload.promptContext).toContain('duration_s');
  });

  it('returns trace health issue evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_health_issues');
      expect(sql).toContain('FROM stats');
      expect(sql).toContain("severity IN ('error', 'data_loss')");
      expect(sql).toContain('value > 0');
      return {
        columns: [
          'issue_stat_count',
          'error_stat_count',
          'data_loss_stat_count',
          'total_issue_value',
          'issue_names',
          'issue_values',
          'issue_severities',
          'source_table',
        ],
        rows: [[
          1,
          1,
          0,
          7,
          'trace_sorter_negative_timestamp_dropped',
          '7',
          'error',
          'stats',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有采集错误吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('trace_health_issues');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:trace_health_issues',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Trace 采集/解析健康问题');
    expect(payload.promptContext).toContain('issue_stat_count');
    expect(payload.promptContext).toContain('trace_sorter_negative_timestamp_dropped');
  });

  it('returns FrameTimeline data availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_frame_timeline_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain('FROM actual_frame_timeline_slice');
      expect(sql).toContain('FROM expected_frame_timeline_slice');
      return {
        columns: [
          'actual_frame_timeline_slice_count',
          'expected_frame_timeline_slice_count',
          'janky_actual_frame_count',
          'actual_frame_upid_count',
          'source_table',
        ],
        rows: [[697, 697, 21, 3, 'actual_frame_timeline_slice,expected_frame_timeline_slice']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 FrameTimeline 数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('frame_timeline_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:frame_timeline_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('FrameTimeline 数据可用性');
    expect(payload.promptContext).toContain('actual_frame_timeline_slice_count');
    expect(payload.promptContext).toContain('697');
  });

  it('returns observed refresh-rate evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_refresh_rate');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain("t.name = 'VSYNC-sf'");
      expect(sql).toContain('FROM expected_frame_timeline_slice');
      expect(sql).toContain('sample_count >= 10');
      expect(sql).not.toContain('default_60hz');
      return {
        columns: [
          'refresh_rate_hz',
          'vsync_period_ns',
          'vsync_period_ms',
          'detection_method',
          'sample_count',
          'raw_median_period_ns',
          'source_table',
        ],
        rows: [[120, 8_333_333, 8.333, 'vsync_sf', 240, 8_330_000, 'counter_track,counter']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 观测到的刷新率是多少？',
      focusResult: { method: 'none', apps: [] },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('refresh_rate');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:refresh_rate',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('观测到的 VSync 刷新率');
    expect(payload.promptContext).toContain('refresh_rate_hz');
    expect(payload.promptContext).toContain('120');
    expect(direct?.conclusion).toContain('约为 120 Hz');
    expect(direct?.conclusion).toContain('不等同于设备支持的全部刷新率');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'refresh_rate_hz',
      value: 120,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'sample_count',
      value: 240,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('does not return direct refresh-rate evidence for default fallback rows', () => {
    const envelope = traceFactEnvelope({
      evidenceKind: 'refresh_rate',
      rows: [[60, 16_666_667, 16.667, 'default_60hz', 0, 16_666_667, 'default']],
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: {
        envelopes: [envelope],
        evidenceKind: 'refresh_rate',
        promptContext: 'refresh fallback',
      },
      outputLanguage: 'zh-CN',
    });

    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [envelope],
        evidenceKind: 'refresh_rate',
        promptContext: 'refresh fallback',
      },
    })).toBe(false);
    expect(direct).toBeUndefined();
  });

  it('returns generic slice and track data availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_slice_data_presence');
      expect(sql).toContain('COUNT(*) FROM slice');
      expect(sql).toContain('COUNT(*) FROM track');
      expect(sql).toContain('COUNT(*) FROM process_track');
      expect(sql).toContain('COUNT(*) FROM thread_track');
      return {
        columns: [
          'slice_count',
          'track_count',
          'process_track_count',
          'thread_track_count',
          'source_table',
        ],
        rows: [[101278, 771, 65, 403, 'slice,track,process_track,thread_track']],
        durationMs: 1,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 slice 数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('slice_data_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:slice_data_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('通用 slice/track 数据可用性');
    expect(payload.promptContext).toContain('slice_count');
    expect(payload.promptContext).toContain('101278');
  });

  it('returns common trace data inventory evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_data_inventory');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.network_packets');
      expect(sql).toContain('COUNT(*) FROM slice');
      expect(sql).toContain('COUNT(*) FROM sched_slice');
      expect(sql).toContain('COUNT(*) FROM actual_frame_timeline_slice');
      expect(sql).toContain('COUNT(*) FROM android_network_packets');
      expect(sql).toContain('COUNT(*) FROM android_logs');
      return {
        columns: [
          'trace_start_ns',
          'trace_end_ns',
          'duration_s',
          'slice_count',
          'track_count',
          'process_track_count',
          'thread_track_count',
          'process_count',
          'thread_count',
          'sched_slice_count',
          'thread_state_count',
          'counter_track_count',
          'process_counter_track_count',
          'cpu_counter_track_count',
          'gpu_counter_track_count',
          'counter_sample_count',
          'cpufreq_sample_count',
          'actual_frame_timeline_slice_count',
          'expected_frame_timeline_slice_count',
          'gpu_slice_count',
          'gpu_counter_sample_count',
          'network_packet_event_count',
          'android_log_count',
          'source_table',
        ],
        rows: [[100, 5_100_000_000, 5, 101278, 771, 65, 403, 1031, 12891, 66756, 129368, 303, 227, 70, 0, 90275, 1255, 697, 697, 0, 0, 0, 123, 'trace_bounds,slice,track,process,thread,sched_slice,thread_state,counter_track,process_counter_track,cpu_counter_track,gpu_counter_track,counter,actual_frame_timeline_slice,expected_frame_timeline_slice,gpu_slice,android_network_packets,android_logs']],
        durationMs: 7,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 采集了哪些数据？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('trace_data_inventory');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:trace_data_inventory',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('常用 Trace 数据清单');
    expect(payload.promptContext).toContain('slice_count');
    expect(payload.promptContext).toContain('actual_frame_timeline_slice_count');
    expect(payload.promptContext).toContain('android_log_count');
    expect(payload.promptContext).toContain('101278');
  });

  it('returns Android network packet availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_network_packet_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.network_packets');
      expect(sql).toContain('FROM android_network_packets');
      expect(sql).toContain('network_packet_event_count');
      expect(sql).toContain('network_packet_bytes');
      return {
        columns: [
          'network_packet_event_count',
          'network_packet_count',
          'network_packet_bytes',
          'network_iface_count',
          'network_transport_count',
          'network_ifaces',
          'network_iface_packet_counts',
          'network_transports',
          'network_transport_packet_counts',
          'source_table',
        ],
        rows: [[42, 840, 1_234_567, 2, 2, 'wlan0,rmnet_data0', '700,140', 'TCP,UDP', '780,60', 'android_network_packets']],
        durationMs: 1,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有网络包数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('network_packet_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:network_packet_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Android 网络包数据可用性');
    expect(payload.promptContext).toContain('network_packet_event_count');
    expect(payload.promptContext).toContain('42');
  });

  it('returns Android Logcat availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_logcat_presence');
      expect(sql).toContain('FROM android_logs');
      expect(sql).toContain('logcat_event_count');
      expect(sql).toContain('warn_log_count');
      expect(sql).toContain('ranked_tags');
      return {
        columns: [
          'logcat_event_count',
          'warn_log_count',
          'error_log_count',
          'fatal_log_count',
          'distinct_tag_count',
          'sample_tags',
          'sample_tag_counts',
          'first_log_ts',
          'last_log_ts',
          'source_table',
        ],
        rows: [[123, 12, 3, 1, 8, 'ActivityManager,InputDispatcher,Choreographer', '70,33,20', 1_000_000, 2_000_000, 'android_logs']],
        durationMs: 1,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 logcat 数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('logcat_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:logcat_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Android Logcat 日志数据可用性');
    expect(payload.promptContext).toContain('logcat_event_count');
    expect(payload.promptContext).toContain('123');
  });

  it('returns deduplicated jank presence evidence for focus app yes/no questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_jank_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain('GROUP BY package_name, upid, frame_id');
      expect(sql).toContain("WHERE package_name = 'com.example.app'");
      return {
        columns: [
          'package_name',
          'process_names',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          347,
          21,
          6.05,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'App Deadline Missed,Buffer Stuffing',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 4,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有掉帧？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
    });

    expect(payload.evidenceKind).toBe('jank_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:jank_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('FrameTimeline 掉帧/卡顿存在性');
    expect(payload.promptContext).toContain('jank_frames');
    expect(payload.promptContext).toContain('21');
    expect(payload.promptContext).toContain('fps');
    expect(payload.promptContext).toContain('77.99');
  });

  it('returns trace-wide jank evidence without requiring a focus app for explicit trace-level questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_jank_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain('FROM actual_frame_timeline_slice');
      expect(sql).toContain('GROUP BY upid, frame_id');
      expect(sql).toContain("'trace' AS scope");
      expect(sql).not.toContain('android.process_metadata');
      expect(sql).not.toContain('package_name =');
      return {
        columns: [
          'scope',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'trace',
          697,
          21,
          3.01,
          10,
          4_449_374_956,
          4.449375,
          'App Deadline Missed,Buffer Stuffing',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有没有掉帧？',
      focusResult: { method: 'none', apps: [] },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('trace_jank_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:trace_jank_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Trace 全局 FrameTimeline 掉帧/卡顿');
    expect(payload.promptContext).toContain('jank_frames');
    expect(direct?.conclusion).toContain('当前 trace 的 FrameTimeline 中共有 697 帧');
    expect(direct?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(direct?.conclusion).toContain('不等同于特定应用或进程的归因结论');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scope',
      value: 'trace',
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 21,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('routes combined trace-wide frame and janky-frame count questions to jank evidence', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_jank_presence');
      expect(sql).not.toContain('runtime_trace_frame_count');
      expect(sql).toContain('FROM actual_frame_timeline_slice');
      expect(sql).toContain("'trace' AS scope");
      return {
        columns: [
          'scope',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'trace',
          347,
          0,
          0,
          10,
          3_470_000_000,
          3.47,
          '',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '快速回答：这条 trace 的滑动总帧数和 janky frame 数是多少？请引用当前证据 ID，只给结论。',
      focusResult: { method: 'none', apps: [] },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('trace_jank_presence');
    expect(payload.promptContext).toContain('total_frames');
    expect(payload.promptContext).toContain('jank_frames');
    expect(direct?.conclusion).toContain('当前 trace 的 FrameTimeline 中共有 347 帧');
    expect(direct?.conclusion).toContain('0 帧标记为掉帧/卡顿');
    expect(direct?.conclusionContract.claims?.[0]?.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'total_frames', value: 347 }),
      expect.objectContaining({ column: 'jank_frames', value: 0 }),
    ]));
  });

  it('returns trace-wide frame-count evidence without requiring a focus app for bare total frame-count questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_frame_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.frames.timeline');
      expect(sql).toContain('FROM actual_frame_timeline_slice');
      expect(sql).toContain('GROUP BY upid, frame_id');
      expect(sql).toContain("'trace' AS scope");
      expect(sql).not.toContain('android.process_metadata');
      expect(sql).not.toContain('package_name =');
      expect(sql).not.toContain('AS fps');
      return {
        columns: [
          'scope',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'source_table',
        ],
        rows: [['trace', 697, 10, 4_449_374_956, 4.449375, 'actual_frame_timeline_slice']],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'total frame count?',
      focusResult: { method: 'none', apps: [] },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('trace_frame_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:trace_frame_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Trace 全局 FrameTimeline 帧数');
    expect(payload.promptContext).toContain('total_frames');
    expect(payload.promptContext ?? '').not.toContain('fps');
    expect(direct?.conclusion).toContain('当前 trace 的 FrameTimeline 中共有 697 帧');
    expect(direct?.conclusion).toContain('不等同于特定应用或进程的归因结论');
    expect(direct?.conclusion ?? '').not.toContain('FPS');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scope',
      value: 'trace',
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'total_frames',
      value: 697,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  itWithLaunchLightTraceProcessor('matches launch_light canonical trace-wide distinct frame count', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_frame_count');
      expect(sql).toContain('GROUP BY upid, frame_id');

      const { stdout } = await execFileAsync(traceProcessorPath, ['query', launchLightTracePath, sql], {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000,
      });
      const text = String(stdout);
      expect(text).toContain('"scope","total_frames","window_start_ns","window_end_ns","duration_s","source_table"');
      expect(text).toContain('"trace",291,');
      expect(text).not.toContain('"trace",248,');

      return {
        columns: [
          'scope',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'source_table',
        ],
        rows: [['trace', 291, 0, 0, 0, 'actual_frame_timeline_slice']],
        durationMs: 1,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'launch-light',
      query: 'total frame count?',
      focusResult: { method: 'none', apps: [] },
      outputLanguage: 'zh-CN',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payload.evidenceKind).toBe('trace_frame_count');
  }, 30_000);

  it('returns selected-range trace-wide frame-count evidence when a scoped time range is provided', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_trace_frame_count');
      expect(sql).toContain('FROM actual_frame_timeline_slice');
      expect(sql).toContain("'selected_range' AS scope");
      expect(sql).toContain('AND ts < 2000');
      expect(sql).toContain('AND (ts + dur) > 1000');
      expect(sql).toContain('AS scope_start_ns');
      expect(sql).toContain('AS scope_end_ns');
      return {
        columns: [
          'scope',
          'total_frames',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'scope_start_ns',
          'scope_end_ns',
          'source_table',
        ],
        rows: [['selected_range', 41, 1005, 1985, 0.00098, 1000, 2000, 'actual_frame_timeline_slice']],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 一共有多少帧？',
      focusResult: { method: 'none', apps: [] },
      timeRange: { startNs: 1000, endNs: 2000 },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('trace_frame_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].display?.title)
      .toBe('运行时选区 Trace 事实预证据：trace_frame_count');
    expect(payload.envelopes[0].meta.evidenceRefId)
      .toMatch(/^data:runtime_trace_fact:trace_frame_count:current:[a-f0-9]{12}$/);
    expect(payload.promptContext).toContain('当前选区运行时预证据');
    expect(payload.promptContext).toContain('scope_start_ns');
    expect(direct?.conclusion).toContain('当前选区的 FrameTimeline 中共有 41 帧');
    expect(direct?.conclusion).toContain('选区内的 trace-wide FrameTimeline 统计');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scope_start_ns',
      value: 1000,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scope_end_ns',
      value: 2000,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('routes dropped-frame count questions to count-focused jank evidence before generic frame metrics', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_jank_presence');
      expect(sql).not.toContain('runtime_frame_metrics');
      return {
        columns: [
          'package_name',
          'process_names',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          347,
          21,
          6.05,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'App Deadline Missed,Buffer Stuffing',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 4,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'how many dropped frames?',
      packageName: 'com.example.app',
    });

    expect(payload.evidenceKind).toBe('jank_frame_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.promptContext).toContain('jank_frames');
    expect(payload.promptContext).toContain('21');
    expect(payload.promptContext).not.toContain('fps');
    expect(payload.promptContext).not.toContain('77.99');
  });

  it('returns selected-range app-scoped janky-frame count evidence when a scoped time range is provided', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_jank_presence');
      expect(sql).toContain("WHERE package_name = 'com.example.app'");
      expect(sql).toContain('AND a.ts < 2000');
      expect(sql).toContain('AND (a.ts + a.dur) > 1000');
      expect(sql).toContain('AS scope_start_ns');
      expect(sql).toContain('AS scope_end_ns');
      expect(sql).not.toContain('runtime_frame_metrics');
      return {
        columns: [
          'package_name',
          'process_names',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'jank_types',
          'scope_start_ns',
          'scope_end_ns',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          17,
          3,
          17.65,
          1005,
          1985,
          0.00098,
          'App Deadline Missed',
          1000,
          2000,
          'actual_frame_timeline_slice',
        ]],
        durationMs: 4,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'how many dropped frames?',
      packageName: 'com.example.app',
      timeRange: { startNs: 1000, endNs: 2000 },
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(payload.evidenceKind).toBe('jank_frame_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].display?.title)
      .toBe('运行时选区 Trace 事实预证据：jank_frame_count');
    expect(payload.promptContext).toContain('当前选区运行时预证据');
    expect(payload.promptContext).toContain('scope_start_ns');
    expect(payload.promptContext).not.toContain('fps');
    expect(direct?.conclusion).toContain('选区内焦点应用 com.example.app');
    expect(direct?.conclusion).toContain('3 帧标记为掉帧/卡顿');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scope_start_ns',
      value: 1000,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 3,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('routes dropped-frame rate questions to jank evidence before generic frame metrics', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_jank_presence');
      expect(sql).toContain('AS jank_rate_pct');
      expect(sql).not.toContain('runtime_frame_metrics');
      return {
        columns: [
          'package_name',
          'process_names',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          347,
          21,
          6.05,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'App Deadline Missed,Buffer Stuffing',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 4,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'dropped frame rate?',
      packageName: 'com.example.app',
    });

    expect(payload.evidenceKind).toBe('jank_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.promptContext).toContain('jank_rate_pct');
    expect(payload.promptContext).toContain('6.05');
  });

  it('answers combined FPS and jank-count questions from one jank evidence query', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_jank_presence');
      expect(sql).toContain('AS fps');
      expect(sql).not.toContain('runtime_frame_metrics');
      return {
        columns: [
          'package_name',
          'process_names',
          'total_frames',
          'jank_frames',
          'jank_rate_pct',
          'window_start_ns',
          'window_end_ns',
          'duration_s',
          'fps',
          'jank_types',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          'com.example.app',
          347,
          21,
          6.05,
          10,
          4_449_374_956,
          4.449375,
          77.99,
          'App Deadline Missed,Buffer Stuffing',
          'actual_frame_timeline_slice',
        ]],
        durationMs: 4,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '滑动 FPS 和掉帧数是多少？',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(payload.evidenceKind).toBe('jank_presence');
    expect(direct?.conclusion).toContain('77.99 FPS');
    expect(direct?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'fps',
      value: 77.99,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 21,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('returns observed CPU core count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_cpu_core_count_cpu_table');
      expect(sql).toContain('FROM cpu');
      expect(sql).not.toContain('FROM sched_slice');
      return {
        columns: [
          'observed_cpu_count',
          'observed_cpus',
          'universe_source',
          'cpu_table_count',
          'cpu_table_cpus',
          'source_table',
        ],
        rows: [[
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'cpu_table',
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'cpu',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'CPU 有几核？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('cpu_core_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:cpu_core_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('观测到的 CPU 核心数');
    expect(payload.promptContext).toContain('observed_cpu_count');
    expect(payload.promptContext).toContain('7');
  });

  it('returns CPU frequency counter availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_cpu_frequency_presence');
      expect(sql).toContain('FROM cpu_counter_track');
      expect(sql).toContain("t.name = 'cpufreq'");
      expect(sql).toContain('JOIN counter c ON c.track_id = t.id');
      return {
        columns: [
          'cpufreq_cpu_count',
          'cpufreq_sample_count',
          'cpufreq_cpus',
          'min_freq_khz',
          'max_freq_khz',
          'first_sample_ts',
          'last_sample_ts',
          'source_table',
        ],
        rows: [[
          8,
          848,
          '0, 1, 2, 3, 4, 5, 6, 7',
          300000,
          3187200,
          1_000_000,
          2_000_000,
          'cpu_counter_track,counter',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 CPU 频率数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('cpu_frequency_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:cpu_frequency_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('CPU 频率计数器可用性');
    expect(payload.promptContext).toContain('cpufreq_sample_count');
    expect(payload.promptContext).toContain('848');
  });

  it('returns power and battery counter availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_power_counter_presence');
      expect(sql).toContain('FROM counter_track');
      expect(sql).toContain('JOIN counter c ON c.track_id = t.track_id');
      expect(sql).toContain("lower(t.name) GLOB '*power*'");
      expect(sql).toContain("lower(t.name) GLOB 'battery*'");
      expect(sql).not.toContain("GLOB '*current*'");
      return {
        columns: [
          'power_counter_track_count',
          'power_counter_sample_count',
          'power_counter_names',
          'power_counter_sample_counts',
          'source_table',
        ],
        rows: [[
          4,
          728,
          'PowerMode 4630946602912453524,PowerMode 4630946929504945811,BatteryChargeCounter,BatteryCurrent',
          '365,365,1,1',
          'counter_track,counter',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有功耗数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('power_counter_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:power_counter_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('功耗/电量相关计数器可用性');
    expect(payload.promptContext).toContain('power_counter_sample_count');
    expect(payload.promptContext).toContain('728');
    expect(payload.promptContext).toContain('BatteryChargeCounter');
  });

  it('returns memory counter availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_memory_counter_presence');
      expect(sql).toContain('FROM process_counter_track');
      expect(sql).toContain('JOIN counter c ON c.track_id = t.track_id');
      expect(sql).toContain("lower(t.name) GLOB '*memory*'");
      expect(sql).toContain("lower(t.name) GLOB '*rss*'");
      expect(sql).toContain("lower(t.name) GLOB '*swap*'");
      expect(sql).not.toContain("GLOB '*mem*'");
      expect(sql).not.toContain("GLOB '*ion*'");
      return {
        columns: [
          'memory_counter_track_count',
          'memory_counter_sample_count',
          'memory_counter_names',
          'memory_counter_sample_counts',
          'memory_counter_max_values',
          'source_table',
        ],
        rows: [[
          5,
          1411,
          'HWUI All Memory,HWUI CPU Memory,HWUI Misc Memory,Purgeable HWUI Misc Memory,Bitmap Memory',
          '350,350,350,350,11',
          '17543280,12783428,14841544,11968316,77992790',
          'process_counter_track,counter',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有内存数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('memory_counter_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:memory_counter_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('内存相关计数器可用性');
    expect(payload.promptContext).toContain('memory_counter_sample_count');
    expect(payload.promptContext).toContain('1411');
    expect(payload.promptContext).toContain('HWUI All Memory');
  });

  it('returns scheduler and thread-state data availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_scheduler_data_presence');
      expect(sql).toContain('FROM sched_slice');
      expect(sql).toContain('FROM thread_state');
      expect(sql).toContain("state = 'Running'");
      expect(sql).toContain("state IN ('R', 'R+')");
      expect(sql).toContain("state = 'R+'");
      expect(sql).toContain("state = 'S'");
      expect(sql).toContain("state IN ('D', 'DK')");
      expect(sql).toContain("state = 'I'");
      return {
        columns: [
          'sched_slice_count',
          'thread_state_count',
          'running_state_count',
          'runnable_state_count',
          'preempted_runnable_state_count',
          'sleeping_state_count',
          'uninterruptible_sleep_state_count',
          'idle_state_count',
          'source_table',
        ],
        rows: [[66756, 129368, 44698, 41267, 2743, 71302, 1884, 24, 'sched_slice,thread_state']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有调度数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('scheduler_data_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:scheduler_data_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('调度和线程状态数据可用性');
    expect(payload.promptContext).toContain('sched_slice_count');
    expect(payload.promptContext).toContain('66756');
    expect(payload.promptContext).toContain('thread_state_count');
    expect(payload.promptContext).toContain('preempted_runnable_state_count');
    expect(payload.promptContext).toContain('sleeping_state_count');
    expect(payload.promptContext).toContain('uninterruptible_sleep_state_count');
  });

  it('returns GPU slice and counter data availability evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_gpu_data_presence');
      expect(sql).toContain('FROM gpu_slice');
      expect(sql).toContain('FROM gpu_counter_track');
      expect(sql).toContain('JOIN gpu_counter_track t ON c.track_id = t.id');
      return {
        columns: [
          'gpu_slice_count',
          'gpu_counter_track_count',
          'gpu_counter_sample_count',
          'gpu_counter_names',
          'gpu_slice_names',
          'source_table',
        ],
        rows: [[0, 1, 12, 'gpufreq', '', 'gpu_slice,gpu_counter_track,counter']],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 GPU 数据吗？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('gpu_data_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:gpu_data_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('GPU slice 和 counter 数据可用性');
    expect(payload.promptContext).toContain('gpu_counter_sample_count');
    expect(payload.promptContext).toContain('12');
    expect(payload.promptContext).toContain('gpufreq');
  });

  it('falls back to observed CPU evidence when the cpu table has no rows', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      if (query.mock.calls.length === 1) {
        expect(sql).toContain('runtime_cpu_core_count_cpu_table');
        return {
          columns: [
            'observed_cpu_count',
            'observed_cpus',
            'universe_source',
            'cpu_table_count',
            'cpu_table_cpus',
            'source_table',
          ],
          rows: [],
          durationMs: 1,
        };
      }
      expect(sql).toContain('runtime_cpu_core_count_observed_fallback');
      expect(sql).toContain('FROM sched_slice');
      expect(sql).toContain('cpu_table_fallback_no_observed');
      return {
        columns: [
          'observed_cpu_count',
          'observed_cpus',
          'universe_source',
          'cpu_table_count',
          'cpu_table_cpus',
          'source_table',
        ],
        rows: [[
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'sched_observed',
          0,
          '',
          'sched_slice/thread_state',
        ]],
        durationMs: 3,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'CPU 有几核？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(payload.evidenceKind).toBe('cpu_core_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.promptContext).toContain('observed_cpu_count');
    expect(payload.promptContext).toContain('7');
  });

  it('returns observed thread count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_thread_count');
      expect(sql).toContain('FROM thread');
      expect(sql).toContain('COUNT(DISTINCT utid) AS thread_count');
      expect(sql).not.toContain('sample_threads');
      expect(sql).not.toContain('sample_thread_names');
      return {
        columns: [
          'thread_count',
          'process_count',
          'source_table',
        ],
        rows: [[
          142,
          12,
          'thread',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '线程数量是多少？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('thread_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:thread_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('观测到的线程数');
    expect(payload.promptContext).toContain('thread_count');
    expect(payload.promptContext).toContain('142');
  });

  it('returns focus-app thread count evidence with package filtering for app-scoped questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_app_process_thread_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.process_metadata');
      expect(sql).toContain('LEFT JOIN android_process_metadata');
      expect(sql).toContain("= 'com.example.app'");
      expect(sql).toContain("LIKE 'com.example.app' || ':%'");
      expect(sql).toContain('COUNT(DISTINCT t.utid) AS thread_count');
      expect(sql).toContain('process_thread_counts');
      expect(sql).not.toContain('runtime_thread_count');
      expect(sql).not.toContain('HAVING COUNT(DISTINCT utid) > 0');
      return {
        columns: [
          'package_name',
          'process_count',
          'thread_count',
          'process_names',
          'process_thread_counts',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          2,
          18,
          'com.example.app,com.example.app:remote',
          '15,3',
          'process,thread,android_process_metadata',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '焦点应用有多少线程？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
    });

    expect(payload.evidenceKind).toBe('app_thread_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:app_thread_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('焦点应用线程数');
    expect(payload.promptContext).toContain('package_name');
    expect(payload.promptContext).toContain('thread_count');
    expect(payload.promptContext).toContain('com.example.app');
    expect(payload.promptContext).toContain('18');
  });

  it('returns observed process count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_process_count');
      expect(sql).toContain('FROM process');
      expect(sql).toContain('COUNT(*) AS process_count');
      expect(sql).toContain('LEFT JOIN thread');
      expect(sql).toContain('process_names');
      expect(sql).toContain('omitted_process_count');
      return {
        columns: [
          'process_count',
          'listed_process_count',
          'process_names',
          'process_thread_counts',
          'omitted_process_count',
          'source_table',
        ],
        rows: [[
          12,
          3,
          'system_server,com.example.app,com.android.systemui',
          '45,12,9',
          9,
          'process,thread',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有多少个进程？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('process_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:process_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('观测到的进程数');
    expect(payload.promptContext).toContain('process_count');
    expect(payload.promptContext).toContain('12');
    expect(payload.promptContext).toContain('process_names');
    expect(payload.promptContext).toContain('system_server');
  });

  it('returns focus-app process count evidence with package filtering for app-scoped questions', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_app_process_thread_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.process_metadata');
      expect(sql).toContain('LEFT JOIN android_process_metadata');
      expect(sql).toContain("= 'com.example.app'");
      expect(sql).toContain("LIKE 'com.example.app' || ':%'");
      expect(sql).toContain('COUNT(DISTINCT upid) AS process_count');
      expect(sql).toContain('process_thread_counts');
      expect(sql).not.toContain('runtime_process_count');
      expect(sql).not.toContain('omitted_process_count');
      return {
        columns: [
          'package_name',
          'process_count',
          'thread_count',
          'process_names',
          'process_thread_counts',
          'source_table',
        ],
        rows: [[
          'com.example.app',
          2,
          18,
          'com.example.app,com.example.app:remote',
          '15,3',
          'process,thread,android_process_metadata',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '焦点应用有多少进程？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
    });

    expect(payload.evidenceKind).toBe('app_process_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:app_process_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('焦点应用进程数');
    expect(payload.promptContext).toContain('package_name');
    expect(payload.promptContext).toContain('process_count');
    expect(payload.promptContext).toContain('com.example.app');
    expect(payload.promptContext).toContain('2');
  });

  it('returns Binder transaction count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_binder_transaction_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.binder');
      expect(sql).toContain('FROM android_binder_txns');
      expect(sql).toContain('COUNT(*) AS binder_txn_count');
      expect(sql).toContain('SUM(client_dur)');
      return {
        columns: [
          'binder_txn_count',
          'sync_count',
          'async_count',
          'total_client_ms',
          'max_client_ms',
          'source_table',
        ],
        rows: [[
          2930,
          912,
          2018,
          2226.42,
          176.38,
          'android_binder_txns',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'Binder 调用次数是多少？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('binder_transaction_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:binder_transaction_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('Binder Transaction 数量');
    expect(payload.promptContext).toContain('binder_txn_count');
    expect(payload.promptContext).toContain('2930');
    expect(payload.promptContext).toContain('android_binder_txns');
  });

  it('returns ANR presence evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_anr_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.anrs');
      expect(sql).toContain('FROM android_anrs');
      expect(sql).toContain('COUNT(*) AS total_anr_count');
      expect(sql).toContain('GROUP_CONCAT(DISTINCT COALESCE(anr_type');
      return {
        columns: [
          'total_anr_count',
          'affected_process_count',
          'first_anr_ts',
          'last_anr_ts',
          'anr_span_seconds',
          'anr_types',
          'source_table',
        ],
        rows: [[
          0,
          0,
          null,
          null,
          null,
          '',
          'android_anrs',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 ANR？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('anr_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:anr_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('ANR 存在性');
    expect(payload.promptContext).toContain('total_anr_count');
    expect(payload.promptContext).toContain('android_anrs');
  });

  it('returns app startup presence evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_startup_presence');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.startup.startups');
      expect(sql).toContain('FROM android_startups');
      expect(sql).toContain('COUNT(*) AS startup_count');
      expect(sql).toContain('WHERE dur > 0');
      return {
        columns: [
          'startup_count',
          'packages',
          'startup_types',
          'first_startup_ts',
          'last_startup_ts',
          'total_startup_ms',
          'max_startup_ms',
          'source_table',
        ],
        rows: [[
          1,
          'com.example.androidappdemo',
          'cold',
          1_000_000_000,
          1_000_000_000,
          301.84,
          301.84,
          'android_startups',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '启动次数是多少？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('startup_presence');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:startup_presence',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('App 启动事件存在性');
    expect(payload.promptContext).toContain('startup_count');
    expect(payload.promptContext).toContain('com.example.androidappdemo');
    expect(payload.promptContext).toContain('android_startups');
  });

  it('returns scroll gesture count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_scroll_gesture_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.input');
      expect(sql).toContain('FROM android_input_events');
      expect(sql).toContain('move_count >= 3');
      expect(sql).toContain('scroll_start_count');
      return {
        columns: [
          'scroll_gesture_count',
          'scroll_start_count',
          'first_scroll_ts',
          'last_scroll_ts',
          'max_move_count',
          'process_names',
          'source_table',
          'heuristic',
        ],
        rows: [[
          2,
          2,
          506_731_587_003_811,
          506_734_643_167_039,
          16,
          'com.example.wechatfriendforcustomscroller',
          'android_input_events',
          'scene_reconstruction.user_gestures(move_count>=3)',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有几次滑动？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('scroll_gesture_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:scroll_gesture_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('滑动手势数量');
    expect(payload.promptContext).toContain('scroll_gesture_count');
    expect(payload.promptContext).toContain('2');
    expect(payload.promptContext).toContain('scene_reconstruction.user_gestures');
  });

  it('returns input event count evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_input_event_count');
      expect(sql).toContain('INCLUDE PERFETTO MODULE android.input');
      expect(sql).toContain('FROM android_input_events');
      expect(sql).toContain('COUNT(*) AS input_event_count');
      expect(sql).toContain("event_type = 'MOTION'");
      return {
        columns: [
          'input_event_count',
          'motion_event_count',
          'key_event_count',
          'process_count',
          'first_input_ts',
          'last_input_ts',
          'process_names',
          'source_table',
        ],
        rows: [[
          140,
          140,
          0,
          2,
          506_731_587_003_811,
          506_734_643_167_039,
          'com.example.wechatfriendforcustomscroller,system_server',
          'android_input_events',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '输入事件数量是多少？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('input_event_count');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:input_event_count',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('输入事件数量');
    expect(payload.promptContext).toContain('input_event_count');
    expect(payload.promptContext).toContain('140');
    expect(payload.promptContext).toContain('android_input_events');
  });

  it('returns device metadata evidence without requiring a focus app', async () => {
    const query = jest.fn<QueryTrace>(async (_traceId, sql) => {
      expect(sql).toContain('runtime_device_info');
      expect(sql).toContain('android_device_manufacturer');
      expect(sql).toContain('FROM metadata');
      return {
        columns: [
          'android_device_manufacturer',
          'android_build_fingerprint',
          'android_sdk_version',
          'android_soc_model',
          'system_name',
          'system_release',
          'system_machine',
          'source_table',
        ],
        rows: [[
          'OPPO',
          'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376:user/release-keys',
          36,
          'SM8750',
          'Linux',
          '6.6.89-android15',
          'aarch64',
          'metadata',
        ]],
        durationMs: 2,
      };
    });

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '设备型号是什么？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(payload.evidenceKind).toBe('device_info');
    expect(payload.envelopes).toHaveLength(1);
    expect(payload.envelopes[0].meta).toMatchObject({
      source: 'runtime_trace_fact:device_info',
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
    });
    expect(payload.promptContext).toContain('设备和系统元数据');
    expect(payload.promptContext).toContain('android_device_manufacturer');
    expect(payload.promptContext).toContain('OPPO');
  });

  it('skips frame metric evidence when no package identity is available', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [],
      rows: [],
      durationMs: 0,
    }));

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '滑动 FPS 是多少？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).not.toHaveBeenCalled();
    expect(payload).toEqual({ envelopes: [], evidenceKind: 'frame_metrics' });
  });

  it('skips jank presence evidence when no package identity is available', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [],
      rows: [],
      durationMs: 0,
    }));

    const payload = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有掉帧？',
      focusResult: { method: 'none', apps: [] },
    });

    expect(query).not.toHaveBeenCalled();
    expect(payload).toEqual({ envelopes: [], evidenceKind: 'jank_presence' });
  });
});

describe('buildQuickTraceFactDirectAnswer', () => {
  it('builds a multi-row verifier-backed answer for the issue #235 longest-slice query', async () => {
    const query = jest.fn<QueryTrace>();
    const rows = [
      ['100', '50000000', 50, 'slice-a', 'process-a', 'thread-a', 'thread_track'],
      ['200', '40000000', 40, 'slice-b', 'process-b', '<process track>', 'process_track'],
      ['300', '30000000', 30, 'slice-c', 'process-c', 'thread-c', 'thread_track'],
      ['400', '20000000', 20, 'slice-d', 'process-d', '<process track>', 'process_track'],
      ['500', '10000000', 10, 'slice-e', 'process-e', 'thread-e', 'thread_track'],
    ];
    const execute = jest.fn(async (
      _skillId: string,
      _traceId: string,
      _params?: Record<string, unknown>,
      _inherited?: Record<string, unknown>,
    ) => ({
      skillId: 'longest_process_slices',
      skillName: 'Longest Process Slices',
      success: true,
      displayResults: [{
        stepId: 'root',
        title: 'Longest Process Slices',
        level: 'detail',
        format: 'table',
        data: {
          columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name', 'track_scope'],
          rows,
        },
      }],
      diagnostics: [],
      executionTimeMs: 1,
    } as any));

    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      skillExecutor: { execute },
      traceId: 'trace-1',
      query: 'summarize top-5 longest process slices',
      outputLanguage: 'en',
    });
    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'en',
    });

    expect(query).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      'longest_process_slices',
      'trace-1',
      expect.objectContaining({ max_rows: 5 }),
      expect.any(Object),
    );
    expect(evidence.evidenceKind).toBe('longest_process_slices');
    expect(evidence.envelopes[0].data.rows).toHaveLength(5);
    expect(evidence.envelopes[0].meta.evidenceRefId)
      .toMatch(/^data:skill:longest_process_slices:current:[a-f0-9]{12}:root$/);
    expect(direct?.conclusion).toContain('The 5 longest process slices');
    expect(direct?.conclusion).toContain('5. slice-e — 10 ms');
    expect(direct?.conclusion).toContain('track_scope=`process_track`');
    expect(direct?.conclusionContract.evidenceChain?.[0].text)
      .toContain('track_scope=thread_track');

    const references = direct?.conclusionContract.claims?.[0].references ?? [];
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowIndex: 0, column: 'slice_name', value: 'slice-a' }),
      expect.objectContaining({ rowIndex: 4, column: 'duration_ms', value: 10 }),
      expect.objectContaining({ rowIndex: 4, column: 'process_name', value: 'process-e' }),
      expect.objectContaining({ rowIndex: 1, column: 'track_scope', value: 'process_track' }),
    ]));
    expect(new Set(references.map(reference => reference.rowIndex))).toEqual(new Set([0, 1, 2, 3, 4]));

    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it.each([
    {
      name: 'missing track scope',
      columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name'],
      row: ['100', '50000000', 50, 'slice-a', 'process-a', 'thread-a'],
    },
    {
      name: 'generic track scope',
      columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name', 'track_scope'],
      row: ['100', '50000000', 50, 'slice-a', 'process-a', 'track-a', 'generic_track'],
    },
    {
      name: 'fabricated process-track thread',
      columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name', 'track_scope'],
      row: ['100', '50000000', 50, 'slice-a', 'process-a', 'fake-thread', 'process_track'],
    },
    {
      name: 'thread track using the process-track marker',
      columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name', 'track_scope'],
      row: ['100', '50000000', 50, 'slice-a', 'process-a', '<process track>', 'thread_track'],
    },
    {
      name: 'thread track with an empty thread name',
      columns: ['ts', 'dur_ns', 'duration_ms', 'slice_name', 'process_name', 'thread_name', 'track_scope'],
      row: ['100', '50000000', 50, 'slice-a', 'process-a', '', 'thread_track'],
    },
  ])('rejects longest-slice evidence with $name', async ({ columns, row }) => {
    const execute = jest.fn(async () => ({
      skillId: 'longest_process_slices',
      skillName: 'Longest Process Slices',
      success: true,
      displayResults: [{
        stepId: 'root',
        title: 'Longest Process Slices',
        level: 'detail',
        format: 'table',
        data: { columns, rows: [row] },
      }],
      diagnostics: [],
      executionTimeMs: 1,
    } as any));

    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query: jest.fn<QueryTrace>() },
      skillExecutor: { execute },
      traceId: 'trace-1',
      query: 'summarize top-5 longest process slices',
      outputLanguage: 'en',
    });

    expect(evidence).toEqual({
      envelopes: [],
      evidenceKind: 'longest_process_slices',
    });
    expect(buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'en',
    })).toBeUndefined();
  });

  it('answers selected-range duration with verifier-backed selection evidence', () => {
    const payload = {
      evidenceKind: 'selection_duration' as const,
      promptContext: 'selection duration context',
      envelopes: [traceFactEnvelope({
        evidenceKind: 'selection_duration',
        traceId: 'trace-1',
        columns: ['scope', 'scope_start_ns', 'scope_end_ns', 'duration_ns', 'duration_s', 'source_table'],
        rows: [['selection', 1_000_000_000, 3_500_000_000, 2_500_000_000, 2.5, 'selection_context']],
      })],
    };

    const direct = buildQuickTraceFactDirectAnswer({
      evidence: payload,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('当前选区的起止时间为 1000000000-3500000000 ns');
    expect(direct?.conclusion).toContain('时长约 2.5 秒');
    expect(direct?.conclusionContract.claims?.[0].references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'scope_start_ns', value: 1_000_000_000 }),
        expect.objectContaining({ column: 'scope_end_ns', value: 3_500_000_000 }),
        expect.objectContaining({ column: 'duration_ns', value: 2_500_000_000 }),
        expect.objectContaining({ column: 'duration_s', value: 2.5 }),
      ]),
    );

    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: payload.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for trace timing bounds', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: ['trace_start_ns', 'trace_end_ns', 'trace_start_s', 'trace_end_s', 'duration_s', 'source_table'],
      rows: [[100, 2_500_000_100, 0.000000, 2.5, 2.5, 'trace_bounds']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 的起止时间是多少？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('trace_duration');
    expect(direct?.conclusion).toContain('起止时间为 0-2.5 秒');
    expect(direct?.conclusion).toContain('录制时长约 2.5 秒');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'trace_start_s',
      value: 0,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'trace_end_s',
      value: 2.5,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'duration_s',
      value: 2.5,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for observed CPU core count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'observed_cpu_count',
        'observed_cpus',
        'universe_source',
        'cpu_table_count',
        'cpu_table_cpus',
        'source_table',
      ],
      rows: [[
        7,
        '0, 1, 2, 3, 4, 5, 6',
        'sched_observed',
        7,
        '0, 1, 2, 3, 4, 5, 6',
        'sched_slice/thread_state',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'CPU 有几核？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('7 个 CPU 核心');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims).toHaveLength(1);
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for CPU frequency counter availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'cpufreq_cpu_count',
        'cpufreq_sample_count',
        'cpufreq_cpus',
        'min_freq_khz',
        'max_freq_khz',
        'first_sample_ts',
        'last_sample_ts',
        'source_table',
      ],
      rows: [[
        8,
        848,
        '0, 1, 2, 3, 4, 5, 6, 7',
        300000,
        3187200,
        1_000_000,
        2_000_000,
        'cpu_counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 CPU 频率数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('cpu_frequency_presence');
    expect(direct?.conclusion).toContain('采集到了 CPU 频率计数器数据');
    expect(direct?.conclusion).toContain('共有 848 个 cpufreq 样本');
    expect(direct?.conclusion).toContain('300000-3187200 kHz');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'cpufreq_sample_count',
      value: 848,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'max_freq_khz',
      value: 3187200,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when CPU frequency counters are absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'cpufreq_cpu_count',
        'cpufreq_sample_count',
        'cpufreq_cpus',
        'min_freq_khz',
        'max_freq_khz',
        'first_sample_ts',
        'last_sample_ts',
        'source_table',
      ],
      rows: [[
        0,
        0,
        '',
        0,
        0,
        null,
        null,
        'cpu_counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 cpufreq counters?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('cpu_frequency_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的 CPU 频率计数器数据');
    expect(direct?.conclusion).toContain('不等同于证明设备没有频率变化或 DVFS 行为');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'cpufreq_sample_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for power and battery counter availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'power_counter_track_count',
        'power_counter_sample_count',
        'power_counter_names',
        'power_counter_sample_counts',
        'source_table',
      ],
      rows: [[
        4,
        728,
        'PowerMode 4630946602912453524,PowerMode 4630946929504945811,BatteryChargeCounter,BatteryCurrent',
        '365,365,1,1',
        'counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有功耗数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('power_counter_presence');
    expect(direct?.conclusion).toContain('采集到了功耗/电量相关计数器数据');
    expect(direct?.conclusion).toContain('共 728 个样本');
    expect(direct?.conclusion).toContain('BatteryChargeCounter=1');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'power_counter_sample_count',
      value: 728,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'power_counter_names',
      value: 'PowerMode 4630946602912453524,PowerMode 4630946929504945811,BatteryChargeCounter,BatteryCurrent',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when power and battery counters are absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'power_counter_track_count',
        'power_counter_sample_count',
        'power_counter_names',
        'power_counter_sample_counts',
        'source_table',
      ],
      rows: [[
        0,
        0,
        '',
        '',
        'counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有电量计数器？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('power_counter_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的功耗/电量相关 counter 数据');
    expect(direct?.conclusion).toContain('不等同于证明设备没有耗电或功耗问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'power_counter_sample_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for memory counter availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'memory_counter_track_count',
        'memory_counter_sample_count',
        'memory_counter_names',
        'memory_counter_sample_counts',
        'memory_counter_max_values',
        'source_table',
      ],
      rows: [[
        5,
        1411,
        'HWUI All Memory,HWUI CPU Memory,HWUI Misc Memory,Purgeable HWUI Misc Memory,Bitmap Memory',
        '350,350,350,350,11',
        '17543280,12783428,14841544,11968316,77992790',
        'process_counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有内存数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('memory_counter_presence');
    expect(direct?.conclusion).toContain('采集到了内存相关计数器数据');
    expect(direct?.conclusion).toContain('共 1411 个样本');
    expect(direct?.conclusion).toContain('HWUI All Memory=350');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'memory_counter_sample_count',
      value: 1411,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'memory_counter_names',
      value: 'HWUI All Memory,HWUI CPU Memory,HWUI Misc Memory,Purgeable HWUI Misc Memory,Bitmap Memory',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when memory counters are absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'memory_counter_track_count',
        'memory_counter_sample_count',
        'memory_counter_names',
        'memory_counter_sample_counts',
        'memory_counter_max_values',
        'source_table',
      ],
      rows: [[
        0,
        0,
        '',
        '',
        '',
        'process_counter_track,counter',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有内存计数器？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('memory_counter_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的内存相关 process counter 数据');
    expect(direct?.conclusion).toContain('不等同于证明应用没有内存问题、内存压力或 OOM 风险');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'memory_counter_sample_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for scheduler data availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'sched_slice_count',
        'thread_state_count',
        'running_state_count',
        'runnable_state_count',
        'preempted_runnable_state_count',
        'sleeping_state_count',
        'uninterruptible_sleep_state_count',
        'idle_state_count',
        'source_table',
      ],
      rows: [[66756, 129368, 44698, 41267, 2743, 71302, 1884, 24, 'sched_slice,thread_state']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有调度数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('scheduler_data_presence');
    expect(direct?.conclusion).toContain('采集到了调度/线程状态数据');
    expect(direct?.conclusion).toContain('sched_slice 66756 行');
    expect(direct?.conclusion).toContain('thread_state 129368 行');
    expect(direct?.conclusion).toContain('Runnable(R/R+) 状态 41267 行');
    expect(direct?.conclusion).toContain('R+ 抢占等待 2743 行');
    expect(direct?.conclusion).toContain('Sleeping(S) 状态 71302 行');
    expect(direct?.conclusion).toContain('Uninterruptible(D/DK) 状态 1884 行');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'sched_slice_count',
      value: 66756,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'thread_state_count',
      value: 129368,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'preempted_runnable_state_count',
      value: 2743,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'sleeping_state_count',
      value: 71302,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'uninterruptible_sleep_state_count',
      value: 1884,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when scheduler data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'sched_slice_count',
        'thread_state_count',
        'running_state_count',
        'runnable_state_count',
        'preempted_runnable_state_count',
        'sleeping_state_count',
        'uninterruptible_sleep_state_count',
        'idle_state_count',
        'source_table',
      ],
      rows: [[0, 0, 0, 0, 0, 0, 0, 0, 'sched_slice,thread_state']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 sched_slice 数据？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('scheduler_data_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的调度/线程状态数据');
    expect(direct?.conclusion).toContain('不等同于证明系统没有调度等待、抢占或线程状态问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'sched_slice_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for R+ thread-state count queries', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'sched_slice_count',
        'thread_state_count',
        'running_state_count',
        'runnable_state_count',
        'preempted_runnable_state_count',
        'sleeping_state_count',
        'uninterruptible_sleep_state_count',
        'idle_state_count',
        'source_table',
      ],
      rows: [[66756, 129368, 44698, 44010, 2743, 29519, 5305, 5747, 'sched_slice,thread_state']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'how many R+ thread states are in this trace?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('scheduler_data_presence');
    expect(direct?.conclusion).toContain('R+ 抢占等待 2743 行');
    expect(direct?.conclusion).toContain('Runnable(R/R+) 状态 44010 行');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'preempted_runnable_state_count',
      value: 2743,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for GPU data availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'gpu_slice_count',
        'gpu_counter_track_count',
        'gpu_counter_sample_count',
        'gpu_counter_names',
        'gpu_slice_names',
        'source_table',
      ],
      rows: [[0, 1, 12, 'gpufreq', '', 'gpu_slice,gpu_counter_track,counter']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 GPU 数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('gpu_data_presence');
    expect(direct?.conclusion).toContain('采集到了 GPU 相关数据');
    expect(direct?.conclusion).toContain('gpu_slice 0 行');
    expect(direct?.conclusion).toContain('GPU counter 样本 12 个');
    expect(direct?.conclusion).toContain('gpufreq');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'gpu_counter_sample_count',
      value: 12,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'gpu_counter_names',
      value: 'gpufreq',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('counts GPU counter tracks as GPU-related records even when no counter samples exist', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'gpu_slice_count',
        'gpu_counter_track_count',
        'gpu_counter_sample_count',
        'gpu_counter_names',
        'gpu_slice_names',
        'source_table',
      ],
      rows: [[0, 1, 0, 'gpufreq', '', 'gpu_slice,gpu_counter_track,counter']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 GPU counter？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('gpu_data_presence');
    expect(direct?.conclusion).toContain('采集到了 GPU 相关数据');
    expect(direct?.conclusion).toContain('GPU counter track 1 个');
    expect(direct?.conclusion).toContain('GPU counter 样本 0 个');
    expect(direct?.conclusion).toContain('gpufreq');
  });

  it('builds a cautious verifier-backed direct answer when GPU data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'gpu_slice_count',
        'gpu_counter_track_count',
        'gpu_counter_sample_count',
        'gpu_counter_names',
        'gpu_slice_names',
        'source_table',
      ],
      rows: [[0, 0, 0, '', '', 'gpu_slice,gpu_counter_track,counter']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 GPU counter？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('gpu_data_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的 GPU slice/counter 数据');
    expect(direct?.conclusion).toContain('不等同于证明设备没有 GPU 渲染、负载或图形性能问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'gpu_counter_sample_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for observed thread count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'thread_count',
        'process_count',
        'source_table',
      ],
      rows: [[
        142,
        12,
        'thread',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '线程数量是多少？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('142 个线程');
    expect(direct?.conclusion).toContain('12 个进程');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'thread_count',
      value: 142,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for focus-app thread count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_count',
        'thread_count',
        'process_names',
        'process_thread_counts',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        2,
        18,
        'com.example.app,com.example.app:remote',
        '15,3',
        'process,thread,android_process_metadata',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '焦点应用有多少线程？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('app_thread_count');
    expect(direct?.conclusion).toContain('焦点应用 com.example.app');
    expect(direct?.conclusion).toContain('18 个线程');
    expect(direct?.conclusion).toContain('2 个进程');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'package_name',
      value: 'com.example.app',
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'thread_count',
      value: 18,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for observed process count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'process_count',
        'listed_process_count',
        'process_names',
        'process_thread_counts',
        'omitted_process_count',
        'source_table',
      ],
      rows: [[
        12,
        3,
        'system_server,com.example.app,com.android.systemui',
        '45,12,9',
        9,
        'process,thread',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有多少个进程？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('12 个进程');
    expect(direct?.conclusion).toContain('前 3 个进程包括');
    expect(direct?.conclusion).toContain('system_server（45 线程）');
    expect(direct?.conclusion).toContain('另有 9 个进程未列出');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'process_count',
      value: 12,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'process_names',
      value: 'system_server,com.example.app,com.android.systemui',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for focus-app process count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_count',
        'thread_count',
        'process_names',
        'process_thread_counts',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        2,
        18,
        'com.example.app,com.example.app:remote',
        '15,3',
        'process,thread,android_process_metadata',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '焦点应用有多少进程？',
      focusResult: {
        primaryApp: 'com.example.app',
        method: 'frame_timeline',
        apps: [{
          packageName: 'com.example.app',
          totalDurationNs: 4_449_374_956,
          switchCount: 347,
        }],
      },
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('app_process_count');
    expect(direct?.conclusion).toContain('焦点应用 com.example.app');
    expect(direct?.conclusion).toContain('2 个进程');
    expect(direct?.conclusion).toContain('18 个线程');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'package_name',
      value: 'com.example.app',
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'process_count',
      value: 2,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for Binder transaction count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'binder_txn_count',
        'sync_count',
        'async_count',
        'total_client_ms',
        'max_client_ms',
        'source_table',
      ],
      rows: [[
        2930,
        912,
        2018,
        2226.42,
        176.38,
        'android_binder_txns',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'how many Binder transactions?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('binder_transaction_count');
    expect(direct?.conclusion).toContain('2930 次 Binder transaction');
    expect(direct?.conclusion).toContain('912 次同步');
    expect(direct?.conclusion).toContain('2018 次异步');
    expect(direct?.conclusion).toContain('2226.42 ms');
    expect(direct?.conclusion).toContain('176.38 ms');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'binder_txn_count',
      value: 2930,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'android_binder_txns',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a direct answer when no Binder transactions are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'binder_txn_count',
        'sync_count',
        'async_count',
        'total_client_ms',
        'max_client_ms',
        'source_table',
      ],
      rows: [[
        0,
        0,
        0,
        0,
        0,
        'android_binder_txns',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 Binder 调用？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('未记录到 Binder transaction');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'binder_txn_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for positive ANR presence evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'total_anr_count',
        'affected_process_count',
        'first_anr_ts',
        'last_anr_ts',
        'anr_span_seconds',
        'anr_types',
        'source_table',
      ],
      rows: [[
        2,
        1,
        1_000_000_000,
        6_000_000_000,
        5,
        'INPUT_DISPATCHING_TIMEOUT',
        'android_anrs',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'ANR 数量是多少？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('anr_presence');
    expect(direct?.conclusion).toContain('2 个系统 ANR 事件');
    expect(direct?.conclusion).toContain('影响 1 个进程');
    expect(direct?.conclusion).toContain('INPUT_DISPATCHING_TIMEOUT');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'total_anr_count',
      value: 2,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'android_anrs',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer when no ANR events are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'total_anr_count',
        'affected_process_count',
        'first_anr_ts',
        'last_anr_ts',
        'anr_span_seconds',
        'anr_types',
        'source_table',
      ],
      rows: [[
        0,
        0,
        null,
        null,
        null,
        '',
        'android_anrs',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 ANR？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('android_anrs 未记录到系统 ANR 事件');
    expect(direct?.conclusion).toContain('不等同于证明采集范围之外从未发生 ANR');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'total_anr_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for positive app startup presence evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'startup_count',
        'packages',
        'startup_types',
        'first_startup_ts',
        'last_startup_ts',
        'total_startup_ms',
        'max_startup_ms',
        'source_table',
      ],
      rows: [[
        1,
        'com.example.androidappdemo',
        'cold',
        1_000_000_000,
        1_000_000_000,
        301.84,
        301.84,
        'android_startups',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '启动次数是多少？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('startup_presence');
    expect(direct?.conclusion).toContain('1 个 duration > 0 的 App 启动事件');
    expect(direct?.conclusion).toContain('com.example.androidappdemo');
    expect(direct?.conclusion).toContain('cold');
    expect(direct?.conclusion).toContain('301.84 ms');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'startup_count',
      value: 1,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'android_startups',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer when no complete app startup events are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'startup_count',
        'packages',
        'startup_types',
        'first_startup_ts',
        'last_startup_ts',
        'total_startup_ms',
        'max_startup_ms',
        'source_table',
      ],
      rows: [[
        0,
        '',
        '',
        null,
        null,
        0,
        0,
        'android_startups',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有启动事件？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('android_startups 未记录到 duration > 0 的 App 启动事件');
    expect(direct?.conclusion).toContain('不等同于证明采集范围之外没有发生启动');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'startup_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for positive scroll gesture count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'scroll_gesture_count',
        'scroll_start_count',
        'first_scroll_ts',
        'last_scroll_ts',
        'max_move_count',
        'process_names',
        'source_table',
        'heuristic',
      ],
      rows: [[
        2,
        2,
        506_731_587_003_811,
        506_734_643_167_039,
        16,
        'com.example.wechatfriendforcustomscroller',
        'android_input_events',
        'scene_reconstruction.user_gestures(move_count>=3)',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有几次滑动？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('scroll_gesture_count');
    expect(direct?.conclusion).toContain('识别到 2 次滑动手势');
    expect(direct?.conclusion).toContain('滑动启动为 2 次');
    expect(direct?.conclusion).toContain('单次最多 16 个 MOVE 事件');
    expect(direct?.conclusion).toContain('com.example.wechatfriendforcustomscroller');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scroll_gesture_count',
      value: 2,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'heuristic',
      value: 'scene_reconstruction.user_gestures(move_count>=3)',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer when no scroll gestures are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'scroll_gesture_count',
        'scroll_start_count',
        'first_scroll_ts',
        'last_scroll_ts',
        'max_move_count',
        'process_names',
        'source_table',
        'heuristic',
      ],
      rows: [[
        0,
        0,
        null,
        null,
        0,
        '',
        'android_input_events',
        'scene_reconstruction.user_gestures(move_count>=3)',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有滑动？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('未识别到满足 move_count >= 3 的滑动手势');
    expect(direct?.conclusion).toContain('不等同于证明采集范围之外没有滑动');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'scroll_gesture_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for positive input event count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'input_event_count',
        'motion_event_count',
        'key_event_count',
        'process_count',
        'first_input_ts',
        'last_input_ts',
        'process_names',
        'source_table',
      ],
      rows: [[
        140,
        140,
        0,
        2,
        506_731_587_003_811,
        506_734_643_167_039,
        'com.example.wechatfriendforcustomscroller,system_server',
        'android_input_events',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '输入事件数量是多少？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('input_event_count');
    expect(direct?.conclusion).toContain('记录了 140 个可解析输入事件');
    expect(direct?.conclusion).toContain('MOTION 140 个');
    expect(direct?.conclusion).toContain('KEY 0 个');
    expect(direct?.conclusion).toContain('覆盖 2 个进程');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'input_event_count',
      value: 140,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'android_input_events',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer when no input events are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'input_event_count',
        'motion_event_count',
        'key_event_count',
        'process_count',
        'first_input_ts',
        'last_input_ts',
        'process_names',
        'source_table',
      ],
      rows: [[
        0,
        0,
        0,
        0,
        null,
        null,
        '',
        'android_input_events',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有输入事件？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('未记录到可解析输入事件');
    expect(direct?.conclusion).toContain('不等同于证明采集范围之外没有输入');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'input_event_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for device metadata evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'android_device_manufacturer',
        'android_build_fingerprint',
        'android_sdk_version',
        'android_soc_model',
        'system_name',
        'system_release',
        'system_machine',
        'source_table',
      ],
      rows: [[
        'OPPO',
        'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376:user/release-keys',
        36,
        'SM8750',
        'Linux',
        '6.6.89-android15',
        'aarch64',
        'metadata',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '设备型号是什么？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('trace metadata 记录');
    expect(direct?.conclusion).toContain('设备制造商为 OPPO');
    expect(direct?.conclusion).toContain('Android SDK为 36');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'android_device_manufacturer',
      value: 'OPPO',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for trace health issues', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'issue_stat_count',
        'error_stat_count',
        'data_loss_stat_count',
        'total_issue_value',
        'issue_names',
        'issue_values',
        'issue_severities',
        'source_table',
      ],
      rows: [[
        1,
        1,
        0,
        7,
        'trace_sorter_negative_timestamp_dropped',
        '7',
        'error',
        'stats',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有采集错误吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('trace_health_issues');
    expect(direct?.conclusion).toContain('记录了 1 类 trace health issue');
    expect(direct?.conclusion).toContain('trace_sorter_negative_timestamp_dropped=7 (error)');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'issue_stat_count',
      value: 1,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'issue_names',
      value: 'trace_sorter_negative_timestamp_dropped',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when no trace health issues are recorded', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'issue_stat_count',
        'error_stat_count',
        'data_loss_stat_count',
        'total_issue_value',
        'issue_names',
        'issue_values',
        'issue_severities',
        'source_table',
      ],
      rows: [[
        0,
        0,
        0,
        0,
        '',
        '',
        '',
        'stats',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 trace health issues?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('trace_health_issues');
    expect(direct?.conclusion).toContain('未记录 severity=error/data_loss 且 value > 0 的 trace health issue');
    expect(direct?.conclusion).toContain('不等同于证明应用没有性能问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'issue_stat_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for FrameTimeline data availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'actual_frame_timeline_slice_count',
        'expected_frame_timeline_slice_count',
        'janky_actual_frame_count',
        'actual_frame_upid_count',
        'source_table',
      ],
      rows: [[697, 697, 21, 3, 'actual_frame_timeline_slice,expected_frame_timeline_slice']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 FrameTimeline 数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('frame_timeline_presence');
    expect(direct?.conclusion).toContain('采集到了 FrameTimeline 数据');
    expect(direct?.conclusion).toContain('actual_frame_timeline_slice 697 行');
    expect(direct?.conclusion).toContain('expected_frame_timeline_slice 697 行');
    expect(direct?.conclusion).toContain('21 行 actual frame 标记为 jank');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'actual_frame_timeline_slice_count',
      value: 697,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'janky_actual_frame_count',
      value: 21,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when FrameTimeline data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'actual_frame_timeline_slice_count',
        'expected_frame_timeline_slice_count',
        'janky_actual_frame_count',
        'actual_frame_upid_count',
        'source_table',
      ],
      rows: [[0, 0, 0, 0, 'actual_frame_timeline_slice,expected_frame_timeline_slice']],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有 actual_frame_timeline_slice 表？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('frame_timeline_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的 FrameTimeline 数据');
    expect(direct?.conclusion).toContain('不等同于证明设备没有渲染、掉帧或图形性能问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'actual_frame_timeline_slice_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for generic slice and track data availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'slice_count',
        'track_count',
        'process_track_count',
        'thread_track_count',
        'source_table',
      ],
      rows: [[101278, 771, 65, 403, 'slice,track,process_track,thread_track']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 slice 数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('slice_data_presence');
    expect(direct?.conclusion).toContain('采集到了通用 slice/track 时间线数据');
    expect(direct?.conclusion).toContain('slice 101278 行');
    expect(direct?.conclusion).toContain('track 771 行');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'slice_count',
      value: 101278,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'thread_track_count',
      value: 403,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when generic slice and track data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'slice_count',
        'track_count',
        'process_track_count',
        'thread_track_count',
        'source_table',
      ],
      rows: [[0, 0, 0, 0, 'slice,track,process_track,thread_track']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'does this trace have slice rows?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('slice_data_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的通用 slice/track 时间线数据');
    expect(direct?.conclusion).toContain('不等同于证明 trace 没有其他事件或性能问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'slice_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for common trace data inventory', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'trace_start_ns',
        'trace_end_ns',
        'duration_s',
        'slice_count',
        'track_count',
        'process_track_count',
        'thread_track_count',
        'process_count',
        'thread_count',
        'sched_slice_count',
        'thread_state_count',
        'counter_track_count',
        'process_counter_track_count',
        'cpu_counter_track_count',
        'gpu_counter_track_count',
        'counter_sample_count',
        'cpufreq_sample_count',
        'actual_frame_timeline_slice_count',
        'expected_frame_timeline_slice_count',
        'gpu_slice_count',
        'gpu_counter_sample_count',
        'network_packet_event_count',
        'android_log_count',
        'source_table',
      ],
      rows: [[100, 5_100_000_000, 5, 101_278, 771, 65, 403, 1031, 12_891, 66_756, 129_368, 303, 227, 70, 0, 90_275, 1255, 697, 697, 0, 0, 0, 123, 'trace_bounds,slice,track,process,thread,sched_slice,thread_state,counter_track,process_counter_track,cpu_counter_track,gpu_counter_track,counter,actual_frame_timeline_slice,expected_frame_timeline_slice,gpu_slice,android_network_packets,android_logs']],
      durationMs: 7,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 采集了哪些数据？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('trace_data_inventory');
    expect(direct?.conclusion).toContain('常用数据清单包括');
    expect(direct?.conclusion).toContain('slice/track 时间线');
    expect(direct?.conclusion).toContain('FrameTimeline');
    expect(direct?.conclusion).toContain('Logcat 日志数据');
    expect(direct?.conclusion).toContain('未看到');
    expect(direct?.conclusion).toContain('不等同于完整数据源枚举或问题诊断');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'slice_count',
      value: 101_278,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'network_packet_event_count',
      value: 0,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'android_log_count',
      value: 123,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for Android network packet availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'network_packet_event_count',
        'network_packet_count',
        'network_packet_bytes',
        'network_iface_count',
        'network_transport_count',
        'network_ifaces',
        'network_iface_packet_counts',
        'network_transports',
        'network_transport_packet_counts',
        'source_table',
      ],
      rows: [[42, 840, 1_234_567, 2, 2, 'wlan0,rmnet_data0', '700,140', 'TCP,UDP', '780,60', 'android_network_packets']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有网络包数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('network_packet_presence');
    expect(direct?.conclusion).toContain('采集到了 packet-level 网络数据');
    expect(direct?.conclusion).toContain('android_network_packets 42 行');
    expect(direct?.conclusion).toContain('packet_count 合计 840');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'network_packet_event_count',
      value: 42,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'network_packet_bytes',
      value: 1_234_567,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when Android network packet data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'network_packet_event_count',
        'network_packet_count',
        'network_packet_bytes',
        'network_iface_count',
        'network_transport_count',
        'network_ifaces',
        'network_iface_packet_counts',
        'network_transports',
        'network_transport_packet_counts',
        'source_table',
      ],
      rows: [[0, 0, 0, 0, 0, '', '', '', '', 'android_network_packets']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'does this trace have network packets?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('network_packet_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的 packet-level 网络数据');
    expect(direct?.conclusion).toContain('不等同于证明设备或应用没有网络活动、请求慢或网络问题');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'network_packet_event_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for Android Logcat availability', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'logcat_event_count',
        'warn_log_count',
        'error_log_count',
        'fatal_log_count',
        'distinct_tag_count',
        'sample_tags',
        'sample_tag_counts',
        'first_log_ts',
        'last_log_ts',
        'source_table',
      ],
      rows: [[123, 12, 3, 1, 8, 'ActivityManager,InputDispatcher,Choreographer', '70,33,20', 1_000_000, 2_000_000, 'android_logs']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '这个 trace 有 logcat 数据吗？',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('logcat_presence');
    expect(direct?.conclusion).toContain('采集到了 Logcat/android_logs 数据');
    expect(direct?.conclusion).toContain('共 123 条日志');
    expect(direct?.conclusion).toContain('warn 及以上 12 条');
    expect(direct?.conclusion).toContain('主要 tag：ActivityManager=70');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'logcat_event_count',
      value: 123,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'error_log_count',
      value: 3,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a cautious verifier-backed direct answer when Android Logcat data is absent', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'logcat_event_count',
        'warn_log_count',
        'error_log_count',
        'fatal_log_count',
        'distinct_tag_count',
        'sample_tags',
        'sample_tag_counts',
        'first_log_ts',
        'last_log_ts',
        'source_table',
      ],
      rows: [[0, 0, 0, 0, 0, '', '', null, null, 'android_logs']],
      durationMs: 1,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'does this trace have logcat logs?',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('logcat_presence');
    expect(direct?.conclusion).toContain('未采集到可解析的 Logcat/android_logs 数据');
    expect(direct?.conclusion).toContain('不等同于证明运行期间没有日志、警告或错误');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'logcat_event_count',
      value: 0,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for positive jank presence evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_names',
        'total_frames',
        'jank_frames',
        'jank_rate_pct',
        'window_start_ns',
        'window_end_ns',
        'duration_s',
        'fps',
        'jank_types',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        347,
        21,
        6.05,
        10,
        4_449_374_956,
        4.449375,
        77.99,
        'App Deadline Missed,Buffer Stuffing',
        'actual_frame_timeline_slice',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有掉帧？',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('com.example.app');
    expect(direct?.conclusion).toContain('347 帧');
    expect(direct?.conclusion).toContain('77.99 FPS');
    expect(direct?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(direct?.conclusion).toContain(evidence.envelopes[0].meta.evidenceRefId);
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 21,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'fps',
      value: 77.99,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'actual_frame_timeline_slice',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a count-focused direct answer for dropped-frame count evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_names',
        'total_frames',
        'jank_frames',
        'jank_rate_pct',
        'window_start_ns',
        'window_end_ns',
        'duration_s',
        'fps',
        'jank_types',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        347,
        21,
        6.05,
        10,
        4_449_374_956,
        4.449375,
        77.99,
        'App Deadline Missed,Buffer Stuffing',
        'actual_frame_timeline_slice',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: 'how many dropped frames?',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(evidence.evidenceKind).toBe('jank_frame_count');
    expect(direct?.conclusion).toContain('com.example.app');
    expect(direct?.conclusion).toContain('347 帧');
    expect(direct?.conclusion).toContain('21 帧标记为掉帧/卡顿');
    expect(direct?.conclusion).toContain('6.05%');
    expect(direct?.conclusion).not.toContain('77.99 FPS');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 21,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).not.toContainEqual(expect.objectContaining({
      column: 'fps',
      value: 77.99,
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer when FrameTimeline shows zero janky frames', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_names',
        'total_frames',
        'jank_frames',
        'jank_rate_pct',
        'window_start_ns',
        'window_end_ns',
        'duration_s',
        'fps',
        'jank_types',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        314,
        0,
        0,
        10,
        3_140_000_000,
        3.14,
        100,
        '',
        'actual_frame_timeline_slice',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '有没有掉帧？',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('314 帧');
    expect(direct?.conclusion).toContain('100 FPS');
    expect(direct?.conclusion).toContain('0 帧标记为掉帧/卡顿');
    expect(direct?.conclusion).toContain('未观测到掉帧/卡顿帧');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'jank_frames',
      value: 0,
    }));
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'source_table',
      value: 'actual_frame_timeline_slice',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('builds a verifier-backed direct answer for FPS evidence', async () => {
    const query = jest.fn<QueryTrace>(async () => ({
      columns: [
        'package_name',
        'process_names',
        'upid_count',
        'total_frames',
        'window_start_ns',
        'window_end_ns',
        'duration_s',
        'fps',
        'source_table',
      ],
      rows: [[
        'com.example.app',
        'com.example.app',
        1,
        347,
        10,
        4_449_374_956,
        4.449375,
        77.99,
        'actual_frame_timeline_slice',
      ]],
      durationMs: 2,
    }));
    const evidence = await buildQuickTraceFactEvidence({
      traceProcessor: { query },
      traceId: 'trace-1',
      query: '滑动 FPS 是多少？',
      packageName: 'com.example.app',
      outputLanguage: 'zh-CN',
    });

    const direct = buildQuickTraceFactDirectAnswer({
      evidence,
      outputLanguage: 'zh-CN',
    });

    expect(direct?.conclusion).toContain('com.example.app');
    expect(direct?.conclusion).toContain('77.99 FPS');
    expect(direct?.conclusion).toContain('347');
    expect(direct?.conclusionContract.claims?.[0]?.references).toContainEqual(expect.objectContaining({
      column: 'package_name',
      value: 'com.example.app',
    }));
    const verified = runClaimVerification({
      conclusionContract: direct?.conclusionContract,
      dataEnvelopes: evidence.envelopes,
      policy: 'record_only',
    });
    expect(verified.claimVerificationResult).toEqual(expect.objectContaining({
      status: 'passed',
      passed: true,
      checkedClaimCount: 1,
      unsupportedClaimCount: 0,
    }));
  });

  it('does not build a direct answer when trace fact evidence is incomplete', () => {
    const direct = buildQuickTraceFactDirectAnswer({
      evidence: { envelopes: [], evidenceKind: 'cpu_core_count' },
      outputLanguage: 'zh-CN',
    });

    expect(direct).toBeUndefined();
  });
});

describe('shouldUseTraceFactEvidenceOnlyQuickAnalysis', () => {
  it('allows evidence-only quick analysis when trace fact evidence is usable', () => {
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope()],
        promptContext: 'frame metrics table',
        evidenceKind: 'frame_metrics',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'trace_frame_count' })],
        promptContext: 'trace frame count table',
        evidenceKind: 'trace_frame_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'cpu_core_count' })],
        promptContext: 'cpu core count table',
        evidenceKind: 'cpu_core_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'power_counter_presence' })],
        promptContext: 'power counter availability table',
        evidenceKind: 'power_counter_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, '', '', 'counter_track,counter']],
          evidenceKind: 'power_counter_presence',
        })],
        promptContext: 'power counter availability table',
        evidenceKind: 'power_counter_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'memory_counter_presence' })],
        promptContext: 'memory counter availability table',
        evidenceKind: 'memory_counter_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, '', '', '', 'process_counter_track,counter']],
          evidenceKind: 'memory_counter_presence',
        })],
        promptContext: 'memory counter availability table',
        evidenceKind: 'memory_counter_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'scheduler_data_presence' })],
        promptContext: 'scheduler data availability table',
        evidenceKind: 'scheduler_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 0, 0, 0, 0, 'sched_slice,thread_state']],
          evidenceKind: 'scheduler_data_presence',
        })],
        promptContext: 'scheduler data availability table',
        evidenceKind: 'scheduler_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'gpu_data_presence' })],
        promptContext: 'gpu data availability table',
        evidenceKind: 'gpu_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, '', '', 'gpu_slice,gpu_counter_track,counter']],
          evidenceKind: 'gpu_data_presence',
        })],
        promptContext: 'gpu data availability table',
        evidenceKind: 'gpu_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'frame_timeline_presence' })],
        promptContext: 'frame timeline availability table',
        evidenceKind: 'frame_timeline_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 'actual_frame_timeline_slice,expected_frame_timeline_slice']],
          evidenceKind: 'frame_timeline_presence',
        })],
        promptContext: 'frame timeline availability table',
        evidenceKind: 'frame_timeline_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'slice_data_presence' })],
        promptContext: 'slice data availability table',
        evidenceKind: 'slice_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 'slice,track,process_track,thread_track']],
          evidenceKind: 'slice_data_presence',
        })],
        promptContext: 'slice data availability table',
        evidenceKind: 'slice_data_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'network_packet_presence' })],
        promptContext: 'network packet availability table',
        evidenceKind: 'network_packet_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 0, '', '', '', '', 'android_network_packets']],
          evidenceKind: 'network_packet_presence',
        })],
        promptContext: 'network packet availability table',
        evidenceKind: 'network_packet_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'logcat_presence' })],
        promptContext: 'logcat availability table',
        evidenceKind: 'logcat_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 0, '', '', null, null, 'android_logs']],
          evidenceKind: 'logcat_presence',
        })],
        promptContext: 'logcat availability table',
        evidenceKind: 'logcat_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'thread_count' })],
        promptContext: 'thread count table',
        evidenceKind: 'thread_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'app_thread_count' })],
        promptContext: 'focus app thread count table',
        evidenceKind: 'app_thread_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'process_count' })],
        promptContext: 'process count table',
        evidenceKind: 'process_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'app_process_count' })],
        promptContext: 'focus app process count table',
        evidenceKind: 'app_process_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'binder_transaction_count' })],
        promptContext: 'binder transaction count table',
        evidenceKind: 'binder_transaction_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'anr_presence' })],
        promptContext: 'anr presence table',
        evidenceKind: 'anr_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, 0, 0, 0, 'android_binder_txns']],
          evidenceKind: 'binder_transaction_count',
        })],
        promptContext: 'binder transaction count table',
        evidenceKind: 'binder_transaction_count',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, null, null, null, '', 'android_anrs']],
          evidenceKind: 'anr_presence',
        })],
        promptContext: 'anr presence table',
        evidenceKind: 'anr_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'startup_presence' })],
        promptContext: 'startup presence table',
        evidenceKind: 'startup_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, '', '', null, null, 0, 0, 'android_startups']],
          evidenceKind: 'startup_presence',
        })],
        promptContext: 'startup presence table',
        evidenceKind: 'startup_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'device_info' })],
        promptContext: 'device metadata table',
        evidenceKind: 'device_info',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ evidenceKind: 'jank_presence' })],
        promptContext: 'jank presence table',
        evidenceKind: 'jank_presence',
      },
    })).toBe(true);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[
            'com.example.app',
            'com.example.app',
            314,
            0,
            0,
            10,
            3_140_000_000,
            3.14,
            '',
            'actual_frame_timeline_slice',
          ]],
          evidenceKind: 'jank_presence',
        })],
        promptContext: 'jank presence table',
        evidenceKind: 'jank_presence',
      },
    })).toBe(true);
  });

  it('falls back to tools when evidence is incomplete or pre-evidence was not requested', () => {
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: false,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope()],
        promptContext: 'frame metrics table',
        evidenceKind: 'frame_metrics',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: { envelopes: [], promptContext: 'frame metrics table' },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({ rows: [['com.example.app', 0, 0, 0]] })],
        promptContext: 'frame metrics table',
        evidenceKind: 'frame_metrics',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, '', '', '']],
          evidenceKind: 'cpu_core_count',
        })],
        promptContext: 'cpu core count table',
        evidenceKind: 'cpu_core_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, null, '', '', 'counter_track,counter']],
          evidenceKind: 'power_counter_presence',
        })],
        promptContext: 'power counter availability table',
        evidenceKind: 'power_counter_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, null, '', '', '', 'process_counter_track,counter']],
          evidenceKind: 'memory_counter_presence',
        })],
        promptContext: 'memory counter availability table',
        evidenceKind: 'memory_counter_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, 0, 0, 0, 0, 0, 0, 0, 'sched_slice,thread_state']],
          evidenceKind: 'scheduler_data_presence',
        })],
        promptContext: 'scheduler data availability table',
        evidenceKind: 'scheduler_data_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, null, '', '', 'gpu_slice,gpu_counter_track,counter']],
          evidenceKind: 'gpu_data_presence',
        })],
        promptContext: 'gpu data availability table',
        evidenceKind: 'gpu_data_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, null, 0, 0, 'actual_frame_timeline_slice,expected_frame_timeline_slice']],
          evidenceKind: 'frame_timeline_presence',
        })],
        promptContext: 'frame timeline availability table',
        evidenceKind: 'frame_timeline_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, null, 0, 0, 'slice,track,process_track,thread_track']],
          evidenceKind: 'slice_data_presence',
        })],
        promptContext: 'slice data availability table',
        evidenceKind: 'slice_data_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, null, 0, 0, 0, '', '', '', '', 'android_network_packets']],
          evidenceKind: 'network_packet_presence',
        })],
        promptContext: 'network packet availability table',
        evidenceKind: 'network_packet_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, 0, 0, 0, 0, '', '', null, null, 'android_logs']],
          evidenceKind: 'logcat_presence',
        })],
        promptContext: 'logcat availability table',
        evidenceKind: 'logcat_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 0, '', 'thread']],
          evidenceKind: 'thread_count',
        })],
        promptContext: 'thread count table',
        evidenceKind: 'thread_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [['com.example.app', 0, 0, '', '', 'process,thread,android_process_metadata']],
          evidenceKind: 'app_thread_count',
        })],
        promptContext: 'focus app thread count table',
        evidenceKind: 'app_thread_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[0, 'process']],
          evidenceKind: 'process_count',
        })],
        promptContext: 'process count table',
        evidenceKind: 'process_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [['com.example.app', 0, 0, '', '', 'process,thread,android_process_metadata']],
          evidenceKind: 'app_process_count',
        })],
        promptContext: 'focus app process count table',
        evidenceKind: 'app_process_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, null, null, null, null, 'android_binder_txns']],
          evidenceKind: 'binder_transaction_count',
        })],
        promptContext: 'binder transaction count table',
        evidenceKind: 'binder_transaction_count',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, 0, null, null, null, '', 'android_anrs']],
          evidenceKind: 'anr_presence',
        })],
        promptContext: 'anr presence table',
        evidenceKind: 'anr_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, '', '', null, null, 0, 0, 'android_startups']],
          evidenceKind: 'startup_presence',
        })],
        promptContext: 'startup presence table',
        evidenceKind: 'startup_presence',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[null, null, null, null, null, null, null, 'metadata']],
          evidenceKind: 'device_info',
        })],
        promptContext: 'device metadata table',
        evidenceKind: 'device_info',
      },
    })).toBe(false);
    expect(shouldUseTraceFactEvidenceOnlyQuickAnalysis({
      quickTraceFactPreEvidence: true,
      traceFactEvidence: {
        envelopes: [traceFactEnvelope({
          rows: [[
            'com.example.app',
            'com.example.app',
            0,
            0,
            0,
            0,
            0,
            0,
            '',
            'actual_frame_timeline_slice',
          ]],
          evidenceKind: 'jank_presence',
        })],
        promptContext: 'jank presence table',
        evidenceKind: 'jank_presence',
      },
    })).toBe(false);
  });
});

describe('joinRuntimeEvidenceContexts', () => {
  it('joins only non-empty runtime evidence sections', () => {
    expect(joinRuntimeEvidenceContexts(undefined, '  fps table  ', '', 'identity table'))
      .toBe('fps table\n\nidentity table');
  });
});
