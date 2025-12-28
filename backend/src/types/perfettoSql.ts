/**
 * Perfetto SQL Type Definitions
 *
 * Based on official Perfetto documentation:
 * - https://perfetto.dev/docs/analysis/sql-tables
 * - Local: perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/views.sql
 */

// ============================================================================
// Special Data Types (from Perfetto SQL grammar)
// ============================================================================

/**
 * ID - Auto-incrementing row identifier
 */
export type ID = number;

/**
 * JOINID - Foreign key reference to table.column
 */
export type JOINID<T> = T;

/**
 * TIMESTAMP - Nanoseconds since device boot
 */
export type TIMESTAMP = number;

/**
 * DURATION - Time delta in nanoseconds
 */
export type DURATION = number;

/**
 * ARGSETID - Reference to args set
 */
export type ARGSETID = number;

// ============================================================================
// Core Table Interfaces (from prelude/after_eof/views.sql)
// ============================================================================

/**
 * slice - Userspace execution slices
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Slice {
  /** Unique id of the slice */
  id: ID;
  /** Timestamp at the start of the slice (nanoseconds) */
  ts: TIMESTAMP;
  /** Duration of the slice (nanoseconds) */
  dur: DURATION;
  /** Track this slice belongs to */
  track_id: JOINID<number>;
  /** Category of the slice */
  category: string | null;
  /** Name describing what was happening */
  name: string | null;
  /** Depth in the current stack of slices */
  depth: number;
  /** Parent slice id */
  parent_id: ID | null;
  /** Argument set id */
  arg_set_id: ARGSETID;
  /** Thread timestamp at start (if thread time collection enabled) */
  thread_ts: TIMESTAMP | null;
  /** Thread time used by this slice */
  thread_dur: DURATION | null;
  /** CPU instruction counter at start */
  thread_instruction_count: number | null;
  /** Change in CPU instruction counter */
  thread_instruction_delta: number | null;
  /** Alias of category */
  cat: string | null;
  /** Alias of id */
  slice_id: ID;
}

/**
 * thread - Thread information
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Thread {
  /** The id of the thread */
  id: ID;
  /** Unique thread id (not OS tid, as tids are recycled) */
  utid: ID;
  /** OS thread id (not unique over trace lifetime) */
  tid: number;
  /** Thread name */
  name: string | null;
  /** Start timestamp (if known) */
  start_ts: TIMESTAMP | null;
  /** End timestamp (if known) */
  end_ts: TIMESTAMP | null;
  /** Process hosting this thread */
  upid: JOINID<number> | null;
  /** Whether this is the main thread */
  is_main_thread: boolean | null;
  /** Whether this is a kernel idle thread */
  is_idle: boolean | null;
  /** Machine identifier for remote threads */
  machine_id: number | null;
  /** Extra args */
  arg_set_id: ARGSETID;
}

/**
 * process - Process information
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Process {
  /** The id of the process */
  id: ID;
  /** Unique process id (not OS pid, as pids are recycled) */
  upid: ID;
  /** OS process id (not unique over trace lifetime) */
  pid: number;
  /** Process name */
  name: string | null;
  /** Start timestamp (if known) */
  start_ts: TIMESTAMP | null;
  /** End timestamp (if known) */
  end_ts: TIMESTAMP | null;
  /** Parent process upid */
  parent_upid: JOINID<number> | null;
  /** Unix user id */
  uid: number | null;
  /** Android appid */
  android_appid: number | null;
  /** Android user id */
  android_user_id: number | null;
  /** /proc/cmdline for this process */
  cmdline: string | null;
  /** Extra args */
  arg_set_id: ARGSETID;
  /** Machine identifier for remote processes */
  machine_id: number | null;
}

/**
 * counter - Counter track values
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Counter {
  /** Unique id of a counter value */
  id: ID;
  /** Time of fetching the counter value */
  ts: TIMESTAMP;
  /** Track this counter belongs to */
  track_id: JOINID<number>;
  /** Value */
  value: number;
  /** Additional information */
  arg_set_id: ARGSETID;
}

/**
 * args - Key-value metadata
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Arg {
  /** The id of the arg */
  id: ID;
  /** The id for a single set of arguments */
  arg_set_id: ARGSETID;
  /** The flat key (without array indexes) */
  flat_key: string;
  /** The key for the arg */
  key: string;
  /** Integer value */
  int_value: number | null;
  /** String value */
  string_value: string | null;
  /** Double value */
  real_value: number | null;
  /** Type: 'int', 'uint', 'string', 'real', 'pointer', 'bool', 'json' */
  value_type: string;
  /** Human-readable formatted value */
  display_value: string;
}

/**
 * track - Track metadata
 */
export interface Track {
  /** Track id */
  id: ID;
  /** Track name */
  name: string;
  /** Track type (slice, counter, etc.) */
  type: string;
  /** Parent track id (for nested tracks) */
  parent_id: ID | null;
}

/**
 * instant - Zero-duration events
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface Instant {
  /** Timestamp of the instant */
  ts: TIMESTAMP;
  /** Track this instant is on */
  track_id: JOINID<number>;
  /** Name of the instant */
  name: string | null;
  /** Argument set id */
  arg_set_id: ARGSETID;
}

/**
 * android_logs - Logcat entries
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export interface AndroidLog {
  /** Row id */
  id: ID;
  /** Timestamp of log entry */
  ts: TIMESTAMP;
  /** Thread writing the log */
  utid: JOINID<number>;
  /** Priority: 3=DEBUG, 4=INFO, 5=WARN, 6=ERROR */
  prio: number;
  /** Tag of the log entry */
  tag: string;
  /** Content of the log entry */
  msg: string;
}

// ============================================================================
// Android-Specific Tables
// ============================================================================

/**
 * sched - CPU scheduling events from ftrace
 */
export interface Sched {
  /** Timestamp */
  ts: TIMESTAMP;
  /** CPU number */
  cpu: number;
  /** Thread utid */
  utid: ID;
  /** Previous state (R, S, D, etc.) */
  prev_state: string;
  /** Scheduling latency (time from runnable to running) */
  scheduling_latency: DURATION;
}

/**
 * thread_state - Thread scheduling states
 */
export interface ThreadState {
  /** State start timestamp */
  ts: TIMESTAMP;
  /** State duration */
  dur: DURATION;
  /** Thread utid */
  utid: ID;
  /** State: Running, Runnable, Sleeping, Uninterruptible, etc. */
  state: string;
  /** CPU (if running) */
  cpu: number | null;
  /** IO wait reason (if blocked on IO) */
  io_wait: string | null;
}

/**
 * android_startups - App launch events
 * Source: perfetto_sql/stdlib/android/startup/startups_minsdk33.sql
 */
export interface AndroidStartup {
  /** Startup id */
  startup_id: number;
  /** Start timestamp */
  ts: TIMESTAMP;
  /** End timestamp */
  ts_end: TIMESTAMP;
  /** Duration */
  dur: DURATION;
  /** Package name */
  package: string;
  /** Startup type: cold, warm, hot */
  startup_type: 'cold' | 'warm' | 'hot';
}

/**
 * actual_frame_timeline_slice - Frame rendering timeline
 */
export interface FrameTimelineSlice {
  /** Slice id */
  id: ID;
  /** Timestamp */
  ts: TIMESTAMP;
  /** Duration */
  dur: DURATION;
  /** Process upid */
  upid: ID;
  /** VSYNC id (as string in name) */
  name: string;
  /** Track id */
  track_id: ID;
}

// ============================================================================
// Skill-Specific Result Types
// ============================================================================

/**
 * Startup analysis result
 * Source: metrics/sql/android/android_startup.sql
 */
export interface StartupResult {
  /** Startup ID */
  startup_id: number;
  /** Package name */
  package: string;
  /** Process name */
  process_name: string;
  /** Startup type */
  startup_type: 'cold' | 'warm' | 'hot';
  /** Time To Initial Display (ms) */
  ttid: number;
  /** Time To Full Display (ms) */
  ttfd: number;
  /** Report Fully Drawn time (ms) */
  rfd: number | null;
  /** Total duration (ms) */
  dur: number;
  /** Zygote fork duration (ms) */
  zygote_fork_dur: number | null;
  /** Activity name */
  activity: string | null;
  /** Longest slices during startup */
  long_slices: Array<{ name: string; dur: number }>;
  /** GC count during startup */
  gc_count: number;
  /** GC total duration (ms) */
  gc_dur: number;
}

/**
 * Scrolling analysis result
 */
export interface ScrollingResult {
  /** Package name */
  package: string;
  /** Total frames */
  total_frames: number;
  /** Jank frames (missed deadline) */
  jank_frames: number;
  /** Jank percentage */
  jank_percent: number;
  /** Average FPS */
  avg_fps: number;
  /** Frame intervals (ms) */
  frame_intervals: Array<{
    frame_number: number;
    dur: number;
    is_jank: boolean;
  }>;
  /** Longest frame durations */
  longest_frames: Array<{ frame_number: number; dur: number }>;
}

/**
 * Memory analysis result
 */
export interface MemoryResult {
  /** Package name */
  package: string;
  /** Process upid */
  upid: ID;
  /** Peak heap size (bytes) */
  peak_heap_size: number;
  /** Total allocations count */
  total_allocations: number;
  /** Total deallocations count */
  total_deallocations: number;
  /** Net memory change (bytes) */
  net_change: number;
  /** Top allocation sites */
  top_allocations: Array<{
    symbol: string;
    count: number;
    total_bytes: number;
  }>;
  /** OOM events count */
  oom_count: number;
  /** LMK events count */
  lmk_count: number;
}

/**
 * CPU analysis result
 */
export interface CpuResult {
  /** Thread utid */
  utid: ID;
  /** Thread name */
  thread_name: string;
  /** Process name */
  process_name: string;
  /** Total CPU time (ms) */
  total_cpu_time: number;
  /** CPU utilization percentage */
  cpu_percent: number;
  /** Time by state */
  time_by_state: Array<{
    state: string;
    dur: number;
    percent: number;
  }>;
  /** Average frequency (MHz) */
  avg_freq: number | null;
  /** Context switches count */
  context_switches: number;
}

/**
 * SurfaceFlinger analysis result
 */
export interface SurfaceFlingerResult {
  /** Display id */
  display_id: number;
  /** Total frames */
  total_frames: number;
  /** Missed frames */
  missed_frames: number;
  /** Missed HWC frames */
  missed_hwc_frames: number;
  /** Missed GPU frames */
  missed_gpu_frames: number;
  /** GPU wait time (ms) */
  gpu_wait_time: number;
  /** Average frame latency (ms) */
  avg_frame_latency: number;
  /** Janky frames */
  janky_frames: number;
}

/**
 * Input analysis result
 */
export interface InputResult {
  /** Input event type */
  event_type: string;
  /** Total events count */
  total_events: number;
  /** Average latency (ms) */
  avg_latency: number;
  /** Max latency (ms) */
  max_latency: number;
  /** Latency p50 (ms) */
  latency_p50: number;
  /** Latency p95 (ms) */
  latency_p95: number;
  /** Latency p99 (ms) */
  latency_p99: number;
}

/**
 * Binder analysis result
 */
export interface BinderResult {
  /** Process name */
  process_name: string;
  /** Total binder transactions */
  total_txns: number;
  /** Sync transactions */
  sync_txns: number;
  /** Async transactions */
  async_txns: number;
  /** Average transaction duration (ms) */
  avg_dur: number;
  /** Max transaction duration (ms) */
  max_dur: number;
  /** Top transactions by duration */
  top_txns: Array<{
    aidl_name: string;
    dur: number;
    is_sync: boolean;
  }>;
  /** Thread state breakdown during binder calls */
  thread_state_breakdown: Array<{
    state: string;
    dur: number;
    count: number;
  }>;
}

/**
 * Buffer flow analysis result
 */
export interface BufferFlowResult {
  /** Buffer queue depth */
  queue_depth: number;
  /** Average fence wait time (ms) */
  avg_fence_wait: number;
  /** Max fence wait time (ms) */
  max_fence_wait: number;
  /** Total buffers queued */
  total_buffers: number;
  /** Dropped buffers */
  dropped_buffers: number;
  /** Producer to consumer latency (ms) */
  p2c_latency: number;
}

/**
 * SystemServer analysis result
 */
export interface SystemServerResult {
  /** System service name */
  service_name: string;
  /** Total calls */
  total_calls: number;
  /** Average latency (ms) */
  avg_latency: number;
  /** Max latency (ms) */
  max_latency: number;
  /** Slow calls (> 100ms) */
  slow_calls: number;
  /** ANR contributors */
  anr_contributors: string[];
}

/**
 * Navigation analysis result
 */
export interface NavigationResult {
  /** Activity name */
  activity: string;
  /** Navigation type (start, resume, etc.) */
  nav_type: string;
  /** Duration (ms) */
  dur: number;
  /** From activity */
  from_activity: string | null;
  /** To activity */
  to_activity: string;
  /** Fragment transactions */
  fragment_txns: number;
}

/**
 * Click response analysis result
 */
export interface ClickResponseResult {
  /** Click event id */
  event_id: number;
  /** Click timestamp */
  ts: TIMESTAMP;
  /** Time to UI response (ms) */
  response_time: number;
  /** Time to render complete (ms) */
  render_time: number;
  /** Input target */
  target: string;
  /** Response type */
  response_type: string;
}

// ============================================================================
// Analysis Request/Response Types
// ============================================================================

/**
 * Request for general Perfetto SQL analysis
 */
export interface PerfettoSqlRequest {
  /** Trace ID to analyze */
  traceId: string;
  /** Natural language question */
  question: string;
  /** Optional: package name filter */
  packageName?: string;
  /** Optional: time range filter (ns) */
  timeRange?: { start: number; end: number };
}

/**
 * Response from Perfetto SQL analysis
 */
export interface PerfettoSqlResponse {
  /** Analysis type that was used */
  analysisType: string;
  /** Generated SQL query */
  sql: string;
  /** Query result rows (array of arrays, matching QueryResult format) */
  rows: any[];
  /** Row count */
  rowCount: number;
  /** Human-readable summary */
  summary: string;
  /** Additional metrics */
  metrics?: Record<string, number | string>;
  /** Additional analysis details (e.g., jank breakdown, method used) */
  details?: Record<string, unknown>;
}

/**
 * Skill type enum
 */
export enum PerfettoSkillType {
  STARTUP = 'startup',
  SCROLLING = 'scrolling',
  NAVIGATION = 'navigation',
  CLICK_RESPONSE = 'click_response',
  MEMORY = 'memory',
  CPU = 'cpu',
  SURFACE_FLINGER = 'surfaceflinger',
  SYSTEM_SERVER = 'systemserver',
  INPUT = 'input',
  BINDER = 'binder',
  BUFFER_FLOW = 'bufferflow',
}

/**
 * Detected intent from user question
 */
export interface DetectedIntent {
  /** Skill type to use */
  skillType: PerfettoSkillType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Extracted parameters */
  params: Record<string, string | number>;
}
