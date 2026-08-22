# SmartPerfetto Data Contract

[English](DATA_CONTRACT_DESIGN.en.md) | [中文](DATA_CONTRACT_DESIGN.md)

This document describes the implemented contract, not a migration plan. The
TypeScript source of truth is
[`backend/src/types/dataContract.ts`](../src/types/dataContract.ts).
`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts`
is generated and must not be edited manually. The CapabilityManifest source of
truth is
[`backend/src/types/capabilityManifest.ts`](../src/types/capabilityManifest.ts).

## Contract Goal

The same analysis data is consumed by several product surfaces:

```text
TraceProcessor / YAML Skill / runtime direct evidence
  -> DataEnvelope
  -> SSE and frontend tables
  -> HTML report
  -> CLI turn artifacts
  -> analysis-result snapshot / comparison
  -> evidence, claim-verification, and identity sidecars
```

Each surface may project a different view, but it must not invent an
incompatible private shape. Chat may omit low-signal audit detail; reports,
snapshots, and CLI artifacts retain the provenance needed for review.

## DataEnvelope

`DataEnvelope<T>` has three parts:

```ts
interface DataEnvelope<T = DataPayload> {
  meta: DataEnvelopeMeta;
  data: T;
  display: DataEnvelopeDisplay;
}
```

- `meta`: data kind, schema version, source, timestamp, Skill/step, execution
  status, and evidence provenance.
- `data`: table, chart, text, or diagnostic payload.
- `display`: layer, format, title, column schema, visibility, and
  ordering/collapse hints.

`meta.executionStatus` distinguishes:

- `observed`: the query succeeded and produced an observed result;
- `empty`: the query succeeded with no matching rows;
- `optional_error`: an optional query was unavailable or failed.

Do not collapse `empty` and `optional_error` into "no issue." Comparison
envelopes also preserve `traceSide`, pane, trace id, query hash, and evidence
references. Process/thread evidence may carry an identity sidecar, and
plan-driven evidence may carry phase attribution. Those fields must remain
consistent across reports, snapshots, and verifier paths.

## CapabilityManifest

After the legacy five `TraceCompleteness` fields are complete, the shared trace
probe also resolves a `capability_manifest@1` probe-time snapshot.
`CapabilityManifestV1.content` contains only stable capability inputs: the
identity of the trace processor that is actually running, the trace-bytes
SHA-256 and clock range, and each capability status. `contentHash` is the
canonical hash of that content and `manifestId` derives from it. `provenance`
keeps `traceId`, `diagnosedAt`, and `generatedAt` separately and is not mixed
into the content hash.

The manifest distinguishes a present-but-empty table from a missing schema.
The legacy result retains its compatible `missing_config_suspected` result for
present-empty data, while the manifest maps it to `status: insufficient` and
`sourceState: present_empty`. Only a genuinely missing table maps to
`status: missing` and `sourceState: schema_missing`. Consumers must not collapse
those states again.

`CapabilityManifestResolutionV1` has three outcomes: `ready` carries the
manifest; `unavailable` carries a fixed reason/detail code when trace or
identity material cannot be obtained safely; and `failed` means only that
manifest construction failed. A resolution never exposes raw errors, binary
paths, or trace paths. The current prompt/chat projection ignores this shadow
field; report, snapshot, and CLI persistence is part of the next activation
step.

## Display Layers And Detail

Source constants validate the current display layers:

- `overview`: L1 summary;
- `list`: L2 list/detail;
- `session`: session- or interval-scoped results;
- `deep`: L3/L4 drill-down;
- `diagnosis`: deterministic diagnosis.

Detail levels are `none`, `debug`, `detail`, `summary`, `key`, and `hidden`.
Normal chat/table projections must not present `none` or `hidden` data as
visible evidence. Report and internal-audit retention follows each projection's
contract.

## Self-Describing Columns

`ColumnDefinition` is the table-rendering schema. Important fields include:

- `name` and `label`;
- `type`: `string`, `number`, `timestamp`, `duration`, `percentage`, `bytes`,
  `boolean`, `enum`, `json`, or `link`;
- `format` and `unit`;
- `clickAction`, including `navigate_timeline`, `navigate_range`, and `copy`;
- `durationColumn`, sorting, width, hidden state, and tooltip.

Skills should declare column semantics explicitly. Compatibility paths use
`inferColumnDefinition()` / `buildColumnDefinitions()` for common `ts`, `dur`,
`*_ms`, and `*_bytes` fields, but inference is not a reason for new Skills to
omit schema.

Timestamps and durations may use strings to preserve nanosecond precision.
Frontend formatting and navigation must not first coerce them through a lossy
JavaScript `number`.

## Skill Compatibility Bridge

SkillExecutor still produces `DisplayResult` / `LayeredSkillResult`. The current
bridge functions are:

- `displayResultToEnvelope()`;
- `layeredResultToEnvelopes()`;
- `envelopeToDisplayResult()`;
- `envelopesToLayeredResult()`.

They preserve compatibility with existing Skills and consumers; they do not
bypass DataEnvelope validation. New or changed Skills must retain
`display.layer`, `display.level`, column schema, execution status, and
synthesize output through conversion.

## Query Review

`QueryReviewV1` is review metadata for an executed SQL query or Skill, not a
new form of trace evidence. `execute_sql`, `execute_sql_on`, and `invoke_skill`
may produce it with the producer, evidence/artifact source, tables read,
filters, output fields, guardrails, limitations, and observed execution
statistics. Complex SQL that cannot be inspected deterministically remains
`partial`; inferred structure must not be presented as observed fact.

Its fixed boundary is `allowedUse: review_metadata_only`. A Query Review can
explain what a query did, but cannot support a diagnostic claim by itself or
replace an `evidenceRefId`. The complete object follows its DataEnvelope or
artifact into reports; the compact model projection omits executable SQL; and
private-analysis projections apply the shared redaction boundary.

## Analysis Receipt

`AnalysisReceiptV2` is built at the analysis-completion boundary. It binds the
`runManifestId`, run, session, trace, requested/resolved mode, runtime, and
provider; separately
counts trace evidence and non-evidence context; summarizes claim audit and the
final-report, claim-verification, and identity-resolution gates; and links the
report, snapshot, or CLI turn that was actually produced.

The receipt describes what happened in this run. `partial` and
`not_applicable` must not be projected as `passed`, and report failures remain
visible in `outputs.reportError`. Web SSE, HTML reports, CLI persistence, and
analysis-result snapshots keep the same versioned contract while using
surface-appropriate readable projections. Private-knowledge flows apply the
security projection first.

## UI Actions

A DataEnvelope may derive a bounded UI action proposal:

- `navigate_timeline`;
- `navigate_range`;
- `open_evidence_table`;
- `pin_evidence`.

Actions must reference existing evidence, artifacts, or Skill output. The
frontend executes only allowed typed actions, never arbitrary model-generated
scripts, SQL, or URLs.

## Agent External Feedback

`ExternalIssueOpportunityV1`, `ExternalIssueReviewV1`, and
`ExternalIssueDraftV1` are independent post-completion derivative contracts.
They are not `UiActionProposalV1` variants and do not change
`AnalysisRunSpec`.

- Opportunity detection reads only the persisted `analysis_completed` event,
  matching RunManifest, and optional result snapshot.
- A review contains at most three candidates. Each candidate must cite real
  evidence, Skill, claim-gate, identity, or report references from that run.
  Agent JSON passes exact-key, enum, size, and public-content validation. The
  review endpoint also attaches a short-lived server integrity attestation.
- A draft combines a validated candidate, user answers, and explicit
  sensitive-data confirmation. Facts, Agent assessment, user confirmation,
  missing evidence, and redactions remain separate. The provider pin and
  server attestation are revalidated before generation, and
  `notSubmitted` is always `true`.
- Private/code-aware source runs, missing or drifted provider pins, and
  security-sensitive content fail closed.

The optional RunManifest `providerSnapshotHash` binds new runs to the provider
configuration used for review. Legacy manifests remain readable but never
silently borrow the current provider. The existing generator emits the
frontend types from the backend sources of truth.

## Generation And Verification

After changing the backend contract:

```bash
cd backend
npm run generate:frontend-types
npm run typecheck
npx jest src/types/__tests__/dataContract.test.ts \
  src/services/skillEngine/__tests__/displayContractValidator.test.ts \
  src/services/__tests__/htmlReportGenerator.test.ts --runInBand
```

The generator updates
`perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts`.
If generated output changes, run the relevant Perfetto UI typecheck/tests and
update the committed `frontend/` prebuild according to
[`AGENTS.md`](../../AGENTS.md) and the
[frontend rules](../../.claude/rules/frontend.md).

Skill YAML changes additionally require:

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```

Use the repository gate before landing:

```bash
npm run verify:pr
```

## Maintenance Checklist

- Backend types remain the only handwritten source; generated files were not
  edited directly.
- SSE, report, CLI, snapshot, comparison, and verifier projections were checked.
- External-issue opportunity/review/draft preserve source-run references,
  provider pinning, server review attestation, user confirmation, and the
  `notSubmitted` boundary.
- `empty`, `optional_error`, and uncertainty were not collapsed into a
  deterministic conclusion.
- Current/reference and identity/provenance fields survive conversion.
- Column units, timestamp precision, and click actions match the real data.
- Chinese and English docs and contract tests are updated together.
