-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- heapprofd allocations of scoped processes, per (upid, heap_name). Requires
-- fragments/heap_target_process.sql before it. Negative size/count rows are
-- frees: SUM(size) is unreleased bytes, SUM(MAX(size, 0)) is allocated bytes.
-- retention_measurable is the single definition of whether unreleased bytes
-- mean anything: libc.malloc records every free, other heaps only if frees
-- were observed, and com.android.art Java allocation profiles never record GC
-- frees (unreleased == allocated by construction), so they are churn only.
heap_profile_callsites AS MATERIALIZED (
  SELECT
    a.upid,
    a.heap_name,
    a.callsite_id,
    SUM(a.size) AS unreleased_bytes,
    SUM(MAX(a.size, 0)) AS alloc_bytes,
    SUM(a.count) AS unreleased_count,
    SUM(MAX(a.count, 0)) AS alloc_count,
    SUM(a.size < 0) AS free_records
  FROM heap_profile_allocation AS a
  JOIN heap_target_process USING (upid)
  GROUP BY a.upid, a.heap_name, a.callsite_id
),
heap_profiles AS (
  SELECT
    upid,
    heap_name,
    SUM(unreleased_bytes) AS unreleased_bytes,
    SUM(alloc_bytes) AS alloc_bytes,
    SUM(unreleased_count) AS unreleased_count,
    SUM(alloc_count) AS alloc_count,
    SUM(free_records) AS free_records,
    heap_name = 'libc.malloc'
      OR (heap_name != 'com.android.art' AND SUM(free_records) > 0) AS retention_measurable
  FROM heap_profile_callsites
  GROUP BY upid, heap_name
)
