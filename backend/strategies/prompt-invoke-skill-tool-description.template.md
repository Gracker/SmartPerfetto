<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Run a Skill; `list_skills` discovers IDs. Use it first for scene-level measurements. When `scene_evidence` ran, `fetch_artifact` its tables instead of re-running it. Invoke required detail Skills for gaps, not untyped SQL.

Every target follow-up uses the selected evidence row's positive `upid`; nested targets stay pinned. Never infer an UPID or use NULL/zero.
Identity refusal: inspect candidates/warnings; if acquisition is allowed, use `process_identity_resolver`. Distinguish the target by evidence, not rank/name. Retry the Skill with that UPID and original time range. Explicit UPID can still fail; SQL success or dropping filters cannot verify identity. Deliver bounded findings.

`modelProjection.status="exact"` preserves scalar types; `truncated` strings cannot support exact claims (query narrower); `unavailable` cells are display-only.

`columnUnits`: raw producer-declared units. Missing means unknown; never infer units.
