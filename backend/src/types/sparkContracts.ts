// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto Spark Contracts
 *
 * Single source of truth for contract shapes introduced during the legacy
 * Spark buildout. The original planning history remains in git; downstream
 * services, Skills, MCP tools, UI panels, and reporters depend on this module.
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
 * @module sparkContracts
 */

import type {CaseKnowledgeExtension} from './caseKnowledge';

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

/** Per-Spark-number mapping recorded inside each contract for traceability. */
export interface SparkCoverageEntry {
  /** Spark idea number from the archived Spark planning package. */
  sparkId: number;
  /** Plan id (`01`-`57`) consuming the idea. */
  planId: string;
  /** Delivery status retained for compatibility with persisted Spark coverage. */
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
  | 'case_library'
  /** Codebase-aware analysis — user application source. */
  | 'app_source'
  /** Codebase-aware analysis — Linux kernel or vendor kernel source. */
  | 'kernel_source'
  /**
   * Retired: chunks the former Android Internals Wiki connector stored. They
   * stay listable and deletable; no writer stores the kind any more.
   */
  | 'android_internals_wiki';

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
  /** Path relative to the registered codebase root, when this chunk is source-backed. */
  filePath?: string;
  /** 1-based source line range covered by this chunk. */
  lineRange?: { start: number; end: number };
  /** Primary symbol/function/class represented by the chunk. */
  symbol?: string;
  /** Best-effort language tag for source-backed chunks. */
  language?: 'cpp' | 'c' | 'java' | 'kotlin' | 'rust' | 'go' | 'py' | 'unknown';
  /** Pinned source commit, when available. */
  commitHash?: string;
  /** Vendor tag for kernel/OEM sources. */
  vendor?: string;
  /** Build-id or equivalent artifact identity used to pin symbolization. */
  buildId?: string;
  /** Registered codebase id for user-configured source chunks. */
  codebaseId?: string;
  /** Registered external-knowledge source id for private document chunks. */
  knowledgeSourceId?: string;
  /** Immutable staged index generation; registry activation selects the readable generation. */
  sourceGeneration?: string;
  /** Opaque legacy-store scope binding for private knowledge; never project to clients or models. */
  knowledgeScopeFingerprint?: string;
  /** Upstream article workflow status, e.g. finalized or verified. */
  sourceStatus?: string;
  /** Upstream confidence label preserved for model caveats. */
  sourceConfidence?: string;
  /** Upstream platform/version boundary against which the article was last verified. */
  lastVerifiedAgainst?: string;
  /** Required human-readable attribution for externally licensed knowledge. */
  attribution?: string;
  /** Exact corpus content identity used alongside a possibly dirty Git revision. */
  contentFingerprint?: string;
  /** True when the source checkout contained changes beyond the recorded Git revision. */
  sourceDirty?: boolean;
  /** Tells consumers whether commitHash is clean, dirty-worktree context, or unavailable. */
  commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
  /** Origin that decides legacy-vs-scoped-private filtering. Missing old values are backfilled by RagStore. */
  registryOrigin?: 'codebase_registry' | 'external_knowledge_registry' |
    'legacy_plan55' | 'plan44_memory' | 'plan54_cases';
}

/**
 * Provenance for explanatory background knowledge. This is deliberately
 * separate from Trace evidence references: it cannot satisfy a SQL/Skill
 * evidence requirement or prove a current-trace claim.
 *
 * Historical: only the retired built-in Knowledge Pack produced these. They
 * stay because older sessions, reports and snapshots carry them and replay
 * them unchanged; no current run creates one.
 */
export interface BackgroundKnowledgeReference {
  sourceKind: 'android_internals_pack';
  packVersion: string;
  packFingerprint: string;
  sourceRevision: string;
  articleId: string;
  articleTitle: string;
  sectionId: string;
  sectionHeading: string;
  chunkId: string;
  chunkHash: string;
  license: string;
  confidence?: string;
  lastVerified?: string;
  lastVerifiedAgainst?: string;
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
// Plan 50 — App/Device/Build/CUJ Baseline Store
//          (Spark #34, #67, #105, #150, #176, #177, #178)
//
// Plan 50 adds durable persistence + cross-baseline diff + CI gate semantics
// on top of the baseline reference below.
// =============================================================================

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
 * Per-metric aggregate within a baseline. Numeric fields ignore meaning
 * when `unsupportedReason` is set — this keeps missing-data paths explicit
 * (e.g. metric not collected on this device, sample count below threshold).
 */
export interface BaselineMetric {
  /** Stable metric id, e.g. `frames.jank_count.p95`. */
  metricId: string;
  /** Unit string: `ns` | `ms` | `count` | `percent` | `bytes`. */
  unit: string;
  median: number;
  p95: number;
  p99: number;
  max: number;
  /** Sample count contributing to this metric. */
  sampleCount: number;
  /** Optional ns range when bounded to a window. */
  range?: NsTimeRange;
  /**
   * Why this metric is unavailable for this baseline. When set, consumers
   * must ignore the numeric fields above.
   */
  unsupportedReason?: string;
}

/**
 * A baseline is a curated aggregate over N traces matching the same key.
 *
 * Extends `TraceSummaryBaselineRef` so consumers do not see
 * a parallel `baselineId` / `sampleCount` / `capturedAt` shape. The base
 * type provides those fields; this contract adds curation, redaction,
 * window, and metrics.
 *
 * Note: `sampleCount` is optional via the base type. The Plan 50 service
 * layer (`baselineStore.ts`) enforces `sampleCount >= 3` when status
 * advances to `'published'`. The schema does not enforce that floor so
 * older snapshots remain readable.
 */
export interface BaselineRecord
  extends SparkProvenance,
    TraceSummaryBaselineRef {
  // Inherited from TraceSummaryBaselineRef:
  //   baselineId, artifactId, capturedAt, sampleCount?
  // New fields below.
  key: PerfBaselineKey;
  status: CurationStatus;
  /**
   * Redaction state. Must be `'redacted'` when published AND `key` carries
   * identifiable info (raw appId/deviceId). When the key is anonymized at
   * capture time, `'raw'` is acceptable for `published` status.
   */
  redactionState: 'raw' | 'partial' | 'redacted';
  /** First trace timestamp in the baseline window (epoch ms). */
  windowStartMs: number;
  /** Last trace timestamp in the baseline window (epoch ms). */
  windowEndMs: number;
  metrics: BaselineMetric[];
  /** Optional pointer to the SoC/OEM matrix this baseline belongs to. */
  matrixId?: string;
  /** Notes from the curator (manual annotation). */
  curatorNote?: string;
}

/**
 * Per-metric delta entry — supports missing-data paths via
 * `unsupportedReason`. When severity is `'unsupported'`, callers must
 * ignore the numeric fields.
 */
export interface BaselineDiffDelta {
  metricId: string;
  unit: string;
  /** Numeric fields are optional so missing-data paths remain visible. */
  baseValue?: number;
  candidateValue?: number;
  deltaAbs?: number;
  deltaPct?: number;
  /** Detected regression severity. `unsupported` when delta cannot be computed. */
  severity: 'none' | 'info' | 'warning' | 'regression' | 'unsupported';
  /**
   * Why this delta could not be computed, e.g. `'missing on baseline'`,
   * `'sample count below 3'`, `'divide-by-zero'`. Required when severity
   * is `'unsupported'`.
   */
  unsupportedReason?: string;
}

/** Diff between two baselines (or trace-vs-baseline). */
export interface BaselineDiffArtifact extends SparkProvenance {
  baseBaselineId: string;
  /** Either another baseline or a single trace under analysis. */
  candidate:
    | {kind: 'baseline'; id: string}
    | {kind: 'trace'; traceId: string};
  deltas: BaselineDiffDelta[];
  /** Top contributors to the largest regressions, ordered worst-first. */
  topRegressions?: Array<{
    metricId: string;
    deltaPct: number;
    evidence?: SparkEvidenceRef;
  }>;
}

/**
 * Regression gate output for CI integration (Spark #105).
 *
 * `diff` is optional when `status` is `'skipped'` — earlier drafts forced
 * a meaningless diff for skipped gates. The skipped gate must instead
 * record `skipReason` so triagers can audit why the gate did not run.
 */
export interface RegressionGateResult extends SparkProvenance {
  /** Stable gate id, e.g. `ci-pr-12345`. */
  gateId: string;
  baselineId: string;
  status: 'pass' | 'fail' | 'flaky' | 'skipped';
  /** Diff that drove the decision. Optional only when status is `'skipped'`. */
  diff?: BaselineDiffArtifact;
  /** Why the gate was skipped (only when status='skipped'). */
  skipReason?: string;
  /** Threshold rule that triggered (when status is `'fail'`). */
  rule?: {metricId: string; threshold: number; observed: number};
}

/**
 * BaselineStoreContract (Plan 50)
 *
 * Surface of the durable baseline store. Lists all baselines with
 * optional cross-baseline matrix descriptors for SoC/OEM comparison.
 */
export interface BaselineStoreContract extends SparkProvenance {
  baselines: BaselineRecord[];
  /** Cross-baseline matrices for SoC/OEM/build comparison (Spark #177, #178). */
  matrix?: Array<{
    matrixId: string;
    baselineIds: string[];
    description?: string;
  }>;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 44 — Project Memory, Hybrid RAG, Self-improvement (Spark #94, #95)
//
// Important: this contract does NOT modify the existing
// `analysisPatternMemory.ts` session-scope store. Plan 44 introduces an
// independent `projectMemory.ts` store for project + world scopes that
// reuses the same status state machine.
// =============================================================================

/**
 * Status state for memory entries.
 *
 * **MUST stay in sync** with `PatternStatus` in
 * `backend/src/agentv3/types.ts`. The two unions are intentionally
 * duplicated here to keep `backend/src/types/` independent of
 * `backend/src/agentv3/` (existing layer rule — only agentv3 imports from
 * types, not the reverse). When the agentv3 union changes, mirror the
 * change here.
 *
 * - `provisional` — freshly saved, no feedback yet
 * - `confirmed` — positive feedback OR auto-promoted after 24h without negatives
 * - `rejected` — user explicitly rejected the conclusion
 * - `disputed` — reverse feedback within 10s–24h window
 * - `disputed_late` — reverse feedback >24h after first feedback
 */
export type ProjectMemoryStatus =
  | 'provisional'
  | 'confirmed'
  | 'rejected'
  | 'disputed'
  | 'disputed_late';

/**
 * A memory entry scoped to project or world.
 *
 * Session-scope entries stay in `analysisPatternMemory.ts` (existing
 * 200-entry store with weighted Jaccard + supersede integration); this
 * contract is NOT used for session entries. Project + world entries live
 * in the new Plan 44 `projectMemory.ts` store.
 */
export interface ProjectMemoryEntry {
  /** Stable entry id (sha-256 prefix). */
  entryId: string;
  /** `'project'` or `'world'` — never `'session'`. */
  scope: MemoryScope;
  /** Stable project key — typically appId or appId+device. */
  projectKey?: string;
  /** Tag fingerprint (reuses analysisPatternMemory's tag taxonomy). */
  tags: string[];
  /** The recorded insight. */
  insight: string;
  /** Confidence 0..1. */
  confidence: number;
  /** Status — reuses the existing 5-state machine including `disputed_late`. */
  status: ProjectMemoryStatus;
  /** Hop count up the scope ladder (project → world consolidation). */
  promotionLevel?: number;
  /**
   * Promotion policy that authorized this entry's current scope.
   *
   * **Required** for any entry whose `scope` is `'world'` — the Plan 44
   * service layer (`projectMemory.saveProjectMemoryEntry`) must throw
   * when a world entry is saved without a policy. Optional on `project`
   * entries that were created directly (not promoted).
   */
  promotionPolicy?: MemoryPromotionPolicy;
  evidence?: SparkEvidenceRef[];
  createdAt: number;
  lastSeenAt?: number;
  /**
   * Why this entry is unavailable for retrieval. When set, recall and
   * RAG retrieval must skip this entry but the row stays for audit.
   */
  unsupportedReason?: string;
}

/**
 * Feedback → case → skill draft pipeline state (Spark #95).
 *
 * Tracks the lifecycle of a feedback signal as it gets enriched into a
 * case draft, then a skill draft, then reviewed and merged or rejected.
 */
export interface FeedbackPipelineEntry {
  entryId: string;
  /** Source feedback id (in selfImprove/feedbackEnricher). */
  feedbackId: string;
  /** Stage in the pipeline. */
  stage:
    | 'feedback'
    | 'case_draft'
    | 'skill_draft'
    | 'reviewed'
    | 'merged'
    | 'rejected';
  /**
   * Reference to the case generated by this feedback. Uses the shared
   * `CaseRef` from base types so this contract does not depend on
   * Plan 54's CaseNode shape (breaks the #44 ↔ #54 schema cycle).
   */
  case?: CaseRef;
  /** Generated skill draft id, if any. */
  skillDraftId?: string;
  /** Reviewer name when stage advances to reviewed/merged/rejected. */
  reviewer?: string;
  /** When the pipeline last advanced (epoch ms). */
  updatedAt: number;
}

/**
 * MemoryRagSelfImprovementContract (Plan 44)
 *
 * Surface of the project memory + RAG + self-improvement layer. Sits
 * alongside the existing session-scope `analysisPatternMemory.ts`.
 *
 * Storage location for project + world entries:
 * `backend/logs/analysis_project_memory.json` with shape
 * `{entries: ProjectMemoryEntry[], promotionAudit: ...}` (see Plan 44
 * §4.3 in the design doc for the audit log layout).
 */
export interface MemoryRagSelfImprovementContract extends SparkProvenance {
  /** Project + world memory entries (session entries stay elsewhere). */
  entries: ProjectMemoryEntry[];
  /** Active feedback pipeline entries. */
  pipeline: FeedbackPipelineEntry[];
  /** Optional retrieval cache populated by the orchestrator. */
  recentRetrievals?: RagRetrievalResult[];
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 54 — Case Graph, Public Case Library
//          (Spark #162, #179, #180, #195, #196, #203)
// =============================================================================

/**
 * Educational level used by the case browser (Spark #162).
 *
 * Drives default filters for the public case library and the "导览模式"
 * walkthrough — junior developers see novice-tagged cases first.
 */
export type CaseEducationalLevel = 'novice' | 'intermediate' | 'advanced';

/**
 * Severity of a finding linked to a case node. Mirrors the lightweight
 * severity vocabulary used across SmartPerfetto reports.
 */
export type CaseFindingSeverity = 'info' | 'warning' | 'critical';

/**
 * One finding link inside a case node — the analyst's claim about the
 * underlying trace, with optional evidence pointer.
 */
export interface CaseFindingLink {
  /** Stable finding id. */
  id: string;
  severity: CaseFindingSeverity;
  /** Short human-readable title. */
  title: string;
  evidence?: SparkEvidenceRef;
}

/**
 * A single case = curated trace + analysis snapshot + curation metadata.
 *
 * Publishing gate is double-controlled: a case can be `status='published'`
 * only when `redactionState='redacted'` AND `curatedBy` is set
 * (a curator has signed off). Anonymizer alone is not enough — see
 * §5.2 in the design doc for the boundary.
 */
export interface CaseNode extends SparkProvenance {
  caseId: string;
  /** Title for the browsing UI. */
  title: string;
  /** Curation status — uses `CurationStatus` from base types. */
  status: CurationStatus;
  /** Composite key matching the baseline namespace (when applicable). */
  key?: PerfBaselineKey;
  /**
   * Anonymization state. Tracked separately from `status` so an
   * in-review case can move toward redaction without flipping the
   * curation lifecycle.
   */
  redactionState: 'raw' | 'partial' | 'redacted';
  /**
   * Pointer to the original trace artifact (or anonymized copy when
   * published). Optional because archived / consent-revoked cases stay
   * in the library as read-only metadata. See `traceUnavailableReason`.
   */
  traceArtifactId?: string;
  /**
   * Why the trace artifact is unavailable, e.g. `'archived after 90 days'`,
   * `'evicted from artifact store'`, `'consent revoked'`. When set,
   * `traceArtifactId` may be undefined and consumers must treat the
   * case as read-only metadata.
   */
  traceUnavailableReason?: string;
  /** Pointer to the analysis report artifact. */
  reportArtifactId?: string;
  /** Tags for category filtering. */
  tags: string[];
  /** Linked findings — top-level claim ids. */
  findings: CaseFindingLink[];
  /** Curator name (required for `status='published'`). */
  curatedBy?: string;
  /** When curated (epoch ms). */
  curatedAt?: number;
  /** Educational level (Spark #162). */
  educationalLevel?: CaseEducationalLevel;
  /** Rich curated-case payload derived from Markdown knowledge sources. */
  knowledge?: CaseKnowledgeExtension;
}

/**
 * A relation between two cases in the case graph.
 *
 * Edges are directional — the relation often is too (e.g.
 * `before_after_fix` from old to fixed case). Symmetric relations
 * (`similar_root_cause`) should be stored once with a documented
 * "canonical from-side" rule rather than mirrored.
 */
export interface CaseEdge {
  edgeId: string;
  fromCaseId: string;
  toCaseId: string;
  /** Relation kind. The string union below lists the canonical relations. */
  relation:
    | 'similar_root_cause'
    | 'same_app'
    | 'same_device'
    | 'before_after_fix'
    | 'derived_pattern'
    | 'contradicts'
    | string;
  /** Confidence 0..1. */
  weight?: number;
  /** Free-form note from the curator. */
  note?: string;
}

/**
 * CaseGraphLibraryContract (Plan 54)
 *
 * Surface of the case library + graph. `lastPublishedAt` is set when the
 * library is exported as a public bundle (Spark #180); private and
 * draft cases never affect this timestamp.
 */
export interface CaseGraphLibraryContract extends SparkProvenance {
  cases: CaseNode[];
  edges: CaseEdge[];
  /** When the library was last exported as a public bundle (Spark #180). */
  lastPublishedAt?: number;
  coverage: SparkCoverageEntry[];
}

// =============================================================================
// Plan 41 — Standalone SmartPerfetto MCP Server / A2A / Host API
//          (Spark #91, #92, #96, #133, #139, #173)
//
// Architecture note: the existing in-process MCP server uses
// `createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk` and registers
// short tool names. The `MCP_NAME_PREFIX = 'mcp__smartperfetto__'`
// constant is purely an SDK `allowedTools` prefix — NOT a tool name.
// Plan 41 introduces a `mcpToolRegistry` that holds short names, plus a
// stdio adapter that exposes them as native MCP tools. The SDK adapter
// generates the prefix when it builds `allowedTools`. See §4.5 in the
// design doc for the full migration plan.
// =============================================================================

/**
 * Tool exposure level. Drives whether external hosts (Claude Code,
 * Cursor, Codex via stdio) and remote A2A peers see the tool.
 *
 * - `public` — safe for any host.
 * - `public-readonly` — externally visible read-only metadata tool.
 * - `internal` — agentv3 protocol tools (plan / hypothesis / note
 *   updates). Writing them from an external host would corrupt the
 *   active session.
 * - `requires_codebase_permission` — only visible inside a request/session
 *   with codebase permission; never exposed via stdio/A2A.
 * - `deprecated` — kept for compatibility, hidden from public surface.
 */
export type McpToolExposure =
  | 'public'
  | 'public-readonly'
  | 'internal'
  | 'requires_codebase_permission'
  | 'deprecated';

/**
 * ACI — Agent-Callable Interface descriptor (Spark #96).
 *
 * One per tool. Used by the standalone MCP server to advertise tools
 * to external hosts and by the SDK adapter to construct `allowedTools`
 * lists.
 */
export interface McpToolAci {
  /** Short name as registered in `mcpToolRegistry`, e.g. `invoke_skill`. */
  toolName: string;
  /** Fully qualified name with SDK prefix, e.g. `mcp__smartperfetto__invoke_skill`. */
  qualifiedName: string;
  exposure: McpToolExposure;
  /** Brief description for agent system prompts. */
  summary: string;
  /** JSON-schema fragment for the input args (Zod-derived in practice). */
  inputSchema?: unknown;
  /** Example payloads pulled from the existing tool description. */
  examples?: Array<{args: unknown; expected?: unknown}>;
  /** Required env vars or capability flags, e.g. `['traceProcessor']`. */
  requires?: string[];
}

/**
 * A2A AgentCard descriptor (Spark #92).
 *
 * Advertises the SmartPerfetto agent's capabilities to remote callers.
 * `trustLevel` controls the handshake required before tool calls are
 * accepted; `private` cards require a signed key exchange before any
 * exposed tool is callable from the remote peer.
 */
export interface A2aAgentCard {
  /** Stable card id, e.g. `smartperfetto-perf-analyst`. */
  cardId: string;
  /** Display name shown in remote agent UIs. */
  displayName: string;
  /** Capabilities advertised to remote callers. */
  capabilities: string[];
  /** Trust level — `public` (open) | `partner` (signed) | `private` (handshake). */
  trustLevel: 'public' | 'partner' | 'private';
  /** Subset of the `McpToolAci.toolName` set exposed via A2A. */
  tools: string[];
  /** Public key fingerprint for `partner` / `private` cards. */
  publicKey?: string;
}

/**
 * McpPublicApiContract (Plan 41)
 *
 * Surface of the standalone MCP server + A2A capabilities. Lists every
 * registered tool with its ACI plus any active A2A agent cards.
 */
export interface McpPublicApiContract extends SparkProvenance {
  /** Every tool registered in `mcpToolRegistry`, regardless of exposure. */
  tools: McpToolAci[];
  /** A2A agent cards — empty when A2A is disabled (default). */
  agentCards?: A2aAgentCard[];
  /** Server semver. */
  serverVersion: string;
  /** MCP protocol version the server speaks. */
  protocolVersion: string;
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
