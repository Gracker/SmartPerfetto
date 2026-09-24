-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Dumps a Skill reports per-dump rows for, chosen by dump_selector: latest
-- (last dump of each process, the default), first, or all. Unknown values
-- fall back to latest; heap_graph_dump_selector exposes the applied value.
-- Requires fragments/heap_target_process.sql and
-- fragments/heap_graph_dump_scope.sql before it.
heap_graph_dump_selector AS (
  SELECT
    CASE lower(trim('${dump_selector|latest}'))
      WHEN 'first' THEN 'first'
      WHEN 'all' THEN 'all'
      ELSE 'latest'
    END AS dump_selector
),
heap_graph_indexed_dumps AS (
  SELECT
    d.*,
    ROW_NUMBER() OVER (PARTITION BY d.upid ORDER BY d.graph_sample_ts) AS dump_index,
    ROW_NUMBER() OVER (PARTITION BY d.upid ORDER BY d.graph_sample_ts DESC) AS reverse_index
  FROM heap_graph_dump_scope AS d
),
heap_graph_selected_dumps AS (
  SELECT
    d.*,
    CASE s.dump_selector
      WHEN 'all' THEN 1
      WHEN 'first' THEN d.dump_index = 1
      ELSE d.reverse_index = 1
    END AS selected_for_ranking
  FROM heap_graph_indexed_dumps AS d
  CROSS JOIN heap_graph_dump_selector AS s
)
