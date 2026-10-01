---
case_id: scroll_shader_compile_pixel8_001
title: Scroll jank from RenderThread shader compilation
status: published
quality: curated
scene: scrolling
domain_pack: scrolling.v1
curator: smartperfetto-maintainers
tags: [scrolling, shader_compile, render_thread]
taxonomy:
  primary_root_cause: shader_compile
  secondary_root_causes: [render_thread_heavy]
  responsibility: app
  severity: critical
context:
  app_architecture: standard
  device_vendor: pixel
  os_version: Android 15
  refresh_rate_hz: 120
  workload: list_scroll
evidence_signatures:
  required:
    - field: reason_code
      op: eq
      value: shader_compile
    - field: render_slices
      op: contains_any
      value: ["compileShader", "makePipeline", "Shader"]
  supportive:
    - field: jank_responsibility
      op: eq
      value: APP
    - field: vsync_missed
      op: gte
      value: 1
findings:
  - id: f1
    title: RenderThread shader compilation overlaps the dropped-frame window
    evidence_refs: []
    confidence: high
recommendations:
  app:
    - id: app_precompile_shader
      priority: P0
      action: Precompile or warm up shaders before the first interactive scroll.
      applies_when: RenderThread shader or pipeline compilation slices overlap dropped-frame windows.
      risks: Warmup moves CPU and memory cost earlier, so schedule it outside critical startup or first-input paths.
  oem:
    - id: oem_gpu_sched_response
      priority: P1
      action: Inspect GPU frequency response and RenderThread scheduling during shader-heavy frames.
      applies_when: App-side shader work remains after precompile and the same frames show low frequency or scheduling delay.
      risks: Frequency or boost policy changes can increase power and should be scoped to short interactive windows.
relations:
  similar_root_cause: []
  same_app: []
  same_device: []
  before_after_fix: []
  derived_pattern: [scroll_scheduler_freq_mixed_001]
  contradicts: []
---

## Summary

The dropped frames are dominated by RenderThread shader or pipeline compilation
inside the visible scroll window. This is primarily an app-actionable issue
when the compilation is synchronous and repeatable on first exposure.

## Evidence Notes

Treat the recommendation as strong only when the trace contains shader-related
RenderThread slices inside the janky frame window and the root-cause classifier
reported `shader_compile`.
