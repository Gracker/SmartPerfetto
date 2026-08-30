// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import 'dotenv/config';

import {createHash, randomBytes, randomInt} from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import http, {type IncomingMessage, type RequestOptions} from 'http';
import os from 'os';
import path from 'path';
import {performance as nodePerformance} from 'perf_hooks';
import {Readable} from 'stream';

import type {ConclusionContract} from '../agent/core/conclusionContract';
import {
  isProductionAgentRuntimeKind,
  PRODUCTION_RUNTIME_KINDS,
  type AgentRuntimeKind,
} from '../agentRuntime/runtimeKinds';
import type {
  RuntimePerformancePhaseReceiptV1,
  RuntimePerformanceReceiptV1,
} from '../agentRuntime/runtimePerformance';
import {canonicalContentHash, canonicalJsonString} from '../services/selfEvolution/canonicalJson';

export type BenchmarkSampleKind = 'real' | 'deterministic';
export type BenchmarkJudgmentStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export type BenchmarkCandidate = 'task4' | 'task5' | 'task6' | 'task7' | 'task8' | 'task9';
export type BenchmarkScenarioId = 'startup-full' | 'scrolling-full' | 'identity-fast';
export type BenchmarkExecutionProvenance = 'synthetic_scorer' | 'genuine_adapter' | 'real_provider';

export const CANDIDATE_TARGET_PHASES: Readonly<Record<BenchmarkCandidate, readonly RuntimePerformancePhaseReceiptV1['name'][]>> = {
  task4: ['quick_evidence', 'focus'],
  task5: [],
  task6: ['classification', 'comparison', 'skill_registry', 'knowledge', 'provider', 'verification'],
  task7: ['sdk_start', 'provider', 'correction'],
  task8: ['provider'],
  task9: ['skill_registry', 'sdk_start', 'provider'],
};

const CANDIDATE_RUNTIME_MATRIX: Readonly<Record<BenchmarkCandidate, readonly AgentRuntimeKind[]>> = {
  task4: PRODUCTION_RUNTIME_KINDS,
  task5: PRODUCTION_RUNTIME_KINDS,
  task6: ['claude-agent-sdk', 'openai-agents-sdk'],
  task7: ['pi-agent-core'],
  task8: ['opencode'],
  task9: ['qoder-agent-sdk'],
};

const CELL_FIELDS = [
  'runtime',
  'candidate',
  'executionProvenance',
  'candidateConfigFingerprint',
  'providerId',
  'model',
  'providerSnapshotHash',
  'trace',
  'queryHash',
  'mode',
  'scenario',
  'repetition',
  'warmup',
  'cacheState',
  'acceptedAtMs',
  'firstOutputMs',
  'terminalMs',
  'performance',
  'providerUsage',
  'targetBinding',
  'cleanup',
  'terminalOutcome',
  'quality',
] as const;
const MAX_STRING = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_STREAM_TIMEOUT_MS = 15 * 60_000;
const MIN_DETERMINISTIC_P95_SAMPLES = 30;
const REAL_MEASURED_REPETITIONS = 3;
const MAX_BENCHMARK_MS = 7 * 24 * 60 * 60 * 1_000;

export const DETERMINISTIC_ADAPTER_ADMISSION = {
  status: 'NOT_CONFIGURED' as const,
  reason: 'Five-adapter deterministic admission requires per-adapter Jest SDK/provider harnesses; synthetic scorer fixtures are non-admissible.',
};

export interface ProviderUsageReceiptV1 {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export interface RuntimeBenchmarkQuality {
  unsupportedClaims: number;
  verifiedClaims: number;
  identityErrors: number;
  finalReportGate: string;
  claimVerificationGate: string;
  identityResolutionGate: string;
  semanticFingerprint: string;
  evidenceBindingHashes: string[];
  identityBindingHashes: string[];
  sourceBindingHashes: string[];
}

export interface RuntimeBenchmarkCell {
  candidate: BenchmarkCandidate;
  executionProvenance: BenchmarkExecutionProvenance;
  candidateConfigFingerprint: string;
  runtime: AgentRuntimeKind;
  providerId: string | null;
  model?: string;
  providerSnapshotHash?: string;
  trace: string;
  queryHash: string;
  mode: 'fast' | 'full';
  scenario: BenchmarkScenarioId;
  repetition: number;
  warmup: boolean;
  cacheState: 'cold' | 'warm';
  acceptedAtMs: number;
  firstOutputMs?: number;
  terminalMs: number;
  performance?: RuntimePerformanceReceiptV1;
  providerUsage?: ProviderUsageReceiptV1;
  targetBinding: RuntimeBenchmarkTargetBinding;
  cleanup: RuntimeBenchmarkCleanupReceipt;
  terminalOutcome: 'completed' | 'partial' | 'quota_exceeded' | 'cancelled' | 'error';
  quality: RuntimeBenchmarkQuality;
}

export interface RuntimeBenchmarkTargetBinding {
  uploadedTraceId: string;
  receiptTraceId: string;
  analyzeSessionId: string;
  receiptSessionId: string;
  analyzeRunId: string;
  terminalRunId: string;
  receiptRunId: string;
  requestedQueryHash: string;
  observedQueryHash?: string;
  requestedMode: 'fast' | 'full';
  observedMode?: 'fast' | 'full' | 'auto';
  resolvedMode?: 'quick' | 'full';
  requestedCandidateId: BenchmarkCandidate;
  requestedCandidateConfigFingerprint: string;
  observedCandidateId?: BenchmarkCandidate;
  observedCandidateConfigFingerprint?: string;
  observedTargetConfigHash?: string;
  observedSourceHash?: string;
}

export interface RuntimeBenchmarkCleanupItemReceipt {
  attempted: boolean;
  success: boolean;
  status?: number;
  error?: string;
}

export interface RuntimeBenchmarkCleanupReceipt {
  session: RuntimeBenchmarkCleanupItemReceipt;
  trace: RuntimeBenchmarkCleanupItemReceipt;
}

export interface BenchmarkPairOrderEntry {
  candidate: BenchmarkCandidate;
  runtime: AgentRuntimeKind;
  scenario: BenchmarkScenarioId;
  repetition: number;
  cacheState: 'cold' | 'warm';
  order: readonly ['base', 'candidate'] | readonly ['candidate', 'base'];
}

export interface BenchmarkDataRootReceipt {
  idHash: string;
  fresh: boolean;
  verified: boolean;
}

export interface BenchmarkPairResetReceipt {
  candidateId: BenchmarkCandidate;
  runtime: AgentRuntimeKind;
  scenario: BenchmarkScenarioId;
  repetition: number;
  cacheState: 'cold' | 'warm';
  resetReceiptHash: string;
  verified: boolean;
}

export interface BenchmarkLifecycleMetadata {
  targetUrl: string;
  serverIdentityHash?: string;
  targetConfigHash?: string;
  sourceHash?: string;
  outputRunNonce: string;
  pairResetReceipts: BenchmarkPairResetReceipt[];
  randomizedPairOrder: BenchmarkPairOrderEntry[];
  warmupPairOrder: BenchmarkPairOrderEntry[];
  freshSessionsVerified: boolean;
  dataRoot: BenchmarkDataRootReceipt;
  outputRoot: string;
  cacheReset: {
    declared: boolean;
    receiptHash?: string;
    reason?: string;
  };
}

export interface RuntimeBenchmarkArtifactV1 {
  schemaVersion: 1;
  role: 'base' | 'candidate';
  executionProvenance: BenchmarkExecutionProvenance;
  scope: RuntimeBenchmarkArtifactScope | null;
  lifecycle: BenchmarkLifecycleMetadata;
  cells: RuntimeBenchmarkCell[];
}

export interface RuntimeBenchmarkArtifactScope {
  runtime: AgentRuntimeKind;
  candidateId: BenchmarkCandidate;
  candidateConfigFingerprint: string;
  outputRunNonce: string;
  sampleKind: BenchmarkSampleKind;
}

export interface SemanticGoldenAuthorization {
  authorizationId: string;
  candidateId: BenchmarkCandidate;
  runtime: AgentRuntimeKind;
  scenario: BenchmarkScenarioId;
  sampleKind: BenchmarkSampleKind;
  baseFingerprint: string;
  candidateFingerprint: string;
}

export interface BenchmarkMetricJudgment {
  status: BenchmarkJudgmentStatus;
  base?: number;
  candidate?: number;
  improvementPercent?: number;
  reasons: string[];
}

export interface CandidateAdmissionResult {
  scope: RuntimeBenchmarkArtifactScope;
  candidate: BenchmarkCandidate;
  candidateId: BenchmarkCandidate;
  runtime: AgentRuntimeKind;
  scenario: BenchmarkScenarioId;
  sampleKind: BenchmarkSampleKind;
  candidateConfigFingerprint: string;
  targetPhases: readonly RuntimePerformancePhaseReceiptV1['name'][];
  decision: 'default_on' | 'serial';
  quality: BenchmarkMetricJudgment;
  observability: BenchmarkMetricJudgment;
  performance: BenchmarkMetricJudgment;
  firstOutputMedian: BenchmarkMetricJudgment;
  observedMax: BenchmarkMetricJudgment;
  totalP95: BenchmarkMetricJudgment;
  firstOutputP95: BenchmarkMetricJudgment;
  reasons: string[];
}

export interface CandidateAdmissionAggregateResult {
  candidateId: BenchmarkCandidate;
  candidateConfigFingerprint: string;
  sampleKind: BenchmarkSampleKind;
  decision: 'default_on' | 'serial';
  groups: CandidateAdmissionResult[];
  reasons: string[];
}

export interface RuntimeBenchmarkScenario {
  id: BenchmarkScenarioId;
  traceId: string;
  tracePath: string;
  query: string;
  mode: 'fast' | 'full';
}

export interface AgentLatencyBenchmarkOptions {
  baseUrl: string;
  candidateUrl: string;
  runtime: AgentRuntimeKind;
  outputDir: string;
  backendRoot: string;
  candidate?: BenchmarkCandidate;
  candidateConfigFingerprint?: string;
  outputRunNonce?: string;
  lifecycleReceipt?: BenchmarkExternalLifecycleReceiptV1;
}

export interface BenchmarkExternalLifecycleReceiptV1 {
  schemaVersion: 1;
  generatedAtMs: number;
  baseUrl: string;
  candidateUrl: string;
  runtime: AgentRuntimeKind;
  candidateId: BenchmarkCandidate;
  candidateConfigFingerprint: string;
  outputRunNonce: string;
  baseServerIdentityHash: string;
  candidateServerIdentityHash: string;
  baseConfigHash: string;
  candidateConfigHash: string;
  baseSourceHash: string;
  candidateSourceHash: string;
  baseDataRootHash: string;
  candidateDataRootHash: string;
  freshDataRoots: true;
  freshSessions: true;
  cacheResetBetweenPairs: true;
  coldWarmProtocol: 'one_cold_warmup_then_three_warm_pairs';
  pairCount: number;
  pairResetReceipts: BenchmarkPairResetReceipt[];
}

export interface RuntimeAvailabilityEntry {
  status: 'CONFIGURED_NOT_VERIFIED' | 'NOT_AVAILABLE';
  reason: string;
  signals: string[];
}

export interface LocalRuntimeAvailability {
  scope: 'local_harness_only';
  deepseek: RuntimeAvailabilityEntry;
  openai: RuntimeAvailabilityEntry;
  pi: RuntimeAvailabilityEntry;
  opencode: RuntimeAvailabilityEntry;
  claude: RuntimeAvailabilityEntry;
  qoder: RuntimeAvailabilityEntry;
}

export interface TargetBenchmarkCellInput {
  baseUrl: string;
  runtime: AgentRuntimeKind;
  candidate: BenchmarkCandidate;
  candidateConfigFingerprint: string;
  scenario: RuntimeBenchmarkScenario;
  repetition: number;
  warmup: boolean;
  cacheState: 'cold' | 'warm';
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxJsonBytes?: number;
  maxSseBytes?: number;
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
}

interface RuntimeBenchmarkQualityInput {
  conclusionContract: ConclusionContract | Record<string, unknown>;
  analysisReceipt: Record<string, unknown>;
  claimVerificationResult?: Record<string, unknown>;
  identityResolutions?: Array<Record<string, unknown>>;
  sourceClaimBindings?: Array<Record<string, unknown>>;
}

interface SemanticFingerprintInput {
  conclusionContract: ConclusionContract | Record<string, unknown>;
  identityResolutions?: Array<Record<string, unknown>>;
  sourceClaimBindings?: Array<Record<string, unknown>>;
}

interface ScoreCandidateAdmissionInput {
  baseArtifact: RuntimeBenchmarkArtifactV1;
  candidateArtifact: RuntimeBenchmarkArtifactV1;
  candidate: BenchmarkCandidate;
  runtime: AgentRuntimeKind;
  scenario: BenchmarkScenarioId;
  sampleKind: BenchmarkSampleKind;
  semanticGoldenAuthorizations?: SemanticGoldenAuthorization[];
}

interface ParseArgsContext {
  backendRoot?: string;
  nowMs?: number;
}

interface BoundedJsonOptions {
  maxBytes?: number;
}

interface AvailabilityInspectionOptions {
  env?: NodeJS.ProcessEnv;
  commandExists?: (command: string) => boolean;
  fileExists?: (filePath: string) => boolean;
  homeDir?: string;
}

interface DeterministicStubMatrixEntry {
  role: 'base' | 'candidate';
  cell: RuntimeBenchmarkCell;
}

function asRecord(value: unknown, code = 'benchmark_object_required'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function assertKnownFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  code: string,
): void {
  const known = new Set(fields);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) throw new Error(`${code}:${key}`);
  }
}

function boundedString(value: unknown, code: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > MAX_STRING) throw new Error(code);
  return normalized;
}

function optionalBoundedString(value: unknown, code: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, code);
}

function finiteNonnegative(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

function boundedMs(value: unknown, code: string, allowZero = true): number {
  const parsed = finiteNonnegative(value, code);
  if ((!allowZero && parsed === 0) || parsed > MAX_BENCHMARK_MS) throw new Error(code);
  return parsed;
}

function strictHash(value: unknown, code: string): string {
  const parsed = boundedString(value, code);
  if (!/^(?:sha256:)?[0-9a-f]{16,128}$/i.test(parsed)) throw new Error(code);
  return parsed.toLowerCase();
}

function safeIdentifier(value: unknown, code: string): string {
  const parsed = boundedString(value, code);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(parsed) || /(?:bearer|secret|token|password|api[_-]?key|https?:)/i.test(parsed)) {
    throw new Error(code);
  }
  return parsed;
}

function safeModelSlug(value: unknown, code: string): string {
  const parsed = boundedString(value, code);
  if (
    parsed.length > 160
    || !/^[A-Za-z0-9._:/@+\-]+$/.test(parsed)
    || /(?:bearer|secret|token|password|api[_-]?key|sk-[A-Za-z0-9])/i.test(parsed)
  ) {
    throw new Error(code);
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, code: string): number {
  const parsed = finiteNonnegative(value, code);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = nonnegativeInteger(value, code);
  if (parsed <= 0) throw new Error(code);
  return parsed;
}

function hashCanonical(value: unknown): string {
  return `sha256:${canonicalContentHash(value)}`;
}

function semanticReference(reference: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    'evidenceRefId',
    'sourceRef',
    'sourceToolCallId',
    'artifactId',
    'sourceArtifactId',
    'identityRefId',
    'sourceReferenceId',
    'rowIndex',
    'rowSelector',
    'column',
    'value',
  ];
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (reference[field] !== undefined) result[field] = reference[field];
  }
  return result;
}

function semanticIdentity(identity: Record<string, unknown>): Record<string, unknown> {
  const target = optionalRecord(identity.target);
  const semanticTarget: Record<string, unknown> = {};
  for (const key of [
    'traceSide', 'packageName', 'processName', 'threadName', 'role',
    'upid', 'utid', 'pid', 'tid', 'source',
  ]) {
    if (target?.[key] !== undefined) semanticTarget[key] = target[key];
  }
  if (target?.timeRange !== undefined) semanticTarget.timeRange = target.timeRange;
  const semanticResolved = (
    values: unknown,
    fields: readonly string[],
  ): Record<string, unknown>[] => Array.isArray(values)
    ? values.map(value => {
      const record = asRecord(value, 'benchmark_identity_resolution_item_invalid');
      const output: Record<string, unknown> = {};
      for (const field of fields) {
        if (record[field] !== undefined) output[field] = record[field];
      }
      if (Array.isArray(record.matchSources)) output.matchSources = stringArray(record.matchSources);
      return output;
    }).sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right)))
    : [];
  return {
    identityRefId: boundedString(identity.identityRefId, 'benchmark_identity_ref_missing'),
    status: boundedString(identity.status, 'benchmark_identity_status_missing'),
    ...(Object.keys(semanticTarget).length > 0 ? {target: semanticTarget} : {}),
    processes: semanticResolved(identity.processes, [
      'upid', 'pid', 'processName', 'packageName', 'startTs', 'endTs', 'confidence',
    ]),
    threads: semanticResolved(identity.threads, [
      'utid', 'tid', 'threadName', 'role', 'owningUpid', 'processName', 'activeRange', 'confidence',
    ]),
    warnings: stringArray(identity.warnings),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim())
    .sort();
}

function semanticSourceBinding(binding: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'claimId',
    'conclusionId',
    'traceEvidenceRefId',
    'sourceReferenceId',
    'mechanismStatus',
    'status',
  ]) {
    if (binding[key] !== undefined) result[key] = binding[key];
  }
  const sourceReferenceIds = stringArray(binding.sourceReferenceIds);
  const traceEvidenceRefIds = stringArray(binding.traceEvidenceRefIds);
  if (sourceReferenceIds.length > 0) result.sourceReferenceIds = sourceReferenceIds;
  if (traceEvidenceRefIds.length > 0) result.traceEvidenceRefIds = traceEvidenceRefIds;
  if (Object.keys(result).length === 0) {
    throw new Error('benchmark_source_binding_semantic_identity_missing');
  }
  return result;
}

function semanticContractPayload(input: SemanticFingerprintInput): Record<string, unknown> {
  const contract = asRecord(input.conclusionContract, 'benchmark_conclusion_contract_required');
  if (contract.schemaVersion !== 'conclusion_contract_v1') {
    throw new Error('benchmark_conclusion_contract_version_invalid');
  }
  const conclusions = Array.isArray(contract.conclusions) ? contract.conclusions : [];
  const evidenceChain = Array.isArray(contract.evidenceChain) ? contract.evidenceChain : [];
  const rankedRoots = conclusions
    .map((value, originalIndex) => {
      const conclusion = asRecord(value, 'benchmark_conclusion_invalid');
      const rank = positiveInteger(conclusion.rank, 'benchmark_conclusion_rank_invalid');
      const explicitId = typeof conclusion.id === 'string' ? conclusion.id.trim() : '';
      const evidence = optionalRecord(evidenceChain[originalIndex]);
      const conclusionId = explicitId || (typeof evidence?.conclusionId === 'string'
        ? evidence.conclusionId.trim()
        : '');
      if (!conclusionId) throw new Error('benchmark_conclusion_semantic_id_missing');
      return {rank, conclusionId, originalIndex};
    })
    .sort((left, right) => left.rank - right.rank || left.originalIndex - right.originalIndex)
    .map(({rank, conclusionId}) => ({rank, conclusionId}));

  const claims = Array.isArray(contract.claims) ? contract.claims : [];
  if (claims.length === 0) throw new Error('benchmark_claims_missing');
  const rootOrder = new Map(rankedRoots.map((root, index) => [root.conclusionId, index]));
  const semanticClaims = claims
    .map((value, originalIndex) => {
      const claim = asRecord(value, 'benchmark_claim_invalid');
      const id = boundedString(claim.id, 'benchmark_claim_id_missing');
      const conclusionId = boundedString(claim.conclusionId, 'benchmark_claim_conclusion_id_missing');
      const references = Array.isArray(claim.references)
        ? claim.references.map(reference => semanticReference(asRecord(reference, 'benchmark_claim_reference_invalid')))
        : [];
      const artifactRefs = Array.isArray(claim.artifactRefs)
        ? claim.artifactRefs.map(reference => semanticReference(asRecord(reference, 'benchmark_claim_artifact_reference_invalid')))
        : [];
      if (references.length === 0 && artifactRefs.length === 0) throw new Error('benchmark_claim_reference_missing');
      return {
        id,
        conclusionId,
        kind: typeof claim.kind === 'string' ? claim.kind : null,
        supportLevel: typeof claim.supportLevel === 'string' ? claim.supportLevel : null,
        references: references.sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right))),
        artifactRefs: artifactRefs.sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right))),
        relationRefs: stringArray(claim.relationRefs),
        originalIndex,
      };
    })
    .sort((left, right) => {
      const leftRoot = rootOrder.get(left.conclusionId) ?? Number.MAX_SAFE_INTEGER;
      const rightRoot = rootOrder.get(right.conclusionId) ?? Number.MAX_SAFE_INTEGER;
      return leftRoot - rightRoot || left.originalIndex - right.originalIndex;
    })
    .map(({originalIndex: _originalIndex, ...claim}) => claim);

  const identities = (input.identityResolutions ?? [])
    .map(semanticIdentity)
    .sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right)));
  const sourceBindings = (input.sourceClaimBindings ?? [])
    .map(semanticSourceBinding)
    .sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right)));
  return {
    schemaVersion: contract.schemaVersion,
    mode: contract.mode,
    rankedRoots,
    claims: semanticClaims,
    identities,
    sourceBindings,
  };
}

export function buildSemanticFingerprint(input: SemanticFingerprintInput): string {
  return hashCanonical(semanticContractPayload(input));
}

function claimBindingHashes(contractInput: ConclusionContract | Record<string, unknown>): string[] {
  const contract = asRecord(contractInput);
  const claims = Array.isArray(contract.claims) ? contract.claims : [];
  return claims.map(value => {
    const claim = asRecord(value, 'benchmark_claim_invalid');
    return hashCanonical({
      id: boundedString(claim.id, 'benchmark_claim_id_missing'),
      conclusionId: boundedString(claim.conclusionId, 'benchmark_claim_conclusion_id_missing'),
      references: (Array.isArray(claim.references) ? claim.references : [])
        .map(reference => semanticReference(asRecord(reference)))
        .sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right))),
      artifactRefs: (Array.isArray(claim.artifactRefs) ? claim.artifactRefs : [])
        .map(reference => semanticReference(asRecord(reference)))
        .sort((left, right) => canonicalJsonString(left).localeCompare(canonicalJsonString(right))),
    });
  }).sort();
}

export function buildRuntimeBenchmarkQuality(input: RuntimeBenchmarkQualityInput): RuntimeBenchmarkQuality {
  const receipt = asRecord(input.analysisReceipt, 'benchmark_analysis_receipt_required');
  const claimAudit = asRecord(receipt.claimAudit, 'benchmark_claim_audit_required');
  const qualityGates = asRecord(receipt.qualityGates, 'benchmark_quality_gates_required');
  const identities = input.identityResolutions ?? [];
  const sourceBindings = input.sourceClaimBindings ?? [];
  const verifier = input.claimVerificationResult;
  const verifiedClaims = claimAudit.verifiedClaims;
  const unsupportedClaims = verifier?.unsupportedClaimCount ?? claimAudit.unsupportedClaims;
  const identityErrors = identities.filter(identity => {
    const status = identity.status;
    return status !== 'verified' && status !== 'not_required';
  }).length;
  return {
    unsupportedClaims: nonnegativeInteger(unsupportedClaims, 'benchmark_unsupported_claims_invalid'),
    verifiedClaims: nonnegativeInteger(verifiedClaims, 'benchmark_verified_claims_invalid'),
    identityErrors,
    finalReportGate: parseGate(qualityGates.finalReportContract, 'benchmark_final_report_gate_invalid'),
    claimVerificationGate: parseGate(qualityGates.claimVerification, 'benchmark_claim_verification_gate_invalid'),
    identityResolutionGate: parseGate(qualityGates.identityResolution, 'benchmark_identity_resolution_gate_invalid'),
    semanticFingerprint: buildSemanticFingerprint({
      conclusionContract: input.conclusionContract,
      identityResolutions: identities,
      sourceClaimBindings: sourceBindings,
    }),
    evidenceBindingHashes: claimBindingHashes(input.conclusionContract),
    identityBindingHashes: identities.map(identity => hashCanonical(semanticIdentity(identity))).sort(),
    sourceBindingHashes: sourceBindings.map(binding => hashCanonical(semanticSourceBinding(binding))).sort(),
  };
}

function parseHashArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value)) throw new Error(code);
  const hashes = value.map(entry => strictHash(entry, code));
  if (new Set(hashes).size !== hashes.length) throw new Error(`${code}:duplicate`);
  return [...hashes].sort();
}

function parseGate(value: unknown, code: string): 'passed' | 'partial' | 'not_applicable' {
  if (value !== 'passed' && value !== 'partial' && value !== 'not_applicable') throw new Error(code);
  return value;
}

function parseQuality(value: unknown): RuntimeBenchmarkQuality {
  const record = asRecord(value, 'benchmark_quality_required');
  assertKnownFields(record, [
    'unsupportedClaims',
    'verifiedClaims',
    'identityErrors',
    'finalReportGate',
    'claimVerificationGate',
    'identityResolutionGate',
    'semanticFingerprint',
    'evidenceBindingHashes',
    'identityBindingHashes',
    'sourceBindingHashes',
  ], 'benchmark_quality_unknown_field');
  return {
    unsupportedClaims: nonnegativeInteger(record.unsupportedClaims, 'benchmark_unsupported_claims_invalid'),
    verifiedClaims: nonnegativeInteger(record.verifiedClaims, 'benchmark_verified_claims_invalid'),
    identityErrors: nonnegativeInteger(record.identityErrors, 'benchmark_identity_errors_invalid'),
    finalReportGate: parseGate(record.finalReportGate, 'benchmark_final_report_gate_invalid'),
    claimVerificationGate: parseGate(record.claimVerificationGate, 'benchmark_claim_verification_gate_invalid'),
    identityResolutionGate: parseGate(record.identityResolutionGate, 'benchmark_identity_resolution_gate_invalid'),
    semanticFingerprint: strictHash(record.semanticFingerprint, 'benchmark_semantic_fingerprint_invalid'),
    evidenceBindingHashes: parseHashArray(record.evidenceBindingHashes, 'benchmark_evidence_bindings_invalid'),
    identityBindingHashes: parseHashArray(record.identityBindingHashes, 'benchmark_identity_bindings_invalid'),
    sourceBindingHashes: parseHashArray(record.sourceBindingHashes, 'benchmark_source_bindings_invalid'),
  };
}

function parseProviderUsage(value: unknown): ProviderUsageReceiptV1 | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'benchmark_provider_usage_invalid');
  assertKnownFields(record, [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens', 'costUsd',
  ], 'benchmark_provider_usage_unknown_field');
  const result: ProviderUsageReceiptV1 = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'reasoningTokens'] as const) {
    if (record[key] !== undefined) result[key] = nonnegativeInteger(record[key], `benchmark_provider_usage_${key}_invalid`);
  }
  if (record.costUsd !== undefined) result.costUsd = finiteNonnegative(record.costUsd, 'benchmark_provider_usage_cost_invalid');
  return result;
}

const PHASE_NAMES = new Set<string>(CANDIDATE_TARGET_PHASES.task4
  .concat(CANDIDATE_TARGET_PHASES.task5, CANDIDATE_TARGET_PHASES.task6, CANDIDATE_TARGET_PHASES.task7, CANDIDATE_TARGET_PHASES.task8, CANDIDATE_TARGET_PHASES.task9)
  .concat(['architecture', 'completeness', 'finalization']));

function parsePerformance(value: unknown): RuntimePerformanceReceiptV1 | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, 'benchmark_runtime_performance_invalid');
  assertKnownFields(record, ['schemaVersion', 'firstOutputMs', 'phases', 'tools', 'sql', 'truncated'], 'benchmark_runtime_performance_unknown_field');
  if (record.schemaVersion !== 1) throw new Error('benchmark_runtime_performance_version_invalid');
  if (!Array.isArray(record.phases) || !Array.isArray(record.tools) || !Array.isArray(record.sql)) {
    throw new Error('benchmark_runtime_performance_arrays_invalid');
  }
  const phases = record.phases.map(value => {
    const phase = asRecord(value, 'benchmark_runtime_phase_invalid');
    assertKnownFields(phase, ['name', 'startOffsetMs', 'durationMs', 'outcome'], 'benchmark_runtime_phase_unknown_field');
    const name = boundedString(phase.name, 'benchmark_runtime_phase_name_invalid');
    if (!PHASE_NAMES.has(name)) throw new Error('benchmark_runtime_phase_name_invalid');
    const outcome = boundedString(phase.outcome, 'benchmark_runtime_phase_outcome_invalid');
    if (!['ok', 'error', 'cancelled'].includes(outcome)) throw new Error('benchmark_runtime_phase_outcome_invalid');
    return {
      name: name as RuntimePerformancePhaseReceiptV1['name'],
      startOffsetMs: boundedMs(phase.startOffsetMs, 'benchmark_runtime_phase_start_invalid'),
      durationMs: boundedMs(phase.durationMs, 'benchmark_runtime_phase_duration_invalid'),
      outcome: outcome as RuntimePerformancePhaseReceiptV1['outcome'],
    };
  });
  const tools = record.tools.map(value => {
    const tool = asRecord(value, 'benchmark_runtime_tool_invalid');
    assertKnownFields(tool, [
      'toolCallIdHash', 'mode', 'schedulerWaitMs', 'fallbackReason', 'durationMs', 'outcome',
    ], 'benchmark_runtime_tool_unknown_field');
    const mode = boundedString(tool.mode, 'benchmark_runtime_tool_mode_invalid');
    if (mode !== 'exclusive' && mode !== 'commutative_read') throw new Error('benchmark_runtime_tool_mode_invalid');
    const outcome = boundedString(tool.outcome, 'benchmark_runtime_tool_outcome_invalid');
    if (!['ok', 'error', 'cancelled'].includes(outcome)) throw new Error('benchmark_runtime_tool_outcome_invalid');
    const fallbackReason = optionalBoundedString(tool.fallbackReason, 'benchmark_runtime_tool_fallback_invalid');
    if (fallbackReason !== undefined && !['disabled_by_env', 'commutative_read_not_admitted'].includes(fallbackReason)) {
      throw new Error('benchmark_runtime_tool_fallback_invalid');
    }
    return {
      toolCallIdHash: strictHash(tool.toolCallIdHash, 'benchmark_runtime_tool_hash_invalid'),
      mode: mode as 'exclusive' | 'commutative_read',
      schedulerWaitMs: boundedMs(tool.schedulerWaitMs, 'benchmark_runtime_tool_wait_invalid'),
      ...(fallbackReason ? {fallbackReason: fallbackReason as 'disabled_by_env' | 'commutative_read_not_admitted'} : {}),
      durationMs: boundedMs(tool.durationMs, 'benchmark_runtime_tool_duration_invalid'),
      outcome: outcome as 'ok' | 'error' | 'cancelled',
    };
  });
  const sql = record.sql.map(value => {
    const item = asRecord(value, 'benchmark_runtime_sql_invalid');
    assertKnownFields(item, [
      'processorKeyHash', 'priority', 'queueWaitMs', 'executionMs', 'outcome',
    ], 'benchmark_runtime_sql_unknown_field');
    const priority = boundedString(item.priority, 'benchmark_runtime_sql_priority_invalid');
    if (!['p0', 'p1', 'p2'].includes(priority)) throw new Error('benchmark_runtime_sql_priority_invalid');
    const outcome = boundedString(item.outcome, 'benchmark_runtime_sql_outcome_invalid');
    if (!['ok', 'error', 'cancelled'].includes(outcome)) throw new Error('benchmark_runtime_sql_outcome_invalid');
    return {
      processorKeyHash: strictHash(item.processorKeyHash, 'benchmark_runtime_sql_hash_invalid'),
      priority: priority as 'p0' | 'p1' | 'p2',
      queueWaitMs: boundedMs(item.queueWaitMs, 'benchmark_runtime_sql_queue_wait_invalid'),
      executionMs: boundedMs(item.executionMs, 'benchmark_runtime_sql_execution_invalid'),
      outcome: outcome as 'ok' | 'error' | 'cancelled',
    };
  });
  let truncated: RuntimePerformanceReceiptV1['truncated'];
  if (record.truncated !== undefined) {
    const raw = asRecord(record.truncated, 'benchmark_runtime_truncated_invalid');
    assertKnownFields(raw, ['phases', 'tools', 'sql'], 'benchmark_runtime_truncated_unknown_field');
    truncated = {
      phases: nonnegativeInteger(raw.phases, 'benchmark_runtime_truncated_phases_invalid'),
      tools: nonnegativeInteger(raw.tools, 'benchmark_runtime_truncated_tools_invalid'),
      sql: nonnegativeInteger(raw.sql, 'benchmark_runtime_truncated_sql_invalid'),
    };
  }
  return {
    schemaVersion: 1,
    ...(record.firstOutputMs !== undefined
      ? {firstOutputMs: boundedMs(record.firstOutputMs, 'benchmark_runtime_first_output_invalid')}
      : {}),
    phases,
    tools,
    sql,
    ...(truncated ? {truncated} : {}),
  };
}

function parseCandidate(value: unknown): BenchmarkCandidate {
  if (value !== 'task4' && value !== 'task5' && value !== 'task6' && value !== 'task7' && value !== 'task8' && value !== 'task9') {
    throw new Error('benchmark_cell_candidate_invalid');
  }
  return value;
}

function parseExecutionProvenance(value: unknown): BenchmarkExecutionProvenance {
  if (value !== 'synthetic_scorer' && value !== 'genuine_adapter' && value !== 'real_provider') {
    throw new Error('benchmark_execution_provenance_invalid');
  }
  return value;
}

function parseTargetBinding(value: unknown): RuntimeBenchmarkTargetBinding {
  const record = asRecord(value, 'benchmark_target_binding_required');
  assertKnownFields(record, [
    'uploadedTraceId', 'receiptTraceId', 'analyzeSessionId', 'receiptSessionId',
    'analyzeRunId', 'terminalRunId', 'receiptRunId', 'requestedQueryHash',
    'observedQueryHash', 'requestedMode', 'observedMode', 'resolvedMode',
    'requestedCandidateId', 'requestedCandidateConfigFingerprint',
    'observedCandidateId', 'observedCandidateConfigFingerprint',
    'observedTargetConfigHash', 'observedSourceHash',
  ], 'benchmark_target_binding_unknown_field');
  const binding: RuntimeBenchmarkTargetBinding = {
    uploadedTraceId: safeIdentifier(record.uploadedTraceId, 'benchmark_uploaded_trace_id_invalid'),
    receiptTraceId: safeIdentifier(record.receiptTraceId, 'benchmark_receipt_trace_id_invalid'),
    analyzeSessionId: safeIdentifier(record.analyzeSessionId, 'benchmark_analyze_session_id_invalid'),
    receiptSessionId: safeIdentifier(record.receiptSessionId, 'benchmark_receipt_session_id_invalid'),
    analyzeRunId: safeIdentifier(record.analyzeRunId, 'benchmark_analyze_run_id_invalid'),
    terminalRunId: safeIdentifier(record.terminalRunId, 'benchmark_terminal_run_id_invalid'),
    receiptRunId: safeIdentifier(record.receiptRunId, 'benchmark_receipt_run_id_invalid'),
    requestedQueryHash: strictHash(record.requestedQueryHash, 'benchmark_requested_query_hash_invalid'),
    ...(record.observedQueryHash !== undefined
      ? {observedQueryHash: strictHash(record.observedQueryHash, 'benchmark_observed_query_hash_invalid')}
      : {}),
    requestedMode: record.requestedMode === 'fast' || record.requestedMode === 'full'
      ? record.requestedMode
      : (() => { throw new Error('benchmark_requested_mode_invalid'); })(),
    ...(record.observedMode === 'fast' || record.observedMode === 'full' || record.observedMode === 'auto'
      ? {observedMode: record.observedMode}
      : record.observedMode === undefined
        ? {}
        : (() => { throw new Error('benchmark_observed_mode_invalid'); })()),
    ...(record.resolvedMode === 'quick' || record.resolvedMode === 'full'
      ? {resolvedMode: record.resolvedMode}
      : record.resolvedMode === undefined
        ? {}
        : (() => { throw new Error('benchmark_resolved_mode_invalid'); })()),
    requestedCandidateId: parseCandidate(record.requestedCandidateId),
    requestedCandidateConfigFingerprint: strictHash(
      record.requestedCandidateConfigFingerprint,
      'benchmark_requested_candidate_config_fingerprint_invalid',
    ),
    ...(record.observedCandidateId !== undefined
      ? {observedCandidateId: parseCandidate(record.observedCandidateId)}
      : {}),
    ...(record.observedCandidateConfigFingerprint !== undefined
      ? {observedCandidateConfigFingerprint: strictHash(
        record.observedCandidateConfigFingerprint,
        'benchmark_observed_candidate_config_fingerprint_invalid',
      )}
      : {}),
    ...(record.observedTargetConfigHash !== undefined
      ? {observedTargetConfigHash: strictHash(record.observedTargetConfigHash, 'benchmark_observed_target_config_hash_invalid')}
      : {}),
    ...(record.observedSourceHash !== undefined
      ? {observedSourceHash: strictHash(record.observedSourceHash, 'benchmark_observed_source_hash_invalid')}
      : {}),
  };
  if (
    binding.uploadedTraceId !== binding.receiptTraceId
    || binding.analyzeSessionId !== binding.receiptSessionId
    || binding.analyzeRunId !== binding.terminalRunId
    || binding.analyzeRunId !== binding.receiptRunId
  ) {
    throw new Error('benchmark_target_binding_mismatch');
  }
  if (binding.observedQueryHash && binding.observedQueryHash !== binding.requestedQueryHash) {
    throw new Error('benchmark_observed_query_hash_mismatch');
  }
  if (binding.observedMode && binding.observedMode !== binding.requestedMode) {
    throw new Error('benchmark_observed_mode_mismatch');
  }
  if (
    binding.resolvedMode
    && ((binding.requestedMode === 'fast' && binding.resolvedMode !== 'quick')
      || (binding.requestedMode === 'full' && binding.resolvedMode !== 'full'))
  ) {
    throw new Error('benchmark_resolved_mode_mismatch');
  }
  if (binding.observedCandidateId && binding.observedCandidateId !== binding.requestedCandidateId) {
    throw new Error('benchmark_observed_candidate_id_mismatch');
  }
  if (
    binding.observedCandidateConfigFingerprint
    && binding.observedCandidateConfigFingerprint !== binding.requestedCandidateConfigFingerprint
  ) {
    throw new Error('benchmark_observed_candidate_config_fingerprint_mismatch');
  }
  return binding;
}

function parseCleanupItem(value: unknown, label: string): RuntimeBenchmarkCleanupItemReceipt {
  const record = asRecord(value, `benchmark_cleanup_${label}_required`);
  assertKnownFields(record, ['attempted', 'success', 'status', 'error'], `benchmark_cleanup_${label}_unknown_field`);
  if (typeof record.attempted !== 'boolean' || typeof record.success !== 'boolean') {
    throw new Error(`benchmark_cleanup_${label}_invalid`);
  }
  const status = record.status === undefined
    ? undefined
    : nonnegativeInteger(record.status, `benchmark_cleanup_${label}_status_invalid`);
  if (status !== undefined && (status < 100 || status > 599)) throw new Error(`benchmark_cleanup_${label}_status_invalid`);
  return {
    attempted: record.attempted,
    success: record.success,
    ...(status !== undefined ? {status} : {}),
    ...(record.error !== undefined ? {error: safeIdentifier(record.error, `benchmark_cleanup_${label}_error_invalid`)} : {}),
  };
}

function parseCleanup(value: unknown): RuntimeBenchmarkCleanupReceipt {
  const record = asRecord(value, 'benchmark_cleanup_required');
  assertKnownFields(record, ['session', 'trace'], 'benchmark_cleanup_unknown_field');
  return {
    session: parseCleanupItem(record.session, 'session'),
    trace: parseCleanupItem(record.trace, 'trace'),
  };
}

export function parseRuntimeBenchmarkCell(value: unknown): RuntimeBenchmarkCell {
  const record = asRecord(value, 'benchmark_cell_required');
  assertKnownFields(record, CELL_FIELDS, 'benchmark_cell_unknown_field');
  if (!isProductionAgentRuntimeKind(record.runtime)) throw new Error('benchmark_cell_runtime_invalid');
  const candidate = parseCandidate(record.candidate);
  const executionProvenance = parseExecutionProvenance(record.executionProvenance);
  const candidateConfigFingerprint = strictHash(
    record.candidateConfigFingerprint,
    'benchmark_candidate_config_fingerprint_invalid',
  );
  if (!CANDIDATE_RUNTIME_MATRIX[candidate].includes(record.runtime)) throw new Error('benchmark_candidate_runtime_invalid');
  if (record.providerId !== null && typeof record.providerId !== 'string') {
    throw new Error('benchmark_cell_provider_id_invalid');
  }
  const mode = record.mode;
  if (mode !== 'fast' && mode !== 'full') throw new Error('benchmark_cell_mode_invalid');
  const scenario = record.scenario;
  if (scenario !== 'startup-full' && scenario !== 'scrolling-full' && scenario !== 'identity-fast') {
    throw new Error('benchmark_cell_scenario_invalid');
  }
  if (typeof record.warmup !== 'boolean') throw new Error('benchmark_cell_warmup_invalid');
  const acceptedAtMs = boundedMs(record.acceptedAtMs, 'benchmark_cell_accepted_at_invalid');
  const terminalMs = boundedMs(record.terminalMs, 'benchmark_cell_terminal_invalid', false);
  if (terminalMs <= acceptedAtMs) throw new Error('benchmark_cell_terminal_before_accept');
  const firstOutputMs = record.firstOutputMs === undefined
    ? undefined
    : boundedMs(record.firstOutputMs, 'benchmark_cell_first_output_invalid');
  if (firstOutputMs !== undefined && firstOutputMs > terminalMs - acceptedAtMs) {
    throw new Error('benchmark_cell_first_output_after_terminal');
  }
  const performance = parsePerformance(record.performance);
  if (
    firstOutputMs !== undefined
    && performance?.firstOutputMs !== undefined
    && firstOutputMs !== performance.firstOutputMs
  ) {
    throw new Error('benchmark_first_output_receipt_mismatch');
  }
  if (performance?.phases.some(phase => phase.startOffsetMs + phase.durationMs > terminalMs - acceptedAtMs)) {
    throw new Error('benchmark_runtime_phase_after_terminal');
  }
  const queryHash = strictHash(record.queryHash, 'benchmark_cell_query_hash_invalid');
  const targetBinding = parseTargetBinding(record.targetBinding);
  if (targetBinding.requestedQueryHash !== queryHash) throw new Error('benchmark_query_hash_binding_mismatch');
  if (targetBinding.requestedMode !== mode) throw new Error('benchmark_mode_binding_mismatch');
  if (targetBinding.requestedCandidateId !== candidate) throw new Error('benchmark_candidate_id_binding_mismatch');
  if (targetBinding.requestedCandidateConfigFingerprint !== candidateConfigFingerprint) {
    throw new Error('benchmark_candidate_config_binding_mismatch');
  }
  const cacheState = record.cacheState;
  if (cacheState !== 'cold' && cacheState !== 'warm') throw new Error('benchmark_cell_cache_state_invalid');
  const repetition = nonnegativeInteger(record.repetition, 'benchmark_cell_repetition_invalid');
  if (record.warmup === true ? repetition !== 0 : repetition === 0) throw new Error('benchmark_cell_repetition_warmup_mismatch');
  const terminalOutcome = record.terminalOutcome;
  if (!['completed', 'partial', 'quota_exceeded', 'cancelled', 'error'].includes(String(terminalOutcome))) {
    throw new Error('benchmark_terminal_outcome_invalid');
  }
  return {
    candidate,
    executionProvenance,
    candidateConfigFingerprint,
    runtime: record.runtime,
    providerId: record.providerId === null ? null : safeIdentifier(record.providerId, 'benchmark_cell_provider_id_invalid'),
    ...(record.model !== undefined ? {model: safeModelSlug(record.model, 'benchmark_cell_model_invalid')} : {}),
    ...(record.providerSnapshotHash !== undefined
      ? {providerSnapshotHash: strictHash(record.providerSnapshotHash, 'benchmark_cell_provider_snapshot_hash_invalid')}
      : {}),
    trace: safeIdentifier(record.trace, 'benchmark_cell_trace_invalid'),
    queryHash,
    mode,
    scenario,
    repetition,
    warmup: record.warmup,
    cacheState,
    acceptedAtMs,
    ...(firstOutputMs !== undefined ? {firstOutputMs} : {}),
    terminalMs,
    ...(performance ? {performance} : {}),
    ...(record.providerUsage !== undefined ? {providerUsage: parseProviderUsage(record.providerUsage)} : {}),
    targetBinding,
    cleanup: parseCleanup(record.cleanup),
    terminalOutcome: terminalOutcome as RuntimeBenchmarkCell['terminalOutcome'],
    quality: parseQuality(record.quality),
  };
}

function parsePairOrderEntry(value: unknown): BenchmarkPairOrderEntry {
  const record = asRecord(value, 'benchmark_pair_order_entry_invalid');
  assertKnownFields(record, [
    'candidate', 'runtime', 'scenario', 'repetition', 'cacheState', 'order',
  ], 'benchmark_pair_order_unknown_field');
  const candidate = parseCandidate(record.candidate);
  if (!isProductionAgentRuntimeKind(record.runtime)) throw new Error('benchmark_pair_order_runtime_invalid');
  if (!CANDIDATE_RUNTIME_MATRIX[candidate].includes(record.runtime)) throw new Error('benchmark_pair_order_candidate_runtime_invalid');
  if (record.scenario !== 'startup-full' && record.scenario !== 'scrolling-full' && record.scenario !== 'identity-fast') {
    throw new Error('benchmark_pair_order_scenario_invalid');
  }
  if (record.cacheState !== 'cold' && record.cacheState !== 'warm') throw new Error('benchmark_pair_order_cache_state_invalid');
  if (!Array.isArray(record.order) || record.order.length !== 2) throw new Error('benchmark_pair_order_invalid');
  const order = record.order[0] === 'base' && record.order[1] === 'candidate'
    ? ['base', 'candidate'] as const
    : record.order[0] === 'candidate' && record.order[1] === 'base'
      ? ['candidate', 'base'] as const
      : (() => { throw new Error('benchmark_pair_order_invalid'); })();
  return {
    candidate,
    runtime: record.runtime,
    scenario: record.scenario,
    repetition: nonnegativeInteger(record.repetition, 'benchmark_pair_order_repetition_invalid'),
    cacheState: record.cacheState,
    order,
  };
}

function parsePairResetReceipt(value: unknown): BenchmarkPairResetReceipt {
  const record = asRecord(value, 'benchmark_pair_reset_receipt_invalid');
  assertKnownFields(record, [
    'candidateId', 'runtime', 'scenario', 'repetition', 'cacheState', 'resetReceiptHash', 'verified',
  ], 'benchmark_pair_reset_receipt_unknown_field');
  const candidateId = parseCandidate(record.candidateId);
  if (!isProductionAgentRuntimeKind(record.runtime)) throw new Error('benchmark_pair_reset_runtime_invalid');
  if (!CANDIDATE_RUNTIME_MATRIX[candidateId].includes(record.runtime)) throw new Error('benchmark_pair_reset_candidate_runtime_invalid');
  if (record.scenario !== 'startup-full' && record.scenario !== 'scrolling-full' && record.scenario !== 'identity-fast') {
    throw new Error('benchmark_pair_reset_scenario_invalid');
  }
  if (record.cacheState !== 'cold' && record.cacheState !== 'warm') throw new Error('benchmark_pair_reset_cache_state_invalid');
  if (typeof record.verified !== 'boolean') throw new Error('benchmark_pair_reset_verified_invalid');
  return {
    candidateId,
    runtime: record.runtime,
    scenario: record.scenario,
    repetition: nonnegativeInteger(record.repetition, 'benchmark_pair_reset_repetition_invalid'),
    cacheState: record.cacheState,
    resetReceiptHash: strictHash(record.resetReceiptHash, 'benchmark_pair_reset_hash_invalid'),
    verified: record.verified,
  };
}

function parseLifecycle(value: unknown): BenchmarkLifecycleMetadata {
  const record = asRecord(value, 'benchmark_lifecycle_required');
  assertKnownFields(record, [
    'targetUrl', 'serverIdentityHash', 'targetConfigHash', 'sourceHash',
    'outputRunNonce', 'pairResetReceipts',
    'randomizedPairOrder', 'warmupPairOrder', 'freshSessionsVerified',
    'dataRoot', 'outputRoot', 'cacheReset',
  ], 'benchmark_lifecycle_unknown_field');
  if (!Array.isArray(record.randomizedPairOrder)) throw new Error('benchmark_lifecycle_pair_order_invalid');
  if (!Array.isArray(record.warmupPairOrder)) throw new Error('benchmark_lifecycle_warmup_pair_order_invalid');
  if (!Array.isArray(record.pairResetReceipts)) throw new Error('benchmark_lifecycle_pair_reset_receipts_invalid');
  if (typeof record.freshSessionsVerified !== 'boolean') throw new Error('benchmark_lifecycle_fresh_sessions_invalid');
  const dataRoot = asRecord(record.dataRoot, 'benchmark_lifecycle_data_root_invalid');
  assertKnownFields(dataRoot, ['idHash', 'fresh', 'verified'], 'benchmark_lifecycle_data_root_unknown_field');
  if (typeof dataRoot.fresh !== 'boolean' || typeof dataRoot.verified !== 'boolean') {
    throw new Error('benchmark_lifecycle_data_root_invalid');
  }
  const cacheReset = asRecord(record.cacheReset, 'benchmark_lifecycle_cache_reset_invalid');
  assertKnownFields(cacheReset, ['declared', 'receiptHash', 'reason'], 'benchmark_lifecycle_cache_reset_unknown_field');
  if (typeof cacheReset.declared !== 'boolean') throw new Error('benchmark_lifecycle_cache_reset_invalid');
  const outputRoot = boundedString(record.outputRoot, 'benchmark_lifecycle_output_root_invalid');
  if (path.isAbsolute(outputRoot) || outputRoot.includes('..') || !outputRoot.startsWith('test-output/runtime-concurrency/')) {
    throw new Error('benchmark_lifecycle_output_root_invalid');
  }
  return {
    targetUrl: validateTargetUrl(boundedString(record.targetUrl, 'benchmark_lifecycle_target_url_invalid')),
    ...(record.serverIdentityHash !== undefined
      ? {serverIdentityHash: strictHash(record.serverIdentityHash, 'benchmark_lifecycle_server_identity_hash_invalid')}
      : {}),
    ...(record.targetConfigHash !== undefined
      ? {targetConfigHash: strictHash(record.targetConfigHash, 'benchmark_lifecycle_target_config_hash_invalid')}
      : {}),
    ...(record.sourceHash !== undefined
      ? {sourceHash: strictHash(record.sourceHash, 'benchmark_lifecycle_source_hash_invalid')}
      : {}),
    outputRunNonce: strictHash(record.outputRunNonce, 'benchmark_lifecycle_output_run_nonce_invalid'),
    pairResetReceipts: record.pairResetReceipts.map(parsePairResetReceipt),
    randomizedPairOrder: record.randomizedPairOrder.map(parsePairOrderEntry),
    warmupPairOrder: record.warmupPairOrder.map(parsePairOrderEntry),
    freshSessionsVerified: record.freshSessionsVerified,
    dataRoot: {
      idHash: strictHash(dataRoot.idHash, 'benchmark_lifecycle_data_root_hash_invalid'),
      fresh: dataRoot.fresh,
      verified: dataRoot.verified,
    },
    outputRoot,
    cacheReset: {
      declared: cacheReset.declared,
      ...(cacheReset.receiptHash !== undefined
        ? {receiptHash: strictHash(cacheReset.receiptHash, 'benchmark_lifecycle_cache_reset_hash_invalid')}
        : {}),
      ...(cacheReset.reason !== undefined ? {reason: boundedString(cacheReset.reason, 'benchmark_lifecycle_cache_reset_reason_invalid')} : {}),
    },
  };
}

function parseArtifactScope(value: unknown): RuntimeBenchmarkArtifactScope | null {
  if (value === null) return null;
  const record = asRecord(value, 'benchmark_artifact_scope_invalid');
  assertKnownFields(record, [
    'runtime', 'candidateId', 'candidateConfigFingerprint', 'outputRunNonce', 'sampleKind',
  ], 'benchmark_artifact_scope_unknown_field');
  const candidateId = parseCandidate(record.candidateId);
  if (!isProductionAgentRuntimeKind(record.runtime)) throw new Error('benchmark_artifact_scope_runtime_invalid');
  if (!CANDIDATE_RUNTIME_MATRIX[candidateId].includes(record.runtime)) {
    throw new Error('benchmark_artifact_scope_candidate_runtime_invalid');
  }
  if (record.sampleKind !== 'real' && record.sampleKind !== 'deterministic') {
    throw new Error('benchmark_artifact_scope_sample_kind_invalid');
  }
  return {
    runtime: record.runtime,
    candidateId,
    candidateConfigFingerprint: strictHash(
      record.candidateConfigFingerprint,
      'benchmark_artifact_scope_candidate_config_invalid',
    ),
    outputRunNonce: strictHash(record.outputRunNonce, 'benchmark_artifact_scope_output_nonce_invalid'),
    sampleKind: record.sampleKind,
  };
}

function assertArtifactScopeConsistency(
  scope: RuntimeBenchmarkArtifactScope | null,
  lifecycle: BenchmarkLifecycleMetadata,
  cells: readonly RuntimeBenchmarkCell[],
  executionProvenance: BenchmarkExecutionProvenance,
): void {
  const orderEntries = [...lifecycle.randomizedPairOrder, ...lifecycle.warmupPairOrder];
  if (!scope) {
    if (cells.length > 0 || orderEntries.length > 0 || lifecycle.pairResetReceipts.length > 0) {
      throw new Error('benchmark_artifact_unscoped_content_forbidden');
    }
    return;
  }
  if (lifecycle.outputRunNonce !== scope.outputRunNonce) {
    throw new Error('benchmark_artifact_scope_output_nonce_mismatch');
  }
  if (scope.sampleKind === 'real' && executionProvenance !== 'real_provider') {
    throw new Error('benchmark_artifact_scope_provenance_mismatch');
  }
  if (scope.sampleKind === 'deterministic' && executionProvenance === 'real_provider') {
    throw new Error('benchmark_artifact_scope_provenance_mismatch');
  }
  if (cells.some(cell =>
    cell.runtime !== scope.runtime
    || cell.candidate !== scope.candidateId
    || cell.candidateConfigFingerprint !== scope.candidateConfigFingerprint)) {
    throw new Error('benchmark_artifact_scope_cell_mismatch');
  }
  if (orderEntries.some(entry =>
    entry.runtime !== scope.runtime
    || entry.candidate !== scope.candidateId)) {
    throw new Error('benchmark_artifact_scope_pair_order_mismatch');
  }
  if (lifecycle.pairResetReceipts.some(receipt =>
    receipt.runtime !== scope.runtime
    || receipt.candidateId !== scope.candidateId)) {
    throw new Error('benchmark_artifact_scope_pair_reset_mismatch');
  }
}

export function parseRuntimeBenchmarkArtifact(value: unknown): RuntimeBenchmarkArtifactV1 {
  const record = asRecord(value, 'benchmark_artifact_required');
  assertKnownFields(record, ['schemaVersion', 'role', 'executionProvenance', 'scope', 'lifecycle', 'cells'], 'benchmark_artifact_unknown_field');
  if (record.schemaVersion !== 1) throw new Error('benchmark_artifact_version_invalid');
  if (record.role !== 'base' && record.role !== 'candidate') throw new Error('benchmark_artifact_role_invalid');
  if (!Array.isArray(record.cells)) throw new Error('benchmark_artifact_cells_invalid');
  const executionProvenance = parseExecutionProvenance(record.executionProvenance);
  const scope = parseArtifactScope(record.scope);
  const lifecycle = parseLifecycle(record.lifecycle);
  const cells = record.cells.map(parseRuntimeBenchmarkCell);
  if (cells.some(cell => cell.executionProvenance !== executionProvenance)) {
    throw new Error('benchmark_artifact_provenance_mismatch');
  }
  assertArtifactScopeConsistency(scope, lifecycle, cells, executionProvenance);
  return {
    schemaVersion: 1,
    role: record.role,
    executionProvenance,
    scope,
    lifecycle,
    cells,
  };
}

const PAIRED_IDENTITY_FIELDS: Array<keyof RuntimeBenchmarkCell> = [
  'candidate', 'executionProvenance', 'candidateConfigFingerprint', 'runtime', 'providerId', 'model', 'providerSnapshotHash', 'trace', 'queryHash', 'mode',
  'scenario', 'repetition', 'warmup', 'cacheState',
];

export function assertPairedBenchmarkCells(base: RuntimeBenchmarkCell, candidate: RuntimeBenchmarkCell): void {
  for (const field of PAIRED_IDENTITY_FIELDS) {
    if (base[field] !== candidate[field]) {
      throw new Error(`benchmark_pair_identity_mismatch:${field}`);
    }
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function finalReportGateRank(value: string): number {
  if (value === 'passed') return 2;
  if (value === 'partial') return 1;
  return 0;
}

function isAuthorizedFingerprintChange(
  base: RuntimeBenchmarkCell,
  candidate: RuntimeBenchmarkCell,
  authorizations: readonly SemanticGoldenAuthorization[],
  sampleKind: BenchmarkSampleKind,
): boolean {
  return authorizations.some(authorization =>
    authorization.authorizationId.trim().length >= 8
    && authorization.candidateId === base.candidate
    && authorization.runtime === base.runtime
    && authorization.scenario === base.scenario
    && authorization.sampleKind === sampleKind
    && authorization.baseFingerprint === base.quality.semanticFingerprint
    && authorization.candidateFingerprint === candidate.quality.semanticFingerprint);
}

function qualityJudgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  authorizations: readonly SemanticGoldenAuthorization[],
  sampleKind: BenchmarkSampleKind,
): BenchmarkMetricJudgment {
  const reasons: string[] = [];
  for (const [base, candidate] of pairs) {
    const fingerprintEqual = base.quality.semanticFingerprint === candidate.quality.semanticFingerprint;
    if (!fingerprintEqual && !isAuthorizedFingerprintChange(base, candidate, authorizations, sampleKind)) {
      reasons.push(`semantic_fingerprint_regression:${base.scenario}:${base.repetition}`);
    }
    if (candidate.quality.unsupportedClaims > base.quality.unsupportedClaims) reasons.push('unsupported_claims_regression');
    if (candidate.quality.verifiedClaims < base.quality.verifiedClaims) reasons.push('verified_claims_regression');
    if (candidate.quality.identityErrors > base.quality.identityErrors) reasons.push('identity_errors_regression');
    if (finalReportGateRank(candidate.quality.finalReportGate) < finalReportGateRank(base.quality.finalReportGate)) {
      reasons.push('final_report_gate_regression');
    }
    if (finalReportGateRank(candidate.quality.claimVerificationGate) < finalReportGateRank(base.quality.claimVerificationGate)) {
      reasons.push('claim_verification_gate_regression');
    }
    if (finalReportGateRank(candidate.quality.identityResolutionGate) < finalReportGateRank(base.quality.identityResolutionGate)) {
      reasons.push('identity_resolution_gate_regression');
    }
    if (!arraysEqual(base.quality.evidenceBindingHashes, candidate.quality.evidenceBindingHashes)) {
      reasons.push('evidence_bindings_regression');
    }
    if (!arraysEqual(base.quality.identityBindingHashes, candidate.quality.identityBindingHashes)) {
      reasons.push('identity_bindings_regression');
    }
    if (!arraysEqual(base.quality.sourceBindingHashes, candidate.quality.sourceBindingHashes)) {
      reasons.push('source_bindings_regression');
    }
  }
  return {status: reasons.length > 0 ? 'FAIL' : 'PASS', reasons: [...new Set(reasons)]};
}

function providerUsageMissingReasons(usage: ProviderUsageReceiptV1 | undefined): string[] {
  if (!usage) return ['provider_usage_missing'];
  const reasons: string[] = [];
  if (usage.inputTokens === undefined) reasons.push('provider_input_tokens_missing');
  if (usage.outputTokens === undefined) reasons.push('provider_output_tokens_missing');
  if (usage.cacheReadTokens === undefined) reasons.push('provider_cache_tokens_missing');
  if (usage.reasoningTokens === undefined) reasons.push('provider_reasoning_tokens_missing');
  if (usage.costUsd === undefined) reasons.push('provider_cost_missing');
  return reasons;
}

function observabilityJudgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  lifecycleReasons: readonly string[],
): BenchmarkMetricJudgment {
  const reasons: string[] = [...lifecycleReasons];
  for (const [base, candidate] of pairs) {
    for (const cell of [base, candidate]) {
      if (!cell.model) reasons.push('model_missing');
      if (!cell.providerSnapshotHash) reasons.push('provider_snapshot_hash_missing');
      reasons.push(...providerUsageMissingReasons(cell.providerUsage));
      if (cell.firstOutputMs === undefined) reasons.push('first_output_missing');
      if (!cell.performance) reasons.push('runtime_performance_missing');
      if (!cell.targetBinding.observedQueryHash) reasons.push('observed_query_hash_missing');
      if (!cell.targetBinding.observedMode) reasons.push('observed_mode_missing');
      if (!cell.targetBinding.resolvedMode) reasons.push('resolved_mode_missing');
      if (!cell.targetBinding.observedCandidateId) reasons.push('observed_candidate_id_missing');
      if (!cell.targetBinding.observedCandidateConfigFingerprint) reasons.push('observed_candidate_config_fingerprint_missing');
      if (!cell.targetBinding.observedTargetConfigHash) reasons.push('observed_target_config_hash_missing');
      if (!cell.targetBinding.observedSourceHash) reasons.push('observed_source_hash_missing');
      if (cell.terminalOutcome !== 'completed') reasons.push(`terminal_outcome_${cell.terminalOutcome}`);
      if (!cell.cleanup.session.attempted || !cell.cleanup.session.success) reasons.push('session_cleanup_failed');
      if (!cell.cleanup.trace.attempted || !cell.cleanup.trace.success) reasons.push('trace_cleanup_failed');
      const truncated = cell.performance?.truncated;
      if (truncated && (truncated.phases > 0 || truncated.tools > 0 || truncated.sql > 0)) {
        reasons.push('runtime_performance_truncated');
      }
      if (
        cell.performance?.phases.some(phase => phase.outcome !== 'ok')
        || cell.performance?.tools.some(tool => tool.outcome !== 'ok')
        || cell.performance?.sql.some(sql => sql.outcome !== 'ok')
      ) {
        reasons.push('runtime_performance_non_ok');
      }
    }
  }
  return {status: reasons.length > 0 ? 'INCONCLUSIVE' : 'PASS', reasons: [...new Set(reasons)]};
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('benchmark_metric_samples_missing');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error('benchmark_metric_samples_missing');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function improvementPercent(base: number, candidate: number): number | undefined {
  if (base <= 0) return undefined;
  return ((base - candidate) / base) * 100;
}

function materialRegression(base: number, candidate: number): boolean {
  if (candidate <= base) return false;
  const absolute = candidate - base;
  const percent = base > 0 ? (absolute / base) * 100 : Number.POSITIVE_INFINITY;
  return percent > 5 && absolute > 250;
}

function totalDuration(cell: RuntimeBenchmarkCell): number {
  return cell.terminalMs - cell.acceptedAtMs;
}

function targetPhaseDuration(
  cell: RuntimeBenchmarkCell,
  targetPhases: readonly RuntimePerformancePhaseReceiptV1['name'][],
): number | undefined {
  if (!cell.performance) return undefined;
  const matching = cell.performance.phases.filter(phase => targetPhases.includes(phase.name));
  if (matching.length === 0) return undefined;
  return matching.reduce((sum, phase) => sum + phase.durationMs, 0);
}

function performanceJudgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  targetPhases: readonly RuntimePerformancePhaseReceiptV1['name'][],
  observability: BenchmarkMetricJudgment,
): BenchmarkMetricJudgment {
  if (observability.status !== 'PASS') return {status: 'INCONCLUSIVE', reasons: [...observability.reasons]};
  const baseTotal = median(pairs.map(([base]) => totalDuration(base)));
  const candidateTotal = median(pairs.map(([, candidate]) => totalDuration(candidate)));
  const basePhases = pairs.map(([base]) => targetPhaseDuration(base, targetPhases));
  const candidatePhases = pairs.map(([, candidate]) => targetPhaseDuration(candidate, targetPhases));
  const totalImprovement = improvementPercent(baseTotal, candidateTotal);
  if (totalImprovement === undefined) {
    return {status: 'INCONCLUSIVE', base: baseTotal, candidate: candidateTotal, reasons: ['zero_baseline_total']};
  }
  if (totalImprovement >= 15) {
    return {
      status: 'PASS',
      base: baseTotal,
      candidate: candidateTotal,
      improvementPercent: totalImprovement,
      reasons: [],
    };
  }
  if (targetPhases.length === 0) {
    return {
      status: 'FAIL',
      base: baseTotal,
      candidate: candidateTotal,
      improvementPercent: totalImprovement,
      reasons: ['performance_threshold_not_met'],
    };
  }
  if (basePhases.some(value => value === undefined) || candidatePhases.some(value => value === undefined)) {
    return {status: 'INCONCLUSIVE', base: baseTotal, candidate: candidateTotal, improvementPercent: totalImprovement, reasons: ['mapped_target_phase_missing']};
  }
  const basePhase = median(basePhases as number[]);
  const candidatePhase = median(candidatePhases as number[]);
  const phaseImprovement = improvementPercent(basePhase, candidatePhase);
  if (phaseImprovement === undefined) {
    return {status: 'INCONCLUSIVE', base: baseTotal, candidate: candidateTotal, improvementPercent: totalImprovement, reasons: ['zero_baseline_target_phase']};
  }
  const passed = phaseImprovement >= 30;
  return {
    status: passed ? 'PASS' : 'FAIL',
    base: baseTotal,
    candidate: candidateTotal,
    improvementPercent: Math.max(totalImprovement, phaseImprovement),
    reasons: passed ? [] : ['performance_threshold_not_met'],
  };
}

function medianFirstOutputJudgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  observability: BenchmarkMetricJudgment,
): BenchmarkMetricJudgment {
  if (observability.status !== 'PASS') return {status: 'INCONCLUSIVE', reasons: ['first_output_missing']};
  const base = median(pairs.map(([cell]) => cell.firstOutputMs!));
  const candidate = median(pairs.map(([, cell]) => cell.firstOutputMs!));
  if (base <= 0) return {status: 'INCONCLUSIVE', base, candidate, reasons: ['zero_baseline_first_output']};
  return {
    status: materialRegression(base, candidate) ? 'FAIL' : 'PASS',
    base,
    candidate,
    reasons: materialRegression(base, candidate) ? ['material_first_output_median_regression'] : [],
  };
}

function observedMaxJudgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  sampleKind: BenchmarkSampleKind,
  observability: BenchmarkMetricJudgment,
): BenchmarkMetricJudgment {
  if (sampleKind !== 'real') return {status: 'INCONCLUSIVE', reasons: ['observed_max_real_only']};
  if (pairs.length !== REAL_MEASURED_REPETITIONS) {
    return {status: 'INCONCLUSIVE', reasons: ['real_sample_count_must_equal_3']};
  }
  if (observability.status !== 'PASS') return {status: 'INCONCLUSIVE', reasons: [...observability.reasons]};
  const baseTotal = Math.max(...pairs.map(([cell]) => totalDuration(cell)));
  const candidateTotal = Math.max(...pairs.map(([, cell]) => totalDuration(cell)));
  const baseFirst = Math.max(...pairs.map(([cell]) => cell.firstOutputMs!));
  const candidateFirst = Math.max(...pairs.map(([, cell]) => cell.firstOutputMs!));
  if (baseTotal <= 0 || baseFirst <= 0) {
    return {status: 'INCONCLUSIVE', base: baseTotal, candidate: candidateTotal, reasons: ['zero_baseline_observed_max']};
  }
  const failed = materialRegression(baseTotal, candidateTotal) || materialRegression(baseFirst, candidateFirst);
  return {
    status: failed ? 'FAIL' : 'PASS',
    base: baseTotal,
    candidate: candidateTotal,
    reasons: failed ? ['material_observed_max_regression'] : [],
  };
}

function p95Judgment(
  pairs: Array<[RuntimeBenchmarkCell, RuntimeBenchmarkCell]>,
  sampleKind: BenchmarkSampleKind,
  metric: 'total' | 'first_output',
  observability: BenchmarkMetricJudgment,
): BenchmarkMetricJudgment {
  if (sampleKind === 'real') return {status: 'INCONCLUSIVE', reasons: ['real_p95_requires_more_than_3_samples']};
  if (pairs.length < MIN_DETERMINISTIC_P95_SAMPLES) {
    return {status: 'INCONCLUSIVE', reasons: ['deterministic_p95_requires_30_samples']};
  }
  if (observability.status !== 'PASS') return {status: 'INCONCLUSIVE', reasons: [...observability.reasons]};
  const baseValues = pairs.map(([cell]) => metric === 'total' ? totalDuration(cell) : cell.firstOutputMs!);
  const candidateValues = pairs.map(([, cell]) => metric === 'total' ? totalDuration(cell) : cell.firstOutputMs!);
  const base = percentile95(baseValues);
  const candidate = percentile95(candidateValues);
  if (base <= 0) return {status: 'INCONCLUSIVE', base, candidate, reasons: [`zero_baseline_${metric}_p95`]};
  const failed = materialRegression(base, candidate);
  return {
    status: failed ? 'FAIL' : 'PASS',
    base,
    candidate,
    reasons: failed ? [`material_${metric}_p95_regression`] : [],
  };
}

function logicalCellKey(cell: RuntimeBenchmarkCell): string {
  return [
    cell.candidate,
    cell.runtime,
    cell.scenario,
    cell.warmup ? 'warmup' : 'measured',
    String(cell.repetition),
    cell.cacheState,
  ].join('|');
}

function pairOrderKey(entry: BenchmarkPairOrderEntry, warmup: boolean): string {
  return [
    entry.candidate,
    entry.runtime,
    entry.scenario,
    warmup ? 'warmup' : 'measured',
    String(entry.repetition),
    entry.cacheState,
  ].join('|');
}

function pairResetKey(entry: BenchmarkPairResetReceipt): string {
  return [
    entry.candidateId,
    entry.runtime,
    entry.scenario,
    entry.repetition === 0 ? 'warmup' : 'measured',
    String(entry.repetition),
    entry.cacheState,
  ].join('|');
}

function assertUniqueKeys(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function validateArtifactPairOrder(artifact: RuntimeBenchmarkArtifactV1): void {
  const measuredCellKeys = artifact.cells.filter(cell => !cell.warmup).map(logicalCellKey);
  const warmupCellKeys = artifact.cells.filter(cell => cell.warmup).map(logicalCellKey);
  const measuredOrderKeys = artifact.lifecycle.randomizedPairOrder.map(entry => pairOrderKey(entry, false));
  const warmupOrderKeys = artifact.lifecycle.warmupPairOrder.map(entry => pairOrderKey(entry, true));
  const resetKeys = artifact.lifecycle.pairResetReceipts.map(pairResetKey);
  const resetHashes = artifact.lifecycle.pairResetReceipts.map(entry => entry.resetReceiptHash);
  assertUniqueKeys(measuredCellKeys, 'benchmark_duplicate_measured_cell');
  assertUniqueKeys(warmupCellKeys, 'benchmark_duplicate_warmup_cell');
  assertUniqueKeys(measuredOrderKeys, 'benchmark_duplicate_pair_order');
  assertUniqueKeys(warmupOrderKeys, 'benchmark_duplicate_warmup_pair_order');
  assertUniqueKeys(resetKeys, 'benchmark_duplicate_pair_reset_receipt');
  assertUniqueKeys(resetHashes, 'benchmark_duplicate_pair_reset_hash');
  if (!arraysEqual(sorted(measuredCellKeys), sorted(measuredOrderKeys))) throw new Error('benchmark_pair_order_coverage_mismatch');
  if (!arraysEqual(sorted(warmupCellKeys), sorted(warmupOrderKeys))) throw new Error('benchmark_warmup_pair_order_coverage_mismatch');
  if (!arraysEqual(sorted([...measuredCellKeys, ...warmupCellKeys]), sorted(resetKeys))) {
    throw new Error('benchmark_pair_reset_coverage_mismatch');
  }
}

function validateRepetitions(
  cells: readonly RuntimeBenchmarkCell[],
  sampleKind: BenchmarkSampleKind,
): void {
  const measured = cells.filter(cell => !cell.warmup).map(cell => cell.repetition).sort((left, right) => left - right);
  const expectedCount = sampleKind === 'real' ? REAL_MEASURED_REPETITIONS : MIN_DETERMINISTIC_P95_SAMPLES;
  const expected = Array.from({length: expectedCount}, (_, index) => index + 1);
  if (measured.length !== expected.length || measured.some((value, index) => value !== expected[index])) {
    throw new Error(sampleKind === 'real'
      ? 'benchmark_real_repetitions_must_be_exact_1_to_3'
      : 'benchmark_deterministic_repetitions_must_be_exact_1_to_30');
  }
  const warmups = cells.filter(cell => cell.warmup);
  if (sampleKind === 'real') {
    if (warmups.length !== 1 || warmups[0].repetition !== 0 || warmups[0].cacheState !== 'cold') {
      throw new Error('benchmark_real_warmup_required');
    }
    if (cells.filter(cell => !cell.warmup).some(cell => cell.cacheState !== 'warm')) {
      throw new Error('benchmark_real_measured_cells_must_be_warm');
    }
  } else if (warmups.length !== 0) {
    throw new Error('benchmark_deterministic_warmup_unexpected');
  }
}

function lifecycleJudgment(
  base: RuntimeBenchmarkArtifactV1,
  candidate: RuntimeBenchmarkArtifactV1,
  baseCells: readonly RuntimeBenchmarkCell[],
  candidateCells: readonly RuntimeBenchmarkCell[],
): BenchmarkMetricJudgment {
  const groupCells = [...baseCells, ...candidateCells];
  const reasons: string[] = [];
  if (!base.lifecycle.freshSessionsVerified || !candidate.lifecycle.freshSessionsVerified) reasons.push('fresh_sessions_unverified');
  if (!base.lifecycle.dataRoot.fresh || !candidate.lifecycle.dataRoot.fresh) reasons.push('fresh_data_root_unverified');
  if (!base.lifecycle.dataRoot.verified || !candidate.lifecycle.dataRoot.verified) reasons.push('data_root_identity_unverified');
  if (base.lifecycle.dataRoot.idHash === candidate.lifecycle.dataRoot.idHash) reasons.push('data_roots_not_distinct');
  if (!base.lifecycle.serverIdentityHash || !candidate.lifecycle.serverIdentityHash) reasons.push('server_identity_missing');
  if (
    base.lifecycle.serverIdentityHash
    && base.lifecycle.serverIdentityHash === candidate.lifecycle.serverIdentityHash
  ) reasons.push('server_identities_not_distinct');
  if (!base.lifecycle.targetConfigHash || !candidate.lifecycle.targetConfigHash) reasons.push('target_config_hash_missing');
  if (!base.lifecycle.sourceHash || !candidate.lifecycle.sourceHash) reasons.push('source_hash_missing');
  if (baseCells.some(cell => cell.targetBinding.observedTargetConfigHash !== base.lifecycle.targetConfigHash)) {
    reasons.push('base_target_config_hash_mismatch');
  }
  if (candidateCells.some(cell => cell.targetBinding.observedTargetConfigHash !== candidate.lifecycle.targetConfigHash)) {
    reasons.push('candidate_target_config_hash_mismatch');
  }
  if (baseCells.some(cell => cell.targetBinding.observedSourceHash !== base.lifecycle.sourceHash)) {
    reasons.push('base_source_hash_mismatch');
  }
  if (candidateCells.some(cell => cell.targetBinding.observedSourceHash !== candidate.lifecycle.sourceHash)) {
    reasons.push('candidate_source_hash_mismatch');
  }
  if (!base.lifecycle.cacheReset.declared || !candidate.lifecycle.cacheReset.declared) reasons.push('cache_reset_not_declared');
  if (!base.lifecycle.cacheReset.receiptHash || !candidate.lifecycle.cacheReset.receiptHash) reasons.push('cache_reset_receipt_missing');
  if (
    base.lifecycle.pairResetReceipts.some(receipt => !receipt.verified)
    || candidate.lifecycle.pairResetReceipts.some(receipt => !receipt.verified)
  ) reasons.push('pair_reset_receipt_unverified');
  if (groupCells.some(cell => !cell.cleanup.session.attempted || !cell.cleanup.session.success)) reasons.push('session_cleanup_failed');
  if (groupCells.some(cell => !cell.cleanup.trace.attempted || !cell.cleanup.trace.success)) reasons.push('trace_cleanup_failed');
  if (groupCells.some(cell => cell.terminalOutcome !== 'completed')) reasons.push('non_completed_cell_present');
  return {status: reasons.length > 0 ? 'INCONCLUSIVE' : 'PASS', reasons};
}

export function scoreCandidateAdmission(input: ScoreCandidateAdmissionInput): CandidateAdmissionResult {
  const baseArtifact = parseRuntimeBenchmarkArtifact(input.baseArtifact);
  const candidateArtifact = parseRuntimeBenchmarkArtifact(input.candidateArtifact);
  if (baseArtifact.role !== 'base' || candidateArtifact.role !== 'candidate') throw new Error('benchmark_artifact_roles_mismatch');
  if (baseArtifact.executionProvenance !== candidateArtifact.executionProvenance) throw new Error('benchmark_artifact_provenance_pair_mismatch');
  if (!baseArtifact.scope || !candidateArtifact.scope) throw new Error('benchmark_artifact_scope_required');
  if (canonicalJsonString(baseArtifact.scope) !== canonicalJsonString(candidateArtifact.scope)) {
    throw new Error('benchmark_artifact_scope_pair_mismatch');
  }
  if (
    baseArtifact.scope.candidateId !== input.candidate
    || baseArtifact.scope.runtime !== input.runtime
    || baseArtifact.scope.sampleKind !== input.sampleKind
  ) {
    throw new Error('benchmark_artifact_scope_request_mismatch');
  }
  if (baseArtifact.lifecycle.targetUrl === candidateArtifact.lifecycle.targetUrl) throw new Error('benchmark_targets_must_differ');
  validateArtifactPairOrder(baseArtifact);
  validateArtifactPairOrder(candidateArtifact);
  if (
    canonicalJsonString(baseArtifact.lifecycle.randomizedPairOrder)
      !== canonicalJsonString(candidateArtifact.lifecycle.randomizedPairOrder)
    || canonicalJsonString(baseArtifact.lifecycle.warmupPairOrder)
      !== canonicalJsonString(candidateArtifact.lifecycle.warmupPairOrder)
    || canonicalJsonString(baseArtifact.lifecycle.pairResetReceipts)
      !== canonicalJsonString(candidateArtifact.lifecycle.pairResetReceipts)
    || baseArtifact.lifecycle.outputRunNonce !== candidateArtifact.lifecycle.outputRunNonce
  ) {
    throw new Error('benchmark_pair_order_artifact_mismatch');
  }
  if (!CANDIDATE_RUNTIME_MATRIX[input.candidate].includes(input.runtime)) throw new Error('benchmark_candidate_runtime_invalid');
  const matchesGroup = (cell: RuntimeBenchmarkCell) =>
    cell.candidate === input.candidate
    && cell.runtime === input.runtime
    && cell.scenario === input.scenario;
  const baseGroup = baseArtifact.cells.filter(matchesGroup);
  const candidateGroup = candidateArtifact.cells.filter(matchesGroup);
  if (baseGroup.length === 0 || baseGroup.length !== candidateGroup.length) throw new Error('benchmark_pair_sample_count_mismatch');
  validateRepetitions(baseGroup, input.sampleKind);
  validateRepetitions(candidateGroup, input.sampleKind);
  const baseByKey = new Map(baseGroup.map(cell => [logicalCellKey(cell), cell]));
  const candidateByKey = new Map(candidateGroup.map(cell => [logicalCellKey(cell), cell]));
  if (!arraysEqual(sorted([...baseByKey.keys()]), sorted([...candidateByKey.keys()]))) {
    throw new Error('benchmark_pair_keys_mismatch');
  }
  for (const baseCell of baseGroup) {
    assertPairedBenchmarkCells(baseCell, candidateByKey.get(logicalCellKey(baseCell))!);
  }
  const baseMeasured = baseGroup.filter(cell => !cell.warmup).sort((left, right) => left.repetition - right.repetition);
  const candidateMeasured = baseMeasured.map(base => candidateByKey.get(logicalCellKey(base))!);
  const sampleIdentity = (cell: RuntimeBenchmarkCell): string => canonicalJsonString({
    candidate: cell.candidate,
    executionProvenance: cell.executionProvenance,
    candidateConfigFingerprint: cell.candidateConfigFingerprint,
    runtime: cell.runtime,
    providerId: cell.providerId,
    model: cell.model ?? null,
    providerSnapshotHash: cell.providerSnapshotHash ?? null,
    trace: cell.trace,
    queryHash: cell.queryHash,
    mode: cell.mode,
    scenario: cell.scenario,
  });
  const expectedIdentity = sampleIdentity(baseGroup[0]);
  if (
    baseGroup.some(cell => sampleIdentity(cell) !== expectedIdentity)
    || candidateGroup.some(cell => sampleIdentity(cell) !== expectedIdentity)
  ) {
    throw new Error('benchmark_sample_identity_drift');
  }
  const pairs = baseMeasured.map((base, index): [RuntimeBenchmarkCell, RuntimeBenchmarkCell] => {
    const candidate = candidateMeasured[index];
    assertPairedBenchmarkCells(base, candidate);
    return [base, candidate];
  });
  const targetPhases = CANDIDATE_TARGET_PHASES[input.candidate];
  const quality = qualityJudgment(pairs, input.semanticGoldenAuthorizations ?? [], input.sampleKind);
  const provenanceReasons: string[] = [];
  if (input.sampleKind === 'deterministic' && baseArtifact.executionProvenance !== 'genuine_adapter') {
    provenanceReasons.push('deterministic_genuine_adapter_required');
  }
  if (input.sampleKind === 'real' && baseArtifact.executionProvenance !== 'real_provider') {
    provenanceReasons.push('real_provider_provenance_required');
  }
  const lifecycle = lifecycleJudgment(baseArtifact, candidateArtifact, baseGroup, candidateGroup);
  lifecycle.reasons.push(...provenanceReasons);
  if (provenanceReasons.length > 0) lifecycle.status = 'INCONCLUSIVE';
  const observability = observabilityJudgment(pairs, lifecycle.reasons);
  const performance = performanceJudgment(pairs, targetPhases, observability);
  const firstOutputMedian = medianFirstOutputJudgment(pairs, observability);
  const observedMax = observedMaxJudgment(pairs, input.sampleKind, observability);
  const totalP95 = p95Judgment(pairs, input.sampleKind, 'total', observability);
  const firstOutputP95 = p95Judgment(pairs, input.sampleKind, 'first_output', observability);
  const sampleSpecificPass = input.sampleKind === 'real'
    ? observedMax.status === 'PASS'
    : totalP95.status === 'PASS' && firstOutputP95.status === 'PASS';
  const admitted = quality.status === 'PASS'
    && observability.status === 'PASS'
    && performance.status === 'PASS'
    && firstOutputMedian.status === 'PASS'
    && sampleSpecificPass;
  const reasons = [...new Set([
    ...quality.reasons,
    ...observability.reasons,
    ...performance.reasons,
    ...firstOutputMedian.reasons,
    ...(input.sampleKind === 'real' ? observedMax.reasons : []),
    ...(input.sampleKind === 'deterministic' ? totalP95.reasons : []),
    ...(input.sampleKind === 'deterministic' ? firstOutputP95.reasons : []),
  ])];
  return {
    scope: {...baseArtifact.scope},
    candidate: input.candidate,
    candidateId: input.candidate,
    runtime: input.runtime,
    scenario: input.scenario,
    sampleKind: input.sampleKind,
    candidateConfigFingerprint: baseMeasured[0].candidateConfigFingerprint,
    targetPhases,
    decision: admitted ? 'default_on' : 'serial',
    quality,
    observability,
    performance,
    firstOutputMedian,
    observedMax,
    totalP95,
    firstOutputP95,
    reasons,
  };
}

export function aggregateCandidateAdmissions(
  groups: CandidateAdmissionResult[],
  candidateId: BenchmarkCandidate,
  sampleKind: BenchmarkSampleKind,
): CandidateAdmissionAggregateResult {
  const selected = groups.filter(group => group.candidateId === candidateId && group.sampleKind === sampleKind);
  if (selected.length === 0) throw new Error('benchmark_candidate_aggregate_groups_missing');
  if (selected.some(group =>
    group.scope.candidateId !== group.candidateId
    || group.scope.runtime !== group.runtime
    || group.scope.sampleKind !== group.sampleKind
    || group.scope.candidateConfigFingerprint !== group.candidateConfigFingerprint)) {
    throw new Error('benchmark_candidate_result_scope_mismatch');
  }
  const keys = selected.map(group => `${group.runtime}|${group.scenario}`);
  assertUniqueKeys(keys, 'benchmark_candidate_aggregate_duplicate_group');
  const configFingerprints = [...new Set(selected.map(group => group.candidateConfigFingerprint))];
  if (configFingerprints.length !== 1) throw new Error('benchmark_candidate_aggregate_mixed_config_fingerprints');
  const requiredKeys = CANDIDATE_RUNTIME_MATRIX[candidateId].flatMap(runtime =>
    (['startup-full', 'scrolling-full', 'identity-fast'] as const).map(scenario => `${runtime}|${scenario}`));
  const missingReasons = requiredKeys
    .filter(key => !keys.includes(key))
    .map(key => `missing_required_group:${key}`);
  const reasons = [
    ...missingReasons,
    ...selected.flatMap(group => group.decision === 'default_on'
    ? []
      : [`${group.runtime}:${group.scenario}:${group.reasons.join(',') || 'inconclusive'}`]),
  ];
  return {
    candidateId,
    candidateConfigFingerprint: configFingerprints[0],
    sampleKind,
    decision: reasons.length === 0 ? 'default_on' : 'serial',
    groups: selected,
    reasons,
  };
}

function validateTargetUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('benchmark_target_url_invalid');
  }
  if (url.username || url.password) throw new Error('benchmark_target_url_credentials_forbidden');
  if (url.protocol !== 'http:') throw new Error('benchmark_target_url_protocol_invalid');
  const hostname = url.hostname.toLowerCase();
  if (!['127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new Error('benchmark_target_url_not_loopback');
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('benchmark_target_url_port_required');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('benchmark_target_url_shape_invalid');
  return url.origin;
}

export function buildDirectHttpRequestOptions(rawUrl: string, method = 'GET'): RequestOptions {
  const url = new URL(rawUrl);
  validateTargetUrl(url.origin);
  if (url.username || url.password || url.search || url.hash) throw new Error('benchmark_target_url_shape_invalid');
  return {
    protocol: 'http:',
    hostname: url.hostname === '[::1]' ? '::1' : url.hostname,
    port: Number(url.port),
    method,
    path: url.pathname,
    agent: false,
  };
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

export function directHttpResponse(
  rawUrl: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    writeBody?: (request: http.ClientRequest) => void;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      ...buildDirectHttpRequestOptions(rawUrl, options.method),
      headers: options.headers,
    };
    let settled = false;
    let responseReceived = false;
    const removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const request = http.request(requestOptions, message => {
      responseReceived = true;
      if (settled) {
        message.destroy();
        return;
      }
      message.once('close', removeAbortListener);
      try {
        const status = message.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          rejectOnce(new Error('benchmark_redirect_forbidden'));
          message.destroy();
          return;
        }
        const body = status === 204 || status === 304
          ? null
          : Readable.toWeb(message) as ReadableStream<Uint8Array>;
        const response = new Response(body, {
          status,
          headers: responseHeaders(message),
        });
        settled = true;
        resolve(response);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error('benchmark_response_invalid'));
        message.destroy();
      }
    });
    const abort = () => {
      rejectOnce(new Error('benchmark_request_aborted'));
      request.destroy(new Error('benchmark_request_aborted'));
    };
    request.once('error', error => {
      options.signal?.removeEventListener('abort', abort);
      rejectOnce(error);
    });
    request.once('close', () => {
      if (!responseReceived) rejectOnce(new Error('benchmark_request_closed_before_response'));
    });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, {once: true});
    try {
      if (options.writeBody) options.writeBody(request);
      else request.end();
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error('benchmark_request_body_failed'));
      request.destroy();
    }
  });
}

async function directFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  if (init.redirect && init.redirect !== 'error') throw new Error('benchmark_redirect_policy_invalid');
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = init.body;
  if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new Error('benchmark_direct_http_body_invalid');
  }
  const buffer = body === undefined || body === null
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(body as string | Uint8Array);
  if (buffer) headers['content-length'] = String(buffer.length);
  return directHttpResponse(rawUrl, {
    method: init.method ?? 'GET',
    headers,
    signal: init.signal ?? undefined,
    ...(buffer ? {writeBody: request => request.end(buffer)} : {}),
  });
}

async function directUploadTrace(
  rawUrl: string,
  tracePath: string,
  signal: AbortSignal,
): Promise<Response> {
  const boundary = `smartperfetto-${randomBytes(16).toString('hex')}`;
  const filename = path.basename(tracePath).replace(/[^A-Za-z0-9._-]/g, '_');
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const size = (await fsp.stat(tracePath)).size;
  return directHttpResponse(rawUrl, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(prefix.length + size + suffix.length),
    },
    signal,
    writeBody: request => {
      request.write(prefix);
      const source = fs.createReadStream(tracePath);
      let stopped = false;
      let sourceEnded = false;
      const detach = () => {
        signal.removeEventListener('abort', onAbort);
        request.removeListener('error', onRequestFailure);
        request.removeListener('close', onRequestClose);
        request.removeListener('response', onEarlyResponse);
      };
      const stopSource = (error: Error) => {
        if (stopped) return;
        stopped = true;
        detach();
        if (!sourceEnded && !source.destroyed) source.destroy(error);
      };
      const onAbort = () => stopSource(new Error('benchmark_request_aborted'));
      const onRequestFailure = () => stopSource(new Error('benchmark_upload_request_failed'));
      const onRequestClose = () => stopSource(new Error('benchmark_upload_request_closed'));
      const onEarlyResponse = () => stopSource(new Error('benchmark_upload_early_response'));
      signal.addEventListener('abort', onAbort, {once: true});
      request.once('error', onRequestFailure);
      request.once('close', onRequestClose);
      request.once('response', onEarlyResponse);
      source.once('error', error => {
        if (stopped) return;
        stopSource(error);
        request.destroy(error);
      });
      source.once('end', () => {
        sourceEnded = true;
        stopped = true;
        detach();
        request.end(suffix);
      });
      source.pipe(request, {end: false});
    },
  });
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertNoSymlinkComponents(base: string, target: string): void {
  let current = base;
  const relative = path.relative(base, target);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('benchmark_output_dir_symlink_forbidden');
  }
}

function validateFreshOutputDirectory(raw: string, backendRoot: string): string {
  const allowedRoot = path.resolve(backendRoot, 'test-output', 'runtime-concurrency');
  if (!fs.existsSync(backendRoot) || !fs.lstatSync(backendRoot).isDirectory()) {
    throw new Error('benchmark_backend_root_invalid');
  }
  if (fs.lstatSync(backendRoot).isSymbolicLink()) throw new Error('benchmark_output_dir_symlink_forbidden');
  for (const current of [path.join(backendRoot, 'test-output'), allowedRoot]) {
    if (!fs.existsSync(current)) continue;
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error('benchmark_output_dir_symlink_forbidden');
    if (!stats.isDirectory()) throw new Error('benchmark_output_root_invalid');
  }
  const outputDir = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(backendRoot, raw);
  if (!isWithin(allowedRoot, outputDir)) throw new Error('benchmark_output_dir_outside_root');
  assertNoSymlinkComponents(allowedRoot, outputDir);
  if (fs.existsSync(outputDir)) throw new Error('benchmark_output_dir_not_fresh');
  return outputDir;
}

export interface BenchmarkOutputDirectoryIdentity {
  realPath: string;
  dev: number;
  ino: number;
}

async function assertOutputDirectoryIdentity(
  directory: string,
  identity: BenchmarkOutputDirectoryIdentity,
): Promise<void> {
  const stats = await fsp.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('benchmark_output_dir_identity_changed');
  const realPath = await fsp.realpath(directory);
  if (realPath !== identity.realPath || stats.dev !== identity.dev || stats.ino !== identity.ino) {
    throw new Error('benchmark_output_dir_identity_changed');
  }
}

export async function prepareBenchmarkOutputDirectory(
  options: AgentLatencyBenchmarkOptions,
): Promise<BenchmarkOutputDirectoryIdentity> {
  const resolved = validateFreshOutputDirectory(options.outputDir, options.backendRoot);
  if (resolved !== options.outputDir) throw new Error('benchmark_output_dir_revalidation_mismatch');
  let current = options.backendRoot;
  for (const component of ['test-output', 'runtime-concurrency']) {
    current = path.join(current, component);
    try {
      await fsp.mkdir(current, {mode: 0o700});
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }
    const stats = await fsp.lstat(current);
    if (stats.isSymbolicLink()) throw new Error('benchmark_output_dir_symlink_forbidden');
    if (!stats.isDirectory()) throw new Error('benchmark_output_root_invalid');
  }
  await fsp.mkdir(options.outputDir, {recursive: false, mode: 0o700});
  const allowedReal = await fsp.realpath(path.join(options.backendRoot, 'test-output', 'runtime-concurrency'));
  const outputReal = await fsp.realpath(options.outputDir);
  if (!isWithin(allowedReal, outputReal)) throw new Error('benchmark_output_dir_outside_root');
  const stats = await fsp.lstat(options.outputDir);
  return {realPath: outputReal, dev: stats.dev, ino: stats.ino};
}

export function parseExternalLifecycleReceipt(
  value: unknown,
  expected: {
    baseUrl: string;
    candidateUrl: string;
    runtime: AgentRuntimeKind;
    candidateId: BenchmarkCandidate;
    candidateConfigFingerprint: string;
    outputRunNonce?: string;
    nowMs?: number;
  },
): BenchmarkExternalLifecycleReceiptV1 {
  const record = asRecord(value, 'benchmark_lifecycle_receipt_invalid');
  assertKnownFields(record, [
    'schemaVersion', 'generatedAtMs', 'baseUrl', 'candidateUrl',
    'runtime', 'candidateId', 'candidateConfigFingerprint', 'outputRunNonce',
    'baseServerIdentityHash', 'candidateServerIdentityHash',
    'baseConfigHash', 'candidateConfigHash', 'baseSourceHash', 'candidateSourceHash',
    'baseDataRootHash', 'candidateDataRootHash', 'freshDataRoots', 'freshSessions',
    'cacheResetBetweenPairs', 'coldWarmProtocol', 'pairCount', 'pairResetReceipts',
  ], 'benchmark_lifecycle_receipt_unknown_field');
  if (record.schemaVersion !== 1) throw new Error('benchmark_lifecycle_receipt_version_invalid');
  const generatedAtMs = finiteNonnegative(record.generatedAtMs, 'benchmark_lifecycle_receipt_generated_at_invalid');
  const nowMs = expected.nowMs ?? Date.now();
  if (generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > 10 * 60_000) {
    throw new Error('benchmark_lifecycle_receipt_stale');
  }
  const baseUrl = validateTargetUrl(boundedString(record.baseUrl, 'benchmark_lifecycle_receipt_base_url_invalid'));
  const candidateUrl = validateTargetUrl(boundedString(record.candidateUrl, 'benchmark_lifecycle_receipt_candidate_url_invalid'));
  if (baseUrl !== expected.baseUrl || candidateUrl !== expected.candidateUrl) throw new Error('benchmark_lifecycle_receipt_target_mismatch');
  if (record.runtime !== expected.runtime) throw new Error('benchmark_lifecycle_receipt_runtime_mismatch');
  const candidateId = parseCandidate(record.candidateId);
  if (candidateId !== expected.candidateId) throw new Error('benchmark_lifecycle_receipt_candidate_mismatch');
  const candidateConfigFingerprint = strictHash(record.candidateConfigFingerprint, 'benchmark_lifecycle_receipt_candidate_config_invalid');
  if (candidateConfigFingerprint !== expected.candidateConfigFingerprint) throw new Error('benchmark_lifecycle_receipt_candidate_config_mismatch');
  const outputRunNonce = strictHash(record.outputRunNonce, 'benchmark_lifecycle_receipt_output_nonce_invalid');
  if (expected.outputRunNonce && outputRunNonce !== expected.outputRunNonce) throw new Error('benchmark_lifecycle_receipt_output_nonce_mismatch');
  const baseServerIdentityHash = strictHash(record.baseServerIdentityHash, 'benchmark_lifecycle_receipt_server_hash_invalid');
  const candidateServerIdentityHash = strictHash(record.candidateServerIdentityHash, 'benchmark_lifecycle_receipt_server_hash_invalid');
  const baseConfigHash = strictHash(record.baseConfigHash, 'benchmark_lifecycle_receipt_config_hash_invalid');
  const candidateConfigHash = strictHash(record.candidateConfigHash, 'benchmark_lifecycle_receipt_config_hash_invalid');
  const baseSourceHash = strictHash(record.baseSourceHash, 'benchmark_lifecycle_receipt_source_hash_invalid');
  const candidateSourceHash = strictHash(record.candidateSourceHash, 'benchmark_lifecycle_receipt_source_hash_invalid');
  const baseDataRootHash = strictHash(record.baseDataRootHash, 'benchmark_lifecycle_receipt_data_root_hash_invalid');
  const candidateDataRootHash = strictHash(record.candidateDataRootHash, 'benchmark_lifecycle_receipt_data_root_hash_invalid');
  if (baseServerIdentityHash === candidateServerIdentityHash) throw new Error('benchmark_lifecycle_receipt_server_identity_not_distinct');
  if (baseDataRootHash === candidateDataRootHash) throw new Error('benchmark_lifecycle_receipt_data_roots_not_distinct');
  if (record.freshDataRoots !== true || record.freshSessions !== true || record.cacheResetBetweenPairs !== true) {
    throw new Error('benchmark_lifecycle_receipt_freshness_invalid');
  }
  if (record.coldWarmProtocol !== 'one_cold_warmup_then_three_warm_pairs') {
    throw new Error('benchmark_lifecycle_receipt_protocol_invalid');
  }
  const pairCount = positiveInteger(record.pairCount, 'benchmark_lifecycle_receipt_pair_count_invalid');
  const expectedPairs = 3 * (REAL_MEASURED_REPETITIONS + 1);
  if (pairCount !== expectedPairs) throw new Error('benchmark_lifecycle_receipt_pair_count_mismatch');
  if (!Array.isArray(record.pairResetReceipts)) throw new Error('benchmark_lifecycle_receipt_pair_resets_invalid');
  const pairResetReceipts = record.pairResetReceipts.map(parsePairResetReceipt);
  if (pairResetReceipts.some(receipt => receipt.candidateId !== candidateId || receipt.runtime !== expected.runtime)) {
    throw new Error('benchmark_lifecycle_receipt_pair_reset_scope_mismatch');
  }
  if (pairResetReceipts.some(receipt => !receipt.verified)) {
    throw new Error('benchmark_lifecycle_receipt_pair_reset_unverified');
  }
  const expectedResetKeys = (['startup-full', 'scrolling-full', 'identity-fast'] as const).flatMap(scenario =>
    Array.from({length: REAL_MEASURED_REPETITIONS + 1}, (_, repetition) => [
      candidateId,
      expected.runtime,
      scenario,
      repetition,
      repetition === 0 ? 'cold' : 'warm',
    ].join('|')));
  const actualResetKeys = pairResetReceipts.map(receipt => [
    receipt.candidateId, receipt.runtime, receipt.scenario, receipt.repetition, receipt.cacheState,
  ].join('|'));
  assertUniqueKeys(actualResetKeys, 'benchmark_lifecycle_receipt_duplicate_pair_reset');
  assertUniqueKeys(pairResetReceipts.map(receipt => receipt.resetReceiptHash), 'benchmark_lifecycle_receipt_duplicate_reset_hash');
  if (!arraysEqual(sorted(expectedResetKeys), sorted(actualResetKeys))) {
    throw new Error('benchmark_lifecycle_receipt_pair_reset_coverage_mismatch');
  }
  return {
    schemaVersion: 1,
    generatedAtMs,
    baseUrl,
    candidateUrl,
    runtime: expected.runtime,
    candidateId,
    candidateConfigFingerprint,
    outputRunNonce,
    baseServerIdentityHash,
    candidateServerIdentityHash,
    baseConfigHash,
    candidateConfigHash,
    baseSourceHash,
    candidateSourceHash,
    baseDataRootHash,
    candidateDataRootHash,
    freshDataRoots: true,
    freshSessions: true,
    cacheResetBetweenPairs: true,
    coldWarmProtocol: 'one_cold_warmup_then_three_warm_pairs',
    pairCount,
    pairResetReceipts,
  };
}

function readLifecycleReceiptFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error('benchmark_lifecycle_receipt_file_invalid');
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

export function parseAgentLatencyArgs(argv: string[], context: ParseArgsContext = {}): AgentLatencyBenchmarkOptions {
  const backendRoot = path.resolve(context.backendRoot ?? path.resolve(__dirname, '../..'));
  let baseUrl: string | undefined;
  let candidateUrl: string | undefined;
  let runtime: AgentRuntimeKind | undefined;
  let outputDir: string | undefined;
  let lifecycleReceiptPath: string | undefined;
  let candidate: BenchmarkCandidate | undefined;
  let candidateConfigFingerprint: string | undefined;
  let outputRunNonce: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (![
      '--base-url', '--candidate-url', '--runtime', '--output-dir', '--lifecycle-receipt',
      '--candidate', '--candidate-config-fingerprint', '--output-run-nonce',
    ].includes(arg)) {
      throw new Error(`benchmark_argument_unknown:${arg}`);
    }
    if (!value) throw new Error(`benchmark_argument_value_missing:${arg}`);
    if (arg === '--base-url') baseUrl = validateTargetUrl(value);
    if (arg === '--candidate-url') candidateUrl = validateTargetUrl(value);
    if (arg === '--runtime') {
      if (!isProductionAgentRuntimeKind(value)) throw new Error('benchmark_runtime_invalid');
      runtime = value;
    }
    if (arg === '--output-dir') outputDir = validateFreshOutputDirectory(value, backendRoot);
    if (arg === '--lifecycle-receipt') lifecycleReceiptPath = path.resolve(value);
    if (arg === '--candidate') candidate = parseCandidate(value);
    if (arg === '--candidate-config-fingerprint') {
      candidateConfigFingerprint = strictHash(value, 'benchmark_candidate_config_fingerprint_invalid');
    }
    if (arg === '--output-run-nonce') outputRunNonce = strictHash(value, 'benchmark_output_run_nonce_invalid');
    index++;
  }
  if (!baseUrl || !candidateUrl || !runtime || !outputDir) throw new Error('benchmark_required_arguments_missing');
  if (baseUrl === candidateUrl) throw new Error('benchmark_targets_must_differ');
  if ((candidate && !candidateConfigFingerprint) || (!candidate && candidateConfigFingerprint)) {
    throw new Error('benchmark_candidate_scope_incomplete');
  }
  if (candidate && !CANDIDATE_RUNTIME_MATRIX[candidate].includes(runtime)) throw new Error('benchmark_candidate_runtime_invalid');
  if (lifecycleReceiptPath && (!candidate || !candidateConfigFingerprint)) {
    throw new Error('benchmark_lifecycle_receipt_requires_candidate_scope');
  }
  const lifecycleReceipt = lifecycleReceiptPath
    ? parseExternalLifecycleReceipt(readLifecycleReceiptFile(lifecycleReceiptPath), {
      baseUrl,
      candidateUrl,
      runtime,
      candidateId: candidate!,
      candidateConfigFingerprint: candidateConfigFingerprint!,
      outputRunNonce,
      nowMs: context.nowMs,
    })
    : undefined;
  return {
    baseUrl,
    candidateUrl,
    runtime,
    outputDir,
    backendRoot,
    ...(candidate ? {candidate} : {}),
    ...(candidateConfigFingerprint ? {candidateConfigFingerprint} : {}),
    ...(outputRunNonce || lifecycleReceipt?.outputRunNonce
      ? {outputRunNonce: outputRunNonce ?? lifecycleReceipt!.outputRunNonce}
      : {}),
    ...(lifecycleReceipt ? {lifecycleReceipt} : {}),
  };
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('benchmark_response_too_large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('benchmark_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBoundedJsonResponse(
  response: Response,
  options: BoundedJsonOptions = {},
): Promise<Record<string, unknown>> {
  const bytes = await readBoundedResponseBytes(response, options.maxBytes ?? MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`benchmark_http_error:${response.status}`);
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)), 'benchmark_json_object_required');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('benchmark_')) throw error;
    throw new Error('benchmark_json_invalid');
  }
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, {once: true});
  const timeout = setTimeout(() => controller.abort(new Error('benchmark_request_timeout')), timeoutMs);
  try {
    const response = await fetchImpl(url, {...init, redirect: 'error', signal: controller.signal});
    return await readBoundedJsonResponse(response, {maxBytes});
  } catch (error) {
    if (parentSignal?.aborted) throw new Error('benchmark_request_aborted');
    if (controller.signal.aborted) throw new Error('benchmark_request_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

interface CollectedSseReceipt {
  firstOutputMs?: number;
  terminalMs: number;
  terminalRunId: string;
  terminalOutcome: RuntimeBenchmarkCell['terminalOutcome'];
  payload: Record<string, unknown>;
}

class BenchmarkCellExecutionError extends Error {
  constructor(
    message: string,
    readonly cleanup: RuntimeBenchmarkCleanupReceipt,
  ) {
    super(message);
    this.name = 'BenchmarkCellExecutionError';
  }
}

async function collectBenchmarkSse(
  response: Response,
  input: {acceptedAtClockMs: number; expectedRunId: string; now: () => number; maxBytes: number},
): Promise<CollectedSseReceipt> {
  if (!response.ok || !response.body) throw new Error(`benchmark_sse_http_error:${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) throw new Error('benchmark_sse_content_type_invalid');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = '';
  let firstOutputMs: number | undefined;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (!buffer.trim()) break;
        buffer += '\n\n';
      } else {
        total += value.byteLength;
        if (total > input.maxBytes) throw new Error('benchmark_sse_too_large');
        buffer += decoder.decode(value, {stream: true});
      }
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const block = buffer.slice(0, separator).trim();
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        if (!block || block.startsWith(':')) continue;
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
          if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
        }
        if (firstOutputMs === undefined && ['thought', 'answer_token', 'conclusion'].includes(event)) {
          firstOutputMs = Math.max(0, input.now() - input.acceptedAtClockMs);
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = asRecord(JSON.parse(data.join('\n')), 'benchmark_sse_terminal_payload_invalid');
        } catch {
          throw new Error('benchmark_sse_terminal_payload_invalid');
        }
        const terminalEvents = ['error', 'end', 'cancelled', 'canceled', 'analysis_cancelled', 'quota_exceeded', 'analysis_completed'];
        let correlatedRunId: string | undefined;
        if (terminalEvents.includes(event)) {
          correlatedRunId = safeIdentifier(parsed.runId, 'benchmark_sse_terminal_run_id_missing');
          if (correlatedRunId !== input.expectedRunId) throw new Error('benchmark_sse_terminal_run_id_mismatch');
        }
        if (event === 'error') throw new Error('benchmark_sse_error_event');
        if (event === 'cancelled' || event === 'canceled' || event === 'analysis_cancelled') {
          throw new Error('benchmark_sse_analysis_cancelled');
        }
        if (event === 'quota_exceeded') throw new Error('benchmark_sse_quota_exceeded_event');
        if (event === 'end') throw new Error('benchmark_sse_end_without_analysis_completed');
        if (event !== 'analysis_completed') continue;
        const payload = optionalRecord(parsed.data) ?? parsed;
        const terminalRunId = correlatedRunId!;
        const terminalOutcome: RuntimeBenchmarkCell['terminalOutcome'] = payload.partial === true
          ? 'partial'
          : payload.terminalRunStatus === 'quota_exceeded'
            ? 'quota_exceeded'
            : payload.terminalRunStatus === 'completed'
              ? 'completed'
              : 'error';
        return {
          firstOutputMs,
          terminalMs: Math.max(1, input.now() - input.acceptedAtClockMs),
          terminalRunId,
          terminalOutcome,
          payload,
        };
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  throw new Error('benchmark_sse_terminal_missing');
}

async function openTraceBlob(tracePath: string): Promise<Blob> {
  const openAsBlob = (fs as typeof fs & {openAsBlob?: (filePath: string) => Promise<Blob>}).openAsBlob;
  if (!openAsBlob) throw new Error('benchmark_streaming_file_blob_unavailable');
  return openAsBlob(tracePath);
}

function benchmarkReceiptFromPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return optionalRecord(payload.runtimeBenchmarkReceipt)
    ?? optionalRecord(payload.benchmarkReceipt);
}

function buildCellFromTerminal(input: {
  requestedRuntime: AgentRuntimeKind;
  candidate: BenchmarkCandidate;
  candidateConfigFingerprint: string;
  scenario: RuntimeBenchmarkScenario;
  repetition: number;
  warmup: boolean;
  cacheState: 'cold' | 'warm';
  uploadedTraceId: string;
  analyzeSessionId: string;
  analyzeRunId: string;
  cleanup: RuntimeBenchmarkCleanupReceipt;
  collected: CollectedSseReceipt;
}): RuntimeBenchmarkCell {
  const payload = input.collected.payload;
  const receipt = asRecord(payload.analysisReceipt, 'benchmark_analysis_receipt_missing');
  if (receipt.runtime !== input.requestedRuntime) throw new Error('benchmark_target_runtime_mismatch');
  if (receipt.providerId !== null && typeof receipt.providerId !== 'string') throw new Error('benchmark_target_provider_id_missing');
  const conclusionContract = asRecord(payload.conclusionContract, 'benchmark_conclusion_contract_missing');
  const claimVerificationResult = optionalRecord(payload.claimVerificationResult);
  const identityResolutions = Array.isArray(payload.identityResolutions)
    ? payload.identityResolutions.map(value => asRecord(value, 'benchmark_identity_resolution_invalid'))
    : [];
  const sourceClaimBindings = Array.isArray(conclusionContract.sourceClaimBindings)
    ? conclusionContract.sourceClaimBindings.map(value => asRecord(value, 'benchmark_source_claim_binding_invalid'))
    : [];
  const benchmarkReceipt = benchmarkReceiptFromPayload(payload);
  const performance = parsePerformance(benchmarkReceipt?.performance ?? receipt.performance);
  const providerUsage = parseProviderUsage(benchmarkReceipt?.providerUsage ?? receipt.providerUsage);
  const model = optionalBoundedString(benchmarkReceipt?.model ?? receipt.model, 'benchmark_cell_model_invalid');
  const providerSnapshotHash = optionalBoundedString(
    benchmarkReceipt?.providerSnapshotHash ?? receipt.providerSnapshotHash,
    'benchmark_cell_provider_snapshot_hash_invalid',
  );
  const queryHash = hashCanonical(input.scenario.query);
  const observedQueryHash = optionalBoundedString(
    benchmarkReceipt?.queryHash ?? receipt.queryHash,
    'benchmark_observed_query_hash_invalid',
  );
  const observedCandidateId = benchmarkReceipt?.candidateId === undefined
    ? undefined
    : parseCandidate(benchmarkReceipt.candidateId);
  const observedCandidateConfigFingerprint = optionalBoundedString(
    benchmarkReceipt?.candidateConfigFingerprint,
    'benchmark_observed_candidate_config_fingerprint_invalid',
  );
  const observedTargetConfigHash = optionalBoundedString(
    benchmarkReceipt?.targetConfigHash,
    'benchmark_observed_target_config_hash_invalid',
  );
  const observedSourceHash = optionalBoundedString(
    benchmarkReceipt?.sourceHash,
    'benchmark_observed_source_hash_invalid',
  );
  return parseRuntimeBenchmarkCell({
    candidate: input.candidate,
    executionProvenance: 'real_provider',
    candidateConfigFingerprint: input.candidateConfigFingerprint,
    runtime: input.requestedRuntime,
    providerId: receipt.providerId,
    ...(model ? {model} : {}),
    ...(providerSnapshotHash ? {providerSnapshotHash} : {}),
    trace: input.scenario.traceId,
    queryHash,
    mode: input.scenario.mode,
    scenario: input.scenario.id,
    repetition: input.repetition,
    warmup: input.warmup,
    cacheState: input.cacheState,
    acceptedAtMs: 0,
    ...(input.collected.firstOutputMs !== undefined ? {firstOutputMs: input.collected.firstOutputMs} : {}),
    terminalMs: input.collected.terminalMs,
    ...(performance ? {performance} : {}),
    ...(providerUsage ? {providerUsage} : {}),
    targetBinding: {
      uploadedTraceId: input.uploadedTraceId,
      receiptTraceId: receipt.traceId,
      analyzeSessionId: input.analyzeSessionId,
      receiptSessionId: receipt.sessionId,
      analyzeRunId: input.analyzeRunId,
      terminalRunId: input.collected.terminalRunId,
      receiptRunId: receipt.runId,
      requestedQueryHash: queryHash,
      ...(observedQueryHash ? {observedQueryHash} : {}),
      requestedMode: input.scenario.mode,
      ...(receipt.mode === 'fast' || receipt.mode === 'full' || receipt.mode === 'auto'
        ? {observedMode: receipt.mode}
        : {}),
      ...(receipt.resolvedMode === 'quick' || receipt.resolvedMode === 'full'
        ? {resolvedMode: receipt.resolvedMode}
        : {}),
      requestedCandidateId: input.candidate,
      requestedCandidateConfigFingerprint: input.candidateConfigFingerprint,
      ...(observedCandidateId ? {observedCandidateId} : {}),
      ...(observedCandidateConfigFingerprint ? {observedCandidateConfigFingerprint} : {}),
      ...(observedTargetConfigHash ? {observedTargetConfigHash} : {}),
      ...(observedSourceHash ? {observedSourceHash} : {}),
    },
    cleanup: input.cleanup,
    terminalOutcome: input.collected.terminalOutcome,
    quality: buildRuntimeBenchmarkQuality({
      conclusionContract,
      analysisReceipt: receipt,
      claimVerificationResult,
      identityResolutions,
      sourceClaimBindings,
    }),
  });
}

function deadlineController(parent: AbortSignal | undefined, timeoutMs: number): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, {once: true});
  const timeout = setTimeout(() => controller.abort(new Error('benchmark_request_timeout')), timeoutMs);
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function uploadTraceJson(input: {
  baseUrl: string;
  tracePath: string;
  fetchImpl: typeof fetch;
  useDirectTransport: boolean;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}): Promise<Record<string, unknown>> {
  const deadline = deadlineController(input.signal, input.timeoutMs);
  try {
    const response = input.useDirectTransport
      ? await directUploadTrace(
        `${input.baseUrl}/api/traces/upload`,
        input.tracePath,
        deadline.controller.signal,
      )
      : await (async () => {
        const form = new FormData();
        form.append('file', await openTraceBlob(input.tracePath), path.basename(input.tracePath));
        return input.fetchImpl(`${input.baseUrl}/api/traces/upload`, {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: deadline.controller.signal,
        });
      })();
    return await readBoundedJsonResponse(response, {maxBytes: input.maxBytes});
  } catch (error) {
    if (input.signal?.aborted) throw new Error('benchmark_request_aborted');
    if (deadline.controller.signal.aborted) throw new Error('benchmark_request_timeout');
    throw error;
  } finally {
    deadline.dispose();
  }
}

async function cleanupTargetResource(input: {
  fetchImpl: typeof fetch;
  url: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RuntimeBenchmarkCleanupItemReceipt> {
  let status: number | undefined;
  const deadline = deadlineController(input.signal, input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.url, {
      method: 'DELETE',
      redirect: 'error',
      signal: deadline.controller.signal,
    });
    status = response.status;
    const payload = await readBoundedJsonResponse(response, {maxBytes: input.maxBytes});
    const success = payload.success === true;
    return {
      attempted: true,
      success,
      status,
      ...(!success ? {error: 'cleanup_receipt_unsuccessful'} : {}),
    };
  } catch (error) {
    const code = input.signal?.aborted
      ? 'request_aborted'
      : deadline.controller.signal.aborted
        ? 'request_timeout'
        : error instanceof Error && /^benchmark_[a-z0-9_:.-]+$/.test(error.message)
          ? error.message.replace(/^benchmark_/, '')
          : 'cleanup_request_failed';
    return {
      attempted: true,
      success: false,
      ...(status !== undefined ? {status} : {}),
      error: code,
    };
  } finally {
    deadline.dispose();
  }
}

export async function runTargetBenchmarkCell(input: TargetBenchmarkCellInput): Promise<RuntimeBenchmarkCell> {
  if (!CANDIDATE_RUNTIME_MATRIX[input.candidate].includes(input.runtime)) throw new Error('benchmark_candidate_runtime_invalid');
  const useDirectTransport = input.fetchImpl === undefined;
  const fetchImpl = input.fetchImpl ?? directFetch;
  const now = input.now ?? (() => nodePerformance.now());
  const maxJsonBytes = input.maxJsonBytes ?? MAX_RESPONSE_BYTES;
  const maxSseBytes = input.maxSseBytes ?? MAX_SSE_BYTES;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamTimeoutMs = input.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
  const baseUrl = validateTargetUrl(input.baseUrl);
  if (!fs.existsSync(input.scenario.tracePath)) throw new Error('benchmark_trace_missing');
  const upload = await uploadTraceJson({
    baseUrl,
    tracePath: input.scenario.tracePath,
    fetchImpl,
    useDirectTransport,
    signal: input.signal,
    timeoutMs: requestTimeoutMs,
    maxBytes: maxJsonBytes,
  });
  if (upload.success !== true) throw new Error('benchmark_trace_upload_unsuccessful');
  const trace = asRecord(upload.trace, 'benchmark_trace_upload_receipt_missing');
  const traceId = safeIdentifier(trace.id, 'benchmark_trace_upload_id_missing');
  if (trace.status !== 'ready' || (trace.processorStatus !== undefined && trace.processorStatus !== 'ready')) {
    const cleanup: RuntimeBenchmarkCleanupReceipt = {
      session: {attempted: false, success: false, error: 'session_not_created'},
      trace: await cleanupTargetResource({
        fetchImpl,
        url: `${baseUrl}/api/traces/${encodeURIComponent(traceId)}`,
        timeoutMs: requestTimeoutMs,
        maxBytes: maxJsonBytes,
      }),
    };
    throw new BenchmarkCellExecutionError('benchmark_trace_upload_not_ready', cleanup);
  }
  let sessionId: string | undefined;
  let runId: string | undefined;
  let collected: CollectedSseReceipt | undefined;
  let primaryError: unknown;
  try {
    const analyze = await requestJson(
      fetchImpl,
      `${baseUrl}/api/agent/v1/analyze`,
      {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          traceId,
          query: input.scenario.query,
          options: {analysisMode: input.scenario.mode},
        }),
        signal: input.signal,
      },
      requestTimeoutMs,
      maxJsonBytes,
    );
    if (analyze.success !== true) throw new Error('benchmark_analyze_unsuccessful');
    sessionId = safeIdentifier(analyze.sessionId, 'benchmark_analyze_session_id_missing');
    runId = safeIdentifier(analyze.runId, 'benchmark_analyze_run_id_missing');
    const acceptedAtClockMs = now();
    const deadline = deadlineController(input.signal, streamTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/api/agent/v1/runs/${encodeURIComponent(runId)}/stream`, {
        headers: {accept: 'text/event-stream'},
        redirect: 'error',
        signal: deadline.controller.signal,
      });
      collected = await collectBenchmarkSse(response, {acceptedAtClockMs, expectedRunId: runId, now, maxBytes: maxSseBytes});
    } catch (error) {
      if (input.signal?.aborted) throw new Error('benchmark_request_aborted');
      if (deadline.controller.signal.aborted) throw new Error('benchmark_stream_timeout');
      throw error;
    } finally {
      deadline.dispose();
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // Cleanup receipts are collected below after both identifiers are frozen.
  }
  const cleanup: RuntimeBenchmarkCleanupReceipt = {
    session: sessionId
      ? await cleanupTargetResource({
        fetchImpl,
        url: `${baseUrl}/api/agent/v1/${encodeURIComponent(sessionId)}`,
        timeoutMs: requestTimeoutMs,
        maxBytes: maxJsonBytes,
      })
      : {attempted: false, success: false, error: 'session_id_unavailable'},
    trace: await cleanupTargetResource({
      fetchImpl,
      url: `${baseUrl}/api/traces/${encodeURIComponent(traceId)}`,
      timeoutMs: requestTimeoutMs,
      maxBytes: maxJsonBytes,
    }),
  };
  if (primaryError) {
    const code = primaryError instanceof Error ? primaryError.message : 'benchmark_target_cell_failed';
    throw new BenchmarkCellExecutionError(code, cleanup);
  }
  if (!sessionId || !runId || !collected) throw new BenchmarkCellExecutionError('benchmark_terminal_state_missing', cleanup);
  try {
    return buildCellFromTerminal({
      requestedRuntime: input.runtime,
      candidate: input.candidate,
      candidateConfigFingerprint: input.candidateConfigFingerprint,
      scenario: input.scenario,
      repetition: input.repetition,
      warmup: input.warmup,
      cacheState: input.cacheState,
      uploadedTraceId: traceId,
      analyzeSessionId: sessionId,
      analyzeRunId: runId,
      cleanup,
      collected,
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'benchmark_target_cell_failed';
    throw new BenchmarkCellExecutionError(code, cleanup);
  }
}

function syntheticScorerContract(): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'initial_report',
    conclusions: [
      {rank: 1, statement: 'synthetic scorer prose'},
      {rank: 2, statement: 'synthetic scorer secondary prose'},
    ],
    clusters: [],
    evidenceChain: [
      {conclusionId: 'root-primary', text: 'ignored'},
      {conclusionId: 'root-secondary', text: 'ignored'},
    ],
    claims: [
      {id: 'claim-primary', conclusionId: 'root-primary', text: 'ignored', kind: 'causal', references: [{evidenceRefId: 'data:primary', sourceRef: 'sql:primary'}]},
      {id: 'claim-secondary', conclusionId: 'root-secondary', text: 'ignored', kind: 'causal', references: [{evidenceRefId: 'data:secondary', sourceRef: 'sql:secondary'}]},
    ],
    uncertainties: [],
    nextSteps: [],
  };
}

function syntheticScorerQuality(): RuntimeBenchmarkQuality {
  return buildRuntimeBenchmarkQuality({
    conclusionContract: syntheticScorerContract(),
    analysisReceipt: {
      claimAudit: {verifiedClaims: 2, unsupportedClaims: 0},
      qualityGates: {
        finalReportContract: 'passed',
        claimVerification: 'passed',
        identityResolution: 'passed',
      },
    },
    claimVerificationResult: {checkedClaimCount: 2, unsupportedClaimCount: 0},
    identityResolutions: [{identityRefId: 'identity:app', status: 'verified', target: {traceId: 'trace', role: 'app_main'}}],
    sourceClaimBindings: [],
  });
}

function syntheticScorerPerformance(scale: number, firstOutputMs: number): RuntimePerformanceReceiptV1 {
  const specs: Array<[RuntimePerformancePhaseReceiptV1['name'], number]> = [
    ['quick_evidence', 400],
    ['focus', 200],
    ['classification', 300],
    ['comparison', 200],
    ['skill_registry', 300],
    ['knowledge', 200],
    ['sdk_start', 500],
    ['provider', 1_200],
    ['verification', 300],
    ['correction', 300],
  ];
  return {
    schemaVersion: 1,
    firstOutputMs,
    phases: specs.map(([name, durationMs], index) => ({
      name,
      startOffsetMs: index * 100,
      durationMs: Math.round(durationMs * scale),
      outcome: 'ok',
    })),
    tools: [],
    sql: [],
  };
}

const SYNTHETIC_SCORER_SCENARIOS: ReadonlyArray<Omit<RuntimeBenchmarkScenario, 'tracePath'>> = [
  {id: 'startup-full', traceId: 'android-startup-heavy', query: '分析启动性能', mode: 'full'},
  {id: 'scrolling-full', traceId: 'android-scroll-customer', query: '分析滑动性能', mode: 'full'},
  {id: 'identity-fast', traceId: 'android-scroll-customer', query: '这个 trace 的应用包名和主要进程是什么？', mode: 'fast'},
];

export function buildSyntheticScorerMatrix(options: {repetitions: number}): DeterministicStubMatrixEntry[] {
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions !== MIN_DETERMINISTIC_P95_SAMPLES) {
    throw new Error('benchmark_synthetic_scorer_repetitions_must_equal_30');
  }
  const quality = syntheticScorerQuality();
  const usage: ProviderUsageReceiptV1 = {
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 100,
    reasoningTokens: 50,
    costUsd: 0.02,
  };
  const entries: DeterministicStubMatrixEntry[] = [];
  for (const candidate of Object.keys(CANDIDATE_RUNTIME_MATRIX) as BenchmarkCandidate[]) {
    for (const runtime of CANDIDATE_RUNTIME_MATRIX[candidate]) {
      for (const scenario of SYNTHETIC_SCORER_SCENARIOS) {
        for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        const jitter = (repetition % 5) * 5;
        const queryHash = hashCanonical(scenario.query);
        const candidateConfigFingerprint = hashCanonical(`synthetic:${candidate}`);
        const shared = {
          candidate,
          executionProvenance: 'synthetic_scorer' as const,
          candidateConfigFingerprint,
          runtime,
          providerId: 'synthetic-scorer',
          model: `synthetic-scorer:${runtime}`,
          providerSnapshotHash: `sha256:${createHash('sha256').update(runtime).digest('hex').slice(0, 32)}`,
          trace: scenario.traceId,
          queryHash,
          mode: scenario.mode,
          scenario: scenario.id,
          repetition,
          warmup: false,
          cacheState: 'warm' as const,
          acceptedAtMs: 0,
          providerUsage: usage,
          quality,
          cleanup: {
            session: {attempted: true, success: true, status: 200},
            trace: {attempted: true, success: true, status: 200},
          },
          terminalOutcome: 'completed' as const,
        } satisfies Omit<RuntimeBenchmarkCell, 'firstOutputMs' | 'terminalMs' | 'performance' | 'targetBinding'>;
        const targetBinding = (role: 'base' | 'candidate'): RuntimeBenchmarkTargetBinding => ({
          uploadedTraceId: `${role}-trace-${repetition}`,
          receiptTraceId: `${role}-trace-${repetition}`,
          analyzeSessionId: `${role}-session-${repetition}`,
          receiptSessionId: `${role}-session-${repetition}`,
          analyzeRunId: `${role}-run-${repetition}`,
          terminalRunId: `${role}-run-${repetition}`,
          receiptRunId: `${role}-run-${repetition}`,
          requestedQueryHash: queryHash,
          observedQueryHash: queryHash,
          requestedMode: scenario.mode,
          observedMode: scenario.mode,
          resolvedMode: scenario.mode === 'fast' ? 'quick' : 'full',
          requestedCandidateId: candidate,
          requestedCandidateConfigFingerprint: candidateConfigFingerprint,
          observedCandidateId: candidate,
          observedCandidateConfigFingerprint: candidateConfigFingerprint,
          observedTargetConfigHash: hashCanonical(`${role}:target-config`),
          observedSourceHash: hashCanonical(`${role}:source`),
        });
        entries.push({
          role: 'base',
          cell: {
            ...shared,
            firstOutputMs: 1_000 + jitter,
            terminalMs: 4_000 + jitter,
            performance: syntheticScorerPerformance(1, 1_000 + jitter),
            targetBinding: targetBinding('base'),
          },
        });
        entries.push({
          role: 'candidate',
          cell: {
            ...shared,
            firstOutputMs: 820 + jitter,
            terminalMs: 3_200 + jitter,
            performance: syntheticScorerPerformance(0.65, 820 + jitter),
            targetBinding: targetBinding('candidate'),
          },
        });
        }
      }
    }
  }
  return entries;
}

function defaultCommandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  return pathValue.split(path.delimiter).some(directory => extensions.some(extension => {
    const candidate = path.join(directory, `${command}${extension}`);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

function concreteEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key]?.trim();
  return Boolean(value && !/^(?:changeme|replace[_ -]?me|example|placeholder)$/i.test(value));
}

function availability(
  configured: boolean,
  configuredReason: string,
  unavailableReason: string,
  signals: string[],
): RuntimeAvailabilityEntry {
  return {
    status: configured ? 'CONFIGURED_NOT_VERIFIED' : 'NOT_AVAILABLE',
    reason: configured ? configuredReason : unavailableReason,
    signals,
  };
}

export function inspectLocalRuntimeAvailability(
  options: AvailabilityInspectionOptions = {},
): LocalRuntimeAvailability {
  const env = options.env ?? process.env;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const fileExists = options.fileExists ?? fs.existsSync;
  const homeDir = options.homeDir ?? os.homedir();
  const deepseekKey = concreteEnv(env, 'DEEPSEEK_API_KEY');
  const openAiKey = concreteEnv(env, 'OPENAI_API_KEY');
  const piModel = concreteEnv(env, 'SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON');
  const openCodeModel = concreteEnv(env, 'SMARTPERFETTO_OPENCODE_MODEL_JSON');
  const claudeEnv = concreteEnv(env, 'ANTHROPIC_API_KEY')
    || concreteEnv(env, 'ANTHROPIC_AUTH_TOKEN')
    || concreteEnv(env, 'AWS_BEARER_TOKEN_BEDROCK')
    || concreteEnv(env, 'GOOGLE_APPLICATION_CREDENTIALS');
  const claudeBinary = commandExists('claude') || (concreteEnv(env, 'CLAUDE_BINARY_PATH') && fileExists(env.CLAUDE_BINARY_PATH!));
  const openCodeBinary = commandExists('opencode');
  const qoderPat = concreteEnv(env, 'QODER_PERSONAL_ACCESS_TOKEN');
  const qoderBinary = commandExists('qodercli') || (concreteEnv(env, 'QODERCLI_PATH') && fileExists(env.QODERCLI_PATH!));
  const qoderLocalAuthHints = [
    path.join(homeDir, '.qoder', 'qoder-auth.json'),
    path.join(homeDir, '.config', 'qoder', 'auth.json'),
  ].some(fileExists);
  const qoderByok = concreteEnv(env, 'QODER_BYOK_API_KEY');

  return {
    scope: 'local_harness_only',
    deepseek: availability(
      deepseekKey,
      'DeepSeek credential is configured locally; authentication and quota remain unverified until bounded real A/B.',
      'DEEPSEEK_API_KEY is not configured locally.',
      deepseekKey ? ['deepseek_api_key_present'] : [],
    ),
    openai: availability(
      openAiKey,
      'OpenAI-compatible credential is configured locally; endpoint/model acceptance remains unverified.',
      'OPENAI_API_KEY is not configured locally.',
      openAiKey ? ['openai_api_key_present'] : [],
    ),
    pi: availability(
      piModel,
      'Pi model/provider configuration is present; provider authentication remains unverified.',
      'Pi model/provider configuration is not present in the local environment.',
      piModel ? ['pi_model_config_present'] : [],
    ),
    opencode: availability(
      openCodeModel && openCodeBinary,
      'OpenCode model configuration and local binary are present; authentication remains unverified.',
      openCodeModel
        ? 'OpenCode model configuration is present but the local OpenCode binary is unavailable.'
        : 'OpenCode model configuration is not present locally.',
      [
        ...(openCodeModel ? ['opencode_model_config_present'] : []),
        ...(openCodeBinary ? ['opencode_binary_present'] : []),
      ],
    ),
    claude: availability(
      claudeEnv || claudeBinary,
      claudeEnv
        ? 'Claude provider credential is configured; authentication remains unverified.'
        : 'Claude binary is present and may use local login; non-interactive authentication remains unverified.',
      'Neither Claude provider credentials nor a local Claude binary were found.',
      [
        ...(claudeEnv ? ['claude_provider_credential_present'] : []),
        ...(claudeBinary ? ['claude_binary_present'] : []),
      ],
    ),
    qoder: qoderPat
      ? {
        status: 'CONFIGURED_NOT_VERIFIED',
        reason: 'Qoder PAT is configured; SDK/CLI acceptance remains unverified until bounded real A/B.',
        signals: ['qoder_pat_present', ...(qoderByok ? ['qoder_byok_present'] : [])],
      }
      : {
        status: 'NOT_AVAILABLE',
        reason: qoderByok
          ? 'Qoder BYOK does not prove Qoder authentication; no QODER_PERSONAL_ACCESS_TOKEN is configured and local login is not non-interactively verifiable.'
          : 'Qoder authentication is not non-interactively available; no QODER_PERSONAL_ACCESS_TOKEN is configured.',
        signals: [
          ...(qoderByok ? ['qoder_byok_present'] : []),
          ...(qoderBinary ? ['qoder_binary_present'] : []),
          ...(qoderLocalAuthHints ? ['qoder_local_auth_hint_present'] : []),
        ],
      },
  };
}

function realScenarios(options: AgentLatencyBenchmarkOptions): RuntimeBenchmarkScenario[] {
  const repoRoot = path.dirname(options.backendRoot);
  return [
    {
      id: 'startup-full',
      traceId: 'android-startup-heavy',
      tracePath: path.join(repoRoot, 'Trace', 'real', 'android-startup-heavy', 'trace.pftrace'),
      query: '分析启动性能',
      mode: 'full',
    },
    {
      id: 'scrolling-full',
      traceId: 'android-scroll-customer',
      tracePath: path.join(repoRoot, 'Trace', 'real', 'android-scroll-customer', 'trace.pftrace'),
      query: '分析滑动性能',
      mode: 'full',
    },
    {
      id: 'identity-fast',
      traceId: 'android-scroll-customer',
      tracePath: path.join(repoRoot, 'Trace', 'real', 'android-scroll-customer', 'trace.pftrace'),
      query: '这个 trace 的应用包名和主要进程是什么？',
      mode: 'fast',
    },
  ];
}

function candidatesForRuntime(runtime: AgentRuntimeKind): BenchmarkCandidate[] {
  if (runtime === 'claude-agent-sdk' || runtime === 'openai-agents-sdk') return ['task4', 'task5', 'task6'];
  if (runtime === 'pi-agent-core') return ['task4', 'task5', 'task7'];
  if (runtime === 'opencode') return ['task4', 'task5', 'task8'];
  return ['task4', 'task5', 'task9'];
}

function relativeOutputRoot(options: AgentLatencyBenchmarkOptions): string {
  return path.relative(options.backendRoot, options.outputDir).split(path.sep).join('/');
}

export async function writeBenchmarkJsonAtomic(
  filePath: string,
  value: unknown,
  directoryIdentity?: BenchmarkOutputDirectoryIdentity,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let handle: fsp.FileHandle | undefined;
  try {
    if (directoryIdentity) await assertOutputDirectoryIdentity(directory, directoryIdentity);
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJsonString(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (directoryIdentity) await assertOutputDirectoryIdentity(directory, directoryIdentity);
    await fsp.rename(temporary, filePath);
    if (directoryIdentity) await assertOutputDirectoryIdentity(directory, directoryIdentity);
    const directoryHandle = await fsp.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!directoryIdentity) {
      await fsp.unlink(temporary).catch(() => undefined);
    } else {
      await assertOutputDirectoryIdentity(directory, directoryIdentity)
        .then(() => fsp.unlink(temporary))
        .catch(() => undefined);
    }
    throw error;
  }
}

function plannedRealCallMatrix(runtime: AgentRuntimeKind, scenarios: readonly RuntimeBenchmarkScenario[]) {
  return {
    status: 'PENDING_REVIEW' as const,
    runtime,
    scenarios: scenarios.map(scenario => scenario.id),
    warmupsPerCell: 1,
    measuredPairedRepetitions: REAL_MEASURED_REPETITIONS,
    note: 'Invocation performs bounded real provider calls only after independent harness review.',
    deterministicAdapterAdmission: DETERMINISTIC_ADAPTER_ADMISSION,
  };
}

export interface RunAgentLatencyBenchmarkDependencies {
  signal?: AbortSignal;
  executeCell?: (input: TargetBenchmarkCellInput) => Promise<RuntimeBenchmarkCell>;
  randomOrder?: () => readonly ['base', 'candidate'] | readonly ['candidate', 'base'];
}

function benchmarkErrorCode(error: unknown): string {
  return error instanceof Error && /^benchmark_[a-z0-9_:.-]+$/.test(error.message)
    ? error.message
    : 'benchmark_agent_latency_failed';
}

async function writeRunFailureEvidence(input: {
  outputDir: string;
  outputIdentity: BenchmarkOutputDirectoryIdentity;
  stage: string;
  error: unknown;
  baseCells: RuntimeBenchmarkCell[];
  candidateCells: RuntimeBenchmarkCell[];
  randomizedPairOrder: BenchmarkPairOrderEntry[];
  warmupPairOrder: BenchmarkPairOrderEntry[];
}): Promise<void> {
  const cells = [...input.baseCells, ...input.candidateCells];
  await writeBenchmarkJsonAtomic(path.join(input.outputDir, 'failure.json'), {
    schemaVersion: 1,
    status: 'FAILED',
    stage: input.stage,
    errors: [benchmarkErrorCode(input.error)],
    completed: {baseCells: input.baseCells, candidateCells: input.candidateCells},
    randomizedPairOrder: input.randomizedPairOrder,
    warmupPairOrder: input.warmupPairOrder,
    cleanupReceipts: cells.map(cell => ({
      candidate: cell.candidate,
      runtime: cell.runtime,
      scenario: cell.scenario,
      repetition: cell.repetition,
      cleanup: cell.cleanup,
    })),
    ...(input.error instanceof BenchmarkCellExecutionError
      ? {failedCellCleanup: input.error.cleanup}
      : {}),
  }, input.outputIdentity);
}

export async function runAgentLatencyBenchmark(
  options: AgentLatencyBenchmarkOptions,
  dependencies: RunAgentLatencyBenchmarkDependencies = {},
): Promise<{
  base: RuntimeBenchmarkArtifactV1;
  candidate: RuntimeBenchmarkArtifactV1;
  admissions: CandidateAdmissionResult[];
  aggregates: CandidateAdmissionAggregateResult[];
  availability: LocalRuntimeAvailability;
}> {
  const outputIdentity = await prepareBenchmarkOutputDirectory(options);
  const scenarios = realScenarios(options);
  const availability = inspectLocalRuntimeAvailability();
  const plannedMatrix = plannedRealCallMatrix(options.runtime, scenarios);
  await writeBenchmarkJsonAtomic(path.join(options.outputDir, 'availability.json'), {
    schemaVersion: 1,
    availability,
    plannedRealCallMatrix: plannedMatrix,
  }, outputIdentity);
  const baseCells: RuntimeBenchmarkCell[] = [];
  const candidateCells: RuntimeBenchmarkCell[] = [];
  const randomizedPairOrder: BenchmarkPairOrderEntry[] = [];
  const warmupPairOrder: BenchmarkPairOrderEntry[] = [];
  const scopedCandidates = options.candidate ? [options.candidate] : [];
  const outputRunNonce = options.outputRunNonce ?? hashCanonical(randomBytes(32).toString('hex'));
  const pairResetReceipts = options.lifecycleReceipt?.pairResetReceipts
    ?? scopedCandidates.flatMap(candidateId => scenarios.flatMap(scenario =>
      Array.from({length: REAL_MEASURED_REPETITIONS + 1}, (_, repetition) => ({
        candidateId,
        runtime: options.runtime,
        scenario: scenario.id,
        repetition,
        cacheState: repetition === 0 ? 'cold' as const : 'warm' as const,
        resetReceiptHash: hashCanonical(`unverified:${outputRunNonce}:${candidateId}:${scenario.id}:${repetition}`),
        verified: false,
      }))));
  const resetByKey = new Map(pairResetReceipts.map(receipt => [[
    receipt.candidateId, receipt.runtime, receipt.scenario, receipt.repetition,
  ].join('|'), receipt]));
  const executeCell = dependencies.executeCell ?? runTargetBenchmarkCell;
  let stage = 'matrix_start';
  try {
    for (const candidateId of scopedCandidates) {
      for (const scenario of scenarios) {
        for (let repetition = 0; repetition <= REAL_MEASURED_REPETITIONS; repetition++) {
          const warmup = repetition === 0;
          const resetReceipt = resetByKey.get([
            candidateId, options.runtime, scenario.id, repetition,
          ].join('|'));
          const cacheState = resetReceipt?.cacheState ?? (warmup ? 'cold' as const : 'warm' as const);
          const order = dependencies.randomOrder?.() ?? (randomInt(2) === 0
            ? ['base', 'candidate'] as const
            : ['candidate', 'base'] as const);
          const orderEntry: BenchmarkPairOrderEntry = {
            candidate: candidateId,
            runtime: options.runtime,
            scenario: scenario.id,
            repetition,
            cacheState,
            order,
          };
          (warmup ? warmupPairOrder : randomizedPairOrder).push(orderEntry);
          for (const role of order) {
            stage = `${candidateId}:${scenario.id}:${repetition}:${role}`;
            const targetUrl = role === 'base' ? options.baseUrl : options.candidateUrl;
            const measured = await executeCell({
              baseUrl: targetUrl,
              runtime: options.runtime,
              candidate: candidateId,
              candidateConfigFingerprint: options.candidateConfigFingerprint!,
              scenario,
              repetition,
              warmup,
              cacheState,
              signal: dependencies.signal,
            });
            (role === 'base' ? baseCells : candidateCells).push(measured);
            await writeBenchmarkJsonAtomic(path.join(options.outputDir, 'partial.json'), {
              schemaVersion: 1,
              status: 'RUNNING',
              stage,
              completed: {baseCells, candidateCells},
              randomizedPairOrder,
              warmupPairOrder,
            }, outputIdentity);
          }
        }
      }
    }
  } catch (error) {
    await writeRunFailureEvidence({
      outputDir: options.outputDir, outputIdentity, stage, error, baseCells, candidateCells,
      randomizedPairOrder, warmupPairOrder,
    });
    throw error;
  }
  try {
    stage = 'admission_and_final_artifacts';
    const lifecycleBase = {
      randomizedPairOrder,
      warmupPairOrder,
      outputRunNonce,
      pairResetReceipts,
      freshSessionsVerified: options.lifecycleReceipt?.freshSessions ?? false,
      outputRoot: relativeOutputRoot(options),
      cacheReset: {
        declared: options.lifecycleReceipt?.cacheResetBetweenPairs ?? false,
        ...(options.lifecycleReceipt
          ? {receiptHash: hashCanonical(options.lifecycleReceipt)}
          : {reason: 'The external target lifecycle did not expose a cache-reset receipt.'}),
      },
    };
  const base: RuntimeBenchmarkArtifactV1 = {
    schemaVersion: 1,
    role: 'base',
    executionProvenance: 'real_provider',
    scope: options.candidate && options.candidateConfigFingerprint
      ? {
          runtime: options.runtime,
          candidateId: options.candidate,
          candidateConfigFingerprint: options.candidateConfigFingerprint,
          outputRunNonce,
          sampleKind: 'real',
        }
      : null,
    lifecycle: {
      ...lifecycleBase,
      targetUrl: options.baseUrl,
      ...(options.lifecycleReceipt ? {serverIdentityHash: options.lifecycleReceipt.baseServerIdentityHash} : {}),
      ...(options.lifecycleReceipt ? {
        targetConfigHash: options.lifecycleReceipt.baseConfigHash,
        sourceHash: options.lifecycleReceipt.baseSourceHash,
      } : {}),
      dataRoot: options.lifecycleReceipt
        ? {idHash: options.lifecycleReceipt.baseDataRootHash, fresh: true, verified: true}
        : {idHash: hashCanonical(`base:${options.baseUrl}`), fresh: false, verified: false},
    },
    cells: baseCells,
  };
  const candidate: RuntimeBenchmarkArtifactV1 = {
    schemaVersion: 1,
    role: 'candidate',
    executionProvenance: 'real_provider',
    scope: options.candidate && options.candidateConfigFingerprint
      ? {
          runtime: options.runtime,
          candidateId: options.candidate,
          candidateConfigFingerprint: options.candidateConfigFingerprint,
          outputRunNonce,
          sampleKind: 'real',
        }
      : null,
    lifecycle: {
      ...lifecycleBase,
      targetUrl: options.candidateUrl,
      ...(options.lifecycleReceipt ? {serverIdentityHash: options.lifecycleReceipt.candidateServerIdentityHash} : {}),
      ...(options.lifecycleReceipt ? {
        targetConfigHash: options.lifecycleReceipt.candidateConfigHash,
        sourceHash: options.lifecycleReceipt.candidateSourceHash,
      } : {}),
      dataRoot: options.lifecycleReceipt
        ? {idHash: options.lifecycleReceipt.candidateDataRootHash, fresh: true, verified: true}
        : {idHash: hashCanonical(`candidate:${options.candidateUrl}`), fresh: false, verified: false},
    },
    cells: candidateCells,
  };
    const admissions = scopedCandidates.flatMap(candidateId =>
      scenarios.map(scenario => scoreCandidateAdmission({
        baseArtifact: base,
        candidateArtifact: candidate,
        candidate: candidateId,
        runtime: options.runtime,
        scenario: scenario.id,
        sampleKind: 'real',
      })));
    const aggregates = scopedCandidates.map(candidateId =>
      aggregateCandidateAdmissions(admissions, candidateId, 'real'));
    await Promise.all([
      writeBenchmarkJsonAtomic(path.join(options.outputDir, 'base.json'), base, outputIdentity),
      writeBenchmarkJsonAtomic(path.join(options.outputDir, 'candidate.json'), candidate, outputIdentity),
      writeBenchmarkJsonAtomic(path.join(options.outputDir, 'admission.json'), {schemaVersion: 1, admissions, aggregates}, outputIdentity),
      writeBenchmarkJsonAtomic(path.join(options.outputDir, 'availability.json'), {schemaVersion: 1, availability, plannedRealCallMatrix: plannedMatrix}, outputIdentity),
    ]);
    return {base, candidate, admissions, aggregates, availability};
  } catch (error) {
    await writeRunFailureEvidence({
      outputDir: options.outputDir, outputIdentity, stage, error, baseCells, candidateCells,
      randomizedPairOrder, warmupPairOrder,
    });
    throw error;
  }
}

function determineExitCode(result: Awaited<ReturnType<typeof runAgentLatencyBenchmark>>): number {
  return result.aggregates.length > 0
    && result.aggregates.every(aggregate => aggregate.decision === 'default_on')
    ? 0
    : 2;
}

async function main(): Promise<void> {
  const options = parseAgentLatencyArgs(process.argv.slice(2));
  const controller = new AbortController();
  const abortFromSignal = () => controller.abort(new Error('benchmark_request_aborted'));
  process.once('SIGINT', abortFromSignal);
  let result: Awaited<ReturnType<typeof runAgentLatencyBenchmark>>;
  try {
    result = await runAgentLatencyBenchmark(options, {signal: controller.signal});
  } catch (error) {
    const code = benchmarkErrorCode(error);
    throw new Error(code);
  } finally {
    process.removeListener('SIGINT', abortFromSignal);
  }
  process.stdout.write(`${canonicalJsonString({
    outputDir: relativeOutputRoot(options),
    admissions: result.admissions.map(admission => ({
      candidate: admission.candidate,
      decision: admission.decision,
      reasons: admission.reasons,
    })),
  })}\n`);
  process.exitCode = determineExitCode(result) || undefined;
}

if (require.main === module) {
  main().catch(error => {
    const code = error instanceof Error && /^benchmark_[a-z0-9_:.-]+$/.test(error.message)
      ? error.message
      : 'benchmark_agent_latency_failed';
    process.stderr.write(`${code}\n`);
    process.exit(1);
  });
}
