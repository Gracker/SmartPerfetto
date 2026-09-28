-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Which receiver of a physical input event is its application delivery.
-- android_input_events has one row per receiving channel of the same physical
-- event (input_event_id): the app window plus gesture monitors, the pointer
-- dispatcher, wallpaper and navigation bar channels. The stdlib sets
-- event_action only from app-side delivery evidence on a window the receiving
-- process owns, so monitor channels never carry it; an app delivery can still
-- lack it (no `view` atrace, no frame after the event).
--   action       - event_action is known: an observed application delivery.
--   monitor_copy - NULL action, and another row of the same input_event_id
--                  carries one: a monitor observation, not the app's.
--   unresolved   - NULL action on every receiver of the event (trace-edge
--                  events, FOCUS, runtimes that resolve no action).
-- unresolved_event_key identifies an unresolved event once per input_event_id,
-- so counting it DISTINCT gives extra channels of one event no extra weight.
-- window_owner is the stdlib's owner of the receiving channel,
-- str_split(str_split(event_channel, ' ', 1), '/', 0), spelled portably: the
-- package of a '<hash> <package>/<component>' window. Monitor, dispatcher,
-- navigation-bar and wallpaper channels never yield their receiver's name; nor
-- do app windows titled without '/' (PopupWindow:..), which keep plain counts.
-- unresolved_window_event_key keeps an unresolved event only on a window its
-- receiver owns: the exact name, or the name before ':' for multi-process apps,
-- whose delivery the stdlib cannot resolve (substr, not GLOB: the owner is
-- channel text). Rankers read it right after the action count, because a
-- monitor sees touches aimed at every window and can out-count the app.
-- Classified over the whole relation, never inside a caller's time window, so a
-- window edge cannot separate a copy from its action-bearing sibling.
-- scene_input_facts.sql applies the same "the action-bearing receiver is
-- primary" rule per stream for scene reconstruction, without window ownership.
-- Requires fragments/android_input_events_normalized.sql listed before it.
android_input_action_event_ids AS (
  SELECT DISTINCT input_event_id
  FROM android_input_events_normalized
  WHERE event_action IS NOT NULL AND input_event_id IS NOT NULL
),
android_input_event_deliveries AS NOT MATERIALIZED (
  SELECT d.*,
    CASE WHEN d.window_owner != ''
      AND substr(d.process_name || ':', 1, length(d.window_owner) + 1) = d.window_owner || ':'
      THEN d.unresolved_event_key END AS unresolved_window_event_key
  FROM (
    SELECT e.*,
      CASE WHEN e.event_action IS NOT NULL THEN 'action'
        WHEN a.input_event_id IS NOT NULL THEN 'monitor_copy'
        ELSE 'unresolved' END AS delivery_role,
      CASE WHEN e.event_action IS NULL AND a.input_event_id IS NULL
        THEN COALESCE(e.input_event_id, 'dispatch:' || e.dispatch_ts) END AS unresolved_event_key,
      -- Second word of the channel, cut at its first '/'.
      CASE WHEN instr(e.event_channel, ' ') > 0 THEN substr(
        replace(substr(e.event_channel, instr(e.event_channel, ' ') + 1), '/', ' '), 1,
        instr(replace(substr(e.event_channel, instr(e.event_channel, ' ') + 1), '/', ' ') || ' ', ' ') - 1)
      END AS window_owner
    FROM android_input_events_normalized AS e
    LEFT JOIN android_input_action_event_ids AS a ON a.input_event_id = e.input_event_id
  ) AS d
)
