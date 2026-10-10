// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {z} from 'zod';

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {
  ConclusionBindingEligibility,
  ConclusionContractClaimItem,
} from '../../agent/core/conclusionContract';
import {SOURCE_CLAIM_STATUS_VALUES, type SafeSourceProvenanceProjection, type SourceClaimStatusV1} from '../codebase/sourceClaimVerifier';
import {SOURCE_CITATION_STATUS_VALUES, type SourceCitationV1} from '../codebase/sourceCitations';
import {sanitizeKnowledgeUse, type KnowledgeUseV1} from '../knowledge/knowledgeUse';
import type {ClaimSupportV1} from '../../types/evidenceContract';
import type {ClaimVerificationResult} from '../../types/claimVerification';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {
  SOURCE_LOOKUP_KIND_VALUES,
  type SourceClaimBindingV1,
  type SourceReferenceV1,
  type SourceUseDecisionV1,
} from '../codebase/sourceUseDecision';

type FormalConclusionClaim = Omit<ConclusionContractClaimItem,
  'rawSemantics' | 'rawReferences' | 'semanticsParseIssues'>;

export interface AnalysisEvidencePresentation {
  conclusionBindingEligibility: ConclusionBindingEligibility | null;
  claims: FormalConclusionClaim[];
  claimSupport: ClaimSupportV1[];
  claimVerificationResult: ClaimVerificationResult | null;
  identityResolutions: IdentityResolutionV1[];
  investigationAssessment: AnalysisResult['investigationAssessment'] | null;
  deliveryAssurance: AnalysisResult['deliveryAssurance'] | null;
  sourceUseDecision: SourceUseDecisionV1 | null;
  sourceReferences: SourceReferenceV1[];
  sourceClaimBindings: SourceClaimBindingV1[];
  /** The current verifier's standing per source-dependent claim; absent in historical bundles. */
  sourceClaimStatuses?: SourceClaimStatusV1[];
  /** Source locations the answer cites; absent in historical bundles. */
  sourceCitations?: SourceCitationV1[];
  /** Selected knowledge delivered and the answer's knowledge citations; absent when not recorded. */
  knowledgeUse?: KnowledgeUseV1;
}

export type AnalysisEvidencePresentationInput = Pick<AnalysisResult,
  'claimSupport' | 'claimVerificationResult' | 'identityResolutions' |
  'investigationAssessment' | 'deliveryAssurance' | 'knowledgeUse'> & {conclusionContract?: unknown};

const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const nullableScalar = scalar.nullable();
const timestamp = z.union([z.string(), z.number().finite()]);

function schemas(strict: boolean) {
  const object = <T extends z.ZodRawShape>(shape: T) => strict ? z.strictObject(shape) : z.object(shape);
  const scalarRecord = z.record(z.string(), scalar);
  const jsonRecord = z.record(z.string(), z.json());

  const claimReference: z.ZodType = object({
    evidenceRefId: z.string().optional(), rowIndex: z.number().int().nonnegative().optional(),
    rowSelector: scalarRecord.optional(), column: z.string().optional(), value: nullableScalar.optional(),
    sourceRef: z.string().optional(), sourceToolCallId: z.string().optional(), artifactId: z.string().optional(),
    sourceArtifactId: z.string().optional(),
  });
  const semantics: z.ZodType = object({
    schemaVersion: z.literal('claim_semantics@1'), predicate: z.string(),
    polarity: z.enum(['affirmed', 'negated', 'undetermined']),
    discourse: z.enum(['asserted', 'hypothetical', 'quoted', 'rejected_quote']),
    quantifier: z.enum(['one', 'some', 'all', 'only']),
    modality: z.enum(['certain', 'possible', 'undetermined']), conditions: z.array(z.string()).optional(),
    scope: object({
      subjectRefs: z.array(claimReference).optional(), objectRefs: z.array(claimReference).optional(),
      population: z.enum(['cited_rows', 'selected_interval', 'process_instance', 'trace', 'codebase']),
      timeRangeNs: object({start: z.string(), end: z.string()}).optional(),
    }),
    numeric: object({operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
      value: z.union([z.number().finite(), z.string()]), unit: z.string()}).optional(),
    source: object({sourceReferenceId: z.string(), filePath: z.string(),
      lineRange: object({start: z.number().int().positive(), end: z.number().int().positive()})}).optional(),
  });
  const claim = object({
    id: z.string().optional(), conclusionId: z.string().optional(), text: z.string(),
    kind: z.enum(['numeric', 'categorical', 'time_range', 'identity', 'causal', 'comparison', 'inference', 'recommendation']).optional(),
    references: z.array(claimReference),
    artifactRefs: z.array(object({artifactId: z.string(), rowIndex: z.number().int().nonnegative().optional(),
      rowSelector: jsonRecord.optional()})).optional(),
    relationRefs: z.array(z.string()).optional(),
    supportLevel: z.enum(['verified', 'partial', 'inference', 'unsupported']).optional(),
    semantics: semantics.optional(),
  });

  const processScope = object({
    mode: z.enum(['exact_upid', 'named', 'unscoped']), traceId: z.string(),
    traceSide: z.enum(['current', 'reference', 'unknown']), upid: z.number().int().positive().optional(),
    requestedName: z.string().optional(), identityRefId: z.string().optional(),
  });
  const scopeProvenance = object({
    version: z.literal('process_scope_evidence@1'),
    entries: z.array(object({
      role: z.enum(['target', 'global_context', 'peer_context', 'identity_metadata']),
      scope: processScope, sourceStepId: z.string().optional(), fields: z.array(z.string()).optional(),
      availability: z.enum(['available', 'unavailable']).optional(), reason: z.string().optional(),
      relativeTo: processScope.optional(),
    })),
    invalid: z.literal(true).optional(),
  });
  const evidenceContext = object({
    traceId: z.string(), captureId: z.string().optional(), traceSide: z.enum(['current', 'reference', 'unknown']).optional(),
    paneSide: z.enum(['left', 'right', 'top', 'bottom']).optional(), toolCallId: z.string().optional(),
    sourceToolCallId: z.string().optional(),
    producerKind: z.enum(['execute_sql', 'execute_sql_on', 'invoke_skill', 'compare_skill', 'fetch_artifact', 'analysis_snapshot', 'manual']),
    skillId: z.string().optional(), stepId: z.string().optional(), queryHash: z.string().optional(),
    queryReviewId: z.string().optional(), sqlTextRef: z.string().optional(), paramsHash: z.string().optional(),
    artifactId: z.string().optional(), sourceArtifactId: z.string().optional(), planPhaseId: z.string().optional(),
  });
  const evidenceCell = object({
    sourceRef: z.string().optional(), rowIndex: z.number().int().nonnegative().optional(),
    rowSelector: scalarRecord.optional(), column: z.string(), value: nullableScalar.optional(),
    actualValue: nullableScalar.optional(), isSqlNull: z.boolean().optional(), displayValue: z.string().optional(),
    unit: z.string().optional(),
    producer: object({skillId: z.string(), stepId: z.string(), metricId: z.string(),
      aggregation: z.string().optional()}).optional(),
  });
  const evidenceIdentity = object({
    packageName: z.string().optional(), processName: z.string().optional(), threadName: z.string().optional(),
    upid: z.number().int().nonnegative().optional(), utid: z.number().int().nonnegative().optional(),
    pid: z.number().int().nonnegative().optional(), tid: z.number().int().nonnegative().optional(),
    role: z.enum(['app_main', 'render_thread', 'binder_thread', 'producer', 'surfaceflinger', 'hwc', 'unknown']).optional(),
    identityRefId: z.string().optional(), confidence: z.number().finite().optional(),
    status: z.enum(['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error']).optional(),
    warnings: z.array(z.string()).optional(),
  });
  const evidenceAnchor = object({
    anchorId: z.string(), version: z.literal('evidence_contract@1'), evidenceRefId: z.string(), context: evidenceContext,
    cells: z.array(evidenceCell).optional(),
    timeRange: object({startTs: timestamp, endTs: timestamp, unit: z.literal('ns'),
      source: z.enum(['row', 'params', 'selection', 'derived'])}).optional(),
    identity: evidenceIdentity.optional(), scopeProvenance: scopeProvenance.optional(), confidence: z.number().finite().optional(),
    claimBoundary: z.string().optional(), evidenceScope: z.string().optional(), rootCauseBoundary: z.string().optional(),
    missing: z.boolean().optional(), missingReason: z.string().optional(),
  });
  const proofBinding = object({endpointColumn: z.string(), proofColumn: z.string()});
  const proofBindings = object({subject: proofBinding, object: proofBinding});
  const relation = object({
    schemaVersion: z.literal('evidence_relation@1'), id: z.string(),
    kind: z.enum(['overlap', 'wakeup', 'blocking_state', 'binder_peer', 'lock_owner', 'comparison_delta', 'derived']),
    direction: z.enum(['subject_to_object', 'object_to_subject', 'symmetric']),
    verificationStatus: z.enum(['verified', 'candidate', 'rejected']),
    reasonCode: z.enum([
      'relation_anchor_missing', 'relation_endpoint_value_mismatch', 'trace_context_missing', 'trace_context_mismatch',
      'identity_conflict', 'identity_evidence_missing', 'proof_anchor_missing', 'proof_binding_missing',
      'proof_binding_mismatch', 'binary_proof_verified', 'overlap_range_missing', 'overlap_range_invalid',
      'overlap_disjoint', 'overlap_verified', 'comparison_side_mismatch', 'comparison_not_cross_trace',
      'comparison_metric_missing', 'comparison_metric_invalid', 'comparison_delta_mismatch', 'comparison_delta_verified',
      'derived_not_verified',
    ]),
    subjectAnchorId: z.string(), objectAnchorId: z.string().optional(), proofAnchorId: z.string().optional(),
    relationAnchorId: z.string().optional(), directEvidenceAnchorIds: z.array(z.string()), proofBindings: proofBindings.optional(),
    metricColumn: z.string().optional(), value: scalar.optional(), isSqlNull: z.boolean().optional(), unit: z.string().optional(),
    deltaDirection: z.literal('current_minus_reference').optional(),
    supportLevel: z.enum(['verified', 'partial', 'inference', 'unsupported']), reason: z.string().optional(),
  });
  const claimSupport = object({
    claimId: z.string(), kind: z.enum(['numeric', 'categorical', 'identity', 'time_range', 'causal', 'comparison', 'inference', 'recommendation']),
    text: z.string(), semantics: semantics.optional(), bindingEligibility: z.enum(['eligible', 'ineligible', 'legacy_unchecked']).optional(),
    anchors: z.array(evidenceAnchor), relationAnchors: z.array(evidenceAnchor).optional(), relations: z.array(relation).optional(),
    relationEvaluation: z.enum(['not_configured', 'verified', 'candidate', 'rejected', 'missing']).optional(),
    supportLevel: z.enum(['verified', 'partial', 'inference', 'unsupported']), inferenceReason: z.string().optional(),
  });

  const verificationReference = object({
    evidenceRefId: z.string().optional(), sourceRef: z.string().optional(), artifactId: z.string().optional(),
    sourceToolCallId: z.string().optional(), anchorId: z.string().optional(), column: z.string().optional(),
    status: z.enum(['matched', 'missing', 'ambiguous', 'value_mismatch', 'ineligible', 'not_checked']),
    message: z.string().optional(),
  });
  const nativeRow = object({
    anchorId: z.string(), evidenceRefId: z.string(), captureId: z.string(), traceId: z.string(),
    traceSide: z.enum(['current', 'reference']), relation: z.string(), idColumn: z.string(),
    id: z.number().int().nonnegative(), schemaFingerprint: z.string(),
  });
  const verificationClaim = object({
    claimId: z.string(), status: z.enum(['verified', 'partial', 'inference', 'unsupported', 'not_checked']),
    referenceResults: z.array(verificationReference).optional(), referenceCells: z.array(verificationReference).optional(),
    deterministicProof: object({
      kind: z.enum(['numeric_cell', 'captured_cell', 'source_location', 'interval_overlap', 'comparison_delta', 'none']),
      status: z.enum(['proved', 'candidate', 'rejected', 'not_checked']), reason: z.string(),
      anchorIds: z.array(z.string()), evidenceRefIds: z.array(z.string()), nativeRows: z.array(nativeRow).optional(),
    }).optional(),
    propositionCoverage: object({status: z.enum(['complete', 'partial', 'none']), covered: z.array(z.string()),
      uncovered: z.array(z.string()), reason: z.string()}).optional(),
    semanticReview: object({consistency: z.enum(['consistent', 'inconsistent', 'unknown']),
      contentLocations: z.array(object({start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
        textHash: z.string()}))}).optional(),
  });
  // Keyed by the result type: a field missing here would be stripped on write and rejected on read.
  const claimVerification = object({
    schemaVersion: z.enum(['claim_verifier@1', 'claim_verifier@2']),
    status: z.enum(['passed', 'failed', 'partial', 'not_checked']), policy: z.enum(['block', 'retry', 'warn_only', 'record_only']),
    notCheckedReason: z.string().optional(), notCheckedDetail: z.string().optional(),
    passed: z.boolean(), checkedClaimCount: z.number().int().nonnegative(),
    unsupportedClaimCount: z.number().int().nonnegative(), claimResults: z.array(verificationClaim),
    issues: z.array(object({claimId: z.string(), severity: z.enum(['error', 'warning']), code: z.string(),
      message: z.string(), evidenceRefId: z.string().optional()})),
  } satisfies Record<keyof ClaimVerificationResult, z.ZodType>);

  const identityTarget = object({
    traceId: z.string(), traceSide: z.enum(['current', 'reference', 'unknown']).optional(), packageName: z.string().optional(),
    processName: z.string().optional(), threadName: z.string().optional(),
    role: z.enum(['app_main', 'render_thread', 'binder_thread', 'producer', 'surfaceflinger', 'hwc', 'unknown']).optional(),
    upid: z.number().int().nonnegative().optional(), utid: z.number().int().nonnegative().optional(),
    pid: z.number().int().nonnegative().optional(), tid: z.number().int().nonnegative().optional(),
    timeRange: object({startTs: timestamp, endTs: timestamp}).optional(),
    source: z.enum(['user_param', 'skill_param', 'selection', 'visible_window', 'sql_filter', 'derived']),
  });
  const processIdentity = object({
    upid: z.number().int().nonnegative(), pid: z.number().int().nonnegative().optional(), processName: z.string().optional(),
    packageName: z.string().optional(), startTs: timestamp.optional(), endTs: timestamp.optional(),
    matchSources: z.array(z.string()), confidence: z.number().finite(),
  });
  const threadIdentity = object({
    utid: z.number().int().nonnegative(), tid: z.number().int().nonnegative().optional(), threadName: z.string().optional(),
    role: z.enum(['app_main', 'render_thread', 'binder_thread', 'producer', 'surfaceflinger', 'hwc', 'unknown']).optional(),
    owningUpid: z.number().int().nonnegative().optional(), processName: z.string().optional(),
    activeRange: object({startTs: timestamp.optional(), endTs: timestamp.optional()}).optional(),
    matchSources: z.array(z.string()), confidence: z.number().finite(),
  });
  const identityResolution = object({
    version: z.literal('identity_contract@1'), identityRefId: z.string(), target: identityTarget,
    status: z.enum(['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error']),
    processes: z.array(processIdentity), threads: z.array(threadIdentity), warnings: z.array(z.string()),
    recommendedParams: scalarRecord.optional(),
  });

  const reportBinding = object({
    candidateRef: z.string(), runId: z.string(), attemptId: z.string(), conclusionFingerprint: z.string(),
    conclusionContractFingerprint: z.string(), evidenceFingerprint: z.string(), requirementsFingerprint: z.string(),
    registryFingerprint: z.string(), intentFingerprint: z.string(), caseRetrievalFingerprint: z.string().optional(),
  });
  const evidenceRecord = object({
    recordId: z.string(), captureId: z.string(), rowIndex: z.number().int().nonnegative(), evidenceRefId: z.string().optional(),
    artifactId: z.string().optional(), sourceToolCallId: z.string().optional(), skillId: z.string(), stepId: z.string(),
    definitionFingerprint: z.string(), selectedSqlHash: z.string(), traceId: z.string(),
    traceSide: z.enum(['current', 'reference']), originRunId: z.string().optional(), origin: z.enum(['current_run', 'reused', 'unknown']),
    domain: z.string(), metricId: z.string(), status: z.enum(['observed', 'partial', 'unavailable', 'unknown']),
    window: object({start: timestamp, end: timestamp}), upid: z.number().int().nonnegative().optional(),
    utid: z.number().int().nonnegative().optional(), cpu: z.number().int().nonnegative().nullable().optional(),
    ucpu: z.number().int().nonnegative().nullable().optional(), machineId: z.number().int().nonnegative().nullable().optional(),
    windowId: z.union([z.number().finite(), z.string(), z.null()]).optional(), role: z.string().nullable().optional(),
    aggregation: z.string().optional(), value: nullableScalar, unit: z.string().optional(),
    coverage: timestamp.optional(), denominator: timestamp.optional(),
  });
  const investigationAssessment = object({
    schemaVersion: z.literal(1), binding: reportBinding.extend({ledgerFingerprint: z.string(), evidenceRecordsFingerprint: z.string().optional()}),
    status: z.enum(['not_checked', 'unavailable', 'coverage_incomplete', 'checked']),
    requirements: z.array(object({
      requirementId: z.string(), domain: z.string(), applicability: z.enum(['applicable', 'not_applicable', 'unknown']),
      coverage: z.enum(['covered', 'missing', 'unknown']), contentLocations: z.array(object({start: z.number().int().nonnegative(), end: z.number().int().positive()})),
      evidenceRecordIds: z.array(z.string()), scopeMatch: z.enum(['matched', 'mismatched', 'unknown']),
      evidenceStatus: z.enum(['observed', 'insufficient', 'not_checked', 'failed', 'not_applicable', 'unknown']),
      acquisition: z.enum(['observed', 'insufficient', 'not_checked', 'failed', 'not_applicable', 'unknown']),
    })),
    evidenceRecords: z.array(evidenceRecord).optional(),
    ledgerAcquisition: z.array(object({
      requirementId: z.string(), domain: z.string(),
      applicability: z.enum(['applicable', 'not_applicable', 'unknown']),
      status: z.enum(['observed', 'partial', 'evidence_absent', 'not_applicable', 'not_declared', 'unknown']),
      declaredMetrics: z.array(z.string()), observedMetrics: z.array(z.string()),
      condition: object({metricId: z.string(), operator: z.string(), value: z.number(),
        observed: z.number().nullable(), met: z.boolean().nullable()}).optional(),
    })).optional(),
  });
  const assuranceStatus = z.enum(['not_applicable', 'not_checked', 'unavailable', 'coverage_incomplete', 'passed', 'failed']);
  const deliveryAssurance = object({
    schemaVersion: z.literal(1), entry: z.enum(['runtime_draft', 'new_finalization', 'historical_restore']),
    completion: assuranceStatus, claims: assuranceStatus, source: assuranceStatus, identity: assuranceStatus,
    report: assuranceStatus, investigation: assuranceStatus.optional(), investigationEvidence: assuranceStatus.optional(),
  });

  const sourceReference = object({
    id: z.string(), chunkId: z.string().optional(), referenceId: z.string().optional(), codebaseId: z.string(),
    filePath: z.string(), lineRange: object({start: z.number().int().positive(), end: z.number().int().positive()}).optional(),
    symbol: z.string().optional(), buildId: z.string().optional(), commitHash: z.string().optional(),
    sourceGeneration: z.string().optional(), lookupKind: z.enum(SOURCE_LOOKUP_KIND_VALUES),
  });
  const sourceUseDecision = object({
    schemaVersion: z.literal('source_use_decision@1'), codeAwareMode: z.enum(['metadata_only', 'provider_send']),
    selectedCodebaseIds: z.array(z.string()),
    status: z.enum(['pending', 'not_needed', 'disallowed', 'no_queryable_anchor', 'attempted', 'located', 'corroborated',
      'ambiguous_candidates', 'not_found_complete', 'search_incomplete', 'unverified']),
    reasonCode: z.enum(['not_needed', 'disallowed', 'no_queryable_anchor', 'ambiguous_candidates',
      'not_found_complete', 'search_incomplete', 'unverified']).optional(),
    attemptedTools: z.array(z.string()), queriedCodebaseIds: z.array(z.string()), usedCodebaseIds: z.array(z.string()),
    coverageComplete: z.boolean().optional(), incompleteReasons: z.array(z.string()).optional(), references: z.array(sourceReference),
  });
  // `mechanismStatus` appears only in historical bundles.
  const sourceBinding = object({
    claimId: z.string(), mechanismStatus: z.enum(['corroborated', 'compatible', 'ambiguous', 'unverified']).optional(),
    sourceReferenceIds: z.array(z.string()), traceEvidenceRefIds: z.array(z.string()),
  });
  const sourceClaimStatus = object({
    claimId: z.string(), status: z.enum(SOURCE_CLAIM_STATUS_VALUES),
    sourceReferenceIds: z.array(z.string()), traceEvidenceRefIds: z.array(z.string()),
  });
  const sourceCitation = object({
    citation: z.string(), filePath: z.string(),
    lineRange: object({start: z.number().int().positive(), end: z.number().int().positive()}),
    status: z.enum(SOURCE_CITATION_STATUS_VALUES), sourceReferenceId: z.string().optional(),
    candidateReferenceIds: z.array(z.string()).optional(),
  });
  // Its one closed shape check is sanitizeKnowledgeUse, which returns a fresh copy.
  const knowledgeUse = z.unknown().transform((value, context): KnowledgeUseV1 => {
    const record = sanitizeKnowledgeUse(value);
    if (record) return record;
    context.addIssue({code: 'custom', message: 'invalid knowledge_use@1'});
    return z.NEVER;
  });

  return object({
    conclusionBindingEligibility: z.enum(['eligible', 'ineligible', 'legacy_unchecked']).nullable(),
    claims: z.array(claim), claimSupport: z.array(claimSupport), claimVerificationResult: claimVerification.nullable(),
    identityResolutions: z.array(identityResolution), investigationAssessment: investigationAssessment.nullable(),
    deliveryAssurance: deliveryAssurance.nullable(), sourceUseDecision: sourceUseDecision.nullable(),
    sourceReferences: z.array(sourceReference), sourceClaimBindings: z.array(sourceBinding),
    sourceClaimStatuses: z.array(sourceClaimStatus).optional(), sourceCitations: z.array(sourceCitation).optional(),
    knowledgeUse: knowledgeUse.optional(),
  });
}

const writeSchema = schemas(false);
const readSchema = schemas(true);

export function projectAnalysisEvidenceForDisplay(input: {
  result: AnalysisEvidencePresentationInput;
  sourceProvenance?: SafeSourceProvenanceProjection;
}): AnalysisEvidencePresentation | undefined {
  try {
    if (!isObject(input.result)) return undefined;
    const rawContract = ownDataValue(input.result, 'conclusionContract');
    const conclusionContract = isObject(rawContract) ? rawContract : undefined;
    const rawProvenance = input.sourceProvenance;
    if (rawProvenance !== undefined && !isObject(rawProvenance)) return undefined;
    const rawDecision = rawProvenance ? ownDataValue(rawProvenance, 'sourceUseDecision') : undefined;
    const sourceUseDecision = rawDecision === undefined ? null : rawDecision;
    const candidate = {
      conclusionBindingEligibility: conclusionContract
        ? ownDataValue(conclusionContract, 'bindingEligibility') ?? null : null,
      claims: conclusionContract ? ownDataValue(conclusionContract, 'claims') ?? [] : [],
      claimSupport: ownDataValue(input.result, 'claimSupport') ?? [],
      claimVerificationResult: ownDataValue(input.result, 'claimVerificationResult') ?? null,
      identityResolutions: ownDataValue(input.result, 'identityResolutions') ?? [],
      investigationAssessment: ownDataValue(input.result, 'investigationAssessment') ?? null,
      deliveryAssurance: ownDataValue(input.result, 'deliveryAssurance') ?? null,
      sourceUseDecision,
      sourceReferences: isObject(rawDecision) ? ownDataValue(rawDecision, 'references') ?? [] : [],
      sourceClaimBindings: rawProvenance ? ownDataValue(rawProvenance, 'sourceClaimBindings') ?? [] : [],
      // Present only on current results.
      ...Object.fromEntries((['sourceClaimStatuses', 'sourceCitations'] as const).flatMap(key => {
        const value = rawProvenance ? ownDataValue(rawProvenance, key) : undefined;
        return value === undefined ? [] : [[key, value]];
      })),
    };
    // A malformed record is dropped by itself; it reads as not recorded.
    const knowledgeUse = sanitizeKnowledgeUse(ownDataValue(input.result, 'knowledgeUse'));
    if (knowledgeUse) Object.assign(candidate, {knowledgeUse});
    const prepared = prepareWriterTree(candidate);
    return deepFreeze(writeSchema.parse(prepared)) as AnalysisEvidencePresentation;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('analysis_evidence_accessor');
  return descriptor.value;
}

export function parseClosedAnalysisEvidencePresentation(value: unknown): AnalysisEvidencePresentation | undefined {
  try {
    assertPlainDataTree(value);
    return deepFreeze(readSchema.parse(value)) as AnalysisEvidencePresentation;
  } catch {
    return undefined;
  }
}

function assertPlainDataTree(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('analysis_evidence_non_finite_number');
    return;
  }
  if (typeof value !== 'object') throw new Error('analysis_evidence_non_json_value');
  if (active.has(value)) throw new Error('analysis_evidence_cycle');
  active.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0 ||
        Object.getOwnPropertyNames(value).filter(key => !Array.isArray(value) || key !== 'length').length !==
          Object.keys(value).length) {
      throw new Error('analysis_evidence_hidden_property');
    }
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (!isPlainArrayPrototype(prototype) || Object.keys(value).length !== value.length) {
        throw new Error('analysis_evidence_sparse_array');
      }
    } else if (!isPlainObjectPrototype(prototype)) {
      throw new Error('analysis_evidence_non_plain_object');
    }
    rejectOwnProtoKey(value);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('analysis_evidence_accessor');
      }
      assertPlainDataTree(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

function prepareWriterTree(value: unknown, active = new Set<object>(), dynamicRecord = false): unknown {
  if (value === undefined) throw new Error('analysis_evidence_undefined');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('analysis_evidence_non_finite_number');
    return value;
  }
  if (typeof value !== 'object') throw new Error('analysis_evidence_non_json_value');
  if (active.has(value)) throw new Error('analysis_evidence_cycle');
  active.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('analysis_evidence_symbol');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (!isPlainArrayPrototype(prototype) || Object.keys(value).length !== value.length) {
        throw new Error('analysis_evidence_sparse_array');
      }
      return value.map(item => prepareWriterTree(item, active, dynamicRecord));
    }
    if (!isPlainObjectPrototype(prototype)) throw new Error('analysis_evidence_non_plain_object');
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      throw new Error('analysis_evidence_hidden_property');
    }
    rejectOwnProtoKey(value);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('analysis_evidence_accessor');
      }
      if (descriptor.value === undefined) {
        if (dynamicRecord) throw new Error('analysis_evidence_dynamic_undefined');
        continue;
      }
      output[key] = prepareWriterTree(
        descriptor.value,
        active,
        dynamicRecord || key === 'rowSelector' || key === 'recommendedParams',
      );
    }
    return output;
  } finally {
    active.delete(value);
  }
}

/**
 * JSON.parse and js-yaml keep `__proto__` as an own key, but zod skips it in
 * every object and record schema (strictObject included, without an issue), so
 * a parsed presentation would silently differ from the claim it displays.
 */
function rejectOwnProtoKey(value: object): void {
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) throw new Error('analysis_evidence_proto_key');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isPlainArrayPrototype(prototype: object | null): boolean {
  return prototype === Array.prototype ||
    Boolean(prototype && Object.prototype.hasOwnProperty.call(prototype, 'constructor') &&
      (prototype as {constructor?: {name?: string}}).constructor?.name === 'Array');
}

function isPlainObjectPrototype(prototype: object | null): boolean {
  return prototype === null || prototype === Object.prototype ||
    Boolean(prototype && Object.getPrototypeOf(prototype) === null &&
      (prototype as {constructor?: {name?: string}}).constructor?.name === 'Object');
}
