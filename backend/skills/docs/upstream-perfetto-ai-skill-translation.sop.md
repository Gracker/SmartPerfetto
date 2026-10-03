<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

# Upstream Perfetto AI Skill Translation SOP

This SOP translates reviewed upstream analysis runbooks into SmartPerfetto
runtime assets. Do not copy upstream markdown skills into a second agent skill
runtime.

## Distinct Upstream Sources

| Source | Reviewed surface | Role |
|---|---|---|
| `https://github.com/google/perfetto` | `ai/skills/perfetto/**` at the pinned Perfetto release | Release-coupled Perfetto SQL/workflow gap check |
| `https://github.com/android/skills` | `profilers/perfetto-sql/**` and `profilers/perfetto-trace-analysis/**` at an independently pinned commit | Android Skills methodology gap check |

These repositories have separate locks, commits, reports, and review decisions.
An Android Skills repository release or `main` update never changes the pinned
Perfetto stdlib, trace processor, or official Perfetto AI Skill identity.

## Translation Rule

| Upstream content | SmartPerfetto target |
|---|---|
| Executable PerfettoSQL | `backend/skills/**/*.skill.yaml` step |
| Investigation order | `backend/strategies/*.strategy.md` phase |
| Caveat / data availability rule | Skill fallback row, optional step, or strategy warning |
| Trace processor mechanics | MCP/tool docs and SQL validator behavior |
| Long-form explanation | `backend/skills/docs/*.sop.md` or strategy note |

## Review Checklist

1. Identify whether the upstream skill contains executable SQL, only workflow
   guidance, or environment setup instructions.
2. Reject any Google-internal or repo-relative dependency unless SmartPerfetto
   already has an equivalent public/local path.
3. Prefer stdlib modules over raw table joins. When raw tables are required,
   keep selected columns explicit.
4. Add an availability step before deep analysis when the required trace signal
   may be absent.
5. Keep deterministic evidence in YAML Skill output. Keep interpretation rules
   in strategies or docs.
6. Add focused eval coverage for both data-present and no-data contracts when
   fixtures exist. If only no-data fixtures exist, assert the empty contract.
7. Run `validate:skills`, relevant skill evals, `typecheck`, `build`, and the
   repository PR gate before pushing.

## Android Skills Translation Boundaries

- Adopt analysis order, stop conditions, SQL invariants, and domain checklists
  only when they improve an existing SmartPerfetto contract.
- Do not adopt the Android CLI downloader/runtime. SmartPerfetto uses its pinned
  trace processor pool and the public repository uses its checksum-verified
  bootstrap.
- Do not adopt the trace-adjacent scratchpad convention. SmartPerfetto already
  separates evidence, plan logs, reports, snapshots, CLI artifacts, and chat
  projection.
- `PARTITIONED` limits SPAN_JOIN entity matching; it does not prove that either
  input is non-overlapping inside a partition. Require a fixture/assertion or a
  bounded witness query and reference it with
  `perfetto-span-join-non-overlap-proof`.
- Treat blanket upstream advice as review input, not an unconditional rule.
  For example, Perfetto's own stdlib contains valid view-backed SPAN_JOIN
  inputs, so SmartPerfetto does not prohibit all views.
- Keep IRQ-versus-runnable delay, RT kernel-thread policy, and catch-up-storm
  diagnostics as candidates until a data-present trace fixture and semantic
  assertion prove their portable evidence contracts.

## Current Mappings

| Upstream skill | SmartPerfetto mapping | Status |
|---|---|---|
| `perfetto-infra-querying-traces` | SQL stdlib docs/lineage lookup, auto-include validator, MCP SQL guidance | Implemented |
| `perfetto-infra-getting-trace-processor` | Existing local `trace_processor_shell` pool and setup docs; no runtime skill copy | Documented |
| `perfetto-workflow-android-heap-dump` | `android_heap_graph_summary`, `android_heap_dominator_path_extract`, `android_bitmap_memory_per_process`, memory strategy heap graph guidance | Implemented |
| `perfetto` v57 Agent Skill: `workflows/gpu/gpu_info.md` | `gpu_v57_ai_diagnostics` inventory step; complements existing `gpu_analysis` and `gpu_metrics` | Implemented |
| `perfetto` v57 Agent Skill: `workflows/gpu/timeline_occupancy.md` | `gpu_v57_ai_diagnostics` timeline occupancy and idle-gap steps | Implemented |
| `perfetto` v57 Agent Skill: `workflows/gpu/frequency_residency.md` | `gpu_v57_ai_diagnostics` busy-frequency residency, DVFS ramp, and below-target-clock busy steps (upstream gpu_sustained_throttle.sql; no frequency-cap evidence) | Implemented |
| `perfetto` v57 Agent Skill: vendor-neutral GPU compute workflow | `gpu_compute_kernel_analysis`; `gpu-workload` contains real compute-category GPU slices and producer-provided launch arguments | Implemented |
| `perfetto` v57 Agent Skill: NVIDIA counter workflows | Not promoted without an owned producer-counter schema and data-present fixture; generic kernel timing and launch arguments are not NVIDIA Speed-of-Light or counter-derived occupancy evidence | Deferred |
| `perfetto` v57 Agent Skill: Android memory heap dump/caching scripts | `android_heap_graph_summary`, `android_heap_graph_leak_candidates`, `android_bitmap_memory_per_process`, `android_memory_v57_ai_diagnostics` repeated-object and size-frequency steps | Implemented |
| `perfetto` v57 Agent Skill: Android dominator-path extraction | `android_heap_dominator_path_extract`; `memory-gc-pressure` contains a real managed heap graph and validates the data-present query contract | Implemented |
| `perfetto` v57 Agent Skill: cross-trace heap-path clustering | Declarative `batch_analysis` selects the portable extraction rows; the typed TF-IDF/K-Means/Silhouette post-processor, batch artifact, and report projection remain SmartPerfetto product-only | Implemented (product-only post-processing) |
| `perfetto` v57 Agent Skill: Java/native allocation profile scripts | `native_heap_breakdown`, `android_memory_v57_ai_diagnostics` heap-profile hotspot step | Implemented |
| v57 `linux.systemd_journald` stdlib | `linux_systemd_journald_analysis` | Implemented |
| v57 `state` table / state tracks | `trace_state_track_summary`; existing `state_timeline` remains the higher-level interaction timeline | Implemented |
| `android/skills` `profilers/perfetto-sql` | SQL guardrails, schema/stdlib lookup, idempotent execution, and explicit SPAN_JOIN non-overlap proof | Implemented |
| `android/skills` `profilers/perfetto-trace-analysis` | Scene routing, evidence chain, dependency drill-down, and bounded secondary-bottleneck closure | Implemented |
| `android/skills` IRQ/runnable-delay, RT policy, and catch-up-storm ideas | No new atomic Skill without a data-present fixture and semantic assertion | Deferred |

## Acceptance

A translation is complete only when the SmartPerfetto asset can be invoked by
the existing Skill/strategy runtime and its output contract is tested. A markdown
note alone is not enough unless the upstream source has no executable analysis
surface.
