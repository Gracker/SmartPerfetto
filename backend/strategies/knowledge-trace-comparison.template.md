<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Trace comparison evidence

Resolve the user's baseline/comparison labels to the supplied trace identities
and pane aliases. State the full package/process names and windows used. Process
names, startup IDs and timestamps may differ: select the matching workload on
each side rather than copying a local ID or absolute time to the other trace.

Compare matching definitions, units, denominators, event populations and capture
coverage. A successful capability probe establishes comparable availability;
missing or unprobed capabilities remain unknown. Show baseline, comparison and
the delta direction for supported metrics. Missing is not zero, and a zero or
missing baseline does not support percentage change. Separate absolute delta,
relative change and share of the measured window.

In SmartPerfetto raw-trace tools, current is the baseline and reference is the
comparison role; physical left/right/top/bottom comes from the supplied mapping.
compare_skill accepts currentParams/referenceParams for distinct windows and
identities. execute_sql and invoke_skill use current; execute_sql_on selects a
side explicitly. A tool on one side does not collect evidence from both.
compare_skill aligns steps, not rows: a bounded ranking can omit on one side
an item present on the other. Before calling an item new or gone, request it
by name on both sides (for heap dumps, `class_names`). Only an explicit zero
row from a successfully read source counts as zero.

For stored-result comparisons, use the normalized snapshot metrics and their
original provenance. Do not recover numbers from report prose or treat missing
dimensions as zero. Retain missingness and follow the current evidence-access
policy rather than silently querying raw traces to fill gaps.

Explain each material difference using aligned evidence and relevant system or
application context. A percentage threshold or two different measurements alone
does not prove a cause; retain alternatives, confounders and unsupported links.
