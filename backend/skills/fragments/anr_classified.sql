-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- Input: fragments/art_gc_names.sql and fragments/anr_matched.sql, listed
-- before this fragment. The matched ANRs, every column kept, plus:
--   trigger_type              the trigger family of anr_type
--   root_cause_pattern_hint   comma-separated candidate patterns named by the
--                             subject text ('' when none): a starting point for
--                             the investigation, never its conclusion
anr_classified AS (
  SELECT
    *,
    CASE
      WHEN anr_type = 'INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW' THEN 'no_focus_window'
      WHEN anr_type = 'INPUT_DISPATCHING_TIMEOUT' THEN 'input_dispatching_timeout'
      WHEN anr_type = 'BROADCAST_OF_INTENT' THEN 'broadcast_timeout'
      WHEN anr_type IN ('EXECUTING_SERVICE', 'START_FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_TIMEOUT', 'FOREGROUND_SHORT_SERVICE_TIMEOUT') THEN 'service_timeout'
      WHEN anr_type = 'CONTENT_PROVIDER_NOT_RESPONDING' THEN 'content_provider_timeout'
      WHEN anr_type IN ('JOB_SERVICE_START', 'JOB_SERVICE_STOP', 'JOB_SERVICE_BIND', 'JOB_SERVICE_NOTIFICATION_NOT_PROVIDED') THEN 'job_scheduler_timeout'
      WHEN anr_type = 'SYSTEM_SERVER_WATCHDOG_TIMEOUT' THEN 'system_watchdog_swt'
      WHEN anr_type = 'BIND_APPLICATION' THEN 'bind_application_timeout'
      WHEN anr_type = 'GPU_HANG' THEN 'gpu_hang'
      WHEN anr_type = 'APP_TRIGGERED' THEN 'app_triggered_anr'
      ELSE 'unknown'
    END AS trigger_type,
    TRIM(
      (CASE
        WHEN LOWER(COALESCE(subject, '')) GLOB '*deadlock*'
          OR LOWER(COALESCE(subject, '')) GLOB '*waiting to lock*'
          OR LOWER(COALESCE(subject, '')) GLOB '*monitor contention*'
          OR LOWER(COALESCE(subject, '')) GLOB '*futex*'
          THEN 'deadlock,' ELSE '' END) ||
      (CASE
        WHEN LOWER(COALESCE(subject, '')) GLOB '*oom*'
          OR LOWER(COALESCE(subject, '')) GLOB '*lmk*'
          OR LOWER(COALESCE(subject, '')) GLOB '*memory*'
          OR EXISTS (SELECT 1 FROM art_gc_text_patterns g WHERE LOWER(COALESCE(subject, '')) GLOB g.pattern)
          THEN 'memory_leak_oom_pressure,' ELSE '' END) ||
      (CASE
        WHEN LOWER(COALESCE(subject, '')) GLOB '*cpu*'
          OR LOWER(COALESCE(subject, '')) GLOB '*iowait*'
          OR LOWER(COALESCE(subject, '')) GLOB '*load*'
          OR LOWER(COALESCE(subject, '')) GLOB '*sched*'
          THEN 'high_load_anr,' ELSE '' END),
      ','
    ) AS root_cause_pattern_hint
  FROM anr_matched
)
