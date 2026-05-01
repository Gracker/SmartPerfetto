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
  /** Fully qualified name, e.g. `smartperfetto.scrolling.jank_frames`. */
  name: string;
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
