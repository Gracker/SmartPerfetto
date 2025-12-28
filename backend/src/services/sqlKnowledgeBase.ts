/**
 * SQL Knowledge Base
 *
 * Stores official Perfetto SQL table schemas, function signatures,
 * and analysis patterns from the official Perfetto codebase.
 *
 * Sources:
 * - perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/views.sql
 * - perfetto/docs/analysis/builtin.md
 * - perfetto/src/trace_processor/metrics/sql/android/
 */

import fs from 'fs';
import path from 'path';

// ============================================================================
// Table Schema Definitions (from official views.sql)
// ============================================================================

export interface TableColumn {
  name: string;
  type: string;
  description: string;
  nullable?: boolean;
}

export interface TableSchema {
  name: string;
  description: string;
  columns: TableColumn[];
  joins?: string[]; // Tables this commonly joins with
}

/**
 * Official Perfetto table schemas
 * Source: perfetto_sql/stdlib/prelude/after_eof/views.sql
 */
export const TABLE_SCHEMAS: Record<string, TableSchema> = {
  slice: {
    name: 'slice',
    description: 'Contains slices from userspace which explains what threads were doing during the trace',
    columns: [
      { name: 'id', type: 'ID', description: 'The id of the slice' },
      { name: 'ts', type: 'TIMESTAMP', description: 'The timestamp at the start of the slice in nanoseconds' },
      { name: 'dur', type: 'DURATION', description: 'The duration of the slice in nanoseconds' },
      { name: 'track_id', type: 'JOINID(track.id)', description: 'The id of the track this slice is located on' },
      { name: 'category', type: 'STRING', description: 'The "category" of the slice', nullable: true },
      { name: 'name', type: 'STRING', description: 'The name of the slice', nullable: true },
      { name: 'depth', type: 'LONG', description: 'The depth of the slice in the current stack of slices' },
      { name: 'parent_id', type: 'JOINID(slice.id)', description: 'The id of the parent slice', nullable: true },
      { name: 'arg_set_id', type: 'ARGSETID', description: 'The id of the argument set', nullable: true },
      { name: 'thread_ts', type: 'TIMESTAMP', description: 'Thread timestamp at start', nullable: true },
      { name: 'thread_dur', type: 'DURATION', description: 'Thread time used by this slice', nullable: true },
      { name: 'cat', type: 'STRING', description: 'Alias of category', nullable: true },
      { name: 'slice_id', type: 'JOINID(slice.id)', description: 'Alias of id' },
    ],
    joins: ['thread', 'track', 'process', 'args'],
  },

  slices: {
    name: 'slices',
    description: 'Alternative alias of table slice',
    columns: [
      { name: 'id', type: 'ID', description: 'Alias of slice.id' },
      { name: 'ts', type: 'TIMESTAMP', description: 'Alias of slice.ts' },
      { name: 'dur', type: 'DURATION', description: 'Alias of slice.dur' },
      { name: 'track_id', type: 'JOINID(track.id)', description: 'Alias of slice.track_id' },
      { name: 'category', type: 'STRING', description: 'Alias of slice.category', nullable: true },
      { name: 'name', type: 'STRING', description: 'Alias of slice.name', nullable: true },
      { name: 'depth', type: 'LONG', description: 'Alias of slice.depth' },
    ],
    joins: ['thread', 'track', 'process'],
  },

  thread: {
    name: 'thread',
    description: 'Contains information of threads seen during the trace',
    columns: [
      { name: 'id', type: 'ID', description: 'The id of the thread' },
      { name: 'utid', type: 'ID', description: 'Unique thread id (monotonic, not OS tid)' },
      { name: 'tid', type: 'LONG', description: 'The OS id for this thread (not unique)' },
      { name: 'name', type: 'STRING', description: 'The name of the thread', nullable: true },
      { name: 'start_ts', type: 'TIMESTAMP', description: 'The start timestamp', nullable: true },
      { name: 'end_ts', type: 'TIMESTAMP', description: 'The end timestamp', nullable: true },
      { name: 'upid', type: 'JOINID(process.id)', description: 'The process hosting this thread', nullable: true },
      { name: 'is_main_thread', type: 'BOOL', description: 'Whether this is the main thread', nullable: true },
      { name: 'is_idle', type: 'BOOL', description: 'Whether this is a kernel idle thread', nullable: true },
    ],
    joins: ['process', 'thread_track'],
  },

  process: {
    name: 'process',
    description: 'Contains information of processes seen during the trace',
    columns: [
      { name: 'id', type: 'ID', description: 'The id of the process' },
      { name: 'upid', type: 'ID', description: 'Unique process id (monotonic, not OS pid)' },
      { name: 'pid', type: 'LONG', description: 'The OS id for this process (not unique)' },
      { name: 'name', type: 'STRING', description: 'The name of the process', nullable: true },
      { name: 'cmdline', type: 'STRING', description: '/proc/cmdline for this process', nullable: true },
      { name: 'start_ts', type: 'TIMESTAMP', description: 'The start timestamp', nullable: true },
      { name: 'end_ts', type: 'TIMESTAMP', description: 'The end timestamp', nullable: true },
      { name: 'parent_upid', type: 'JOINID(process.id)', description: 'Parent process upid', nullable: true },
      { name: 'uid', type: 'LONG', description: 'The Unix user id', nullable: true },
      { name: 'android_appid', type: 'LONG', description: 'Android appid', nullable: true },
    ],
    joins: ['thread'],
  },

  counter: {
    name: 'counter',
    description: 'Counters are values put into tracks during parsing of the trace',
    columns: [
      { name: 'id', type: 'ID', description: 'Unique id of a counter value' },
      { name: 'ts', type: 'TIMESTAMP', description: 'Time of fetching the counter value' },
      { name: 'track_id', type: 'JOINID(track.id)', description: 'Track this counter belongs to' },
      { name: 'value', type: 'DOUBLE', description: 'Value' },
      { name: 'arg_set_id', type: 'ARGSETID', description: 'Additional information' },
    ],
    joins: ['track'],
  },

  args: {
    name: 'args',
    description: 'Arbitrary key-value pairs for metadata',
    columns: [
      { name: 'id', type: 'ID', description: 'The id of the arg' },
      { name: 'arg_set_id', type: 'ARGSETID', description: 'The id for a single set of arguments' },
      { name: 'flat_key', type: 'STRING', description: 'The key without array indexes' },
      { name: 'key', type: 'STRING', description: 'The key for the arg' },
      { name: 'int_value', type: 'LONG', description: 'The integer value', nullable: true },
      { name: 'string_value', type: 'STRING', description: 'The string value', nullable: true },
      { name: 'real_value', type: 'DOUBLE', description: 'The double value', nullable: true },
      { name: 'value_type', type: 'STRING', description: 'Type: int, uint, string, real, pointer, bool, json' },
      { name: 'display_value', type: 'STRING', description: 'Human-readable formatted value' },
    ],
  },

  track: {
    name: 'track',
    description: 'Track metadata for organizing slices/counters',
    columns: [
      { name: 'id', type: 'ID', description: 'Track id' },
      { name: 'name', type: 'STRING', description: 'Track name' },
      { name: 'type', type: 'STRING', description: 'Track type' },
      { name: 'parent_id', type: 'ID', description: 'Parent track id', nullable: true },
    ],
  },

  instant: {
    name: 'instant',
    description: 'Contains instant events from userspace (zero-duration events)',
    columns: [
      { name: 'ts', type: 'TIMESTAMP', description: 'The timestamp of the instant' },
      { name: 'track_id', type: 'JOINID(track.id)', description: 'Track this instant is on' },
      { name: 'name', type: 'STRING', description: 'The name of the instant', nullable: true },
      { name: 'arg_set_id', type: 'ARGSETID', description: 'Argument set id' },
    ],
    joins: ['track', 'thread', 'process'],
  },

  android_logs: {
    name: 'android_logs',
    description: 'Log entries from Android logcat',
    columns: [
      { name: 'id', type: 'ID', description: 'Which row in the table the log corresponds to' },
      { name: 'ts', type: 'TIMESTAMP', description: 'Timestamp of log entry' },
      { name: 'utid', type: 'JOINID(thread.id)', description: 'Thread writing the log entry' },
      { name: 'prio', type: 'LONG', description: 'Priority: 3=DEBUG, 4=INFO, 5=WARN, 6=ERROR' },
      { name: 'tag', type: 'STRING', description: 'Tag of the log entry' },
      { name: 'msg', type: 'STRING', description: 'Content of the log entry' },
    ],
    joins: ['thread'],
  },

  // Android-specific tables
  sched: {
    name: 'sched',
    description: 'CPU scheduling events from ftrace',
    columns: [
      { name: 'ts', type: 'TIMESTAMP', description: 'Timestamp' },
      { name: 'cpu', type: 'LONG', description: 'CPU number' },
      { name: 'utid', type: 'JOINID(thread.id)', description: 'Thread utid' },
      { name: 'prev_state', type: 'STRING', description: 'Previous state (R, S, D, etc.)' },
      { name: 'scheduling_latency', type: 'DURATION', description: 'Time from runnable to running' },
    ],
    joins: ['thread'],
  },

  thread_state: {
    name: 'thread_state',
    description: 'Thread scheduling states with durations',
    columns: [
      { name: 'ts', type: 'TIMESTAMP', description: 'State start timestamp' },
      { name: 'dur', type: 'DURATION', description: 'State duration' },
      { name: 'utid', type: 'JOINID(thread.id)', description: 'Thread utid' },
      { name: 'state', type: 'STRING', description: 'State: Running, Runnable, Sleeping, etc.' },
      { name: 'cpu', type: 'LONG', description: 'CPU (if running)', nullable: true },
      { name: 'io_wait', type: 'STRING', description: 'IO wait reason', nullable: true },
    ],
    joins: ['thread'],
  },

  android_startups: {
    name: 'android_startups',
    description: 'App launch events (cold/warm/hot)',
    columns: [
      { name: 'startup_id', type: 'INT', description: 'Startup id' },
      { name: 'ts', type: 'TIMESTAMP', description: 'Start timestamp' },
      { name: 'ts_end', type: 'TIMESTAMP', description: 'End timestamp' },
      { name: 'dur', type: 'DURATION', description: 'Duration' },
      { name: 'package', type: 'STRING', description: 'Package name' },
      { name: 'startup_type', type: 'STRING', description: 'Startup type: cold, warm, hot' },
    ],
    joins: ['process', 'thread'],
  },
};

// ============================================================================
// Builtin Function Catalog (from builtin.md)
// ============================================================================

export interface FunctionSignature {
  name: string;
  returnType: string;
  params: Array<{ name: string; type: string; optional?: boolean }>;
  description: string;
  category: string;
}

/**
 * Official Perfetto builtin functions
 * Source: perfetto/docs/analysis/builtin.md
 */
export const BUILTIN_FUNCTIONS: Record<string, FunctionSignature> = {
  // Arg extraction functions
  EXTRACT_ARG: {
    name: 'EXTRACT_ARG',
    returnType: 'VARIOUS',
    params: [{ name: 'arg_set_id', type: 'ARGSETID' }, { name: 'key', type: 'STRING' }],
    description: 'Extract the value for the given key from the arg set',
    category: 'args',
  },

  EXTRACT_UID: {
    name: 'EXTRACT_UID',
    returnType: 'INT',
    params: [{ name: 'arg_set_id', type: 'ARGSETID' }],
    description: 'Extract the uid from the arg set',
    category: 'args',
  },

  // String functions
  STR_SPLIT: {
    name: 'STR_SPLIT',
    returnType: 'STRING',
    params: [
      { name: 'input', type: 'STRING' },
      { name: 'delimiter', type: 'STRING' },
      { name: 'index', type: 'INT' },
    ],
    description: 'Split string by delimiter and return the Nth part (1-indexed)',
    category: 'string',
  },

  SUBSTR: {
    name: 'SUBSTR',
    returnType: 'STRING',
    params: [
      { name: 'input', type: 'STRING' },
      { name: 'start', type: 'INT' },
      { name: 'length', type: 'INT', optional: true },
    ],
    description: 'Return substring starting at start position (1-indexed)',
    category: 'string',
  },

  // Type casting functions
  CAST_INT: {
    name: 'CAST_INT!',
    returnType: 'INT',
    params: [{ name: 'value', type: 'VARIOUS' }],
    description: 'Cast value to INT (throws if fails)',
    category: 'cast',
  },

  CAST_UINT: {
    name: 'CAST_UINT!',
    returnType: 'UINT',
    params: [{ name: 'value', type: 'VARIOUS' }],
    description: 'Cast value to UINT (throws if fails)',
    category: 'cast',
  },

  CAST_STRING: {
    name: 'CAST_STRING!',
    returnType: 'STRING',
    params: [{ name: 'value', type: 'VARIOUS' }],
    description: 'Cast value to STRING (throws if fails)',
    category: 'cast',
  },

  // Aggregate functions
  AVG: {
    name: 'AVG',
    returnType: 'DOUBLE',
    params: [{ name: 'expr', type: 'NUMBER' }],
    description: 'Average of non-null values',
    category: 'aggregate',
  },

  SUM: {
    name: 'SUM',
    returnType: 'NUMBER',
    params: [{ name: 'expr', type: 'NUMBER' }],
    description: 'Sum of non-null values',
    category: 'aggregate',
  },

  COUNT: {
    name: 'COUNT',
    returnType: 'INT',
    params: [{ name: 'expr', type: 'VARIOUS' }],
    description: 'Count of non-null values',
    category: 'aggregate',
  },

  MAX: {
    name: 'MAX',
    returnType: 'VARIOUS',
    params: [{ name: 'expr', type: 'VARIOUS' }],
    description: 'Maximum value',
    category: 'aggregate',
  },

  MIN: {
    name: 'MIN',
    returnType: 'VARIOUS',
    params: [{ name: 'expr', type: 'VARIOUS' }],
    description: 'Minimum value',
    category: 'aggregate',
  },

  // Window functions
  LEAD: {
    name: 'LEAD',
    returnType: 'VARIOUS',
    params: [
      { name: 'expr', type: 'VARIOUS' },
      { name: 'offset', type: 'INT', optional: true },
      { name: 'default', type: 'VARIOUS', optional: true },
    ],
    description: 'Return value from next row',
    category: 'window',
  },

  LAG: {
    name: 'LAG',
    returnType: 'VARIOUS',
    params: [
      { name: 'expr', type: 'VARIOUS' },
      { name: 'offset', type: 'INT', optional: true },
      { name: 'default', type: 'VARIOUS', optional: true },
    ],
    description: 'Return value from previous row',
    category: 'window',
  },

  ROW_NUMBER: {
    name: 'ROW_NUMBER',
    returnType: 'INT',
    params: [],
    description: 'Row number within partition',
    category: 'window',
  },

  // Conditional functions
  IIF: {
    name: 'IIF',
    returnType: 'VARIOUS',
    params: [
      { name: 'condition', type: 'BOOL' },
      { name: 'true_value', type: 'VARIOUS' },
      { name: 'false_value', type: 'VARIOUS' },
    ],
    description: 'Return true_value if condition true, else false_value',
    category: 'conditional',
  },

  // Math functions
  ABS: {
    name: 'ABS',
    returnType: 'NUMBER',
    params: [{ name: 'value', type: 'NUMBER' }],
    description: 'Absolute value',
    category: 'math',
  },

  ROUND: {
    name: 'ROUND',
    returnType: 'NUMBER',
    params: [{ name: 'value', type: 'NUMBER' }, { name: 'precision', type: 'INT', optional: true }],
    description: 'Round to precision (default 0)',
    category: 'math',
  },

  // Hierarchical functions (for slices)
  ANCESTOR_SLICE: {
    name: 'ANCESTOR_SLICE',
    returnType: 'SLICE',
    params: [{ name: 'slice_id', type: 'ID' }],
    description: 'Return ancestor slice',
    category: 'hierarchy',
  },
};

// ============================================================================
// GLOB Patterns for Common Slice Names (from official metrics)
// ============================================================================

export interface GlobPattern {
  pattern: string;
  description: string;
  category: string;
}

/**
 * Common GLOB patterns used in Perfetto metrics
 * Source: perfetto/src/trace_processor/metrics/sql/android/
 */
export const GLOB_PATTERNS: Record<string, GlobPattern[]> = {
  startup: [
    { pattern: 'launchingActivity#*:*', description: 'Activity launch events', category: 'startup' },
    { pattern: 'launchingActivity#*:completed-*:*', description: 'Activity completion events', category: 'startup' },
    { pattern: 'Start proc: *', description: 'Process start events', category: 'startup' },
    { pattern: 'reportFullyDrawn*', description: 'Fully drawn events', category: 'startup' },
    { pattern: 'performResume:*', description: 'Activity resume events', category: 'startup' },
    { pattern: 'performCreate:*', description: 'Activity create events', category: 'startup' },
  ],

  binder: [
    { pattern: '*BinderTransaction*', description: 'Binder transaction events', category: 'binder' },
    { pattern: 'Transact: *', description: 'Transaction events', category: 'binder' },
    { pattern: '* oneway *', description: 'One-way transactions', category: 'binder' },
  ],

  scrolling: [
    { pattern: '*Scroll*', description: 'Scroll events', category: 'scrolling' },
    { pattern: '*fling*', description: 'Fling events', category: 'scrolling' },
    { pattern: 'FrameTimeline*', description: 'Frame timeline events', category: 'scrolling' },
  ],

  surfaceflinger: [
    { pattern: 'Trace GPU completion fence *', description: 'GPU fence start', category: 'surfaceflinger' },
    { pattern: 'waiting for GPU completion *', description: 'GPU fence wait', category: 'surfaceflinger' },
    { pattern: 'presentFence*', description: 'Present fence events', category: 'surfaceflinger' },
    { pattern: '*composition*', description: 'Composition events', category: 'surfaceflinger' },
  ],

  memory: [
    { pattern: '*GC*', description: 'Garbage collection events', category: 'memory' },
    { pattern: '*Allocation*', description: 'Allocation events', category: 'memory' },
    { pattern: '*lmk*', description: 'Low memory killer events', category: 'memory' },
  ],

  input: [
    { pattern: '*Input*', description: 'Input events', category: 'input' },
    { pattern: '*Touch*', description: 'Touch events', category: 'input' },
    { pattern: '*Key*', description: 'Key events', category: 'input' },
  ],

  monitor: [
    { pattern: 'Lock contention *', description: 'Lock contention events', category: 'monitor' },
    { pattern: '*Monitor Contention*', description: 'Monitor contention', category: 'monitor' },
  ],
};

// ============================================================================
// SQL Template Library (from official metrics)
// ============================================================================

export interface SqlTemplate {
  name: string;
  description: string;
  category: string;
  sql: string;
  params: Array<{ name: string; description: string; type: string }>;
}

/**
 * SQL templates for common analysis patterns
 * These are distilled from official Perfetto metrics
 */
export const SQL_TEMPLATES: Record<string, SqlTemplate> = {
  // Startup templates
  startup_summary: {
    name: 'startup_summary',
    description: 'Get all app startups with timing information',
    category: 'startup',
    sql: `
      SELECT
        startup_id,
        ts,
        dur,
        package,
        startup_type
      FROM android_startups
      {{WHERE}}
      ORDER BY ts DESC
      LIMIT {{limit}}
    `,
    params: [
      { name: 'WHERE', description: 'WHERE clause filter', type: 'string' },
      { name: 'limit', description: 'Max rows to return', type: 'number' },
    ],
  },

  startup_by_package: {
    name: 'startup_by_package',
    description: 'Get startup stats for a specific package',
    category: 'startup',
    sql: `
      SELECT
        startup_type,
        AVG(dur) / 1e6 as avg_dur_ms,
        COUNT(*) as count,
        MIN(dur) / 1e6 as min_dur_ms,
        MAX(dur) / 1e6 as max_dur_ms
      FROM android_startups
      WHERE package GLOB '{{package}}*'
      GROUP BY startup_type
    `,
    params: [
      { name: 'package', description: 'Package name pattern', type: 'string' },
    ],
  },

  // Slice analysis templates
  slices_by_name: {
    name: 'slices_by_name',
    description: 'Find slices matching a name pattern',
    category: 'slice',
    sql: `
      SELECT
        s.id,
        s.ts,
        s.dur / 1e6 as dur_ms,
        s.name,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '{{pattern}}'
      {{AND_EXTRA}}
      ORDER BY s.dur DESC
      LIMIT {{limit}}
    `,
    params: [
      { name: 'pattern', description: 'GLOB pattern for slice name', type: 'string' },
      { name: 'AND_EXTRA', description: 'Additional AND conditions', type: 'string' },
      { name: 'limit', description: 'Max rows', type: 'number' },
    ],
  },

  long_slices: {
    name: 'long_slices',
    description: 'Find longest slices for a process',
    category: 'slice',
    sql: `
      SELECT
        s.name,
        s.dur / 1e6 as dur_ms,
        s.depth,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name GLOB '{{process_pattern}}'
        AND s.dur > {{min_dur_ns}}
      ORDER BY s.dur DESC
      LIMIT {{limit}}
    `,
    params: [
      { name: 'process_pattern', description: 'Process name GLOB pattern', type: 'string' },
      { name: 'min_dur_ns', description: 'Minimum duration in ns', type: 'number' },
      { name: 'limit', description: 'Max rows', type: 'number' },
    ],
  },

  // Thread state templates
  thread_state_summary: {
    name: 'thread_state_summary',
    description: 'Summarize thread states for a process',
    category: 'thread_state',
    sql: `
      SELECT
        ts.state,
        SUM(ts.dur) / 1e6 as total_dur_ms,
        COUNT(*) as count
      FROM thread_state ts
      JOIN thread t ON ts.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name GLOB '{{process_pattern}}'
        {{AND_EXTRA}}
      GROUP BY ts.state
      ORDER BY total_dur_ms DESC
    `,
    params: [
      { name: 'process_pattern', description: 'Process name pattern', type: 'string' },
      { name: 'AND_EXTRA', description: 'Additional conditions', type: 'string' },
    ],
  },

  // Binder templates
  binder_summary: {
    name: 'binder_summary',
    description: 'Summarize binder transactions for a process',
    category: 'binder',
    sql: `
      SELECT
        s.name,
        COUNT(*) as count,
        AVG(s.dur) / 1e6 as avg_dur_ms,
        SUM(s.dur) / 1e6 as total_dur_ms
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE p.name GLOB '{{process_pattern}}'
        AND s.name GLOB '*Binder*'
      GROUP BY s.name
      ORDER BY count DESC
    `,
    params: [
      { name: 'process_pattern', description: 'Process name pattern', type: 'string' },
    ],
  },

  // SurfaceFlinger templates
  surfaceflinger_frames: {
    name: 'surfaceflinger_frames',
    description: 'Analyze SurfaceFlinger frame timing',
    category: 'surfaceflinger',
    sql: `
      SELECT
        COUNT(*) as total_frames,
        SUM(CAST(dur > 16666666 AS INT)) as missed_frames,
        AVG(dur) / 1e6 as avg_frame_dur_ms
      FROM slice s
      JOIN track tr ON s.track_id = tr.id
      WHERE tr.name GLOB '*Display*'
        {{AND_EXTRA}}
    `,
    params: [
      { name: 'AND_EXTRA', description: 'Additional conditions', type: 'string' },
    ],
  },

  // Memory templates
  gc_events: {
    name: 'gc_events',
    description: 'Find garbage collection events',
    category: 'memory',
    sql: `
      SELECT
        s.name,
        s.ts,
        s.dur / 1e6 as dur_ms,
        t.name as thread_name,
        p.name as process_name
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process p ON t.upid = p.upid
      WHERE s.name GLOB '*GC*'
        {{AND_EXTRA}}
      ORDER BY s.ts
    `,
    params: [
      { name: 'AND_EXTRA', description: 'Additional conditions', type: 'string' },
    ],
  },
};

// ============================================================================
// Knowledge Base Class
// ============================================================================

export class SqlKnowledgeBase {
  private perfettoPath: string;

  constructor(perfettoPath: string) {
    this.perfettoPath = perfettoPath;
  }

  /**
   * Get table schema by name
   */
  getTableSchema(tableName: string): TableSchema | undefined {
    return TABLE_SCHEMAS[tableName];
  }

  /**
   * Get all table names
   */
  getTableNames(): string[] {
    return Object.keys(TABLE_SCHEMAS);
  }

  /**
   * Get function signature by name
   */
  getFunction(functionName: string): FunctionSignature | undefined {
    return BUILTIN_FUNCTIONS[functionName];
  }

  /**
   * Get all functions
   */
  getFunctions(): FunctionSignature[] {
    return Object.values(BUILTIN_FUNCTIONS);
  }

  /**
   * Get functions by category
   */
  getFunctionsByCategory(category: string): FunctionSignature[] {
    return Object.values(BUILTIN_FUNCTIONS).filter((f) => f.category === category);
  }

  /**
   * Get GLOB patterns by category
   */
  getGlobPatterns(category: string): GlobPattern[] {
    return GLOB_PATTERNS[category] || [];
  }

  /**
   * Get SQL template by name
   */
  getTemplate(templateName: string): SqlTemplate | undefined {
    return SQL_TEMPLATES[templateName];
  }

  /**
   * Get templates by category
   */
  getTemplatesByCategory(category: string): SqlTemplate[] {
    return Object.values(SQL_TEMPLATES).filter((t) => t.category === category);
  }

  /**
   * Validate column exists in table
   */
  validateColumn(tableName: string, columnName: string): boolean {
    const table = TABLE_SCHEMAS[tableName];
    if (!table) return false;
    return table.columns.some((c) => c.name === columnName);
  }

  /**
   * Suggest joins for a table
   */
  suggestJoins(tableName: string): string[] {
    const table = TABLE_SCHEMAS[tableName];
    return table?.joins || [];
  }

  /**
   * Load and parse a Perfetto SQL file from the local project
   */
  async parseLocalSqlFile(relativePath: string): Promise<string> {
    const fullPath = path.join(this.perfettoPath, relativePath);
    try {
      return await fs.promises.readFile(fullPath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read SQL file: ${fullPath}`);
    }
  }

  /**
   * Get standard library modules list
   */
  listStdlibModules(): string[] {
    const categories = [
      'android/startup',
      'android/surfaceflinger',
      'android/memory',
      'linux/cpu',
      'linux/memory',
      'slices',
      'sched',
      'counters',
      'intervals',
      'graphs',
    ];
    return categories;
  }
}

// Default instance (uses local Perfetto project path)
const DEFAULT_PERFETTO_PATH = '/Users/chris/Code/SmartPerfetto/SmartPerfetto/perfetto';

export function createKnowledgeBase(perfettoPath = DEFAULT_PERFETTO_PATH): SqlKnowledgeBase {
  return new SqlKnowledgeBase(perfettoPath);
}

export default SqlKnowledgeBase;
