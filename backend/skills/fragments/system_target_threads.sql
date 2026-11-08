-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)
-- This file is part of SmartPerfetto. See LICENSE for details.

-- Input: system_windows(window_id, window_start_ts, window_end_ts). Requires
-- fragments/effective_target_processes.sql. Parameters: package (the process
-- name or its name:* subprocesses, '' for any), utid (one thread, else NULL).
-- An exact process scope binds the UPID and ignores package.
--   system_target_processes  window x target process (upid, pid, name)
--   system_target_threads    window x target thread; role is main for the
--                            thread whose tid is the process pid, else target
system_target_processes AS (
  SELECT w.window_id, p.upid, p.pid, p.name
  FROM system_windows w CROSS JOIN effective_target_processes p
  WHERE ${__process_scope.upid} IS NOT NULL OR '${package}' = ''
    OR p.name = '${package}' OR p.name GLOB '${package}:*'
),
system_target_threads AS (
  SELECT tp.window_id, tp.upid, t.utid,
    CASE WHEN t.tid = tp.pid THEN 'main' ELSE 'target' END AS role
  FROM system_target_processes tp
  JOIN thread t ON t.upid = tp.upid
  WHERE ${utid} IS NULL OR t.utid = ${utid}
)
