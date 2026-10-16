-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: fragments/art_gc_names.sql, listed before this fragment; the step
-- parameters package, start_ts and end_ts. The GC slices of the target
-- process(es) that start in the range, one row per slice: runs and waits,
-- told apart by gc_kind. gc_type is the cause ART names a run by (Explicit,
-- Alloc), Young for another young-generation run, Background for another
-- background run, or Wait for a thread blocked on the collector.
memory_gc_events AS (
  SELECT
    *,
    CASE
      WHEN gc_kind = 'wait' THEN 'Wait'
      WHEN gc_name GLOB '*Explicit*' THEN 'Explicit'
      WHEN gc_name GLOB 'Alloc*' OR gc_name GLOB 'NativeAlloc*' THEN 'Alloc'
      WHEN gc_name GLOB '*young*' THEN 'Young'
      WHEN gc_name GLOB 'Background*' THEN 'Background'
      ELSE 'Other'
    END AS gc_type
  FROM (
    SELECT
      s.id AS gc_id,
      s.ts,
      s.dur,
      s.name AS gc_name,
      (
        SELECT n.gc_kind FROM art_gc_slice_name_patterns n
        WHERE s.name GLOB n.pattern
        ORDER BY n.gc_kind
        LIMIT 1
      ) AS gc_kind,
      t.name AS thread_name,
      t.tid,
      p.pid,
      p.upid,
      CASE WHEN t.tid = p.pid THEN 1 ELSE 0 END AS is_main_thread
    FROM slice s
    JOIN thread_track tt ON s.track_id = tt.id
    JOIN thread t ON tt.utid = t.utid
    JOIN process p ON t.upid = p.upid
    WHERE s.name GLOB '*GC*'
      AND ('${package}' = '' OR p.name = '${package}' OR p.name GLOB '${package}:*')
      AND (${start_ts} IS NULL OR s.ts >= ${start_ts})
      AND (${end_ts} IS NULL OR s.ts < ${end_ts})
  )
  WHERE gc_kind IS NOT NULL
)
