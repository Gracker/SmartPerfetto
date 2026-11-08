<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Loaded with the scene_evidence segment for a bounded question. The data
     shape comes from sceneEntryEvidence.ts (buildSceneEvidencePromptData);
     this file owns the interpretation. -->

## Entry evidence for this question

`scene_evidence`: entry Skill the product ran before your first turn, as
context for the current question. Answer only what the question asks; it does
not ask for a review of everything this Skill covers. `targetScope: all_processes` means no
target was resolved and the Skill covered every process; `ran` with `identity`
reports its verified target. `cells` tuples (order `fields`) cite an `artifacts`
entry via `evidenceRefId`, `rowIndex`, `column`, exact `value`.
`artifactIdRange` covers all run tables: `fetch_artifact` what the question
needs, not duplicate Skill/SQL. Acquire only evidence the question still lacks.
`not_run`: nothing collected (`reason`). For `identity_ambiguous`, follow
`invoke_skill` identity recovery: distinguish the target with evidence, then
retry its positive `upid` and original window. Rank/name or SQL success does not
verify identity; unresolved candidates remain uncertain.
