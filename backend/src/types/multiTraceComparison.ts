// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export const ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION = 'analysis_result_snapshot@1' as const;
export const COMPARISON_MATRIX_SCHEMA_VERSION = 'comparison_matrix@1' as const;
export const MULTI_TRACE_COMPARISON_RUN_SCHEMA_VERSION = 'multi_trace_comparison_run@1' as const;

export type AnalysisResultVisibility = 'private' | 'workspace';

export type AnalysisResultSceneType =
  | 'startup'
  | 'scrolling'
  | 'interaction'
  | 'memory'
  | 'cpu'
  | 'general';

export type AnalysisResultSnapshotStatus = 'ready' | 'partial' | 'failed';

export type NormalizedMetricUnit =
  | 'ms'
  | 'fps'
  | '%'
  | 'count'
  | 'bytes'
  | 'ns'
  | 'mhz'
  | 'text';

export type NormalizedMetricDirection =
  | 'lower_is_better'
  | 'higher_is_better'
  | 'neutral';

export type NormalizedMetricAggregation =
  | 'p50'
  | 'p90'
  | 'p95'
  | 'p99'
  | 'avg'
  | 'max'
  | 'sum'
  | 'single';

export type NormalizedMetricSourceType =
  | 'skill'
  | 'sql'
  | 'agent_conclusion'
  | 'report'
  | 'manual'
  | 'backfill';

export type StandardComparisonMetricKey =
  | 'startup.total_ms'
  | 'startup.first_frame_ms'
  | 'startup.bind_application_ms'
  | 'startup.activity_start_ms'
  | 'startup.main_thread_blocked_ms'
  | 'scrolling.avg_fps'
  | 'scrolling.frame_count'
  | 'scrolling.jank_count'
  | 'scrolling.jank_rate_pct'
  | 'scrolling.p50_frame_ms'
  | 'scrolling.p95_frame_ms'
  | 'scrolling.p99_frame_ms'
  | 'cpu.main_thread_running_ms'
  | 'cpu.main_thread_runnable_ms'
  | 'cpu.big_core_pct'
  | 'cpu.avg_freq_mhz'
  | 'trace.duration_ms'
  | 'trace.device_model'
  | 'trace.android_version'
  | 'trace.capture_config_summary';

export type ComparisonMetricKey = StandardComparisonMetricKey | (string & {});

export interface NormalizedMetricDefinition {
  key: StandardComparisonMetricKey;
  label: string;
  group: string;
  unit: NormalizedMetricUnit;
  direction: NormalizedMetricDirection;
  aggregation: NormalizedMetricAggregation;
}

export const STANDARD_COMPARISON_METRICS: readonly NormalizedMetricDefinition[] = [
  { key: 'startup.total_ms', label: 'Startup total duration', group: 'startup', unit: 'ms', direction: 'lower_is_better', aggregation: 'single' },
  { key: 'startup.first_frame_ms', label: 'First frame duration', group: 'startup', unit: 'ms', direction: 'lower_is_better', aggregation: 'single' },
  { key: 'startup.bind_application_ms', label: 'Bind application duration', group: 'startup', unit: 'ms', direction: 'lower_is_better', aggregation: 'single' },
  { key: 'startup.activity_start_ms', label: 'Activity start duration', group: 'startup', unit: 'ms', direction: 'lower_is_better', aggregation: 'single' },
  { key: 'startup.main_thread_blocked_ms', label: 'Main thread blocked duration', group: 'startup', unit: 'ms', direction: 'lower_is_better', aggregation: 'sum' },
  { key: 'scrolling.avg_fps', label: 'Average FPS', group: 'fps', unit: 'fps', direction: 'higher_is_better', aggregation: 'avg' },
  { key: 'scrolling.frame_count', label: 'Frame count', group: 'fps', unit: 'count', direction: 'neutral', aggregation: 'sum' },
  { key: 'scrolling.jank_count', label: 'Jank frame count', group: 'jank', unit: 'count', direction: 'lower_is_better', aggregation: 'sum' },
  { key: 'scrolling.jank_rate_pct', label: 'Jank rate', group: 'jank', unit: '%', direction: 'lower_is_better', aggregation: 'avg' },
  { key: 'scrolling.p50_frame_ms', label: 'P50 frame duration', group: 'fps', unit: 'ms', direction: 'lower_is_better', aggregation: 'p50' },
  { key: 'scrolling.p95_frame_ms', label: 'P95 frame duration', group: 'fps', unit: 'ms', direction: 'lower_is_better', aggregation: 'p95' },
  { key: 'scrolling.p99_frame_ms', label: 'P99 frame duration', group: 'fps', unit: 'ms', direction: 'lower_is_better', aggregation: 'p99' },
  { key: 'cpu.main_thread_running_ms', label: 'Main thread running time', group: 'cpu', unit: 'ms', direction: 'lower_is_better', aggregation: 'sum' },
  { key: 'cpu.main_thread_runnable_ms', label: 'Main thread runnable time', group: 'cpu', unit: 'ms', direction: 'lower_is_better', aggregation: 'sum' },
  { key: 'cpu.big_core_pct', label: 'Big core residency', group: 'cpu', unit: '%', direction: 'neutral', aggregation: 'avg' },
  { key: 'cpu.avg_freq_mhz', label: 'Average CPU frequency', group: 'cpu', unit: 'mhz', direction: 'neutral', aggregation: 'avg' },
  { key: 'trace.duration_ms', label: 'Trace duration', group: 'environment', unit: 'ms', direction: 'neutral', aggregation: 'single' },
  { key: 'trace.device_model', label: 'Device model', group: 'environment', unit: 'text', direction: 'neutral', aggregation: 'single' },
  { key: 'trace.android_version', label: 'Android version', group: 'environment', unit: 'text', direction: 'neutral', aggregation: 'single' },
  { key: 'trace.capture_config_summary', label: 'Capture config', group: 'environment', unit: 'text', direction: 'neutral', aggregation: 'single' },
] as const;

export const STANDARD_COMPARISON_METRIC_KEYS = STANDARD_COMPARISON_METRICS.map(metric => metric.key);

export interface TraceComparisonMetadata {
  appPackage?: string;
  processName?: string;
  deviceModel?: string;
  androidVersion?: string;
  buildFingerprint?: string;
  captureConfigSummary?: string;
  traceDurationMs?: number;
  traceSizeBytes?: number;
  startedAtNs?: number;
  endedAtNs?: number;
  [key: string]: unknown;
}

export interface AnalysisSummary {
  headline: string;
  details?: string[];
  risks?: string[];
  recommendations?: string[];
  confidence?: number;
  partialReasons?: string[];
  analysisReceipt?: import('./dataContract').AnalysisReceipt;
  uiActionProposals?: import('./dataContract').UiActionProposalV1[];
}

export interface NormalizedMetricSource {
  type: NormalizedMetricSourceType;
  skillId?: string;
  stepId?: string;
  dataEnvelopeId?: string;
  reportId?: string;
  messageId?: string;
  sql?: string;
  backfillRunId?: string;
}

export interface NormalizedMetricValue {
  key: ComparisonMetricKey;
  label: string;
  group: string;
  value: number | string | null;
  unit?: NormalizedMetricUnit;
  direction?: NormalizedMetricDirection;
  aggregation?: NormalizedMetricAggregation;
  confidence: number;
  missingReason?: string;
  source: NormalizedMetricSource;
}

export type EvidenceRefType =
  | 'snapshot_metric'
  | 'data_envelope'
  | 'skill_step'
  | 'report'
  | 'agent_event'
  | 'trace_backfill';

export interface EvidenceRef {
  id: string;
  type: EvidenceRefType;
  label?: string;
  snapshotId?: string;
  metricKey?: ComparisonMetricKey;
  dataEnvelopeId?: string;
  reportId?: string;
  runId?: string;
  eventCursor?: number;
  url?: string;
  metadata?: Record<string, unknown>;
}

export type SimilarityHintSource = 'analysis_result_snapshot' | 'case_library';
export type SimilarityHintBand = 'strong' | 'partial' | 'background';

export interface SimilarityMatchReason {
  feature: string;
  currentValue?: string | number | boolean;
  matchedValue?: string | number | boolean;
  weight: number;
}

export interface SimilarityHintV1 {
  schemaVersion: 1;
  id: string;
  source: SimilarityHintSource;
  sourceId: string;
  score: number;
  band: SimilarityHintBand;
  matchReasons: SimilarityMatchReason[];
  limitations: string[];
  allowedUse: 'navigation_hint_only';
}

export interface TraceSimilarityCaseQuery {
  scene: string;
  domainPack: string;
  rootCause: string;
  secondaryRootCauses?: string[];
  responsibility?: import('./caseKnowledge').CaseKnowledgeResponsibility;
  audiences?: Array<'app' | 'oem'>;
}

export interface TraceSimilaritySignatureV1 {
  schemaVersion: 1;
  sceneType?: AnalysisResultSceneType;
  appPackage?: string;
  processName?: string;
  deviceModel?: string;
  androidVersion?: string;
  buildFingerprintPrefix?: string;
  traceDurationMs?: number;
  traceSizeBytes?: number;
  metrics: Record<string, number>;
  categoricalSignals: Record<string, string | boolean>;
  caseEvidenceSignatures: Record<string, unknown>;
  caseQuery?: TraceSimilarityCaseQuery;
}

export interface AnalysisResultSnapshot {
  id: string;
  tenantId: string;
  workspaceId: string;
  traceId: string;
  sessionId: string;
  runId: string;
  reportId?: string;
  createdBy?: string;
  visibility: AnalysisResultVisibility;
  sceneType: AnalysisResultSceneType;
  title: string;
  userQuery: string;
  traceLabel: string;
  traceMetadata: TraceComparisonMetadata;
  summary: AnalysisSummary;
  conclusionContract?: unknown;
  claimSupport?: import('./evidenceContract').ClaimSupportV1[];
  claimVerificationResult?: import('./claimVerification').ClaimVerificationResult;
  identityResolutions?: import('./identityContract').IdentityResolutionV1[];
  capabilityManifest?: import('./capabilityManifest').CapabilityManifestAttributionV1;
  metrics: NormalizedMetricValue[];
  evidenceRefs: EvidenceRef[];
  status: AnalysisResultSnapshotStatus;
  schemaVersion: typeof ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION;
  createdAt: number;
  expiresAt?: number;
}

export interface AnalysisResultWindowState {
  tenantId: string;
  workspaceId: string;
  windowId: string;
  userId?: string;
  traceId?: string;
  backendTraceId?: string;
  activeSessionId?: string;
  latestSnapshotId?: string;
  traceTitle?: string;
  sceneType?: AnalysisResultSceneType;
  metadata?: Record<string, unknown>;
  updatedAt: number;
  expiresAt: number;
}

export interface ComparisonMatrixInput {
  snapshotId: string;
  traceId: string;
  title: string;
  traceLabel: string;
  sceneType: AnalysisResultSceneType;
  userQuery: string;
  visibility: AnalysisResultVisibility;
  createdBy?: string;
  createdAt: number;
  traceMetadata: TraceComparisonMetadata;
}

export interface ComparisonMatrixCell {
  snapshotId: string;
  metricKey: ComparisonMetricKey;
  value: number | string | null;
  numericValue?: number;
  unit?: NormalizedMetricUnit;
  confidence: number;
  missingReason?: string;
  source: NormalizedMetricSource;
}

export interface ComparisonDelta {
  snapshotId: string;
  baselineSnapshotId: string;
  metricKey: ComparisonMetricKey;
  deltaValue: number | null;
  deltaPct: number | null;
  direction: NormalizedMetricDirection;
  assessment: 'better' | 'worse' | 'same' | 'unknown';
}

export interface ComparisonMatrixRow {
  metricKey: ComparisonMetricKey;
  label: string;
  group: string;
  unit?: NormalizedMetricUnit;
  direction: NormalizedMetricDirection;
  baseline?: ComparisonMatrixCell;
  cells: ComparisonMatrixCell[];
  deltas: ComparisonDelta[];
  missingSnapshotIds: string[];
}

export interface ComparisonMatrixGroup {
  group: string;
  rowMetricKeys: ComparisonMetricKey[];
  rowCount: number;
  significantChangeCount: number;
  missingMetricCount: number;
  defaultCollapsed: boolean;
}

export interface ComparisonMatrix {
  schemaVersion: typeof COMPARISON_MATRIX_SCHEMA_VERSION;
  inputSnapshots: ComparisonMatrixInput[];
  baselineSnapshotId?: string;
  rows: ComparisonMatrixRow[];
  groups: ComparisonMatrixGroup[];
  evidenceRefs: EvidenceRef[];
  missingMatrix: Record<string, Record<string, string>>;
  warnings: string[];
  createdAt: number;
}

export interface ComparisonConclusion {
  source?: 'deterministic' | 'ai';
  model?: string;
  generatedAt?: number;
  verifiedFacts: string[];
  inferences: string[];
  recommendations: string[];
  uncertainty: string[];
}

export interface ComparisonResult {
  matrix: ComparisonMatrix;
  conclusion: ComparisonConclusion;
  significantChanges: ComparisonDelta[];
  reportId?: string;
  reportUrl?: string;
  reportExportUrl?: string;
}

export type MultiTraceComparisonRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_selection';

export interface MultiTraceComparisonRun {
  id: string;
  tenantId: string;
  workspaceId: string;
  createdBy?: string;
  inputSnapshotIds: string[];
  baselineSnapshotId?: string;
  query: string;
  metricKeys?: ComparisonMetricKey[];
  status: MultiTraceComparisonRunStatus;
  result?: ComparisonResult;
  reportId?: string;
  error?: string;
  schemaVersion: typeof MULTI_TRACE_COMPARISON_RUN_SCHEMA_VERSION;
  createdAt: number;
  completedAt?: number;
}
