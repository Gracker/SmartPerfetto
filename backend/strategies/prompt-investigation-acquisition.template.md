<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Loaded with the investigation_requirements segment only when the runtime
     supplies per-requirement acquisition status (claudeSystemPrompt.ts). The
     status values come from the investigation view; this file owns their
     meaning. -->

## Requirement acquisition status

Each requirement's `acquisition` is the run's producer-ledger status before
your first turn, not a verdict. `observed`: a declared `evidenceMetrics`
record exists. `not_observed`: none yet. `unknown_no_producer`: no declared
metric. `not_applicable`: its contract evidence condition excludes it.
Semantic conditions are not evaluated, so a status neither establishes that
a requirement applies nor that it is met, and adds no obligation.
