<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Run a registered Skill against the current trace. Use `list_skills` when its ID is unknown. Use it first for scene-level measurements: the scene strategy names the Skill for each question, with its units and identity checks. When `scene_evidence` ran, cite and `fetch_artifact` its tables instead of re-running it.

For a target follow-up, pass the positive `upid` only from its selected evidence row. The identity gate pins nested target Skills. Never infer an UPID from a name or pass NULL, zero, or ambiguity.

`modelProjection.status="exact"` preserves scalar types. With `truncated`, no artifact string supports an exact claim; query narrower. With `unavailable`, cells are display-only.

`columnUnits` gives raw producer-declared units. Missing means unknown; never infer from names, type/format, or displayed `%`.
