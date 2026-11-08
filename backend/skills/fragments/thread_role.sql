-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- No input CTE. One role per utid for EVERY thread in the trace, because a
-- waker usually sits outside the analyzed process: a role table scoped to one
-- package cannot name who did the waking.
--
-- Android thread comm is truncated to 15 characters (TASK_COMM_LEN - 1), so a
-- real capture carries `ReferenceQueueD`, `pool-10-thread-`, `RxCachedWorkerP`.
-- A rule that depends on the tail of the full name therefore matches nothing on
-- a device trace: `*ReferenceQueueDaemon*` never fires, and `pool-*-thread-*`
-- silently drops every pool numbered 10 and above.
--
-- Most rules are anchored prefix GLOBs for that reason. Six are deliberately
-- contains-GLOBs — `*Network*`, `*decode*`, `*Decode*`, `*Dispatcher*`,
-- `*Executor*` and `*Worker*` — because the word that names the role sits after
-- a library-specific prefix and still fits inside the truncated comm. They run
-- last within their role and after the earlier roles, so a prefix rule always
-- wins over them.
--
-- The role is a NAME-derived hint about what a thread is conventionally used
-- for. It is not evidence about what the thread did in this window, and it
-- never establishes on its own that a wait was network, image or IO work.
-- `main` is resolved from tid = pid and wins over every name rule; pid 0 is
-- excluded so swapper/idle does not read as somebody's main thread.
-- GLOB is case-sensitive and Android 12+ renames binder pool threads to
-- lowercase `binder:<pid>_<n>`: on the corpus traces 240 of 245 binder threads
-- are lowercase, so a `Binder:*`-only rule classifies almost all of them as
-- `other` and makes every binder wake read as an ordinary worker hand-off.
--
-- This is the only definition of the rules: the critical-path engine reads the
-- roles through fragments/segment_wake_sources.sql rather than a copy, and
-- backend/src/services/__tests__/threadRoleContract.test.ts executes the
-- fragment to pin each role.
--
-- `binder_named` is the binder thread-name rule on its own, independent of the
-- main-wins precedence: a native service whose main thread joined its binder
-- pool keeps role `main` and is still binder_named, so a binder-pool reader
-- uses this column rather than a second copy of the name rule.
thread_roles AS (
  SELECT t.utid, t.tid, t.name AS thread_name, t.upid,
    p.pid AS process_pid, p.name AS process_name, t.binder_named,
    CASE
      WHEN p.pid IS NOT NULL AND p.pid > 0 AND t.tid = p.pid THEN 'main'
      WHEN t.name GLOB 'RenderThread*' THEN 'render'
      WHEN t.name GLOB 'HeapTaskDaemon*'
        OR t.name GLOB 'FinalizerDaemon*'
        OR t.name GLOB 'ReferenceQueueD*' THEN 'gc'
      WHEN t.name GLOB 'Jit thread pool*'
        OR t.name GLOB 'Profile Saver*' THEN 'jit'
      WHEN t.binder_named THEN 'binder'
      WHEN t.name GLOB 'OkHttp*'
        OR t.name GLOB 'Okio*'
        OR t.name GLOB 'Cronet*'
        OR t.name GLOB 'ChromiumNet*'
        OR t.name GLOB 'NetworkThread*'
        OR t.name GLOB '*Network*' THEN 'network'
      WHEN t.name GLOB 'glide*'
        OR t.name GLOB 'Glide*'
        OR t.name GLOB 'Coil*'
        OR t.name GLOB 'Fresco*'
        OR t.name GLOB '*decode*'
        OR t.name GLOB '*Decode*' THEN 'image'
      WHEN t.name GLOB 'pool-*'
        OR t.name GLOB 'AsyncTask*'
        OR t.name GLOB 'arch_disk_io*'
        OR t.name GLOB 'RxCached*'
        OR t.name GLOB 'DefaultDispatcher*'
        OR t.name GLOB 'Dispatchers.Default*'
        OR t.name GLOB '*Dispatcher*'
        OR t.name GLOB '*Executor*'
        OR t.name GLOB '*Worker*' THEN 'worker'
      WHEN t.name GLOB '1.ui' THEN 'flutter_ui'
      WHEN t.name GLOB '1.raster' THEN 'flutter_raster'
      WHEN t.name GLOB 'CrRendererMain*' THEN 'webview'
      WHEN t.name GLOB 'Signal Catcher*' THEN 'system'
      ELSE 'other'
    END AS role
  FROM (
    SELECT thread.*,
      COALESCE(name GLOB 'Binder:*' OR name GLOB 'binder:*'
        OR name GLOB 'HwBinder:*' OR name GLOB 'hwbinder:*', 0) AS binder_named
    FROM thread
  ) t
  LEFT JOIN process p ON p.upid = t.upid
)
