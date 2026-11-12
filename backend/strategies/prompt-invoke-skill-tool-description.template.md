<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Run a Skill; IDs via list_skills. Use it first for registered metric measurements. After scene_evidence, `fetch_artifact` its tables instead of re-running it. Use required detail Skills for gaps, not untyped SQL.

CPU hotspots with observed `perf_counters`: collect event-track deltas via a registered Skill. Counts != deltas; missing callsites only limit symbol attribution.

Use the selected evidence row's positive `upid`; nested targets stay pinned. Never infer an UPID or use NULL/zero.
Identity refusal: inspect candidates/warnings; if allowed, use `process_identity_resolver`. Select by evidence, not rank/name; retry its UPID and same window. UPID can still fail. SQL success or dropping filters cannot verify identity. Keep bounds.

`modelProjection.status`: exact keeps scalar types; truncated strings need narrower queries for exact claims; unavailable cells are display-only.

`columnUnits`: raw producer-declared units. Missing means unknown; never infer units.
