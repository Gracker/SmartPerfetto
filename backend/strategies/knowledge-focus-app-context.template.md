<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->
<!-- Loaded with trace_context whenever the runtime ran focus-app detection or
     scoped to an inferred package. The data shape comes from focusAppTarget.ts;
     this file owns the interpretation. -->

## Focus-app context

`trace_context.focusApp` is a ranked hypothesis about which app the trace is
about, computed from foreground time, frames, launches, battery `top` and CPU
activity in the analysis window. It is not the user's target. Only a package the
user named (`packageSource: user`) or a selection binds the analysis target.

When `packageSource` is `auto_detected`, Skills are scoped to that package by
default and the result says so (`appliedDefaultProcess`). If the question names
no app or process and that package has no frame, scheduling or slice evidence
for what the question needs in the window, switch to the best candidate that has
such evidence, and state the switch and the reason in the answer. Do not refuse
because the inferred package lacks evidence.

`status: ambiguous` means no package is in effect: nothing is scoped by default.
Choose the candidate whose signals match the evidence the question needs, pass
it explicitly as the process selector, and say which one you chose and why; if
the choice would change the answer and the signals cannot decide it, ask.
Processes in `excludedNoActivity` did nothing observable in the window; skip
them unless the user asks about them.
