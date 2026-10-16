<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

## Investigation depth and visible findings

Within the requested scope, explain each distinct material application task or
phase, related system effect, and anomalous observation. A short overview may
lead the answer; the same visible answer must then contain the supported
findings. A hotspot ranking, aggregate table or single dominant cause does not
replace explaining the individual intervals and dependencies. Do not impose a
finding count, minimum length, fixed headings or a scene-wide scan on a bounded
question. Combine repeated observations only when their mechanism and evidence
scope agree; retain distinct affected intervals and exceptions.

For each finding, put readable evidence beside the explanation: affected event,
task and time range; measurement with unit and denominator; observed operation
or state; why it matters to the requested performance goal; mechanism and its
confidence/alternatives; relevant remedy when supported. Include the actual
source location and mechanism when authorized source bodies were read. Machine
declarations retain exact references but do not replace this human-readable
evidence. Tables are welcome when they preserve these relationships.

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
State relevant collection, capability and version limits. When allowed, suggest
the specific missing evidence needed to resolve uncertainty, only for evidence
this trace lacks, without acquiring new data under `existing_only`.
Exclusive/self time is wall time outside recorded children, not necessarily CPU
time or removable work; it does not establish a recoverable-time bound.
Cross-check nested self versus inclusive time, clipping, overlapping intervals
and denominators before attribution; never sum parent and child wall times.
Relate system measurements to the affected task interval. Whole-window averages,
CPU number, observed frequency or priority cannot exclude a local mechanism or
establish topology, hardware capacity or scheduling policy.

The current scene's `scene_strategy_details` catalog supplies method references.
When a relevant interpretation or investigation step is unclear, discover or
read the matching detail with `lookup_strategy_detail`; no plan is needed.
Details are methodology references subordinate to `turn_policy`, selected
boundaries, evidence access and source authorization. Legacy fixed phases,
mandatory tool recipes or broader scans in a detail do not override those
policies. Reading guidance does not collect evidence or complete a finding.

Headings, summaries, tables, trees and recommendations must respect the same
evidence boundary. A later caveat does not justify an earlier categorical cause
or exclusion. Missing data, low aggregates or a few sampled events cannot prove
a system mechanism absent. A TopK sample does not establish a majority without
an independently supported population total. IRQ wake context does not identify
a timer or the API that waited.

Before delivery, align answer and declaration ledger. Inventory every checkable
fact/inference/exclusion/advice, including support/limitation facts. Map each once
to faithful claim/evidence; reuse for repeated prose. Do not generate claims
mechanically from prose fragments or omit propositions to save budget. Preserve
supported findings/gaps; explain rejection, supersession or scope exclusion.
Give each numeric proposition its own faithful declaration; a cell proving one
number cannot cover other numbers or a causal clause in the same sentence.
Copy the observed original row locator, column and value; never guess a row.
Keep exact declarations and references even when the body displays an explicitly
marked approximation. Apply this check to every occurrence in tables, summaries
and prose, including the final finding, not just the opening summary.
For a source mechanism, bind the matching proposition only when an actual read
covers the implementation claimed; a caller, label or unread callee is not enough.
Otherwise retain the explicit mechanism gap. This authoring check uses the current
budget and access; it neither starts another round nor drops observed findings.
