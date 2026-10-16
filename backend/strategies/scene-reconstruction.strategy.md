<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

---
scene: scene_reconstruction
investigation_contract:
  schema_version: 1
  profiles:
    - {id: scene_reconstruction, version: 1}
classification_description: "Reconstructing the sequence of user actions, device state changes and application responses across the requested trace range, with evidence-bound timeline revisions and explicit observation gaps."
priority: 1
effort: high
required_capabilities: []
optional_capabilities:
  - device_state
  - input_latency
  - frame_rendering
  - startup
  - surfaceflinger
  - battery_counters
keywords:
  - 场景还原
  - 还原场景
  - 用户操作还原
  - 操作时间线
  - 手机状态变化
  - scene reconstruction
  - scene replay
  - reconstruct user actions
  - user interaction timeline
final_report_contract:
  required_sections:
    - id: scene_timeline
      label: 用户操作、设备状态与应用响应
      description: "Explain the chronological operation/state story at the granularity supported by evidence, with exact intervals, object identities and adjacent readable evidence. Build the structured segment set progressively through the scene proposal tool; the visible account must retain material findings rather than silently dropping the tail or unresolved phases. Do not duplicate the tool JSON in prose."
    - id: scene_evidence_coverage
      label: 观测与扫描覆盖
      description: "State the requested range, actual inspected ranges and available sources. Distinguish query scan completion, trace capture completeness and story verification. Identify truncation, unscanned intervals, unsupported sources and exhausted budgets; none can be represented as observed inactivity."
    - id: scene_uncertainty_and_revisions
      label: 未知、歧义与修订
      description: "Explain unresolved action/state/ownership and boundary alternatives, the evidence that justified material revisions, and the remaining limitations. Keep proposal acceptance and finite time/identity checks separate from semantic support. If no material ambiguity remains, explain the evidence supporting that result without inventing uncertainty."
---

#### scene_reconstruction Core Strategy

Reconstruct what the user and device were doing throughout the requested trace range. The user has selected this investigation; start acquisition within the authorized run. Establish the trace bounds and available sources, collect facts, form competing explanations where needed, query the uncertainties, then revise a structured timeline. Performance diagnosis is a follow-up when a particular observation warrants it.

Use the registered `scene_reconstruction` and `scene_device_state_changes` Skills as initial fact inventories. Inspect source/coverage metadata and original artifact rows. Discover further available Skills and schemas for missing input, state, window or response evidence. A successful inventory is not a completed reconstruction. Missing action, missing ACK, absent samples and unavailable tables remain explicit unknowns.

For each segment, distinguish user action, device state and application response; preserve object identity and exact nanosecond boundaries. A gap between observed events is not proof of user inactivity. Input movement is not necessarily scrolling; ACK is not presentation; foreground overlap alone does not bind the input target.

Use `propose_scene_timeline` when this run exposes it. Submit current-run evidence references and candidate deltas, inspect its diagnostics, and correct the explanation, references or boundaries. Only the product assesses the final revision. Never declare a proposal verified, manufacture proof, or reconstruct a final timeline from Markdown.

After the initial fact inventory yields a citable observation, submit a small first revision with unsupported dimensions and remaining ranges explicitly unknown. Continue acquisition and revise that candidate as evidence develops. Do not wait for a complete trace narrative before the first submission, and do not plan the proposal as a final phase: it belongs to the first phase that returns citable rows. Acquisition pauses while no segment is committed after the initial inventory, and closes near the budget limit so the final revision and answer fit; a paused or closed acquisition returns the action to take. Choose queries from the remaining uncertainties; no fixed tool sequence or repeated revision is required when the first candidate already accounts for the available evidence.

Read `scene_reconstruction:full` for source limits, complete pagination, long-trace carry and revision handling. Preserve the entire requested scope. Resource limits end in an explicit partial result with remaining ranges, not a shortened trace presented as complete.

<!-- strategy-detail id="full" title="Scene reconstruction acquisition and revision" keywords="scene reconstruction,user input,device state,coverage,pagination,revision,场景还原,用户操作,设备状态,覆盖,修订" default="true" -->
#### Evidence acquisition and candidate revision

**Establish the observation contract.** Read the actual trace bounds, supported tables/columns and source coverage before assigning events. Distinguish unavailable source, an available source with zero returned rows, incomplete dispatch, parsing failures, producer truncation and transport preview. Source presence does not prove complete capture. Preserve exact timestamp strings; do not round nanoseconds through floating-point arithmetic. The requested range may be smaller than the trace: name it explicitly and retain its true boundaries.

**Read the initial inventory as facts and candidates.** `scene_reconstruction` accepts `trace_id`, `scene_row_limit`, `start_ts` and `end_ts`. Its input facts are normalized before window clipping, retaining original boundaries and event identities; inspect each other step's declared coverage rather than assuming the whole composite is windowed. Inspect `input_coverage`, source availability and the relevant original outputs, including the tail. Its gesture labels and merged timeline are hypotheses to reconcile with input, window and response evidence. `scene_device_state_changes` accepts `start_ts`, `end_ts` and `row_limit`; inspect `state_sources`, `state_intervals`, `fact_kind` and truncation. State commits are zero-duration events; a separate state span describes the interval supported by the latest observation. A state-source count alone does not establish that every required interval was read or understood. Use registry-discovered tools for other sources rather than assuming an Android version or recording configuration.

**Scan long traces without losing boundaries.** Page available artifact rows using the returned total, offsets and completion metadata. Artifact pagination retrieves retained output; it cannot recover rows discarded by a producer SQL limit. If output was truncated, acquire additional bounded windows through a supported interval Skill or `execute_sql`. Inspect the schema first. Use a stable ordering that includes a timestamp and a unique event/row identity; timestamps alone are not a safe cursor. When many rows share a timestamp, continue the identity cursor or narrow the query without skipping them. Track which source and time range each successful query covers and which ranges remain unscanned.

Carry the last observed state before a window into the next window only when the source supports persistence. Carry unfinished touch sequences and relevant window/target identity across boundaries; do not invent a new DOWN at a page boundary or close an open gesture at the window end. Deduplicate stable physical event identities while retaining distinct delivery recipients. Mark missing carry-in and open endpoints explicitly. Choose window sizes from returned row/byte sizes and the remaining budget, not a fixed duration. Keep successfully inspected earlier ranges when subsequent acquisition fails.

**Resolve the input action.** Separate physical input from per-window dispatch and preserve available source/device/display/channel identities. `input_events_in_range` is useful for bounded dispatch investigation, but its `android_input_events` rows require a completed ACK chain: zero rows there cannot prove no touch or key activity. Inspect other captured native/legacy sources when they can reveal missing DOWN/UP/CANCEL, partial dispatch, motion action or device changes. Preserve unknown action values. Multiple MOVE events establish movement, not list scrolling; require scrolling/response evidence before naming scroll or fling. The absence of frames cannot turn movement into idle.

Name the source population of every count you report — slices, log lines, counter samples or input records are different populations, and a count from one cannot be described as another. Do not claim an action such as scroll/fling is absent from a partial search. Count all matching original action events with an explicit population and physical-event deduplication rule; delivery receipts, endpoint counts and truncated previews are different populations and cannot be used to calculate that count mentally.

**Resolve device state independently.** Keep screen on/off/doze, lock state, charging, input-device state, committed device-state values and orientation separate. A screen state is not an unlock event; charging is not proof of cable presence. Preserve OEM DeviceState values until device-specific configuration supports a posture name. Do not name folding/unfolding solely from an integer. A first state sample in the middle of the trace does not prove the prior state. If a dimension was not recorded, identify it as unavailable instead of synthesizing a change.

Retain every observed state commit from the inspected inventory as a distinct device observation, even when its posture meaning is unknown. Keep device and input-stream objects separate from contextual applications: foreground overlap does not make an unassigned native input event belong to that app, particularly with multiple windows. Use original timestamp cells for exact boundaries, including CANCEL endpoints; never reconstruct nanoseconds from rounded display durations.

The first charging or other state sample is a first observation, not evidence of a transition from unknown to that state; a transition requires supported before and after observations.

**Resolve application response and ownership.** Bind process instances, windows, display and input target from actual identities where possible. Consider SystemUI, IME, split-screen and PiP without assigning all activity to the top app. Lifecycle, input handling, frame production and presentation are separate observations. ACK duration is not input-to-display latency. Rendering architecture and available FrameTimeline or legacy markers constrain what can be said; absent presentation data remains unknown. Query competing owners or boundary explanations before choosing one. An available source explanation may clarify marker meaning, but it cannot establish an event absent from this trace.

The registered `scene_response_markers` inventory retains raw Scroll/FlingStart markers and their track identities. Its scan covers only its declared marker-name population; neither a marker duration nor zero matching rows establishes a complete gesture, presentation interval or absence of every response mechanism.

**Maintain the structured candidate.** Use stable segment IDs, exact `startNs`/`endNs`, an explicit object and separate `userAction`, `deviceState`, `appResponse`. Write unknown in the unsupported dimension while preserving what was observed in the others. Evidence locators must refer to original rows captured by tools in this run. Do not cite a previous scene report, model notes, a proposal result or another run as fresh execution evidence. Use actual artifact-wide row indices and observed columns/values. If producer time or identity semantics are unavailable, accept that the corresponding finite check remains unknown; do not rename a column or change a claim to manufacture a pass.

The optional reference `value`, when supplied, must denote the captured cell: quote strings exactly, and quote a numeric cell as the number or its exact decimal string (nanosecond cells may be quoted as strings, like `startNs`). Cite one identifier per reference, from the same tool result as the row: `evidenceRefId`, or `artifactId` for a stored artifact. `rowIndex` copies the `rowIndex` printed with a row, never its sample or page position; unindexed row lists count from 0. An evidence boundary column must exist in the cited original row. If an end is computed as `ts + dur`, query and cite a real end column or mark the boundary inferred; never invent a column name. Use rejection diagnostics' segment ID, reference index, requested and available columns and conflicting identifiers to repair the specific candidate before accumulating a larger batch. Independent groups still commit when another group is rejected; resubmit only the rejected groups against the returned revision.

Submit a delta with the last accepted `baseRevision` and a unique `proposalId`. Unmentioned segments remain. Update an existing ID when revising that segment; use `supersedes` and `removeSegmentIds` when replacing/removing old candidates. Record `dependencies` when a segment depends on another segment's carry state or boundary. A changed dependency can invalidate later checks. Unresolved alternatives belong in the current `unresolved` list; do not erase them simply to shorten output. Repeat an identical proposal ID only to retry the identical payload.

On stale revision, reconcile with the tool's current revision before submitting a new delta. On invalid or evicted references, reacquire current-run evidence during the normal analysis loop when the budget allows. Correct object/boundary contradictions by checking the underlying source. Tool acceptance means the candidate was stored; it does not certify its story. A successful finite boundary or identity check proves only that predicate, not action semantics, causal attribution or complete coverage.

**Close the investigation honestly.** Submit the accumulated candidate before delivering the final account. Cover early, middle and late observations and preserve material app/system responses and unresolved findings in the visible answer. Structured segments remain the detailed timeline; prose explains the story and material revisions without dumping tool JSON. State actual scan/capture/verification limits and the uninspected range if any. The finalizer cannot perform new acquisition. If the scene tool is not available on this authorized surface, deliver the observed facts with that limitation; do not pretend to publish a canonical scene revision.
<!-- /strategy-detail -->
