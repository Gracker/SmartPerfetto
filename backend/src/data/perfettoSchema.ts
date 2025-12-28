export const PERFETTO_TABLES_SCHEMA = `
# Perfetto SQL Schema Reference

## Core Tables Structure

### slice
- id: INTEGER (Primary key)
- type: STRING (slice type)
- ts: INTEGER (Start timestamp in nanoseconds)
- dur: INTEGER (Duration in nanoseconds)
- track_id: INTEGER (Foreign key to track table)
- category: STRING (Category name)
- name: STRING (Slice name)
- depth: INTEGER (Slice depth for nesting)
- parent_stack_id: INTEGER (Parent stack ID)
- arg_set_id: INTEGER (Argument set ID)

### thread
- utid: INTEGER (Unique thread ID)
- tid: INTEGER (Thread ID)
- pid: INTEGER (Process ID)
- name: STRING (Thread name)
- is_main_thread: BOOLEAN (True if main thread)
- start_ts: INTEGER (Start timestamp)
- end_ts: INTEGER (End timestamp)
- upid: INTEGER (Foreign key to process table)

### process
- upid: INTEGER (Unique process ID)
- pid: INTEGER (Process ID)
- name: STRING (Process name)
- cmdline: STRING (Command line)
- uid: INTEGER (User ID)
- pkg_name: STRING (Package name for Android)
- start_ts: INTEGER (Start timestamp)
- end_ts: INTEGER (End timestamp)

### track
- id: INTEGER (Track ID)
- name: STRING (Track name)
- type: STRING (Track type: 'track', 'thread_track', 'process_track', 'gpu_track')
- parent_id: INTEGER (Parent track ID)
- machine_id: INTEGER (Machine ID for remote tracks)

### thread_track
- id: INTEGER (Track ID)
- type: STRING (Always 'thread_track')
- utid: INTEGER (Thread ID)
- name: STRING (Track name)

### process_track
- id: INTEGER (Track ID)
- type: STRING (Always 'process_track')
- upid: INTEGER (Process ID)
- name: STRING (Track name)

### sched
- ts: INTEGER (Timestamp in nanoseconds)
- cpu: INTEGER (CPU number)
- prev_state: INTEGER (Previous task state)
- next_state: INTEGER (Next task state)
- prev_comm: STRING (Previous command name)
- next_comm: STRING (Next command name)
- prev_pid: INTEGER (Previous process ID)
- next_pid: INTEGER (Next process ID)
- utid: INTEGER (Thread ID)
- priority: INTEGER (Scheduling priority)
- io_wait: BOOLEAN (True if waiting for IO)

### counter
- id: INTEGER (Counter ID)
- type: STRING (Counter type)
- ts: INTEGER (Timestamp in nanoseconds)
- value: DOUBLE (Counter value)
- track_id: INTEGER (Track ID reference)
- arg_set_id: INTEGER (Argument set ID)

### ftrace_event
- ts: INTEGER (Timestamp in nanoseconds)
- cpu: INTEGER (CPU number)
- pid: INTEGER (Process ID)
- tid: INTEGER (Thread ID)
- pstate: INTEGER (Process state)
- prio: INTEGER (Priority)
- syscall: STRING (System call name)
- args: STRING (Event arguments as JSON)

### android_log
- ts: INTEGER (Timestamp in nanoseconds)
- prio: INTEGER (Log priority)
- uid: INTEGER (User ID)
- pid: INTEGER (Process ID)
- tid: INTEGER (Thread ID)
- tag: STRING (Log tag)
- msg: STRING (Log message)

### heap_graph_object
- id: INTEGER (Object ID)
- graph_id: INTEGER (Graph ID)
- type_name: STRING (Object type)
- size: INTEGER (Object size in bytes)
- root_type: INTEGER (Root type)
- object_location: INTEGER (Object location)

### heap_profile
- ts: INTEGER (Timestamp in nanoseconds)
- graph_id: INTEGER (Graph ID)
- callsite_id: INTEGER (Call site ID)
- self_allocated: INTEGER (Self allocated bytes)
- self_freed: INTEGER (Self freed bytes)
- alloc_count: INTEGER (Allocation count)
- free_count: INTEGER (Free count)

### slice_long_args (VIEW)
- id: INTEGER (Slice ID)
- type: STRING (Slice type)
- ts: INTEGER (Start timestamp)
- dur: INTEGER (Duration)
- track_id: INTEGER (Track ID)
- category: STRING (Category)
- name: STRING (Name)
- depth: INTEGER (Depth)
- parent_stack_id: INTEGER (Parent stack ID)
- arg_set_id: INTEGER (Argument set ID)
- flattened_args: STRING (Flattened arguments as JSON)

### flow
- id: INTEGER (Flow ID)
- type: STRING (Flow type: 'slice', 'instant', 'counter')
- ts: INTEGER (Start timestamp)
- dur: INTEGER (Duration)
- track_id: INTEGER (Track ID)
- category: STRING (Category)
- name: STRING (Name)
- flow_id: INTEGER (Flow identifier)
- depth: INTEGER (Depth)

## Common Perfetto SQL Functions

### Window Functions
- window_tableau() - Creates sliding windows
- lag() - Gets value from previous row
- lead() - Gets value from next row
- first_value() - Gets first value in window
- last_value() - Gets last value in window

### Aggregate Functions
- COUNT(), SUM(), AVG(), MIN(), MAX()
- SPAN(first_ts, last_ts) - Calculates time span
- DURATION(dur) - Formats duration as human readable

### Scalar Functions
- EXTRACT(arg_name FROM arg_set_id) - Extracts argument values
- atoi(str) - String to integer
- printf(format, ...) - Formatted output
- CAST(expression AS type) - Type conversion

### Table Functions
- CPU_SLICE_FOR_THREAD_THREAD_TIME(utid) - CPU slices for thread
- TABLE_NAME_WITH_FILTER(condition) - Filtered table view

## Important Notes

1. **All timestamps are in nanoseconds**
2. **JOIN conditions must use explicit foreign key relationships**
3. **Use TABLE_WITH_FILTER() instead of WHERE clause for better performance**
4. **Thread tracks use thread_track table, not track table directly**
5. **For Android-specific data, prefix tables with android_ (e.g., android_logs)**
6. **Use id-based joins, not name-based joins**
7. **Slice durations are in nanoseconds, convert to ms for display: dur / 1e6**

## Common Query Patterns

### Main Thread Analysis
\`\`\`sql
SELECT slice.*
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE thread.is_main_thread = 1
  AND process.name = 'com.example.app'
\`\`\`

### Frame Rate Analysis
\`\`\`sql
SELECT
  ts,
  dur / 1e6 AS dur_ms,
  LEAD(ts) OVER (ORDER BY ts) - ts AS frame_interval
FROM slice
WHERE name LIKE 'Choreographer#doFrame%'
  AND track_id = (
    SELECT id FROM thread_track
    WHERE utid = (SELECT utid FROM thread WHERE name = 'main' LIMIT 1)
  )
\`\`\`

### Memory Usage
\`\`\`sql
SELECT
  graph_sample.ts / 1e9 AS time_s,
  SUM(heap_profile.size) / 1024 / 1024 AS size_mb
FROM heap_profile
JOIN heap_graph_object ON heap_profile.graph_object_id = heap_graph_object.id
WHERE heap_profile.object_type LIKE '%'
GROUP BY graph_sample.ts
ORDER BY time_s
\`\`\`
`;

export const PERFETTO_SQL_EXAMPLES = {
  jank: `
SELECT
  process.name AS process_name,
  thread.name AS thread_name,
  slice.name,
  slice.dur / 1e6 AS duration_ms,
  slice.ts / 1e9 AS start_time_s
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE thread.is_main_thread = 1
  AND slice.dur > 16666000  -- > 16.67ms (60fps)
  AND slice.category IN ('gfx', 'view')
ORDER BY slice.dur DESC
LIMIT 100;`,

  cpu_usage: `
SELECT
  process.name,
  SUM(dur) / 1e9 / (
    SELECT (MAX(ts) - MIN(ts)) / 1e9
    FROM sched
    WHERE cpu = 0
  ) * 100 AS cpu_percent
FROM sched
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE cpu = 0
GROUP BY process.name
HAVING cpu_percent > 0.1
ORDER BY cpu_percent DESC;`,

  memory_leaks: `
SELECT
  type_name,
  COUNT(*) AS count,
  SUM(size) / 1024 / 1024 AS total_mb
FROM heap_graph_object
WHERE type_name NOT IN ('<root>', 'com.android.art.Data', 'java.lang.Class')
GROUP BY type_name
HAVING count > 100
ORDER BY total_mb DESC;`,

  anr_detection: `
SELECT
  process.name AS app_name,
  thread.name AS thread_name,
  slice.ts / 1e9 AS start_time,
  slice.dur / 1e9 AS duration_s,
  slice.name AS blocked_operation
FROM slice
JOIN thread_track ON slice.track_id = thread_track.id
JOIN thread USING (utid)
JOIN process USING (upid)
WHERE slice.dur > 5e9  -- > 5 seconds
  AND process.name NOT LIKE 'com.android%'
  AND process.name NOT LIKE 'android%'
ORDER BY slice.dur DESC;`,

  binder_calls: `
SELECT
  EXTRACT(arg_name FROM arg_set_id) AS binder_call,
  COUNT(*) AS call_count,
  AVG(dur) / 1e6 AS avg_duration_ms
FROM slice
WHERE slice.name = 'binder transaction'
  AND slice.category = 'binder'
GROUP BY binder_call
HAVING call_count > 10
ORDER BY avg_duration_ms DESC;`
};