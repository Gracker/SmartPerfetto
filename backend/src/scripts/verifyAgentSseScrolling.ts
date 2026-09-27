// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.
/// <reference lib="es2021.weakref" />

import 'dotenv/config';
import { installEpipeGuard } from '../utils/epipeGuard';
import {backendLogPath} from '../runtimePaths';
installEpipeGuard();

import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import agentRoutes from '../routes/agentRoutes';
import ragAdminRoutes from '../routes/ragAdminRoutes';
import skillRoutes from '../routes/skillRoutes';
import traceProcessorRoutes from '../routes/traceProcessorRoutes';
import { getTraceProcessorService, type TraceInfo, type TraceProcessorService } from '../services/traceProcessorService';
import { resolveAgentRuntimeSelection } from '../agentRuntime';
import { getOpenAIRuntimeDiagnostics, hasOpenAICredentials } from '../agentOpenAI';
import type {ClaimSemanticsV1, ConclusionContract} from '../agent/core/conclusionContract';
import type { TraceDataset } from '../agent/core/orchestratorTypes';
import type {
  SelectionContext,
  TrackEventSelectionContext,
  TracePairContext,
  TracePairLayout,
  TraceSource,
} from '../agentv3/types';
import {
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
} from '../middleware/auth';
import { writeTraceMetadata } from '../services/traceMetadataStore';
import {CodeLookupLedger} from '../services/codebase/codeLookupLedger';
import {hasConcreteCodeReference} from '../services/codebase/codeReferenceContract';
import {sanitizeSourceUseDecision, type SourceClaimBindingV1, type SourceUseDecisionV1} from '../services/codebase/sourceUseDecision';
import type {ClaimVerificationResult, ClaimVerificationClaimResult} from '../types/claimVerification';
import type {ClaimSupportV1, EvidenceAnchorV1} from '../types/evidenceContract';
import type {AnalysisDeliveryAssurance, AnalysisCompletion} from '../types/analysisDelivery';
import {analysisDeliveryFingerprint} from '../types/analysisDelivery';
import type {AnalysisTurnIntent} from '../agentRuntime/analysisTurnIntent';
import type {FinalInvestigationAssessment, InvestigationRequirementAssessment} from '../types/analysisInvestigationAssessment';
import {sanitizeCandidateProtocolDiagnostic, type CandidateProtocolDiagnostic} from '../services/canonicalAnalysisResult';
import {TraceProcessorFactory, WorkingTraceProcessor} from '../services/workingTraceProcessor';
import {analyzeRawSqlDirectProjection} from '../services/evidence/rawSqlDirectProjection';
import {readRawSqlCaptureFields, resolveRawSqlNativeRowSchema, type RawSqlNativeRowSchema} from '../services/evidence/rawSqlNativeProvenance';
import {resolveCapabilityTraceProcessorIdentity} from '../services/capabilityManifestRuntimeIdentity';
import {loadPerfettoSqlDocsAsset} from '../services/perfettoSqlDocs';
import {prepareAnalysisRunTraceProcessorLeases, type AnalysisRunTraceProcessorLeases,
  type AnalysisRunTraceProcessorLeaseEntry} from '../services/analysisRunTraceProcessorLease';
import type {EnterpriseRepositoryScope} from '../services/enterpriseRepository';
import {
  privateProjectedSourceEventType,
  successfulCodeLookupToolCounts,
} from './agentSseVerificationEvidence';

import {isTerminalSseEvent} from '../assistant/stream/sessionSseReplay';
import {createSceneSseObservation, recordSceneSseEvent, evaluateSceneSseVerification, SCENE_RUN_TERMINAL_EVENTS, parseSceneOracleSpecs, collectSceneOracleRows, evaluateSceneOracleRows, type SceneOracleSpec, type SceneOracleObservation, type SceneSseObservation} from './sceneSseVerification';

type CodeAwareMode = 'off' | 'metadata_only' | 'provider_send';
type SmartAction = 'preview' | 'analyze';

export interface VerifyOptions {
  entry?: 'analyze' | 'scene-reconstruction';
  sceneScenario?: 'complete' | 'partial' | 'cancel';
  sceneMinRevision?: number;
  sceneObservationMs?: number;
  sceneOracles?: SceneOracleSpec[];
  /** Optional task facts; literal text checks are transport diagnostics only. */
  expectation?: AgentSseExpectation;
  tracePath: string;
  referenceTracePath?: string;
  query: string;
  timeoutMs: number;
  outputPath?: string;
  keepSession: boolean;
  keepTrace: boolean;
  requireConclusionEvidence: boolean;
  /** Analysis mode override forwarded as options.analysisMode to the backend. */
  analysisMode?: 'fast' | 'full' | 'auto';
  /** Analyze preset forwarded as options.preset to the backend. */
  preset?: 'smart';
  /** Frontend-style pre-queried trace datasets forwarded as top-level traceContext. */
  traceContext?: TraceDataset[];
  selectionContext?: SelectionContext;
  sliceSelectionTarget?: SliceSelectionTarget;
  /** Smart action forwarded as options.smartAction. Defaults to analyze for --mode smart CLI runs. */
  smartAction?: SmartAction;
  /** Smart scene selection forwarded as options.smartSelection. */
  smartSelection?: {
    scope: 'all' | 'scene_types' | 'scene_ids';
    sceneTypes?: string[];
    sceneIds?: string[];
    label?: string;
  };
  /** Force deterministic prepasses to bypass cached scene reports. */
  forceRefresh: boolean;
  /** Code-aware mode forwarded as options.codeAwareMode to the backend. */
  codeAwareMode?: CodeAwareMode;
  /** Registered codebases exposed to this verification run. */
  codebaseIds: string[];
  /** Registered private knowledge sources exposed to this verification run. */
  knowledgeSourceIds: string[];
  /** Optional source root registered and indexed through the real admin API before analysis. */
  setupCodebaseRoot?: string;
  /** Explicit setup behavior; omitted preserves the historical register-and-index path. */
  setupCodebaseMode?: 'register-only' | 'register-and-index';
  /** Optional Wiki root registered and indexed through the real admin API before analysis. */
  setupKnowledgeRoot?: string;
  /**
   * undefined = use active Provider Manager profile if configured.
   * string = use that explicit provider.
   * null = force env/default fallback and ignore active providers.
   */
  providerId?: string | null;
  /** Require semantic source-level code references in the final conclusion. */
  requireCodeRef: boolean;
  /** Require analysis_completed claim verifier output to pass with no unsupported claims. */
  requireClaimVerifierOk: boolean;
  /** Require the terminal analysis_completed payload to not be marked partial. */
  requireNonPartial: boolean;
  /** Require a final-report heading such as # 性能分析报告 / ## 综合结论 / ## Final Conclusion. */
  requireFinalReportHeading: boolean;
  /** Fail if final text contains process narration such as "enter Phase". */
  forbidProcessNarration: boolean;
  /** Optional upper bound for the final analysis_completed conclusion text length. */
  maxAnalysisCompletedConclusionChars?: number;
  /** Exact transport/canary assertion, never natural-language semantic evidence. */
  requiredText: string[];
  /** Literal text that must not appear in a conclusion/analysis_completed event. */
  forbiddenText: string[];
  /** Optional second-turn query sent to the same session after the first turn completes. */
  followUpQuery?: string;
  /** Per-turn analysis mode for the follow-up; defaults to auto instead of inheriting the first turn. */
  followUpAnalysisMode: 'fast' | 'full' | 'auto';
  /** Literal text that must appear in the follow-up conclusion/analysis_completed event. */
  followUpRequiredText: string[];
  /** Tool names that must not be dispatched during the follow-up turn. */
  followUpForbiddenTools: string[];
  /** Degraded fallback names that must not be emitted during the run. */
  forbiddenDegradedFallbacks: string[];
  /** Allow full-mode source/tool checks that intentionally do not emit data envelopes. */
  allowNoDataEnvelopes: boolean;
  /** Require at least one data envelope even in quick mode. */
  requireDataEnvelope: boolean;
  /** Require analysis_completed.quickRun receipt metadata. */
  requireQuickRun: boolean;
  /** Allow capability-limited preview runtimes that only prove routing/SSE/finalization. */
  allowCapabilityLimitedRuntime: boolean;
  /** Require a real source-run-pinned external issue opportunity and Agent triage. */
  requireExternalIssueTriage: boolean;
  /** Tool names that must be dispatched during the run. */
  requiredTools: string[];
  /** Private lookup tools that must return at least one provenance-bearing chunk. */
  requiredSuccessfulLookups: string[];
  /** Skill ids that must be dispatched through invoke_skill during the run. */
  requiredSkills: string[];
  tracePairLayout: TracePairLayout;
  tracePairWorkspaceOpen: boolean;
  tracePairSplitPercent: number;
  tracePairActiveTraceSide: TraceSource;
  tracePairMaximizedTraceSide?: TraceSource;
  tracePairMinimizedTraceSides: TraceSource[];
}

export interface SseSummary {
  terminalAnalysis?: TerminalAnalysisEvidence;
  candidateProtocolDiagnostics?: CandidateProtocolDiagnostic[];
  totalEvents: number;
  terminalEvent?: string;
  /** agentv3 event type counts */
  progressCount: number;
  agentTaskDispatchedCount: number;
  agentResponseCount: number;
  answerTokenCount: number;
  /** Non-provisional conclusion events; the answer's terminal payload. */
  conclusionCount: number;
  /**
   * Deliver first, verify after: `conclusion` events with `provisional: true`,
   * sent when the semantic review starts. They carry the final body but no
   * verdict, so they never count as a terminal conclusion payload.
   */
  provisionalConclusionCount: number;
  /** Milliseconds from stream start to the first provisional answer (latency measurement). */
  firstProvisionalConclusionMs?: number;
  dataEnvelopeCount: number;
  planSubmittedCount: number;
  /**
   * The analysis process view's own surface.
   *
   * These were computed, transmitted, and never observed: the process view is
   * assembled from `conversation_step`, and `thought` carries the model's
   * between-tool reasoning, yet neither had a counter here. A run that stopped
   * emitting them would have looked identical to one that did not, so a claim
   * that either reaches a user was unfalsifiable from this artifact.
   */
  conversationStepCount: number;
  thoughtCount: number;
  planPhaseUpdatedCount: number;
  architectureDetectedCount: number;
  degradedCount: number;
  degradedFallbackCounts: Record<string, number>;
  degradedEvents: Array<{
    fallback?: string;
    terminationReason?: string;
    message?: string;
  }>;
  errorEvents: string[];
  /** Number of DataEnvelope objects carried by data events, not just event count. */
  dataEnvelopeItemCount: number;
  dataEnvelopeMissingPhaseCount: number;
  dataEnvelopeAmbiguousPhaseCount: number;
  dataEnvelopeUnexpectedPhaseCount: number;
  dataEnvelopePhaseCounts: Record<string, number>;
  conclusionChars: number;
  conclusionHasConcreteEvidenceRefs: boolean;
  conclusionHasEvidenceIndex: boolean;
  analysisCompletedConclusionChars: number;
  analysisCompletedHasConcreteEvidenceRefs: boolean;
  analysisCompletedHasEvidenceIndex: boolean;
  analysisCompletedHasFinalReportHeading: boolean;
  analysisCompletedHasProcessNarration: boolean;
  claimVerifierStatus?: string;
  claimVerifierPassed?: boolean;
  claimVerifierCheckedClaimCount?: number;
  claimVerifierUnsupportedClaimCount?: number;
  claimVerifierIssueCount?: number;
  conclusionHasConcreteCodeRefs: boolean;
  analysisCompletedHasConcreteCodeRefs: boolean;
  analysisCompletedSourceUseStatus?: string;
  analysisCompletedSourceUseDecision?: SourceUseDecisionV1;
  analysisCompletedSourceReferenceCount?: number;
  analysisCompletedSourceBindingCount?: number;
  analysisCompletedSourceClaimVerifierStatus?: string;
  analysisCompletedSourceMechanismStatuses?: string[];
  analysisCompletedSourceReferenceMembershipPassed?: boolean;
  analysisCompletedVerifiedSourceBindings?: Array<Omit<SourceClaimBindingV1, 'reason'>>;
  analysisCompletedReportUrl?: string;
  analysisCompletedPartial?: boolean;
  analysisCompletedTerminationReason?: string;
  analysisCompletedTerminationMessage?: string;
  externalIssueSource?: {
    runId: string;
    runManifestId: string;
    resultSnapshotId?: string;
  };
  quickRun?: {
    requestedMode?: string;
    resolvedMode?: string;
    profile?: string;
    targetTurns?: number;
    hardCapTurns?: number;
    actualTurns?: number;
    enforcement?: string;
    stopReason?: string;
    verifierStatus?: string;
    frontendPrequeryInjected?: number;
    frontendPrequeryCited?: number;
    currentRunDataEnvelopes?: number;
    citedEvidenceRefs?: number;
  };
  requiredTextMatches: Record<string, boolean>;
  forbiddenTextMatches: Record<string, boolean>;
  /** Older SSE fields that may still appear in archived sessions/logs. */
  stageNames: string[];
  stageTransitionCount: number;
  directSkillProgressCount: number;
  directSkillCompletedCount: number;
  directSkillFindingCount: number;
  toolCallCounts: Record<string, number>;
  successfulLookupCounts: Record<string, number>;
  skillCallCounts: Record<string, number>;
}

type FactScalar = string | number | boolean;
export interface AgentSseExpectedFact {
  id: string;
  kind: 'numeric' | 'categorical' | 'identity';
  columns: string[];
  verification: 'proved' | 'reference_only';
  population?: ClaimSemanticsV1['scope']['population'];
  value?: FactScalar;
  unit?: string;
  /** Suite-owned read-only query. Results never enter the model context. */
  oracle?: {sql: string; column: string; unit?: string; traceSide?: 'current' | 'reference';
    anchorMatch?: {startTs?: string; upid?: string;
      nativeRow?: {relation: string; idColumn: string; oracleColumn: string}}};
}

export interface AgentSseExpectation {
  schemaVersion: 1;
  intent: Partial<Pick<AnalysisTurnIntent, 'sceneId' | 'taskKind' | 'scope' | 'deliverable' | 'evidenceAccess'>>;
  facts: AgentSseExpectedFact[];
  investigation?: AgentSseInvestigationExpectation;
  /** Explicitly unmeasured facets, such as source recommendation wording. */
  uncoveredFacets?: string[];
}

export interface AgentSseInvestigationExpectation {
  contentAssurance: NonNullable<AnalysisDeliveryAssurance['investigation']>;
  evidenceAssurance: NonNullable<AnalysisDeliveryAssurance['investigationEvidence']>;
  assessmentStatus: FinalInvestigationAssessment['status'];
  requirements: Array<{
    id: string;
    domain: string;
    applicability: InvestigationRequirementAssessment['applicability'];
    coverage: InvestigationRequirementAssessment['coverage'];
    acquisition: InvestigationRequirementAssessment['acquisition'];
    scopeMatch: InvestigationRequirementAssessment['scopeMatch'];
    records?: Array<{
      metricId: string;
      traceSide: 'current' | 'reference';
      origin?: 'current_run' | 'reused' | 'unknown';
      upid?: number;
      utid?: number;
      window?: {start: string; end: string};
      /** Resolve window/identity from an independently collected fact oracle row. */
      oracleScope?: {factId: string; startColumn: string; endColumn: string; upidColumn?: string; utidColumn?: string};
    }>;
  }>;
}

export interface TerminalAnalysisEvidence {
  success?: boolean;
  conclusion?: string;
  completion?: AnalysisCompletion;
  turnIntent?: AnalysisTurnIntent;
  deliveryAssurance?: AnalysisDeliveryAssurance;
  conclusionContract?: ConclusionContract;
  claimVerificationResult?: ClaimVerificationResult;
  claimSupport?: ClaimSupportV1[];
  investigationAssessment?: FinalInvestigationAssessment;
}

export type AgentSseOracleRows = Record<string, Array<Record<string, unknown>>>;
export type AgentSseOracleNativeSchemas = Record<string, Readonly<RawSqlNativeRowSchema & {traceId: string}>>;

/** Independent pre-model oracle pin. It never receives a model proof or issues a capture witness. */
export async function prepareAgentSseNativeOracle(input: {
  expectation: AgentSseExpectation;
  traceId: string;
  service: Pick<TraceProcessorService, 'getTrace' | 'getRunningNativeProcessorObservation' | 'getRunningCapabilityTraceProcessorInput'>;
  signal?: AbortSignal;
  lease?: AnalysisRunTraceProcessorLeaseEntry;
  assertCurrent?: () => void;
}, dependencies: {
  resolveIdentity?: typeof resolveCapabilityTraceProcessorIdentity;
  loadDocs?: typeof loadPerfettoSqlDocsAsset;
} = {}): Promise<{schemas: AgentSseOracleNativeSchemas; assertCurrent(): Promise<void>}> {
  const facts = input.expectation.facts.filter(fact => fact.oracle?.anchorMatch?.nativeRow);
  const schemas: AgentSseOracleNativeSchemas = Object.create(null);
  if (!facts.length) return {schemas: Object.freeze(schemas), assertCurrent: async () => undefined};
  const unavailable = (): never => {throw new Error('Task native row oracle unavailable');};
  const queryScope = input.lease ? {leaseId: input.lease.lease.id, leaseMode: input.lease.lease.mode,
    leaseScope: input.lease.context.leaseScope, signal: input.signal} : {signal: input.signal};
  if (input.lease && (input.lease.context.traceId !== input.traceId || input.lease.lease.traceId !== input.traceId ||
      input.lease.context.leaseId !== input.lease.lease.id || input.lease.context.mode !== input.lease.lease.mode ||
      !input.lease.context.holder || !input.lease.context.leaseScope)) return unavailable();
  const registered = input.service.getTrace(input.traceId);
  input.signal?.throwIfAborted();
  input.assertCurrent?.();
  const initial = input.service.getRunningNativeProcessorObservation(input.traceId, queryScope);
  if (!registered || registered.id !== input.traceId || registered.status !== 'ready' || !initial) return unavailable();
  const binarySelection = {...initial.binarySelection};
  const observeCurrent = () => {
    input.signal?.throwIfAborted();
    input.assertCurrent?.();
    const current = input.service.getRunningNativeProcessorObservation(input.traceId, queryScope);
    const binary = input.service.getRunningCapabilityTraceProcessorInput(input.traceId, queryScope);
    if (input.service.getTrace(input.traceId) !== registered || registered.id !== input.traceId || registered.status !== 'ready' ||
      !current || current.instanceToken !== initial.instanceToken || current.registrationToken !== initial.registrationToken ||
      current.instanceId !== initial.instanceId || !current.instanceId || current.traceId !== input.traceId ||
      current.status !== 'trusted' || current.nativeSchemaEligible !== true ||
      current.analysisRunPrivate !== (input.lease?.privateProcessor ?? false) ||
      !isDeepStrictEqual(current.binarySelection, binarySelection) || !isDeepStrictEqual(binary, binarySelection)) unavailable();
  };
  const resolveIdentity = dependencies.resolveIdentity ?? resolveCapabilityTraceProcessorIdentity;
  const loadDocs = dependencies.loadDocs ?? loadPerfettoSqlDocsAsset;
  observeCurrent();
  const identity = await resolveIdentity(binarySelection);
  observeCurrent();
  if (identity.source !== 'bundled') return unavailable();
  for (const fact of facts) {
    const tuple = fact.oracle!.anchorMatch!.nativeRow!;
    const schema = resolveRawSqlNativeRowSchema(identity, loadDocs(), tuple.relation);
    if (!schema || schema.relation !== tuple.relation || schema.idColumn !== tuple.idColumn) return unavailable();
    schemas[fact.id] = Object.freeze({...schema, traceId: input.traceId});
  }
  const assertCurrent = async () => {
    observeCurrent();
    const currentIdentity = await resolveIdentity(binarySelection);
    observeCurrent();
    if (!isDeepStrictEqual(currentIdentity, identity)) unavailable();
    for (const fact of facts) {
      const schema = resolveRawSqlNativeRowSchema(currentIdentity, loadDocs(), fact.oracle!.anchorMatch!.nativeRow!.relation);
      if (!schema || !isDeepStrictEqual({...schema, traceId: input.traceId}, schemas[fact.id])) unavailable();
    }
  };
  await assertCurrent();
  return {schemas: Object.freeze(schemas), assertCurrent};
}

/** One oracle-owned lease group; its rows and schemas never become model evidence. */
export async function collectAgentSseOracleEvidence(input: {
  expectation: AgentSseExpectation;
  traceId: string;
  referenceTraceId?: string;
  service: TraceProcessorService;
  scope: EnterpriseRepositoryScope;
  deadlineMs: number;
  signal?: AbortSignal;
}, dependencies: Parameters<typeof prepareAgentSseNativeOracle>[1] & {
  prepareLeases?: typeof prepareAnalysisRunTraceProcessorLeases;
} = {}): Promise<{rows: AgentSseOracleRows; schemas: AgentSseOracleNativeSchemas}> {
  const needsReference = input.expectation.facts.some(fact => fact.oracle?.traceSide === 'reference');
  if (needsReference && (!input.referenceTraceId || input.referenceTraceId === input.traceId)) {
    throw new Error('Task reference trace oracle unavailable');
  }
  const sides: Array<['current' | 'reference', string]> = [['current', input.traceId]];
  if (needsReference) sides.push(['reference', input.referenceTraceId!]);
  if (!input.expectation.facts.some(fact => fact.oracle?.anchorMatch?.nativeRow)) {
    const registrations = new Map(sides.map(([, id]) => [id, input.service.getTrace(id)]));
    const assertPair = () => {
      input.signal?.throwIfAborted();
      if (!needsReference) return;
      if (Date.now() >= input.deadlineMs || sides.some(([, id]) => !registrations.get(id) ||
        input.service.getTrace(id) !== registrations.get(id) || registrations.get(id)?.status !== 'ready' || registrations.get(id)?.id !== id)) {
        throw new Error('Task reference trace oracle registration changed');
      }
    };
    assertPair();
    const rows = await collectAgentSseOracleRows(input.expectation, async (sql, side) => {
      assertPair();
      const result = await input.service.query(side === 'reference' ? input.referenceTraceId! : input.traceId, sql);
      assertPair();
      return result;
    });
    return {rows, schemas: {}};
  }
  if (!Number.isFinite(input.deadlineMs)) throw new Error('Task native row oracle deadline invalid');
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const registered = new Map(sides.map(([side, id]) => [side, input.service.getTrace(id)]));
  const assertOwner = () => {
    if (!signal.aborted && Date.now() >= input.deadlineMs) {
      controller.abort(new DOMException('Task native row oracle deadline exceeded', 'TimeoutError'));
    }
    signal.throwIfAborted();
    for (const [side, id] of sides) {
      const registration = registered.get(side);
      if (!registration || input.service.getTrace(id) !== registration || registration.id !== id || registration.status !== 'ready') {
        throw new Error('Task native row oracle registration changed');
      }
    }
  };
  assertOwner();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => {
    const remaining = input.deadlineMs - Date.now();
    if (remaining <= 0) controller.abort(new DOMException('Task native row oracle deadline exceeded', 'TimeoutError'));
    else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  };
  expire();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {rejectAbort = reject;});
  // Ownership may abort before preparation reaches the first race.
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, {once: true});
  let group: AnalysisRunTraceProcessorLeases | undefined;
  try {
    assertOwner();
    const preparation = (dependencies.prepareLeases ?? prepareAnalysisRunTraceProcessorLeases)({
      service: input.service, scope: input.scope, currentTraceId: input.traceId,
      ...(needsReference ? {referenceTraceId: input.referenceTraceId} : {}),
      runId: `verification-oracle-${randomUUID()}`, sessionId: `verification-oracle-${randomUUID()}`,
      signal, assertCurrent: assertOwner,
      onInvalidated: error => controller.abort(error),
    });
    // A late group still belongs to this cancelled oracle, never a subsequent run.
    void preparation.then(value => {if (signal.aborted) {try {value.release();} catch { /* Admission owns its own cleanup too. */ }}}, () => undefined);
    group = await Promise.race([preparation, aborted]);
    const ownedGroup = group;
    const result = await Promise.race([ownedGroup.run(async () => {
      if (ownedGroup.entries.length !== sides.length) throw new Error('Task native row oracle lease unavailable');
      const rows: AgentSseOracleRows = Object.create(null);
      const schemas: AgentSseOracleNativeSchemas = Object.create(null);
      const pins: Array<Awaited<ReturnType<typeof prepareAgentSseNativeOracle>>> = [];
      for (const [side, targetTraceId] of sides) {
        const entries = ownedGroup.entries.filter(entry => entry.side === side && entry.context.traceId === targetTraceId);
        if (entries.length !== 1) throw new Error('Task native row oracle lease unavailable');
        const entry = entries[0];
        const expectation = {...input.expectation, facts: input.expectation.facts.filter(fact => (fact.oracle?.traceSide ?? 'current') === side)};
        const pin = await prepareAgentSseNativeOracle({expectation, traceId: targetTraceId,
          service: input.service, signal, lease: entry, assertCurrent: () => {assertOwner(); ownedGroup.assertCurrent();}}, dependencies);
        pins.push(pin);
        Object.assign(rows, await collectAgentSseOracleRows(expectation, async sql => {
          for (const active of pins) await active.assertCurrent();
          const result = await input.service.query(targetTraceId, sql, {signal,
            leaseId: entry.lease.id, leaseMode: entry.lease.mode, leaseScope: entry.context.leaseScope});
          for (const active of pins) await active.assertCurrent();
          return result;
        }));
        Object.assign(schemas, pin.schemas);
      }
      for (const pin of pins) await pin.assertCurrent();
      return {rows, schemas};
    }), aborted]);
    assertOwner();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    controller.abort();
    group?.release();
  }
}

function nativeOracleAnchorMatches(input: {
  fact: AgentSseExpectedFact; proof?: ClaimVerificationClaimResult; anchor: EvidenceAnchorV1;
  oracleRow: Record<string, unknown>; schema?: AgentSseOracleNativeSchemas[string]; traceId: string;
}): boolean | undefined {
  const tuple = input.fact.oracle?.anchorMatch?.nativeRow;
  if (!tuple) return undefined;
  const {anchor, proof, schema} = input;
  const rows = proof?.deterministicProof?.nativeRows;
  if (rows === undefined || Array.isArray(rows) && rows.length === 0) return undefined;
  if (!Array.isArray(rows)) return false;
  if (proof?.status !== 'verified' || proof.deterministicProof?.kind !== 'numeric_cell' ||
    proof.deterministicProof.status !== 'proved' || proof.propositionCoverage?.status !== 'complete' ||
    proof.propositionCoverage.uncovered.length || rows.length !== 1 || !schema || schema.traceId !== input.traceId ||
    schema.relation !== tuple.relation || schema.idColumn !== tuple.idColumn) return false;
  const row = rows[0];
  if (!row || typeof row !== 'object') return false;
  return row.anchorId === anchor.anchorId && row.evidenceRefId === anchor.evidenceRefId &&
    proof.deterministicProof.anchorIds.includes(row.anchorId) && proof.deterministicProof.evidenceRefIds.includes(row.evidenceRefId) &&
    typeof row.captureId === 'string' && row.captureId.length > 0 && row.captureId === anchor.context.captureId &&
    row.traceId === input.traceId && row.traceId === anchor.context.traceId && row.traceSide === (input.fact.oracle?.traceSide ?? 'current') &&
    anchor.context.traceSide === row.traceSide && row.relation === schema.relation && row.idColumn === schema.idColumn &&
    row.schemaFingerprint === schema.schemaFingerprint && /^[a-f0-9]{64}$/.test(row.schemaFingerprint) &&
    Number.isSafeInteger(row.id) && row.id >= 0 && row.id === input.oracleRow[tuple.oracleColumn];
}

export interface SliceSelectionTarget {
  processName: string;
  threadName: string;
  eventName: string;
}

type SliceSelectionErrorCode = 'SLICE_SELECTION_INVALID' | 'SLICE_SELECTION_NOT_FOUND' |
  'SLICE_SELECTION_AMBIGUOUS' | 'SLICE_SELECTION_QUERY_FAILED' | 'SLICE_SELECTION_TIMEOUT' |
  'SLICE_SELECTION_CANCELLED' | 'SLICE_SELECTION_INVALID_IDENTITY';

export class VerificationSliceSelectionError extends Error {
  constructor(readonly code: SliceSelectionErrorCode) {
    super(code);
    this.name = 'VerificationSliceSelectionError';
  }
}

export interface ResolvedVerificationSliceSelection {
  status: 'resolved';
  purpose: 'input_scope_not_verified_evidence';
  selector: SliceSelectionTarget;
  selectionContext: TrackEventSelectionContext;
  identity: {traceId: string; table: 'slice'; eventId: number; ts: number; trackId: number; utid: number; upid: number};
}

export function parseSliceSelectionTarget(value: unknown): SliceSelectionTarget {
  const record = asRecord(value);
  const limits = {processName: 256, threadName: 256, eventName: 1024};
  if (!record || Object.keys(record).length !== 3 || Object.keys(record).some(key => !Object.prototype.hasOwnProperty.call(limits, key)) ||
      Object.entries(limits).some(([key, limit]) => typeof record[key] !== 'string' ||
        !record[key].trim() || record[key].length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(record[key]))) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID');
  }
  return {processName: record.processName as string, threadName: record.threadName as string, eventName: record.eventName as string};
}

/** Resolve a user scope against this loaded trace; returned rows are never model evidence. */
export async function resolveVerificationSliceSelection(input: {
  service: Pick<ReturnType<typeof getTraceProcessorService>, 'queryBounded'>;
  traceId: string;
  selector: SliceSelectionTarget;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ResolvedVerificationSliceSelection> {
  const selector = parseSliceSelectionTarget(input.selector);
  if (!input.traceId || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID');
  }
  const timeoutMs = Math.min(input.timeoutMs, 10_000);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const sql = `SELECT s.id AS event_id, s.ts, s.track_id, tt.utid, t.upid, s.dur
    FROM slice s JOIN thread_track tt ON s.track_id = tt.id
    JOIN thread t ON tt.utid = t.utid JOIN process p ON t.upid = p.upid
    WHERE p.name = ${quote(selector.processName)} AND t.name = ${quote(selector.threadName)}
      AND s.name = ${quote(selector.eventName)} ORDER BY s.id LIMIT 2`;
  let result;
  try {
    signal.throwIfAborted();
    result = await input.service.queryBounded(input.traceId, sql, {
      timeoutMs, signal, maxRows: 2, maxResponseBytes: 16 * 1024,
    });
    signal.throwIfAborted();
  } catch {
    throw new VerificationSliceSelectionError(input.signal?.aborted ? 'SLICE_SELECTION_CANCELLED'
      : timeout.aborted ? 'SLICE_SELECTION_TIMEOUT' : 'SLICE_SELECTION_QUERY_FAILED');
  }
  if (result.error) throw new VerificationSliceSelectionError('SLICE_SELECTION_QUERY_FAILED');
  if (result.rows.length === 0) throw new VerificationSliceSelectionError('SLICE_SELECTION_NOT_FOUND');
  if (result.rows.length !== 1) throw new VerificationSliceSelectionError('SLICE_SELECTION_AMBIGUOUS');
  const columns = ['event_id', 'ts', 'track_id', 'utid', 'upid', 'dur'];
  if (!isDeepStrictEqual(result.columns, columns) || result.rows[0].length !== columns.length) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID_IDENTITY');
  }
  const values = result.rows[0].slice(0, 5).map(value => typeof value === 'number' ? value :
    typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN);
  if (values.some((value, index) => !Number.isSafeInteger(value) || (index !== 1 && value < 0))) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID_IDENTITY');
  }
  const [eventId, ts, trackId, utid, upid] = values;
  const rawDuration = result.rows[0][5];
  const duration = typeof rawDuration === 'number' ? rawDuration :
    typeof rawDuration === 'string' && /^-?\d+$/.test(rawDuration) ? Number(rawDuration) : NaN;
  if (!Number.isSafeInteger(duration) || duration < -1 ||
      (duration >= 0 && !Number.isSafeInteger(ts + duration))) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID_IDENTITY');
  }
  return {status: 'resolved', purpose: 'input_scope_not_verified_evidence', selector,
    selectionContext: {kind: 'track_event', source: 'track_event_selection', eventId, ts,
      ...(duration >= 0 ? {dur: duration} : {})},
    identity: {traceId: input.traceId, table: 'slice', eventId, ts, trackId, utid, upid}};
}

interface AgentSseFactVerification {
  matched: boolean;
  proposition: 'proved' | 'unknown';
  matchedClaimIds: string[];
  matchedAnchorIds: string[];
}

/** A returned trace ID is not a successful processor readiness probe. */
export function assertVerificationTraceReady(traceId: string, trace: Pick<TraceInfo, 'status' | 'error'> | undefined): void {
  if (trace?.status !== 'ready') {
    throw new Error(`Trace ${traceId} is not ready (${trace?.status ?? 'missing'}): ${trace?.error ?? 'processor readiness was not established'}`);
  }
}

/** Admit the entire pair before oracle queries, metadata publication or analysis. */
export async function loadVerificationTracePair(input: {
  service: Pick<ReturnType<typeof getTraceProcessorService>, 'loadTraceFromFilePath' | 'getTrace'>;
  tracePath: string;
  referenceTracePath?: string;
  onLoaded?: (traceId: string, side: 'current' | 'reference') => void;
}): Promise<{traceId: string; referenceTraceId?: string}> {
  const load = async (filePath: string, side: 'current' | 'reference') => {
    const id = await input.service.loadTraceFromFilePath(filePath);
    // Ownership is reported before admission so a rejected pair is still cleaned up.
    input.onLoaded?.(id, side);
    assertVerificationTraceReady(id, input.service.getTrace(id));
    return id;
  };
  const traceId = await load(input.tracePath, 'current');
  const referenceTraceId = input.referenceTracePath ? await load(input.referenceTracePath, 'reference') : undefined;
  return {traceId, ...(referenceTraceId ? {referenceTraceId} : {})};
}

export function taskAcceptanceStatus(observedChecksPassed: boolean, uncoveredFacets: readonly string[]): {
  observedChecksPassed: boolean; semanticAcceptance: 'PASSED' | 'FAILED' | 'INCONCLUSIVE'; completeAcceptance: boolean;
} {
  return {observedChecksPassed,
    semanticAcceptance: !observedChecksPassed ? 'FAILED' : uncoveredFacets.length ? 'INCONCLUSIVE' : 'PASSED',
    completeAcceptance: observedChecksPassed && uncoveredFacets.length === 0};
}

/** Closed configuration schema: misspelled expectations must not silently disappear. */
export function parseAgentSseExpectation(value: unknown): AgentSseExpectation {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s.trim());
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v);
  const fail = (): never => {throw new Error('Invalid --expectation-json: expected agent SSE expectation schemaVersion 1');};
  if (!object(value) || !keys(value, ['schemaVersion', 'intent', 'facts', 'investigation', 'uncoveredFacets']) || value.schemaVersion !== 1 ||
      !object(value.intent) || !keys(value.intent, ['sceneId', 'taskKind', 'scope', 'deliverable', 'evidenceAccess']) ||
      !Object.keys(value.intent).length || !Array.isArray(value.facts) || !value.facts.length ||
      (value.uncoveredFacets !== undefined && !strings(value.uncoveredFacets))) return fail();
  const intentValues: Record<string, string[]> = {taskKind: ['acknowledgement', 'fact', 'investigation', 'comparison'],
    scope: ['bounded_question', 'scene_wide'], deliverable: ['answer', 'report'], evidenceAccess: ['existing_only', 'read_new']};
  for (const [key, item] of Object.entries(value.intent)) {
    if (typeof item !== 'string' || !item.trim() || (intentValues[key] && !intentValues[key].includes(item))) return fail();
  }
  const ids = new Set<string>();
  for (const fact of value.facts) {
    if (!object(fact) || !keys(fact, ['id', 'kind', 'columns', 'verification', 'population', 'value', 'unit', 'oracle']) ||
        typeof fact.id !== 'string' || !fact.id.trim() || ids.has(fact.id) || !strings(fact.columns) ||
        !['numeric', 'categorical', 'identity'].includes(String(fact.kind)) ||
        !['proved', 'reference_only'].includes(String(fact.verification)) ||
        (fact.population !== undefined && !['cited_rows', 'selected_interval', 'process_instance', 'trace', 'codebase'].includes(String(fact.population))) ||
        (fact.value !== undefined && !scalar(fact.value)) || (fact.unit !== undefined && (typeof fact.unit !== 'string' || !fact.unit.trim())) ||
        (fact.value === undefined && fact.oracle === undefined)) return fail();
    ids.add(fact.id);
    if (fact.oracle !== undefined) {
      const oracle = fact.oracle;
      if (!object(oracle) || !keys(oracle, ['sql', 'column', 'unit', 'traceSide', 'anchorMatch']) ||
          typeof oracle.sql !== 'string' || !oracle.sql.trim() || typeof oracle.column !== 'string' || !oracle.column.trim() ||
          (oracle.traceSide !== undefined && !['current', 'reference'].includes(String(oracle.traceSide))) ||
          (oracle.unit !== undefined && (typeof oracle.unit !== 'string' || !oracle.unit.trim())) ||
          (oracle.anchorMatch !== undefined && (!object(oracle.anchorMatch) || !keys(oracle.anchorMatch, ['startTs', 'upid', 'nativeRow']) ||
            [oracle.anchorMatch.startTs, oracle.anchorMatch.upid].some(v => v !== undefined && (typeof v !== 'string' || !v.trim()))))) return fail();
      const nativeRow = object(oracle.anchorMatch) ? oracle.anchorMatch.nativeRow : undefined;
      if (nativeRow !== undefined && (!object(nativeRow) || !keys(nativeRow, ['relation', 'idColumn', 'oracleColumn']) ||
          !['relation', 'idColumn', 'oracleColumn'].every(key => typeof nativeRow[key] === 'string' &&
            /^[a-zA-Z_][a-zA-Z0-9_.]{0,159}$/.test(nativeRow[key] as string)))) return fail();
      // The harness accepts SELECTs and module imports, never a mutation script.
      const query = oracle.sql.replace(/^(?:\s*INCLUDE\s+PERFETTO\s+MODULE\s+[\w.]+\s*;)*/i, '').replace(/;\s*$/, '');
      if (!/^\s*(SELECT|WITH)\b/i.test(query) || query.includes(';') ||
          /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REPLACE)\b/i.test(oracle.sql)) return fail();
    }
  }
  if (value.investigation !== undefined) {
    const investigation = value.investigation;
    const assurance = ['not_applicable', 'not_checked', 'unavailable', 'coverage_incomplete', 'passed', 'failed'];
    if (!object(investigation) || !keys(investigation, ['contentAssurance', 'evidenceAssurance', 'assessmentStatus', 'requirements']) ||
      !assurance.includes(String(investigation.contentAssurance)) || !assurance.includes(String(investigation.evidenceAssurance)) ||
      !['not_checked', 'unavailable', 'coverage_incomplete', 'checked'].includes(String(investigation.assessmentStatus)) ||
      !Array.isArray(investigation.requirements) || !investigation.requirements.length) return fail();
    const requirementIds = new Set<string>();
    const ns = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20;
    for (const row of investigation.requirements) {
      if (!object(row) || !keys(row, ['id', 'domain', 'applicability', 'coverage', 'acquisition', 'scopeMatch', 'records']) ||
        typeof row.id !== 'string' || !row.id.trim() || requirementIds.has(row.id) || typeof row.domain !== 'string' || !row.domain.trim() ||
        !['applicable', 'not_applicable', 'unknown'].includes(String(row.applicability)) ||
        !['covered', 'missing', 'unknown'].includes(String(row.coverage)) ||
        !['observed', 'insufficient', 'not_checked', 'failed', 'not_applicable', 'unknown'].includes(String(row.acquisition)) ||
        !['matched', 'mismatched', 'unknown'].includes(String(row.scopeMatch)) ||
        (row.records !== undefined && (!Array.isArray(row.records) || !row.records.length))) return fail();
      requirementIds.add(row.id);
      for (const record of (row.records ?? []) as unknown[]) {
        if (!object(record) || !keys(record, ['metricId', 'traceSide', 'origin', 'upid', 'utid', 'window', 'oracleScope']) ||
          typeof record.metricId !== 'string' || !record.metricId.trim() || !['current', 'reference'].includes(String(record.traceSide)) ||
          (record.origin !== undefined && !['current_run', 'reused', 'unknown'].includes(String(record.origin))) ||
          [record.upid, record.utid].some(id => id !== undefined && (!Number.isSafeInteger(id) || (id as number) < 0))) return fail();
        if (record.window !== undefined && (!object(record.window) || !keys(record.window, ['start', 'end']) ||
          !ns(record.window.start) || !ns(record.window.end) || BigInt(record.window.end) <= BigInt(record.window.start))) return fail();
        if (record.oracleScope !== undefined) {
          const scope = record.oracleScope;
          if (!object(scope) || !keys(scope, ['factId', 'startColumn', 'endColumn', 'upidColumn', 'utidColumn']) ||
            !['factId', 'startColumn', 'endColumn'].every(key => typeof scope[key] === 'string' && (scope[key] as string).trim()) ||
            [scope.upidColumn, scope.utidColumn].some(column => column !== undefined && (typeof column !== 'string' || !column.trim())) ||
            !value.facts.some(fact => object(fact) && fact.id === scope.factId && object(fact.oracle) &&
              (fact.oracle.traceSide ?? 'current') === record.traceSide)) return fail();
        }
      }
    }
  }
  return structuredClone(value) as unknown as AgentSseExpectation;
}

/** Only declared units are converted; column names never imply a unit. */
function factValueEquals(actual: unknown, actualUnit: string | undefined, expected: unknown, expectedUnit: string | undefined): boolean {
  const numeric = (value: unknown): number | undefined => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
      ? Number(value) : undefined;
    return number !== undefined && Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
  };
  if (actualUnit === expectedUnit && actual === expected) return true;
  const left = numeric(actual), right = numeric(expected);
  if (left === undefined || right === undefined || !actualUnit || !expectedUnit) return false;
  if (actualUnit === expectedUnit) return left === right;
  const timeScale: Record<string, number> = {ns: 1, us: 1_000, ms: 1_000_000, s: 1_000_000_000};
  if (['frame', 'frames'].includes(actualUnit) && ['frame', 'frames'].includes(expectedUnit)) return left === right;
  return Boolean(actualUnit && expectedUnit && timeScale[actualUnit] && timeScale[expectedUnit] &&
    left * timeScale[actualUnit] === right * timeScale[expectedUnit]);
}

/** Assert server-issued investigation projection bindings; prose and tool counts are not proof. */
export function evaluateAgentSseInvestigationExpectation(input: {
  terminal?: TerminalAnalysisEvidence;
  expectation: AgentSseInvestigationExpectation;
  traceId: string;
  referenceTraceId?: string;
  oracleRows?: AgentSseOracleRows;
}): Record<string, boolean> {
  const {terminal, expectation, traceId, referenceTraceId} = input;
  const assessment = terminal?.investigationAssessment;
  const binding = assessment?.binding;
  const completion = terminal?.completion;
  const body = terminal?.conclusion ?? '';
  const records = assessment?.evidenceRecords ?? [];
  const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const ns = (value: unknown): bigint | undefined => {
    const text = String(value);
    return /^(0|[1-9][0-9]*)$/.test(text) && text.length <= 20 &&
      (typeof value !== 'number' || Number.isSafeInteger(value)) ? BigInt(text) : undefined;
  };
  const checks: Record<string, boolean> = {
    'investigation:contentAssurance': terminal?.deliveryAssurance?.investigation === expectation.contentAssurance,
    'investigation:evidenceAssurance': terminal?.deliveryAssurance?.investigationEvidence === expectation.evidenceAssurance,
    'investigation:assessmentStatus': assessment?.schemaVersion === 1 && assessment.status === expectation.assessmentStatus,
    'investigation:candidateBinding': Boolean(binding && completion && nonempty(binding.candidateRef) && nonempty(binding.runId) &&
      nonempty(binding.attemptId) && nonempty(binding.registryFingerprint) && binding.candidateRef === completion.candidateRef &&
      binding.runId === completion.runId && binding.attemptId === completion.attemptId &&
      binding.conclusionFingerprint === analysisDeliveryFingerprint(body) &&
      binding.conclusionContractFingerprint === analysisDeliveryFingerprint(terminal?.conclusionContract) &&
      binding.registryFingerprint === terminal?.turnIntent?.registryFingerprint &&
      binding.intentFingerprint === analysisDeliveryFingerprint(terminal?.turnIntent) &&
      nonempty(binding.requirementsFingerprint) && nonempty(binding.evidenceFingerprint) && nonempty(binding.ledgerFingerprint)),
    'investigation:uniqueRequirements': Boolean(assessment && new Set(assessment.requirements.map(row => row.requirementId)).size === assessment.requirements.length),
    'investigation:uniqueRecords': new Set(records.map(record => record.recordId)).size === records.length,
    'investigation:recordsBinding': !expectation.requirements.some(row => row.records?.length) ||
      Boolean(binding?.evidenceRecordsFingerprint && binding.evidenceRecordsFingerprint === analysisDeliveryFingerprint(records)),
  };
  for (const expected of expectation.requirements) {
    const rows = assessment?.requirements.filter(row => row.requirementId === expected.id) ?? [];
    const row = rows.length === 1 ? rows[0] : undefined;
    checks[`investigation:requirement:${expected.id}`] = Boolean(row && row.domain === expected.domain &&
      row.applicability === expected.applicability && row.coverage === expected.coverage &&
      row.acquisition === expected.acquisition && row.evidenceStatus === expected.acquisition && row.scopeMatch === expected.scopeMatch &&
      (row.coverage !== 'covered' || (row.contentLocations.length > 0 && row.contentLocations.every(location =>
        Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) && location.start >= 0 &&
        location.end > location.start && location.end <= body.length))) &&
      new Set(row.evidenceRecordIds).size === row.evidenceRecordIds.length);
    for (const [index, desired] of (expected.records ?? []).entries()) {
      checks[`investigation:record:${expected.id}:${index}`] = Boolean(row?.evidenceRecordIds.some(recordId => {
        const candidates = records.filter(record => record.recordId === recordId);
        const record = candidates.length === 1 ? candidates[0] : undefined;
        if (!record || record.domain !== expected.domain || record.metricId !== desired.metricId ||
          record.traceSide !== desired.traceSide || record.traceId !== (desired.traceSide === 'current' ? traceId : referenceTraceId) ||
          !nonempty(record.traceId) || !nonempty(record.captureId) || !nonempty(record.recordId) || !record.window ||
          !Number.isSafeInteger(record.rowIndex) || record.rowIndex < 0 ||
          !record.recordId.startsWith(`${record.captureId}:${record.rowIndex}:`) ||
          !nonempty(record.definitionFingerprint) || !nonempty(record.selectedSqlHash) || !nonempty(record.skillId) || !nonempty(record.stepId) ||
          (desired.origin !== undefined && record.origin !== desired.origin) ||
          (record.origin === 'current_run' && record.originRunId !== completion?.runId) ||
          (desired.upid !== undefined && record.upid !== desired.upid) || (desired.utid !== undefined && record.utid !== desired.utid) ||
          (expected.acquisition === 'observed' && record.status !== 'observed')) return false;
        const start = ns(record.window.start), end = ns(record.window.end);
        if (start === undefined || end === undefined || end <= start) return false;
        if (desired.window && (start !== ns(desired.window.start) || end !== ns(desired.window.end))) return false;
        const scope = desired.oracleScope;
        if (!scope) return true;
        return (input.oracleRows?.[scope.factId] ?? []).some(oracle =>
          start === ns(oracle[scope.startColumn]) && end === ns(oracle[scope.endColumn]) &&
          (!scope.upidColumn || record.upid === oracle[scope.upidColumn]) &&
          (!scope.utidColumn || record.utid === oracle[scope.utidColumn]));
      }));
    }
  }
  return checks;
}

/** Transport projections do not reissue capture witnesses. v2 proves the retained raw cells. */
export function evaluateAgentSseExpectation(input: {
  terminal?: TerminalAnalysisEvidence; expectation: AgentSseExpectation; traceId: string; oracleRows?: AgentSseOracleRows;
  oracleNativeSchemas?: AgentSseOracleNativeSchemas;
  referenceTraceId?: string;
}): {checks: Record<string, boolean>; facts: Record<string, AgentSseFactVerification>; uncoveredFacets: string[]} {
  const {terminal, expectation, traceId} = input;
  const claims = terminal?.conclusionContract?.claims ?? [];
  const verifier = terminal?.claimVerificationResult;
  const assurance = terminal?.deliveryAssurance;
  const completion = terminal?.completion;
  const checks: Record<string, boolean> = {
    taskCompleted: terminal?.success === true && completion?.status === 'completed' &&
      completion.conclusionFingerprint === analysisDeliveryFingerprint(terminal?.conclusion ?? '') &&
      Boolean(completion.runId && completion.attemptId && completion.candidateRef),
    deliveryCompletionPassed: assurance?.entry === 'new_finalization' && assurance.completion === 'passed',
    deliveryClaimsPassed: assurance?.claims === 'passed',
    deliveryIdentityPassed: assurance?.identity === 'passed' || assurance?.identity === 'not_applicable',
    deliverySourcePassed: assurance?.source === 'passed' || assurance?.source === 'not_applicable',
    deliveryReportPassed: expectation.intent.deliverable === 'report'
      ? assurance?.report === 'passed' : assurance?.report === 'passed' || assurance?.report === 'not_applicable',
    intentResolved: terminal?.turnIntent?.status === 'resolved',
    originalClaimsVerified: verifier?.schemaVersion === 'claim_verifier@2' && verifier.passed === true &&
      verifier.status === 'passed' && verifier.unsupportedClaimCount === 0 && claims.length > 0 &&
      verifier.claimResults.length === claims.length && new Set(claims.map(claim => claim.id)).size === claims.length &&
      claims.every(claim => Boolean(claim.id) && verifier.claimResults.filter(result => result.claimId === claim.id &&
        (result.status === 'verified' || result.status === 'inference')).length === 1),
  };
  for (const [key, value] of Object.entries(expectation.intent)) checks[`intent:${key}`] = terminal?.turnIntent?.[key as keyof AnalysisTurnIntent] === value;
  if (expectation.investigation) Object.assign(checks, evaluateAgentSseInvestigationExpectation({
    ...input, expectation: expectation.investigation,
  }));
  const facts: Record<string, AgentSseFactVerification> = Object.create(null);
  for (const fact of expectation.facts) {
    const traceSide = fact.oracle?.traceSide ?? 'current';
    const factTraceId = traceSide === 'reference' ? input.referenceTraceId : traceId;
    const matchedAnchorIds = new Set<string>();
    const matchedClaims = claims.filter(claim => {
      const semantics = claim.semantics;
      if (claim.kind !== fact.kind || !semantics || semantics.polarity !== 'affirmed' || semantics.discourse !== 'asserted' ||
          semantics.modality !== 'certain' || (fact.population && semantics.scope.population !== fact.population)) return false;
      const proof = verifier?.claimResults.find(result => result.claimId === claim.id);
      const support = terminal?.claimSupport?.filter(item => item.claimId === claim.id);
      if (support?.length !== 1 || support[0].text !== claim.text || support[0].kind !== claim.kind ||
          !isDeepStrictEqual(support[0].semantics, semantics)) return false;
      if (fact.verification === 'proved' && (proof?.status !== 'verified' || proof.deterministicProof?.status !== 'proved' ||
          proof.deterministicProof.kind !== 'numeric_cell' ||
          proof.propositionCoverage?.status !== 'complete' || proof.propositionCoverage.uncovered.length > 0)) return false;
      return support[0].anchors.some(anchor => {
        if (anchor.missing || !factTraceId || anchor.context.traceId !== factTraceId || anchor.context.traceSide !== traceSide) return false;
        if (fact.verification === 'proved' && (!proof?.deterministicProof?.anchorIds.includes(anchor.anchorId) ||
            !proof.deterministicProof.evidenceRefIds.includes(anchor.evidenceRefId))) return false;
        return anchor.cells?.some(cell => {
          if (!fact.columns.includes(cell.column) || cell.actualValue === undefined || cell.actualValue === null ||
              (cell.value !== undefined && cell.value !== cell.actualValue)) return false;
          const originalRefs = fact.kind === 'numeric' ? semantics.scope.subjectRefs ?? [] : claim.references;
          if (!originalRefs.some(ref => {
            const identifiers = [[ref.evidenceRefId, anchor.evidenceRefId], [ref.artifactId, anchor.context.artifactId],
              [ref.sourceArtifactId, anchor.context.artifactId], [ref.sourceToolCallId, anchor.context.sourceToolCallId],
              [ref.sourceRef, cell.sourceRef]].filter(([id]) => id !== undefined);
            return ref.column === cell.column && identifiers.length > 0 && identifiers.every(([id, actual]) => id === actual) &&
              (ref.rowIndex === undefined || ref.rowIndex === cell.rowIndex) &&
              (ref.rowSelector === undefined || isDeepStrictEqual(ref.rowSelector, cell.rowSelector)) &&
              (ref.value === undefined || ref.value === cell.actualValue);
          })) return false;
          if (!proof?.referenceCells?.some(ref => ref.anchorId === anchor.anchorId && ref.column === cell.column && ref.status === 'matched')) return false;
          if (fact.kind === 'numeric' && (semantics.predicate !== 'numeric.cell' || semantics.numeric?.operator !== 'eq')) return false;
          const values = fact.oracle ? input.oracleRows?.[fact.id] ?? [] : [{value: fact.value}];
          return values.some(row => {
            const expected = fact.oracle ? row[fact.oracle.column] : row.value;
            const unit = fact.oracle?.unit ?? fact.unit;
            if (fact.value !== undefined && !factValueEquals(expected, unit, fact.value, fact.unit)) return false;
            const nativeMatch = nativeOracleAnchorMatches({fact, proof, anchor, oracleRow: row,
              schema: input.oracleNativeSchemas?.[fact.id], traceId: factTraceId});
            if (nativeMatch === false) return false;
            const match = fact.oracle?.anchorMatch;
            if (nativeMatch === true) {
              if (match?.startTs && anchor.timeRange?.startTs !== undefined && String(anchor.timeRange.startTs) !== String(row[match.startTs])) return false;
              if (match?.upid && anchor.identity?.upid !== undefined && anchor.identity.upid !== row[match.upid]) return false;
            } else {
              if (match?.nativeRow && (!match.startTs || !match.upid)) return false;
              if (match?.startTs && String(anchor.timeRange?.startTs) !== String(row[match.startTs])) return false;
              if (match?.upid && anchor.identity?.upid !== row[match.upid]) return false;
            }
            const matches = fact.kind === 'numeric'
              ? factValueEquals(semantics.numeric?.value, semantics.numeric?.unit, expected, unit) &&
                factValueEquals(cell.actualValue, cell.unit ?? fact.unit, expected, unit)
              : cell.actualValue === expected;
            if (matches) matchedAnchorIds.add(anchor.anchorId);
            return matches;
          });
        });
      });
    });
    const matches = matchedClaims.length > 0;
    facts[fact.id] = {matched: matches, proposition: matches && fact.verification === 'proved' ? 'proved' : 'unknown',
      matchedClaimIds: matchedClaims.flatMap(claim => typeof claim.id === 'string' ? [claim.id] : []),
      matchedAnchorIds: [...matchedAnchorIds]};
    checks[`fact:${fact.id}`] = matches;
  }
  return {checks, facts, uncoveredFacets: [...(expectation.uncoveredFacets ?? []),
    ...expectation.facts.filter(fact => fact.verification === 'reference_only').map(fact => `${fact.id}: proposition proof unavailable`)]};
}

export async function collectAgentSseOracleRows(expectation: AgentSseExpectation, query: (sql: string, traceSide: 'current' | 'reference') => Promise<{
  columns: string[]; rows: unknown[][]; error?: string;
}>): Promise<AgentSseOracleRows> {
  const out: AgentSseOracleRows = Object.create(null);
  const queried = new Map<string, Awaited<ReturnType<typeof query>>>();
  for (const fact of expectation.facts) {
    if (!fact.oracle) continue;
    const traceSide = fact.oracle.traceSide ?? 'current';
    const queryKey = `${traceSide}:${fact.oracle.sql}`;
    let result = queried.get(queryKey);
    if (!result) {result = await query(fact.oracle.sql, traceSide); queried.set(queryKey, result);}
    if (result.error || !result.columns.includes(fact.oracle.column) || !result.rows.length || result.rows.length > 100_000) {
      throw new Error(`Task fact oracle unavailable: ${fact.id}`);
    }
    const nativeRow = fact.oracle.anchorMatch?.nativeRow;
    if (nativeRow) {
      const idIndex = result.columns.indexOf(nativeRow.oracleColumn);
      if (idIndex < 0 || result.columns.lastIndexOf(nativeRow.oracleColumn) !== idIndex ||
          result.rows.some(row => !Number.isSafeInteger(row[idIndex]) || Number(row[idIndex]) < 0)) {
        throw new Error(`Task fact oracle unavailable: ${fact.id}`);
      }
    }
    out[fact.id] = result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
  }
  return out;
}

export function buildFollowUpVerificationChecks(
  followUpSse: SseSummary,
  options: Pick<
    VerifyOptions,
    | 'followUpAnalysisMode'
    | 'followUpRequiredText'
    | 'followUpForbiddenTools'
    | 'requireNonPartial'
    | 'requireClaimVerifierOk'
    | 'forbiddenDegradedFallbacks'
  >,
): Record<string, boolean> {
  const followUpIsQuickMode = followUpSse.planSubmittedCount === 0;
  const requiredTextChecks = Object.fromEntries(
    options.followUpRequiredText.map(text => [
      `followUpRequiresText:${text}`,
      followUpSse.requiredTextMatches[text] === true,
    ]),
  );
  const forbiddenToolChecks = Object.fromEntries(
    options.followUpForbiddenTools.map(toolName => [
      `followUpForbidsTool:${toolName}`,
      (followUpSse.toolCallCounts[toolName] ?? 0) === 0,
    ]),
  );
  const degradedFallbackChecks = Object.fromEntries(
    options.forbiddenDegradedFallbacks.map(fallback => [
      `followUpForbidsDegradedFallback:${fallback}`,
      (followUpSse.degradedFallbackCounts[fallback] ?? 0) === 0,
    ]),
  );
  const partialChecks: Record<string, boolean> = options.requireNonPartial
    ? {followUpAnalysisCompletedNotPartial: followUpSse.analysisCompletedPartial !== true}
    : {};
  const claimVerifierChecks: Record<string, boolean> = options.requireClaimVerifierOk
    ? {
      followUpHasClaimVerifierResult: Boolean(followUpSse.claimVerifierStatus),
      followUpClaimVerifierPassed:
        followUpSse.claimVerifierStatus === 'passed' &&
        followUpSse.claimVerifierPassed !== false,
      followUpClaimVerifierHasNoUnsupportedClaims:
        (followUpSse.claimVerifierUnsupportedClaimCount ?? 0) === 0,
    }
    : {};

  return {
    hasFollowUpProgressEvents: followUpSse.progressCount > 0,
    hasFollowUpTerminalConclusionPayload:
      followUpSse.conclusionCount > 0 ||
      followUpSse.analysisCompletedConclusionChars > 0,
    hasFollowUpAnalysisCompletedEvent:
      followUpSse.terminalEvent === 'analysis_completed' ||
      followUpSse.terminalEvent === 'end',
    hasFollowUpNoSseErrors: followUpSse.errorEvents.length === 0,
    ...(options.followUpAnalysisMode === 'fast'
      ? {followUpFastModeHonored: followUpIsQuickMode}
      : {}),
    ...requiredTextChecks,
    ...forbiddenToolChecks,
    ...degradedFallbackChecks,
    ...partialChecks,
    ...claimVerifierChecks,
  };
}

const DEFAULT_TRACE = '../Trace/real/android-scroll-customer/trace.pftrace';
const DEFAULT_QUERY = '分析滑动性能';

function printUsage(): void {
  console.log('Usage: npx tsx src/scripts/verifyAgentSseScrolling.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --entry <analyze|scene-reconstruction> Dedicated product route; analyze is the default');
  console.log('  --scene-oracle-json <json|@file> Authored independent exact trace interval/object oracles');
  console.log('  --scene-scenario <complete|partial|cancel> Scene lifecycle case; default complete');
  console.log('  --scene-min-revision <integer>    Explicit correction case only; default 1');
  console.log('  --scene-observation-ms <integer>  Post-terminal late/replay observation, 1..30000 ms; default 2000');
  console.log('  --trace <path>                    Trace path (default: ../Trace/real/android-scroll-customer/trace.pftrace)');
  console.log('  --reference-trace <path>          Reference trace path for raw dual-trace comparison');
  console.log('  --query <text>                    Analyze query (default: 分析滑动性能)');
  console.log('  --expectation-json <json|@file>   Closed v1 task intent/facts with independent trace oracles');
  console.log('  --timeout-ms <number>             SSE timeout in ms (default: 600000)');
  console.log('  --mode <fast|full|auto|smart>     Override analysisMode, or use smart as shorthand for --preset smart');
  console.log('  --preset <smart>                  Forward preset to the backend');
  console.log('  --trace-context-json <json|@file> Forward frontend-style traceContext datasets');
  console.log('  --selection-context-json <json|@file>');
  console.log('                                      Forward frontend-style selectionContext');
  console.log('  --select-slice-json <json|@file>    Resolve exactly one slice by processName, threadName, eventName; mutually exclusive with --selection-context-json');
  console.log('  --smart-action <preview|analyze>  Smart action (default: analyze for --mode/--preset smart)');
  console.log('  --smart-scope <all|scene_types|scene_ids>');
  console.log('                                      Smart selection scope (default: all for analyze)');
  console.log('  --smart-scene-type <type>          Smart scene type selection; repeatable');
  console.log('  --smart-scene-id <id>              Smart scene id selection; repeatable');
  console.log('  --force-refresh                   Bypass cached scene reports when supported');
  console.log('  --code-aware <off|metadata_only|provider_send>');
  console.log('                                      Forward codeAwareMode to the backend');
  console.log('  --codebase-id <id>                 Registered codebase id to expose; repeatable');
  console.log('  --knowledge-source-id <id>         Registered private knowledge source id; repeatable');
  console.log('  --setup-codebase-root <path>       Register and index an app-source root before analysis');
  console.log('  --setup-codebase-mode <register-only|register-and-index>');
  console.log('                                      Select setup behavior (default: register-and-index)');
  console.log('  --setup-knowledge-root <path>      Register and index an Android Internals Wiki root before analysis');
  console.log('  --provider-id <id|env|null>        Provider id, or env/null to ignore active providers');
  console.log('  --require-code-ref                 Require source-level code refs in conclusion/analysis_completed text');
  console.log('  --require-claim-verifier-ok        Require analysis_completed claim verifier to pass with no unsupported claims');
  console.log('  --require-non-partial              Fail if analysis_completed is marked partial');
  console.log('  --require-final-report-heading     Require a final-report heading in analysis_completed text');
  console.log('  --forbid-process-narration         Fail if final text contains process narration like entering phases');
  console.log('  --max-analysis-completed-conclusion-chars <number>');
  console.log('                                      Fail if analysis_completed conclusion text exceeds this length');
  console.log('  --require-text <text>              Exact transport/canary diagnostic only; not semantic correctness');
  console.log('  --forbid-text <text>               Exact transport/canary diagnostic only; not semantic correctness');
  console.log('  --follow-up-query <text>           Run a second turn against the same session');
  console.log('  --follow-up-mode <fast|full|auto>  Follow-up mode (default: auto)');
  console.log('  --follow-up-require-text <text>    Exact follow-up transport diagnostic only; repeatable');
  console.log('  --follow-up-forbid-tool <name>     Fail if follow-up dispatches this tool; repeatable');
  console.log('  --forbid-degraded-fallback <name>  Fail if a degraded event with this fallback is emitted; repeatable');
  console.log('  --require-tool <name>              Require an agent_task_dispatched tool call; repeatable');
  console.log('  --require-successful-lookup <name> Require a successful provenance-bearing private lookup; repeatable');
  console.log('  --require-skill <skillId>          Require an invoke_skill call for a specific skillId; repeatable');
  console.log('  --trace-pair-layout <horizontal|vertical>');
  console.log('                                      Dual-trace visual layout metadata (default: horizontal)');
  console.log('  --trace-pair-workspace-open        Mark both trace panes as visible in the same-page workspace');
  console.log('  --trace-pair-split <number>        Primary pane split percent, clamped to 18..82 (default: 50)');
  console.log('  --trace-pair-active <current|reference>');
  console.log('                                      Active/focused trace pane (default: current)');
  console.log('  --trace-pair-maximized <current|reference>');
  console.log('                                      Mark one trace pane as maximized in tracePairContext');
  console.log('  --trace-pair-minimized <current|reference>');
  console.log('                                      Mark a trace pane as minimized; repeatable');
  console.log('  --require-data-envelope            Require at least one SSE data envelope, including in fast mode');
  console.log('  --require-quick-run                Require analysis_completed.quickRun receipt metadata');
  console.log('  --allow-no-data-envelopes          Do not require data envelopes in full mode');
  console.log('  --allow-capability-limited-runtime Do not require plan/tool/data events for preview runtime smoke tests');
  console.log('  --require-external-issue-triage    Require source-run-pinned M10 opportunity and live Agent review');
  console.log('  --output <path>                   JSON report output path');
  console.log('  --require-conclusion-evidence     Fail unless analysis_completed conclusion has concrete evidence refs');
  console.log('  --keep-session                    Do not delete session after verification');
  console.log('  --keep-trace                      Do not delete loaded trace after verification');
  console.log('  --help                            Show this help');
}

function parseTraceContextArg(value: string): TraceDataset[] {
  const raw = value.startsWith('@')
    ? fs.readFileSync(path.resolve(process.cwd(), value.slice(1)), 'utf8')
    : value;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('--trace-context-json must be a JSON array');
  }
  const datasets = parsed.filter((dataset): dataset is TraceDataset => {
    if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return false;
    const record = dataset as Partial<TraceDataset>;
    return typeof record.label === 'string'
      && Array.isArray(record.columns)
      && record.columns.every((column) => typeof column === 'string')
      && Array.isArray(record.rows)
      && record.rows.every((row) => Array.isArray(row));
  });
  if (datasets.length === 0) {
    throw new Error('--trace-context-json did not contain any valid datasets');
  }
  return datasets;
}

function parseSelectionContextArg(value: string): SelectionContext {
  const raw = value.startsWith('@')
    ? fs.readFileSync(path.resolve(process.cwd(), value.slice(1)), 'utf8')
    : value;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--selection-context-json must be a JSON object');
  }
  return parsed as SelectionContext;
}

function parseSliceSelectionTargetArg(value: string): SliceSelectionTarget {
  try {
    const filePath = value.startsWith('@') ? path.resolve(process.cwd(), value.slice(1)) : undefined;
    if (filePath) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > 8192) throw new Error('selector_file');
    }
    const raw = filePath ? fs.readFileSync(filePath, 'utf8') : value;
    if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('selector_size');
    return parseSliceSelectionTarget(JSON.parse(raw));
  } catch {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID');
  }
}

export function parseArgs(argv: string[]): VerifyOptions {
  const options: VerifyOptions = {
    tracePath: path.resolve(process.cwd(), DEFAULT_TRACE),
    query: DEFAULT_QUERY,
    timeoutMs: 600_000,
    keepSession: false,
    keepTrace: false,
    forceRefresh: false,
    requireConclusionEvidence: false,
    codebaseIds: [],
    knowledgeSourceIds: [],
    requireCodeRef: false,
    requireClaimVerifierOk: false,
    requireNonPartial: false,
    requireFinalReportHeading: false,
    forbidProcessNarration: false,
    requiredText: [],
    forbiddenText: [],
    followUpRequiredText: [],
    followUpAnalysisMode: 'auto',
    followUpForbiddenTools: [],
    forbiddenDegradedFallbacks: [],
    allowNoDataEnvelopes: false,
    requireDataEnvelope: false,
    requireQuickRun: false,
    allowCapabilityLimitedRuntime: false,
    requireExternalIssueTriage: false,
    requiredTools: [],
    requiredSuccessfulLookups: [],
    requiredSkills: [],
    tracePairLayout: 'horizontal',
    tracePairWorkspaceOpen: false,
    tracePairSplitPercent: 50,
    tracePairActiveTraceSide: 'current',
    tracePairMinimizedTraceSides: [],
  };
  let smartScope: 'all' | 'scene_types' | 'scene_ids' | undefined;
  const smartSceneTypes: string[] = [];
  const smartSceneIds: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--scene-oracle-json') {
      if (!next) throw new Error('--scene-oracle-json requires a value');
      options.sceneOracles = parseSceneOracleSpecs(JSON.parse(next.startsWith('@') ? fs.readFileSync(path.resolve(process.cwd(), next.slice(1)), 'utf8') : next));
      i += 1; continue;
    }
    if (arg === '--entry') {
      if (next !== 'analyze' && next !== 'scene-reconstruction') throw new Error('--entry requires analyze or scene-reconstruction');
      options.entry = next; i += 1; continue;
    }
    if (arg === '--scene-scenario') {
      if (next !== 'complete' && next !== 'partial' && next !== 'cancel') throw new Error('--scene-scenario requires complete, partial or cancel');
      options.sceneScenario = next; i += 1; continue;
    }
    if (arg === '--scene-min-revision' || arg === '--scene-observation-ms') {
      const value = Number(next);
      if (!next || !Number.isSafeInteger(value) || value < 1 || value > (arg === '--scene-min-revision' ? 64 : 30000)) throw new Error(`${arg} out of range`);
      if (arg === '--scene-min-revision') options.sceneMinRevision = value;
      else options.sceneObservationMs = value;
      i += 1; continue;
    }

    if (arg === '--expectation-json') {
      if (!next) throw new Error('--expectation-json requires a value');
      options.expectation = parseAgentSseExpectation(JSON.parse(next.startsWith('@')
        ? fs.readFileSync(path.resolve(process.cwd(), next.slice(1)), 'utf8') : next));
      i += 1;
      continue;
    }

    if (arg === '--help') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--keep-session') {
      options.keepSession = true;
      continue;
    }

    if (arg === '--keep-trace') {
      options.keepTrace = true;
      continue;
    }

    if (arg === '--force-refresh') {
      options.forceRefresh = true;
      continue;
    }

    if (arg === '--require-conclusion-evidence') {
      options.requireConclusionEvidence = true;
      continue;
    }

    if (arg === '--require-code-ref') {
      options.requireCodeRef = true;
      continue;
    }

    if (arg === '--require-claim-verifier-ok') {
      options.requireClaimVerifierOk = true;
      continue;
    }

    if (arg === '--require-non-partial') {
      options.requireNonPartial = true;
      continue;
    }

    if (arg === '--require-final-report-heading') {
      options.requireFinalReportHeading = true;
      continue;
    }

    if (arg === '--forbid-process-narration') {
      options.forbidProcessNarration = true;
      continue;
    }

    if (arg === '--allow-no-data-envelopes') {
      options.allowNoDataEnvelopes = true;
      continue;
    }

    if (arg === '--require-data-envelope') {
      options.requireDataEnvelope = true;
      continue;
    }

    if (arg === '--require-quick-run') {
      options.requireQuickRun = true;
      continue;
    }

    if (arg === '--allow-capability-limited-runtime') {
      options.allowCapabilityLimitedRuntime = true;
      options.allowNoDataEnvelopes = true;
      continue;
    }

    if (arg === '--require-external-issue-triage') {
      options.requireExternalIssueTriage = true;
      continue;
    }

    if (arg === '--trace') {
      if (!next) {
        throw new Error('--trace requires a value');
      }
      options.tracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--reference-trace') {
      if (!next) {
        throw new Error('--reference-trace requires a value');
      }
      options.referenceTracePath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--query') {
      if (!next) {
        throw new Error('--query requires a value');
      }
      options.query = next;
      i += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      if (!next) {
        throw new Error('--timeout-ms requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${next}`);
      }
      options.timeoutMs = parsed;
      i += 1;
      continue;
    }

    if (arg === '--max-analysis-completed-conclusion-chars') {
      if (!next) {
        throw new Error('--max-analysis-completed-conclusion-chars requires a value');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-analysis-completed-conclusion-chars value: ${next}`);
      }
      options.maxAnalysisCompletedConclusionChars = parsed;
      i += 1;
      continue;
    }

    if (arg === '--mode') {
      if (!next) {
        throw new Error('--mode requires a value');
      }
      if (next === 'smart') {
        options.preset = 'smart';
        options.smartAction = options.smartAction ?? 'analyze';
        options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
        i += 1;
        continue;
      }
      if (next !== 'fast' && next !== 'full' && next !== 'auto') {
        throw new Error(`Invalid --mode value: ${next} (expected fast|full|auto|smart)`);
      }
      options.analysisMode = next;
      i += 1;
      continue;
    }

    if (arg === '--preset') {
      if (!next) {
        throw new Error('--preset requires a value');
      }
      if (next !== 'smart') {
        throw new Error(`Invalid --preset value: ${next} (expected smart)`);
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      i += 1;
      continue;
    }

    if (arg === '--trace-context-json') {
      if (!next) {
        throw new Error('--trace-context-json requires a value');
      }
      options.traceContext = parseTraceContextArg(next);
      i += 1;
      continue;
    }

    if (arg === '--selection-context-json') {
      if (!next) {
        throw new Error('--selection-context-json requires a value');
      }
      options.selectionContext = parseSelectionContextArg(next);
      i += 1;
      continue;
    }

    if (arg === '--select-slice-json') {
      if (!next || options.sliceSelectionTarget) throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID');
      options.sliceSelectionTarget = parseSliceSelectionTargetArg(next);
      i += 1;
      continue;
    }

    if (arg === '--smart-action') {
      if (!next) {
        throw new Error('--smart-action requires a value');
      }
      if (next !== 'preview' && next !== 'analyze') {
        throw new Error(`Invalid --smart-action value: ${next} (expected preview|analyze)`);
      }
      options.preset = 'smart';
      options.smartAction = next;
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      i += 1;
      continue;
    }

    if (arg === '--smart-scope') {
      if (!next) {
        throw new Error('--smart-scope requires a value');
      }
      if (next !== 'all' && next !== 'scene_types' && next !== 'scene_ids') {
        throw new Error(`Invalid --smart-scope value: ${next} (expected all|scene_types|scene_ids)`);
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartScope = next;
      i += 1;
      continue;
    }

    if (arg === '--smart-scene-type') {
      if (!next) {
        throw new Error('--smart-scene-type requires a value');
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartSceneTypes.push(next);
      smartScope = smartScope ?? 'scene_types';
      i += 1;
      continue;
    }

    if (arg === '--smart-scene-id') {
      if (!next) {
        throw new Error('--smart-scene-id requires a value');
      }
      options.preset = 'smart';
      options.smartAction = options.smartAction ?? 'analyze';
      options.query = options.query === DEFAULT_QUERY ? '/smart' : options.query;
      smartSceneIds.push(next);
      smartScope = smartScope ?? 'scene_ids';
      i += 1;
      continue;
    }

    if (arg === '--code-aware') {
      if (!next) {
        throw new Error('--code-aware requires a value');
      }
      if (next !== 'off' && next !== 'metadata_only' && next !== 'provider_send') {
        throw new Error(`Invalid --code-aware value: ${next} (expected off|metadata_only|provider_send)`);
      }
      options.codeAwareMode = next;
      i += 1;
      continue;
    }

    if (arg === '--codebase-id') {
      if (!next) {
        throw new Error('--codebase-id requires a value');
      }
      options.codebaseIds.push(next);
      i += 1;
      continue;
    }

    if (arg === '--knowledge-source-id') {
      if (!next) {
        throw new Error('--knowledge-source-id requires a value');
      }
      options.knowledgeSourceIds.push(next);
      i += 1;
      continue;
    }

    if (arg === '--setup-codebase-root') {
      if (!next) {
        throw new Error('--setup-codebase-root requires a value');
      }
      options.setupCodebaseRoot = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--setup-codebase-mode') {
      if (!next) {
        throw new Error('--setup-codebase-mode requires a value');
      }
      if (next !== 'register-only' && next !== 'register-and-index') {
        throw new Error(
          `Invalid --setup-codebase-mode value: ${next} (expected register-only|register-and-index)`,
        );
      }
      options.setupCodebaseMode = next;
      i += 1;
      continue;
    }

    if (arg === '--setup-knowledge-root') {
      if (!next) {
        throw new Error('--setup-knowledge-root requires a value');
      }
      options.setupKnowledgeRoot = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    if (arg === '--provider-id') {
      if (!next) {
        throw new Error('--provider-id requires a value');
      }
      options.providerId = normalizeProviderIdArg(next);
      i += 1;
      continue;
    }

    if (arg === '--require-text') {
      if (!next) {
        throw new Error('--require-text requires a value');
      }
      options.requiredText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--forbid-text') {
      if (!next) {
        throw new Error('--forbid-text requires a value');
      }
      options.forbiddenText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--follow-up-query') {
      if (!next) {
        throw new Error('--follow-up-query requires a value');
      }
      options.followUpQuery = next;
      i += 1;
      continue;
    }

    if (arg === '--follow-up-mode') {
      if (!next) {
        throw new Error('--follow-up-mode requires a value');
      }
      if (next !== 'fast' && next !== 'full' && next !== 'auto') {
        throw new Error(`Invalid --follow-up-mode value: ${next} (expected fast|full|auto)`);
      }
      options.followUpAnalysisMode = next;
      i += 1;
      continue;
    }

    if (arg === '--follow-up-require-text') {
      if (!next) {
        throw new Error('--follow-up-require-text requires a value');
      }
      options.followUpRequiredText.push(next);
      i += 1;
      continue;
    }

    if (arg === '--follow-up-forbid-tool') {
      if (!next) {
        throw new Error('--follow-up-forbid-tool requires a value');
      }
      options.followUpForbiddenTools.push(next);
      i += 1;
      continue;
    }

    if (arg === '--forbid-degraded-fallback') {
      if (!next) {
        throw new Error('--forbid-degraded-fallback requires a value');
      }
      options.forbiddenDegradedFallbacks.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-tool') {
      if (!next) {
        throw new Error('--require-tool requires a value');
      }
      options.requiredTools.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-successful-lookup') {
      if (!next) {
        throw new Error('--require-successful-lookup requires a value');
      }
      options.requiredSuccessfulLookups.push(next);
      i += 1;
      continue;
    }

    if (arg === '--require-skill') {
      if (!next) {
        throw new Error('--require-skill requires a value');
      }
      options.requiredSkills.push(next);
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-layout') {
      if (!next) {
        throw new Error('--trace-pair-layout requires a value');
      }
      if (next !== 'horizontal' && next !== 'vertical') {
        throw new Error(`Invalid --trace-pair-layout value: ${next} (expected horizontal|vertical)`);
      }
      options.tracePairLayout = next;
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-workspace-open') {
      options.tracePairWorkspaceOpen = true;
      continue;
    }

    if (arg === '--trace-pair-split') {
      if (!next) {
        throw new Error('--trace-pair-split requires a value');
      }
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --trace-pair-split value: ${next}`);
      }
      options.tracePairSplitPercent = parsed;
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-active') {
      if (!next) {
        throw new Error('--trace-pair-active requires a value');
      }
      options.tracePairActiveTraceSide = parseTraceSourceArg(next, '--trace-pair-active');
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-maximized') {
      if (!next) {
        throw new Error('--trace-pair-maximized requires a value');
      }
      options.tracePairMaximizedTraceSide = parseTraceSourceArg(next, '--trace-pair-maximized');
      i += 1;
      continue;
    }

    if (arg === '--trace-pair-minimized') {
      if (!next) {
        throw new Error('--trace-pair-minimized requires a value');
      }
      const traceSide = parseTraceSourceArg(next, '--trace-pair-minimized');
      if (!options.tracePairMinimizedTraceSides.includes(traceSide)) {
        options.tracePairMinimizedTraceSides.push(traceSide);
      }
      i += 1;
      continue;
    }

    if (arg === '--output') {
      if (!next) {
        throw new Error('--output requires a value');
      }
      options.outputPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.preset === 'smart') {
    options.smartAction = options.smartAction ?? 'analyze';
    if (options.smartAction === 'analyze') {
      const scope = smartScope ?? 'all';
      if (scope === 'scene_types') {
        if (smartSceneTypes.length === 0) {
          throw new Error('--smart-scope scene_types requires --smart-scene-type');
        }
        options.smartSelection = {
          scope,
          sceneTypes: Array.from(new Set(smartSceneTypes)),
          label: 'CLI scene_types',
        };
      } else if (scope === 'scene_ids') {
        if (smartSceneIds.length === 0) {
          throw new Error('--smart-scope scene_ids requires --smart-scene-id');
        }
        options.smartSelection = {
          scope,
          sceneIds: Array.from(new Set(smartSceneIds)),
          label: 'CLI scene_ids',
        };
      } else {
        options.smartSelection = { scope: 'all', label: 'CLI all scenes' };
      }
    }
  }

  if (options.setupCodebaseMode && !options.setupCodebaseRoot) {
    throw new Error('--setup-codebase-mode requires --setup-codebase-root');
  }

  if (options.sliceSelectionTarget && options.selectionContext) {
    throw new VerificationSliceSelectionError('SLICE_SELECTION_INVALID');
  }

  if (options.entry !== 'scene-reconstruction' && (options.sceneScenario || options.sceneMinRevision !== undefined || options.sceneObservationMs !== undefined || options.sceneOracles)) {
    throw new Error('Scene flags require --entry scene-reconstruction');
  }
  if (options.entry === 'scene-reconstruction' && (options.preset || options.followUpQuery || options.referenceTracePath ||
      options.requireNonPartial || options.requireQuickRun || options.requireExternalIssueTriage || options.expectation)) {
    throw new Error('Scene entry cannot borrow ordinary analysis, quick, non-partial or fact-claim gates');
  }
  return options;
}

function parseTraceSourceArg(value: string, flag: string): TraceSource {
  if (value === 'current' || value === 'reference') return value;
  throw new Error(`Invalid ${flag} value: ${value} (expected current|reference)`);
}

function normalizeProviderIdArg(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'env' || normalized === 'null' || normalized === 'none' || normalized === 'default') {
    return null;
  }
  if (value.trim() === '') {
    throw new Error('--provider-id must not be empty');
  }
  return value;
}

function createVerificationApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  });

  app.use('/api/agent/v1', agentRoutes);
  app.use('/api/rag', ragAdminRoutes);
  app.use('/api/trace-processor', traceProcessorRoutes);
  app.use('/api/skills', skillRoutes);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

async function postJsonOrThrow(
  baseUrl: string,
  route: string,
  body?: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(method === 'POST'
      ? {
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body ?? {}),
        }
      : {}),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || payload.success === false) {
    throw new Error(`Context setup failed (${route}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

type SetupRequest = typeof postJsonOrThrow;

export interface AnalysisContextSetupResult {
  codebases: Array<{
    codebaseId: string;
    setupMode: 'register-only' | 'register-and-index';
    chunkCount: number;
    activeIndexState: 'active' | 'none';
    activeGeneration?: string;
    pendingGeneration: boolean;
    reindexRequests: number;
  }>;
}

export async function setupAnalysisContext(
  baseUrl: string,
  options: VerifyOptions,
  request: SetupRequest = postJsonOrThrow,
): Promise<AnalysisContextSetupResult> {
  const result: AnalysisContextSetupResult = {codebases: []};
  if (options.setupCodebaseRoot) {
    const setupMode = options.setupCodebaseMode ?? 'register-and-index';
    const registration = await request(baseUrl, '/api/rag/codebases/register', {
      kind: 'app_source',
      displayName: 'DeepSeek E2E App Source',
      rootPath: options.setupCodebaseRoot,
      sendToProvider: true,
    });
    const codebase = asRecord(registration.codebase);
    const codebaseId = typeof codebase?.codebaseId === 'string' ? codebase.codebaseId : '';
    if (!codebaseId) throw new Error('Context setup did not return a codebaseId');
    let reindexRequests = 0;
    if (setupMode === 'register-and-index') {
      await request(
        baseUrl,
        `/api/rag/codebases/${encodeURIComponent(codebaseId)}/reindex`,
        {},
      );
      reindexRequests = 1;
    }

    const auditPayload = await request(
      baseUrl,
      `/api/rag/codebases/${encodeURIComponent(codebaseId)}/audit`,
      undefined,
      'GET',
    );
    const audit = asRecord(auditPayload.audit);
    if (!audit || audit.codebaseId !== codebaseId) {
      throw new Error('Context setup audit did not return the registered codebase');
    }
    const chunkCount = typeof audit.chunkCount === 'number' ? audit.chunkCount : 0;
    const activeIndexState: 'active' | 'none' = audit.activeIndexState === 'active'
      ? 'active'
      : 'none';
    const activeGeneration = typeof audit.activeGeneration === 'string'
      ? audit.activeGeneration
      : undefined;
    const pendingGeneration = Boolean(audit.pendingGeneration);
    if (
      setupMode === 'register-only' &&
      (
        chunkCount !== 0 ||
        activeIndexState !== 'none' ||
        activeGeneration !== undefined ||
        pendingGeneration ||
        reindexRequests !== 0
      )
    ) {
      throw new Error('register-only setup returned an indexed or active audited codebase state');
    }
    if (
      setupMode === 'register-and-index' &&
      (
        chunkCount <= 0 ||
        activeIndexState !== 'active' ||
        activeGeneration === undefined ||
        pendingGeneration
      )
    ) {
      throw new Error('register-and-index setup did not produce an active audited index');
    }
    result.codebases.push({
      codebaseId,
      setupMode,
      chunkCount,
      activeIndexState,
      activeGeneration,
      pendingGeneration,
      reindexRequests,
    });
    options.codebaseIds.push(codebaseId);
    options.codeAwareMode ??= 'provider_send';
  }

  if (options.setupKnowledgeRoot) {
    const registration = await postJsonOrThrow(baseUrl, '/api/rag/android-internals/sources', {
      rootPath: options.setupKnowledgeRoot,
      displayName: 'DeepSeek E2E Android Internals',
      rightsAcknowledged: true,
      sendToProvider: true,
    });
    const source = asRecord(registration.source);
    const sourceId = typeof source?.sourceId === 'string' ? source.sourceId : '';
    if (!sourceId) throw new Error('Context setup did not return a knowledge source id');
    await postJsonOrThrow(
      baseUrl,
      `/api/rag/android-internals/sources/${encodeURIComponent(sourceId)}/reindex`,
      {},
    );
    options.knowledgeSourceIds.push(sourceId);
  }

  options.codebaseIds = Array.from(new Set(options.codebaseIds));
  options.knowledgeSourceIds = Array.from(new Set(options.knowledgeSourceIds));
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizeDispatchedToolName(toolName: string): string {
  const match = toolName.match(/^mcp__.+?__(.+)$/);
  return match?.[1] ?? toolName;
}

function recordToolCall(summary: SseSummary, toolName: string): void {
  summary.toolCallCounts[toolName] = (summary.toolCallCounts[toolName] ?? 0) + 1;
  const normalized = normalizeDispatchedToolName(toolName);
  if (normalized !== toolName) {
    summary.toolCallCounts[normalized] = (summary.toolCallCounts[normalized] ?? 0) + 1;
  }
}

function recordClaimVerifierSummary(summary: SseSummary, payload: Record<string, unknown> | null): void {
  const direct = asRecord(payload?.claimVerificationResult);
  const nested = asRecord(asRecord(payload?.qualityArtifacts)?.claimVerificationResult);
  const verifier = direct ?? nested;
  if (!verifier) return;

  if (typeof verifier.status === 'string') summary.claimVerifierStatus = verifier.status;
  if (typeof verifier.passed === 'boolean') summary.claimVerifierPassed = verifier.passed;
  if (typeof verifier.checkedClaimCount === 'number') {
    summary.claimVerifierCheckedClaimCount = verifier.checkedClaimCount;
  }
  if (typeof verifier.unsupportedClaimCount === 'number') {
    summary.claimVerifierUnsupportedClaimCount = verifier.unsupportedClaimCount;
  }
  if (Array.isArray(verifier.issues)) {
    summary.claimVerifierIssueCount = verifier.issues.length;
  }
}

function hasConcreteEvidenceReferences(text: string): boolean {
  return /art-\d+|data:[a-z0-9_:.:-]+|evidence_ref_id\s*=|evidence\s*(ref|id|source)\s*[:=]|source_ref\s*=|表\s*(?:art-\d+|sql:\d+)|\bsql:\d+\b/i.test(text);
}

function hasEvidenceIndex(text: string): boolean {
  return /证据(?:表)?索引/.test(text);
}

function hasFinalReportHeading(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,3}\s*(?:(?:[^\n#]{0,40})?分析报告|综合结论|最终结论|最终报告|Final Conclusion|Final Report|Analysis Report)(?=\s|[：:。.!！?\n]|$)/i.test(text);
}

function hasProcessNarration(text: string): boolean {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return false;
  return /^(?:我来|我需要|我将|我会|现在|接下来|下一步|让我|为了完成|I need\b|I will\b|Now I\b|Next\b|Let me\b)/i.test(compact) ||
    /(?:现在|接下来|下一步).{0,40}(?:完成|进入|继续).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(compact) ||
    /(?:现在完成|现在进入|进入|继续执行).{0,20}Phase\s*\d+(?:\.\d+)?/i.test(compact) ||
    /(?:update_plan_phase|submit_plan|resolve_hypothesis|阶段状态更新|执行剩余阶段|继续执行剩余阶段|OpenAI plan|provider 未主动结束 stream|plan 未完成|plan 已完成)/i.test(compact);
}

function clampTracePairSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(82, Math.max(18, Math.round(value)));
}

function isTracePairPaneLive(
  options: VerifyOptions,
  traceSide: TraceSource,
): boolean {
  if (!options.tracePairWorkspaceOpen) return traceSide === 'current';
  if (
    options.tracePairMaximizedTraceSide &&
    options.tracePairMaximizedTraceSide !== traceSide
  ) {
    return false;
  }
  return !options.tracePairMinimizedTraceSides.includes(traceSide);
}

function buildTracePairContextForVerification(input: {
  options: VerifyOptions;
  traceId: string;
  referenceTraceId: string;
}): TracePairContext {
  const { options, traceId, referenceTraceId } = input;
  const primarySide = options.tracePairLayout === 'vertical' ? 'top' : 'left';
  const referenceSide = options.tracePairLayout === 'vertical' ? 'bottom' : 'right';
  const activeSide = options.tracePairActiveTraceSide === 'reference'
    ? referenceSide
    : primarySide;

  return {
    schemaVersion: 1,
    layout: options.tracePairLayout,
    primarySide,
    referenceSide,
    activeSide,
    workspaceOpen: options.tracePairWorkspaceOpen,
    splitPercent: clampTracePairSplitPercent(options.tracePairSplitPercent),
    ...(options.tracePairMaximizedTraceSide
      ? { maximizedTraceSide: options.tracePairMaximizedTraceSide }
      : {}),
    ...(options.tracePairMinimizedTraceSides.length > 0
      ? { minimizedTraceSides: options.tracePairMinimizedTraceSides }
      : {}),
    aliases: {
      left: 'current',
      top: 'current',
      primary: 'current',
      main: 'current',
      current: 'current',
      '左': 'current',
      '左侧': 'current',
      '上': 'current',
      '上方': 'current',
      '主': 'current',
      '当前': 'current',
      right: 'reference',
      bottom: 'reference',
      reference: 'reference',
      baseline: 'reference',
      '右': 'reference',
      '右侧': 'reference',
      '下': 'reference',
      '下方': 'reference',
      '参考': 'reference',
    },
    panes: [
      {
        side: primarySide,
        traceSide: 'current',
        traceId,
        traceName: path.basename(options.tracePath),
        active: options.tracePairActiveTraceSide === 'current',
        visualState: isTracePairPaneLive(options, 'current') ? 'live' : 'context_only',
      },
      {
        side: referenceSide,
        traceSide: 'reference',
        traceId: referenceTraceId,
        traceName: path.basename(options.referenceTracePath || 'reference.trace'),
        active: options.tracePairActiveTraceSide === 'reference',
        visualState: isTracePairPaneLive(options, 'reference') ? 'live' : 'context_only',
      },
    ],
  };
}

interface TextChecks {
  requiredText: string[];
  forbiddenText: string[];
}

function recordTextChecks(summary: SseSummary, text: string, checks: TextChecks): void {
  for (const required of checks.requiredText) {
    if (!summary.requiredTextMatches[required] && text.includes(required)) {
      summary.requiredTextMatches[required] = true;
    }
  }
  for (const forbidden of checks.forbiddenText) {
    if (!summary.forbiddenTextMatches[forbidden] && text.includes(forbidden)) {
      summary.forbiddenTextMatches[forbidden] = true;
    }
  }
}

function extractDataEnvelopes(parsed: unknown, parsedRecord: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const candidates = [
    parsedRecord?.envelope,
    asRecord(parsedRecord?.data)?.envelope,
    parsed,
    parsedRecord?.data,
    asRecord(parsedRecord?.data)?.data,
    parsedRecord?.content,
    asRecord(parsedRecord?.content)?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null);
    }

    const record = asRecord(candidate);
    if (record && asRecord(record.meta)) {
      return [record];
    }
  }

  return [];
}

function recordConclusionEvidence(
  summary: SseSummary,
  text: string,
  target: 'conclusion' | 'analysis_completed',
): void {
  if (target === 'conclusion') {
    summary.conclusionChars = Math.max(summary.conclusionChars, text.length);
    summary.conclusionHasConcreteEvidenceRefs ||= hasConcreteEvidenceReferences(text);
    summary.conclusionHasEvidenceIndex ||= hasEvidenceIndex(text);
    summary.conclusionHasConcreteCodeRefs ||= hasConcreteCodeReference(text);
    return;
  }

  summary.analysisCompletedConclusionChars = Math.max(
    summary.analysisCompletedConclusionChars,
    text.length,
  );
  summary.analysisCompletedHasConcreteEvidenceRefs ||= hasConcreteEvidenceReferences(text);
  summary.analysisCompletedHasEvidenceIndex ||= hasEvidenceIndex(text);
  summary.analysisCompletedHasFinalReportHeading ||= hasFinalReportHeading(text);
  summary.analysisCompletedHasProcessNarration ||= hasProcessNarration(text);
  summary.analysisCompletedHasConcreteCodeRefs ||= hasConcreteCodeReference(text);
}

export class VerificationSseTimeoutError extends Error {
  constructor() {
    super('SSE verification exceeded its configured timeout');
    this.name = 'VerificationSseTimeoutError';
  }
}

type VerificationDiagnosticRow = Record<string, string | number | boolean>;
export interface VerificationDiagnosticsSnapshot {
  schemaVersion: 'verification_observation@1';
  diagnosticOnly: true;
  timing: 'elapsed_since_install_not_native_budget';
  jsonTiming: 'body_read_and_parse_combined';
  fetch: readonly Readonly<VerificationDiagnosticRow>[];
  sql: readonly Readonly<VerificationDiagnosticRow>[];
  fetchDroppedCount: number;
  sqlDroppedCount: number;
  observationFailures: number;
  restoreConflicts: number;
}

/** Process-local observation only. No hooks are installed when this module is imported. */
export function installVerificationDiagnostics(input: {
  phase: () => string;
  fetchTarget?: object;
  queryPrototype?: object;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const fetchRows: VerificationDiagnosticRow[] = [];
  const sqlRows: VerificationDiagnosticRow[] = [];
  let active = true, fetchDroppedCount = 0, sqlDroppedCount = 0, observationFailures = 0, restoreConflicts = 0;
  let frozen: VerificationDiagnosticsSnapshot | undefined;
  const restores: Array<{target: WeakRef<object>; key: string; original?: PropertyDescriptor; wrapper: Function}> = [];
  const removeListeners: Array<() => void> = [];
  const processorIds = new WeakMap<object, number>();
  let nextProcessorId = 0;
  const bounded = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1_000_000_000, Math.floor(value))) : 0;
  const elapsed = () => bounded(now() - startedAt);
  const member = (value: unknown, values: readonly string[]) => typeof value === 'string' && values.includes(value) ? value : 'unknown';
  const phase = () => member(input.phase(), ['context_setup', 'trace_load', 'selection_resolution', 'trace_oracle',
    'analysis_start', 'analysis_stream', 'analysis_verification', 'follow_up_start', 'follow_up_stream', 'follow_up_verification']);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const safe = (operation: () => void) => {
    if (!active) return;
    try {operation();} catch {observationFailures = bounded(observationFailures + 1);}
  };
  const data = (value: unknown, key: string): unknown => value !== null && typeof value === 'object'
    ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const observe = (promise: unknown, fulfilled: (value: any) => void, rejected: () => void) => safe(() => {
    // Both callbacks absorb observer failures. The derived promise is never returned.
    void Reflect.apply(Promise.prototype.then, promise, [
      (value: unknown) => {safe(() => fulfilled(value));}, () => {safe(rejected);},
    ]);
  });
  const wrap = (target: object, key: string, factory: (original: Function) => Function) => safe(() => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    let descriptor = original, prototype = Object.getPrototypeOf(target), depth = 0;
    while (!descriptor && prototype && depth++ < 8) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!descriptor || typeof descriptor.value !== 'function') {observationFailures++; return;}
    const wrapper = factory(descriptor.value);
    Object.defineProperty(target, key, original ? {...original, value: wrapper}
      : {value: wrapper, writable: true, configurable: true, enumerable: false});
    restores.push({target: new WeakRef(target), key, original, wrapper});
  });
  const modelHash = (row: VerificationDiagnosticRow, key: string, model: unknown) => {
    if (typeof model === 'string' && model.length > 0 && model.length <= 256) row[key] = hash(model);
  };
  const observeJson = (response: object, row: VerificationDiagnosticRow) => wrap(response, 'json', original => function(this: unknown, ...args: unknown[]) {
    safe(() => {row.state = 'json_pending'; row.jsonStartedElapsedMs = elapsed();});
    let promise: unknown;
    try {promise = Reflect.apply(original, this, args);} catch (error) {
      safe(() => {row.state = 'json_rejected'; row.jsonSettledElapsedMs = elapsed();});
      throw error;
    }
    observe(promise, value => {
      row.state = 'json_fulfilled'; row.jsonSettledElapsedMs = elapsed();
      modelHash(row, 'actualModelHash', data(value, 'model'));
      row.responseStatus = member(data(value, 'status'), ['completed', 'incomplete', 'failed', 'cancelled']);
      const choices = data(value, 'choices');
      if (Array.isArray(choices) && choices.length === 1) {
        row.finishReason = member(data(choices[0], 'finish_reason'), ['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
        const content = data(data(choices[0], 'message'), 'content');
        if (typeof content === 'string') row.outputChars = bounded(content.length);
      } else {
        const output = data(value, 'output');
        if (Array.isArray(output) && output.length <= 512) {
          let chars = 0, hasText = false;
          for (const item of output) {
            const content = data(item, 'content');
            if (data(item, 'type') !== 'message' || !Array.isArray(content) || content.length > 512) continue;
            for (const part of content) {
              const text = data(part, 'text');
              if (data(part, 'type') === 'output_text' && typeof text === 'string') {hasText = true; chars = bounded(chars + text.length);}
            }
          }
          if (hasText) row.outputChars = chars;
        }
      }
    }, () => {row.state = 'json_rejected'; row.jsonSettledElapsedMs = elapsed();});
    return promise;
  });
  wrap(input.fetchTarget ?? globalThis, 'fetch', original => function(this: unknown, ...args: unknown[]) {
    let row: VerificationDiagnosticRow | undefined;
    safe(() => {
      const requestObject = args[0] instanceof Request;
      const address = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href
        : requestObject ? (args[0] as Request).url : undefined;
      if (!address) return;
      const pathname = new URL(address).pathname;
      const endpoint = pathname.endsWith('/chat/completions') ? 'chat_completions' : pathname.endsWith('/responses') ? 'responses' : undefined;
      if (!endpoint) return;
      if (fetchRows.length >= 32) {fetchDroppedCount = bounded(fetchDroppedCount + 1); return;}
      row = {sequence: fetchRows.length + 1, phase: phase(), endpoint, startedElapsedMs: elapsed(),
        state: 'fetch_pending', stream: 'unknown', requestMetadata: 'unavailable'};
      fetchRows.push(row);
      const body = requestObject ? undefined : data(args[1], 'body');
      // Never consume a Request, stream, FormData or other non-string body.
      if (typeof body === 'string') {
        row.inputBytes = bounded(Buffer.byteLength(body));
        if (body.length <= 256 * 1024) {
          const request: unknown = JSON.parse(body);
          row.requestMetadata = 'observed';
          const stream = data(request, 'stream');
          row.stream = stream === undefined ? false : typeof stream === 'boolean' ? stream : 'unknown';
          modelHash(row, 'requestedModelHash', data(request, 'model'));
        }
      }
      const signal = data(args[1], 'signal');
      if (signal instanceof AbortSignal) {
        const observedRow = row;
        const aborted = () => safe(() => {observedRow.abortObservedElapsedMs = elapsed();});
        if (signal.aborted) aborted();
        else {signal.addEventListener('abort', aborted, {once: true}); removeListeners.push(() => signal.removeEventListener('abort', aborted));}
      }
    });
    let promise: unknown;
    try {promise = Reflect.apply(original, this, args);} catch (error) {
      if (row) safe(() => {row!.state = 'fetch_rejected'; row!.settledElapsedMs = elapsed();});
      throw error;
    }
    if (row) {
      const observedRow = row;
      observe(promise, response => {
        observedRow.state = 'headers_received'; observedRow.headersElapsedMs = elapsed();
        if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) observedRow.httpStatus = response.status;
        if (response && typeof response === 'object') observeJson(response, observedRow);
      }, () => {observedRow.state = 'fetch_rejected'; observedRow.settledElapsedMs = elapsed();});
    }
    return promise;
  });
  const nativeSnapshot = (processor: any, row: VerificationDiagnosticRow, suffix: string) => {
    const snapshot = processor.getNativeProvenanceSnapshot?.();
    row[`nativeStatus${suffix}`] = member(snapshot?.status, ['unknown', 'trusted', 'tainted']);
    row[`nativeSchemaEligible${suffix}`] = typeof snapshot?.nativeSchemaEligible === 'boolean' ? snapshot.nativeSchemaEligible : 'unknown';
  };
  for (const method of ['query', 'queryBounded']) wrap(input.queryPrototype ?? WorkingTraceProcessor.prototype, method,
    original => function(this: unknown, ...args: unknown[]) {
      let row: VerificationDiagnosticRow | undefined;
      safe(() => {
        if (sqlRows.length >= 128) {sqlDroppedCount = bounded(sqlDroppedCount + 1); return;}
        row = {sequence: sqlRows.length + 1, phase: phase(), method, startedElapsedMs: elapsed(), state: 'pending'};
        sqlRows.push(row);
        if (this && typeof this === 'object') {
          if (!processorIds.has(this)) processorIds.set(this, ++nextProcessorId);
          row.processorSequence = processorIds.get(this)!;
          const privateRun = data(this, 'analysisRunPrivate');
          row.analysisRunPrivate = typeof privateRun === 'boolean' ? privateRun : 'unknown';
          nativeSnapshot(this, row, 'AtCall');
        }
        if (typeof args[0] === 'string') {
          row.sqlHash = hash(args[0]); row.sqlBytes = bounded(Buffer.byteLength(args[0]));
          const analysis = analyzeRawSqlDirectProjection(args[0]);
          row.pureRead = analysis.pureRead;
          row.parserReason = analysis.reason === undefined ? 'none' : member(analysis.reason,
            ['sql_unrecognized', 'sql_byte_budget', 'sql_token_budget', 'sql_depth_budget', 'projection_not_direct']);
          // Syntax candidates do not establish an actual native result mapping.
          row.directProjection = Boolean(analysis.relation && analysis.projections?.some(projection =>
            projection.kind === 'column' || projection.kind === 'star'));
        }
      });
      let promise: unknown;
      try {promise = Reflect.apply(original, this, args);} catch (error) {
        if (row) safe(() => {row!.state = 'rejected'; row!.settledElapsedMs = elapsed();});
        throw error;
      }
      if (row) {
        const observedRow = row;
        observe(promise, result => {
          observedRow.state = 'fulfilled'; observedRow.settledElapsedMs = elapsed();
          observedRow.resultError = typeof data(result, 'error') === 'string' && Boolean(data(result, 'error'));
          nativeSnapshot(this, observedRow, 'AtSettle');
          const fields = readRawSqlCaptureFields(result);
          observedRow.captureFieldsPresent = fields !== undefined;
          observedRow.captureFieldCount = bounded(fields ? Object.keys(fields).length : 0);
        }, () => {observedRow.state = 'rejected'; observedRow.settledElapsedMs = elapsed();});
      }
      return promise;
    });
  return {stop(): VerificationDiagnosticsSnapshot {
    if (frozen) return frozen;
    active = false;
    for (const remove of removeListeners.splice(0)) {try {remove();} catch {observationFailures++;}}
    for (const restore of restores.splice(0).reverse()) {
      try {
        const target = restore.target.deref();
        if (!target) continue;
        if (Object.getOwnPropertyDescriptor(target, restore.key)?.value !== restore.wrapper) {restoreConflicts++; continue;}
        if (restore.original) Object.defineProperty(target, restore.key, restore.original);
        else if (!Reflect.deleteProperty(target, restore.key)) restoreConflicts++;
      } catch {restoreConflicts++;}
    }
    frozen = Object.freeze({schemaVersion: 'verification_observation@1', diagnosticOnly: true,
      timing: 'elapsed_since_install_not_native_budget', jsonTiming: 'body_read_and_parse_combined',
      fetch: Object.freeze(fetchRows.map(row => Object.freeze({...row}))), sql: Object.freeze(sqlRows.map(row => Object.freeze({...row}))),
      fetchDroppedCount, sqlDroppedCount, observationFailures: bounded(observationFailures), restoreConflicts: bounded(restoreConflicts)});
    return frozen;
  }};
}

export function writeVerificationDiagnostics(outputPath: string, snapshot: VerificationDiagnosticsSnapshot): boolean {
  try {
    const diagnosticsPath = `${outputPath}.diagnostics.json`;
    fs.mkdirSync(path.dirname(diagnosticsPath), {recursive: true});
    fs.writeFileSync(diagnosticsPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    return true;
  } catch {
    try {console.error('diagnostic_write_failed');} catch { /* Diagnostics cannot replace the run's outcome. */ }
    return false;
  }
}

export class VerificationLifecycleError extends Error {
  constructor(readonly code: string) {super('The analysis lifecycle failed');}
}

/** Only verifier-issued phase/status fields enter failure artifacts, never error or provider text. */
export async function recordVerificationFailureAndCancel(input: {
  baseUrl: string;
  outputPath: string;
  phase: string;
  startedAt: number;
  timeoutMs: number;
  sessionId?: string;
  runId?: string;
  error: unknown;
  selectionResolution?: ResolvedVerificationSliceSelection;
}, request: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const failure: Record<string, unknown> = {
    schemaVersion: 'agent_sse_verification_failure@1',
    timestamp: new Date().toISOString(),
    phase: input.phase,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId || undefined,
    runId: input.runId || undefined,
    errorCode: input.error instanceof VerificationLifecycleError ? input.error.code
      : input.error instanceof VerificationSseTimeoutError ? 'SSE_TIMEOUT'
      : input.error instanceof VerificationSliceSelectionError ? input.error.code : 'VERIFICATION_FAILED',
    ...preserveVerificationSessionLog(input.outputPath, input.sessionId ?? ''),
    ...(input.selectionResolution ? {selectionResolution: input.selectionResolution} : {}),
    cancellation: input.sessionId && input.runId ? 'pending' : 'not_owned',
    passed: false,
    observedChecksPassed: false,
    semanticAcceptance: 'INCONCLUSIVE',
    completeAcceptance: false,
  };
  const persist = () => {
    fs.mkdirSync(path.dirname(input.outputPath), {recursive: true});
    fs.writeFileSync(input.outputPath, `${JSON.stringify(failure, null, 2)}\n`);
  };
  // Persist first: cancellation itself may time out or the child may be killed.
  persist();
  if (input.sessionId && input.runId) {
    try {
      const response = await request(`${input.baseUrl}/api/agent/v1/${encodeURIComponent(input.sessionId)}/cancel`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({runId: input.runId}), signal: AbortSignal.timeout(10_000),
      });
      const payload = asRecord(await response.json());
      failure.cancellation = response.ok && payload?.success === true &&
        payload.sessionId === input.sessionId && payload.runId === input.runId ? 'confirmed' : 'rejected';
      failure.cancellationHttpStatus = response.status;
    } catch {
      failure.cancellation = 'failed';
    }
    persist();
  }
  return failure;
}

export async function collectSseSummary(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
  textChecks: TextChecks,
  options: { runId?: string; observeEvent?: (event: string, payload: unknown) => void | Promise<void>; readUntilClose?: boolean; terminalObservationMs?: number } = {},
): Promise<SseSummary> {
  const streamStartedAt = Date.now();
  const summary: SseSummary = {
    candidateProtocolDiagnostics: [],
    totalEvents: 0,
    progressCount: 0,
    agentTaskDispatchedCount: 0,
    agentResponseCount: 0,
    answerTokenCount: 0,
    conclusionCount: 0,
    provisionalConclusionCount: 0,
    dataEnvelopeCount: 0,
    planSubmittedCount: 0,
    conversationStepCount: 0,
    thoughtCount: 0,
    planPhaseUpdatedCount: 0,
    architectureDetectedCount: 0,
    degradedCount: 0,
    degradedFallbackCounts: {},
    degradedEvents: [],
    errorEvents: [],
    dataEnvelopeItemCount: 0,
    dataEnvelopeMissingPhaseCount: 0,
    dataEnvelopeAmbiguousPhaseCount: 0,
    dataEnvelopeUnexpectedPhaseCount: 0,
    dataEnvelopePhaseCounts: {},
    conclusionChars: 0,
    conclusionHasConcreteEvidenceRefs: false,
    conclusionHasEvidenceIndex: false,
    analysisCompletedConclusionChars: 0,
    analysisCompletedHasConcreteEvidenceRefs: false,
    analysisCompletedHasEvidenceIndex: false,
    analysisCompletedHasFinalReportHeading: false,
    analysisCompletedHasProcessNarration: false,
    conclusionHasConcreteCodeRefs: false,
    analysisCompletedHasConcreteCodeRefs: false,
    requiredTextMatches: Object.fromEntries(textChecks.requiredText.map((text) => [text, false])),
    forbiddenTextMatches: Object.fromEntries(textChecks.forbiddenText.map((text) => [text, false])),
    stageNames: [],
    stageTransitionCount: 0,
    directSkillProgressCount: 0,
    directSkillCompletedCount: 0,
    directSkillFindingCount: 0,
    toolCallCounts: {},
    successfulLookupCounts: {},
    skillCallCounts: {},
  };

  const stageNameSet = new Set<string>();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let observationFinished = false;
  let terminalObservation: ReturnType<typeof setTimeout> | undefined;

  try {
    const streamPath = options.runId
      ? `/api/agent/v1/runs/${options.runId}/stream`
      : `/api/agent/v1/${sessionId}/stream`;
    const response = await fetch(`${baseUrl}${streamPath}`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE stream failed: HTTP ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let shouldStop = false;

    while (!shouldStop) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let separatorIndex = buffer.indexOf('\n\n');

      while (separatorIndex !== -1) {
        const block = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);

        if (block !== '' && !block.startsWith(':')) {
          let event = 'message';
          const dataLines: string[] = [];

          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          const dataText = dataLines.join('\n');
          let parsed: unknown = dataText;
          if (dataText !== '') {
            try {
              parsed = JSON.parse(dataText);
            } catch {
              parsed = dataText;
            }
          }

          summary.totalEvents += 1;
          summary.terminalEvent = event;

          const parsedRecord = asRecord(parsed);
          const payload = asRecord(parsedRecord?.data) ?? parsedRecord;

          await options.observeEvent?.(event, event === 'data' ? parsed : payload);
          // The product's own predicate: a failed run ends with `error` and leaves the stream open.
          const terminal = isTerminalSseEvent(event, dataText);
          if (options.readUntilClose && !terminalObservation && terminal) {
            terminalObservation = setTimeout(() => {observationFinished = true; controller.abort();}, options.terminalObservationMs ?? 2000);
          }

          // --- agentv3 event counting ---
          switch (event) {
            case 'progress': {
              summary.progressCount += 1;
              if (payload?.phase === 'candidate_protocol') {
                const diagnostic = sanitizeCandidateProtocolDiagnostic(payload.candidateProtocolDiagnostic);
                const diagnostics = summary.candidateProtocolDiagnostics!;
                if (diagnostic && diagnostics.length < 4 && !diagnostics.some(previous =>
                  previous.candidateIndex === diagnostic.candidateIndex && previous.stage === diagnostic.stage)) {
                  diagnostics.push(diagnostic);
                }
              }
              const sourceEventType = privateProjectedSourceEventType(payload);
              if (sourceEventType === 'plan_submitted') {
                summary.planSubmittedCount += 1;
              } else if (sourceEventType === 'agent_response') {
                summary.agentResponseCount += 1;
              } else if (sourceEventType === 'plan_phase_updated') {
                summary.planPhaseUpdatedCount += 1;
              } else if (sourceEventType === 'conversation_step') {
                // A private-knowledge run reports these through `progress` with
                // the original name in `sourceEventType`, so both shapes have to
                // be counted or the surface looks absent on exactly the runs
                // whose projection is most worth checking.
                summary.conversationStepCount += 1;
              } else if (sourceEventType === 'thought' || sourceEventType === 'worker_thought') {
                summary.thoughtCount += 1;
              } else if (sourceEventType === 'degraded') {
                summary.degradedCount += 1;
                const fallback = typeof payload?.degradedFallback === 'string'
                  ? payload.degradedFallback
                  : undefined;
                if (fallback) {
                  summary.degradedFallbackCounts[fallback] =
                    (summary.degradedFallbackCounts[fallback] ?? 0) + 1;
                }
                summary.degradedEvents.push(fallback ? {fallback} : {});
              }
              break;
            }
            case 'tool_call':
              if (typeof payload?.toolName === 'string') {
                recordToolCall(summary, payload.toolName);
              }
              break;
            case 'agent_task_dispatched':
              summary.agentTaskDispatchedCount += 1;
              if (typeof payload?.toolName === 'string') {
                recordToolCall(summary, payload.toolName);
              }
              {
                const args = asRecord(payload?.args);
                if (typeof args?.skillId === 'string') {
                  summary.skillCallCounts[args.skillId] = (summary.skillCallCounts[args.skillId] ?? 0) + 1;
                }
              }
              break;
            case 'agent_response':
              summary.agentResponseCount += 1;
              break;
            case 'answer_token':
              summary.answerTokenCount += 1;
              break;
            case 'conversation_step':
              summary.conversationStepCount += 1;
              break;
            case 'thought':
            case 'worker_thought':
              summary.thoughtCount += 1;
              break;
            case 'plan_phase_updated':
              summary.planPhaseUpdatedCount += 1;
              break;
            case 'conclusion':
              if (payload?.provisional === true) {
                summary.provisionalConclusionCount += 1;
                summary.firstProvisionalConclusionMs ??= Date.now() - streamStartedAt;
                if (typeof payload.conclusion === 'string') recordTextChecks(summary, payload.conclusion, textChecks);
                break;
              }
              summary.conclusionCount += 1;
              if (typeof payload?.conclusion === 'string') {
                recordTextChecks(summary, payload.conclusion, textChecks);
                recordConclusionEvidence(summary, payload.conclusion, 'conclusion');
              }
              break;
            case 'data':
              summary.dataEnvelopeCount += 1;
              for (const envelope of extractDataEnvelopes(parsed, parsedRecord)) {
                const meta = asRecord(envelope.meta);
                const phaseId = typeof meta?.planPhaseId === 'string' ? meta.planPhaseId : '';
                const attribution = typeof meta?.planPhaseAttribution === 'string'
                  ? meta.planPhaseAttribution
                  : '';
                summary.dataEnvelopeItemCount += 1;
                summary.dataEnvelopePhaseCounts[phaseId || '<missing>'] =
                  (summary.dataEnvelopePhaseCounts[phaseId || '<missing>'] || 0) + 1;
                if (!phaseId) summary.dataEnvelopeMissingPhaseCount += 1;
                if (attribution === 'ambiguous') summary.dataEnvelopeAmbiguousPhaseCount += 1;
                if (attribution === 'unexpected_tool') summary.dataEnvelopeUnexpectedPhaseCount += 1;
              }
              break;
            case 'plan_submitted':
              summary.planSubmittedCount += 1;
              break;
            case 'architecture_detected':
              summary.architectureDetectedCount += 1;
              break;
            case 'degraded':
              summary.degradedCount += 1;
              if (typeof payload?.fallback === 'string') {
                summary.degradedFallbackCounts[payload.fallback] =
                  (summary.degradedFallbackCounts[payload.fallback] ?? 0) + 1;
              }
              summary.degradedEvents.push({
                ...(typeof payload?.fallback === 'string' ? { fallback: payload.fallback } : {}),
                ...(typeof payload?.terminationReason === 'string' ? { terminationReason: payload.terminationReason } : {}),
                ...(typeof payload?.message === 'string' ? { message: payload.message } : {}),
              });
              break;
            default:
              break;
          }

          if (event === 'analysis_completed') {
            if (payload) {
              summary.terminalAnalysis = {
                success: payload.success as boolean | undefined,
                conclusion: payload.conclusion as string | undefined,
                completion: payload.completion as TerminalAnalysisEvidence['completion'],
                turnIntent: payload.turnIntent as TerminalAnalysisEvidence['turnIntent'],
                deliveryAssurance: payload.deliveryAssurance as TerminalAnalysisEvidence['deliveryAssurance'],
                conclusionContract: payload.conclusionContract as TerminalAnalysisEvidence['conclusionContract'],
                claimVerificationResult: payload.claimVerificationResult as TerminalAnalysisEvidence['claimVerificationResult'],
                claimSupport: payload.claimSupport as TerminalAnalysisEvidence['claimSupport'],
                investigationAssessment: payload.investigationAssessment as TerminalAnalysisEvidence['investigationAssessment'],
              };
            }
            if (typeof payload?.conclusion === 'string') {
              recordTextChecks(summary, payload.conclusion, textChecks);
              recordConclusionEvidence(summary, payload.conclusion, 'analysis_completed');
            }
            recordClaimVerifierSummary(summary, payload);
            const conclusionContract = asRecord(payload?.conclusionContract);
            const actualSourceUseDecision = sanitizeSourceUseDecision(payload?.sourceUseDecision);
            if (actualSourceUseDecision) {
              summary.analysisCompletedSourceUseDecision = actualSourceUseDecision;
            }
            const sourceUseDecision = asRecord(payload?.sourceUseDecision) ?? asRecord(conclusionContract?.sourceUseDecision);
            if (typeof sourceUseDecision?.status === 'string') {
              summary.analysisCompletedSourceUseStatus = sourceUseDecision.status;
            }
            if (Array.isArray(sourceUseDecision?.references)) {
              summary.analysisCompletedSourceReferenceCount = sourceUseDecision.references.length;
            }
            if (Array.isArray(conclusionContract?.sourceClaimBindings)) {
              summary.analysisCompletedSourceBindingCount = conclusionContract.sourceClaimBindings.length;
            }
            const sourceClaimVerification = asRecord(payload?.sourceClaimVerificationResult);
            if (sourceClaimVerification?.schemaVersion === 'source_claim_verifier@1' &&
                Array.isArray(sourceClaimVerification.bindings) && Array.isArray(sourceUseDecision?.references)) {
              const returnedReferenceIds = new Set(
                sourceUseDecision.references.map(reference => asRecord(reference)?.id),
              );
              summary.analysisCompletedSourceClaimVerifierStatus = String(sourceClaimVerification.status);
              summary.analysisCompletedSourceMechanismStatuses = sourceClaimVerification.bindings
                .map(binding => String(asRecord(binding)?.mechanismStatus));
              summary.analysisCompletedSourceReferenceMembershipPassed =
                sourceClaimVerification.bindings.length > 0 &&
                sourceClaimVerification.bindings.every(binding => {
                  const refs = asRecord(binding)?.sourceReferenceIds;
                  return Array.isArray(refs) && refs.length > 0 && refs.every(ref => returnedReferenceIds.has(ref));
                });
              if (sourceClaimVerification.status === 'passed' && summary.analysisCompletedSourceReferenceMembershipPassed) {
                summary.analysisCompletedVerifiedSourceBindings = sourceClaimVerification.bindings.map(binding => {
                  const verified = binding as SourceClaimBindingV1;
                  return {claimId: verified.claimId, mechanismStatus: verified.mechanismStatus,
                    sourceReferenceIds: verified.sourceReferenceIds, traceEvidenceRefIds: verified.traceEvidenceRefIds};
                });
              }
            }
            if (typeof payload?.reportUrl === 'string') {
              summary.analysisCompletedReportUrl = payload.reportUrl;
            }
            if (typeof payload?.partial === 'boolean') {
              summary.analysisCompletedPartial = payload.partial;
            }
            if (typeof payload?.terminationReason === 'string') {
              summary.analysisCompletedTerminationReason = payload.terminationReason;
            }
            if (typeof payload?.terminationMessage === 'string') {
              summary.analysisCompletedTerminationMessage = payload.terminationMessage;
            }
            const receipt = asRecord(payload?.analysisReceipt);
            const receiptOutputs = asRecord(receipt?.outputs);
            if (
              typeof receipt?.runId === 'string' &&
              typeof receipt.runManifestId === 'string'
            ) {
              summary.externalIssueSource = {
                runId: receipt.runId,
                runManifestId: receipt.runManifestId,
                ...(typeof receiptOutputs?.resultSnapshotId === 'string'
                  ? {resultSnapshotId: receiptOutputs.resultSnapshotId}
                  : {}),
              };
            }
            if (payload?.quickRun && typeof payload.quickRun === 'object' && !Array.isArray(payload.quickRun)) {
              const quickRun = payload.quickRun as Record<string, any>;
              const evidence = quickRun.evidence && typeof quickRun.evidence === 'object'
                ? quickRun.evidence as Record<string, any>
                : {};
              summary.quickRun = {
                ...(typeof quickRun.requestedMode === 'string' ? { requestedMode: quickRun.requestedMode } : {}),
                ...(typeof quickRun.resolvedMode === 'string' ? { resolvedMode: quickRun.resolvedMode } : {}),
                ...(typeof quickRun.profile === 'string' ? { profile: quickRun.profile } : {}),
                ...(typeof quickRun.targetTurns === 'number' ? { targetTurns: quickRun.targetTurns } : {}),
                ...(typeof quickRun.hardCapTurns === 'number' ? { hardCapTurns: quickRun.hardCapTurns } : {}),
                ...(typeof quickRun.actualTurns === 'number' ? { actualTurns: quickRun.actualTurns } : {}),
                ...(typeof quickRun.enforcement === 'string' ? { enforcement: quickRun.enforcement } : {}),
                ...(typeof quickRun.stopReason === 'string' ? { stopReason: quickRun.stopReason } : {}),
                ...(typeof quickRun.verifierStatus === 'string' ? { verifierStatus: quickRun.verifierStatus } : {}),
                ...(typeof evidence.frontendPrequeryInjected === 'number' ? { frontendPrequeryInjected: evidence.frontendPrequeryInjected } : {}),
                ...(typeof evidence.frontendPrequeryCited === 'number' ? { frontendPrequeryCited: evidence.frontendPrequeryCited } : {}),
                ...(typeof evidence.currentRunDataEnvelopes === 'number' ? { currentRunDataEnvelopes: evidence.currentRunDataEnvelopes } : {}),
                ...(typeof evidence.citedEvidenceRefs === 'number' ? { citedEvidenceRefs: evidence.citedEvidenceRefs } : {}),
              };
            }
          }

          // --- Older SSE counting (backwards compat) ---
          if (event === 'stage_transition') {
            const stageName = typeof payload?.stageName === 'string' ? payload.stageName : undefined;
            if (stageName) {
              stageNameSet.add(stageName);
              summary.stageTransitionCount += 1;
            }
          }

          if (event === 'progress') {
            const message = typeof payload?.message === 'string' ? payload.message : '';
            if (message.includes('DirectSkill[jank_frame_detail]')) {
              summary.directSkillProgressCount += 1;
            }
            if (message.includes('DirectSkillExecutor: completed')) {
              summary.directSkillCompletedCount += 1;
            }
          }

          if (event === 'finding') {
            const findingsContainer = asRecord(parsedRecord?.data);
            const findingsRaw = findingsContainer?.findings;
            if (Array.isArray(findingsRaw)) {
              for (const finding of findingsRaw) {
                const findingRecord = asRecord(finding);
                const source = typeof findingRecord?.source === 'string' ? findingRecord.source : '';
                if (source.includes('direct_skill:jank_frame_detail')) {
                  summary.directSkillFindingCount += 1;
                }
              }
            }
          }

          if (event === 'error') {
            const lifecycleCode = payload?.code ?? payload?.errorCode;
            if (typeof lifecycleCode === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,100}$/.test(lifecycleCode)) {
              throw new VerificationLifecycleError(lifecycleCode);
            }
            if (typeof payload?.message === 'string') {
              summary.errorEvents.push(payload.message);
            } else {
              summary.errorEvents.push(typeof parsed === 'string' ? parsed : 'Unknown SSE error event');
            }
          }

          if (!options.readUntilClose && terminal) {
            shouldStop = true;
            break;
          }
        }

        separatorIndex = buffer.indexOf('\n\n');
      }
    }

  } catch (error) {
    if (!observationFinished) {
      if (controller.signal.aborted) throw new VerificationSseTimeoutError();
      throw error;
    }
  } finally {
    clearTimeout(terminalObservation);
    clearTimeout(timeout);
    try { await reader?.cancel(); } catch {}
  }

  summary.stageNames = Array.from(stageNameSet);
  return summary;
}

interface ExternalIssueE2eVerification {
  checks: Record<string, boolean>;
  passed: boolean;
  summary: {
    opportunityStatus?: string;
    signalKinds: string[];
    reviewSource?: string;
    candidateDecisions: string[];
    candidateOwnership: string[];
    draftAttempted: boolean;
    draftNotSubmitted?: boolean;
    githubUrlIsHttps?: boolean;
  };
}

async function verifyExternalIssueTriage(
  baseUrl: string,
  sessionId: string,
  source: SseSummary['externalIssueSource'],
): Promise<ExternalIssueE2eVerification> {
  const summary: ExternalIssueE2eVerification['summary'] = {
    signalKinds: [],
    candidateDecisions: [],
    candidateOwnership: [],
    draftAttempted: false,
  };
  const checks: Record<string, boolean> = {
    externalIssueSourcePersisted: Boolean(source),
    externalIssueNegativeFeedbackStored: false,
    externalIssueOpportunityAvailable: false,
    externalIssueHasUserReportedInaccuracySignal: false,
    externalIssueAgentReviewUsed: false,
    externalIssueHasValidatedCandidates: false,
    externalIssueDraftBoundaryVerified: false,
  };
  if (!source) {
    return {checks, passed: false, summary};
  }

  const feedbackResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/feedback`,
    {
      rating: 'negative',
      runId: source.runId,
      targetKind: 'conclusion',
      targetId: source.runId,
      source: 'api',
      idempotencyKey: `external-issue-e2e:${source.runId}`,
    },
  );
  checks.externalIssueNegativeFeedbackStored =
    feedbackResponse.ok &&
    feedbackResponse.payload.durableFeedbackStored === true;
  if (!checks.externalIssueNegativeFeedbackStored) {
    return {checks, passed: false, summary};
  }

  const opportunityResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/opportunity`,
    source,
  );
  const opportunity = asRecord(opportunityResponse.payload.opportunity);
  summary.opportunityStatus =
    typeof opportunity?.status === 'string' ? opportunity.status : undefined;
  summary.signalKinds = Array.isArray(opportunity?.signals)
    ? opportunity.signals
      .map(item => asRecord(item)?.kind)
      .filter((kind): kind is string => typeof kind === 'string')
    : [];
  checks.externalIssueOpportunityAvailable =
    opportunityResponse.ok && opportunity?.status === 'available';
  checks.externalIssueHasUserReportedInaccuracySignal =
    summary.signalKinds.includes('user_reported_inaccuracy');
  if (!checks.externalIssueOpportunityAvailable) {
    return {checks, passed: false, summary};
  }

  const reviewResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/review`,
    source,
  );
  const review = asRecord(reviewResponse.payload.review);
  const candidates = Array.isArray(review?.candidates)
    ? review.candidates
      .map(candidate => asRecord(candidate))
      .filter((candidate): candidate is Record<string, unknown> => candidate !== null)
    : [];
  summary.reviewSource =
    typeof review?.source === 'string' ? review.source : undefined;
  summary.candidateDecisions = candidates
    .map(candidate => candidate.decision)
    .filter((decision): decision is string => typeof decision === 'string');
  summary.candidateOwnership = candidates
    .map(candidate => candidate.ownership)
    .filter((ownership): ownership is string => typeof ownership === 'string');
  checks.externalIssueAgentReviewUsed =
    reviewResponse.ok && review?.source === 'agent';
  checks.externalIssueHasValidatedCandidates =
    candidates.length > 0 && candidates.length <= 3;
  if (!checks.externalIssueAgentReviewUsed || candidates.length === 0) {
    return {checks, passed: false, summary};
  }

  const readyCandidate = candidates.find(candidate =>
    candidate.decision === 'report' || candidate.decision === 'needs_user_input');
  if (!readyCandidate || typeof readyCandidate.candidateId !== 'string') {
    checks.externalIssueDraftBoundaryVerified = summary.candidateDecisions.every(
      decision => decision === 'needs_verification' || decision === 'not_reportable',
    );
    return {
      checks,
      passed: Object.values(checks).every(Boolean),
      summary,
    };
  }

  const questions = Array.isArray(readyCandidate.userQuestions)
    ? readyCandidate.userQuestions
      .map(question => asRecord(question))
      .filter((question): question is Record<string, unknown> => question !== null)
    : [];
  const answers = questions
    .filter(question => typeof question.questionId === 'string')
    .map(question => ({
      questionId: question.questionId,
      answer: 'Reproduced by the isolated real-provider E2E run; no private trace content is attached.',
    }));
  summary.draftAttempted = true;
  const draftResponse = await postJsonResponse(
    baseUrl,
    `/api/agent/v1/${encodeURIComponent(sessionId)}/external-issue/draft`,
    {
      ...source,
      review,
      candidateId: readyCandidate.candidateId,
      answers,
      sensitiveDataReviewed: true,
    },
  );
  const draft = asRecord(draftResponse.payload.draft);
  summary.draftNotSubmitted = draft?.notSubmitted === true;
  summary.githubUrlIsHttps =
    typeof draft?.githubUrl === 'string' &&
    draft.githubUrl.startsWith('https://github.com/');
  checks.externalIssueDraftBoundaryVerified =
    draftResponse.ok &&
    summary.draftNotSubmitted &&
    summary.githubUrlIsHttps;
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
    summary,
  };
}

async function postJsonResponse(
  baseUrl: string,
  route: string,
  body: Record<string, unknown>,
): Promise<{
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
  }
  return {ok: response.ok, status: response.status, payload};
}

export function findSessionLogFile(sessionId: string): string | null {
  const logDir = backendLogPath('sessions');
  if (!fs.existsSync(logDir)) {
    return null;
  }
  const prefix = `session_${sessionId}_`;
  const files = fs
    .readdirSync(logDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .sort();

  if (files.length === 0) {
    return null;
  }

  return path.join(logDir, files[files.length - 1]);
}

/** Preserve this task's session evidence before isolated runtime cleanup, without credentials. */
export function preserveVerificationSessionLog(outputPath: string, sessionId: string): {
  sessionLogFile?: string; lifecycleErrorCode?: string;
} {
  if (!sessionId) return {};
  const source = findSessionLogFile(sessionId);
  if (!source) return {};
  const secrets = Object.entries(process.env).filter(([key, value]) =>
    /key|token|password|secret|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key,
      /authorization|api[-_]?key|password|secret|credential|cookie|accessToken|refreshToken/i.test(key) ? '[REDACTED]' : redact(nested)]));
  };
  let lifecycleErrorCode: string | undefined;
  const entries = fs.readFileSync(source, 'utf8').split('\n').filter(Boolean).map(line => {
    let entry: Record<string, unknown>;
    try {entry = JSON.parse(line);} catch {return JSON.stringify({unparsedLineHash: createHash('sha256').update(line).digest('hex')});}
    const error = asRecord(entry.error);
    if (entry.level === 'error' && typeof error?.message === 'string' && /^[a-z][a-z0-9_]{3,100}$/.test(error.message)) {
      lifecycleErrorCode = error.message;
    }
    return JSON.stringify(redact(entry));
  });
  const sessionLogFile = `${outputPath}.session-log.jsonl`;
  fs.mkdirSync(path.dirname(sessionLogFile), {recursive: true});
  fs.writeFileSync(sessionLogFile, `${entries.join('\n')}\n`);
  return {sessionLogFile, ...(lifecycleErrorCode ? {lifecycleErrorCode} : {})};
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.tracePath)) {
    throw new Error(`Trace file not found: ${options.tracePath}`);
  }
  if (options.referenceTracePath && !fs.existsSync(options.referenceTracePath)) {
    throw new Error(`Reference trace file not found: ${options.referenceTracePath}`);
  }

  const runtimeSelection = resolveAgentRuntimeSelection(options.providerId);
  if (runtimeSelection.kind === 'openai-agents-sdk' && !hasOpenAICredentials(options.providerId)) {
    const diagnostics = getOpenAIRuntimeDiagnostics(options.providerId);
    throw new Error(
      'OpenAI Agents SDK runtime is selected but no usable OpenAI-compatible credentials were found. ' +
      diagnostics.configHint
    );
  }

  const traceProcessorService = getTraceProcessorService();
  let server: ReturnType<express.Express['listen']> | undefined;
  let baseUrl = '';
  let traceId = '';
  let referenceTraceId = '';
  let sessionId = '';
  let ownedRunId = '';
  let phase = 'context_setup';
  let sceneObservation: SceneSseObservation | undefined;
  let sceneBounds: {startNs: string; endNs: string} | undefined;
  let sceneOracles: SceneOracleObservation[] = [];
  let selectionResolution: ResolvedVerificationSliceSelection | undefined;
  const startedAt = Date.now();
  const outputPath = options.outputPath ?? path.resolve(process.cwd(), `test-output/verify-agent-sse-scrolling-${startedAt}.json`);
  const diagnostics = installVerificationDiagnostics({phase: () => phase});
  let diagnosticsWritten = false;
  const persistDiagnostics = () => {
    if (diagnosticsWritten) return;
    diagnosticsWritten = true;
    writeVerificationDiagnostics(outputPath, diagnostics.stop());
  };

  try {
    const app = createVerificationApp();
    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind local verification server');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = await setupAnalysisContext(baseUrl, options);
    phase = 'trace_load';
    await loadVerificationTracePair({service: traceProcessorService, tracePath: options.tracePath,
      referenceTracePath: options.referenceTracePath, onLoaded: (id, side) => {
        if (side === 'current') traceId = id;
        else referenceTraceId = id;
      }});
    if (options.sliceSelectionTarget) {
      phase = 'selection_resolution';
      selectionResolution = await resolveVerificationSliceSelection({service: traceProcessorService,
        traceId, selector: options.sliceSelectionTarget, timeoutMs: options.timeoutMs});
      options.selectionContext = selectionResolution.selectionContext;
    }
    phase = 'trace_oracle';
    if (options.entry === 'scene-reconstruction') {
      const bounds = await traceProcessorService.query(traceId,
        'SELECT CAST(start_ts AS TEXT) AS start_ns, CAST(end_ts AS TEXT) AS end_ns FROM trace_bounds');
      const start = bounds.rows?.[0]?.[bounds.columns.indexOf('start_ns')];
      const end = bounds.rows?.[0]?.[bounds.columns.indexOf('end_ns')];
      if (bounds.error || typeof start !== 'string' || typeof end !== 'string' || !/^\d+$/.test(start) || !/^\d+$/.test(end)) {
        throw new Error('SCENE_ORACLE_BOUNDS_UNAVAILABLE');
      }
      sceneBounds = {startNs: start, endNs: end};
      sceneOracles = await collectSceneOracleRows(options.sceneOracles || [], sql => traceProcessorService.query(traceId, sql));
    }

    const oracleEvidence = options.expectation ? await collectAgentSseOracleEvidence({
      expectation: options.expectation, traceId, referenceTraceId, service: traceProcessorService, deadlineMs: startedAt + options.timeoutMs,
      scope: {tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID, userId: DEFAULT_DEV_USER_ID},
    }) : undefined;
    const oracleRows = oracleEvidence?.rows;
    await writeTraceMetadata({
      id: traceId,
      filename: path.basename(options.tracePath),
      size: fs.statSync(options.tracePath).size,
      uploadedAt: new Date().toISOString(),
      status: 'ready',
      path: traceProcessorService.getTraceFilePath(traceId),
      tenantId: DEFAULT_TENANT_ID,
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: DEFAULT_DEV_USER_ID,
    });

    let tracePairContext: TracePairContext | undefined;
    if (options.referenceTracePath) {
      await writeTraceMetadata({
        id: referenceTraceId,
        filename: path.basename(options.referenceTracePath),
        size: fs.statSync(options.referenceTracePath).size,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: traceProcessorService.getTraceFilePath(referenceTraceId),
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        userId: DEFAULT_DEV_USER_ID,
      });
      tracePairContext = buildTracePairContextForVerification({
        options,
        traceId,
        referenceTraceId,
      });
    }

    phase = 'analysis_start';
    const startResponse = await fetch(`${baseUrl}/api/agent/v1/${options.entry === 'scene-reconstruction' ? 'scene-reconstruct' : 'analyze'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traceId,
        query: options.query,
        ...(referenceTraceId ? { referenceTraceId } : {}),
        ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
        ...(options.traceContext ? { traceContext: options.traceContext } : {}),
        ...(options.selectionContext ? { selectionContext: options.selectionContext } : {}),
        options: {
          ...(options.preset ? { preset: options.preset } : {}),
          ...(options.smartAction ? { smartAction: options.smartAction } : {}),
          ...(options.smartSelection ? { smartSelection: options.smartSelection } : {}),
          ...(options.forceRefresh ? { forceRefresh: true } : {}),
          ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}),
          ...(options.codeAwareMode ? { codeAwareMode: options.codeAwareMode } : {}),
          ...(options.codebaseIds.length > 0 ? { codebaseIds: options.codebaseIds } : {}),
          ...(options.knowledgeSourceIds.length > 0
            ? { knowledgeSourceIds: options.knowledgeSourceIds }
            : {}),
          ...(tracePairContext ? { tracePairContext } : {}),
        },
      }),
    });

    const startJson = (await startResponse.json()) as Record<string, unknown>;
    if (!startResponse.ok || typeof startJson.sessionId !== 'string') {
      throw new Error(`Analyze request failed: ${JSON.stringify(startJson)}`);
    }
    sessionId = startJson.sessionId;
    ownedRunId = typeof startJson.runId === 'string' ? startJson.runId : '';
    if (!ownedRunId) throw new Error('Analyze request did not identify the owned run');

    phase = 'analysis_stream';
    const sceneScope = {traceId, sessionId, runId: ownedRunId};
    const persistSceneObservation = () => {
      if (!sceneObservation) return;
      fs.mkdirSync(path.dirname(outputPath), {recursive: true});
      fs.writeFileSync(`${outputPath}.scene-events.json`, JSON.stringify({scope: sceneScope, observation: sceneObservation}, null, 2));
    };
    if (options.entry === 'scene-reconstruction') {sceneObservation = createSceneSseObservation(); persistSceneObservation();}
    const observeSceneEvent = sceneObservation ? async (event: string, payload: unknown) => {
      const observed = sceneObservation!;
      recordSceneSseEvent(observed, event, payload, sceneScope);
      if (event === 'scene_timeline_updated' || SCENE_RUN_TERMINAL_EVENTS.has(event)) persistSceneObservation();
      if (options.sceneScenario === 'cancel' && event === 'scene_timeline_updated' && observed.cancelRequestedAt === undefined) {
        observed.cancelRequestedAt = observed.events;
        persistSceneObservation();
        const response = await fetch(`${baseUrl}/api/agent/v1/scene-reconstruct/${sessionId}/cancel`, {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({runId: ownedRunId}), signal: AbortSignal.timeout(10000)});
        const cancelled = asRecord(await response.json());
        observed.cancelConfirmed = response.ok && cancelled?.success === true && cancelled.runId === ownedRunId;
        persistSceneObservation();
      }
    } : undefined;
    const sse = await collectSseSummary(baseUrl, sessionId, options.timeoutMs, {
      requiredText: options.requiredText,
      forbiddenText: options.forbiddenText,
    }, {runId: ownedRunId, ...(observeSceneEvent ? {observeEvent: observeSceneEvent, readUntilClose: true, terminalObservationMs: options.sceneObservationMs ?? 2000} : {})});
    phase = 'analysis_verification';
    if (sceneObservation && sceneBounds) {
      const observationMs = options.sceneObservationMs ?? 2000;
      await new Promise(resolve => setTimeout(resolve, observationMs));
      const replay = createSceneSseObservation();
      await collectSseSummary(baseUrl, sessionId, Math.min(options.timeoutMs, 30000), {requiredText: [], forbiddenText: []},
        {runId: ownedRunId, readUntilClose: true, terminalObservationMs: observationMs, observeEvent: (event, payload) => recordSceneSseEvent(replay, event, payload, sceneScope)});
      const statusResponse = await fetch(`${baseUrl}/api/agent/v1/${sessionId}/status`, {signal: AbortSignal.timeout(10000)});
      const status: unknown = statusResponse.ok ? await statusResponse.json() : {httpStatus: statusResponse.status};
      let report: unknown;
      if (sceneObservation.reportRef) {
        const response = await fetch(`${baseUrl}/api/agent/v1/scene-reconstruct/report/${encodeURIComponent(sceneObservation.reportRef.reportId)}`, {signal: AbortSignal.timeout(10000)});
        report = response.ok ? await response.json() : {httpStatus: response.status};
      }
      const verified = evaluateSceneSseVerification({observation: sceneObservation, replay, scope: sceneScope, status, report,
        start: startJson, bounds: sceneBounds, scenario: options.sceneScenario ?? 'complete', minRevision: options.sceneMinRevision ?? 1,
        runtime: runtimeSelection.kind, providerId: options.providerId, observationMs});
      const oracleChecks = evaluateSceneOracleRows(sceneObservation.finalTimeline, sceneOracles);
      Object.assign(verified.checks, oracleChecks);
      verified.passed = verified.passed && Object.values(oracleChecks).every(Boolean);
      if (!sceneOracles.length) verified.uncoveredFacets.push('independent_scene_interval_and_object_oracles_not_configured');
      const output = {schemaVersion: 'scene_sse_verification@1', timestamp: new Date().toISOString(), tracePath: options.tracePath,
        runtime: runtimeSelection.kind, providerId: options.providerId, ...sceneScope, bounds: sceneBounds, sceneOracles, ...verified,
        passedMeaning: 'scene_route_runtime_revision_and_public_report_checks_only',
        ...taskAcceptanceStatus(verified.passed, verified.uncoveredFacets), observation: sceneObservation, replay, status, report,
        ...preserveVerificationSessionLog(outputPath, sessionId)};
      fs.mkdirSync(path.dirname(outputPath), {recursive: true});
      fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
      console.log(JSON.stringify({outputPath, passed: verified.passed, checks: verified.checks, uncoveredFacets: verified.uncoveredFacets}, null, 2));
      if (!verified.passed) process.exitCode = 1;
      return;
    }

    const taskVerification = options.expectation ? evaluateAgentSseExpectation({
      terminal: sse.terminalAnalysis, expectation: options.expectation, traceId, referenceTraceId, oracleRows,
      oracleNativeSchemas: oracleEvidence?.schemas,
    }) : undefined;
    const auditedLookupCounts = successfulCodeLookupToolCounts(
      CodeLookupLedger.restore(sessionId, 12_000, 2).getEntries(),
    );
    sse.successfulLookupCounts = auditedLookupCounts;
    for (const [toolName, count] of Object.entries(auditedLookupCounts)) {
      // The audit and SSE describe the same calls; the ledger is a lower bound
      // for older private projections, not another set of executions to add.
      sse.toolCallCounts[toolName] = Math.max(sse.toolCallCounts[toolName] ?? 0, count);
    }

    // Quick-mode analyses skip plan submission. Architecture detection can still
    // be emitted by the deterministic prepass before the lightweight agent path.
    // Don't use agent_response count as a quick/full classifier. Quick has a
    // 5-turn product target but a larger hard cap, and runtime adapters differ.
    const isQuickMode = sse.planSubmittedCount === 0;

    const smartMode = options.preset === 'smart';
    const capabilityLimitedRuntime = options.allowCapabilityLimitedRuntime;
    const requiredChecks = {
      hasProgressEvents: sse.progressCount > 0,
      ...(smartMode || capabilityLimitedRuntime || isQuickMode || options.expectation ? {} : { hasAgentResponses: sse.agentResponseCount > 0 }),
      hasTerminalConclusionPayload: sse.conclusionCount > 0 || sse.analysisCompletedConclusionChars > 0,
      hasAnalysisCompletedEvent: sse.terminalEvent === 'analysis_completed' || sse.terminalEvent === 'end',
      hasNoSseErrors: sse.errorEvents.length === 0,
    };

    const fullModeChecks = smartMode || capabilityLimitedRuntime || options.expectation
      ? {}
      : {
        ...(options.allowNoDataEnvelopes ? {} : { hasDataEnvelopes: sse.dataEnvelopeCount > 0 }),
        hasPlanSubmitted: sse.planSubmittedCount > 0,
        hasArchitectureDetected: sse.architectureDetectedCount > 0,
      };
    const dualTraceChecks = options.referenceTracePath
      ? {
        hasReferenceTraceId: referenceTraceId.length > 0,
        hasTracePairContext: Boolean(tracePairContext),
      }
      : {};

    // Mode expectation: if the caller pinned `--mode fast|full`, verify the backend honored it.
    // Catches regressions where a fast CLI flag silently falls back to the full pipeline (or vice versa).
    const modeExpectationChecks: Record<string, boolean> = {};
    if (!capabilityLimitedRuntime && options.analysisMode === 'fast') {
      modeExpectationChecks.fastModeHonored = options.expectation ? sse.quickRun?.resolvedMode === 'quick' : isQuickMode;
    } else if (!capabilityLimitedRuntime && options.analysisMode === 'full' && !options.expectation) {
      modeExpectationChecks.fullModeHonored = !isQuickMode;
    }
    const conclusionEvidenceChecks = options.requireConclusionEvidence
      ? {
        hasAnalysisCompletedConclusion: sse.analysisCompletedConclusionChars > 0,
        hasAnalysisCompletedConclusionEvidence: sse.analysisCompletedHasConcreteEvidenceRefs,
      }
      : {};
    const codeReferenceChecks = options.requireCodeRef
      ? {
        hasConcreteCodeReferences:
          sse.conclusionHasConcreteCodeRefs || sse.analysisCompletedHasConcreteCodeRefs,
      }
      : {};
    const claimVerifierChecks = options.requireClaimVerifierOk
      ? {
        hasClaimVerifierResult: Boolean(sse.claimVerifierStatus),
        claimVerifierPassed: sse.claimVerifierStatus === 'passed' && sse.claimVerifierPassed !== false,
        claimVerifierHasNoUnsupportedClaims: (sse.claimVerifierUnsupportedClaimCount ?? 0) === 0,
      }
      : {};
    const partialChecks = options.requireNonPartial
      ? {
        analysisCompletedNotPartial: sse.analysisCompletedPartial !== true,
      }
      : {};
    const finalReportHeadingChecks = options.requireFinalReportHeading
      ? {
        analysisCompletedHasFinalReportHeading: sse.analysisCompletedHasFinalReportHeading,
      }
      : {};
    const processNarrationChecks = options.forbidProcessNarration
      ? {
        analysisCompletedHasNoProcessNarration: !sse.analysisCompletedHasProcessNarration,
      }
      : {};
    const conclusionLengthChecks = options.maxAnalysisCompletedConclusionChars !== undefined
      ? {
        analysisCompletedConclusionWithinMaxChars:
          sse.analysisCompletedConclusionChars <= options.maxAnalysisCompletedConclusionChars,
      }
      : {};
    const requiredTextChecks = Object.fromEntries(
      options.requiredText.map((text) => [`requiresText:${text}`, sse.requiredTextMatches[text] === true]),
    );
    const forbiddenTextChecks = Object.fromEntries(
      options.forbiddenText.map((text) => [`forbidsText:${text}`, sse.forbiddenTextMatches[text] !== true]),
    );
    const requiredToolChecks = Object.fromEntries(
      options.requiredTools.map((toolName) => [`requiresTool:${toolName}`, (sse.toolCallCounts[toolName] ?? 0) > 0]),
    );
    const requiredSuccessfulLookupChecks = Object.fromEntries(
      options.requiredSuccessfulLookups.map((toolName) => [
        `requiresSuccessfulLookup:${toolName}`,
        (sse.successfulLookupCounts[toolName] ?? 0) > 0,
      ]),
    );
    const requiredSkillChecks = Object.fromEntries(
      options.requiredSkills.map((skillId) => [`requiresSkill:${skillId}`, (sse.skillCallCounts[skillId] ?? 0) > 0]),
    );
    const degradedFallbackChecks = Object.fromEntries(
      options.forbiddenDegradedFallbacks.map((fallback) => [
        `forbidsDegradedFallback:${fallback}`,
        (sse.degradedFallbackCounts[fallback] ?? 0) === 0,
      ]),
    );
    const dataEnvelopeChecks = options.requireDataEnvelope
      ? { hasRequiredDataEnvelope: sse.dataEnvelopeCount > 0 }
      : {};
    const quickRunChecks = options.requireQuickRun
      ? {
        hasQuickRunReceipt: Boolean(sse.quickRun),
        quickRunResolvedQuick: sse.quickRun?.resolvedMode === 'quick',
        quickRunHasTurnBudget:
          typeof sse.quickRun?.targetTurns === 'number' &&
          typeof sse.quickRun?.hardCapTurns === 'number' &&
          (sse.quickRun?.targetTurns ?? 0) <= (sse.quickRun?.hardCapTurns ?? 0),
      }
      : {};
    const externalIssueVerification = options.requireExternalIssueTriage
      ? await verifyExternalIssueTriage(
        baseUrl,
        sessionId,
        sse.externalIssueSource,
      )
      : undefined;
    const externalIssueChecks = externalIssueVerification?.checks ?? {};
    const checks = {
      ...taskVerification?.checks,
      ...requiredChecks,
      ...fullModeChecks,
      ...dualTraceChecks,
      ...modeExpectationChecks,
      ...conclusionEvidenceChecks,
      ...codeReferenceChecks,
      ...claimVerifierChecks,
      ...partialChecks,
      ...finalReportHeadingChecks,
      ...processNarrationChecks,
      ...conclusionLengthChecks,
      ...requiredTextChecks,
      ...forbiddenTextChecks,
      ...requiredToolChecks,
      ...requiredSuccessfulLookupChecks,
      ...requiredSkillChecks,
      ...degradedFallbackChecks,
      ...dataEnvelopeChecks,
      ...quickRunChecks,
      ...externalIssueChecks,
    };
    let passed = Object.values(taskVerification?.checks ?? {}).every(Boolean)
      && Object.values(requiredChecks).every(Boolean)
      && Object.values(modeExpectationChecks).every(Boolean)
      && Object.values(dualTraceChecks).every(Boolean)
      && Object.values(conclusionEvidenceChecks).every(Boolean)
      && Object.values(codeReferenceChecks).every(Boolean)
      && Object.values(claimVerifierChecks).every(Boolean)
      && Object.values(partialChecks).every(Boolean)
      && Object.values(finalReportHeadingChecks).every(Boolean)
      && Object.values(processNarrationChecks).every(Boolean)
      && Object.values(conclusionLengthChecks).every(Boolean)
      && Object.values(requiredTextChecks).every(Boolean)
      && Object.values(forbiddenTextChecks).every(Boolean)
      && Object.values(requiredToolChecks).every(Boolean)
      && Object.values(requiredSuccessfulLookupChecks).every(Boolean)
      && Object.values(requiredSkillChecks).every(Boolean)
      && Object.values(degradedFallbackChecks).every(Boolean)
      && Object.values(dataEnvelopeChecks).every(Boolean)
      && Object.values(quickRunChecks).every(Boolean)
      && Object.values(externalIssueChecks).every(Boolean)
      && (isQuickMode || Object.values(fullModeChecks).every(Boolean));
    let followUpOutput: Record<string, unknown> | undefined;
    if (options.followUpQuery) {
      phase = 'follow_up_start';
      const followUpResponse = await fetch(`${baseUrl}/api/agent/v1/sessions/${sessionId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId,
          query: options.followUpQuery,
          ...(referenceTraceId ? { referenceTraceId } : {}),
          ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
          ...(options.selectionContext ? { selectionContext: options.selectionContext } : {}),
          options: {
            analysisMode: options.followUpAnalysisMode,
            ...(options.codeAwareMode ? { codeAwareMode: options.codeAwareMode } : {}),
            ...(options.codebaseIds.length > 0 ? { codebaseIds: options.codebaseIds } : {}),
            ...(options.knowledgeSourceIds.length > 0
              ? { knowledgeSourceIds: options.knowledgeSourceIds }
              : {}),
            ...(tracePairContext ? { tracePairContext } : {}),
          },
        }),
      });
      const followUpStartJson = (await followUpResponse.json()) as Record<string, unknown>;
      if (
        !followUpResponse.ok ||
        typeof followUpStartJson.sessionId !== 'string' ||
        typeof followUpStartJson.runId !== 'string'
      ) {
        throw new Error(`Follow-up analyze request failed: ${JSON.stringify(followUpStartJson)}`);
      }

      ownedRunId = followUpStartJson.runId;
      phase = 'follow_up_stream';
      const followUpSse = await collectSseSummary(
        baseUrl,
        sessionId,
        options.timeoutMs,
        {
          requiredText: options.followUpRequiredText,
          forbiddenText: [],
        },
        { runId: followUpStartJson.runId },
      );
      phase = 'follow_up_verification';
      const followUpChecks = buildFollowUpVerificationChecks(followUpSse, options);
      const followUpPassed = Object.values(followUpChecks).every(Boolean);
      passed = passed && followUpPassed;
      followUpOutput = {
        query: options.followUpQuery,
        requestedAnalysisMode: options.followUpAnalysisMode,
        resolvedAnalysisMode: followUpSse.quickRun?.resolvedMode,
        runId: followUpStartJson.runId,
        checks: followUpChecks,
        passed: followUpPassed,
        summary: followUpSse,
      };
    }
    const preservedSessionLog = preserveVerificationSessionLog(outputPath, sessionId);

    const output = {
      timestamp: new Date().toISOString(),
      tracePath: options.tracePath,
      referenceTracePath: options.referenceTracePath,
      query: options.query,
      preset: options.preset,
      selectionContext: options.selectionContext,
      selectionResolution,
      analysisContext: {
        codeAwareMode: options.codeAwareMode ?? 'off',
        codebaseIds: options.codebaseIds,
        knowledgeSourceIds: options.knowledgeSourceIds,
        setup,
      },
      traceId,
      referenceTraceId: referenceTraceId || undefined,
      tracePairContext,
      sessionId,
      checks,
      passed,
      taskVerification,
      oracleNativeSchemas: oracleEvidence?.schemas,
      passedMeaning: 'observed_transport_and_task_checks_only',
      ...taskAcceptanceStatus(passed, taskVerification?.uncoveredFacets ?? ['task semantics not evaluated']),
      exactTextChecksPurpose: 'transport_or_canary_only_not_semantic_correctness',
      summary: sse,
      externalIssue: externalIssueVerification?.summary,
      followUp: followUpOutput,
      ...preservedSessionLog,
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

    console.log(JSON.stringify(output, null, 2));
    console.log(`Report written to: ${outputPath}`);

    if (!passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Failure cancellation is cleanup too: preserve observations before it waits.
    persistDiagnostics();
    const failure = await recordVerificationFailureAndCancel({baseUrl, outputPath, phase,
      startedAt, timeoutMs: options.timeoutMs, sessionId, runId: ownedRunId, error, selectionResolution});
    throw new Error(`Verification failed during ${phase}: ${failure.errorCode}; failure artifact recorded`);
  } finally {
    persistDiagnostics();
    try {preserveVerificationSessionLog(outputPath, sessionId);} catch { /* Preserve the primary outcome if diagnostic copying fails. */ }
    if (sessionId !== '' && !options.keepSession) {
      try {
        await fetch(`${baseUrl}/api/agent/v1/${sessionId}`, { method: 'DELETE' });
      } catch {
      }
    }

    if (traceId !== '' && !options.keepTrace) {
      try {
        await traceProcessorService.deleteTrace(traceId);
      } catch {
      }
    }

    if (referenceTraceId !== '' && !options.keepTrace) {
      try {
        await traceProcessorService.deleteTrace(referenceTraceId);
      } catch {
      }
    }

    if (server) await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
}

if (require.main === module) {
  main().then(() => {
    // The verdict and artifacts are written; trace processors, SDK children and keep-alive
    // sockets would otherwise hold the loop open, so batch callers needed an external watchdog.
    TraceProcessorFactory.cleanup();
    process.stdout.write('', () => process.exit(process.exitCode ?? 0));
  }, (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
