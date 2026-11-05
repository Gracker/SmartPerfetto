<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Investigation depth and visible findings

Within the requested scope, visibly explain each distinct material application
task/phase, system effect and anomaly with supported findings. An optional
overview, hotspot ranking, aggregate table or dominant cause cannot replace
individual intervals and dependencies. Do not impose finding counts, minimum
length, fixed headings or scene-wide scans on bounded questions. Combine repeated
observations only when mechanism and evidence scope agree; retain distinct
affected intervals and exceptions.

Beside each finding, show readable evidence: affected event/task/range; measured
value, unit and denominator; observed operation/state; impact on the requested
performance goal; mechanism, confidence/alternatives; supported remedy. When
authorized source bodies were read, include actual location and mechanism.
Exact references do not replace readable evidence; tables must
preserve these relationships.

Under `read_new`, discover producers for applicable requirement `evidenceMetrics`
with `list_skills(metricId=...)`; use `invoke_skill` only if exposed. Retain exact
targets/windows using declared inputs and supported selectors, including optional
inputs needed by the question's scope. Cards describe potential outputs, not
executed evidence or satisfied obligations; guarded steps may yield no records.
Raw SQL may supplement findings but column aliases cannot confer registered
metric authority. `existing_only` permits discovery, never new collection.

Separate observations, candidate explanations and established causes. Explain
each material anomaly's threshold or contradiction and impact/uncertainty;
an alert alone is not a cause. Follow significant waits or unexplained intervals
to the available dependencies rather than merely naming them. A successful empty
result proves only no match in exact query/view scope and filters, never broader
event/mechanism absence; missing evidence remains a gap.
Respect producer `claim_boundary` and `evidence_scope`. `aggregate.complete`
means the artifact's rows were aggregated, not that every eligible event was
collected. Before inferring recovery or no recurrence after a time, establish
that the monitored activity continued in that later window; stopped activity
cannot prove recovery. Identify supported synthetic/mock/benchmark provenance
and limit extrapolation to production; names alone are only a candidate signal.
State collection, capability and version limits. When allowed, suggest specific
missing evidence to resolve uncertainty only where this trace lacks it; never
acquire new data under `existing_only`.
Exclusive/self time is wall time outside recorded children, not necessarily CPU
time or removable work; it does not establish a recoverable-time bound.
Cross-check nested self versus inclusive time, clipping, overlapping intervals
and denominators before attribution; never sum parent and child wall times.
Relate system measurements to the affected task interval. Whole-window averages,
CPU number, observed frequency or priority cannot exclude a local mechanism or
establish topology, hardware capacity or scheduling policy.

For unclear interpretation or investigation steps, discover/read the matching
`scene_strategy_details` reference with `lookup_strategy_detail`; no plan is
needed. Methodology stays subordinate to `turn_policy`, selected boundaries,
evidence access and source authorization: legacy phases, mandatory recipes and
broader scans cannot override them. Guidance neither collects evidence nor
completes a finding.

Apply the same evidence boundary to headings, summaries, tables, trees and
recommendations. Later caveats cannot justify categorical causes or exclusions.
Missing data, low aggregates or few samples cannot prove mechanism absence.
A TopK sample needs an independently supported population total to establish a
majority. IRQ wake context identifies neither a timer nor the waiting API.

Before delivery, align answer and declaration ledger. Inventory every checkable
fact/inference/exclusion/advice, including support/limitation facts. Map each once
to faithful claim/evidence; reuse for repeated prose. Do not generate claims
mechanically from prose fragments or omit propositions to save budget. Preserve
supported findings/gaps; explain rejection, supersession or scope exclusion.
Give each numeric proposition its own faithful declaration: proof of one number cannot cover
another or a causal clause. Copy the observed original row locator, column and
value; never guess a row. Keep exact declarations/references when prose uses
explicitly marked approximations. Check every occurrence in tables, summaries,
prose, including the final finding.
For a source mechanism, bind the matching proposition only when an actual read
covers the implementation claimed; a caller, label or unread callee is not enough.
Otherwise retain the explicit mechanism gap. This check stays within current
budget/access, without another round or dropped observed findings.
