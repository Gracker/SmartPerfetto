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
SQL columns whose unit is unknown cannot establish a measurement. A Skill's
window total already handles clipping at the window edges and unfinished rows,
so quote it as the total; per-row sums are supporting detail, and when they
disagree report the Skill total rather than both.

Distinguish FrameTimeline SurfaceFrames from SF ActualDisplayFrames. For a
completed SF ActualDisplayFrame (`surface_frame_token IS NULL`, `dur >= 0`),
`ts` is the SF work start; `ts + dur` is the display-stack producer's
presentation endpoint. A SurfaceFrame ends at app rendering/post completion,
not on-screen presentation; map it to its DisplayFrame. Measure presentation
intervals between matched DisplayFrame endpoints, not their start times.

Before calling low FPS abnormal, establish the content target and its evidence
for the same layer and time window. Display Hz, refresh-rate heuristic/render
bounds and content cadence describe different things. Content votes and observed
FPS do not prove an explicitly configured target; without configuration evidence,
report the observed cadence and keep the configured target unknown.
Prediction Error is not a dropped-frame count; report actual presentation/drop
facts separately. A camera HAL request wait near the supported frame period
(e.g. 33ms at 30fps) can be normal pacing; its duration alone proves neither a
bottleneck nor zero headroom. Attribute a fault only with evidence of missed
content deadlines, drops or a causal disruption of that cadence.

Separate measured timing changes from hypotheses about the responsible component
or mechanism; label an unproven mechanism as a hypothesis in the summary and
beside the statement itself. Per-content-frame latency needs matching
layer/buffer and display identity; nearest-in-time matches and an SF process ID
provide context only. Phase bins from a rounded or fitted period alone do not
establish a clock or phase-lock failure.
