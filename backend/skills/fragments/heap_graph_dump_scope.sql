-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Heap graph dumps in scope, one row per (upid, graph_sample_ts). Requires
-- fragments/heap_target_process.sql before it (process rule lives there).
-- An incomplete dump (packet loss, non-finalized graph) keeps forward
-- references as placeholder objects with self_size = -1, typed with class id
-- 0; they are counted here per scoped dump and never read as real objects.
-- dump_issues lists heap_graph/hprof error or data-loss stats for the process
-- (or global ones); either signal marks the dump incomplete, so its sizes and
-- counts are lower bounds.
heap_graph_dump_scope AS MATERIALIZED (
  SELECT
    d.*,
    CASE
      WHEN d.placeholder_object_count > 0 OR d.dump_issues IS NOT NULL THEN 'incomplete_dump'
      ELSE 'no_incompleteness_signal'
    END AS dump_completeness
  FROM (
    SELECT
      h.upid,
      h.ts AS graph_sample_ts,
      t.process_name,
      t.process_identity,
      COALESCE(ph.placeholder_object_count, 0) AS placeholder_object_count,
      (
        SELECT GROUP_CONCAT(s.name || '=' || s.value, ', ')
        FROM stats AS s
        WHERE (s.name GLOB 'heap_graph*' OR s.name GLOB 'hprof*')
          AND s.severity IN ('error', 'data_loss')
          AND s.value > 0
          AND (s.idx = h.upid OR s.idx IS NULL)
      ) AS dump_issues
    FROM heap_graph AS h
    JOIN heap_target_process AS t USING (upid)
    -- One pass over the object table for every dump, not one per dump.
    LEFT JOIN (
      SELECT upid, graph_sample_ts, COUNT(*) AS placeholder_object_count
      FROM heap_graph_object
      WHERE self_size = -1
      GROUP BY upid, graph_sample_ts
    ) AS ph
      ON ph.upid = h.upid
      AND ph.graph_sample_ts = h.ts
    WHERE ${graph_sample_ts} IS NULL OR h.ts = ${graph_sample_ts}
  ) AS d
),
-- The only read path for heap objects: real objects of scoped dumps, so no
-- sum or count can include a placeholder.
heap_graph_scoped_objects AS (
  SELECT o.*
  FROM heap_graph_object AS o
  JOIN heap_graph_dump_scope AS d
    ON d.upid = o.upid
    AND d.graph_sample_ts = o.graph_sample_ts
  WHERE o.self_size >= 0
)
