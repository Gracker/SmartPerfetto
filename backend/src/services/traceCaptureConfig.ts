// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {
  generateTraceConfig,
  type TraceIntent,
} from './traceConfigGenerator';

export type CapturePresetId =
  | 'startup'
  | 'scrolling'
  | 'camera'
  | 'anr'
  | 'game'
  | 'memory'
  | 'memory-profile'
  | 'cpu'
  | 'power'
  | 'overview'
  | 'full';

export type CaptureTarget = 'android' | 'linux';

export interface CaptureConfigRenderOptions {
  target: CaptureTarget;
  preset: CapturePresetId;
  app?: string;
  durationSeconds: number;
  bufferSizeKb?: number;
  extraAtraceCategories?: string[];
  cuj?: string;
}

export interface CapturePresetDefinition {
  id: CapturePresetId;
  label: string;
  intent: TraceIntent;
  defaultDurationSeconds: number;
  bufferSizeKb: number;
  atraceCategories: string[];
  ftraceEvents: string[];
  dataSources: string[];
  description: string;
  /** Chinese rendering of `description`; the proposal rationale is derived from these two. */
  descriptionZh: string;
  /**
   * Present only on a preset that profiles one app process: it needs a
   * concrete `--app` (no `*` or glob) and the device's built-in perfetto,
   * whose profilers are platform daemons a sideloaded tracebox lacks.
   * System-wide presets have none and accept `--app '*'` on any device.
   */
  requirements?: CapturePresetRequirements;
}

export interface CapturePresetRequirements {
  /** Lowest Android API level whose built-in perfetto provides every data source. */
  minApiLevel: number;
  /** Shortest capture the preset's own schedule (e.g. repeated dumps) needs. */
  minDurationSeconds: number;
  /** System-wide preset a proposal falls back to when no concrete app is given. */
  appFallbackPreset: CapturePresetId;
  /** Capture-time caveats: preflight warnings on `capture android`, warnings on proposals. */
  notes: Array<{ en: string; zh: string }>;
}

const COMMON_DATA_SOURCES = [
  'android.packages_list',
  'linux.process_stats',
  'linux.sys_stats',
  'android.log',
];

const COMMON_FTRACE_EVENTS = [
  'sched/sched_switch',
  'sched/sched_blocked_reason',
  'sched/sched_waking',
  'sched/sched_wakeup',
  'sched/sched_wakeup_new',
  'sched/sched_process_exit',
  'sched/sched_process_free',
  'task/task_newtask',
  'task/task_rename',
  'power/cpu_frequency',
  // Actual frequency alone cannot show a clamp. cpu_frequency_limits carries the
  // scheduler/thermal min+max bounds as typed counter tracks.
  'power/cpu_frequency_limits',
  'power/cpu_idle',
  'ftrace/print',
];

// Thermal zone temperature and cooling-device state. Both the power and the
// CPU/scheduler preset need them: a frequency clamp is only attributable once
// the thermal side of the same window is in the trace.
const THERMAL_EVENTS = [
  'thermal/thermal_temperature',
  'thermal/cdev_update',
];

const BINDER_EVENTS = [
  'binder/binder_transaction',
  'binder/binder_transaction_received',
  'binder/binder_transaction_alloc_buf',
  'binder/binder_set_priority',
  'binder/binder_lock',
  'binder/binder_locked',
  'binder/binder_unlock',
];

const CAMERA_MEMORY_EVENTS = [
  'dmabuf_heap/dma_heap_stat',
  'ion/ion_stat',
  // Older Pixel/vendor kernels expose the legacy ION allocation pair rather
  // than ion_stat. Unsupported ftrace events are ignored by traced.
  'kmem/ion_heap_grow',
  'kmem/ion_heap_shrink',
];

const IO_EVENTS = [
  'block/block_rq_issue',
  'block/block_rq_complete',
  'f2fs/f2fs_sync_file_enter',
  'f2fs/f2fs_sync_file_exit',
  'ext4/ext4_sync_file_enter',
  'ext4/ext4_sync_file_exit',
];

const MEMORY_EVENTS = [
  'oom/oom_score_adj_update',
  'kmem/rss_stat',
  'vmscan/mm_vmscan_direct_reclaim_begin',
  'vmscan/mm_vmscan_direct_reclaim_end',
  'vmscan/mm_vmscan_kswapd_wake',
];

const POWER_EVENTS = [
  'power/suspend_resume',
  'power/wakeup_source_activate',
  'power/wakeup_source_deactivate',
  'power/gpu_frequency',
  ...THERMAL_EVENTS,
];

// memory-profile layout. Each data source owns a buffer so one heavy producer
// cannot evict another's data: buffer 0 process_stats + packages_list (RING,
// sized so 1 s polling survives the duration), 1 heapprofd (RING: every
// continuous dump is cumulative, so the newest ones are the ones to keep),
// 2 java_hprof (DISCARD: an early baseline dump is never overwritten mid-dump;
// a late dump that no longer fits is truncated, which the heap-graph analysis
// reports as incomplete), 3 ftrace (small RING).
const MEMORY_PROFILE_JAVA_HPROF_MIN_BUFFER_KB = 256 * 1024;
const MEMORY_PROFILE_HEAPPROFD_BUFFER_KB = 128 * 1024;
const MEMORY_PROFILE_FTRACE_BUFFER_KB = 16 * 1024;
const MEMORY_PROFILE_PROCESS_STATS_KB_PER_SECOND = 64;
const MEMORY_PROFILE_PROCESS_STATS_MIN_KB = 8 * 1024;
const MEMORY_PROFILE_PROCESS_STATS_MAX_KB = 128 * 1024;
const MEMORY_PROFILE_PROC_STATS_POLL_MS = 1000;
const MEMORY_PROFILE_HEAPPROFD_SAMPLING_INTERVAL_BYTES = 32 * 1024;
const MEMORY_PROFILE_HEAPPROFD_SHMEM_SIZE_BYTES = 16 * 1024 * 1024;
const MEMORY_PROFILE_HEAPPROFD_DUMP_INTERVAL_MS = 5000;
// java_hprof always dumps when its data source starts (the baseline) and then
// continuously at dump_phase_ms + k * dump_interval_ms. Spreading two more
// dumps over the duration minus a tail for the last dump to finish yields
// about three dumps: baseline, middle, end.
const MEMORY_PROFILE_JAVA_DUMP_TAIL_MS = 10000;
const MEMORY_PROFILE_JAVA_DUMP_MIN_INTERVAL_MS = 10000;
const CONCRETE_APP_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*(:[A-Za-z0-9_.]+)?$/;

export const CAPTURE_PRESETS: CapturePresetDefinition[] = [
  {
    id: 'startup',
    label: 'Android startup',
    intent: 'startup',
    defaultDurationSeconds: 20,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'dalvik', 'binder_driver', 'pm', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...IO_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline'],
    description: 'App launch and first-frame investigation with sched, binder, IO, logcat, and FrameTimeline.',
    descriptionZh: '启动分析需要覆盖 launch、首帧、调度、binder、IO 和 FrameTimeline 信号。',
  },
  {
    id: 'scrolling',
    label: 'Android scrolling/jank',
    intent: 'scrolling',
    defaultDurationSeconds: 15,
    bufferSizeKb: 65536,
    atraceCategories: ['gfx', 'view', 'input', 'wm', 'am', 'binder_driver', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, 'power/gpu_frequency'],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Scrolling and frame-jank capture with FrameTimeline, input, scheduler, and CPU/GPU frequency.',
    descriptionZh: '滑动和卡顿分析需要 FrameTimeline、input、调度、CPU/GPU 频率和 binder 上下文。',
  },
  {
    id: 'camera',
    label: 'Android Camera',
    intent: 'camera',
    defaultDurationSeconds: 20,
    bufferSizeKb: 98304,
    atraceCategories: ['camera', 'hal', 'gfx', 'view', 'binder_driver', 'freq', 'sched'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...CAMERA_MEMORY_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline'],
    description: 'Camera request, binder, scheduler, preview presentation, and DMA-BUF/ION allocation evidence.',
    descriptionZh: 'Camera 分析需要覆盖 request activity、binder、调度、预览呈现和 DMA-BUF/ION 分配信号。',
  },
  {
    id: 'anr',
    label: 'Android ANR/main-thread block',
    intent: 'anr',
    defaultDurationSeconds: 30,
    bufferSizeKb: 98304,
    atraceCategories: ['am', 'wm', 'view', 'input', 'dalvik', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...IO_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.input.inputevent'],
    description: 'ANR and main-thread blocking with input, binder, scheduler, IO, and logcat context.',
    descriptionZh: 'ANR 分析需要 input、主线程调度、binder、IO 和 logcat 上下文。',
  },
  {
    id: 'game',
    label: 'Android game/rendering',
    intent: 'gpu',
    defaultDurationSeconds: 20,
    bufferSizeKb: 98304,
    atraceCategories: ['gfx', 'view', 'input', 'wm', 'am', 'hal', 'video', 'rs', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, 'power/gpu_frequency'],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'gpu.counters', 'gpu.renderstages'],
    description: 'Game and native rendering capture with app/SF frame signals plus CPU/GPU scheduling context.',
    descriptionZh: '渲染和游戏分析需要 app/SF frame 信号、GPU counters、渲染阶段和调度上下文。',
  },
  {
    id: 'memory',
    label: 'Android memory',
    intent: 'memory',
    defaultDurationSeconds: 30,
    bufferSizeKb: 98304,
    atraceCategories: ['am', 'wm', 'view', 'dalvik', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...MEMORY_EVENTS, ...IO_EVENTS],
    dataSources: COMMON_DATA_SOURCES,
    description: 'Memory pressure, GC, process stats, LMK-adj, reclaim, IO, and logcat correlation.',
    descriptionZh: '内存分析需要 process stats、reclaim、LMK-adj、GC、IO 和 logcat 上下文。',
  },
  {
    // Modelled on Perfetto's Memscope single-process recipe; rendered by
    // renderMemoryProfileConfig, not the shared system-wide layout.
    id: 'memory-profile',
    label: 'Android app memory profile',
    intent: 'memory',
    defaultDurationSeconds: 60,
    bufferSizeKb: MEMORY_PROFILE_JAVA_HPROF_MIN_BUFFER_KB,
    atraceCategories: ['dalvik', 'am', 'wm'],
    ftraceEvents: ['ftrace/print'],
    dataSources: [
      'android.packages_list',
      'linux.process_stats',
      'android.heapprofd',
      'android.java_hprof',
      'linux.ftrace',
    ],
    description: 'Single-app memory profile after Perfetto Memscope: 1 s process memory counters, heapprofd native heap samples, and about three Java heap dumps (baseline, middle, end). Needs a concrete --app, Android 11+, and a profileable or debuggable app.',
    descriptionZh: '单 app 内存剖析（参照 Perfetto Memscope）：1 秒粒度的进程内存计数、heapprofd native 堆采样，以及约 3 次 Java heap dump（基线、中段、末段）。需要明确的 --app、Android 11+，且 app 为 profileable 或 debuggable。',
    requirements: {
      // heapprofd needs API 29; android.java_hprof needs API 30.
      minApiLevel: 30,
      // Shorter captures cannot fit a second Java heap dump after the baseline.
      minDurationSeconds: 20,
      appFallbackPreset: 'memory',
      notes: [
        {
          en: 'memory-profile: on user builds the app must be profileable or debuggable (userdebug/eng builds profile any app); otherwise heapprofd and java_hprof record nothing for it.',
          zh: 'memory-profile：user 版本上 app 必须是 profileable 或 debuggable（userdebug/eng 版本可剖析任意 app），否则 heapprofd 和 java_hprof 不会为它记录任何数据。',
        },
        {
          en: 'memory-profile: each Java heap dump pauses the app while the heap is written (often seconds); expect visible freezes at the dump points.',
          zh: 'memory-profile：每次 Java heap dump 都会在写堆期间暂停 app（常为数秒），dump 时刻会出现可见卡顿。',
        },
        {
          en: 'memory-profile: start the app before capturing; the baseline Java heap dump is taken when the trace starts and only finds a running process.',
          zh: 'memory-profile：请先启动 app 再开始采集；基线 Java heap dump 在 trace 开始时执行，只能找到已在运行的进程。',
        },
      ],
    },
  },
  {
    id: 'cpu',
    label: 'Android CPU/scheduler',
    intent: 'generic',
    defaultDurationSeconds: 15,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS, ...THERMAL_EVENTS],
    dataSources: COMMON_DATA_SOURCES,
    description: 'Scheduler, CPU frequency/idle/limits, thermal zones, process stats, and lightweight app context.',
    descriptionZh: 'CPU 分析需要 scheduler、CPU frequency/idle/limits、thermal zone、process stats 和轻量 app 上下文。',
  },
  {
    id: 'power',
    label: 'Android power/battery',
    intent: 'power',
    defaultDurationSeconds: 60,
    bufferSizeKb: 131072,
    atraceCategories: ['am', 'pm', 'power', 'network', 'binder_driver'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...POWER_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.power', 'android.network_packets'],
    description: 'Battery drain, power rails, suspend/wakeup, wakelock, CPU idle/frequency/limits, thermal zones, and modem correlation.',
    descriptionZh: '功耗分析需要电池、power rail、suspend/wakeup、wakelock、thermal zone、CPU 限频和网络耗电信号。',
  },
  {
    id: 'overview',
    label: 'Android overview',
    intent: 'generic',
    defaultDurationSeconds: 20,
    bufferSizeKb: 65536,
    atraceCategories: ['am', 'wm', 'view', 'gfx', 'input', 'dalvik', 'binder_driver', 'pm', 'webview'],
    ftraceEvents: [...COMMON_FTRACE_EVENTS, ...BINDER_EVENTS],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Balanced default for scene discovery and first-pass SmartPerfetto analysis.',
    descriptionZh: 'Overview capture 是 SmartPerfetto 首轮分析的均衡默认配置。',
  },
  {
    id: 'full',
    label: 'Android full diagnostic',
    intent: 'generic',
    defaultDurationSeconds: 20,
    bufferSizeKb: 131072,
    atraceCategories: [
      'am',
      'adb',
      'aidl',
      'dalvik',
      'audio',
      'binder_lock',
      'binder_driver',
      'bionic',
      'camera',
      'database',
      'gfx',
      'hal',
      'input',
      'network',
      'nnapi',
      'pm',
      'power',
      'rs',
      'res',
      'rro',
      'sm',
      'ss',
      'vibrator',
      'video',
      'view',
      'webview',
      'wm',
    ],
    ftraceEvents: [
      ...COMMON_FTRACE_EVENTS,
      ...BINDER_EVENTS,
      ...IO_EVENTS,
      ...MEMORY_EVENTS,
      ...CAMERA_MEMORY_EVENTS,
      ...THERMAL_EVENTS,
      'irq/irq_handler_entry',
      'irq/irq_handler_exit',
      'sync/sync_timeline',
      'sync/sync_wait',
      'power/gpu_frequency',
      'raw_syscalls/sys_enter',
      'raw_syscalls/sys_exit',
    ],
    dataSources: [...COMMON_DATA_SOURCES, 'android.surfaceflinger.frametimeline', 'android.input.inputevent'],
    description: 'Broad diagnostic preset based on the local full config pattern; higher overhead, richer evidence.',
    descriptionZh: 'Full diagnostic capture 覆盖面广且开销更高，只应在明确要求最大覆盖时使用。',
  },
];

const PRESET_BY_ID = new Map(CAPTURE_PRESETS.map((preset) => [preset.id, preset]));

export function getCapturePreset(id: CapturePresetId): CapturePresetDefinition {
  const preset = PRESET_BY_ID.get(id);
  if (!preset) throw new Error(`unknown capture preset: ${id}`);
  return preset;
}

export function isCapturePresetId(value: string): value is CapturePresetId {
  return PRESET_BY_ID.has(value as CapturePresetId);
}

export function listCapturePresets(): CapturePresetDefinition[] {
  return [...CAPTURE_PRESETS];
}

export function renderAndroidTraceConfig(opts: CaptureConfigRenderOptions): string {
  if (opts.target !== 'android') {
    throw new Error(`capture config target ${opts.target} is not implemented`);
  }

  const preset = getCapturePreset(opts.preset);
  const durationMs = Math.round((opts.durationSeconds ?? preset.defaultDurationSeconds) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('capture duration must be a positive number of seconds');
  }
  if (preset.requirements) {
    return renderMemoryProfileConfig(preset, preset.requirements, opts, durationMs);
  }

  const packageName = opts.app?.trim() || '*';
  const contract = generateTraceConfig({
    intent: preset.intent,
    packageName,
    cuj: opts.cuj,
  });
  const dataSources = resolveCaptureDataSources(preset, { packageName, cuj: opts.cuj });
  const ftraceEvents = unique(preset.ftraceEvents);
  const atraceCategories = unique([
    ...preset.atraceCategories,
    ...(opts.extraAtraceCategories ?? []),
  ]);
  const bufferSizeKb = resolveCaptureBufferSizeKb(preset, opts.durationSeconds, opts.bufferSizeKb);

  return [
    `# SmartPerfetto capture preset: ${preset.id}`,
    `# ${preset.description}`,
    `# Trace config generator rationale: ${contract.rationale}`,
    ...renderBuffer(bufferSizeKb, 'RING_BUFFER'),
    ...renderBuffer(4096, 'RING_BUFFER'),
    ...dataSources
      .filter((source) => source !== 'linux.ftrace')
      .map((source) => renderDataSource(source)),
    ...renderFtraceDataSource(0, ftraceEvents, atraceCategories, packageName),
    ...renderConfigTrailer(durationMs),
  ].join('\n');
}

/**
 * Resolve the `--app` value of a preset that requires one concrete process.
 * heapprofd treats glob characters as wildcards that are only valid with
 * no_startup, and java_hprof needs an exact cmdline, so `*` and patterns fail.
 */
export function isConcreteCaptureApp(app: string | undefined): boolean {
  return CONCRETE_APP_PATTERN.test(app?.trim() ?? '');
}

export function requireConcreteCaptureApp(preset: CapturePresetDefinition, app: string | undefined): string {
  const packageName = app?.trim() ?? '';
  if (!packageName || packageName === '*') {
    throw new Error(`capture preset ${preset.id} profiles one app process; pass a concrete --app <package> (not '*')`);
  }
  if (!isConcreteCaptureApp(packageName)) {
    throw new Error(`capture preset ${preset.id} needs an exact package or process name (e.g. com.example.app or com.example.app:remote), got ${JSON.stringify(packageName)}`);
  }
  return packageName;
}

/**
 * Size of the preset's primary buffer. For system-wide presets this is the
 * duration-scaled ring shared by ftrace. For memory-profile it is the
 * java_hprof (heap graph) DISCARD buffer; the other memory-profile buffers are
 * derived from the duration. An override must keep room for a full baseline
 * dump, so memory-profile rejects one below its default.
 */
export function resolveCaptureBufferSizeKb(
  preset: CapturePresetDefinition,
  durationSeconds: number,
  overrideKb?: number,
): number {
  if (!preset.requirements) {
    return overrideKb ?? calculateCaptureBufferSizeKb(durationSeconds, preset.bufferSizeKb);
  }
  if (overrideKb === undefined) return preset.bufferSizeKb;
  if (!Number.isFinite(overrideKb) || overrideKb < preset.bufferSizeKb) {
    throw new Error(`capture preset ${preset.id} needs a java_hprof buffer of at least ${preset.bufferSizeKb} KB, got ${overrideKb}`);
  }
  return Math.ceil(overrideKb / 4) * 4;
}

/** Data sources a rendered preset config contains. */
export function resolveCaptureDataSources(
  preset: CapturePresetDefinition,
  opts: { packageName: string; cuj?: string },
): string[] {
  if (preset.requirements) return [...preset.dataSources];
  const contract = generateTraceConfig({
    intent: preset.intent,
    packageName: opts.packageName,
    cuj: opts.cuj,
  });
  return unique([
    ...preset.dataSources,
    ...contract.fragments.map((fragment) => fragment.dataSource),
  ]);
}

/** Interval between the continuous Java heap dumps that follow the baseline dump. */
export function memoryProfileJavaDumpIntervalMs(durationMs: number): number {
  const spread = Math.floor((durationMs - MEMORY_PROFILE_JAVA_DUMP_TAIL_MS) / 2 / 1000) * 1000;
  return Math.max(MEMORY_PROFILE_JAVA_DUMP_MIN_INTERVAL_MS, spread);
}

// memory-profile is the only app-profile preset, so it is the one renderer
// behind `requirements`. Only fields present both at the pinned Perfetto
// revision and in Android 11 (API 30) perfetto are emitted: the device parses this textproto and rejects
// unknown fields. That excludes process_stats record_process_age and
// java_hprof smaps_config (needs build ZP1A.260626.001+), both used by
// Memscope. Buffers are addressed by index because BufferConfig.name is newer
// than Android 11. The CUJ option only annotates the system-wide generator
// contract and has no effect here.
function renderMemoryProfileConfig(
  preset: CapturePresetDefinition,
  requirements: CapturePresetRequirements,
  opts: CaptureConfigRenderOptions,
  durationMs: number,
): string {
  const packageName = requireConcreteCaptureApp(preset, opts.app);
  const app = escapeTextProto(packageName);
  if (durationMs < requirements.minDurationSeconds * 1000) {
    throw new Error(`capture preset ${preset.id} needs --duration >= ${requirements.minDurationSeconds} s so a second Java heap dump follows the baseline`);
  }
  const javaHprofBufferKb = resolveCaptureBufferSizeKb(preset, durationMs / 1000, opts.bufferSizeKb);
  const processStatsBufferKb = Math.min(
    MEMORY_PROFILE_PROCESS_STATS_MAX_KB,
    Math.max(
      MEMORY_PROFILE_PROCESS_STATS_MIN_KB,
      Math.ceil(durationMs / 1000) * MEMORY_PROFILE_PROCESS_STATS_KB_PER_SECOND,
    ),
  );
  const javaDumpIntervalMs = memoryProfileJavaDumpIntervalMs(durationMs);
  const atraceCategories = unique([
    ...preset.atraceCategories,
    ...(opts.extraAtraceCategories ?? []),
  ]);

  return [
    `# SmartPerfetto capture preset: ${preset.id}`,
    `# ${preset.description}`,
    '# Buffers: 0 process_stats + packages_list (RING), 1 heapprofd (RING), 2 java_hprof (DISCARD), 3 ftrace (RING).',
    `# java_hprof dumps when the trace starts (baseline), then every ${javaDumpIntervalMs} ms.`,
    ...renderBuffer(processStatsBufferKb, 'RING_BUFFER'),
    ...renderBuffer(MEMORY_PROFILE_HEAPPROFD_BUFFER_KB, 'RING_BUFFER'),
    ...renderBuffer(javaHprofBufferKb, 'DISCARD'),
    ...renderBuffer(MEMORY_PROFILE_FTRACE_BUFFER_KB, 'RING_BUFFER'),
    'data_sources {',
    '  config {',
    '    name: "android.packages_list"',
    '    target_buffer: 0',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "linux.process_stats"',
    '    target_buffer: 0',
    '    process_stats_config {',
    '      scan_all_processes_on_start: true',
    `      proc_stats_poll_ms: ${MEMORY_PROFILE_PROC_STATS_POLL_MS}`,
    '    }',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "android.heapprofd"',
    '    target_buffer: 1',
    '    heapprofd_config {',
    `      process_cmdline: "${app}"`,
    `      sampling_interval_bytes: ${MEMORY_PROFILE_HEAPPROFD_SAMPLING_INTERVAL_BYTES}`,
    `      shmem_size_bytes: ${MEMORY_PROFILE_HEAPPROFD_SHMEM_SIZE_BYTES}`,
    '      block_client: true',
    '      continuous_dump_config {',
    `        dump_phase_ms: ${MEMORY_PROFILE_HEAPPROFD_DUMP_INTERVAL_MS}`,
    `        dump_interval_ms: ${MEMORY_PROFILE_HEAPPROFD_DUMP_INTERVAL_MS}`,
    '      }',
    '    }',
    '  }',
    '}',
    'data_sources {',
    '  config {',
    '    name: "android.java_hprof"',
    '    target_buffer: 2',
    '    java_hprof_config {',
    `      process_cmdline: "${app}"`,
    '      continuous_dump_config {',
    // The baseline dump is implicit at data-source start; a phase equal to
    // the interval keeps the first continuous dump off the baseline.
    `        dump_phase_ms: ${javaDumpIntervalMs}`,
    `        dump_interval_ms: ${javaDumpIntervalMs}`,
    '      }',
    '    }',
    '  }',
    '}',
    ...renderFtraceDataSource(3, preset.ftraceEvents, atraceCategories, packageName),
    ...renderConfigTrailer(durationMs),
  ].join('\n');
}

export function readTraceConfigFile(
  configPath: string,
  opts: { durationSeconds?: number; bufferSizeKb?: number } = {},
): { path: string; textproto: string; durationMs?: number; templated: boolean } {
  const resolved = path.resolve(configPath);
  const source = fs.readFileSync(resolved, 'utf-8');
  const rendered = renderTraceConfigTemplate(source, opts);
  return {
    path: resolved,
    textproto: rendered.textproto,
    durationMs: extractDurationMs(rendered.textproto),
    templated: rendered.templated,
  };
}

export function renderTraceConfigTemplate(
  textproto: string,
  opts: { durationSeconds?: number; bufferSizeKb?: number } = {},
): { textproto: string; templated: boolean } {
  const needsDuration = textproto.includes('{duration_ms}');
  const needsBuffer = textproto.includes('{buffer_size_kb}');
  if (!needsDuration && !needsBuffer) {
    return { textproto, templated: false };
  }
  if (needsDuration && opts.durationSeconds === undefined) {
    throw new Error('config template contains {duration_ms}; pass --duration <seconds>');
  }
  const durationMs = opts.durationSeconds !== undefined
    ? Math.round(opts.durationSeconds * 1000)
    : undefined;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    throw new Error('--duration must be a positive number of seconds');
  }
  const bufferSizeKb = opts.bufferSizeKb
    ?? calculateCaptureBufferSizeKb(opts.durationSeconds ?? 10);
  return {
    textproto: textproto
      .replace(/\{duration_ms\}/g, String(durationMs ?? ''))
      .replace(/\{buffer_size_kb\}/g, String(bufferSizeKb)),
    templated: true,
  };
}

export function addAtraceCategories(textproto: string, categories: string[]): string {
  const clean = unique(categories.map((category) => category.trim()));
  if (clean.length === 0) return textproto;
  const existing = new Set(
    [...textproto.matchAll(/\batrace_categories\s*:\s*"((?:\\"|[^"])*)"/g)]
      .map((match) => unescapeTextProto(match[1] ?? '')),
  );
  const additions = clean.filter((category) => !existing.has(category));
  if (additions.length === 0) return textproto;

  const atraceApps = textproto.match(/(\s*)atrace_apps\s*:/);
  if (atraceApps?.index !== undefined) {
    const indent = atraceApps[1] ?? '';
    const insert = additions.map((category) => `${indent}atrace_categories: "${escapeTextProto(category)}"`).join('\n');
    return `${textproto.slice(0, atraceApps.index)}${insert}\n${textproto.slice(atraceApps.index)}`;
  }

  const ftrace = textproto.match(/(\s*)ftrace_config\s*\{/);
  if (ftrace?.index !== undefined) {
    const lineEnd = textproto.indexOf('\n', ftrace.index);
    const insertAt = lineEnd >= 0 ? lineEnd + 1 : ftrace.index + ftrace[0].length;
    const indent = `${ftrace[1] ?? ''}  `;
    const insert = additions.map((category) => `${indent}atrace_categories: "${escapeTextProto(category)}"`).join('\n');
    return `${textproto.slice(0, insertAt)}${insert}\n${textproto.slice(insertAt)}`;
  }

  throw new Error('--categories requires a Perfetto config with ftrace_config or atrace_apps');
}

export function calculateCaptureBufferSizeKb(durationSeconds: number, minimumKb = 65536): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('--duration must be a positive number of seconds');
  }
  const estimatedKb = Math.round(durationSeconds * 8 * 1024);
  const clampedKb = Math.max(64 * 1024, Math.min(512 * 1024, estimatedKb));
  return Math.max(minimumKb, clampedKb);
}

export function extractDurationMs(textproto: string): number | undefined {
  const matches = [...textproto.matchAll(/^\s*duration_ms\s*:\s*(\d+)\s*$/gm)];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return undefined;
  const value = Number.parseInt(last, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function renderBuffer(sizeKb: number, fillPolicy: 'RING_BUFFER' | 'DISCARD'): string[] {
  return ['buffers {', `  size_kb: ${sizeKb}`, `  fill_policy: ${fillPolicy}`, '}'];
}

function renderFtraceDataSource(
  targetBuffer: number,
  ftraceEvents: string[],
  atraceCategories: string[],
  atraceApp: string,
): string[] {
  return [
    'data_sources {',
    '  config {',
    '    name: "linux.ftrace"',
    `    target_buffer: ${targetBuffer}`,
    '    ftrace_config {',
    ...ftraceEvents.map((event) => `      ftrace_events: "${escapeTextProto(event)}"`),
    ...atraceCategories.map((category) => `      atrace_categories: "${escapeTextProto(category)}"`),
    `      atrace_apps: "${escapeTextProto(atraceApp)}"`,
    '    }',
    '  }',
    '}',
  ];
}

function renderConfigTrailer(durationMs: number): string[] {
  return [
    `duration_ms: ${durationMs}`,
    'flush_period_ms: 5000',
    'incremental_state_config {',
    '  clear_period_ms: 5000',
    '}',
    '',
  ];
}

function renderDataSource(source: string): string {
  switch (source) {
    case 'android.network_packets':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.network_packets"',
        '    target_buffer: 1',
        '    android_network_packets_config {',
        '      poll_ms: 250',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'android.power':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.power"',
        '    target_buffer: 1',
        '    android_power_config {',
        '      battery_poll_ms: 1000',
        '      battery_counters: BATTERY_COUNTER_CHARGE',
        '      battery_counters: BATTERY_COUNTER_CAPACITY_PERCENT',
        '      battery_counters: BATTERY_COUNTER_CURRENT',
        '      battery_counters: BATTERY_COUNTER_CURRENT_AVG',
        '      battery_counters: BATTERY_COUNTER_VOLTAGE',
        '      collect_power_rails: true',
        '      collect_energy_estimation_breakdown: true',
        '      collect_entity_state_residency: true',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'linux.process_stats':
      return [
        'data_sources {',
        '  config {',
        '    name: "linux.process_stats"',
        '    target_buffer: 1',
        '    process_stats_config {',
        '      scan_all_processes_on_start: true',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'linux.sys_stats':
      return [
        'data_sources {',
        '  config {',
        '    name: "linux.sys_stats"',
        '    target_buffer: 1',
        '    sys_stats_config {',
        '      stat_period_ms: 1000',
        '      stat_counters: STAT_CPU_TIMES',
        '      stat_counters: STAT_FORK_COUNT',
        '      cpufreq_period_ms: 1000',
        '    }',
        '  }',
        '}',
      ].join('\n');
    case 'android.log':
      return [
        'data_sources {',
        '  config {',
        '    name: "android.log"',
        '    target_buffer: 1',
        '    android_log_config {',
        '      log_ids: LID_DEFAULT',
        '    }',
        '  }',
        '}',
      ].join('\n');
    default:
      return [
        'data_sources {',
        '  config {',
        `    name: "${escapeTextProto(source)}"`,
        '    target_buffer: 1',
        '  }',
        '}',
      ].join('\n');
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function escapeTextProto(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeTextProto(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}
