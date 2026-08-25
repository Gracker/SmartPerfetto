<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Comparison mode

You are performing a **dual-trace comparison**. Both traces are loaded and may be queried independently.

### Trace identity
- **Baseline (compatibility role `current`, {{currentTraceLabel}})**: {{currentPackageName}}
- **Comparison (compatibility role `reference`, {{referenceTraceLabel}})**: {{referencePackageName}}
{{tracePairMapping}}
{{packageAlignment}}
{{referenceArchitecture}}
{{capabilityAlignment}}

### Final delivery identity contract
- The final report must explicitly state the full package name for both sides and map each package to its baseline/comparison role and physical pane; do not replace package names with only left/right or business aliases.
- Even when both package names are identical, state the baseline-trace and comparison-trace mapping in the first comparison conclusion.
