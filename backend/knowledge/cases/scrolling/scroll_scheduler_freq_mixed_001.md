---
case_id: scroll_scheduler_freq_mixed_001
title: Scroll jank with scheduling delay and slow frequency response
status: reviewed
quality: curated
scene: scrolling
domain_pack: scrolling.v1
curator: smartperfetto-maintainers
tags: [scrolling, scheduling_delay, frequency]
taxonomy:
  primary_root_cause: sched_delay_in_slice
  secondary_root_causes: [big_core_low_freq, freq_ramp_slow]
  responsibility: mixed
  severity: warning
context:
  app_architecture: standard
  device_vendor: generic_android
  os_version: Android 14+
  refresh_rate_hz: 120
  workload: list_scroll
evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: sched_delay_in_slice
    - field: critical_path
      op: contains_any
      value: ["sched_switch", "RenderThread", "cpufreq"]
  supportive:
    - field: jank_responsibility
      op: eq
      value: MIXED
    - field: vsync_missed
      op: gte
      value: 1
findings:
  - id: f1
    title: Critical frame path contains runnable delay before render work resumes
    evidence_refs: []
    confidence: high
recommendations:
  app:
    - id: app_reduce_frame_work
      priority: P1
      action: Reduce per-frame main and RenderThread work so scheduler delay has less opportunity to cross the frame budget.
      applies_when: The same window shows app thread work near budget plus runnable gaps before render completion.
      risks: Removing work without checking visual correctness can regress content freshness or animation smoothness.
  oem:
    - id: oem_interactive_sched_freq
      priority: P1
      action: Review interactive scheduler placement and short-window frequency ramp behavior for scroll workloads.
      applies_when: Janky frames show runnable delay, low core capacity, or slow frequency ramp while app work is otherwise bounded.
      risks: More aggressive placement or boost rules can increase thermal load and power.
relations:
  similar_root_cause: []
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: []
  contradicts: []
---

## Summary

The trace points to a mixed ownership problem: the app still benefits from
reducing per-frame work, while the platform owner should inspect whether the
interactive scheduling and frequency response are slow for the scroll window.

## Evidence Notes

Use this case when the root-cause classifier reports `sched_delay_in_slice` and
the critical path includes scheduling or frequency evidence near the dropped
frame.
