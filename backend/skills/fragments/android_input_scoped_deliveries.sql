-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The input deliveries a caller analyzes inside its time window. A process
-- keeps its application rows (monitor_observation = 0) when it has any in the
-- window, and every row otherwise, so a process that owns both an app window
-- and a gesture monitor is measured by its window alone, while an explicitly
-- chosen process that only observes input still returns its observations.
-- Read the column that matches how the caller identifies its target:
--   analyzed_for_name - judged per process name, so an instance that only
--                       observed input does not rejoin a same-named instance
--                       that received the app deliveries.
--   analyzed_for_upid - judged per upid, so a caller pinned to one instance is
--                       never emptied by a same-named sibling.
-- Roles and monitor channels come from the whole relation (see
-- fragments/android_input_delivery_roles.sql); only this choice depends on the
-- window. Without action evidence anywhere in the trace no channel can be told
-- to be a monitor, so every row stays analyzed rather than guessing by name.
-- Requires fragments/android_input_delivery_roles.sql listed before it.
android_input_scoped_deliveries AS NOT MATERIALIZED (
  SELECT d.*,
    (d.monitor_observation = 0
      OR SUM(d.monitor_observation = 0) OVER (PARTITION BY d.process_name) = 0) AS analyzed_for_name,
    (d.monitor_observation = 0
      OR SUM(d.monitor_observation = 0) OVER (PARTITION BY d.upid) = 0) AS analyzed_for_upid
  FROM android_input_event_deliveries AS d
  WHERE (${start_ts} IS NULL OR d.receive_ts + d.receive_dur > ${start_ts})
    AND (${end_ts} IS NULL OR d.dispatch_ts < ${end_ts})
)
