// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The critical-path response contract: `POST /api/critical-path/:traceId/analyze`
 * and the engine result it carries. The engine modules import these types
 * rather than declare their own, and `npm run generate:frontend-types` emits
 * them into the AI Assistant plugin's generated types (the `(typeof X)[number]`
 * id unions become literal unions there), so the drawer reads the same shape
 * the route writes. `npm run check:types` fails when the two drift.
 *
 * Keep this module declarations only: the id lists below are the single source
 * of every id the engine can emit, and nothing here may import backend code.
 */

export const CRITICAL_PATH_MODULE_IDS = [
  'binder_ipc',
  'lock_futex',
  'io_candidate',
  'sched_cpu',
  'graphics_surface',
  'input',
  'art_gc',
  'kernel_irq',
  'power_wakeup',
  'lock_monitor',
  'io_filesystem',
  'network_receive_candidate',
  'worker_handoff',
  'unclassified',
] as const;

export type CriticalPathModuleId = (typeof CRITICAL_PATH_MODULE_IDS)[number];

export type TextParams = Readonly<Record<string, string | number | boolean | null>>;

/** A product-authored message: a stable code plus the values it quotes. */
export interface CriticalPathTextCode<C extends string = string> {
  code: C;
  params?: TextParams;
}

/** Why a segment is labelled what it is; `slice` and `kernel_function` are trace data. */
export type CriticalPathReason =
  | {kind: 'state'; state: string}
  | {kind: 'kernel_function'; name: string}
  | {kind: 'io_wait'}
  | {kind: 'cpu'; cpu: number | null}
  | {kind: 'slice'; name: string}
  | {kind: 'binder'; process: string | null; method: string | null}
  | {kind: 'lock'; method: string | null}
  | {kind: 'gc_in_window'}
  | {kind: 'cpu_competition'; cpu: number}
  | {kind: 'wake_class'; waitClass: string};

export type CriticalPathEvidence =
  | {kind: 'text'; text: string}
  | {kind: 'task'; process: string | null; thread: string | null}
  | {kind: 'state'; state: string | null}
  /** The longest attributable (work, runnable or uninterruptible) segment of the chain. */
  | {kind: 'longest_segment'; process: string | null; thread: string | null; ms: number}
  /** A chain leaf: another thread's interruptible sleep that ended the chain, and what woke it. */
  | {kind: 'leaf_wait'; process: string | null; thread: string | null; ms: number; waitClass: WaitClass | null}
  /** The selected thread's own wait the analysis explains. */
  | {kind: 'root_wait'; state: string | null; ms: number}
  | {kind: 'duration'; ms: number}
  | {kind: 'selected_task'; ms: number}
  /** Attributable path time: other threads' work, runnable and uninterruptible time. */
  | {kind: 'attributable_path'; ms: number}
  | {kind: 'task_duration'; ms: number}
  | {kind: 'utid'; utid: number}
  | {kind: 'module'; id: CriticalPathModuleId}
  | {kind: 'reason'; reason: CriticalPathReason};

export const CRITICAL_PATH_ANOMALY_IDS = [
  'task_too_long',
  'task_over_frame_budget',
  'external_share_high',
  'long_segment',
  'io_candidate',
  'network_receive_wait',
  'worker_handoff_wait',
  'binder_ipc',
  'java_monitor',
  'gc_overlap',
  'cpu_contention',
  'peer_event_wait',
  'idle_wait',
  'no_clear_anomaly',
  // Unavailable reasons: an empty analysis carries its reason as its one anomaly.
  'task_state_running',
  'no_waiting_time',
  'no_critical_path_stack',
  'no_thread_state_in_window',
  'wait_open_at_trace_end',
] as const;

export type CriticalPathAnomalyId = (typeof CRITICAL_PATH_ANOMALY_IDS)[number];

export const CRITICAL_PATH_RECOMMENDATION_IDS = [
  'follow_binder',
  'inspect_io',
  'inspect_locks',
  'align_rendering',
  'inspect_scheduling',
  'inspect_gc',
  'start_longest_segment',
  'running_selection',
  'no_waiting_selection',
  'record_sched_events',
  'follow_peer_event_wait',
  'choose_active_window',
  'choose_thread_with_sched_data',
  'inspect_unfinished_wait',
] as const;

export type CriticalPathRecommendationId = (typeof CRITICAL_PATH_RECOMMENDATION_IDS)[number];

export const CRITICAL_PATH_WARNING_CODES = [
  'chain_cut',
  'display_cut',
  'recursion_budget',
  'recursion_failed',
  'recursion_cut',
  'invalid_thread_state_id',
  'waker_query_failed',
  'thread_state_not_found',
  'no_recorded_waker',
  'include_failed',
  'stdlib_table_missing',
  'schema_mismatch',
  'query_failed',
  'loader_row_cap',
  'frames_include_failed',
  'frame_query_failed',
  'wait_open_at_trace_end',
  'root_wait_query_failed',
  'thread_state_id_ignored_conflict',
] as const;

export type CriticalPathWarningCode = (typeof CRITICAL_PATH_WARNING_CODES)[number];

export type CriticalPathWarning = CriticalPathTextCode<CriticalPathWarningCode>;

export const CRITICAL_PATH_HINT_CODES = ['irq_wakeup', 'swapper_wakeup', 'range_longest_waiting_slice'] as const;

export type CriticalPathHintCode = (typeof CRITICAL_PATH_HINT_CODES)[number];

export const CRITICAL_PATH_HYPOTHESIS_IDS = [
  'h-binder-server-gc',
  'h-monitor-blocking',
  'h-io-wait',
  'h-gc-stall',
  'h-cpu-competition',
] as const;

export type CriticalPathHypothesisId = (typeof CRITICAL_PATH_HYPOTHESIS_IDS)[number];

export const CRITICAL_PATH_NOTE_CODES = [
  'sync_binder_client',
  'main_thread_blocked',
  'non_main_thread',
  'io_wait_confirmed',
  'inferred_from_blocked_function',
  'mark_compact',
  'non_mark_compact',
  'cpu_max_freq',
  'best_case_only',
] as const;

export type CriticalPathNoteCode = (typeof CRITICAL_PATH_NOTE_CODES)[number];

export type CriticalPathNote = CriticalPathTextCode<CriticalPathNoteCode>;

export type SemanticSourceStatus =
  | 'present'
  | 'empty'
  | 'stdlib_missing'
  | 'sql_error'
  | 'skipped';

export type SemanticSourceName = 'binder' | 'monitor' | 'io' | 'gc' | 'cpu' | 'wakeSource';

export type SemanticSources = Record<SemanticSourceName, SemanticSourceStatus>;

// Every duration below is attributable time: the event's overlap with the
// segment window it is attached to. `eventDurMs` is the whole event.
export interface BinderTxnSummary {
  binderTxnId: number | null;
  binderReplyId: number | null;
  side: 'client' | 'server' | 'both';
  interfaceName: string | null;
  methodName: string | null;
  isSync: boolean | null;
  isMainThread: boolean | null;
  clientProcess: string | null;
  clientThread: string | null;
  serverProcess: string | null;
  serverThread: string | null;
  clientUtid: number | null;
  serverUtid: number | null;
  clientTid: number | null;
  serverTid: number | null;
  durMs: number;
  eventDurMs: number;
}

export interface MonitorContentionSummary {
  rowId: number;
  /** `blocked`: the segment's thread waited for the lock; `owner`: it held the lock its waiter waited for. */
  side: 'blocked' | 'owner';
  shortBlockedMethod: string | null;
  shortBlockingMethod: string | null;
  blockedThreadName: string | null;
  blockingThreadName: string | null;
  blockedTid: number | null;
  blockingTid: number | null;
  blockedUtid: number | null;
  blockingUtid: number | null;
  durMs: number;
  eventDurMs: number;
  isBlockedThreadMain: boolean | null;
}

export interface IoSignal {
  source: 'io_wait_flag' | 'blocked_function';
  blockedFunction: string | null;
  durMs: number;
  eventDurMs: number;
  ioWait: boolean;
}

// Wake-source labels, produced in SQL by fragments/sleep_wake_source_labels.sql:
// Android emits sched_blocked_reason only for D-state waits, so an S wait's
// only kernel signal is who woke it. Both labels are candidates, never causes.
export type WaitClass =
  | 'network_receive_candidate'
  | 'timer_or_device_wake'
  | 'worker_handoff'
  | 'binder_reply'
  | 'system_service'
  | 'unknown';

export type WakeSource =
  | 'irq_or_softirq'
  | 'same_process_thread'
  | 'binder_thread'
  | 'system_process'
  | 'swapper'
  | 'unknown';

export interface WakeSourceSummary {
  state: string | null;
  durMs: number;
  eventDurMs: number;
  threadName: string | null;
  threadRole: string;
  wakerThreadName: string | null;
  wakerProcessName: string | null;
  wakerRole: string;
  irqContext: boolean;
  wakeSource: WakeSource;
  waitClass: WaitClass;
}

export interface GcEventSummary {
  gcType: string | null;
  isMarkCompact: boolean | null;
  reclaimedMb: number | null;
  durMs: number;
  eventDurMs: number;
  thread: string | null;
  process: string | null;
}

export interface CpuCompetitionSummary {
  cpu: number;
  competingTid: number | null;
  competingUtid: number | null;
  competingThread: string | null;
  competingProcess: string | null;
  competingState: string | null;
  competingDurMs: number;
  eventDurMs: number;
  cpuMaxFreqKhz: number | null;
}

export interface SegmentSemantics {
  segmentKey: string;
  // The segment the evidence below was attached to (entity + window).
  utid: number;
  upid: number | null;
  startTs: number;
  endTs: number;
  binderTxns: BinderTxnSummary[];
  monitorContention: MonitorContentionSummary[];
  ioSignals: IoSignal[];
  gcEvents: GcEventSummary[];
  cpuCompetition: CpuCompetitionSummary[];
  wakeSources: WakeSourceSummary[];
}

export type WakerKind = 'irq' | 'swapper' | 'thread' | 'unknown';

export interface WakerHop {
  threadStateId: number | null;
  utid: number | null;
  tid: number | null;
  threadName: string | null;
  processName: string | null;
  state: string | null;
  cpu: number | null;
  irqContext: boolean;
  kind: WakerKind;
  /** What the wakeup says about the chain upstream of it. */
  hintCodes: CriticalPathHintCode[];
  /** `hintCodes` rendered (zh-CN until a projection renders another language). */
  hints: string[];
}

export interface CounterfactualEstimate {
  longestSegmentKey: string | null;
  longestSegmentDurMs: number;
  /** Task duration left if the longest external segment took no time (task − longest). */
  bestCaseDurationMs: number;
  /** The most removing that segment can save (= longestSegmentDurMs). */
  maxSavingMs: number;
  /** The exact ns the ms fields above are rounded from. */
  longestSegmentDurNs: number;
  bestCaseDurationNs: number;
  maxSavingNs: number;
  noteCode: 'best_case_only';
  /** `noteCode` rendered. */
  note: string;
}

export interface FrameImpact {
  frameId: number | null;
  expectedDeadlineDurMs: number;
  jankType: string | null;
  presentType: string | null;
  layerName: string | null;
  appUpid: number | null;
  overlapMs: number;
}

export type HypothesisStrength = 'strong' | 'weak' | 'speculative';

export interface CriticalPathHypothesis {
  id: CriticalPathHypothesisId;
  /** The numbers and enums the statement quotes; the statement is rendered from them. */
  params: TextParams;
  statement: string;
  strength: HypothesisStrength;
  /**
   * SQL that, when run on the same trace, will return rows iff the hypothesis
   * holds. Codex P1-8: only numeric IDs are interpolated; never string
   * literals from segment metadata.
   */
  verificationSql: string;
  noteCodes: CriticalPathNote[];
  /** `noteCodes` rendered. */
  notes: string[];
}

export interface CriticalPathQuantification {
  counterfactual: CounterfactualEstimate | null;
  frameImpacts: FrameImpact[];
  hypotheses: CriticalPathHypothesis[];
  warnings: CriticalPathWarning[];
}

export type CriticalPathInputErrorCode =
  | 'invalid_thread_state_id'
  | 'thread_state_not_found'
  | 'missing_selector'
  | 'non_positive_duration'
  | 'invalid_integer'
  | 'invalid_name';

export interface CriticalPathTaskInfo {
  threadStateId?: number;
  utid: number;
  tid?: number | null;
  upid?: number | null;
  startTs: number;
  dur: number;
  durationMs: number;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  threadName?: string | null;
  processName?: string | null;
}

/**
 * What a chain segment's time means for the selected task.
 *
 * Perfetto's `thread_executing_span` ends a wake chain wherever the waker was
 * itself woken from IRQ context, by the idle task, or out of an io_wait: those
 * wakes have no waker thread to follow. The chain's segments of other threads
 * in S/I or D state are therefore leaves — the waker's own sleep, ended by an
 * interrupt — never another link.
 *
 * - `work`: the thread ran (Running).
 * - `runnable`: the thread was ready but waited for a CPU (R, R+).
 * - `device_wait`: uninterruptible sleep (D, DK), usually I/O or a kernel lock.
 * - `event_wait`: interruptible sleep (S, I) until an external event: a
 *   network packet, a timer, an input event or idle time. It can be the real
 *   blocker (a lock owner sleeping on a socket) or plain idleness.
 * - `other`: any other or missing state.
 *
 * `work + runnable + device_wait` is the attributable time; `event_wait` is
 * reported beside it and never counted as attributable.
 */
export type CriticalPathRole = 'work' | 'runnable' | 'device_wait' | 'event_wait' | 'other';

export interface CriticalPathSegment {
  startTs: number;
  dur: number;
  startOffsetMs: number;
  durationMs: number;
  utid: number;
  /** The blocking thread_state row of this segment, when the stack names one. */
  threadStateId?: number | null;
  tid?: number | null;
  upid?: number | null;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  blockedFunction?: string | null;
  ioWait?: boolean | null;
  cpu?: number | null;
  slices: string[];
  /** Module ids, primary first. */
  moduleIds: CriticalPathModuleId[];
  /** `moduleIds` rendered. */
  modules: string[];
  reasonItems: CriticalPathReason[];
  /** `reasonItems` rendered. */
  reasons: string[];
  semantics?: SegmentSemantics;
  // Which wake source ended this sleep, when the segment was sleeping at all.
  // It is a candidate label, not a cause: an IRQ-context wake is equally a
  // NET_RX softirq and a timer expiry.
  wakeSourceClass?: WaitClass;
  /** What the segment's time means for the task; set by the engine on every segment. */
  pathRole?: CriticalPathRole;
  recursionDepth?: number;
  // Children: result of recursing _critical_path_stack on this segment.
  children?: CriticalPathSegment[];
}

export interface CriticalPathModuleStat {
  moduleId: CriticalPathModuleId;
  /** `moduleId` rendered. */
  module: string;
  durationMs: number;
  percentage: number;
  segmentCount: number;
  examples: string[];
}

export interface CriticalPathAnomaly {
  id: CriticalPathAnomalyId;
  /** The values the detail quotes (numbers, trace names). */
  params?: TextParams;
  severity: 'critical' | 'warning' | 'info';
  /** Rendered from `id`. */
  title: string;
  /** Rendered from `id` and `params`. */
  detail: string;
  evidenceItems: CriticalPathEvidence[];
  /** `evidenceItems` rendered. */
  evidence: string[];
}

/** The longest attributable segment of the whole chain (the displayed prefix may not hold it). */
export interface CriticalPathLongestSegment {
  processName: string | null;
  threadName: string | null;
  durationMs: number;
  moduleIds: CriticalPathModuleId[];
}

export type SliceKind = 'sleeping' | 'uninterruptible' | 'runnable' | 'running' | 'unknown';

export interface SliceFinding {
  threadStateId: number | null;
  startTs: number;
  endTs: number;
  durationMs: number;
  state: string | null;
  kind: SliceKind;
  cpu: number | null;
  blockedFunction: string | null;
  ioWait: boolean | null;
}

/**
 * Why `available` is false: the selected row is Running, the window holds no
 * S/I/D/DK/R/R+ time, Perfetto returned no critical-path stack, the thread has
 * no thread_state row in the window at all (a thread without scheduling data,
 * not an idle one), or the selected wait never ended before the trace did and
 * nothing in it can be followed.
 */
export type CriticalPathUnavailableReason =
  | 'task_state_running'
  | 'no_critical_path_stack'
  | 'no_waiting_time'
  | 'no_thread_state_in_window'
  | 'wait_open_at_trace_end';

/**
 * Where the selected thread's own wait sat relative to its slices.
 *
 * - `in_slice`: a slice of the thread encloses the start of the wait, so the
 *   thread blocked while doing traced work.
 * - `between_slices`: no slice encloses it, but the thread has slices both
 *   before and after it: the wait sat between instrumented work, which is how
 *   an idle Looper looks.
 * - `no_slice_data`: the thread has no slices on at least one side, so the
 *   trace cannot tell work from idleness (atrace app categories missing).
 */
export type CriticalPathRootWaitContext = 'in_slice' | 'between_slices' | 'no_slice_data';

/**
 * The selected thread's own wait the chain explains: the selected
 * thread_state row, or in range mode the longest waiting slice of the window.
 */
export interface CriticalPathRootWait {
  threadStateId: number | null;
  state: string | null;
  startTs: number;
  endTs: number;
  durationMs: number;
  context: CriticalPathRootWaitContext;
  /** The deepest slice of the thread enclosing the wait's start (`in_slice` only). */
  enclosingSlice: {name: string; startTs: number; dur: number; depth: number} | null;
}

/** The longest `event_wait` leaf of the chain: a peer's sleep that ended the chain. */
export interface CriticalPathLeafWait {
  utid: number;
  processName: string | null;
  threadName: string | null;
  state: string | null;
  durationMs: number;
  wakeSourceClass: WaitClass | null;
}

export interface CriticalPathAnalysis {
  available: boolean;
  task: CriticalPathTaskInfo;
  totalMs: number;
  /**
   * Path coverage: the part of the window the chain covers with other threads,
   * whatever they were doing. It includes their `event_wait` leaves, so it is
   * not the time other threads cost the task; read `attributableMs`.
   */
  blockingMs: number;
  selfMs: number;
  /** `blockingMs` as a share of the window (path coverage). */
  externalBlockingPercentage: number;
  /**
   * Other threads' work, runnable and uninterruptible time on the chain: the
   * part of the window another thread's execution or device wait accounts
   * for. The headline number.
   */
  attributableMs?: number;
  attributablePercentage?: number;
  /** Other threads' interruptible sleep (S/I) that ended the chain. */
  eventWaitMs?: number;
  eventWaitPercentage?: number;
  rootWait?: CriticalPathRootWait | null;
  longestEventWait?: CriticalPathLeafWait | null;
  wakeupChain: CriticalPathSegment[];
  moduleBreakdown: CriticalPathModuleStat[];
  anomalies: CriticalPathAnomaly[];
  /** Rendered from the fields below. */
  summary: string;
  recommendationIds: CriticalPathRecommendationId[];
  /** `recommendationIds` rendered. */
  recommendations: string[];
  warningCodes: CriticalPathWarning[];
  /** `warningCodes` rendered. */
  warnings: string[];
  rawRows: number;
  truncated: boolean;
  /** The longest attributable segment (work, runnable or uninterruptible) of the whole chain. */
  longestSegment?: CriticalPathLongestSegment | null;
  // Additive fields:
  slices?: SliceFinding[];
  directWaker?: WakerHop | null;
  quantification?: CriticalPathQuantification;
  semanticSources?: Partial<SemanticSources>;
  unavailableReason?: CriticalPathUnavailableReason;
  // `wakeupChain` holds only the displayed prefix; consumers that summarise
  // waits (the MCP tool routes on them) read these whole-chain totals instead.
  // They cover the top-level chain only: a recursion child covers the same
  // wall time as its parent, so adding it would count that interval again.
  chainSegmentCount?: number;
  /** The chain's S/I/D time: `event_wait + device_wait`. */
  chainWaitMs?: number;
  /** `chainWaitMs` split by the wake-source class of each wait (`unknown` when none). */
  waitClassTotalsMs?: Record<string, number>;
  /**
   * The exact ns behind the rounded headline ms fields. The window is
   * `task.dur` and self time is `task.dur - blocking` (never below 0).
   * Evidence captures read these, never the rounded values.
   */
  totalsNs?: CriticalPathTotalsNs;
}

/**
 * One accounting of the whole top-level chain, by `CriticalPathRole`:
 * `work + runnable + deviceWait + eventWait + other = blocking`,
 * `attributable = work + runnable + deviceWait`,
 * `chainWait = deviceWait + eventWait`.
 */
export interface CriticalPathTotalsNs {
  /** Path coverage: every segment of the whole top-level chain. */
  blocking: number;
  /** The chain's S/I/D time (`chainWaitMs`). */
  chainWait: number;
  /** The selected thread's own S/I/D time inside the window. */
  waiting: number;
  work: number;
  runnable: number;
  deviceWait: number;
  eventWait: number;
  other: number;
  attributable: number;
}

/**
 * The optional model narrative of an auxiliary analysis (critical path,
 * flamegraph): a model answer, or the deterministic rule summary with the
 * reason no model answered.
 */
export interface AiSummary {
  generated: boolean;
  model?: string;
  summary: string;
  warnings: string[];
  redactionApplied?: boolean;
  /** Set whenever `generated` is false; `warnings` carries the localized explanation. */
  fallbackReason?: AiSummaryFallbackReason;
}

/** Why the rule summary was returned instead of a model answer. */
export type AiSummaryFallbackReason =
  | 'ai_disabled'
  | 'permission_denied'
  | 'runtime_not_supported'
  | 'runtime_unavailable'
  | 'credentials_missing'
  | 'client_disconnected'
  | 'timed_out'
  | 'failed'
  | 'empty_response';

export type CriticalPathAiSummary = AiSummary;
export type CriticalPathAiFallbackReason = AiSummaryFallbackReason;

/** Body of `POST /api/critical-path/:traceId/analyze`; the route's schema must accept exactly this. */
export interface CriticalPathAnalyzeRequest {
  /** Exact thread_state row id; its row is the window. */
  threadStateId?: number | string;
  /** Without threadStateId: the thread and window (`dur`, or `endTs`). */
  utid?: number | string;
  startTs?: number | string;
  dur?: number | string;
  endTs?: number | string;
  /** Omitted limits take the engine's `CRITICAL_PATH_DEFAULTS.ui`. */
  maxSegments?: number;
  recursionDepth?: number;
  recursionEnabled?: boolean;
  segmentBudget?: number;
  includeAi?: boolean;
  question?: string;
  outputLanguage?: 'zh-CN' | 'en';
}

export interface CriticalPathAnalyzeResponse {
  success: true;
  /**
   * The engine result rendered in zh-CN (the compatible legacy text fields).
   * @deprecated Read `presentationAnalysis`: the same result in the requested
   * language. Kept for existing HTTP clients; removal is a tracked follow-up.
   */
  analysis: CriticalPathAnalysis;
  /** The same result rendered in the requested output language. */
  presentationAnalysis: CriticalPathAnalysis;
  /** Absent when the request set `includeAi: false`. */
  aiSummary?: CriticalPathAiSummary;
}

export type CriticalPathRouteErrorCode =
  | 'invalid_trace_id'
  | 'invalid_request_body'
  | 'trace_not_found'
  | 'critical_path_failed'
  | CriticalPathInputErrorCode;

export interface CriticalPathErrorResponse {
  success: false;
  code: CriticalPathRouteErrorCode;
  /** Localized; the raw failure stays in the server log. */
  error: string;
  /** For `invalid_request_body`: the fields that failed validation. */
  issues?: Array<{path: string; message: string}>;
}
