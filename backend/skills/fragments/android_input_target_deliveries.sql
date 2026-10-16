-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The scoped input deliveries a caller analyzes, under its process scope.
-- Under an exact process scope: only that UPID's deliveries, analyzed per upid
-- (analyzed_for_upid), so a same-named instance neither joins nor empties it.
-- Otherwise: every delivery, analyzed per process name (analyzed_for_name),
-- for a caller that then names its target process.
-- Requires fragments/android_input_scoped_deliveries.sql listed before it.
android_input_target_deliveries AS NOT MATERIALIZED (
  SELECT d.*,
    CASE WHEN ${__process_scope.upid} IS NULL THEN d.analyzed_for_name ELSE d.analyzed_for_upid END AS analyzed
  FROM android_input_scoped_deliveries AS d
  WHERE ${__process_scope.upid} IS NULL OR d.upid = ${__process_scope.upid}
)
