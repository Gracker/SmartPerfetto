// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Spark Contracts
 *
 * Single source of truth for the contract shapes introduced by the Spark
 *施工计划包 (`docs/superpowers/spark/plans/*`). Each plan defines a minimal,
 * forward-compatible contract that downstream services, Skills, MCP tools,
 * UI panels, or reporters can produce or consume.
 *
 * Design rules (apply to every contract below):
 *  - Every result object carries `schemaVersion`, `source`, `createdAt` (or
 *    equivalent provenance) so old sessions and reports remain readable as the
 *    schema evolves.
 *  - Trace timestamps stay in nanoseconds; presentation layers are free to add
 *    a formatted `*_str` field but must never replace the raw ns value.
 *  - Anything an LLM can quote must expose `evidenceRef`, `artifactId`, `sql`,
 *    `skillId`, or an explicit `unsupportedReason`. Missing-data paths must be
 *    visible — never wrapped as a confident conclusion.
 *  - All new fields are optional by default to keep older sessions consumable.
 *
 * Spark mapping: see `docs/superpowers/spark/README.md` "Spark #1-#205 覆盖矩阵".
 *
 * @module sparkContracts
 */

// =============================================================================
// Shared base types (used across all Spark plans)
// =============================================================================

/** Universal time range expressed in nanoseconds (Perfetto canonical unit). */
export interface NsTimeRange {
  /** Inclusive start in nanoseconds since trace start. */
  startNs: number;
  /** Exclusive end in nanoseconds since trace start. */
  endNs: number;
}

/** Provenance fields that every contract must carry. */
export interface SparkProvenance {
  /** Contract version. Bump on breaking changes. */
  schemaVersion: number;
  /** Where the data came from (skill id, MCP tool id, importer id, …). */
  source: string;
  /** Epoch ms timestamp when the artifact was generated. */
  createdAt: number;
  /**
   * Human-readable reason that explains why the result was downgraded. When
   * present the consumer must treat the contract as a low-confidence/blocked
   * artifact rather than a confident conclusion.
   */
  unsupportedReason?: string;
  /** Free-form provenance notes (e.g. trace processor build, host SHA). */
  notes?: string;
}

/** Pointer that lets consumers resolve back to evidence. */
export interface SparkEvidenceRef {
  /** Time range when the evidence is bounded (optional). */
  range?: NsTimeRange;
  /** Skill that emitted the evidence. */
  skillId?: string;
  /** Step within a composite/iterator skill. */
  stepId?: string;
  /** Backing artifact in the session-scoped artifact store. */
  artifactId?: string;
  /** Raw SQL fingerprint or stored procedure id. */
  sql?: string;
  /** External resource (importer, RAG entry, log file). */
  externalRef?: string;
  /** Optional natural-language description for UI tooltips. */
  description?: string;
}

/** Confidence band shared by decision-tree style outputs. */
export type SparkConfidence = 'low' | 'medium' | 'high' | 'unsupported';

/** Per-Spark-number mapping recorded inside each contract for traceability. */
export interface SparkCoverageEntry {
  /** Spark idea number from `docs/spark.md`. */
  sparkId: number;
  /** Plan id (`01`-`57`) consuming the idea. */
  planId: string;
  /** Status word matching `docs/superpowers/spark/TODO.md`. */
  status: 'scaffolded' | 'implemented' | 'unsupported' | 'future';
  /** Brief note explaining what landed for this Spark id. */
  note?: string;
}

// =============================================================================
// First-tier shared base types — Plans 41 / 44 / 50 / 54 / 55
//
// These types are referenced from multiple plans and live here (not on a
// per-plan basis) so they can be imported once. Every type is opt-in: existing
// plans (01-18) do not depend on them and continue to compile unchanged.
// =============================================================================

/**
 * Strict enum of RAG (Retrieval-Augmented Generation) source kinds.
 *
 * Narrow on purpose — license / consent / freshness policy tables switch on
 * this value and must not silently accept unknown sources. Extending the
 * union requires an explicit contract bump and updates to those tables.
 */
export type RagSourceKind =
  /** Plan 55 — androidperformance.com blog ingester. */
  | 'androidperformance.com'
  /** Plan 55 — AOSP source ingester (license required). */
  | 'aosp'
  /** Plan 55 — OEM SDK doc ingester (license required). */
  | 'oem_sdk'
  /** Plan 44 — exposes project memory entries as a RAG corpus. */
  | 'project_memory'
  /** Plan 44 — world-scope consolidated memory (post-review). */
  | 'world_memory'
  /** Plan 54 — published case library entries. */
  | 'case_library';

/**
 * Pointer to a RAG-indexed document chunk.
 *
 * Used by Plan 44 (project memory references) and Plan 55 (blog/AOSP/OEM
 * retrieval results). The reference travels through the artifact store so
 * downstream consumers can resolve the original text on demand.
 */
export interface RagDocumentRef {
  /** Stable chunk id (sha-256 prefix of source + offset). */
  chunkId: string;
  /** Knowledge source kind — strict enum, see `RagSourceKind`. */
  source: RagSourceKind;
  /** Display title of the parent document. */
  title?: string;
  /** Original URL or local path. */
  uri?: string;
  /** Byte offset (or token offset) into the source document. */
  offset?: number;
  /** Length of the chunk in characters. */
  length?: number;
  /** When the chunk was indexed (epoch ms). */
  indexedAt?: number;
  /**
   * License of the source. Required at ingestion time when `source` is `aosp`
   * or `oem_sdk` — the Plan 55 ingester must reject those chunks if license
   * is missing. Optional for blog / project_memory / world_memory /
   * case_library because those sources have implicit policies covered by
   * Plans 44 / 54.
   */
  license?: 'AGPL-3.0' | 'Apache-2.0' | 'CC-BY-4.0' | 'proprietary' | string;
  /** Freshness flag — true if older than the source's recommended refresh window. */
  stale?: boolean;
}

/**
 * Memory scope hierarchy — controls retention, sharing, and consolidation
 * policy for Plan 44 project memory and Plan 54 case library.
 *
 *   session → project → world
 *
 * Promotion between scopes must be explicit (see `MemoryPromotionTrigger`).
 * Auto-promotion is forbidden — `promote()` must reject any other trigger.
 */
export type MemoryScope =
  /** Ephemeral, dies with the analysis. Lives in `analysisPatternMemory.ts`. */
  | 'session'
  /** Persisted per-project (typically per app + device combo). */
  | 'project'
  /** Promoted to cross-project knowledge after explicit reviewer approval. */
  | 'world';

/**
 * Composite key shared by Plan 50 baselines and Plan 54 case nodes.
 *
 * Anonymization status of each component is the responsibility of the
 * containing record's `redactionState` field — `BaselineRecord` and
 * `CaseNode` both treat raw appId/deviceId as identifiable info.
 */
export interface PerfBaselineKey {
  /** App package or product id. */
  appId: string;
  /** Device fingerprint (model + Android version + SoC). */
  deviceId: string;
  /** Build identifier (git sha, version code, or branch). */
  buildId: string;
  /** Critical-User-Journey id, e.g. `cold_start` / `scroll_feed` / `anr_dispatch`. */
  cuj: string;
}

/**
 * Curation lifecycle status for cases (Plan 54) and baselines (Plan 50).
 *
 * Note: redaction state is a separate axis. Each record (CaseNode,
 * BaselineRecord) carries its own `redactionState: 'raw' | 'partial' |
 * 'redacted'` field. A case can be `published` only if `redactionState ===
 * 'redacted'` AND a curator has signed off (double-control gate).
 */
export type CurationStatus = 'draft' | 'reviewed' | 'published' | 'private';

/**
 * Cross-plan reference to a case node (Plan 54).
 *
 * Defined here, in shared base types, to break the circular dependency
 * between Plan 44 (FeedbackPipelineEntry → caseId) and Plan 54 (CaseNode
 * findings → memory entries). Both plans depend on `CaseRef` rather than
 * importing each other's contract types directly.
 */
export interface CaseRef {
  /** Stable case id from Plan 54's case library. */
  caseId: string;
  /** Optional snapshot of the case status at reference time. */
  status?: CurationStatus;
  /** Free-form note explaining why this case is referenced. */
  citationReason?: string;
}

/**
 * What triggered a memory promotion event (Plan 44).
 *
 * Auto-promotion is intentionally absent — `projectMemory.promote()` must
 * throw when given a trigger outside this union. The audit log relies on a
 * recorded human or eval-driven trigger for every cross-scope move.
 */
export type MemoryPromotionTrigger =
  /** User explicitly said "remember this" via feedback. */
  | 'user_feedback'
  /** Admin signed off via `/api/memory/promote` (reviewer required). */
  | 'reviewer_approval'
  /** Entry contributed to a passing eval case (Spark #95). */
  | 'skill_eval_pass';

/**
 * Audit record attached to every cross-scope memory promotion.
 *
 * Stored on the `ProjectMemoryEntry.promotionPolicy` field for entries
 * whose scope is `world` (required) and optionally on `project` entries
 * that were promoted (rather than created directly). Also appended to the
 * promotion audit log at `backend/logs/analysis_project_memory.json`.
 */
export interface MemoryPromotionPolicy {
  /** Source scope (lower in the hierarchy). */
  fromScope: MemoryScope;
  /** Target scope (higher). */
  toScope: MemoryScope;
  /** What triggered the promotion. */
  trigger: MemoryPromotionTrigger;
  /** Reviewer name when trigger='reviewer_approval'. */
  reviewer?: string;
  /** When the promotion happened (epoch ms). */
  promotedAt: number;
  /** Eval case id when trigger='skill_eval_pass'. */
  evalCaseId?: string;
}

// =============================================================================
// Plan 01 — Stdlib Catalog 与 Skill 覆盖率治理 (Spark #1, #21)
// =============================================================================

/**
 * Per-Skill prerequisite usage entry.
 * Reflects how a skill (composite or atomic) declared a stdlib module either
 * via YAML `prerequisites:` or via raw SQL inspected by `sqlIncludeInjector`.
 */
export interface StdlibSkillUsage {
  skillId: string;
  /** YAML-declared prerequisites. */
  declared: string[];
  /** Modules detected via raw SQL `INCLUDE PERFETTO MODULE` scanning. */
  detected: string[];
  /** Modules declared but never used in any SQL step. */
  declaredButUnused: string[];
  /** Modules used in SQL but not declared in YAML. */
  detectedButUndeclared: string[];
}

/**
 * Stdlib module metadata used by the Skill coverage report.
 * Sourced from `perfettoStdlibScanner` (packaged asset + on-disk source).
 */
export interface StdlibModuleEntry {
  module: string;
  /** Brief module summary if surfaced by the stdlib asset. */
  summary?: string;
  /** Number of skills declaring this module as a prerequisite. */
  declaredBySkills: number;
  /** Number of skills using this module via raw SQL. */
  usedBySkills: number;
  /** True if added since the last catalog snapshot — drives the watcher. */
  newSinceLastSnapshot?: boolean;
}

/**
 * StdlibSkillCoverageContract (Plan 01)
 *
 * Output of `analyzeStdlibSkillCoverage(...)`. Surfaced via:
 *  - `npm run validate:skills` summary block
 *  - MCP tool `list_stdlib_modules` (extension)
 *  - Plan doc snapshot when triaging Skill regressions
 */
export interface StdlibSkillCoverageContract extends SparkProvenance {
  /** Total stdlib modules visible from the scanner asset. */
  totalModules: number;
  /** Modules referenced by at least one Skill (declared OR detected). */
  modulesCovered: number;
  /** Skills with at least one undeclared-but-detected stdlib usage. */
  skillsWithDrift: number;
  /** Modules that no Skill references — Skill suggestion target. */
  uncoveredModules: StdlibModuleEntry[];
  /** Per-Skill drift report, used by the watcher. */
  skillUsage: StdlibSkillUsage[];
  /** Modules added in the most recent stdlib snapshot. */
  newlyAddedModules?: StdlibModuleEntry[];
  /** Spark coverage entries explaining what landed in this contract. */
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 02 — Trace Summary v2 与 Baseline Artifact (Spark #2, #22, #102)
// =============================================================================

/** Hierarchical detail levels for `trace_summary` v2 output. */
export type TraceSummaryLayer = 'L0' | 'L1' | 'L2' | 'L3';

/**
 * Single metric spec entry. Drives both `trace_summary()` baseline output and
 * downstream Skill comparisons. Schema kept minimal — value/unit/range only —
 * so older snapshots remain readable when new dimensions arrive.
 */
export interface TraceSummaryMetric {
  /** Stable metric id, e.g. `frames.jank_count.p95`. */
  metricId: string;
  /** Numeric value. Always paired with `unit`. */
  value: number;
  /** Unit string: `ns`, `ms`, `count`, `percent`, `bytes`, ... */
  unit: string;
  /** Optional ns range when the metric is bounded to a window. */
  range?: NsTimeRange;
  /** Layer this metric belongs to (L0 highest-level → L3 deepest). */
  layer: TraceSummaryLayer;
  /** Skill or stdlib module that produced the value. */
  source: string;
  /** Evidence pointer for AI quoting. */
  evidence?: SparkEvidenceRef;
  /** Why this metric is unavailable for this trace (when applicable). */
  unsupportedReason?: string;
}

/**
 * Baseline artifact descriptor. Baselines live in artifact storage; the
 * contract tracks references rather than embedding full payloads.
 */
export interface TraceSummaryBaselineRef {
  /** Stable baseline id (`<app>/<device>/<build>/<cuj>`). */
  baselineId: string;
  /** Artifact id holding the full snapshot. */
  artifactId: string;
  /** When the baseline was captured (epoch ms). */
  capturedAt: number;
  /** Number of traces aggregated into the baseline. */
  sampleCount?: number;
}

/**
 * TraceSummaryV2Contract (Plan 02)
 *
 * Output of `traceSummaryV2(traceId, options?)`. Surfaces:
 *  - Hierarchical L0-L3 metrics with provenance for each.
 *  - Baseline pointer for diff/regression flows (consumed by Plan 25 / 50).
 *  - `trace_processor_shell` build identifier (Spark #102 — engine continues
 *    to be canonical).
 *  - Probe results so callers can detect feature gaps without re-running the
 *    summary.
 */
export interface TraceSummaryV2Contract extends SparkProvenance {
  /** Trace processor build (semver or git sha). Captures #102 invariant. */
  traceProcessorBuild?: string;
  /** Whole-trace ns range covered by this summary. */
  traceRange: NsTimeRange;
  /** Probe results — true if the metric was producible on this trace. */
  probes: Record<string, boolean>;
  /** L0/L1/L2/L3 metrics in a flat array (layer is per-metric). */
  metrics: TraceSummaryMetric[];
  /** Optional baseline pointer when the request asked for diff context. */
  baseline?: TraceSummaryBaselineRef;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 03 — SmartPerfetto PerfettoSQL Package (Spark #3, #36)
// =============================================================================

/** Kind of SmartPerfetto-owned PerfettoSQL symbol. */
export type SmartPerfettoSqlSymbolKind =
  | 'function'
  | 'view'
  | 'table'
  | 'macro'
  | 'index';

/** Single symbol exported by the `smartperfetto.*` SQL package. */
export interface SmartPerfettoSqlSymbol {
  /** Fully qualified docs path, e.g. `smartperfetto.scrolling.jank_frames`. */
  name: string;
  /**
   * The actual SQL identifier callers use in `SELECT ... FROM <sqlName>`,
   * e.g. `smartperfetto_scrolling_jank_frames`. Codex review caught that
   * `name` is a dotted docs path which is not a valid Perfetto SQL
   * identifier; consumers must always quote `sqlName` in generated SQL.
   */
  sqlName: string;
  kind: SmartPerfettoSqlSymbolKind;
  /** Module file containing the definition (relative to package root). */
  module: string;
  /** Brief description for docs/agent prompt injection. */
  summary?: string;
  /** Function/macro signatures, table column lists. */
  signature?: string;
  /** stdlib modules this symbol depends on. */
  dependencies?: string[];
  /** Whether the symbol is considered stable for external consumers. */
  stability: 'experimental' | 'stable' | 'deprecated';
}

/**
 * SmartPerfettoSqlPackageContract (Plan 03)
 *
 * Output of `loadSmartPerfettoSqlPackage(...)`. Powers:
 *  - `--add-sql-package smartperfetto` boot path on `trace_processor_shell`.
 *  - sqlKnowledgeBase enrichment so the agent can recall canonical symbols.
 *  - validate:strategies catalog so prompt templates can quote symbol names
 *    without drifting from the actual SQL implementation.
 */
export interface SmartPerfettoSqlPackageContract extends SparkProvenance {
  /** Package version (semver). */
  packageVersion: string;
  /** Symbols exported by the package. */
  symbols: SmartPerfettoSqlSymbol[];
  /** Symbols intentionally omitted (e.g., legacy aliases). */
  removed?: SmartPerfettoSqlSymbol[];
  /** Boot command snippet used to register the package, for docs/MCP. */
  bootSnippet?: string;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 04 — Artifact Schema, Hierarchical Summarization, Compression
//          (Spark #24, #25, #26, #28)
// =============================================================================

/** Sampling/clustering strategy applied to a compressed artifact. */
export type ArtifactSamplingStrategy =
  | 'full'
  | 'top_k'
  | 'p95_tail'
  | 'p99_tail'
  | 'random'
  | 'cluster_representative'
  | 'cuj_window';

/** Per-column metadata required for schema-aware JSON output (Spark #28). */
export interface ArtifactColumnSpec {
  name: string;
  /** Semantic type aligned with `dataContract.ColumnType`. */
  type: string;
  /** Unit string (`ns`, `ms`, `bytes`, `count`, `percent`). */
  unit?: string;
  /** Where the value comes from (skill id, stdlib symbol, computation). */
  source?: string;
  /** Free-form note about sampling or clustering applied to the column. */
  samplingNote?: string;
}

/** Compression record so consumers can decide whether to fetch full payload. */
export interface ArtifactCompressionInfo {
  strategy: ArtifactSamplingStrategy;
  /** Original (pre-compression) row count. */
  originalRowCount: number;
  /** Row count after compression. */
  compressedRowCount: number;
  /** Effective sampling ratio (compressedRowCount / originalRowCount). */
  ratio: number;
  /** Window applied for `cuj_window` strategy. */
  window?: NsTimeRange;
  /** Top-K bound for `top_k` strategy. */
  topK?: number;
  /** Random seed for reproducibility on `random` strategy. */
  randomSeed?: number;
}

/**
 * ArtifactSchemaContract (Plan 04)
 *
 * Sidecar metadata attached to entries in the artifact store. The full data
 * remains in `ArtifactStore.fetch(id, 'full')`; this contract describes the
 * compressed view emitted to the LLM context window.
 */
export interface ArtifactSchemaContract extends SparkProvenance {
  /** Pointer to the artifact in `ArtifactStore`. */
  artifactId: string;
  /** Column-level schema; required for AI quoting (Spark #28). */
  columns: ArtifactColumnSpec[];
  /** Compression record. `strategy: 'full'` means no compression applied. */
  compression: ArtifactCompressionInfo;
  /** Time range covered by the artifact (CUJ window). */
  range?: NsTimeRange;
  /** When `top_k` or `p95_tail`, the metric used to rank rows. */
  rankBy?: string;
  /** Cluster representatives chosen by `cluster_representative` strategy. */
  clusterRepresentatives?: number[];
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 05 — Timeline Binning 与 Counter RLE Compression (Spark #23, #27)
// =============================================================================

/** Single binned bucket along a timeline axis. */
export interface TimelineBin {
  /** Inclusive start of the bucket in nanoseconds. */
  startNs: number;
  /** Bucket width in nanoseconds. */
  durNs: number;
  /** Aggregated value for the bucket (sum/avg/count depending on aggregation). */
  value: number;
  /** Count of source rows aggregated into this bin. */
  rowCount?: number;
}

/** RLE turning-point record for counter tracks (Spark #27). */
export interface CounterRleSegment {
  /** Inclusive start in nanoseconds of the constant-value segment. */
  startNs: number;
  /** Exclusive end in nanoseconds. */
  endNs: number;
  /** Counter value held across the segment. */
  value: number;
  /** Optional cumulative delta from prior segment (turning-point hint). */
  delta?: number;
}

/** Aggregation function used for timeline binning. */
export type TimelineBinAggregation = 'sum' | 'avg' | 'count' | 'max' | 'min';

/**
 * TimelineBinningContract (Plan 05)
 *
 * Compact representation of timeline-style data. Two flavours:
 *  - `bins[]` — uniformly bucketed stream values (Spark #23 token compression).
 *  - `rle[]` — run-length encoded counter trail with turning points (Spark #27).
 */
export interface TimelineBinningContract extends SparkProvenance {
  /** Track id this binning describes (`process_counter_track.id`, etc.). */
  trackId: string | number;
  /** Time range covered by the binning. */
  range: NsTimeRange;
  /** Bin width in nanoseconds when `bins[]` is present. */
  binDurNs?: number;
  aggregation?: TimelineBinAggregation;
  bins?: TimelineBin[];
  rle?: CounterRleSegment[];
  /** Original (pre-compression) sample count, for ratio reporting. */
  originalSampleCount: number;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 06 — Anonymization Mapping 与 Large-Trace Streaming (Spark #29, #30)
// =============================================================================

/** Domain of a redacted identifier. */
export type AnonymizationDomain =
  | 'package'
  | 'process'
  | 'thread'
  | 'path'
  | 'user_id'
  | 'device_id';

/** One identifier→placeholder mapping. */
export interface AnonymizationMapping {
  domain: AnonymizationDomain;
  /** Original (sensitive) identifier. */
  original: string;
  /** Stable placeholder used in the redacted output. */
  placeholder: string;
  /** Optional collision counter when multiple originals share a placeholder. */
  collisionIndex?: number;
}

/** Streaming pipeline progress for huge traces (Spark #30). */
export interface LargeTraceStreamProgress {
  /** Total bytes the importer is expected to process. */
  totalBytes: number;
  /** Bytes processed so far. */
  processedBytes: number;
  /** Streaming chunks emitted so far. */
  chunksEmitted: number;
  /** True when the entire trace has been ingested. */
  done: boolean;
  /** Per-chunk wall-time in ms (last chunk). */
  lastChunkMs?: number;
}

/**
 * AnonymizationContract (Plan 06)
 *
 * Container that travels with redacted artifacts. Holds:
 *  - Stable mappings so the same package always becomes the same placeholder.
 *  - Streaming progress when the trace is too large for in-memory ingestion.
 *  - Redaction state — `state: 'redacted'` is required before exporting to a
 *    public report; consumers must error otherwise.
 */
export interface AnonymizationContract extends SparkProvenance {
  /** Redaction state — drives downstream gating. */
  state: 'raw' | 'partial' | 'redacted';
  /** Per-domain mapping table. */
  mappings: AnonymizationMapping[];
  /** Domains that are still raw (not yet mapped). */
  pendingDomains?: AnonymizationDomain[];
  /** Streaming progress when ingesting >1GB traces. */
  streamProgress?: LargeTraceStreamProgress;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 07 — AI Trace Config Generator 与 Self-description Metadata
//          (Spark #53, #197, #201)
// =============================================================================

/**
 * Canonical Perfetto data source names. Verified against
 * `perfetto/docs/data-sources/*.md` and
 * `perfetto/protos/perfetto/config/data_source_config.proto`. Codex round 4
 * caught that earlier names like `android.frametimeline` and
 * `android.input` were not real — generated trace configs would silently
 * fail to capture frame/input data.
 */
export type PerfettoDataSourceId =
  | 'linux.ftrace'
  | 'linux.process_stats'
  | 'linux.sys_stats'
  | 'linux.system_info'
  | 'linux.sysfs_power'
  | 'android.surfaceflinger.frametimeline'
  | 'android.surfaceflinger.layers'
  | 'android.surfaceflinger.transactions'
  | 'android.input.inputevent'
  | 'android.power'
  | 'android.log'
  | 'android.network_packets'
  | 'android.java_hprof'
  | 'gpu.counters'
  | 'gpu.renderstages'
  | 'gpu.log'
  | 'vulkan.memory_tracker'
  | string; // allow forward-compat

/** Single trace config fragment. */
export interface PerfettoConfigFragment {
  /** Logical id of the data source. */
  dataSource: PerfettoDataSourceId;
  /** Human-readable rationale for inclusion. */
  reason: string;
  /** Optional knob set as `key: value` strings. */
  options?: Record<string, string>;
}

/** Custom slice / protobuf injection definition (Spark #53). */
export interface CustomSliceSpec {
  /** Stable slice name surfaced on the timeline. */
  name: string;
  /** Track this slice belongs to (process or async track id). */
  trackHint?: string;
  /** Schema fields the slice carries (mirrors atrace `args=`). */
  fields?: ArtifactColumnSpec[];
  /** Owning module / SDK that emits the slice. */
  emittedBy?: string;
}

/** Trace self-description metadata (Spark #201). */
export interface TraceSelfDescription extends SparkProvenance {
  /** App package the trace was captured against. */
  packageName?: string;
  /** Build id / git sha. */
  buildId?: string;
  /** CUJ scenario name (`cold_start`, `scroll_feed`, …). */
  cuj?: string;
  /** Device fingerprint (model + Android version + SoC). */
  device?: string;
  /** Hint describing how to interpret the trace ("startup", "anr", "scroll"). */
  intent?: string;
  /** Custom slices/markers expected to be present. */
  expectedCustomSlices?: CustomSliceSpec[];
}

/**
 * TraceConfigGeneratorContract (Plan 07)
 *
 * Output of `generateTraceConfig({intent})`. Surfaces:
 *  - Recommended data sources (#197 — AI generated trace config).
 *  - Custom slice schema (#53 — business-side instrumentation contract).
 *  - Self-description metadata embedded in the trace artifact (#201).
 */
export interface TraceConfigGeneratorContract extends SparkProvenance {
  /** Suggested config fragments. */
  fragments: PerfettoConfigFragment[];
  /** Custom slice / protobuf injection schema. */
  customSlices?: CustomSliceSpec[];
  /** Embedded self-description metadata for the captured trace. */
  selfDescription?: TraceSelfDescription;
  /** Compact rationale for the overall config. */
  rationale?: string;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 10 — Jank Decision Tree 与 FrameTimeline Ground Truth (Spark #16, #31)
// =============================================================================

/**
 * FrameTimeline jank_type values used as ground truth (Spark #16).
 * Mirrors `actual_frame_timeline_slice.jank_type` from Perfetto stdlib.
 */
export type FrameTimelineJankType =
  | 'None'
  | 'AppDeadlineMissed'
  | 'SurfaceFlingerCpuDeadlineMissed'
  | 'SurfaceFlingerGpuDeadlineMissed'
  | 'DisplayHAL'
  | 'PredictionError'
  | 'Buffer Stuffing'
  | 'BufferStuffing'
  | 'Unknown'
  | string;

/** Single node in the jank attribution decision tree. */
export interface JankDecisionNode {
  /** Stable node id used for route tracing. */
  nodeId: string;
  /** Short human-readable label. */
  label: string;
  /** Decision rule that selected this branch. */
  rule?: string;
  /** Skill id that produced the data backing this node. */
  skillId?: string;
  /** Evidence pointer for AI quoting. */
  evidence?: SparkEvidenceRef;
  /** Confidence in this branch's diagnosis. */
  confidence?: SparkConfidence;
  /** Children — empty when this is a terminal verdict. */
  children?: JankDecisionNode[];
}

/** Per-frame attribution row. */
export interface JankFrameAttribution {
  frameId: number | string;
  /** ns range of the frame slice. */
  range: NsTimeRange;
  /** FrameTimeline ground truth jank_type. */
  jankType: FrameTimelineJankType;
  /** Path of decision tree node ids that classified this frame. */
  routePath: string[];
  /** Reason code emitted by the analysis (e.g. `cpu_starvation`). */
  reasonCode?: string;
  /** Evidence pointers backing the reason code. */
  evidence?: SparkEvidenceRef[];
}

/**
 * JankDecisionTreeContract (Plan 10)
 *
 * Output of the scrolling Skill verdict layer. Anchors every diagnosis to
 * FrameTimeline `jank_type` so the agent can never blend
 * AppDeadlineMissed / SurfaceFlinger / DisplayHAL conclusions.
 */
export interface JankDecisionTreeContract extends SparkProvenance {
  /** Root of the decision tree (start of the routing). */
  root: JankDecisionNode;
  /** Per-frame attribution rows used to validate the tree. */
  frameAttributions: JankFrameAttribution[];
  /** Frames missing FrameTimeline ground truth (cannot be classified). */
  unclassifiedFrames?: JankFrameAttribution[];
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 11 — Thread State 与 Scheduler Context Priors (Spark #6, #17)
// =============================================================================

/** Per-thread runtime state breakdown over a window. */
export interface ThreadStateBreakdown {
  utid: number;
  /** Owning process pid (-1 if unknown). */
  pid: number;
  threadName: string;
  range: NsTimeRange;
  /** Aggregated durations by `thread_state.state` (Running, R, S, D, …). */
  durByStateNs: Record<string, number>;
  /** Total wakeup count in the window. */
  wakeupCount?: number;
  /** Sched runnable->Running latency p95 (ns). */
  runnableLatencyP95Ns?: number;
}

/** Wakeup edge in the wakeup graph (Spark #17). */
export interface SchedulerWakeupEdge {
  fromUtid: number;
  toUtid: number;
  fromThread?: string;
  toThread?: string;
  /** Wakeup ns timestamp. */
  ts: number;
  /** Latency until target thread runs (ns). */
  latencyNs?: number;
  /** Wakeup reason if available (irq, futex_wake, binder, …). */
  reason?: string;
}

/** Critical task chain entry (Spark #17). */
export interface CriticalTaskChainEntry {
  utid: number;
  threadName: string;
  /** ns range during which this thread was on the critical path. */
  range: NsTimeRange;
  /** Why this segment is on the critical path. */
  reason: string;
}

/**
 * ThreadSchedContextContract (Plan 11)
 *
 * Mandatory prior used by jank/ANR/startup decision trees. Without this
 * contract, downstream Skills must treat their conclusions as low-confidence
 * (Spark #6 — thread_state / sched.with_context as ground truth gate).
 */
export interface ThreadSchedContextContract extends SparkProvenance {
  /** Window the priors describe. */
  range: NsTimeRange;
  /** Per-thread breakdowns (typically focused on UI / RenderThread). */
  threadStates: ThreadStateBreakdown[];
  /** Wakeup graph edges intersecting the window. */
  wakeupEdges?: SchedulerWakeupEdge[];
  /** Ordered critical task chain (Spark #17 report-friendly view). */
  criticalChain?: CriticalTaskChainEntry[];
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 12 — Binder Victim→Server Root-cause Chain (Spark #7)
// =============================================================================

/** A single hop in the binder transaction chain. */
export interface BinderChainHop {
  /** Sequence index within the chain (0 = victim caller). */
  step: number;
  side: 'client' | 'server';
  /** Process+thread id pair. */
  pid: number;
  tid: number;
  process?: string;
  thread?: string;
  /** Binder method name if known. */
  method?: string;
  /** ns range for the hop slice. */
  range: NsTimeRange;
  /** Wait reason if the hop blocked (e.g. lock, IO, cpu_starvation). */
  blockedOn?: string;
  evidence?: SparkEvidenceRef;
}

/**
 * BinderRootCauseChainContract (Plan 12)
 *
 * Output of `binder_root_cause` deep skill. Renders the cross-process chain
 * from the user-visible victim caller all the way to the system server-side
 * blocker, anchored on `android.binder` stdlib slices.
 */
export interface BinderRootCauseChainContract extends SparkProvenance {
  /** Victim slice that triggered the analysis (UI-thread blocking call). */
  victim: BinderChainHop;
  /** Ordered server-side hops; chain[0] is the immediate callee. */
  chain: BinderChainHop[];
  /** Final root cause hop — usually chain[-1] when the chain terminates. */
  rootCause?: BinderChainHop;
  /** Why the chain could not be fully resolved (binder data missing, etc.). */
  truncated?: boolean;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 13 — CPU Frequency, Thermal, PMU Attribution
//          (Spark #8, #9, #10, #35)
// =============================================================================

/** CPU frequency residency entry — fraction of time at a given freq band. */
export interface CpuFreqResidency {
  cpu: number;
  freqHz: number;
  /** Time at this frequency in nanoseconds. */
  durNs: number;
  /** Fraction of the analysis window (0-1). */
  fraction: number;
}

/** Thermal counter sample (per zone). */
export interface ThermalSample {
  zone: string;
  ts: number;
  /** Temperature in millidegrees Celsius. */
  tempMc: number;
  /** Throttling state if known (0 = none, 1+ = throttling tier). */
  throttleStage?: number;
}

/** PMU / simpleperf-derived counter attribution row. */
export interface PmuAttributionRow {
  /** Counter id (`cycles`, `instructions`, `cache-misses`, …). */
  counter: string;
  utid?: number;
  process?: string;
  thread?: string;
  /** Aggregated counter value across the window. */
  value: number;
  /** Optional derived metric (`ipc`, `miss_rate`). */
  derived?: Record<string, number>;
}

/** Thermal throttling decision (Spark #35). */
export type ThermalDecision =
  | 'cool'
  | 'soft_throttle'
  | 'hard_throttle'
  | 'shutdown_imminent'
  | 'unknown';

/**
 * CpuThermalPmuContract (Plan 13)
 *
 * Combined attribution for CPU frequency / thermal / PMU. Skills can request
 * any subset; missing facets must surface as `unsupportedReason` rather than
 * being silently zero-filled.
 */
export interface CpuThermalPmuContract extends SparkProvenance {
  /** Window covered by the analysis. */
  range: NsTimeRange;
  /** Per-CPU frequency residency. */
  cpuFreqResidency?: CpuFreqResidency[];
  /** Thermal samples + decision. */
  thermalSamples?: ThermalSample[];
  thermalDecision?: ThermalDecision;
  /** PMU attribution rows. */
  pmuAttribution?: PmuAttributionRow[];
  /** Smooth vs jank window comparison hint (Spark #8). */
  smoothVsJankComparison?: {
    smoothFraction: number;
    jankFraction: number;
    delta: number;
  };
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 14 — Memory, LMK, DMA/DMABUF Root-cause Graph
//          (Spark #11, #12, #13, #34, #51, #70, #109, #112)
// =============================================================================

/** Per-process memory snapshot row. */
export interface ProcessMemorySnapshot {
  pid: number;
  process?: string;
  ts: number;
  rssBytes?: number;
  swapBytes?: number;
  anonRssBytes?: number;
  /** mm_event derived metrics (page faults, OOM score). */
  mmEvent?: Record<string, number>;
  oomScoreAdj?: number;
}

/** Low-memory-killer event. */
export interface LmkKillEvent {
  ts: number;
  pid: number;
  process?: string;
  oomScoreAdj?: number;
  reason?: string;
  /** Bytes freed by the kill. */
  freedBytes?: number;
}

/** DMA / dmabuf / ion allocation snapshot. */
export interface DmaBufAllocation {
  ts: number;
  bufferBytes: number;
  allocator: 'dmabuf' | 'ion' | 'gpu' | string;
  process?: string;
  /** Refcount when known. */
  refcount?: number;
}

/** External memory artifact (LeakCanary, KOOM, hprof, …). */
export interface MemoryExternalArtifact {
  /** Source kind. */
  kind: 'leak_canary' | 'koom' | 'hprof' | 'baseline' | 'manual' | string;
  /** Pointer to raw artifact in store. */
  artifactId?: string;
  /** Brief summary. */
  summary?: string;
  /** Retained-size in bytes when known. */
  retainedBytes?: number;
  evidence?: SparkEvidenceRef;
}

/**
 * MemoryRootCauseContract (Plan 14)
 *
 * Combines RSS/Swap/MM event timelines, LMK kill events, DMA/DMABUF pressure,
 * and pointers to external memory artifacts (LeakCanary / KOOM / hprof) so the
 * memory analysis Skill can render a unified root-cause graph.
 */
export interface MemoryRootCauseContract extends SparkProvenance {
  range: NsTimeRange;
  processSnapshots?: ProcessMemorySnapshot[];
  lmkEvents?: LmkKillEvent[];
  dmaAllocations?: DmaBufAllocation[];
  externalArtifacts?: MemoryExternalArtifact[];
  /** Baseline diff hint (Spark #34). */
  baselineDiff?: {
    baselineId: string;
    deltaBytes: number;
    /** Top contributors as `{key, deltaBytes}`. */
    topContributors?: Array<{key: string; deltaBytes: number}>;
  };
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 15 — IO, Network, Wakelock, Wakeup Attribution
//          (Spark #15, #18, #20, #56)
// =============================================================================

/** IO blocking event row (Spark #15). */
export interface IoBlockEvent {
  ts: number;
  durNs: number;
  process?: string;
  thread?: string;
  /** Filesystem operation (read, write, fsync, …). */
  op: string;
  /** Filename or device path when known. */
  path?: string;
  /** Bytes transferred. */
  bytes?: number;
  /** Filesystem driver (ext4, f2fs, …). */
  fs?: string;
}

/** Network packet/wait grouping. */
export interface NetworkAttribution {
  /** Local endpoint description. */
  endpoint: string;
  process?: string;
  ts: number;
  durNs: number;
  /** Protocol layer (`tcp`, `udp`, `http`). */
  protocol?: string;
  /** Bytes sent / received. */
  bytesIn?: number;
  bytesOut?: number;
  /** Wait reason matched to a thread state. */
  waitReason?: string;
}

/** Battery / wakelock baseline row (Spark #18). */
export interface WakelockBaselineRow {
  process?: string;
  uid?: number;
  /** Cumulative wake-time (ms). */
  totalMs: number;
  /** Wake count over baseline window. */
  wakeCount: number;
  /** Per-wake median duration (ms). */
  medianMs?: number;
}

/**
 * IoNetworkWakeupContract (Plan 15)
 *
 * Bundles IO, network and wakelock attribution. All facets optional so the
 * Skill can run on traces that captured only a subset.
 */
export interface IoNetworkWakeupContract extends SparkProvenance {
  range: NsTimeRange;
  ioEvents?: IoBlockEvent[];
  networkAttribution?: NetworkAttribution[];
  wakelockBaseline?: WakelockBaselineRow[];
  /** Wakeup edges that originated from IO / network (Spark #20). */
  wakeupEdges?: SchedulerWakeupEdge[];
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 16 — GPU, SurfaceFlinger, Composition Root Cause
//          (Spark #14, #19, #46, #65, #66, #106, #107)
// =============================================================================

/** GPU render-stage breakdown row (Spark #14). */
export interface GpuRenderStage {
  /** Stage name (`vertex_shading`, `fragment_shading`, `compute`, …). */
  stage: string;
  /** Aggregated duration on the GPU in ns. */
  durNs: number;
  /** Optional process attribution. */
  process?: string;
  /** Vendor-specific bucket (Mali / Adreno / PowerVR). */
  vendorBucket?: string;
}

/** SurfaceFlinger composition outcome row. */
export interface SurfaceFlingerComposition {
  vsyncId: number;
  ts: number;
  /** Whether HWC took the layer or composition fell back to GPU. */
  hwcFallback?: boolean;
  /** Whether buffer-stuffing was detected. */
  bufferStuffing?: boolean;
  /** Total composition duration on SF main thread (ns). */
  compositionDurNs?: number;
  /** Number of layers composited. */
  layerCount?: number;
}

/** GPU memory snapshot (Spark #14). */
export interface GpuMemorySnapshot {
  ts: number;
  process?: string;
  bytes: number;
  bucket?: string;
}

/** Vendor profiler import (Spark #65, #66, #106, #107). */
export interface GpuProfilerImport {
  /** Source kind: AGI / Mali / Snapdragon / PowerVR / GameBench. */
  kind: 'agi' | 'mali' | 'snapdragon' | 'powervr' | 'gamebench' | string;
  artifactId?: string;
  /** Time window covered by the import. */
  range?: NsTimeRange;
  /** Brief summary string. */
  summary?: string;
}

/**
 * GpuSurfaceFlingerContract (Plan 16)
 *
 * Joint root-cause contract for GPU + SurfaceFlinger + composition. Skills
 * fill in only the facets they trust; the remainder must use
 * `unsupportedReason` rather than zero-fill.
 */
export interface GpuSurfaceFlingerContract extends SparkProvenance {
  range: NsTimeRange;
  renderStages?: GpuRenderStage[];
  surfaceFlingerCompositions?: SurfaceFlingerComposition[];
  gpuMemory?: GpuMemorySnapshot[];
  vendorProfilerImports?: GpuProfilerImport[];
  /** Latency snapshot from `dumpsys SurfaceFlinger --latency` (Spark #46). */
  surfaceFlingerLatency?: {
    layerName: string;
    framesAnalyzed: number;
    p95DesiredPresentNs: number;
    droppedFrames: number;
  };
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 17 — Startup, ANR, Method-Trace Graph
//          (Spark #32, #33, #49, #68, #69, #72, #78, #132)
// =============================================================================

/** Startup phase identifier (mirrors `android.startup.startups` stdlib). */
export type StartupPhase =
  | 'process_create'
  | 'application_create'
  | 'first_activity_create'
  | 'first_frame'
  | 'reportFullyDrawn'
  | string;

/** Per-phase startup attribution row. */
export interface StartupPhaseRow {
  phase: StartupPhase;
  range: NsTimeRange;
  /** ART/JIT/dex2oat dur if known (Spark #132). */
  artVerifierDurNs?: number;
  jitDurNs?: number;
  classLoadingDurNs?: number;
  /** Compose recomposition storms during the phase (Spark #68). */
  recompositionCount?: number;
  /** App Startup library initializers fired (Spark #69). */
  initializersFired?: string[];
  evidence?: SparkEvidenceRef;
}

/** ANR attribution from `traces.txt` (Spark #49) merged with trace evidence. */
export interface AnrAttribution {
  process: string;
  /** ANR detection ts. */
  ts: number;
  /** Threads sampled in `traces.txt` snapshot. */
  threadSamples?: Array<{
    threadName: string;
    state: string;
    /** Top frame ids referencing the method-trace graph. */
    topFrames?: string[];
  }>;
  /** Why the ANR fired (input dispatch timeout, broadcast timeout, …). */
  reason?: string;
  /** Evidence link to method-trace graph. */
  methodTraceEvidence?: SparkEvidenceRef;
}

/**
 * Method-trace graph row (Spark #72, #78). Method-trace inputs come from
 * Matrix / BTrace / RheaTrace / KOOM or from bytecode instrumentation.
 */
export interface MethodTraceNode {
  id: string;
  method: string;
  /** Flat self-time across the window (ns). */
  selfNs: number;
  /** Total time including children (ns). */
  totalNs: number;
  /** Child node ids. */
  children?: string[];
  /** Source SDK that emitted the node. */
  source?: 'matrix' | 'btrace' | 'rheatrace' | 'koom' | 'bytecode' | string;
}

/**
 * StartupAnrMethodGraphContract (Plan 17)
 *
 * Combines startup decision tree, ANR attribution, and method-trace graph.
 * Skills can populate any subset; missing facets must surface as
 * `unsupportedReason`.
 */
export interface StartupAnrMethodGraphContract extends SparkProvenance {
  range: NsTimeRange;
  /** Startup phase rows (Spark #32, #68, #69, #132). */
  startupPhases?: StartupPhaseRow[];
  /** ANR attributions (Spark #33, #49). */
  anrAttributions?: AnrAttribution[];
  /** Method-trace nodes (Spark #72, #78). */
  methodTraceGraph?: MethodTraceNode[];
  /** Optional decision-tree summary mirroring jank tree shape. */
  decisionTree?: JankDecisionNode;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 18 — Domain Skill Regression & Ground-Truth Eval Harness
//          (Spark #61, #63, #67, #76, #87, #99)
// =============================================================================

/** Single eval case fixture row. */
export interface SkillEvalCase {
  /** Stable case id (`scrolling/jank/heavy_mixed`). */
  caseId: string;
  /** Path to the trace under test (relative to repo root). */
  tracePath: string;
  /** Composite skill or sub-agent under test. */
  skillId: string;
  /** Human-readable scenario description. */
  description?: string;
  /** Source of the ground truth (manual annotation, recorded baseline). */
  groundTruthSource?: string;
}

/** Ground-truth assertion against a Skill output. */
export interface SkillEvalAssertion {
  /** Path expression into the Skill output (`$.diagnostics[0].reason_code`). */
  path: string;
  /** Expected value or matcher description. */
  expected: string;
  /** Tolerance for numeric comparisons (absolute or fraction). */
  tolerance?: number;
  /** Why this assertion matters (root-cause label, missing-data signal). */
  rationale?: string;
}

/** Single run of an eval case. */
export interface SkillEvalRunResult {
  caseId: string;
  /** When the run was executed (epoch ms). */
  ranAt: number;
  /** Exit status. */
  status: 'pass' | 'fail' | 'flaky' | 'skipped';
  /** Number of assertions that passed. */
  assertionsPassed: number;
  /** Number of assertions that failed. */
  assertionsFailed: number;
  /** Per-assertion failure messages. */
  failures?: Array<{path: string; expected: string; actual: string}>;
  /** Wall-clock duration in ms. */
  durationMs?: number;
}

/** Sub-agent expansion entry for the harness (Spark #87). */
export interface SubAgentSpec {
  /** Stable sub-agent id (`scrolling-expert`, `binder-expert`). */
  id: string;
  /** Domain it specializes in. */
  domain: string;
  /** Mandatory eval cases for this sub-agent. */
  evalCases: string[];
}

/**
 * DomainSkillEvalContract (Plan 18)
 *
 * Schema for the eval harness that gates every domain Skill change. The
 * regression command (`npm run test:scene-trace-regression`) materialises
 * `SkillEvalRunResult[]` against the cases listed here.
 */
export interface DomainSkillEvalContract extends SparkProvenance {
  cases: SkillEvalCase[];
  /** Mapping from caseId → list of assertions. */
  assertions: Record<string, SkillEvalAssertion[]>;
  /** Sub-agent specifications referencing the cases above. */
  subAgents?: SubAgentSpec[];
  /** Latest run results for the contract. */
  runs?: SkillEvalRunResult[];
  /** External importer hooks (atrace, simpleperf, bpftrace, macrobenchmark). */
  importers?: Array<{
    /** `atrace | simpleperf | bpftrace | macrobenchmark | microbenchmark`. */
    kind: string;
    /** Whether the importer is required for the harness. */
    required: boolean;
    /** Brief description. */
    note?: string;
  }>;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 55 — androidperformance.com / AOSP / OEM SDK RAG (Spark #181-#183)
//
// Note: `RagSourceKind` and `RagDocumentRef` live in the first-tier shared
// base types block at the top of this file — Plan 44 also imports them.
// =============================================================================

/**
 * One indexed knowledge chunk in the RAG store.
 *
 * License is required at ingestion when `kind` is `aosp` or `oem_sdk`; the
 * Plan 55 ingester rejects those chunks if license is missing. For other
 * kinds (blog, project_memory, world_memory, case_library) license is
 * optional because the source has its own implicit policy.
 */
export interface RagChunk {
  /** Stable chunk id (sha-256 prefix of source + offset). */
  chunkId: string;
  /** Source kind — uses the strict enum from shared base types. */
  kind: RagSourceKind;
  /** Original URL or local path. */
  uri: string;
  /** Display title of the parent document. */
  title?: string;
  /** Tokenized snippet shown to the LLM. */
  snippet: string;
  /** Embedding vector if the ingester produced one. Length is model-specific. */
  embedding?: number[];
  /** Raw token count of the snippet (for context budgeting). */
  tokenCount?: number;
  /**
   * License of the source. Required for `aosp` / `oem_sdk` kinds.
   * Optional otherwise — see comment above.
   */
  license?: string;
  /** When the chunk was indexed (epoch ms). */
  indexedAt: number;
  /** Author or curator. */
  author?: string;
  /** When the source was last verified fresh (epoch ms). */
  verifiedAt?: number;
  /**
   * Why this chunk is unavailable for retrieval, e.g. `'license expired'`,
   * `'consent revoked'`, `'source 404'`. When set, retrieval must skip the
   * chunk but the entry stays for audit so previous citations remain
   * traceable.
   */
  unsupportedReason?: string;
}

/** A single retrieval hit — supports per-hit missing-data paths. */
export interface RagRetrievalHit {
  chunkId: string;
  /** Similarity score 0..1. */
  score: number;
  /** Optional when the hit could not be materialized at retrieval time. */
  chunk?: RagChunk;
  /**
   * Why this hit could not be materialized, e.g. `'chunk evicted'`,
   * `'license blocked at retrieval time'`. When set, `chunk` is expected to
   * be undefined and the agent must not invent content.
   */
  unsupportedReason?: string;
}

/**
 * Output of a single retrieval call. Carries provenance so consumers can
 * audit which kinds were probed and when.
 */
export interface RagRetrievalResult extends SparkProvenance {
  /** The query string used for retrieval. */
  query: string;
  /** Ranked hits — possibly empty if the whole retrieval failed. */
  results: RagRetrievalHit[];
  /** Which source kinds were probed in this retrieval call. */
  probed: RagSourceKind[];
  /** When the retrieval ran (epoch ms). */
  retrievedAt: number;
  // Note: `unsupportedReason` is inherited from SparkProvenance and indicates
  // whole-retrieval failure (e.g. `'index empty'`, `'all sources blocked by
  // license policy'`, `'embedding service unavailable'`). When set,
  // `results` is expected to be empty.
}

/**
 * AndroidperformanceAospRagContract (Plan 55)
 *
 * Surface of the RAG service. Tracks index population per source kind plus
 * the most recent retrieval result for inline citation by reports.
 */
export interface AndroidperformanceAospRagContract extends SparkProvenance {
  /** Number of chunks per source kind currently indexed. */
  index: Record<
    RagSourceKind,
    {chunkCount: number; lastIndexedAt?: number}
  >;
  /** Sample retrieval result attached when the contract is emitted via MCP. */
  lastRetrieval?: RagRetrievalResult;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a fresh provenance block for new contract objects. */
export function makeSparkProvenance(opts: {
  source: string;
  schemaVersion?: number;
  unsupportedReason?: string;
  notes?: string;
}): SparkProvenance {
  return {
    schemaVersion: opts.schemaVersion ?? 1,
    source: opts.source,
    createdAt: Date.now(),
    ...(opts.unsupportedReason ? {unsupportedReason: opts.unsupportedReason} : {}),
    ...(opts.notes ? {notes: opts.notes} : {}),
  };
}

/** Quick guard for "did the producer flag this contract as unsupported?". */
export function isUnsupported(contract: SparkProvenance): boolean {
  return Boolean(contract.unsupportedReason);
}
