<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Loaded with the scene_evidence segment. The data shape comes from
     sceneEntryEvidence.ts (buildSceneEvidencePromptData); this file owns the
     interpretation. -->

## Scene entry evidence

`scene_evidence` is this scene's entry Skill, run by the product before your
first turn under the verified identity it reports. `ran`: each `cells` tuple
(order `fields`) is a citable cell of an `artifacts` entry (its `evidenceRefId`,
`rowIndex`, `column`, exact `value`). `artifactIdRange` holds every table of that
run: `fetch_artifact` the rest instead of re-running the Skill or rewriting it as
`execute_sql`. Explain and drill into these results; acquire only what they do
not cover. `not_run`: nothing was collected (`reason`); with `candidates`, pass
the process the question is about explicitly.
