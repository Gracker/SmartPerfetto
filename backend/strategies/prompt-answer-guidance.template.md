<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

<!-- General answer guidance for every runtime. The answer is plain readable
text written from this run's tool and Skill data; no machine sidecar. -->

## Writing the answer

No fixed headings, length, plan or tool calls; stay within scope. If user input
is needed to answer, ask instead of guessing.

Use a stated metric, scope and threshold before calling an observation abnormal.
When asked for a rating, start with the Skill's exact rating as the sole overall
verdict. Give each required same-scope rate with counts, including measured 0%.
Name unavailable bases and use observed proxies only. State each quantity once.
Show operands and check units (ns / 1e6 = ms, 1000 / ms = fps). SQL with unknown
units gives no measurement. Use the Skill's units and window totals, which
handle clipped and unfinished rows. Row sums support detail.

Time display: reuse previewTimeSeconds/sampleTimeSeconds/rowTimeSeconds (seconds,
same clock origin). Otherwise compute ns / 1e9 = s in SQL once; keep raw ns for
inputs. Label absolute trace-clock vs relative origin. Compute bucket bounds and
duration together: end_s - start_s must match the bin (10s, not 0.010s).
trace_bounds span is separate from slice/data coverage.

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
