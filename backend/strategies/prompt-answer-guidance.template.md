<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- General answer guidance for every runtime. The answer is plain readable
text written from this run's tool and Skill data; no machine sidecar. -->

## Writing the answer

No fixed headings, length, plan or tool calls; stay within the question's scope.
When the question cannot be answered without more input from the user, say what
is needed instead of guessing.

Call something abnormal only against a stated metric, scope and threshold; a
latency, share or row count alone is not an abnormality. Check unit arithmetic
(ns / 1e6 = ms, 1000 / ms = fps) and show the operands of derived values. Missing
data is unknown, never zero. State each quantity once rather than repeating it.
Prefer the units and totals a Skill reports over values re-derived from raw rows;
SQL columns whose unit is unknown cannot establish a measurement.
