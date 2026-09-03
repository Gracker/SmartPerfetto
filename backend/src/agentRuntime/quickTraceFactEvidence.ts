// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';

import type {
  FocusAppDetectionResult,
  FocusAppTimeRange,
} from '../agentv3/focusAppDetector';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {
  matchesLongestProcessSlicesFactQuery,
  requestedLongestProcessSliceRows,
} from '../agentv3/longestProcessSlicesIntent';
import type {
  QueryResult,
  TraceProcessorService,
} from '../services/traceProcessorService';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import {
  getSkillsDir,
  SkillRegistry,
} from '../services/skillEngine/skillLoader';
import type {
  SkillDefinition,
  SkillExecutionResult,
} from '../services/skillEngine/types';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  type DataEnvelope,
  type DataEnvelopeTraceSide,
} from '../types/dataContract';
import {
  cellText,
  columnIndex,
  runtimeSkillSourceToolCallId,
  numericValue,
  rowValue,
  stableQuickEvidenceHash,
  withQuickEvidenceProvenance,
} from './quickEvidenceTable';

export type QuickTraceFactEvidenceKind =
  | 'frame_metrics'
  | 'selection_duration'
  | 'trace_frame_count'
  | 'jank_presence'
  | 'jank_frame_count'
  | 'trace_jank_presence'
  | 'frame_timeline_presence'
  | 'refresh_rate'
  | 'trace_duration'
  | 'trace_health_issues'
  | 'trace_data_inventory'
  | 'cpu_core_count'
  | 'cpu_frequency_presence'
  | 'power_counter_presence'
  | 'memory_counter_presence'
  | 'scheduler_data_presence'
  | 'gpu_data_presence'
  | 'slice_data_presence'
  | 'longest_process_slices'
  | 'network_packet_presence'
  | 'logcat_presence'
  | 'thread_count'
  | 'app_thread_count'
  | 'process_count'
  | 'app_process_count'
  | 'binder_transaction_count'
  | 'anr_presence'
  | 'startup_presence'
  | 'scroll_gesture_count'
  | 'input_event_count'
  | 'device_info';

const QUICK_TRACE_FACT_KIND_POLICY = {
  frame_metrics: { scoped: true, skipFocusDetection: false },
  selection_duration: { scoped: true, skipFocusDetection: true },
  trace_frame_count: { scoped: true, skipFocusDetection: true },
  jank_presence: { scoped: true, skipFocusDetection: false },
  jank_frame_count: { scoped: true, skipFocusDetection: false },
  trace_jank_presence: { scoped: true, skipFocusDetection: true },
  frame_timeline_presence: { scoped: false, skipFocusDetection: true },
  refresh_rate: { scoped: false, skipFocusDetection: true },
  trace_duration: { scoped: false, skipFocusDetection: true },
  trace_health_issues: { scoped: false, skipFocusDetection: true },
  trace_data_inventory: { scoped: false, skipFocusDetection: true },
  cpu_core_count: { scoped: false, skipFocusDetection: true },
  cpu_frequency_presence: { scoped: false, skipFocusDetection: true },
  power_counter_presence: { scoped: false, skipFocusDetection: true },
  memory_counter_presence: { scoped: false, skipFocusDetection: true },
  scheduler_data_presence: { scoped: false, skipFocusDetection: true },
  gpu_data_presence: { scoped: false, skipFocusDetection: true },
  slice_data_presence: { scoped: false, skipFocusDetection: true },
  longest_process_slices: { scoped: true, skipFocusDetection: true },
  network_packet_presence: { scoped: false, skipFocusDetection: true },
  logcat_presence: { scoped: false, skipFocusDetection: true },
  thread_count: { scoped: false, skipFocusDetection: true },
  app_thread_count: { scoped: false, skipFocusDetection: false },
  process_count: { scoped: false, skipFocusDetection: true },
  app_process_count: { scoped: false, skipFocusDetection: false },
  binder_transaction_count: { scoped: false, skipFocusDetection: true },
  anr_presence: { scoped: false, skipFocusDetection: true },
  startup_presence: { scoped: false, skipFocusDetection: true },
  scroll_gesture_count: { scoped: false, skipFocusDetection: true },
  input_event_count: { scoped: false, skipFocusDetection: true },
  device_info: { scoped: false, skipFocusDetection: true },
} satisfies Record<QuickTraceFactEvidenceKind, {
  scoped: boolean;
  skipFocusDetection: boolean;
}>;

export interface QuickTraceFactEvidencePayload {
  envelopes: DataEnvelope[];
  promptContext?: string;
  evidenceKind?: QuickTraceFactEvidenceKind;
}

export interface QuickTraceFactEvidenceInput {
  traceProcessor: Pick<TraceProcessorService, 'query'>;
  skillExecutor?: Pick<SkillExecutor, 'execute'>;
  traceId: string;
  query: string;
  focusResult?: FocusAppDetectionResult;
  packageName?: string;
  timeRange?: FocusAppTimeRange;
  traceSide?: DataEnvelopeTraceSide;
  outputLanguage?: OutputLanguage;
}

const LONGEST_PROCESS_SLICES_SKILL_ID = 'longest_process_slices';
const LONGEST_PROCESS_SLICES_SKILL_PATH = 'atomic/longest_process_slices.skill.yaml';

let cachedLongestProcessSlicesSkill:
  | { skill: SkillDefinition; fragments: Map<string, string> }
  | null
  | undefined;

const FRAME_METRIC_COLUMNS = [
  'package_name',
  'process_names',
  'upid_count',
  'total_frames',
  'window_start_ns',
  'window_end_ns',
  'duration_s',
  'fps',
  'scope_start_ns',
  'scope_end_ns',
  'source_table',
];

const TRACE_FRAME_COUNT_COLUMNS = [
  'scope',
  'total_frames',
  'window_start_ns',
  'window_end_ns',
  'duration_s',
  'scope_start_ns',
  'scope_end_ns',
  'source_table',
];

const TRACE_DURATION_COLUMNS = [
  'trace_start_ns',
  'trace_end_ns',
  'trace_start_s',
  'trace_end_s',
  'duration_s',
  'source_table',
];
const SELECTION_DURATION_COLUMNS = [
  'scope',
  'scope_start_ns',
  'scope_end_ns',
  'duration_ns',
  'duration_s',
  'source_table',
];

const TRACE_HEALTH_ISSUE_COLUMNS = [
  'issue_stat_count',
  'error_stat_count',
  'data_loss_stat_count',
  'total_issue_value',
  'issue_names',
  'issue_values',
  'issue_severities',
  'source_table',
];

const TRACE_DATA_INVENTORY_COLUMNS = [
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
];

const JANK_PRESENCE_COLUMNS = [
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
  'scope_start_ns',
  'scope_end_ns',
  'source_table',
];

const JANK_FRAME_COUNT_COLUMNS = JANK_PRESENCE_COLUMNS.filter(column => column !== 'fps');

const TRACE_JANK_PRESENCE_COLUMNS = [
  'scope',
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
];

const FRAME_TIMELINE_PRESENCE_COLUMNS = [
  'actual_frame_timeline_slice_count',
  'expected_frame_timeline_slice_count',
  'janky_actual_frame_count',
  'actual_frame_upid_count',
  'source_table',
];

const REFRESH_RATE_COLUMNS = [
  'refresh_rate_hz',
  'vsync_period_ns',
  'vsync_period_ms',
  'detection_method',
  'sample_count',
  'raw_median_period_ns',
  'source_table',
];

const CPU_CORE_COUNT_COLUMNS = [
  'observed_cpu_count',
  'observed_cpus',
  'universe_source',
  'cpu_table_count',
  'cpu_table_cpus',
  'source_table',
];

const CPU_FREQUENCY_PRESENCE_COLUMNS = [
  'cpufreq_cpu_count',
  'cpufreq_sample_count',
  'cpufreq_cpus',
  'min_freq_khz',
  'max_freq_khz',
  'first_sample_ts',
  'last_sample_ts',
  'source_table',
];

const POWER_COUNTER_PRESENCE_COLUMNS = [
  'power_counter_track_count',
  'power_counter_sample_count',
  'power_counter_names',
  'power_counter_sample_counts',
  'source_table',
];

const MEMORY_COUNTER_PRESENCE_COLUMNS = [
  'memory_counter_track_count',
  'memory_counter_sample_count',
  'memory_counter_names',
  'memory_counter_sample_counts',
  'memory_counter_max_values',
  'source_table',
];

const SCHEDULER_DATA_PRESENCE_COLUMNS = [
  'sched_slice_count',
  'thread_state_count',
  'running_state_count',
  'runnable_state_count',
  'preempted_runnable_state_count',
  'sleeping_state_count',
  'uninterruptible_sleep_state_count',
  'idle_state_count',
  'source_table',
];

const GPU_DATA_PRESENCE_COLUMNS = [
  'gpu_slice_count',
  'gpu_counter_track_count',
  'gpu_counter_sample_count',
  'gpu_counter_names',
  'gpu_slice_names',
  'source_table',
];

const SLICE_DATA_PRESENCE_COLUMNS = [
  'slice_count',
  'track_count',
  'process_track_count',
  'thread_track_count',
  'source_table',
];

const LONGEST_PROCESS_SLICES_COLUMNS = [
  'ts',
  'dur_ns',
  'duration_ms',
  'slice_name',
  'process_name',
  'thread_name',
];

const NETWORK_PACKET_PRESENCE_COLUMNS = [
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
];

const LOGCAT_PRESENCE_COLUMNS = [
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
];

const THREAD_COUNT_COLUMNS = [
  'thread_count',
  'process_count',
  'source_table',
];

const APP_PROCESS_THREAD_COUNT_COLUMNS = [
  'package_name',
  'process_count',
  'thread_count',
  'process_names',
  'process_thread_counts',
  'source_table',
];

const PROCESS_COUNT_COLUMNS = [
  'process_count',
  'listed_process_count',
  'process_names',
  'process_thread_counts',
  'omitted_process_count',
  'source_table',
];

const BINDER_TRANSACTION_COUNT_COLUMNS = [
  'binder_txn_count',
  'sync_count',
  'async_count',
  'total_client_ms',
  'max_client_ms',
  'source_table',
];

const ANR_PRESENCE_COLUMNS = [
  'total_anr_count',
  'affected_process_count',
  'first_anr_ts',
  'last_anr_ts',
  'anr_span_seconds',
  'anr_types',
  'source_table',
];

const STARTUP_PRESENCE_COLUMNS = [
  'startup_count',
  'packages',
  'startup_types',
  'first_startup_ts',
  'last_startup_ts',
  'total_startup_ms',
  'max_startup_ms',
  'source_table',
];

const SCROLL_GESTURE_COUNT_COLUMNS = [
  'scroll_gesture_count',
  'scroll_start_count',
  'first_scroll_ts',
  'last_scroll_ts',
  'max_move_count',
  'process_names',
  'source_table',
  'heuristic',
];

const INPUT_EVENT_COUNT_COLUMNS = [
  'input_event_count',
  'motion_event_count',
  'key_event_count',
  'process_count',
  'first_input_ts',
  'last_input_ts',
  'process_names',
  'source_table',
];

const DEVICE_INFO_COLUMNS = [
  'android_device_manufacturer',
  'android_build_fingerprint',
  'android_sdk_version',
  'android_soc_model',
  'system_name',
  'system_release',
  'system_machine',
  'source_table',
];

const PROMPT_MAX_ROWS = 3;

const FRAME_RATE_PATTERNS = [
  /帧率|\bfps\b|frame\s*rate/i,
];

const FRAME_COUNT_PATTERNS = [
  /总帧数|帧数|多少帧|frame\s*count|total\s*frames/i,
  /how\s+many\s+frames?(?:\s+(?:are\s+(?:there|in)|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))/i,
];

const FRAME_METRIC_PATTERNS = [
  ...FRAME_RATE_PATTERNS,
  ...FRAME_COUNT_PATTERNS,
];

const TRACE_WIDE_FRAME_COUNT_SCOPE_PATTERN = /(?:(?:trace|录制|采集|抓取|记录|本次|当前|该|全局|整体|全量|整个|整段|overall|global|entire\s+trace|this\s+trace|recording).*(?:总帧数|帧数|多少帧|frame\s*count|total\s*frames|how\s+many\s+frames?))|(?:(?:总帧数|帧数|多少帧|frame\s*count|total\s*frames|how\s+many\s+frames?).*(?:trace|录制|采集|抓取|记录|全局|整体|全量|整个|整段|overall|global|entire\s+trace|this\s+trace|recording))/i;
const TRACE_WIDE_BARE_FRAME_COUNT_PATTERN = /^\s*(?:(?:total|overall|global|entire)\s+)?frame\s*count\s*[?？.。!！]*\s*$|^\s*total\s+frames?\s*[?？.。!！]*\s*$/i;
const APP_SCOPED_FRAME_METRIC_PATTERN = /(?:焦点应用|目标应用|当前应用|应用|app|application|package|包名|进程|process|主进程|surface|layer|窗口|window)/i;

const TRACE_DURATION_PATTERNS = [
  /^\s*(?:(?:is|are)\s+there|does\s+this\s+trace\s+have|有没有|有无|是否存在)?\s*(?:a\s+)?trace[_\s-]?bounds(?:\s*(?:table|rows?|data|range|duration|表|有吗|存在吗))?\s*[?？。.!]*\s*$/i,
  /(?:trace|recording)\s*(?:duration|length)|(?:trace|录制|采集|抓取|记录).*(?:时长|多长|多久|长度|时间范围)|(?:时长|多长|多久|长度|时间范围).*(?:trace|录制|采集|抓取|记录)/i,
  /(?:采样|录屏|录制|采集|抓取|抓|记录|录)(?:了)?(?:多久|多长(?:时间)?|时长|长度|时间范围)|(?:性能数据|trace\s*数据|trace\s*data).*(?:时长|多长(?:时间)?|多久|长度|时间范围)/i,
  /(?:trace|recording|capture)\s*(?:time\s*range|timespan|time\s*span|span|range)|(?:recording|capture)\s*(?:duration|length|time)/i,
  /how\s+long\s+(?:is|was)\s+(?:(?:this|the)\s+)?(?:trace|recording|capture)(?:\s+recorded)?|recording\s+length/i,
  /(?:trace|录制|采集|抓取|记录).*(?:起止|开始时间|结束时间|起始|终止|什么时候|何时|start(?:\s*time)?|end(?:\s*time)?|timestamps?)/i,
  /(?:trace|录制|采集|抓取|记录).*(?:时间|范围|时段|开始|结束)/i,
  /(?:什么时候|何时).*(?:trace|录制|采集|抓取|记录).*(?:开始|结束)|(?:trace|recording).*(?:start|end)\s*(?:time|timestamp)?/i,
];
const SELECTION_DURATION_PATTERNS = [
  /(?:选区|选中(?:的)?|选择(?:的)?范围|当前范围|这个范围|范围|selected\s+range|selection|selected\s+slice|slice).*(?:时长|多长|多久|长度|duration|length|time\s*range)/i,
  /(?:时长|多长|多久|长度|duration|length).*(?:选区|选中(?:的)?|选择(?:的)?范围|当前范围|这个范围|selected\s+range|selection|selected\s+slice|slice)/i,
  /^\s*(?:selection|selected\s+range|selected\s+slice|slice)\s+(?:duration|length|time\s*range)\s*[?？.。!！]*\s*$/i,
];

const TRACE_HEALTH_PATTERN = /(?:trace\s*(?:health|errors?|issues?)|(?:trace|录制|采集|解析).*(?:错误|异常|问题)|(?:采集|解析)(?:错误|异常|问题)|数据丢失|丢包|packet\s+loss|data\s*loss|stats?\s+errors?)/i;
const TRACE_HEALTH_SHAPE_PATTERN = /(?:有没有|是否|有无|有.*[吗么]|多少|几个|几|数量|次数|列出|哪些|存在|any|has|have|is\s+there|are\s+there|how\s+many|list|show|which|what|[?？]\s*$)/i;
const TRACE_HEALTH_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|怎么修|如何修|修复|有哪些问题|什么问题|问题(?:是什么|在哪|原因)|丢包|packet\s+loss|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|fix|repair)/i;

const TRACE_DATA_INVENTORY_PATTERN = /(?:trace|录制|采集|抓取|记录|本次|当前).*(?:有哪些|哪些|什么|有什么|有啥|包含|包括|采集了|记录了|可用).*(?:数据源|数据|信息|表|tables?|sources?)|(?:数据源|采集数据|trace\s*数据|trace\s*data|available\s+data|data\s+sources?).*(?:有哪些|哪些|什么|列表|列出|显示|show|list|available|availability|contains?|include|包含)|(?:what|which).*(?:data|tables?|data\s+sources?).*(?:available|captured|recorded|included?|contained?|in).*(?:trace|recording)|(?:what|which).*(?:does|is).*(?:trace|recording).*(?:contain|include|have|capture|record)|(?:counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data|\bcounters?\b)(?:.*(?:数据|样本|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability|samples?|tables?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data|\bcounters?\b)/i;
const TRACE_DATA_INVENTORY_RAW_COLUMN_PATTERN = /^\s*(?:slice|track|process|thread|process_track|thread_track|sched_slice|thread_state|counter_track|process_counter_track|cpu_counter_track|gpu_counter_track|counter_sample|cpufreq_sample|actual_frame_timeline_slice|expected_frame_timeline_slice|gpu_slice|gpu_counter_sample|network_packet_event|android_log)_count\s*[?？.。!！]*\s*$/i;
const TRACE_DATA_INVENTORY_BARE_PATTERN = /^(?:(?:有哪些|哪些|什么|有什么|有啥|列出|显示|show|list|what|which)\s*)?(?:数据源|采集数据|trace\s*数据|trace\s*data|available\s+data(?:\s+sources?)?|data\s+sources?|tables?|counter[_\s-]?track|process[_\s-]?counter[_\s-]?track|cpu[_\s-]?counter[_\s-]?track|gpu[_\s-]?counter[_\s-]?track|counter|counters?|counter\s+tracks?|counter\s+tables?|counter\s+rows?|counter\s+samples?|counter\s+data)(?:\s*(?:有哪些|哪些|什么|列表|列出|显示|show|list|available|availability|contains?|include|包含|rows?|samples?|tables?|数据|样本|表|行))?[？?。.!\s]*$/i;
const TRACE_DATA_INVENTORY_BARE_TABLE_PATTERN = /^\s*(?:(?:有哪些|哪些|什么|有什么|有啥|列出|显示)\s*(?:数据)?表|(?:数据)?表\s*(?:有哪些|哪些|列表|列出|显示|可用)|available\s+tables?)\s*[?？.。!！]*\s*$/i;
const TRACE_DATA_INVENTORY_SHAPE_PATTERN = /(?:有哪些|哪些|什么|有什么|有啥|列表|列出|显示|show|list|available|availability|contains?|include|包含|包括|采集了|记录了|[?？]\s*$)/i;
const TRACE_DATA_INVENTORY_DIAGNOSTIC_PATTERN = /(?:问题|错误|异常|为什么|原因|根因|分析|诊断|优化|建议|卡顿|卡住|慢|高|低|峰值|过高|偏高|过低|偏低|延迟|耗时|性能|怎么修|如何修|修复|缺失原因|issue|problem|error|abnormal|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|slow|high|low|spike|latency|delay|performance|fix|repair)/i;

const FRAME_TIMELINE_PRESENCE_PATTERN = /(?:frame[_\s-]?timeline|frametimeline|actual_frame_timeline_slice|expected_frame_timeline_slice|帧时间线|帧\s*timeline|帧渲染时间线)(?:.*(?:数据|事件|表|行|数量|多少|几个|几|slice|slices|有没有|是否|有无|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:frame[_\s-]?timeline|frametimeline|actual_frame_timeline_slice|expected_frame_timeline_slice|帧时间线|帧\s*timeline|帧渲染时间线)/i;
const FRAME_TIMELINE_PRESENCE_SHAPE_PATTERN = /(?:数据|事件|表|行|数量|多少|几个|几|slice|slices|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?|how\s+many|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const FRAME_TIMELINE_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|延迟|瓶颈|负载|占用|高|低|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|bottleneck|load|usage|utili[sz]ation|high|low|abnormal)/i;

const REFRESH_RATE_FACT_PATTERN = /(?:(?:trace|录制|采集|抓取|记录|当前|本次|该).*(?:观测|推断|检测|测到|reported|observed|detected|inferred)?.*(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget)|(?:观测|推断|检测|测到|reported|observed|detected|inferred).*(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget).*(?:trace|录制|采集|recording)|(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)|帧周期|frame\s*budget).*(?:trace|录制|采集|抓取|记录|观测|推断|检测|reported|observed|detected|inferred))/i;
const BARE_REFRESH_RATE_FACT_PATTERN = /^\s*(?:(?:what|which)\s+(?:is|was)\s+(?:the\s+)?)?(?:(?:(?:(?:current|observed|detected|inferred|display|screen)\s+|(?:当前|屏幕|显示|观测(?:到的|的)?|检测(?:到的|的)?|测到的?|推断(?:出的|的)?)\s*)?)(?:刷新率|refresh\s*rate|vsync\s*(?:period|周期)?|帧周期|frame\s*budget)|(?:display|screen|current|observed|detected|inferred)\s+hz)(?:\s*(?:是多少|是什么|多少|几|hz|ms|rate|period))?\s*[?？.。!！]*\s*$/i;
const REFRESH_RATE_FACT_SHAPE_PATTERN = /(?:多少|几|是什么|是多少|Hz|hz|ms|毫秒|周期|rate|period|what|which|detected|observed|inferred|[?？]\s*$)/i;
const REFRESH_RATE_FACT_DIAGNOSTIC_PATTERN = /(?:支持|support|vrr|variable\s+refresh|adaptive\s+sync|ltpo|策略|policy|切换|switch|为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|abnormal)/i;

const CPU_CORE_COUNT_PATTERNS = [
  /(?:cpu\s*)?(?:核心|核)(?:数量|数)|(?:多少|几个|几).*(?:cpu\s*)?(?:核心|核)|cpu.*(?:几|多少).*(?:核心|核)|cpu\s*(?:核心|核)\s*[?？]?$|\bcpu\s*cores?\s*[?？]?$|cpu\s*core\s*count|how\s+many\s+cpu\s+cores/i,
  /^\s*cpu\s+(?:count|rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
];

const CPU_FREQUENCY_PRESENCE_PATTERN = /(?:cpu\s*)?(?:频率|freq(?:uency)?|cpufreq|dvfs)(?:.*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录))?|(?:有没有|是否|有无|存在|采集|记录).*(?:cpu\s*)?(?:频率|freq(?:uency)?|cpufreq|dvfs)|\b(?:cpufreq|cpu\s+freq(?:uency)?\s+(?:data|counters?)|cpu\s+frequency\s+counters?|dvfs\s+(?:data|counters?))\b/i;
const CPU_FREQUENCY_PRESENCE_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|counters?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const CPU_FREQUENCY_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|升频|降频|频率低|频率高|不足|异常|慢|卡顿|卡住|耗时|延迟|性能|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|boost|throttl|slow|jank|latency|performance|low|high)/i;

const POWER_COUNTER_PRESENCE_PATTERN = /(?:功耗|耗电|电量|电池|电源|电流|电压|power|battery|energy|charge|watt).*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录|样本|行|available|availability|rows?|samples?|sample\s+count)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:功耗|耗电|电量|电池|电源|电流|电压|power|battery|energy|charge|watt)|\b(?:power|battery|energy|charge)\s+(?:data|counters?|metrics?|rows?|samples?|sample\s+count)\b/i;
const POWER_COUNTER_PRESENCE_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|样本|行|available|availability|data|counters?|metrics?|rows?|samples?|sample\s+count|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const POWER_COUNTER_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|耗电快|耗电高|功耗高|电流大|异常|偏高|偏低|过高|过低|高|低|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|drain|consume|consumption|power\s+draw|high|low|abnormal)/i;

const MEMORY_COUNTER_PRESENCE_PATTERN = /(?:内存|memory|rss|swap).*(?:数据|计数器|counter|counters?|有没有|是否|有无|存在|采集|记录|样本|行|available|availability|rows?|samples?|sample\s+count)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:内存|memory|rss|swap)|\b(?:memory|rss|swap)\s+(?:data|counters?|metrics?|rows?|samples?|sample\s+count)\b|(?:oom[_\s-]?score|oom).*(?:数据|计数器|counter|counters?|metrics?|available|availability)|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:oom[_\s-]?score|oom).*(?:数据|计数器|counter|counters?|metrics?)/i;
const MEMORY_COUNTER_PRESENCE_SHAPE_PATTERN = /(?:数据|计数器|有没有|是否|有无|有.*[吗么]|存在|采集|记录|样本|行|available|availability|data|counters?|metrics?|rows?|samples?|sample\s+count|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const MEMORY_COUNTER_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|泄漏|过高|偏高|高|异常|增长|上涨|占用|压力|oom\s*原因|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|leak|high|abnormal|growth|pressure)/i;

const SCHEDULER_DATA_PRESENCE_PATTERN = /(?:调度|线程状态|thread[_\s-]?state|sched[_\s-]?slice|scheduler|scheduling).*(?:数据|事件|表|行|数量|多少|几个|几|计数|有没有|是否|有无|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|count)|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:调度|线程状态|thread[_\s-]?state|sched[_\s-]?slice|scheduler|scheduling)|\b(?:sched[_\s-]?slice|thread[_\s-]?state|scheduler|scheduling|sched)\s+(?:data|events?|tables?|table\s+rows?|rows?|counts?|availability)\b|\b(?:running|runnable)\s+(?:thread[_\s-]?states?|thread[_\s-]?state|states?)\s+(?:rows?|counts?|count)\b|\b(?:how\s+many|count|counts?|rows?).{0,24}\b(?:running|runnable)\s+(?:thread[_\s-]?states?|states?)\b|^\s*(?:sched[_\s-]?slice|thread[_\s-]?state|sched|scheduler)\s*[?？.。!！]*\s*$/i;
const SCHEDULER_THREAD_STATE_COUNT_FACT_PATTERN = /(?:(?:thread[_\s-]?state|线程状态).{0,32}(?:\b(?:R\+|D|DK|S|I)\b|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占|运行|可运行|睡眠|不可中断|空闲).{0,32}(?:rows?|counts?|count|行|数量|多少|几个|几|计数|[?？]\s*$))|(?:(?:how\s+many|count|counts?|rows?|多少|几个|几|数量|计数).{0,32}(?:\b(?:R\+|D|DK|S|I)\b|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占|运行|可运行|睡眠|不可中断|空闲).{0,32}(?:thread[_\s-]?states?|states?|线程状态|线程))|\b(?:preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle)\s+(?:thread[_\s-]?states?|thread[_\s-]?state|states?)\s+(?:rows?|counts?|count)\b/i;
const SCHEDULER_SHORT_THREAD_STATE_COUNT_FACT_PATTERN = /^\s*(?:(?:thread[_\s-]?state|线程状态)\s+)?(?:R\+|D|DK|S|I|preempted\s+runnable|running|runnable|sleeping|uninterruptible(?:\s+sleep)?|idle|抢占(?:等待)?|运行|可运行|睡眠|不可中断|空闲)(?:[-\s]+state|\s*状态)?\s*(?:thread[_\s-]?states?\s+|states?\s+)?(?:rows?|row\s+count|counts?|count|行数|行|数量|多少|几个|几|计数)\s*[?？.。!！]*\s*$/i;
const SCHEDULER_DATA_PRESENCE_SHAPE_PATTERN = /(?:数据|事件|表|行|数量|多少|几个|几|计数|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|table|tables?|rows?|counts?|how\s+many|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const SCHEDULER_DATA_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|延迟|调度等待|调度不足|调度问题|卡顿|卡住|慢|阻塞|抢占|过多|很多|高|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|latency|delay|jank|slow|blocked|blocking|preempt|contention|high|too\s+many|excessive|spike)/i;
const SCHEDULER_THREAD_STATE_COUNT_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|延迟|调度等待|调度不足|调度问题|卡顿|卡住|慢|阻塞|过多|很多|高|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|latency|delay|jank|slow|blocked|blocking|contention|high|too\s+many|excessive|spike)/i;

const GPU_DATA_PRESENCE_PATTERN = /(?:gpu|图形|图像|渲染器|显卡).*(?:数据|事件|切片|slice|slices|计数器|counter|counters?|表|行|rows?|样本|样本数|samples?|sample\s+count|数量|count|有没有|是否|有无|存在|采集|记录|available|availability|metrics?)|(?:gpu[_\s-]?(?:slice|slices|counter|counters?|data|samples?)|gpu\s+(?:data|events?|slices?|counters?|metrics?|tables?|table\s+rows?|rows?|samples?|sample\s+count|counts?|availability))|(?:有没有|是否|有无|存在|采集|记录|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have).*(?:gpu|图形|图像|渲染器|显卡)/i;
const GPU_DATA_PRESENCE_SHAPE_PATTERN = /(?:数据|事件|切片|slice|slices|计数器|counter|counters?|样本|样本数|samples?|sample\s+count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|data|events?|metrics?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|[?？]\s*$)/i;
const GPU_DATA_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|延迟|瓶颈|负载|占用|高|低|异常|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|bottleneck|load|usage|utili[sz]ation|high|low|abnormal)/i;

const SLICE_DATA_PRESENCE_PATTERN = /(?:\bslices?\b|切片|\btracks?\b|process_track|thread_track|时间线事件|timeline\s+events?)(?:.*(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability|table|tables?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:\bslices?\b|切片|\btracks?\b|process_track|thread_track|时间线事件|timeline\s+events?)/i;
const SLICE_DATA_PRESENCE_SHAPE_PATTERN = /(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|table|tables?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const SLICE_DATA_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|卡顿|掉帧|丢帧|慢|耗时|时长|延迟|瓶颈|负载|占用|高|低|异常|阻塞|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|slow|latency|delay|duration|bottleneck|load|usage|utili[sz]ation|high|low|abnormal|blocked|blocking)/i;

const NETWORK_PACKET_PRESENCE_PATTERN = /(?:android[_\s.-]?network[_\s.-]?packets?|network[_\s-]?packets?|network\s+traffic|packet[-_\s]?level\s+network|网络包|网络数据包|网络数据|网络流量|网络字节(?:数|量)?|流量数据|数据包)(?:.*(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|bytes?|字节|有没有|是否|有无|存在|采集|记录|available|availability|traffic|packets?))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:android[_\s.-]?network[_\s.-]?packets?|network[_\s-]?packets?|network\s+traffic|packet[-_\s]?level\s+network|网络包|网络数据包|网络数据|网络流量|网络字节(?:数|量)?|流量数据|数据包)|\b(?:network|traffic|packets?)\s+(?:data|events?|tables?|table\s+rows?|rows?|counts?|bytes?|packet\s+bytes?)\b|^\s*packets\s*[?？.。!！]*\s*$/i;
const NETWORK_PACKET_PRESENCE_SHAPE_PATTERN = /(?:数据|事件|表|行|rows?|数量|多少|几个|几|count|bytes?|字节|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|traffic|packets?|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const NETWORK_PACKET_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|慢|延迟|耗时|失败|错误|丢包|丢失|掉包|重传|超时|请求|带宽|高|低|异常|耗电|功耗|dns|tls|ttfb|http|quic|ech|certificate|networkcallback|networkcapabilities|local\s+network\s+permission|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|slow|latency|delay|timeout|request|failed|failure|loss|lost|drop|dropped|retransmit|retransmission|bandwidth|high|low|abnormal|drain|power)/i;

const LOGCAT_PRESENCE_PATTERN = /(?:logcat|android[_\s-]?logs?|日志|系统日志)(?:.*(?:数据|日志|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|存在|采集|记录|available|availability))?|(?:有没有|是否|有无|存在|采集|记录|多少|几个|几|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many).*(?:logcat|android[_\s-]?logs?|日志|系统日志)|\blogs?\s+(?:tables?|table\s+rows?|rows?|counts?)\b|^\s*logs\s*[?？.。!！]*\s*$/i;
const LOGCAT_PRESENCE_SHAPE_PATTERN = /(?:数据|日志|事件|表|行|rows?|数量|多少|几个|几|count|有没有|是否|有无|有.*[吗么]|存在|采集|记录|available|availability|has|have|contains?|is\s+there|are\s+there|does\s+(?:this\s+)?trace\s+have|how\s+many|[?？]\s*$)/i;
const LOGCAT_PRESENCE_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|报错|错误|崩溃|卡顿|慢|延迟|耗时|失败|告警|警告|很多|过多|太多|大量|频繁|根因|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|errors?|exceptions?|crash|slow|jank|latency|delay|failure|warning|too\s+many|frequent)/i;
const LOGCAT_SEVERITY_COUNT_FACT_PATTERN = /(?:(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志).{0,40}(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,40}(?:rows?|counts?|count|多少|几个|几|数量|条|any|有没有|是否|有无|[?？]\s*$)|(?:how\s+many|count|counts?|rows?|any|are\s+there|is\s+there|有没有|是否|有无|多少|几个|几|数量|条).{0,40}(?:(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志).{0,40}(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重)|(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,40}(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志))|(?:warn(?:ings?)?|errors?|fatal|警告|告警|错误|报错|严重).{0,20}\b(?:in|from)\s+(?:logcat|android[_\s-]?logs?|\blogs?\b|日志|系统日志)\b(?:[?？.。!！]*\s*$)|(?:warn(?:ings?)?|errors?|fatal)\s+logs?\s*(?:rows?|counts?|count|[?？.。!！]*\s*$))/i;
const LOGCAT_CHINESE_SEVERITY_COUNT_FACT_PATTERN = /(?:(?:有|有没有|是否|有无).{0,12}(?:警告|告警|错误|报错|严重).{0,12}(?:日志|系统日志|logcat)(?:.{0,6}(?:有吗|吗|么|多少|几|数量|条))?|(?:警告|告警|错误|报错|严重).{0,8}(?:日志|系统日志|logcat)(?:.{0,8}(?:有吗|吗|么|多少|几|数量|条))?)\s*[?？.。!！]*$/i;
const LOGCAT_SEVERITY_EVALUATION_DIAGNOSTIC_PATTERN = /(?:很多|过多|太多|大量|频繁|偏高|过高|太高|正常|异常|合理|很严重|严重(?:吗|么|[?？])|too\s+many|frequent|normal|abnormal|reasonable)/i;
const LOGCAT_AMBIGUOUS_ROW_ERROR_PATTERN = /^\s*logs?\s+rows?\s+errors?\s*[?？.。!！]*\s*$/i;
const LOGCAT_CAUSAL_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|崩溃|卡顿|慢|延迟|耗时|失败|why|causes?|reasons?|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|exceptions?|crash|slow|jank|latency|delay|failure)/i;

const THREAD_COUNT_PATTERNS = [
  /^\s*(?:线程|threads?)\s*[？?.!。]*\s*$/i,
  /^\s*(?:线程|threads?)\s+(?:rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
  /线程(?:数量|数|总数)|(?:有|共有|一共有|总共|总计|一共)?\s*(?:多少|几个|几)个?线程(?:[？?。.!\s]*)$|多少线程(?:[？?。.!\s]*)$|threads?\s*count|total\s+threads?|how\s+many\s+threads?(?:\s+(?:are\s+there(?:\s+in\s+(?:this\s+)?trace)?|are\s+in\s+(?:this\s+)?trace|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))?(?:[?.!\s]*)$/i,
  /how\s+many\s+threads?\s+(?:does|do)\s+(?:the\s+)?(?:current|focus|focused|target|selected)\s+app(?:lication)?\s+have/i,
];
const THREAD_COUNT_DIAGNOSTIC_PATTERN = /(?:卡顿|卡住|卡吗|慢|耗时|延迟|阻塞|原因|为什么|根因|分析|诊断|优化|建议|性能|过多|太多|很多|偏高|过高|数量高|数高|blocked|blocking|latency|slow|jank|high|too\s+many|excessive|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|performance)/i;
const APP_SCOPE_PATTERN = /(?:焦点应用|目标应用|当前应用|应用包|包名|current\s+app|focus(?:ed)?\s+app|target\s+app|selected\s+app|\bapp(?:lication)?\b|\bpackage\b)/i;

const PROCESS_COUNT_PATTERNS = [
  /^\s*(?:进程|processes)\s*[？?.!。]*\s*$/i,
  /^\s*process(?:es)?\s+(?:rows?|table(?:\s+rows?)?)\s*[?？.。!！]*\s*$/i,
  /进程(?:数量|数|总数)|(?:有|共有|一共有|总共|总计|一共)?\s*(?:多少|几个|几)个?进程(?:[？?。.!\s]*)$|多少进程(?:[？?。.!\s]*)$|process(?:es)?\s*count|total\s+process(?:es)?|how\s+many\s+process(?:es)?(?:\s+(?:are\s+there(?:\s+in\s+(?:this\s+)?trace)?|are\s+in\s+(?:this\s+)?trace|in\s+(?:this\s+)?trace|does\s+(?:this\s+)?trace\s+have))?(?:[?.!\s]*)$/i,
  /how\s+many\s+process(?:es)?\s+(?:does|do)\s+(?:the\s+)?(?:current|focus|focused|target|selected)\s+app(?:lication)?\s+have/i,
  /(?:有哪些|哪些|列出|显示|给我|告诉我).{0,12}进程(?:名)?|进程(?:名)?.{0,8}(?:有哪些|哪些|列表)|\b(?:list|show)\s+process(?:es)?\b|\b(?:which|what)\s+processes\b|\bprocess(?:es)?\s+(?:names|list)\b/i,
];
const PROCESS_DIAGNOSTIC_PATTERN = /(?:卡顿|卡住|卡吗|慢|耗时|延迟|阻塞|原因|为什么|根因|分析|诊断|优化|建议|性能|过多|太多|很多|偏高|过高|数量高|数高|cpu|内存|memory|blocked|blocking|latency|slow|jank|high|too\s+many|excessive|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|performance)/i;

const BINDER_TRANSACTION_PATTERN = /(?:\bbinder\b|android[_\s-]?binder[_\s-]?txns?)/i;
const BINDER_TRANSACTION_COUNT_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几|count|how\s+many|is\s+there|are\s+there|有没有|是否|有无|[?？]\s*$)/i;
const BINDER_TRANSACTION_DIAGNOSTIC_PATTERN = /(?:阻塞|耗时|延迟|慢|原因|为什么|blocked|blocking|latency|slow|why|root\s*cause|diagnos(?:e|is)|analy[sz]e)/i;

const ANR_PATTERN = /(?:\banrs?\b|android[_\s-]?anrs?|app\s+not\s+responding|应用无响应|无响应)/i;
const ANR_PRESENCE_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|[?？]\s*$)/i;
const ANR_DIAGNOSTIC_PATTERN = /(?:原因|为什么|根因|分析|诊断|优化|建议|阻塞|死锁|卡死|卡住|blocked|blocking|deadlock|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend)/i;

const STARTUP_PATTERN = /(?:启动|launch(?:es|ed|ing)?|startup(?:s)?|android[_\s-]?startups?)/i;
const STARTUP_PRESENCE_SHAPE_PATTERN = /(?:数据|data|事件|events?|表|行|rows?|tables?|数量|次数|总数|多少|几个|几次|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|有.*[吗么]|has|have|does|android[_\s-]?startups?|\bapp\s+launches\s*[?？]\s*$)/i;
const STARTUP_DURATION_FACT_SHAPE_PATTERN = /(?:(?:冷)?启动时间|耗时|时长|用时|用了多久|花了多久|持续多久|持续时间|多久|多长时间|duration|how\s+long|startup\s+time|startup\s+took|launch\s+(?:time|took)|app\s+launch\s+time|app\s+launch\s+duration)/i;
const STARTUP_DIAGNOSTIC_PATTERN = /(?:开始时间|结束时间|起止|ttid|ttfd|慢|性能|原因|为什么|根因|分析|诊断|优化|建议|卡顿|阻塞|高|低|偏高|偏低|过高|过低|太高|太低|正常|异常|合理|timing|start\s*time|end\s*time|timestamps?|time\s+to\s+display|slow|latency|\b(?:high|low|normal|abnormal|bad|good)\b|too\s+(?:high|low)|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|jank|blocked|blocking)/i;

const SCROLL_GESTURE_PATTERN = /(?:滑动|滚动|\bscroll(?:ing|s)?\b|\bscroll\s*gestures?\b|\bswipes?\b)/i;
const SCROLL_GESTURE_COUNT_SHAPE_PATTERN = /(?:次数|多少|几个|几次|手势|表|行|scrolls?|gesture|gestures?|swipes?|table|tables?|rows?|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|has|have|does)/i;
const SCROLL_GESTURE_DIAGNOSTIC_PATTERN = /(?:fps|帧率|帧|掉帧|丢帧|卡顿|流畅|性能|耗时|时延|延迟|慢|高|过多|很多|原因|为什么|根因|分析|诊断|优化|建议|jank|frame|rate|latency|slow|smooth|high|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend)/i;

const INPUT_EVENT_PATTERN = /(?:输入事件|触摸事件|触摸(?:次数|数量)|按键事件|按键次数|键盘事件|\binput\s*(?:events?|事件)|\btouch\s*(?:events?|事件)|\btouches?(?:\s+(?:events?|rows?|counts?|count))?\b|\bkey\s*(?:events?|事件)|\b(?:key|keyboard)\s*(?:events?|press(?:es)?)\b|android[_\s-]?input[_\s-]?events?|\b(?:input|touch|key)\s+(?:tables?|table\s+rows?|rows?|counts?)\b|(?:\b(?:android|input|touch)\b).{0,20}\bmotion\s*events?\b|\bmotion\s+(?:input|touch|rows?|counts?|count)\b|\bmotion\s+(?:input|touch)\s*events?\b|(?:how\s+many|count|counts?|rows?).{0,20}\b(?:motion\s*events?|touches?)\b|\bmotion\s*events?(?:\s+(?:count|counts?|rows?))?\b|(?:有|多少|几个|几).{0,12}motion.{0,8}事件|\bmotion\s*事件\s*(?:数量|次数))/i;
const INPUT_EVENT_COUNT_SHAPE_PATTERN = /(?:数量|次数|总数|多少|几个|几次|表|行|rows?|tables?|count|how\s+many|is\s+there|are\s+there|any|有没有|是否|有无|存在|has|have|does|[?？]\s*$)/i;
const INPUT_EVENT_DIAGNOSTIC_PATTERN = /(?:延迟|时延|耗时|慢|卡顿|掉帧|丢帧|原因|为什么|根因|分析|诊断|优化|建议|跟手|响应|导致|造成|latency|delay|slow|jank|dropped\s+frames?|frame\s+drops?|caus(?:e|es|ed|ing)|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|response|responsiveness)/i;
const CAUSAL_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|导致|造成|\b(?:why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|caus(?:e|es|ed|ing)|reasons?)\b)/i;
const TRACE_METRIC_EVALUATION_SUBJECT_PATTERN = /(?:帧率|fps|frame\s*rate|卡顿率|掉帧率|丢帧率|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?(?:\s*(?:count|number|rate))?|dropped\s*frame\s*percentage|frame\s*drops?(?:\s*(?:count|number|rate))?|帧数|总帧数|frame\s*count|total\s*frames?)/i;
const TRACE_METRIC_EVALUATION_DIAGNOSTIC_PATTERN = /(?:帧率低|帧率高|fps\s*(?:low|high)|卡顿率高|掉帧率高|丢帧率高|帧数(?:高|低)|总帧数(?:高|低)|(?:高|低|偏高|偏低|过高|过低|太高|太低|正常|异常|合理)(?:吗|么|[？?])|(?:是否|是不是).{0,12}(?:正常|异常|合理)|\b(?:fps|frame\s*rate|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?(?:\s*(?:count|number|rate))?|dropped\s*frame\s*percentage|frame\s*drops?(?:\s*(?:count|number|rate))?|frame\s*count|total\s*frames?)\b.{0,24}\b(?:high|low|slow|bad|normal|abnormal|too\s+high|too\s+low)\b|\b(?:is|are|was|were|seems?|looks?)\b.{0,24}\b(?:fps|frame\s*rate|jank\s*rate|janky\s*frame\s*rate|janky?\s*frames?(?:\s*(?:count|number))?|jank\s*count|dropped\s*frames?(?:\s*(?:count|number|rate))?|dropped\s*frame\s*percentage|frame\s*drops?(?:\s*(?:count|number|rate))?|frame\s*count|total\s*frames?)\b.{0,24}\b(?:high|low|slow|bad|normal|abnormal)\b)/i;
const TRACE_DURATION_EVALUATION_DIAGNOSTIC_PATTERN = /(?:时长|多长(?:时间)?|多久|长度|时间范围|duration|length|time\s*range|how\s+long).{0,24}(?:正常|异常|合理|过长|过短|太长|太短|高|低|normal|abnormal|reasonable|too\s+long|too\s+short|high|low)|(?:正常|异常|合理|过长|过短|太长|太短|normal|abnormal|reasonable|too\s+long|too\s+short|high|low).{0,24}(?:时长|长度|时间范围|duration|length|time\s*range)/i;
const PLAIN_CHINESE_PRESENCE_QUERY_PATTERN = /(?:^|[\s,，;；。.!！?？])有.{0,40}(?:吗|么)(?:[？?。.!！\s]*)$|有(?:吗|么)(?:[？?。.!！\s]*)$/;

const DEVICE_INFO_PATTERNS = [
  /设备信息|设备型号|机型|device\s*(?:info|model)|os\s*(?:version|info)|android\s*version/i,
  /(?:安卓|Android)\s*(?:SDK\s*)?版本|SDK\s*版本|android\s*sdk\s*version/i,
  /\bandroid\s*sdk\b/i,
  /^\s*(?:android\s+)?sdk\s*(?:version)?\s*[?？.。!！]*\s*$/i,
  /(?:android\s*)?build\s*fingerprint|device\s*fingerprint|build\s*fingerprint/i,
  /内核(?:版本)?|kernel\s*(?:release|version)|system\s*release/i,
  /(?:系统|设备|CPU|cpu)\s*架构|\b(?:device|cpu|system)\s+architecture\b|\bsystem\s+machine\b|\bwhat\s+architecture\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace)\s+from\b/i,
  /(?:设备|手机).*(?:厂商|制造商|manufacturer|vendor|brand)|(?:device|phone)\s*(?:manufacturer|vendor|brand)/i,
  /(?:SoC|soc|芯片|处理器).*(?:型号|信息|是什么|是哪款|model)|(?:soc|chipset|processor)\s*(?:model|info|information)/i,
  /^\s*soc\s*(?:model|info|information)?\s*[?？.。!！]*\s*$/i,
  /手机(?:信息|型号|机型|系统(?:版本)?|安卓(?:版本)?)/i,
  /(?:这|当前|本次|该)?(?:是|是什么|是哪台|是哪款|是哪部)?(?:哪台|哪款|哪部|什么)手机(?:[？?。.!\s]*$|录(?:制|的)?|采集|抓取|记录)/i,
  /(?:trace|录制|采集|抓取|记录).*(?:哪台|哪款|哪部|什么)手机/i,
  /\b(?:phone|device)\s*(?:model|info|information|os|system|android\s*version)\b/i,
  /\b(?:what|which)\s+(?:phone|device)\s+(?:is|was)\s+(?:this|this\s+trace|the\s+trace|this\s+recording|the\s+recording)\b/i,
  /\b(?:what|which)\s+(?:phone|device).*\b(?:recorded|captured|traced)\b/i,
];
const DEVICE_INFO_DIAGNOSTIC_PATTERN = /(?:为什么|原因|根因|分析|诊断|优化|建议|问题|异常|影响|支持|瓶颈|卡顿|卡住|慢|延迟|耗时|性能|why|root\s*cause|diagnos(?:e|is)|analy[sz]e|optimi[sz]e|recommend|issues?|problems?|abnormal|affect|impact|support|bottleneck|slow|jank|latency|performance)/i;

const JANK_FRAME_COUNT_PATTERNS = [
  /(?:掉帧|丢帧|卡顿)帧?(?:数量|数)|(?:多少|几个|几).*(?:掉帧|丢帧|卡顿)|(?:janky?|dropped)\s*frames?\s*(?:count|number)?\b|\bframe\s*drops?\s*(?:count|number)?\b|\bjank\s*frames?\s*(?:count|number)?\b|\bjank\s*count\b|how\s+many\s+(?:janky?|dropped)\s*frames?/i,
];

const JANK_PRESENCE_PATTERNS = [
  /掉帧率|丢帧率|卡顿率|jank\s*rate|janky\s*frame\s*rate|dropped\s*frames?\s*rate|dropped\s*frame\s*percentage|percentage\s+of\s+(?:janky|dropped)\s+frames?/i,
  /(?:掉帧|丢帧|卡顿)(?:比例|占比)(?:是多少|多少|[？?。\s]*$)|\bjanky?\s*(?:percentage|ratio)\s*[?]?\s*$|what\s+percentage\s+of\s+frames\s+(?:are|were)\s+(?:janky?|dropped)/i,
  /(?:有没有|是否|有无).*(?:掉帧|丢帧|卡顿|jank)|(?:掉帧|丢帧|卡顿).*(?:吗|么)(?:[？?。.!\s]*)$|(?:has|have|contains?)\b.*(?:jank|dropped\s*frames?)|\bany\s+jank\s*[?？.。!]*$|\b(?:is|was|are|were)\s+there\s+(?:any\s+)?jank(?:\s+in\s+(?:this\s+|the\s+)?(?:trace|recording|capture))?\s*[?？.。!]*$|\bjank\s+(?:present|detected)\s*[?？.。!]*$/i,
];
const TRACE_WIDE_JANK_SCOPE_PATTERN = /(?:(?:trace|录制|采集|抓取|记录|本次|当前|该|全局|整体|全量|整个|整段|overall|global|entire\s+trace|this\s+trace|recording).*(?:掉帧|丢帧|卡顿|jank|janky|dropped\s*frames?|frame\s*drops?))|(?:(?:掉帧|丢帧|卡顿|jank|janky|dropped\s*frames?|frame\s*drops?).*(?:trace|录制|采集|抓取|记录|全局|整体|全量|整个|整段|overall|global|entire\s+trace|this\s+trace|recording))/i;
const APP_SCOPED_JANK_PATTERN = /(?:焦点应用|目标应用|应用|app|application|package|包名|进程|process|主进程|线程|thread|surface|layer|窗口|window)/i;

export function shouldBuildQuickTraceFactEvidence(query: string): boolean {
  return detectQuickTraceFactEvidenceKind(query) !== undefined;
}

export function isScopedQuickTraceFactEvidenceKind(
  kind: QuickTraceFactEvidenceKind | undefined,
): boolean {
  return kind ? QUICK_TRACE_FACT_KIND_POLICY[kind].scoped : false;
}

export function shouldBuildScopedQuickTraceFactEvidence(query: string): boolean {
  return isScopedQuickTraceFactEvidenceKind(detectQuickTraceFactEvidenceKind(query));
}

export function shouldSkipFocusDetectionForQuickTraceFactEvidence(query: string): boolean {
  const kind = detectQuickTraceFactEvidenceKind(query);
  return kind ? QUICK_TRACE_FACT_KIND_POLICY[kind].skipFocusDetection : false;
}

function detectQuickTraceFactEvidenceKind(query: string): QuickTraceFactEvidenceKind | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  if (CAUSAL_DIAGNOSTIC_PATTERN.test(trimmed)) return undefined;
  if (
    TRACE_METRIC_EVALUATION_SUBJECT_PATTERN.test(trimmed) &&
    TRACE_METRIC_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  const asksForJankFrameCount = JANK_FRAME_COUNT_PATTERNS.some(pattern => pattern.test(trimmed));
  const asksForJankPresence = JANK_PRESENCE_PATTERNS.some(pattern => pattern.test(trimmed));
  const asksForFrameRate = FRAME_RATE_PATTERNS.some(pattern => pattern.test(trimmed));
  const asksForFrameCount = FRAME_COUNT_PATTERNS.some(pattern => pattern.test(trimmed));
  if (matchesTraceWideJankFactPattern(trimmed, asksForJankFrameCount || asksForJankPresence)) {
    return 'trace_jank_presence';
  }
  if (!asksForFrameRate && matchesTraceWideFrameCountFactPattern(trimmed, asksForFrameCount)) {
    return 'trace_frame_count';
  }
  if (asksForJankFrameCount) {
    return asksForFrameRate || asksForJankPresence ? 'jank_presence' : 'jank_frame_count';
  }
  if (asksForJankPresence) return 'jank_presence';
  if (matchesFrameTimelinePresencePattern(trimmed)) return 'frame_timeline_presence';
  if (matchesRefreshRateFactPattern(trimmed)) return 'refresh_rate';
  if (FRAME_METRIC_PATTERNS.some(pattern => pattern.test(trimmed))) return 'frame_metrics';
  if (SELECTION_DURATION_PATTERNS.some(pattern => pattern.test(trimmed))) return 'selection_duration';
  if (
    TRACE_DURATION_PATTERNS.some(pattern => pattern.test(trimmed)) &&
    !TRACE_DURATION_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)
  ) return 'trace_duration';
  if (matchesTraceHealthIssuePattern(trimmed)) return 'trace_health_issues';
  if (matchesTraceDataInventoryPattern(trimmed)) return 'trace_data_inventory';
  if (CPU_CORE_COUNT_PATTERNS.some(pattern => pattern.test(trimmed))) return 'cpu_core_count';
  if (matchesCpuFrequencyPresencePattern(trimmed)) return 'cpu_frequency_presence';
  if (matchesPowerCounterPresencePattern(trimmed)) return 'power_counter_presence';
  if (matchesMemoryCounterPresencePattern(trimmed)) return 'memory_counter_presence';
  if (matchesSchedulerDataPresencePattern(trimmed)) return 'scheduler_data_presence';
  if (matchesGpuDataPresencePattern(trimmed)) return 'gpu_data_presence';
  if (matchesLongestProcessSlicesFactQuery(trimmed)) return 'longest_process_slices';
  if (matchesSliceDataPresencePattern(trimmed)) return 'slice_data_presence';
  if (matchesNetworkPacketPresencePattern(trimmed)) return 'network_packet_presence';
  if (matchesLogcatPresencePattern(trimmed)) return 'logcat_presence';
  if (matchesAppScopedThreadCountPattern(trimmed)) return 'app_thread_count';
  if (matchesThreadCountPattern(trimmed)) return 'thread_count';
  if (matchesAppScopedProcessCountPattern(trimmed)) return 'app_process_count';
  if (matchesProcessCountPattern(trimmed)) return 'process_count';
  if (matchesBinderTransactionCountPattern(trimmed)) return 'binder_transaction_count';
  if (matchesAnrPresencePattern(trimmed)) return 'anr_presence';
  if (matchesStartupPresencePattern(trimmed)) return 'startup_presence';
  if (matchesScrollGestureCountPattern(trimmed)) return 'scroll_gesture_count';
  if (matchesInputEventCountPattern(trimmed)) return 'input_event_count';
  if (matchesDeviceInfoPattern(trimmed)) return 'device_info';
  return undefined;
}

function matchesTraceWideJankFactPattern(trimmed: string, asksForJankFact: boolean): boolean {
  return asksForJankFact
    && TRACE_WIDE_JANK_SCOPE_PATTERN.test(trimmed)
    && !APP_SCOPED_JANK_PATTERN.test(trimmed);
}

function matchesTraceWideFrameCountFactPattern(trimmed: string, asksForFrameCount: boolean): boolean {
  const asksForBareTraceWideFrameCount = TRACE_WIDE_BARE_FRAME_COUNT_PATTERN.test(trimmed);
  return (asksForFrameCount || asksForBareTraceWideFrameCount)
    && (asksForBareTraceWideFrameCount || TRACE_WIDE_FRAME_COUNT_SCOPE_PATTERN.test(trimmed))
    && !APP_SCOPED_FRAME_METRIC_PATTERN.test(trimmed);
}

function matchesDeviceInfoPattern(trimmed: string): boolean {
  return DEVICE_INFO_PATTERNS.some(pattern => pattern.test(trimmed))
    && !DEVICE_INFO_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesBinderTransactionCountPattern(trimmed: string): boolean {
  return BINDER_TRANSACTION_PATTERN.test(trimmed)
    && (BINDER_TRANSACTION_COUNT_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !BINDER_TRANSACTION_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesProcessCountPattern(trimmed: string): boolean {
  return PROCESS_COUNT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !PROCESS_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesAppScopedThreadCountPattern(trimmed: string): boolean {
  return APP_SCOPE_PATTERN.test(trimmed)
    && THREAD_COUNT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !THREAD_COUNT_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesThreadCountPattern(trimmed: string): boolean {
  return THREAD_COUNT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !THREAD_COUNT_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesAppScopedProcessCountPattern(trimmed: string): boolean {
  return APP_SCOPE_PATTERN.test(trimmed)
    && PROCESS_COUNT_PATTERNS.some(pattern => pattern.test(trimmed))
    && !PROCESS_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesTraceHealthIssuePattern(trimmed: string): boolean {
  return TRACE_HEALTH_PATTERN.test(trimmed)
    && (TRACE_HEALTH_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !TRACE_HEALTH_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesTraceDataInventoryPattern(trimmed: string): boolean {
  const isBareTraceDataInventory = TRACE_DATA_INVENTORY_BARE_PATTERN.test(trimmed);
  const isBareTraceDataInventoryTable = TRACE_DATA_INVENTORY_BARE_TABLE_PATTERN.test(trimmed);
  const isRawInventoryColumnFact = TRACE_DATA_INVENTORY_RAW_COLUMN_PATTERN.test(trimmed);
  return (TRACE_DATA_INVENTORY_PATTERN.test(trimmed) || isBareTraceDataInventory || isBareTraceDataInventoryTable || isRawInventoryColumnFact)
    && (isBareTraceDataInventory
      || isBareTraceDataInventoryTable
      || isRawInventoryColumnFact
      || TRACE_DATA_INVENTORY_SHAPE_PATTERN.test(trimmed)
      || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !matchesSpecificDataPresencePattern(trimmed)
    && !TRACE_DATA_INVENTORY_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesSpecificDataPresencePattern(trimmed: string): boolean {
  return matchesCpuFrequencyPresencePattern(trimmed)
    || matchesPowerCounterPresencePattern(trimmed)
    || matchesMemoryCounterPresencePattern(trimmed)
    || matchesSchedulerDataPresencePattern(trimmed)
    || matchesGpuDataPresencePattern(trimmed)
    || matchesSliceDataPresencePattern(trimmed)
    || matchesNetworkPacketPresencePattern(trimmed)
    || matchesLogcatPresencePattern(trimmed);
}

function matchesFrameTimelinePresencePattern(trimmed: string): boolean {
  return FRAME_TIMELINE_PRESENCE_PATTERN.test(trimmed)
    && (FRAME_TIMELINE_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !FRAME_TIMELINE_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesRefreshRateFactPattern(trimmed: string): boolean {
  const isBareRefreshRateFact = BARE_REFRESH_RATE_FACT_PATTERN.test(trimmed);
  return (REFRESH_RATE_FACT_PATTERN.test(trimmed) || isBareRefreshRateFact)
    && (isBareRefreshRateFact
      || REFRESH_RATE_FACT_SHAPE_PATTERN.test(trimmed)
      || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !REFRESH_RATE_FACT_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesCpuFrequencyPresencePattern(trimmed: string): boolean {
  return CPU_FREQUENCY_PRESENCE_PATTERN.test(trimmed)
    && (CPU_FREQUENCY_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !CPU_FREQUENCY_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesPowerCounterPresencePattern(trimmed: string): boolean {
  return POWER_COUNTER_PRESENCE_PATTERN.test(trimmed)
    && (POWER_COUNTER_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !POWER_COUNTER_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesMemoryCounterPresencePattern(trimmed: string): boolean {
  return MEMORY_COUNTER_PRESENCE_PATTERN.test(trimmed)
    && (MEMORY_COUNTER_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !MEMORY_COUNTER_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesSchedulerDataPresencePattern(trimmed: string): boolean {
  const isThreadStateCountFact = SCHEDULER_THREAD_STATE_COUNT_FACT_PATTERN.test(trimmed)
    || SCHEDULER_SHORT_THREAD_STATE_COUNT_FACT_PATTERN.test(trimmed);
  const isNonDiagnosticThreadStateCountFact = isThreadStateCountFact
    && !SCHEDULER_THREAD_STATE_COUNT_DIAGNOSTIC_PATTERN.test(trimmed);
  return (SCHEDULER_DATA_PRESENCE_PATTERN.test(trimmed) || isThreadStateCountFact)
    && (
      isThreadStateCountFact
      || SCHEDULER_DATA_PRESENCE_SHAPE_PATTERN.test(trimmed)
      || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed)
    )
    && (!SCHEDULER_DATA_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed) || isNonDiagnosticThreadStateCountFact);
}

function matchesGpuDataPresencePattern(trimmed: string): boolean {
  return GPU_DATA_PRESENCE_PATTERN.test(trimmed)
    && (GPU_DATA_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !GPU_DATA_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesSliceDataPresencePattern(trimmed: string): boolean {
  return SLICE_DATA_PRESENCE_PATTERN.test(trimmed)
    && (SLICE_DATA_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !SLICE_DATA_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesNetworkPacketPresencePattern(trimmed: string): boolean {
  return NETWORK_PACKET_PRESENCE_PATTERN.test(trimmed)
    && (NETWORK_PACKET_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !NETWORK_PACKET_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesLogcatPresencePattern(trimmed: string): boolean {
  const isSeverityCountFact = (LOGCAT_SEVERITY_COUNT_FACT_PATTERN.test(trimmed)
    || LOGCAT_CHINESE_SEVERITY_COUNT_FACT_PATTERN.test(trimmed))
    && !LOGCAT_AMBIGUOUS_ROW_ERROR_PATTERN.test(trimmed)
    && !LOGCAT_SEVERITY_EVALUATION_DIAGNOSTIC_PATTERN.test(trimmed)
    && !LOGCAT_CAUSAL_DIAGNOSTIC_PATTERN.test(trimmed);
  return (LOGCAT_PRESENCE_PATTERN.test(trimmed) || isSeverityCountFact)
    && (LOGCAT_PRESENCE_SHAPE_PATTERN.test(trimmed)
      || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed)
      || isSeverityCountFact)
    && (!LOGCAT_PRESENCE_DIAGNOSTIC_PATTERN.test(trimmed) || isSeverityCountFact);
}

function matchesAnrPresencePattern(trimmed: string): boolean {
  return ANR_PATTERN.test(trimmed)
    && (ANR_PRESENCE_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !ANR_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesStartupPresencePattern(trimmed: string): boolean {
  return STARTUP_PATTERN.test(trimmed)
    && (
      STARTUP_PRESENCE_SHAPE_PATTERN.test(trimmed)
      || STARTUP_DURATION_FACT_SHAPE_PATTERN.test(trimmed)
      || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed)
    )
    && !STARTUP_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesScrollGestureCountPattern(trimmed: string): boolean {
  return SCROLL_GESTURE_PATTERN.test(trimmed)
    && (SCROLL_GESTURE_COUNT_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !SCROLL_GESTURE_DIAGNOSTIC_PATTERN.test(trimmed);
}

function matchesInputEventCountPattern(trimmed: string): boolean {
  return INPUT_EVENT_PATTERN.test(trimmed)
    && (INPUT_EVENT_COUNT_SHAPE_PATTERN.test(trimmed) || PLAIN_CHINESE_PRESENCE_QUERY_PATTERN.test(trimmed))
    && !INPUT_EVENT_DIAGNOSTIC_PATTERN.test(trimmed);
}

export function shouldUseTraceFactEvidenceOnlyQuickAnalysis(input: {
  quickTraceFactPreEvidence: boolean;
  traceFactEvidence?: QuickTraceFactEvidencePayload;
}): boolean {
  const evidence = input.traceFactEvidence;
  return input.quickTraceFactPreEvidence
    && !!evidence?.promptContext
    && hasUsableTraceFactEvidence(evidence);
}

export function joinRuntimeEvidenceContexts(
  ...contexts: Array<string | undefined>
): string | undefined {
  const parts = contexts
    .map(context => context?.trim())
    .filter((context): context is string => Boolean(context));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function loadLongestProcessSlicesSkill() {
  if (cachedLongestProcessSlicesSkill !== undefined) return cachedLongestProcessSlicesSkill;

  const registry = new SkillRegistry();
  const skill = registry.loadSingleSkill(getSkillsDir(), LONGEST_PROCESS_SLICES_SKILL_PATH);
  cachedLongestProcessSlicesSkill = skill
    ? { skill, fragments: new Map(registry.getFragmentCache()) }
    : null;
  return cachedLongestProcessSlicesSkill;
}

export function createQuickLongestProcessSlicesSkillExecutor(
  traceProcessor: ConstructorParameters<typeof SkillExecutor>[0],
): SkillExecutor {
  const executor = new SkillExecutor(traceProcessor);
  const loaded = loadLongestProcessSlicesSkill();
  if (loaded) {
    executor.registerSkill(loaded.skill);
    executor.setFragmentRegistry(new Map(loaded.fragments));
  }
  return executor;
}

function hasDisplayRows(result: SkillExecutionResult): boolean {
  return result.displayResults.some(display =>
    Array.isArray(display.data.rows) && display.data.rows.length > 0);
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeTimeRange(timeRange?: FocusAppTimeRange): FocusAppTimeRange | undefined {
  if (!timeRange) return undefined;
  const startNs = Number(timeRange.startNs);
  const endNs = Number(timeRange.endNs);
  if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs <= startNs) {
    return undefined;
  }
  return { startNs, endNs };
}

function scopedFrameTimelineWhere(input: {
  timeRange?: FocusAppTimeRange;
  tsExpr: string;
  durExpr: string;
}): string {
  const base = `${input.tsExpr} IS NOT NULL
        AND ${input.durExpr} IS NOT NULL
        AND ${input.durExpr} >= 0`;
  if (!input.timeRange) return base;
  return `${base}
        AND ${input.tsExpr} < ${input.timeRange.endNs}
        AND (${input.tsExpr} + ${input.durExpr}) > ${input.timeRange.startNs}`;
}

function sourceToolCallId(kind: QuickTraceFactEvidenceKind, queryHash: string): string {
  return `runtime-trace-fact:${kind}:${queryHash}`;
}

function findTableEnvelope(envelopes: DataEnvelope[]): DataEnvelope | undefined {
  return envelopes.find(envelope =>
    Array.isArray(envelope.data.columns)
    && Array.isArray(envelope.data.rows)
    && envelope.data.rows.length > 0);
}

export function hasUsableTraceFactEvidence(evidence: QuickTraceFactEvidencePayload): boolean {
  const envelope = findTableEnvelope(evidence.envelopes);
  if (!envelope?.data.columns || !envelope.data.rows?.length) return false;

  const index = columnIndex(envelope.data.columns);
  const row = envelope.data.rows[0];
  if (evidence.evidenceKind === 'selection_duration') {
    const scopeStartNs = numericValue(rowValue(row, index, 'scope_start_ns'));
    const scopeEndNs = numericValue(rowValue(row, index, 'scope_end_ns'));
    const durationS = numericValue(rowValue(row, index, 'duration_s')) ?? 0;
    return scopeStartNs !== undefined && scopeEndNs !== undefined && scopeEndNs > scopeStartNs && durationS > 0;
  }

  if (evidence.evidenceKind === 'longest_process_slices') {
    return envelope.data.rows.every(candidate => {
      const durationMs = numericValue(rowValue(candidate, index, 'duration_ms')) ?? 0;
      const sliceName = String(rowValue(candidate, index, 'slice_name') ?? '').trim();
      const processName = String(rowValue(candidate, index, 'process_name') ?? '').trim();
      const threadName = String(rowValue(candidate, index, 'thread_name') ?? '').trim();
      const trackScope = String(rowValue(candidate, index, 'track_scope') ?? '').trim();
      const hasConsistentThreadIdentity = trackScope === 'process_track'
        ? threadName === '<process track>'
        : trackScope === 'thread_track'
          && threadName !== ''
          && threadName !== '<process track>';
      return durationMs > 0
        && sliceName !== ''
        && processName !== ''
        && hasConsistentThreadIdentity;
    });
  }

  if (evidence.evidenceKind === 'cpu_core_count') {
    const observedCpuCount = numericValue(rowValue(row, index, 'observed_cpu_count')) ?? 0;
    return observedCpuCount > 0;
  }

  if (evidence.evidenceKind === 'thread_count') {
    const threadCount = numericValue(rowValue(row, index, 'thread_count')) ?? 0;
    return threadCount > 0;
  }

  if (evidence.evidenceKind === 'app_thread_count') {
    const threadCount = numericValue(rowValue(row, index, 'thread_count')) ?? 0;
    return threadCount > 0;
  }

  if (evidence.evidenceKind === 'process_count') {
    const processCount = numericValue(rowValue(row, index, 'process_count')) ?? 0;
    return processCount > 0;
  }

  if (evidence.evidenceKind === 'app_process_count') {
    const processCount = numericValue(rowValue(row, index, 'process_count')) ?? 0;
    return processCount > 0;
  }

  if (evidence.evidenceKind === 'trace_health_issues') {
    const rawIssueStatCount = rowValue(row, index, 'issue_stat_count');
    if (
      rawIssueStatCount === undefined
      || rawIssueStatCount === null
      || String(rawIssueStatCount).trim() === ''
    ) {
      return false;
    }
    const issueStatCount = numericValue(rawIssueStatCount);
    return issueStatCount !== undefined && issueStatCount >= 0;
  }

  if (evidence.evidenceKind === 'trace_data_inventory') {
    const rawDuration = rowValue(row, index, 'duration_s');
    const rawSliceCount = rowValue(row, index, 'slice_count');
    const rawProcessCount = rowValue(row, index, 'process_count');
    const rawThreadCount = rowValue(row, index, 'thread_count');
    if (
      rawDuration === undefined
      || rawDuration === null
      || String(rawDuration).trim() === ''
      || rawSliceCount === undefined
      || rawSliceCount === null
      || String(rawSliceCount).trim() === ''
      || rawProcessCount === undefined
      || rawProcessCount === null
      || String(rawProcessCount).trim() === ''
      || rawThreadCount === undefined
      || rawThreadCount === null
      || String(rawThreadCount).trim() === ''
    ) {
      return false;
    }
    const duration = numericValue(rawDuration);
    const sliceCount = numericValue(rawSliceCount);
    const processCount = numericValue(rawProcessCount);
    const threadCount = numericValue(rawThreadCount);
    return duration !== undefined
      && duration >= 0
      && sliceCount !== undefined
      && sliceCount >= 0
      && processCount !== undefined
      && processCount >= 0
      && threadCount !== undefined
      && threadCount >= 0;
  }

  if (evidence.evidenceKind === 'frame_timeline_presence') {
    const rawActualFrameCount = rowValue(row, index, 'actual_frame_timeline_slice_count');
    const rawExpectedFrameCount = rowValue(row, index, 'expected_frame_timeline_slice_count');
    if (
      rawActualFrameCount === undefined
      || rawActualFrameCount === null
      || String(rawActualFrameCount).trim() === ''
      || rawExpectedFrameCount === undefined
      || rawExpectedFrameCount === null
      || String(rawExpectedFrameCount).trim() === ''
    ) {
      return false;
    }
    const actualFrameCount = numericValue(rawActualFrameCount);
    const expectedFrameCount = numericValue(rawExpectedFrameCount);
    return actualFrameCount !== undefined
      && actualFrameCount >= 0
      && expectedFrameCount !== undefined
      && expectedFrameCount >= 0;
  }

  if (evidence.evidenceKind === 'refresh_rate') {
    const rawRefreshRateHz = rowValue(row, index, 'refresh_rate_hz');
    const rawVsyncPeriodNs = rowValue(row, index, 'vsync_period_ns');
    const rawSampleCount = rowValue(row, index, 'sample_count');
    const detectionMethod = rowValue(row, index, 'detection_method');
    if (
      rawRefreshRateHz === undefined
      || rawRefreshRateHz === null
      || String(rawRefreshRateHz).trim() === ''
      || rawVsyncPeriodNs === undefined
      || rawVsyncPeriodNs === null
      || String(rawVsyncPeriodNs).trim() === ''
      || rawSampleCount === undefined
      || rawSampleCount === null
      || String(rawSampleCount).trim() === ''
      || detectionMethod === undefined
      || detectionMethod === null
      || String(detectionMethod).trim() === ''
      || String(detectionMethod).trim() === 'default_60hz'
    ) {
      return false;
    }
    const refreshRateHz = numericValue(rawRefreshRateHz);
    const vsyncPeriodNs = numericValue(rawVsyncPeriodNs);
    const sampleCount = numericValue(rawSampleCount);
    return refreshRateHz !== undefined
      && refreshRateHz > 0
      && vsyncPeriodNs !== undefined
      && vsyncPeriodNs > 0
      && sampleCount !== undefined
      && sampleCount >= 10;
  }

  if (evidence.evidenceKind === 'cpu_frequency_presence') {
    const rawSampleCount = rowValue(row, index, 'cpufreq_sample_count');
    if (
      rawSampleCount === undefined
      || rawSampleCount === null
      || String(rawSampleCount).trim() === ''
    ) {
      return false;
    }
    const sampleCount = numericValue(rawSampleCount);
    return sampleCount !== undefined && sampleCount >= 0;
  }

  if (evidence.evidenceKind === 'power_counter_presence') {
    const rawSampleCount = rowValue(row, index, 'power_counter_sample_count');
    if (
      rawSampleCount === undefined
      || rawSampleCount === null
      || String(rawSampleCount).trim() === ''
    ) {
      return false;
    }
    const sampleCount = numericValue(rawSampleCount);
    return sampleCount !== undefined && sampleCount >= 0;
  }

  if (evidence.evidenceKind === 'memory_counter_presence') {
    const rawSampleCount = rowValue(row, index, 'memory_counter_sample_count');
    if (
      rawSampleCount === undefined
      || rawSampleCount === null
      || String(rawSampleCount).trim() === ''
    ) {
      return false;
    }
    const sampleCount = numericValue(rawSampleCount);
    return sampleCount !== undefined && sampleCount >= 0;
  }

  if (evidence.evidenceKind === 'scheduler_data_presence') {
    const rawSchedSliceCount = rowValue(row, index, 'sched_slice_count');
    const rawThreadStateCount = rowValue(row, index, 'thread_state_count');
    if (
      rawSchedSliceCount === undefined
      || rawSchedSliceCount === null
      || String(rawSchedSliceCount).trim() === ''
      || rawThreadStateCount === undefined
      || rawThreadStateCount === null
      || String(rawThreadStateCount).trim() === ''
    ) {
      return false;
    }
    const schedSliceCount = numericValue(rawSchedSliceCount);
    const threadStateCount = numericValue(rawThreadStateCount);
    return schedSliceCount !== undefined
      && schedSliceCount >= 0
      && threadStateCount !== undefined
      && threadStateCount >= 0;
  }

  if (evidence.evidenceKind === 'gpu_data_presence') {
    const rawGpuSliceCount = rowValue(row, index, 'gpu_slice_count');
    const rawGpuCounterSampleCount = rowValue(row, index, 'gpu_counter_sample_count');
    if (
      rawGpuSliceCount === undefined
      || rawGpuSliceCount === null
      || String(rawGpuSliceCount).trim() === ''
      || rawGpuCounterSampleCount === undefined
      || rawGpuCounterSampleCount === null
      || String(rawGpuCounterSampleCount).trim() === ''
    ) {
      return false;
    }
    const gpuSliceCount = numericValue(rawGpuSliceCount);
    const gpuCounterSampleCount = numericValue(rawGpuCounterSampleCount);
    return gpuSliceCount !== undefined
      && gpuSliceCount >= 0
      && gpuCounterSampleCount !== undefined
      && gpuCounterSampleCount >= 0;
  }

  if (evidence.evidenceKind === 'slice_data_presence') {
    const rawSliceCount = rowValue(row, index, 'slice_count');
    const rawTrackCount = rowValue(row, index, 'track_count');
    if (
      rawSliceCount === undefined
      || rawSliceCount === null
      || String(rawSliceCount).trim() === ''
      || rawTrackCount === undefined
      || rawTrackCount === null
      || String(rawTrackCount).trim() === ''
    ) {
      return false;
    }
    const sliceCount = numericValue(rawSliceCount);
    const trackCount = numericValue(rawTrackCount);
    return sliceCount !== undefined
      && sliceCount >= 0
      && trackCount !== undefined
      && trackCount >= 0;
  }

  if (evidence.evidenceKind === 'network_packet_presence') {
    const rawEventCount = rowValue(row, index, 'network_packet_event_count');
    const rawPacketCount = rowValue(row, index, 'network_packet_count');
    const rawBytes = rowValue(row, index, 'network_packet_bytes');
    if (
      rawEventCount === undefined
      || rawEventCount === null
      || String(rawEventCount).trim() === ''
      || rawPacketCount === undefined
      || rawPacketCount === null
      || String(rawPacketCount).trim() === ''
      || rawBytes === undefined
      || rawBytes === null
      || String(rawBytes).trim() === ''
    ) {
      return false;
    }
    const eventCount = numericValue(rawEventCount);
    const packetCount = numericValue(rawPacketCount);
    const bytes = numericValue(rawBytes);
    return eventCount !== undefined
      && eventCount >= 0
      && packetCount !== undefined
      && packetCount >= 0
      && bytes !== undefined
      && bytes >= 0;
  }

  if (evidence.evidenceKind === 'logcat_presence') {
    const rawEventCount = rowValue(row, index, 'logcat_event_count');
    if (
      rawEventCount === undefined
      || rawEventCount === null
      || String(rawEventCount).trim() === ''
    ) {
      return false;
    }
    const eventCount = numericValue(rawEventCount);
    return eventCount !== undefined && eventCount >= 0;
  }

  if (evidence.evidenceKind === 'binder_transaction_count') {
    const rawBinderTxnCount = rowValue(row, index, 'binder_txn_count');
    if (
      rawBinderTxnCount === undefined
      || rawBinderTxnCount === null
      || String(rawBinderTxnCount).trim() === ''
    ) {
      return false;
    }
    const binderTxnCount = numericValue(rawBinderTxnCount);
    return binderTxnCount !== undefined && binderTxnCount >= 0;
  }

  if (evidence.evidenceKind === 'anr_presence') {
    const rawAnrCount = rowValue(row, index, 'total_anr_count');
    if (
      rawAnrCount === undefined
      || rawAnrCount === null
      || String(rawAnrCount).trim() === ''
    ) {
      return false;
    }
    const totalAnrCount = numericValue(rawAnrCount);
    return totalAnrCount !== undefined && totalAnrCount >= 0;
  }

  if (evidence.evidenceKind === 'startup_presence') {
    const rawStartupCount = rowValue(row, index, 'startup_count');
    if (
      rawStartupCount === undefined
      || rawStartupCount === null
      || String(rawStartupCount).trim() === ''
    ) {
      return false;
    }
    const startupCount = numericValue(rawStartupCount);
    return startupCount !== undefined && startupCount >= 0;
  }

  if (evidence.evidenceKind === 'scroll_gesture_count') {
    const rawScrollGestureCount = rowValue(row, index, 'scroll_gesture_count');
    if (
      rawScrollGestureCount === undefined
      || rawScrollGestureCount === null
      || String(rawScrollGestureCount).trim() === ''
    ) {
      return false;
    }
    const scrollGestureCount = numericValue(rawScrollGestureCount);
    return scrollGestureCount !== undefined && scrollGestureCount >= 0;
  }

  if (evidence.evidenceKind === 'input_event_count') {
    const rawInputEventCount = rowValue(row, index, 'input_event_count');
    if (
      rawInputEventCount === undefined
      || rawInputEventCount === null
      || String(rawInputEventCount).trim() === ''
    ) {
      return false;
    }
    const inputEventCount = numericValue(rawInputEventCount);
    return inputEventCount !== undefined && inputEventCount >= 0;
  }

  if (evidence.evidenceKind === 'device_info') {
    return [
      'android_device_manufacturer',
      'android_build_fingerprint',
      'android_sdk_version',
      'android_soc_model',
      'system_name',
      'system_release',
      'system_machine',
    ].some(column => {
      const value = rowValue(row, index, column);
      return value !== undefined && value !== null && String(value).trim() !== '';
    });
  }

  if (
    evidence.evidenceKind === 'jank_presence'
    || evidence.evidenceKind === 'jank_frame_count'
    || evidence.evidenceKind === 'trace_jank_presence'
  ) {
    const totalFrames = numericValue(rowValue(row, index, 'total_frames')) ?? 0;
    const jankFrames = numericValue(rowValue(row, index, 'jank_frames')) ?? -1;
    return totalFrames > 0 && jankFrames >= 0;
  }

  if (evidence.evidenceKind === 'trace_frame_count') {
    const totalFrames = numericValue(rowValue(row, index, 'total_frames')) ?? 0;
    return totalFrames > 0;
  }

  const durationS = numericValue(rowValue(row, index, 'duration_s')) ?? 0;
  if (durationS <= 0) return false;

  if (evidence.evidenceKind === 'frame_metrics') {
    const totalFrames = numericValue(rowValue(row, index, 'total_frames')) ?? 0;
    const fps = numericValue(rowValue(row, index, 'fps')) ?? 0;
    return totalFrames > 0 && fps > 0;
  }

  return evidence.evidenceKind === 'trace_duration';
}

function buildPromptContext(
  payload: QuickTraceFactEvidencePayload,
  outputLanguage: OutputLanguage,
): string | undefined {
  const tableEnvelope = findTableEnvelope(payload.envelopes);
  if (!tableEnvelope?.data.columns || !tableEnvelope.data.rows?.length) return undefined;

  const columns = tableEnvelope.data.columns;
  const index = columnIndex(columns);
  const preferredColumns = preferredColumnsForEvidenceKind(payload.evidenceKind)
    .filter(column => index.has(column));
  if (preferredColumns.length === 0) return undefined;

  const header = `| ${preferredColumns.join(' | ')} |`;
  const separator = `| ${preferredColumns.map(() => '---').join(' | ')} |`;
  const rows = tableEnvelope.data.rows
    .slice(0, PROMPT_MAX_ROWS)
    .map(row => `| ${preferredColumns.map(column => cellText(row[index.get(column)!])).join(' | ')} |`);

  const sourceLines = [
    `- evidence_ref_id: \`${tableEnvelope.meta.evidenceRefId}\``,
    `- source_tool_call_id: \`${tableEnvelope.meta.sourceToolCallId}\``,
  ].join('\n');

  const scoped = index.has('scope_start_ns') && index.has('scope_end_ns');
  const titleZh = titleForEvidenceKind(payload.evidenceKind, 'zh-CN', scoped);
  const titleEn = titleForEvidenceKind(payload.evidenceKind, 'en', scoped);

  return localize(
    outputLanguage,
    `${titleZh}\n${sourceLines}\n\n${header}\n${separator}\n${rows.join('\n')}`,
    `${titleEn}\n${sourceLines}\n\n${header}\n${separator}\n${rows.join('\n')}`,
  );
}

function preferredColumnsForEvidenceKind(
  kind: QuickTraceFactEvidenceKind | undefined,
): string[] {
  if (kind === 'frame_metrics') return FRAME_METRIC_COLUMNS;
  if (kind === 'selection_duration') return SELECTION_DURATION_COLUMNS;
  if (kind === 'trace_frame_count') return TRACE_FRAME_COUNT_COLUMNS;
  if (kind === 'jank_presence') return JANK_PRESENCE_COLUMNS;
  if (kind === 'jank_frame_count') return JANK_FRAME_COUNT_COLUMNS;
  if (kind === 'trace_jank_presence') return TRACE_JANK_PRESENCE_COLUMNS;
  if (kind === 'frame_timeline_presence') return FRAME_TIMELINE_PRESENCE_COLUMNS;
  if (kind === 'refresh_rate') return REFRESH_RATE_COLUMNS;
  if (kind === 'trace_duration') return TRACE_DURATION_COLUMNS;
  if (kind === 'trace_health_issues') return TRACE_HEALTH_ISSUE_COLUMNS;
  if (kind === 'trace_data_inventory') return TRACE_DATA_INVENTORY_COLUMNS;
  if (kind === 'cpu_core_count') return CPU_CORE_COUNT_COLUMNS;
  if (kind === 'cpu_frequency_presence') return CPU_FREQUENCY_PRESENCE_COLUMNS;
  if (kind === 'power_counter_presence') return POWER_COUNTER_PRESENCE_COLUMNS;
  if (kind === 'memory_counter_presence') return MEMORY_COUNTER_PRESENCE_COLUMNS;
  if (kind === 'scheduler_data_presence') return SCHEDULER_DATA_PRESENCE_COLUMNS;
  if (kind === 'gpu_data_presence') return GPU_DATA_PRESENCE_COLUMNS;
  if (kind === 'longest_process_slices') return LONGEST_PROCESS_SLICES_COLUMNS;
  if (kind === 'slice_data_presence') return SLICE_DATA_PRESENCE_COLUMNS;
  if (kind === 'network_packet_presence') return NETWORK_PACKET_PRESENCE_COLUMNS;
  if (kind === 'logcat_presence') return LOGCAT_PRESENCE_COLUMNS;
  if (kind === 'thread_count') return THREAD_COUNT_COLUMNS;
  if (kind === 'app_thread_count') return APP_PROCESS_THREAD_COUNT_COLUMNS;
  if (kind === 'process_count') return PROCESS_COUNT_COLUMNS;
  if (kind === 'app_process_count') return APP_PROCESS_THREAD_COUNT_COLUMNS;
  if (kind === 'binder_transaction_count') return BINDER_TRANSACTION_COUNT_COLUMNS;
  if (kind === 'anr_presence') return ANR_PRESENCE_COLUMNS;
  if (kind === 'startup_presence') return STARTUP_PRESENCE_COLUMNS;
  if (kind === 'scroll_gesture_count') return SCROLL_GESTURE_COUNT_COLUMNS;
  if (kind === 'input_event_count') return INPUT_EVENT_COUNT_COLUMNS;
  if (kind === 'device_info') return DEVICE_INFO_COLUMNS;
  return [];
}

function titleForEvidenceKind(
  kind: QuickTraceFactEvidenceKind | undefined,
  outputLanguage: OutputLanguage,
  scoped = false,
): string {
  if (scoped && kind === 'frame_metrics') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: Frame Rate and Frame Count Metrics'
      : '## 当前选区运行时预证据：帧率/帧数基础指标';
  }
  if (scoped && kind === 'trace_frame_count') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: FrameTimeline Frame Count'
      : '## 当前选区运行时预证据：FrameTimeline 帧数';
  }
  if (scoped && kind === 'jank_presence') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: FrameTimeline Jank Presence'
      : '## 当前选区运行时预证据：FrameTimeline 掉帧/卡顿存在性';
  }
  if (scoped && kind === 'jank_frame_count') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: FrameTimeline Janky Frame Count'
      : '## 当前选区运行时预证据：FrameTimeline 掉帧/卡顿帧数';
  }
  if (scoped && kind === 'trace_jank_presence') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: FrameTimeline Jank'
      : '## 当前选区运行时预证据：FrameTimeline 掉帧/卡顿';
  }
  if (kind === 'frame_metrics') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Frame Rate and Frame Count Metrics'
      : '## 当前 Trace 运行时预证据：帧率/帧数基础指标';
  }
  if (kind === 'selection_duration') {
    return outputLanguage === 'en'
      ? '## Current Selection Runtime Evidence: Selection Duration'
      : '## 当前选区运行时预证据：选区时长';
  }
  if (kind === 'trace_frame_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Trace-Wide FrameTimeline Frame Count'
      : '## 当前 Trace 运行时预证据：Trace 全局 FrameTimeline 帧数';
  }
  if (kind === 'trace_duration') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Trace Recording Duration'
      : '## 当前 Trace 运行时预证据：Trace 录制时长';
  }
  if (kind === 'trace_health_issues') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Trace Health Issues'
      : '## 当前 Trace 运行时预证据：Trace 采集/解析健康问题';
  }
  if (kind === 'trace_data_inventory') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Common Trace Data Inventory'
      : '## 当前 Trace 运行时预证据：常用 Trace 数据清单';
  }
  if (kind === 'cpu_frequency_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: CPU Frequency Counter Availability'
      : '## 当前 Trace 运行时预证据：CPU 频率计数器可用性';
  }
  if (kind === 'power_counter_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Power and Battery Counter Availability'
      : '## 当前 Trace 运行时预证据：功耗/电量相关计数器可用性';
  }
  if (kind === 'memory_counter_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Memory Counter Availability'
      : '## 当前 Trace 运行时预证据：内存相关计数器可用性';
  }
  if (kind === 'scheduler_data_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Scheduler and Thread-State Data Availability'
      : '## 当前 Trace 运行时预证据：调度和线程状态数据可用性';
  }
  if (kind === 'gpu_data_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: GPU Slice and Counter Data Availability'
      : '## 当前 Trace 运行时预证据：GPU slice 和 counter 数据可用性';
  }
  if (kind === 'longest_process_slices') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Longest Process Slices'
      : '## 当前 Trace 运行时预证据：最长进程 Slice';
  }
  if (kind === 'slice_data_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Generic Slice and Track Data Availability'
      : '## 当前 Trace 运行时预证据：通用 slice/track 数据可用性';
  }
  if (kind === 'network_packet_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Android Network Packet Data Availability'
      : '## 当前 Trace 运行时预证据：Android 网络包数据可用性';
  }
  if (kind === 'logcat_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Android Logcat Data Availability'
      : '## 当前 Trace 运行时预证据：Android Logcat 日志数据可用性';
  }
  if (kind === 'jank_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: FrameTimeline Jank Presence'
      : '## 当前 Trace 运行时预证据：FrameTimeline 掉帧/卡顿存在性';
  }
  if (kind === 'jank_frame_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: FrameTimeline Janky Frame Count'
      : '## 当前 Trace 运行时预证据：FrameTimeline 掉帧/卡顿帧数';
  }
  if (kind === 'trace_jank_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Trace-Wide FrameTimeline Jank'
      : '## 当前 Trace 运行时预证据：Trace 全局 FrameTimeline 掉帧/卡顿';
  }
  if (kind === 'frame_timeline_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: FrameTimeline Data Availability'
      : '## 当前 Trace 运行时预证据：FrameTimeline 数据可用性';
  }
  if (kind === 'refresh_rate') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Observed VSync Refresh Rate'
      : '## 当前 Trace 运行时预证据：观测到的 VSync 刷新率';
  }
  if (kind === 'thread_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Observed Thread Count'
      : '## 当前 Trace 运行时预证据：观测到的线程数';
  }
  if (kind === 'app_thread_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Focus App Thread Count'
      : '## 当前 Trace 运行时预证据：焦点应用线程数';
  }
  if (kind === 'process_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Observed Process Count'
      : '## 当前 Trace 运行时预证据：观测到的进程数';
  }
  if (kind === 'app_process_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Focus App Process Count'
      : '## 当前 Trace 运行时预证据：焦点应用进程数';
  }
  if (kind === 'binder_transaction_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Binder Transaction Count'
      : '## 当前 Trace 运行时预证据：Binder Transaction 数量';
  }
  if (kind === 'anr_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: ANR Presence'
      : '## 当前 Trace 运行时预证据：ANR 存在性';
  }
  if (kind === 'startup_presence') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: App Startup Presence'
      : '## 当前 Trace 运行时预证据：App 启动事件存在性';
  }
  if (kind === 'scroll_gesture_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Scroll Gesture Count'
      : '## 当前 Trace 运行时预证据：滑动手势数量';
  }
  if (kind === 'input_event_count') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Input Event Count'
      : '## 当前 Trace 运行时预证据：输入事件数量';
  }
  if (kind === 'device_info') {
    return outputLanguage === 'en'
      ? '## Current Trace Runtime Evidence: Device and System Metadata'
      : '## 当前 Trace 运行时预证据：设备和系统元数据';
  }
  return outputLanguage === 'en'
    ? '## Current Trace Runtime Evidence: Observed CPU Core Count'
    : '## 当前 Trace 运行时预证据：观测到的 CPU 核心数';
}

function displayTitleForEvidenceKind(
  kind: QuickTraceFactEvidenceKind,
  scoped = false,
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): string {
  if (kind === 'longest_process_slices') {
    return localize(
      outputLanguage,
      scoped ? '当前选区最长进程 Slice' : '当前 Trace 最长进程 Slice',
      scoped ? 'Longest process slices in the current selection' : 'Longest process slices in the current trace',
    );
  }
  let englishTitle = 'Runtime observed CPU core count pre-evidence';
  if (scoped && kind === 'frame_metrics') englishTitle = 'Runtime selected-range frame metrics pre-evidence';
  else if (kind === 'selection_duration') englishTitle = 'Runtime selected-range duration pre-evidence';
  else if (scoped && kind === 'trace_frame_count') englishTitle = 'Runtime selected-range FrameTimeline frame count pre-evidence';
  else if (scoped && kind === 'jank_presence') englishTitle = 'Runtime selected-range FrameTimeline jank presence pre-evidence';
  else if (scoped && kind === 'jank_frame_count') englishTitle = 'Runtime selected-range FrameTimeline janky frame count pre-evidence';
  else if (scoped && kind === 'trace_jank_presence') englishTitle = 'Runtime selected-range FrameTimeline jank pre-evidence';
  else if (kind === 'frame_metrics') englishTitle = 'Runtime frame metrics pre-evidence';
  else if (kind === 'trace_frame_count') englishTitle = 'Runtime trace-wide FrameTimeline frame count pre-evidence';
  else if (kind === 'jank_presence') englishTitle = 'Runtime FrameTimeline jank presence pre-evidence';
  else if (kind === 'jank_frame_count') englishTitle = 'Runtime FrameTimeline janky frame count pre-evidence';
  else if (kind === 'trace_jank_presence') englishTitle = 'Runtime trace-wide FrameTimeline jank pre-evidence';
  else if (kind === 'frame_timeline_presence') englishTitle = 'Runtime FrameTimeline data availability pre-evidence';
  else if (kind === 'refresh_rate') englishTitle = 'Runtime observed VSync refresh rate pre-evidence';
  else if (kind === 'trace_duration') englishTitle = 'Runtime trace duration pre-evidence';
  else if (kind === 'trace_health_issues') englishTitle = 'Runtime trace health issue pre-evidence';
  else if (kind === 'trace_data_inventory') englishTitle = 'Runtime common trace data inventory pre-evidence';
  else if (kind === 'cpu_frequency_presence') englishTitle = 'Runtime CPU frequency counter availability pre-evidence';
  else if (kind === 'power_counter_presence') englishTitle = 'Runtime power and battery counter availability pre-evidence';
  else if (kind === 'memory_counter_presence') englishTitle = 'Runtime memory counter availability pre-evidence';
  else if (kind === 'scheduler_data_presence') englishTitle = 'Runtime scheduler and thread-state data availability pre-evidence';
  else if (kind === 'gpu_data_presence') englishTitle = 'Runtime GPU slice and counter data availability pre-evidence';
  else if (kind === 'slice_data_presence') englishTitle = 'Runtime generic slice and track data availability pre-evidence';
  else if (kind === 'network_packet_presence') englishTitle = 'Runtime Android network packet data availability pre-evidence';
  else if (kind === 'logcat_presence') englishTitle = 'Runtime Android Logcat data availability pre-evidence';
  else if (kind === 'thread_count') englishTitle = 'Runtime observed thread count pre-evidence';
  else if (kind === 'app_thread_count') englishTitle = 'Runtime focus app thread count pre-evidence';
  else if (kind === 'process_count') englishTitle = 'Runtime observed process count pre-evidence';
  else if (kind === 'app_process_count') englishTitle = 'Runtime focus app process count pre-evidence';
  else if (kind === 'binder_transaction_count') englishTitle = 'Runtime Binder transaction count pre-evidence';
  else if (kind === 'anr_presence') englishTitle = 'Runtime ANR presence pre-evidence';
  else if (kind === 'startup_presence') englishTitle = 'Runtime app startup presence pre-evidence';
  else if (kind === 'scroll_gesture_count') englishTitle = 'Runtime scroll gesture count pre-evidence';
  else if (kind === 'input_event_count') englishTitle = 'Runtime input event count pre-evidence';
  else if (kind === 'device_info') englishTitle = 'Runtime device and system metadata pre-evidence';
  return localize(
    outputLanguage,
    `运行时${scoped ? '选区' : ''} Trace 事实预证据：${kind}`,
    englishTitle,
  );
}

function explicitColumnDefinitionsForEvidenceKind(kind: QuickTraceFactEvidenceKind) {
  if (kind === 'frame_metrics') {
    return [
      { name: 'package_name', type: 'string' as const, format: 'code' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'upid_count', type: 'number' as const },
      { name: 'total_frames', type: 'number' as const },
      { name: 'window_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'window_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'fps', type: 'number' as const },
      { name: 'scope_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'scope_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'trace_frame_count') {
    return [
      { name: 'scope', type: 'string' as const, format: 'code' as const },
      { name: 'total_frames', type: 'number' as const },
      { name: 'window_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'window_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'scope_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'scope_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'trace_duration') {
    return [
      { name: 'trace_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'trace_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'selection_duration') {
    return [
      { name: 'scope', type: 'string' as const, format: 'code' as const },
      { name: 'scope_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'scope_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_ns', type: 'duration' as const, unit: 'ns' as const, format: 'duration_ms' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'trace_health_issues') {
    return [
      { name: 'issue_stat_count', type: 'number' as const },
      { name: 'error_stat_count', type: 'number' as const },
      { name: 'data_loss_stat_count', type: 'number' as const },
      { name: 'total_issue_value', type: 'number' as const },
      { name: 'issue_names', type: 'string' as const, format: 'code' as const },
      { name: 'issue_values', type: 'string' as const, format: 'code' as const },
      { name: 'issue_severities', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'trace_data_inventory') {
    return [
      { name: 'trace_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'trace_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'slice_count', type: 'number' as const },
      { name: 'track_count', type: 'number' as const },
      { name: 'process_track_count', type: 'number' as const },
      { name: 'thread_track_count', type: 'number' as const },
      { name: 'process_count', type: 'number' as const },
      { name: 'thread_count', type: 'number' as const },
      { name: 'sched_slice_count', type: 'number' as const },
      { name: 'thread_state_count', type: 'number' as const },
      { name: 'counter_track_count', type: 'number' as const },
      { name: 'process_counter_track_count', type: 'number' as const },
      { name: 'cpu_counter_track_count', type: 'number' as const },
      { name: 'gpu_counter_track_count', type: 'number' as const },
      { name: 'counter_sample_count', type: 'number' as const },
      { name: 'cpufreq_sample_count', type: 'number' as const },
      { name: 'actual_frame_timeline_slice_count', type: 'number' as const },
      { name: 'expected_frame_timeline_slice_count', type: 'number' as const },
      { name: 'gpu_slice_count', type: 'number' as const },
      { name: 'gpu_counter_sample_count', type: 'number' as const },
      { name: 'network_packet_event_count', type: 'number' as const },
      { name: 'android_log_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'frame_timeline_presence') {
    return [
      { name: 'actual_frame_timeline_slice_count', type: 'number' as const },
      { name: 'expected_frame_timeline_slice_count', type: 'number' as const },
      { name: 'janky_actual_frame_count', type: 'number' as const },
      { name: 'actual_frame_upid_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'refresh_rate') {
    return [
      { name: 'refresh_rate_hz', type: 'number' as const },
      { name: 'vsync_period_ns', type: 'number' as const },
      { name: 'vsync_period_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'detection_method', type: 'string' as const, format: 'code' as const },
      { name: 'sample_count', type: 'number' as const },
      { name: 'raw_median_period_ns', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'cpu_frequency_presence') {
    return [
      { name: 'cpufreq_cpu_count', type: 'number' as const },
      { name: 'cpufreq_sample_count', type: 'number' as const },
      { name: 'cpufreq_cpus', type: 'string' as const, format: 'code' as const },
      { name: 'min_freq_khz', type: 'number' as const },
      { name: 'max_freq_khz', type: 'number' as const },
      { name: 'first_sample_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_sample_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'power_counter_presence') {
    return [
      { name: 'power_counter_track_count', type: 'number' as const },
      { name: 'power_counter_sample_count', type: 'number' as const },
      { name: 'power_counter_names', type: 'string' as const, format: 'code' as const },
      { name: 'power_counter_sample_counts', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'memory_counter_presence') {
    return [
      { name: 'memory_counter_track_count', type: 'number' as const },
      { name: 'memory_counter_sample_count', type: 'number' as const },
      { name: 'memory_counter_names', type: 'string' as const, format: 'code' as const },
      { name: 'memory_counter_sample_counts', type: 'string' as const, format: 'code' as const },
      { name: 'memory_counter_max_values', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'scheduler_data_presence') {
    return [
      { name: 'sched_slice_count', type: 'number' as const },
      { name: 'thread_state_count', type: 'number' as const },
      { name: 'running_state_count', type: 'number' as const },
      { name: 'runnable_state_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'gpu_data_presence') {
    return [
      { name: 'gpu_slice_count', type: 'number' as const },
      { name: 'gpu_counter_track_count', type: 'number' as const },
      { name: 'gpu_counter_sample_count', type: 'number' as const },
      { name: 'gpu_counter_names', type: 'string' as const, format: 'code' as const },
      { name: 'gpu_slice_names', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'longest_process_slices') {
    return [
      { name: 'ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'dur_ns', type: 'duration' as const, unit: 'ns' as const, format: 'duration_ms' as const },
      { name: 'duration_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'slice_name', type: 'string' as const, format: 'code' as const },
      { name: 'process_name', type: 'string' as const, format: 'code' as const },
      { name: 'thread_name', type: 'string' as const, format: 'code' as const },
      { name: 'track_scope', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'slice_data_presence') {
    return [
      { name: 'slice_count', type: 'number' as const },
      { name: 'track_count', type: 'number' as const },
      { name: 'process_track_count', type: 'number' as const },
      { name: 'thread_track_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'network_packet_presence') {
    return [
      { name: 'network_packet_event_count', type: 'number' as const },
      { name: 'network_packet_count', type: 'number' as const },
      { name: 'network_packet_bytes', type: 'number' as const },
      { name: 'network_iface_count', type: 'number' as const },
      { name: 'network_transport_count', type: 'number' as const },
      { name: 'network_ifaces', type: 'string' as const, format: 'code' as const },
      { name: 'network_iface_packet_counts', type: 'string' as const, format: 'code' as const },
      { name: 'network_transports', type: 'string' as const, format: 'code' as const },
      { name: 'network_transport_packet_counts', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'logcat_presence') {
    return [
      { name: 'logcat_event_count', type: 'number' as const },
      { name: 'warn_log_count', type: 'number' as const },
      { name: 'error_log_count', type: 'number' as const },
      { name: 'fatal_log_count', type: 'number' as const },
      { name: 'distinct_tag_count', type: 'number' as const },
      { name: 'sample_tags', type: 'string' as const, format: 'code' as const },
      { name: 'sample_tag_counts', type: 'string' as const, format: 'code' as const },
      { name: 'first_log_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_log_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'jank_presence' || kind === 'jank_frame_count') {
    return [
      { name: 'package_name', type: 'string' as const, format: 'code' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'total_frames', type: 'number' as const },
      { name: 'jank_frames', type: 'number' as const },
      { name: 'jank_rate_pct', type: 'number' as const },
      { name: 'window_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'window_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'fps', type: 'number' as const },
      { name: 'jank_types', type: 'string' as const, format: 'code' as const },
      { name: 'scope_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'scope_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'trace_jank_presence') {
    return [
      { name: 'scope', type: 'string' as const, format: 'code' as const },
      { name: 'total_frames', type: 'number' as const },
      { name: 'jank_frames', type: 'number' as const },
      { name: 'jank_rate_pct', type: 'number' as const },
      { name: 'window_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'window_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'duration_s', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'jank_types', type: 'string' as const, format: 'code' as const },
      { name: 'scope_start_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'scope_end_ns', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'thread_count') {
    return [
      { name: 'thread_count', type: 'number' as const },
      { name: 'process_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'app_thread_count' || kind === 'app_process_count') {
    return [
      { name: 'package_name', type: 'string' as const, format: 'code' as const },
      { name: 'process_count', type: 'number' as const },
      { name: 'thread_count', type: 'number' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'process_thread_counts', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'process_count') {
    return [
      { name: 'process_count', type: 'number' as const },
      { name: 'listed_process_count', type: 'number' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'process_thread_counts', type: 'string' as const, format: 'code' as const },
      { name: 'omitted_process_count', type: 'number' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'binder_transaction_count') {
    return [
      { name: 'binder_txn_count', type: 'number' as const },
      { name: 'sync_count', type: 'number' as const },
      { name: 'async_count', type: 'number' as const },
      { name: 'total_client_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'max_client_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'anr_presence') {
    return [
      { name: 'total_anr_count', type: 'number' as const },
      { name: 'affected_process_count', type: 'number' as const },
      { name: 'first_anr_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_anr_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'anr_span_seconds', type: 'duration' as const, unit: 's' as const, format: 'duration_ms' as const },
      { name: 'anr_types', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'startup_presence') {
    return [
      { name: 'startup_count', type: 'number' as const },
      { name: 'packages', type: 'string' as const, format: 'code' as const },
      { name: 'startup_types', type: 'string' as const, format: 'code' as const },
      { name: 'first_startup_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_startup_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'total_startup_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'max_startup_ms', type: 'duration' as const, unit: 'ms' as const, format: 'duration_ms' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'scroll_gesture_count') {
    return [
      { name: 'scroll_gesture_count', type: 'number' as const },
      { name: 'scroll_start_count', type: 'number' as const },
      { name: 'first_scroll_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_scroll_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'max_move_count', type: 'number' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
      { name: 'heuristic', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'input_event_count') {
    return [
      { name: 'input_event_count', type: 'number' as const },
      { name: 'motion_event_count', type: 'number' as const },
      { name: 'key_event_count', type: 'number' as const },
      { name: 'process_count', type: 'number' as const },
      { name: 'first_input_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'last_input_ts', type: 'timestamp' as const, unit: 'ns' as const, format: 'timestamp_relative' as const },
      { name: 'process_names', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  if (kind === 'device_info') {
    return [
      { name: 'android_device_manufacturer', type: 'string' as const, format: 'code' as const },
      { name: 'android_build_fingerprint', type: 'string' as const, format: 'code' as const },
      { name: 'android_sdk_version', type: 'number' as const },
      { name: 'android_soc_model', type: 'string' as const, format: 'code' as const },
      { name: 'system_name', type: 'string' as const, format: 'code' as const },
      { name: 'system_release', type: 'string' as const, format: 'code' as const },
      { name: 'system_machine', type: 'string' as const, format: 'code' as const },
      { name: 'source_table', type: 'string' as const, format: 'code' as const },
    ];
  }
  return [
    { name: 'observed_cpu_count', type: 'number' as const },
    { name: 'observed_cpus', type: 'string' as const, format: 'code' as const },
    { name: 'universe_source', type: 'string' as const, format: 'code' as const },
    { name: 'cpu_table_count', type: 'number' as const },
    { name: 'cpu_table_cpus', type: 'string' as const, format: 'code' as const },
    { name: 'source_table', type: 'string' as const, format: 'code' as const },
  ];
}

function buildFrameMetricsSql(
  packageName: string,
  timeRange?: FocusAppTimeRange,
): string {
  return `
    -- SmartPerfetto runtime_frame_metrics
    INCLUDE PERFETTO MODULE android.frames.timeline;
    INCLUDE PERFETTO MODULE android.process_metadata;

    WITH frame_packages AS (
      SELECT
        COALESCE(
          NULLIF(m.package_name, ''),
          CASE
            WHEN a.layer_name LIKE 'TX - %/%'
              THEN SUBSTR(a.layer_name, 6, INSTR(SUBSTR(a.layer_name, 6), '/') - 1)
            WHEN a.layer_name LIKE 'TX - %'
              THEN SUBSTR(a.layer_name, 6)
            ELSE NULL
          END,
          NULLIF(m.process_name, ''),
          NULLIF(p.cmdline, ''),
          p.name
        ) AS package_name,
        COALESCE(NULLIF(m.process_name, ''), NULLIF(p.name, '')) AS process_name,
        p.upid,
        COALESCE(
          NULLIF(a.name, ''),
          CAST(a.surface_frame_token AS TEXT),
          CAST(a.display_frame_token AS TEXT),
          CAST(a.id AS TEXT)
        ) AS frame_id,
        a.ts,
        a.dur
      FROM actual_frame_timeline_slice a
      LEFT JOIN process p USING(upid)
      LEFT JOIN android_process_metadata m USING(upid)
      WHERE ${scopedFrameTimelineWhere({ timeRange, tsExpr: 'a.ts', durExpr: 'a.dur' })}
    ),
    per_frame AS (
      SELECT
        package_name,
        MAX(process_name) AS process_name,
        upid,
        frame_id,
        MIN(ts) AS start_ts,
        MAX(ts + dur) AS end_ts
      FROM frame_packages
      WHERE package_name = ${sqlStringLiteral(packageName)}
      GROUP BY package_name, upid, frame_id
    )
    SELECT
      package_name,
      GROUP_CONCAT(DISTINCT process_name) AS process_names,
      COUNT(DISTINCT upid) AS upid_count,
      COUNT(*) AS total_frames,
      CAST(MIN(start_ts) AS INTEGER) AS window_start_ns,
      CAST(MAX(end_ts) AS INTEGER) AS window_end_ns,
      ROUND((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 6) AS duration_s,
      ROUND(CAST(COUNT(*) AS REAL) / NULLIF((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 0), 2) AS fps,
      ${timeRange ? `CAST(${timeRange.startNs} AS INTEGER) AS scope_start_ns,
      CAST(${timeRange.endNs} AS INTEGER) AS scope_end_ns,` : ''}
      'actual_frame_timeline_slice' AS source_table
    FROM per_frame
    GROUP BY package_name
    HAVING total_frames > 0
      AND duration_s > 0
    LIMIT 1
  `;
}

function buildTraceDurationSql(): string {
  return `
    -- SmartPerfetto runtime_trace_duration
    SELECT
      CAST(start_ts AS INTEGER) AS trace_start_ns,
      CAST(end_ts AS INTEGER) AS trace_end_ns,
      ROUND(start_ts / 1000000000.0, 6) AS trace_start_s,
      ROUND(end_ts / 1000000000.0, 6) AS trace_end_s,
      ROUND((end_ts - start_ts) / 1000000000.0, 6) AS duration_s,
      'trace_bounds' AS source_table
    FROM trace_bounds
    WHERE end_ts > start_ts
    LIMIT 1
  `;
}

function buildTraceHealthIssueSql(): string {
  return `
    -- SmartPerfetto runtime_trace_health_issues
    WITH issue_stats AS (
      SELECT
        name,
        severity,
        source,
        CAST(value AS INTEGER) AS value
      FROM stats
      WHERE value > 0
        AND severity IN ('error', 'data_loss')
    ),
    ranked_issues AS (
      SELECT name, severity, value
      FROM issue_stats
      ORDER BY
        CASE severity WHEN 'error' THEN 0 WHEN 'data_loss' THEN 1 ELSE 2 END,
        value DESC,
        name
      LIMIT 8
    ),
    summary AS (
      SELECT
        COUNT(*) AS issue_stat_count,
        COALESCE(SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END), 0) AS error_stat_count,
        COALESCE(SUM(CASE WHEN severity = 'data_loss' THEN 1 ELSE 0 END), 0) AS data_loss_stat_count,
        COALESCE(SUM(value), 0) AS total_issue_value
      FROM issue_stats
    )
    SELECT
      issue_stat_count,
      error_stat_count,
      data_loss_stat_count,
      total_issue_value,
      COALESCE((SELECT GROUP_CONCAT(name, ',') FROM ranked_issues), '') AS issue_names,
      COALESCE((SELECT GROUP_CONCAT(value, ',') FROM ranked_issues), '') AS issue_values,
      COALESCE((SELECT GROUP_CONCAT(severity, ',') FROM ranked_issues), '') AS issue_severities,
      'stats' AS source_table
    FROM summary
  `;
}

function buildTraceDataInventorySql(): string {
  return `
    -- SmartPerfetto runtime_trace_data_inventory
    INCLUDE PERFETTO MODULE android.frames.timeline;
    INCLUDE PERFETTO MODULE android.network_packets;

    SELECT
      CAST((SELECT start_ts FROM trace_bounds) AS INTEGER) AS trace_start_ns,
      CAST((SELECT end_ts FROM trace_bounds) AS INTEGER) AS trace_end_ns,
      ROUND((SELECT end_ts - start_ts FROM trace_bounds) / 1000000000.0, 6) AS duration_s,
      (SELECT COUNT(*) FROM slice) AS slice_count,
      (SELECT COUNT(*) FROM track) AS track_count,
      (SELECT COUNT(*) FROM process_track) AS process_track_count,
      (SELECT COUNT(*) FROM thread_track) AS thread_track_count,
      (SELECT COUNT(*) FROM process) AS process_count,
      (SELECT COUNT(*) FROM thread) AS thread_count,
      (SELECT COUNT(*) FROM sched_slice) AS sched_slice_count,
      (SELECT COUNT(*) FROM thread_state) AS thread_state_count,
      (SELECT COUNT(*) FROM counter_track) AS counter_track_count,
      (SELECT COUNT(*) FROM process_counter_track) AS process_counter_track_count,
      (SELECT COUNT(*) FROM cpu_counter_track) AS cpu_counter_track_count,
      (SELECT COUNT(*) FROM gpu_counter_track) AS gpu_counter_track_count,
      (SELECT COUNT(*) FROM counter) AS counter_sample_count,
      (
        SELECT COUNT(*)
        FROM counter c
        JOIN cpu_counter_track t ON c.track_id = t.id
        WHERE t.name = 'cpufreq'
      ) AS cpufreq_sample_count,
      (SELECT COUNT(*) FROM actual_frame_timeline_slice) AS actual_frame_timeline_slice_count,
      (SELECT COUNT(*) FROM expected_frame_timeline_slice) AS expected_frame_timeline_slice_count,
      (SELECT COUNT(*) FROM gpu_slice) AS gpu_slice_count,
      (
        SELECT COUNT(*)
        FROM counter c
        JOIN gpu_counter_track t ON c.track_id = t.id
      ) AS gpu_counter_sample_count,
      (SELECT COUNT(*) FROM android_network_packets) AS network_packet_event_count,
      (SELECT COUNT(*) FROM android_logs) AS android_log_count,
      'trace_bounds,slice,track,process,thread,sched_slice,thread_state,counter_track,process_counter_track,cpu_counter_track,gpu_counter_track,counter,actual_frame_timeline_slice,expected_frame_timeline_slice,gpu_slice,android_network_packets,android_logs' AS source_table
  `;
}

function buildCpuFrequencyPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_cpu_frequency_presence
    WITH cpufreq_samples AS (
      SELECT
        t.cpu,
        c.ts,
        c.value AS freq_khz
      FROM cpu_counter_track t
      JOIN counter c ON c.track_id = t.id
      WHERE t.name = 'cpufreq'
        AND t.cpu IS NOT NULL
        AND c.value IS NOT NULL
        AND c.value > 0
    ),
    per_cpu AS (
      SELECT
        cpu,
        COUNT(*) AS sample_count,
        MIN(freq_khz) AS min_freq_khz,
        MAX(freq_khz) AS max_freq_khz,
        MIN(ts) AS first_sample_ts,
        MAX(ts) AS last_sample_ts
      FROM cpufreq_samples
      GROUP BY cpu
    ),
    ordered_cpus AS (
      SELECT cpu
      FROM per_cpu
      ORDER BY cpu
    )
    SELECT
      COUNT(*) AS cpufreq_cpu_count,
      COALESCE(SUM(sample_count), 0) AS cpufreq_sample_count,
      COALESCE((SELECT GROUP_CONCAT(cpu, ', ') FROM ordered_cpus), '') AS cpufreq_cpus,
      COALESCE(MIN(min_freq_khz), 0) AS min_freq_khz,
      COALESCE(MAX(max_freq_khz), 0) AS max_freq_khz,
      CAST(MIN(first_sample_ts) AS INTEGER) AS first_sample_ts,
      CAST(MAX(last_sample_ts) AS INTEGER) AS last_sample_ts,
      'cpu_counter_track,counter' AS source_table
    FROM per_cpu
  `;
}

function buildPowerCounterPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_power_counter_presence
    WITH candidate_tracks AS (
      SELECT
        t.id AS track_id,
        t.name AS counter_name
      FROM counter_track t
      WHERE t.name IS NOT NULL
        AND (
          lower(t.name) GLOB '*power*'
          OR lower(t.name) GLOB '*energy*'
          OR lower(t.name) GLOB '*charge*'
          OR lower(t.name) GLOB '*watt*'
          OR lower(t.name) GLOB 'battery*'
          OR lower(t.name) GLOB 'battery_stats.*'
        )
    ),
    per_track AS (
      SELECT
        t.track_id,
        t.counter_name,
        COUNT(c.ts) AS sample_count
      FROM candidate_tracks t
      JOIN counter c ON c.track_id = t.track_id
      WHERE c.value IS NOT NULL
      GROUP BY t.track_id, t.counter_name
    ),
    ranked AS (
      SELECT counter_name, sample_count
      FROM per_track
      ORDER BY sample_count DESC, counter_name
      LIMIT 8
    ),
    summary AS (
      SELECT
        COUNT(*) AS power_counter_track_count,
        COALESCE(SUM(sample_count), 0) AS power_counter_sample_count
      FROM per_track
    )
    SELECT
      power_counter_track_count,
      power_counter_sample_count,
      COALESCE((SELECT GROUP_CONCAT(counter_name, ',') FROM ranked), '') AS power_counter_names,
      COALESCE((SELECT GROUP_CONCAT(sample_count, ',') FROM ranked), '') AS power_counter_sample_counts,
      'counter_track,counter' AS source_table
    FROM summary
  `;
}

function buildMemoryCounterPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_memory_counter_presence
    WITH candidate_tracks AS (
      SELECT
        t.id AS track_id,
        t.name AS counter_name
      FROM process_counter_track t
      WHERE t.name IS NOT NULL
        AND (
          lower(t.name) GLOB '*memory*'
          OR lower(t.name) GLOB '*rss*'
          OR lower(t.name) GLOB '*swap*'
          OR lower(t.name) GLOB 'oom*'
          OR lower(t.name) GLOB '*oom_score*'
        )
    ),
    per_track AS (
      SELECT
        t.track_id,
        t.counter_name,
        COUNT(c.ts) AS sample_count,
        COALESCE(MAX(c.value), 0) AS max_value
      FROM candidate_tracks t
      JOIN counter c ON c.track_id = t.track_id
      WHERE c.value IS NOT NULL
      GROUP BY t.track_id, t.counter_name
    ),
    ranked AS (
      SELECT counter_name, sample_count, max_value
      FROM per_track
      ORDER BY sample_count DESC, counter_name
      LIMIT 8
    ),
    summary AS (
      SELECT
        COUNT(*) AS memory_counter_track_count,
        COALESCE(SUM(sample_count), 0) AS memory_counter_sample_count
      FROM per_track
    )
    SELECT
      memory_counter_track_count,
      memory_counter_sample_count,
      COALESCE((SELECT GROUP_CONCAT(counter_name, ',') FROM ranked), '') AS memory_counter_names,
      COALESCE((SELECT GROUP_CONCAT(sample_count, ',') FROM ranked), '') AS memory_counter_sample_counts,
      COALESCE((SELECT GROUP_CONCAT(max_value, ',') FROM ranked), '') AS memory_counter_max_values,
      'process_counter_track,counter' AS source_table
    FROM summary
  `;
}

function buildSchedulerDataPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_scheduler_data_presence
    SELECT
      (SELECT COUNT(*) FROM sched_slice) AS sched_slice_count,
      (SELECT COUNT(*) FROM thread_state) AS thread_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state = 'Running') AS running_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state IN ('R', 'R+')) AS runnable_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state = 'R+') AS preempted_runnable_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state = 'S') AS sleeping_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state IN ('D', 'DK')) AS uninterruptible_sleep_state_count,
      (SELECT COUNT(*) FROM thread_state WHERE state = 'I') AS idle_state_count,
      'sched_slice,thread_state' AS source_table
  `;
}

function buildGpuDataPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_gpu_data_presence
    SELECT
      (SELECT COUNT(*) FROM gpu_slice) AS gpu_slice_count,
      (SELECT COUNT(*) FROM gpu_counter_track) AS gpu_counter_track_count,
      (
        SELECT COUNT(*)
        FROM counter c
        JOIN gpu_counter_track t ON c.track_id = t.id
      ) AS gpu_counter_sample_count,
      COALESCE((
        SELECT GROUP_CONCAT(name, ',')
        FROM (
          SELECT DISTINCT name
          FROM gpu_counter_track
          WHERE name IS NOT NULL
            AND name != ''
          ORDER BY name
          LIMIT 5
        )
      ), '') AS gpu_counter_names,
      COALESCE((
        SELECT GROUP_CONCAT(name, ',')
        FROM (
          SELECT DISTINCT name
          FROM gpu_slice
          WHERE name IS NOT NULL
            AND name != ''
          ORDER BY name
          LIMIT 5
        )
      ), '') AS gpu_slice_names,
      'gpu_slice,gpu_counter_track,counter' AS source_table
  `;
}

function buildSliceDataPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_slice_data_presence
    SELECT
      (SELECT COUNT(*) FROM slice) AS slice_count,
      (SELECT COUNT(*) FROM track) AS track_count,
      (SELECT COUNT(*) FROM process_track) AS process_track_count,
      (SELECT COUNT(*) FROM thread_track) AS thread_track_count,
      'slice,track,process_track,thread_track' AS source_table
  `;
}

function buildNetworkPacketPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_network_packet_presence
    INCLUDE PERFETTO MODULE android.network_packets;

    WITH packets AS (
      SELECT
        COALESCE(packet_count, 0) AS packet_count,
        COALESCE(packet_length, 0) AS packet_length,
        COALESCE(iface, '') AS iface,
        COALESCE(packet_transport, '') AS packet_transport
      FROM android_network_packets
    ),
    summary AS (
      SELECT
        COUNT(*) AS network_packet_event_count,
        COALESCE(SUM(packet_count), 0) AS network_packet_count,
        COALESCE(SUM(packet_length), 0) AS network_packet_bytes,
        COUNT(DISTINCT NULLIF(iface, '')) AS network_iface_count,
        COUNT(DISTINCT NULLIF(packet_transport, '')) AS network_transport_count
      FROM packets
    ),
    ranked_ifaces AS (
      SELECT iface, SUM(packet_count) AS packet_count
      FROM packets
      WHERE iface != ''
      GROUP BY iface
      ORDER BY packet_count DESC, iface
      LIMIT 5
    ),
    ranked_transports AS (
      SELECT packet_transport, SUM(packet_count) AS packet_count
      FROM packets
      WHERE packet_transport != ''
      GROUP BY packet_transport
      ORDER BY packet_count DESC, packet_transport
      LIMIT 5
    )
    SELECT
      network_packet_event_count,
      network_packet_count,
      network_packet_bytes,
      network_iface_count,
      network_transport_count,
      COALESCE((SELECT GROUP_CONCAT(iface, ',') FROM ranked_ifaces), '') AS network_ifaces,
      COALESCE((SELECT GROUP_CONCAT(packet_count, ',') FROM ranked_ifaces), '') AS network_iface_packet_counts,
      COALESCE((SELECT GROUP_CONCAT(packet_transport, ',') FROM ranked_transports), '') AS network_transports,
      COALESCE((SELECT GROUP_CONCAT(packet_count, ',') FROM ranked_transports), '') AS network_transport_packet_counts,
      'android_network_packets' AS source_table
    FROM summary
  `;
}

function buildLogcatPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_logcat_presence
    WITH log_rows AS (
      SELECT
        ts,
        COALESCE(prio, 0) AS prio,
        COALESCE(NULLIF(tag, ''), '<empty>') AS tag
      FROM android_logs
    ),
    summary AS (
      SELECT
        COUNT(*) AS logcat_event_count,
        COALESCE(SUM(CASE WHEN prio >= 5 THEN 1 ELSE 0 END), 0) AS warn_log_count,
        COALESCE(SUM(CASE WHEN prio >= 6 THEN 1 ELSE 0 END), 0) AS error_log_count,
        COALESCE(SUM(CASE WHEN prio >= 7 THEN 1 ELSE 0 END), 0) AS fatal_log_count,
        COUNT(DISTINCT tag) AS distinct_tag_count,
        CAST(MIN(ts) AS INTEGER) AS first_log_ts,
        CAST(MAX(ts) AS INTEGER) AS last_log_ts
      FROM log_rows
    ),
    ranked_tags AS (
      SELECT tag, COUNT(*) AS log_count
      FROM log_rows
      GROUP BY tag
      ORDER BY log_count DESC, tag
      LIMIT 8
    )
    SELECT
      logcat_event_count,
      warn_log_count,
      error_log_count,
      fatal_log_count,
      distinct_tag_count,
      COALESCE((SELECT GROUP_CONCAT(tag, ',') FROM ranked_tags), '') AS sample_tags,
      COALESCE((SELECT GROUP_CONCAT(log_count, ',') FROM ranked_tags), '') AS sample_tag_counts,
      first_log_ts,
      last_log_ts,
      'android_logs' AS source_table
    FROM summary
  `;
}

function buildJankPresenceSql(
  packageName: string,
  timeRange?: FocusAppTimeRange,
): string {
  return `
    -- SmartPerfetto runtime_jank_presence
    INCLUDE PERFETTO MODULE android.frames.timeline;
    INCLUDE PERFETTO MODULE android.process_metadata;

    WITH frame_packages AS (
      SELECT
        COALESCE(
          NULLIF(m.package_name, ''),
          CASE
            WHEN a.layer_name LIKE 'TX - %/%'
              THEN SUBSTR(a.layer_name, 6, INSTR(SUBSTR(a.layer_name, 6), '/') - 1)
            WHEN a.layer_name LIKE 'TX - %'
              THEN SUBSTR(a.layer_name, 6)
            ELSE NULL
          END,
          NULLIF(m.process_name, ''),
          NULLIF(p.cmdline, ''),
          p.name
        ) AS package_name,
        COALESCE(NULLIF(m.process_name, ''), NULLIF(p.name, '')) AS process_name,
        p.upid,
        COALESCE(
          NULLIF(a.name, ''),
          CAST(a.surface_frame_token AS TEXT),
          CAST(a.display_frame_token AS TEXT),
          CAST(a.id AS TEXT)
        ) AS frame_id,
        a.ts,
        a.dur,
        a.jank_type
      FROM actual_frame_timeline_slice a
      LEFT JOIN process p USING(upid)
      LEFT JOIN android_process_metadata m USING(upid)
      WHERE ${scopedFrameTimelineWhere({ timeRange, tsExpr: 'a.ts', durExpr: 'a.dur' })}
    ),
    per_frame AS (
      SELECT
        package_name,
        GROUP_CONCAT(DISTINCT process_name) AS process_names,
        upid,
        frame_id,
        MIN(ts) AS start_ts,
        MAX(ts + dur) AS end_ts,
        GROUP_CONCAT(DISTINCT CASE
          WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN jank_type
        END) AS jank_types,
        MAX(CASE
          WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1
          ELSE 0
        END) AS is_jank
      FROM frame_packages
      WHERE package_name = ${sqlStringLiteral(packageName)}
      GROUP BY package_name, upid, frame_id
    )
    SELECT
      package_name,
      GROUP_CONCAT(DISTINCT process_names) AS process_names,
      COUNT(*) AS total_frames,
      COALESCE(SUM(is_jank), 0) AS jank_frames,
      ROUND(100.0 * COALESCE(SUM(is_jank), 0) / NULLIF(COUNT(*), 0), 2) AS jank_rate_pct,
      CAST(MIN(start_ts) AS INTEGER) AS window_start_ns,
      CAST(MAX(end_ts) AS INTEGER) AS window_end_ns,
      ROUND((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 6) AS duration_s,
      ROUND(CAST(COUNT(*) AS REAL) / NULLIF((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 0), 2) AS fps,
      COALESCE(GROUP_CONCAT(DISTINCT jank_types), '') AS jank_types,
      ${timeRange ? `CAST(${timeRange.startNs} AS INTEGER) AS scope_start_ns,
      CAST(${timeRange.endNs} AS INTEGER) AS scope_end_ns,` : ''}
      'actual_frame_timeline_slice' AS source_table
    FROM per_frame
    GROUP BY package_name
    HAVING total_frames > 0
    LIMIT 1
  `;
}

function buildTraceWideJankPresenceSql(timeRange?: FocusAppTimeRange): string {
  return `
    -- SmartPerfetto runtime_trace_jank_presence
    INCLUDE PERFETTO MODULE android.frames.timeline;

    WITH per_frame AS (
      SELECT
        COALESCE(
          NULLIF(name, ''),
          CAST(surface_frame_token AS TEXT),
          CAST(display_frame_token AS TEXT),
          CAST(id AS TEXT)
        ) AS frame_id,
        MIN(ts) AS start_ts,
        MAX(ts + dur) AS end_ts,
        GROUP_CONCAT(DISTINCT CASE
          WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN jank_type
        END) AS jank_types,
        MAX(CASE
          WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1
          ELSE 0
        END) AS is_jank
      FROM actual_frame_timeline_slice
      WHERE ${scopedFrameTimelineWhere({ timeRange, tsExpr: 'ts', durExpr: 'dur' })}
      GROUP BY upid, frame_id
    )
    SELECT
      ${timeRange ? "'selected_range'" : "'trace'"} AS scope,
      COUNT(*) AS total_frames,
      COALESCE(SUM(is_jank), 0) AS jank_frames,
      ROUND(100.0 * COALESCE(SUM(is_jank), 0) / NULLIF(COUNT(*), 0), 2) AS jank_rate_pct,
      CAST(MIN(start_ts) AS INTEGER) AS window_start_ns,
      CAST(MAX(end_ts) AS INTEGER) AS window_end_ns,
      ROUND((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 6) AS duration_s,
      COALESCE(GROUP_CONCAT(DISTINCT jank_types), '') AS jank_types,
      ${timeRange ? `CAST(${timeRange.startNs} AS INTEGER) AS scope_start_ns,
      CAST(${timeRange.endNs} AS INTEGER) AS scope_end_ns,` : ''}
      'actual_frame_timeline_slice' AS source_table
    FROM per_frame
    HAVING total_frames > 0
  `;
}

function buildTraceWideFrameCountSql(timeRange?: FocusAppTimeRange): string {
  return `
    -- SmartPerfetto runtime_trace_frame_count
    INCLUDE PERFETTO MODULE android.frames.timeline;

    WITH per_frame AS (
      SELECT
        COALESCE(
          NULLIF(name, ''),
          CAST(surface_frame_token AS TEXT),
          CAST(display_frame_token AS TEXT),
          CAST(id AS TEXT)
        ) AS frame_id,
        MIN(ts) AS start_ts,
        MAX(ts + dur) AS end_ts
      FROM actual_frame_timeline_slice
      WHERE ${scopedFrameTimelineWhere({ timeRange, tsExpr: 'ts', durExpr: 'dur' })}
      GROUP BY upid, frame_id
    )
    SELECT
      ${timeRange ? "'selected_range'" : "'trace'"} AS scope,
      COUNT(*) AS total_frames,
      CAST(MIN(start_ts) AS INTEGER) AS window_start_ns,
      CAST(MAX(end_ts) AS INTEGER) AS window_end_ns,
      ROUND((MAX(end_ts) - MIN(start_ts)) / 1000000000.0, 6) AS duration_s,
      ${timeRange ? `CAST(${timeRange.startNs} AS INTEGER) AS scope_start_ns,
      CAST(${timeRange.endNs} AS INTEGER) AS scope_end_ns,` : ''}
      'actual_frame_timeline_slice' AS source_table
    FROM per_frame
    HAVING total_frames > 0
  `;
}

function buildFrameTimelinePresenceSql(): string {
  return `
    -- SmartPerfetto runtime_frame_timeline_presence
    INCLUDE PERFETTO MODULE android.frames.timeline;

    SELECT
      (SELECT COUNT(*) FROM actual_frame_timeline_slice) AS actual_frame_timeline_slice_count,
      (SELECT COUNT(*) FROM expected_frame_timeline_slice) AS expected_frame_timeline_slice_count,
      (
        SELECT COUNT(*)
        FROM actual_frame_timeline_slice
        WHERE jank_type IS NOT NULL
          AND jank_type != 'None'
      ) AS janky_actual_frame_count,
      (
        SELECT COUNT(DISTINCT upid)
        FROM actual_frame_timeline_slice
        WHERE upid IS NOT NULL
      ) AS actual_frame_upid_count,
      'actual_frame_timeline_slice,expected_frame_timeline_slice' AS source_table
  `;
}

function buildRefreshRateSql(): string {
  return `
    -- SmartPerfetto runtime_refresh_rate
    INCLUDE PERFETTO MODULE android.frames.timeline;

    WITH vsync_sf_raw AS (
      SELECT
        c.ts,
        c.ts - LAG(c.ts) OVER (ORDER BY c.ts) AS interval_ns
      FROM counter c
      JOIN counter_track t ON c.track_id = t.id
      WHERE t.name = 'VSYNC-sf'
    ),
    vsync_sf_stats AS (
      SELECT
        CAST(PERCENTILE(interval_ns, 50) AS INTEGER) AS raw_median_period_ns,
        COUNT(*) AS sample_count
      FROM vsync_sf_raw
      WHERE interval_ns IS NOT NULL
        AND interval_ns > 5500000
        AND interval_ns < 50000000
    ),
    frame_timeline_stats AS (
      SELECT
        CAST(PERCENTILE(dur, 50) AS INTEGER) AS raw_median_period_ns,
        COUNT(*) AS sample_count
      FROM expected_frame_timeline_slice
      WHERE dur IS NOT NULL
        AND dur > 5000000
        AND dur < 50000000
    ),
    candidates AS (
      SELECT
        1 AS priority,
        raw_median_period_ns,
        sample_count,
        'vsync_sf' AS detection_method,
        'counter_track,counter' AS source_table
      FROM vsync_sf_stats
      WHERE sample_count >= 10
        AND raw_median_period_ns > 0
      UNION ALL
      SELECT
        2 AS priority,
        raw_median_period_ns,
        sample_count,
        'expected_frame_timeline_slice' AS detection_method,
        'expected_frame_timeline_slice' AS source_table
      FROM frame_timeline_stats
      WHERE sample_count >= 10
        AND raw_median_period_ns > 0
    ),
    chosen AS (
      SELECT *
      FROM candidates
      ORDER BY priority
      LIMIT 1
    ),
    snapped AS (
      SELECT
        CASE
          WHEN raw_median_period_ns BETWEEN 5500000 AND 6500000 THEN 6060606
          WHEN raw_median_period_ns BETWEEN 6500001 AND 7500000 THEN 6944444
          WHEN raw_median_period_ns BETWEEN 7500001 AND 9500000 THEN 8333333
          WHEN raw_median_period_ns BETWEEN 9500001 AND 12500000 THEN 11111111
          WHEN raw_median_period_ns BETWEEN 12500001 AND 20000000 THEN 16666667
          WHEN raw_median_period_ns BETWEEN 20000001 AND 35000000 THEN 33333333
          ELSE raw_median_period_ns
        END AS vsync_period_ns,
        raw_median_period_ns,
        sample_count,
        detection_method,
        source_table
      FROM chosen
    )
    SELECT
      ROUND(1000000000.0 / vsync_period_ns, 1) AS refresh_rate_hz,
      vsync_period_ns,
      ROUND(vsync_period_ns / 1000000.0, 3) AS vsync_period_ms,
      detection_method,
      sample_count,
      raw_median_period_ns,
      source_table
    FROM snapped
    WHERE vsync_period_ns > 0
  `;
}

function buildCpuTableCoreCountSql(): string {
  return `
    -- SmartPerfetto runtime_cpu_core_count_cpu_table
    WITH cpu_table_cpus AS (
      SELECT id AS cpu_id
      FROM cpu
      WHERE id IS NOT NULL
    ),
    ordered_cpu_table_cpus AS (
      SELECT cpu_id
      FROM cpu_table_cpus
      ORDER BY cpu_id
    )
    SELECT
      COUNT(DISTINCT cpu_id) AS observed_cpu_count,
      (SELECT GROUP_CONCAT(cpu_id, ', ') FROM ordered_cpu_table_cpus) AS observed_cpus,
      'cpu_table' AS universe_source,
      COUNT(DISTINCT cpu_id) AS cpu_table_count,
      (SELECT GROUP_CONCAT(cpu_id, ', ') FROM ordered_cpu_table_cpus) AS cpu_table_cpus,
      'cpu' AS source_table
    FROM cpu_table_cpus
    HAVING COUNT(DISTINCT cpu_id) > 0
    LIMIT 1
  `;
}

function buildObservedCpuCoreCountFallbackSql(): string {
  return `
    -- SmartPerfetto runtime_cpu_core_count_observed_fallback
    WITH observed_sched_cpus AS (
      SELECT cpu AS cpu_id
      FROM sched_slice
      WHERE cpu IS NOT NULL
      UNION
      SELECT cpu AS cpu_id
      FROM thread_state
      WHERE cpu IS NOT NULL
        AND state = 'Running'
    ),
    observed_counter_cpus AS (
      SELECT t.cpu AS cpu_id
      FROM cpu_counter_track t
      JOIN counter c ON c.track_id = t.id
      WHERE t.name = 'cpufreq'
        AND t.cpu IS NOT NULL
        AND c.value > 0
      GROUP BY t.cpu
    ),
    cpu_table_cpus AS (
      SELECT id AS cpu_id
      FROM cpu
      WHERE id IS NOT NULL
    ),
    observed_cpu_universe AS (
      SELECT cpu_id, 'sched_observed' AS universe_source
      FROM observed_sched_cpus
      UNION
      SELECT cpu_id, 'cpufreq_observed_fallback' AS universe_source
      FROM observed_counter_cpus
      WHERE NOT EXISTS (SELECT 1 FROM observed_sched_cpus)
    ),
    cpu_universe AS (
      SELECT cpu_id, universe_source
      FROM observed_cpu_universe
      UNION
      SELECT cpu_id, 'cpu_table_fallback_no_observed' AS universe_source
      FROM cpu_table_cpus
      WHERE NOT EXISTS (SELECT 1 FROM observed_cpu_universe)
    ),
    ordered_cpu_universe AS (
      SELECT cpu_id, universe_source
      FROM cpu_universe
      ORDER BY cpu_id
    )
    SELECT
      COUNT(DISTINCT cpu_id) AS observed_cpu_count,
      GROUP_CONCAT(cpu_id, ', ') AS observed_cpus,
      GROUP_CONCAT(DISTINCT universe_source) AS universe_source,
      (SELECT COUNT(*) FROM cpu_table_cpus) AS cpu_table_count,
      (SELECT GROUP_CONCAT(cpu_id, ', ') FROM (SELECT cpu_id FROM cpu_table_cpus ORDER BY cpu_id)) AS cpu_table_cpus,
      CASE
        WHEN EXISTS (SELECT 1 FROM observed_sched_cpus) THEN 'sched_slice/thread_state'
        WHEN EXISTS (SELECT 1 FROM observed_counter_cpus) THEN 'cpu_counter_track/counter'
        ELSE 'cpu'
      END AS source_table
    FROM ordered_cpu_universe
    HAVING COUNT(DISTINCT cpu_id) > 0
    LIMIT 1
  `;
}

function hasCpuCoreCountRows(result: QueryResult | undefined): result is QueryResult {
  if (!result?.rows.length) return false;
  const countIndex = result.columns.indexOf('observed_cpu_count');
  if (countIndex < 0) return false;
  const count = Number(result.rows[0]?.[countIndex]);
  return Number.isFinite(count) && count > 0;
}

async function queryCpuCoreCountEvidence(input: {
  traceProcessor: Pick<TraceProcessorService, 'query'>;
  traceId: string;
}): Promise<QueryResult> {
  const cpuTableResult = await input.traceProcessor.query(
    input.traceId,
    buildCpuTableCoreCountSql(),
  ).catch(() => undefined);
  if (hasCpuCoreCountRows(cpuTableResult)) return cpuTableResult;

  return input.traceProcessor.query(
    input.traceId,
    buildObservedCpuCoreCountFallbackSql(),
  );
}

function buildThreadCountSql(): string {
  return `
    -- SmartPerfetto runtime_thread_count
    SELECT
      COUNT(DISTINCT utid) AS thread_count,
      COUNT(DISTINCT upid) AS process_count,
      'thread' AS source_table
    FROM thread
    WHERE utid IS NOT NULL
    HAVING COUNT(DISTINCT utid) > 0
    LIMIT 1
  `;
}

function buildAppProcessThreadCountSql(packageName: string): string {
  const packageLiteral = sqlStringLiteral(packageName);
  return `
    -- SmartPerfetto runtime_app_process_thread_count
    INCLUDE PERFETTO MODULE android.process_metadata;

    WITH package_processes AS (
      SELECT
        ${packageLiteral} AS package_name,
        COALESCE(
          NULLIF(m.process_name, ''),
          NULLIF(p.name, ''),
          NULLIF(p.cmdline, ''),
          printf('upid:%d', p.upid)
        ) AS process_name,
        p.upid
      FROM process p
      LEFT JOIN android_process_metadata m USING(upid)
      WHERE p.upid IS NOT NULL
        AND (
          COALESCE(NULLIF(m.package_name, ''), NULLIF(p.cmdline, ''), NULLIF(p.name, '')) = ${packageLiteral}
          OR COALESCE(NULLIF(m.process_name, ''), NULLIF(p.name, ''), NULLIF(p.cmdline, '')) = ${packageLiteral}
          OR COALESCE(NULLIF(m.process_name, ''), NULLIF(p.name, ''), NULLIF(p.cmdline, '')) LIKE ${packageLiteral} || ':%'
        )
    ),
    per_process AS (
      SELECT
        package_name,
        process_name,
        upid,
        COUNT(DISTINCT t.utid) AS thread_count
      FROM package_processes
      LEFT JOIN thread t USING(upid)
      GROUP BY package_name, process_name, upid
    ),
    ranked_processes AS (
      SELECT process_name, thread_count
      FROM per_process
      ORDER BY thread_count DESC, process_name
      LIMIT 12
    )
    SELECT
      ${packageLiteral} AS package_name,
      COUNT(DISTINCT upid) AS process_count,
      COALESCE(SUM(thread_count), 0) AS thread_count,
      COALESCE((SELECT GROUP_CONCAT(process_name, ',') FROM ranked_processes), '') AS process_names,
      COALESCE((SELECT GROUP_CONCAT(thread_count, ',') FROM ranked_processes), '') AS process_thread_counts,
      'process,thread,android_process_metadata' AS source_table
    FROM per_process
    HAVING process_count > 0
  `;
}

function buildProcessCountSql(): string {
  return `
    -- SmartPerfetto runtime_process_count
    WITH process_thread_counts AS (
      SELECT
        p.upid,
        COALESCE(NULLIF(p.name, ''), printf('upid:%d', p.upid)) AS process_name,
        COUNT(DISTINCT t.utid) AS thread_count
      FROM process p
      LEFT JOIN thread t USING (upid)
      WHERE p.upid IS NOT NULL
      GROUP BY p.upid, process_name
    ),
    ranked_processes AS (
      SELECT process_name, thread_count
      FROM process_thread_counts
      ORDER BY thread_count DESC, process_name
      LIMIT 12
    ),
    summary AS (
      SELECT COUNT(*) AS process_count
      FROM process_thread_counts
    )
    SELECT
      summary.process_count AS process_count,
      (SELECT COUNT(*) FROM ranked_processes) AS listed_process_count,
      COALESCE((SELECT GROUP_CONCAT(process_name, ',') FROM ranked_processes), '') AS process_names,
      COALESCE((SELECT GROUP_CONCAT(thread_count, ',') FROM ranked_processes), '') AS process_thread_counts,
      CASE
        WHEN summary.process_count > (SELECT COUNT(*) FROM ranked_processes)
          THEN summary.process_count - (SELECT COUNT(*) FROM ranked_processes)
        ELSE 0
      END AS omitted_process_count,
      'process,thread' AS source_table
    FROM summary
    WHERE summary.process_count > 0
  `;
}

function buildBinderTransactionCountSql(): string {
  return `
    -- SmartPerfetto runtime_binder_transaction_count
    INCLUDE PERFETTO MODULE android.binder;

    SELECT
      COUNT(*) AS binder_txn_count,
      COALESCE(SUM(CASE WHEN is_sync THEN 1 ELSE 0 END), 0) AS sync_count,
      COALESCE(SUM(CASE WHEN NOT is_sync THEN 1 ELSE 0 END), 0) AS async_count,
      ROUND(COALESCE(SUM(client_dur), 0) / 1000000.0, 2) AS total_client_ms,
      ROUND(COALESCE(MAX(client_dur), 0) / 1000000.0, 2) AS max_client_ms,
      'android_binder_txns' AS source_table
    FROM android_binder_txns
  `;
}

function buildAnrPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_anr_presence
    INCLUDE PERFETTO MODULE android.anrs;

    SELECT
      COUNT(*) AS total_anr_count,
      COUNT(DISTINCT process_name) AS affected_process_count,
      CAST(MIN(ts) AS INTEGER) AS first_anr_ts,
      CAST(MAX(ts) AS INTEGER) AS last_anr_ts,
      ROUND((MAX(ts) - MIN(ts)) / 1000000000.0, 2) AS anr_span_seconds,
      COALESCE(GROUP_CONCAT(DISTINCT COALESCE(anr_type, 'unknown')), '') AS anr_types,
      'android_anrs' AS source_table
    FROM android_anrs
  `;
}

function buildStartupPresenceSql(): string {
  return `
    -- SmartPerfetto runtime_startup_presence
    INCLUDE PERFETTO MODULE android.startup.startups;

    SELECT
      COUNT(*) AS startup_count,
      COALESCE(GROUP_CONCAT(DISTINCT package), '') AS packages,
      COALESCE(GROUP_CONCAT(DISTINCT startup_type), '') AS startup_types,
      CAST(MIN(ts) AS INTEGER) AS first_startup_ts,
      CAST(MAX(ts) AS INTEGER) AS last_startup_ts,
      ROUND(COALESCE(SUM(dur), 0) / 1000000.0, 2) AS total_startup_ms,
      ROUND(COALESCE(MAX(dur), 0) / 1000000.0, 2) AS max_startup_ms,
      'android_startups' AS source_table
    FROM android_startups
    WHERE dur > 0
  `;
}

function buildScrollGestureCountSql(): string {
  return `
    -- SmartPerfetto runtime_scroll_gesture_count
    INCLUDE PERFETTO MODULE android.input;

    WITH motion_events AS (
      SELECT
        read_time AS ts,
        event_action,
        process_name,
        CASE WHEN event_action = 'DOWN' THEN 1 ELSE 0 END AS is_start
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND event_action IN ('DOWN', 'MOVE', 'UP')
        AND process_name NOT IN ('system_server', '/system/bin/inputflinger')
        AND process_name NOT GLOB 'com.android.systemui*'
    ),
    gesture_groups AS (
      SELECT
        ts,
        event_action,
        process_name,
        SUM(is_start) OVER (ORDER BY ts) AS gesture_id
      FROM motion_events
    ),
    gesture_stats AS (
      SELECT
        gesture_id,
        MIN(ts) AS first_gesture_ts,
        MAX(ts) AS last_gesture_ts,
        COUNT(*) AS event_count,
        SUM(CASE WHEN event_action = 'MOVE' THEN 1 ELSE 0 END) AS move_count,
        MAX(process_name) AS process_name
      FROM gesture_groups
      WHERE gesture_id > 0
      GROUP BY gesture_id
    ),
    scroll_gestures AS (
      SELECT *
      FROM gesture_stats
      WHERE event_count >= 2
        AND move_count >= 3
    ),
    motion_with_seq AS (
      SELECT
        event_action,
        ts,
        process_name,
        gesture_id,
        SUM(CASE WHEN event_action = 'MOVE' THEN 1 ELSE 0 END)
          OVER (
            PARTITION BY gesture_id
            ORDER BY ts
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS move_seq
      FROM gesture_groups
    ),
    scroll_starts AS (
      SELECT
        MIN(ts) AS scroll_start_ts,
        gesture_id
      FROM motion_with_seq
      WHERE event_action = 'MOVE'
        AND move_seq >= 2
        AND gesture_id > 0
      GROUP BY gesture_id
    )
    SELECT
      COUNT(*) AS scroll_gesture_count,
      (SELECT COUNT(*) FROM scroll_starts) AS scroll_start_count,
      CAST(MIN(first_gesture_ts) AS INTEGER) AS first_scroll_ts,
      CAST(MAX(last_gesture_ts) AS INTEGER) AS last_scroll_ts,
      COALESCE(MAX(move_count), 0) AS max_move_count,
      COALESCE(GROUP_CONCAT(DISTINCT process_name), '') AS process_names,
      'android_input_events' AS source_table,
      'scene_reconstruction.user_gestures(move_count>=3)' AS heuristic
    FROM scroll_gestures
  `;
}

function buildInputEventCountSql(): string {
  return `
    -- SmartPerfetto runtime_input_event_count
    INCLUDE PERFETTO MODULE android.input;

    SELECT
      COUNT(*) AS input_event_count,
      COALESCE(SUM(CASE WHEN event_type = 'MOTION' THEN 1 ELSE 0 END), 0) AS motion_event_count,
      COALESCE(SUM(CASE WHEN event_type = 'KEY' THEN 1 ELSE 0 END), 0) AS key_event_count,
      COUNT(DISTINCT process_name) AS process_count,
      CAST(MIN(read_time) AS INTEGER) AS first_input_ts,
      CAST(MAX(read_time) AS INTEGER) AS last_input_ts,
      COALESCE(GROUP_CONCAT(DISTINCT process_name), '') AS process_names,
      'android_input_events' AS source_table
    FROM android_input_events
  `;
}

function buildDeviceInfoSql(): string {
  return `
    -- SmartPerfetto runtime_device_info
    WITH device_metadata AS (
      SELECT
        MAX(CASE WHEN name = 'android_device_manufacturer' THEN str_value END) AS android_device_manufacturer,
        MAX(CASE WHEN name = 'android_build_fingerprint' THEN str_value END) AS android_build_fingerprint,
        MAX(CASE WHEN name = 'android_sdk_version' THEN int_value END) AS android_sdk_version,
        MAX(CASE WHEN name = 'android_soc_model' THEN str_value END) AS android_soc_model,
        MAX(CASE WHEN name = 'system_name' THEN str_value END) AS system_name,
        MAX(CASE WHEN name = 'system_release' THEN str_value END) AS system_release,
        MAX(CASE WHEN name = 'system_machine' THEN str_value END) AS system_machine
      FROM metadata
    )
    SELECT
      android_device_manufacturer,
      android_build_fingerprint,
      android_sdk_version,
      android_soc_model,
      system_name,
      system_release,
      system_machine,
      'metadata' AS source_table
    FROM device_metadata
    WHERE COALESCE(
      android_device_manufacturer,
      android_build_fingerprint,
      CAST(android_sdk_version AS TEXT),
      android_soc_model,
      system_name,
      system_release,
      system_machine
    ) IS NOT NULL
    LIMIT 1
  `;
}

async function queryTraceFactEvidence(input: {
  traceProcessor: Pick<TraceProcessorService, 'query'>;
  traceId: string;
  kind: QuickTraceFactEvidenceKind;
  packageName?: string;
  timeRange?: FocusAppTimeRange;
}) {
  if (input.kind === 'frame_metrics') {
    if (!input.packageName) return undefined;
    return input.traceProcessor.query(
      input.traceId,
      buildFrameMetricsSql(input.packageName, input.timeRange),
    );
  }
  if (input.kind === 'selection_duration') {
    return undefined;
  }

  if (input.kind === 'trace_frame_count') {
    return input.traceProcessor.query(input.traceId, buildTraceWideFrameCountSql(input.timeRange));
  }

  if (input.kind === 'jank_presence' || input.kind === 'jank_frame_count') {
    if (!input.packageName) return undefined;
    return input.traceProcessor.query(
      input.traceId,
      buildJankPresenceSql(input.packageName, input.timeRange),
    );
  }

  if (input.kind === 'trace_jank_presence') {
    return input.traceProcessor.query(input.traceId, buildTraceWideJankPresenceSql(input.timeRange));
  }

  if (input.kind === 'frame_timeline_presence') {
    return input.traceProcessor.query(input.traceId, buildFrameTimelinePresenceSql());
  }

  if (input.kind === 'refresh_rate') {
    return input.traceProcessor.query(input.traceId, buildRefreshRateSql());
  }

  if (input.kind === 'cpu_core_count') {
    return queryCpuCoreCountEvidence(input);
  }

  if (input.kind === 'cpu_frequency_presence') {
    return input.traceProcessor.query(input.traceId, buildCpuFrequencyPresenceSql());
  }

  if (input.kind === 'power_counter_presence') {
    return input.traceProcessor.query(input.traceId, buildPowerCounterPresenceSql());
  }

  if (input.kind === 'memory_counter_presence') {
    return input.traceProcessor.query(input.traceId, buildMemoryCounterPresenceSql());
  }

  if (input.kind === 'scheduler_data_presence') {
    return input.traceProcessor.query(input.traceId, buildSchedulerDataPresenceSql());
  }

  if (input.kind === 'gpu_data_presence') {
    return input.traceProcessor.query(input.traceId, buildGpuDataPresenceSql());
  }

  if (input.kind === 'slice_data_presence') {
    return input.traceProcessor.query(input.traceId, buildSliceDataPresenceSql());
  }

  if (input.kind === 'network_packet_presence') {
    return input.traceProcessor.query(input.traceId, buildNetworkPacketPresenceSql());
  }

  if (input.kind === 'logcat_presence') {
    return input.traceProcessor.query(input.traceId, buildLogcatPresenceSql());
  }

  if (input.kind === 'thread_count') {
    return input.traceProcessor.query(input.traceId, buildThreadCountSql());
  }

  if (input.kind === 'app_thread_count') {
    if (!input.packageName) return undefined;
    return input.traceProcessor.query(input.traceId, buildAppProcessThreadCountSql(input.packageName));
  }

  if (input.kind === 'process_count') {
    return input.traceProcessor.query(input.traceId, buildProcessCountSql());
  }

  if (input.kind === 'app_process_count') {
    if (!input.packageName) return undefined;
    return input.traceProcessor.query(input.traceId, buildAppProcessThreadCountSql(input.packageName));
  }

  if (input.kind === 'trace_health_issues') {
    return input.traceProcessor.query(input.traceId, buildTraceHealthIssueSql());
  }

  if (input.kind === 'trace_data_inventory') {
    return input.traceProcessor.query(input.traceId, buildTraceDataInventorySql());
  }

  if (input.kind === 'binder_transaction_count') {
    return input.traceProcessor.query(input.traceId, buildBinderTransactionCountSql());
  }

  if (input.kind === 'anr_presence') {
    return input.traceProcessor.query(input.traceId, buildAnrPresenceSql());
  }

  if (input.kind === 'startup_presence') {
    return input.traceProcessor.query(input.traceId, buildStartupPresenceSql());
  }

  if (input.kind === 'scroll_gesture_count') {
    return input.traceProcessor.query(input.traceId, buildScrollGestureCountSql());
  }

  if (input.kind === 'input_event_count') {
    return input.traceProcessor.query(input.traceId, buildInputEventCountSql());
  }

  if (input.kind === 'device_info') {
    return input.traceProcessor.query(input.traceId, buildDeviceInfoSql());
  }

  return input.traceProcessor.query(input.traceId, buildTraceDurationSql());
}

function createTraceFactEnvelope(input: {
  traceId: string;
  traceSide: DataEnvelopeTraceSide;
  kind: QuickTraceFactEvidenceKind;
  scoped?: boolean;
  queryHash: string;
  sourceToolCallId: string;
  columns: string[];
  rows: unknown[][];
  outputLanguage: OutputLanguage;
}): DataEnvelope {
  const title = displayTitleForEvidenceKind(input.kind, input.scoped, input.outputLanguage);
  const explicitColumns = explicitColumnDefinitionsForEvidenceKind(input.kind);

  return createDataEnvelope(
    {
      columns: input.columns,
      rows: input.rows,
    },
    {
      type: 'sql_result',
      source: `runtime_trace_fact:${input.kind}`,
      title,
      layer: 'list',
      format: 'table',
      columns: buildColumnDefinitions(input.columns, explicitColumns),
      evidenceRefId: `data:runtime_trace_fact:${input.kind}:${input.traceSide}:${input.queryHash}`,
      traceSide: input.traceSide,
      traceId: input.traceId,
      queryHash: input.queryHash,
      sourceToolCallId: input.sourceToolCallId,
      paramsHash: input.queryHash,
      intent: 'runtime_trace_fact_lookup',
      planPhaseId: 'quick',
      planPhaseTitle: localize(input.outputLanguage, '快速回答', 'Quick answer'),
      planPhaseGoal: localize(input.outputLanguage, '复用运行时 Trace 基础指标回答局部事实问题', 'Reuse runtime trace facts for focused factual questions'),
      planPhaseAttribution: 'active',
      toolNarration: localize(input.outputLanguage, '复用运行时 Trace 基础指标', 'Reuse runtime trace fact metrics'),
      producerReason: localize(
        input.outputLanguage,
        '快速问答启动阶段已查询当前 trace 的基础事实指标。',
        'The quick-answer startup path already queried basic fact metrics for the current trace.',
      ),
    },
  );
}

export async function buildQuickTraceFactEvidence(
  input: QuickTraceFactEvidenceInput,
): Promise<QuickTraceFactEvidencePayload> {
  const kind = detectQuickTraceFactEvidenceKind(input.query);
  if (!kind) return { envelopes: [] };

  const packageName = input.packageName || input.focusResult?.primaryApp;
  const timeRange = normalizeTimeRange(input.timeRange);
  if (timeRange && !isScopedQuickTraceFactEvidenceKind(kind)) {
    return { envelopes: [], evidenceKind: kind };
  }
  if ((kind === 'frame_metrics' || kind === 'jank_presence' || kind === 'jank_frame_count') && !packageName) {
    return { envelopes: [], evidenceKind: kind };
  }

  const traceSide = input.traceSide ?? 'current';
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const maxRows = kind === 'longest_process_slices'
    ? requestedLongestProcessSliceRows(input.query)
    : undefined;
  const params = {
    kind,
    packageName,
    timeRange,
    maxRows,
  };
  const queryHash = kind === 'longest_process_slices'
    ? stableQuickEvidenceHash({
        traceId: input.traceId,
        traceSide,
        skillId: LONGEST_PROCESS_SLICES_SKILL_ID,
        params,
      })
    : stableHash({
        traceId: input.traceId,
        traceSide,
        params,
      });
  const toolCallId = sourceToolCallId(kind, queryHash);

  try {
    if (kind === 'longest_process_slices') {
      const skillExecutor = input.skillExecutor
        ?? createQuickLongestProcessSlicesSkillExecutor(input.traceProcessor);
      const result = await skillExecutor.execute(
        LONGEST_PROCESS_SLICES_SKILL_ID,
        input.traceId,
        {
          start_ts: timeRange?.startNs,
          end_ts: timeRange?.endNs,
          max_rows: maxRows,
        },
        { __outputLanguage: outputLanguage },
      );
      if (!result.success || !hasDisplayRows(result)) {
        return { envelopes: [], evidenceKind: kind };
      }

      const skillToolCallId = runtimeSkillSourceToolCallId(
        LONGEST_PROCESS_SLICES_SKILL_ID,
        queryHash,
      );
      const envelopes = SkillExecutor.toDataEnvelopes(result, undefined, {
        traceId: input.traceId,
        traceSide,
      }).map((envelope, index) => withQuickEvidenceProvenance(
        {
          ...envelope,
          data: {
            ...envelope.data,
            rows: envelope.data.rows?.slice(0, maxRows),
          },
        },
        {
          skillId: LONGEST_PROCESS_SLICES_SKILL_ID,
          traceId: input.traceId,
          traceSide,
          queryHash,
          sourceToolCallId: skillToolCallId,
          index,
          planPhaseGoal: localize(
            outputLanguage,
            '复用最长进程 Slice Skill 回答 Top-N 时长事实问题',
            'Reuse the longest process slices Skill for Top-N duration facts',
          ),
          toolNarration: localize(
            outputLanguage,
            '查询最长进程 Slice',
            'Query longest process slices',
          ),
          producerReason: localize(
            outputLanguage,
            '快速问答启动阶段已用最长进程 Slice Skill 查询确定性结果。',
            'The quick-answer startup path already queried deterministic results with the longest process slices Skill.',
          ),
          intent: 'runtime_trace_fact_lookup',
          outputLanguage,
        },
      ));
      const payload: QuickTraceFactEvidencePayload = {
        envelopes,
        evidenceKind: kind,
      };
      if (!hasUsableTraceFactEvidence(payload)) {
        return { envelopes: [], evidenceKind: kind };
      }
      return {
        ...payload,
        promptContext: buildPromptContext(payload, outputLanguage),
      };
    }

    if (kind === 'selection_duration') {
      if (!timeRange) return { envelopes: [], evidenceKind: kind };
      const durationNs = timeRange.endNs - timeRange.startNs;
      const envelope = createTraceFactEnvelope({
        traceId: input.traceId,
        traceSide,
        kind,
        scoped: true,
        queryHash,
        sourceToolCallId: toolCallId,
        columns: SELECTION_DURATION_COLUMNS,
        rows: [[
          'selection',
          timeRange.startNs,
          timeRange.endNs,
          durationNs,
          durationNs / 1_000_000_000,
          'selection_context',
        ]],
        outputLanguage,
      });
      const payload: QuickTraceFactEvidencePayload = {
        envelopes: [envelope],
        evidenceKind: kind,
      };
      if (!hasUsableTraceFactEvidence(payload)) {
        return { envelopes: [], evidenceKind: kind };
      }
      return {
        ...payload,
        promptContext: buildPromptContext(payload, outputLanguage),
      };
    }

    const result = await queryTraceFactEvidence({
      traceProcessor: input.traceProcessor,
      traceId: input.traceId,
      kind,
      packageName,
      timeRange,
    });
    if (!result?.rows.length) return { envelopes: [], evidenceKind: kind };

    const envelope = createTraceFactEnvelope({
      traceId: input.traceId,
      traceSide,
      kind,
      scoped: Boolean(timeRange),
      queryHash,
      sourceToolCallId: toolCallId,
      columns: result.columns,
      rows: result.rows.slice(0, 1),
      outputLanguage,
    });
    const payload: QuickTraceFactEvidencePayload = {
      envelopes: [envelope],
      evidenceKind: kind,
    };
    if (!hasUsableTraceFactEvidence(payload)) {
      return { envelopes: [], evidenceKind: kind };
    }

    return {
      ...payload,
      promptContext: buildPromptContext(payload, outputLanguage),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[QuickTraceFactEvidence] trace fact pre-evidence failed:', message);
    return { envelopes: [], evidenceKind: kind };
  }
}
