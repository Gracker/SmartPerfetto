<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Loaded with the scene_evidence segment. The data shape comes from
     sceneEntryEvidence.ts (buildSceneEvidencePromptData); this file owns the
     interpretation. -->

## Scene entry evidence

`scene_evidence`: entry Skill attempted by the product before your first turn.
`ran` reports its verified identity. `cells` tuples (order `fields`) cite an
`artifacts` entry via `evidenceRefId`, `rowIndex`, `column`, exact `value`.
`artifactIdRange` covers all run tables: `fetch_artifact` the rest, not duplicate
Skill/SQL. Explain and drill into results; acquire only missing evidence.
`not_run`: nothing collected (`reason`). For `identity_ambiguous`, follow
`invoke_skill` identity recovery: distinguish the target with evidence, then
retry its positive `upid` and original window. Rank/name or SQL success does not
verify identity; unresolved candidates remain uncertain.
