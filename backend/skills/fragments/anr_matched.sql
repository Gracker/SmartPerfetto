-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2024-2026 Gracker (Chris)

-- No input CTE; the step parameters process_name, package and anr_type (each
-- '' for any). The ANRs of android_anrs that match them, every column kept,
-- plus the window an analysis looks back over:
--   analysis_timeout_ms  the ANR's own duration, else Perfetto's default for
--                        its type, else the platform timeout of the type
--   timeout_source       actual_anr_duration | perfetto_default |
--                        heuristic_fallback, saying which one it is
anr_matched AS (
  SELECT
    *,
    COALESCE(
      NULLIF(anr_dur_ms, 0),
      default_anr_dur_ms,
      CASE
        WHEN anr_type IN ('INPUT_DISPATCHING_TIMEOUT', 'INPUT_DISPATCHING_TIMEOUT_NO_FOCUSED_WINDOW') THEN 5000
        WHEN anr_type = 'BROADCAST_OF_INTENT' THEN 10000
        WHEN anr_type = 'EXECUTING_SERVICE' THEN 20000
        WHEN anr_type IN ('START_FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_TIMEOUT') THEN 30000
        WHEN anr_type = 'FOREGROUND_SHORT_SERVICE_TIMEOUT' THEN 180000
        WHEN anr_type IN ('JOB_SERVICE_START', 'JOB_SERVICE_STOP', 'JOB_SERVICE_BIND', 'JOB_SERVICE_NOTIFICATION_NOT_PROVIDED') THEN 8000
        WHEN anr_type = 'BIND_APPLICATION' THEN 15000
        -- Perfetto's default is NULL for the remaining types: an explicit
        -- low-confidence lookback so downstream SQL still has bounds.
        ELSE 5000
      END
    ) AS analysis_timeout_ms,
    CASE
      WHEN NULLIF(anr_dur_ms, 0) IS NOT NULL THEN 'actual_anr_duration'
      WHEN default_anr_dur_ms IS NOT NULL THEN 'perfetto_default'
      ELSE 'heuristic_fallback'
    END AS timeout_source
  FROM android_anrs
  WHERE (
      ('${process_name}' <> '' AND (process_name = '${process_name}' OR process_name GLOB '${process_name}:*'))
      OR ('${package}' <> '' AND (process_name = '${package}' OR process_name GLOB '${package}:*'))
      OR ('${process_name}' = '' AND '${package}' = '')
    )
    AND (anr_type = '${anr_type}' OR '${anr_type}' = '')
)
