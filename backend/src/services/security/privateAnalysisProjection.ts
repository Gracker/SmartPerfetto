// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {localize, type OutputLanguage} from '../../agentv3/outputLanguage';
import type {SessionStateSnapshot} from '../../agentv3/sessionStateSnapshot';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {AnalysisReceipt} from '../../types/dataContract';
import type {DataEnvelope, UiActionProposalV1} from '../../types/dataContract';
import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {ClaimSupportV1} from '../../types/evidenceContract';
import type {ClaimVerificationResult} from '../../types/claimVerification';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {sanitizeCodeAwareText} from './codeAwareOutputRegistry';
import type {CodeLookupSummary} from '../codebase/codeLookupLedger';
import {isCodebaseKind} from '../codebase/codebaseRegistry';
import {sanitizeStoredCapabilityManifestAttribution} from '../capabilityManifest';
import {sanitizeStoredTraceSummaryAttribution} from '../traceSummaryAttribution';

type PrivateFinding = AnalysisResult['findings'][number];
type PrivateHypothesis = AnalysisResult['hypotheses'][number];

export interface PrivateAnalysisSessionSelection {
  sessionId: string;
  codeAwareMode?: string;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
}

const SAFE_TERMINATION_REASONS = new Set([
  'max_turns',
  'max_budget_usd',
  'max_structured_output_retries',
  'execution_error',
  'timeout',
  'plan_incomplete',
]);
const MAX_PRIVATE_PROVENANCE_IDS = 100;
const MAX_PRIVATE_SOURCE_GENERATIONS = 20;
const MAX_PRIVATE_DISPLAY_NAME = 120;

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

function strictBoundedIdentifier(value: unknown): string | undefined {
  const bounded = boundedIdentifier(value);
  if (
    !bounded ||
    bounded.includes('/') ||
    bounded.includes('\\') ||
    bounded.includes('://') ||
    /[\s\u0000-\u001f\u007f]/.test(bounded)
  ) {
    return undefined;
  }
  return bounded;
}

function boundedDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('://')) {
    return undefined;
  }
  return trimmed.slice(0, MAX_PRIVATE_DISPLAY_NAME);
}

function projectPrivateCodeLookupSummary(
  summary: CodeLookupSummary | undefined,
): CodeLookupSummary | undefined {
  if (!summary) return undefined;
  const referencedCodebaseIds = summary.referencedCodebaseIds
    .map(strictBoundedIdentifier)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  const usedCodebaseIds = summary.usedCodebaseIds
    ?.map(strictBoundedIdentifier)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  const usedKnowledgeSources = summary.usedKnowledgeSources
    ?.map(source => {
      const knowledgeSourceId = boundedIdentifier(source.knowledgeSourceId);
      if (!knowledgeSourceId) return undefined;
      return {
        knowledgeSourceId,
        sourceGenerations: source.sourceGenerations
          .map(boundedIdentifier)
          .filter((value): value is string => Boolean(value))
          .slice(0, MAX_PRIVATE_SOURCE_GENERATIONS),
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  return {
    lookupCount: Math.max(0, Math.min(1_000_000, Math.floor(summary.lookupCount || 0))),
    patchCount: Math.max(0, Math.min(1_000_000, Math.floor(summary.patchCount || 0))),
    referencedCodebaseIds,
    ...(usedCodebaseIds?.length ? {usedCodebaseIds} : {}),
    ...(usedKnowledgeSources?.length ? {usedKnowledgeSources} : {}),
  };
}

function projectPrivateIdList(values: string[] | undefined): string[] | undefined {
  const projected = values
    ?.map(strictBoundedIdentifier)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  return projected?.length ? projected : undefined;
}

function projectPrivateCodebaseSnapshot(
  snapshot: SessionStateSnapshot['codebaseSnapshot'],
): SessionStateSnapshot['codebaseSnapshot'] {
  if (!snapshot) return undefined;
  return snapshot
    .map(item => {
      const codebaseId = strictBoundedIdentifier(item.codebaseId);
      if (!codebaseId) return undefined;
      const displayName = boundedDisplayName(item.displayName);
      const kind = isCodebaseKind(item.kind) ? item.kind : undefined;
      return {
        codebaseId,
        ...(displayName ? {displayName} : {}),
        ...(kind ? {kind} : {}),
        indexGeneration: Math.max(0, Math.min(1_000_000, Math.floor(item.indexGeneration || 0))),
        ...(strictBoundedIdentifier(item.activeGeneration) ? {activeGeneration: strictBoundedIdentifier(item.activeGeneration)} : {}),
        ...(strictBoundedIdentifier(item.contentFingerprint) ? {contentFingerprint: strictBoundedIdentifier(item.contentFingerprint)} : {}),
        ...(strictBoundedIdentifier(item.indexedRevision) ? {indexedRevision: strictBoundedIdentifier(item.indexedRevision)} : {}),
        ...(typeof item.indexedDirty === 'boolean' ? {indexedDirty: item.indexedDirty} : {}),
        ...(item.commitProvenance === 'clean_git_revision' ||
          item.commitProvenance === 'dirty_git_worktree' ||
          item.commitProvenance === 'content_only'
          ? {commitProvenance: item.commitProvenance}
          : {}),
        ...(strictBoundedIdentifier(item.consentHash) ? {consentHash: strictBoundedIdentifier(item.consentHash)} : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
}

export function sessionUsesPrivateKnowledge(
  session: Omit<PrivateAnalysisSessionSelection, 'sessionId'>,
): boolean {
  return Boolean(
    (session.codeAwareMode && session.codeAwareMode !== 'off' && session.codebaseIds?.length) ||
    session.knowledgeSourceIds?.length,
  );
}

export function privateAnalysisFailureMessage(language: OutputLanguage): string {
  return localize(
    language,
    '分析未能完成；详细模型或工具错误已按隐私策略隐藏。',
    'Analysis did not complete; detailed model or tool errors are hidden by the privacy policy.',
  );
}

export function privateAnalysisQueryMessage(language: OutputLanguage): string {
  return localize(
    language,
    '私有源码或知识库分析请求（原始内容未持久化）',
    'Private source or knowledge analysis request (original content not persisted)',
  );
}

export function projectPrivateConclusion(input: {
  sessionId: string;
  conclusion: unknown;
  success: boolean;
  language: OutputLanguage;
}): string {
  if (!input.success) return privateAnalysisFailureMessage(input.language);
  return sanitizeCodeAwareText(input.sessionId, String(input.conclusion ?? ''));
}

export function projectPrivateTerminationReason(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TERMINATION_REASONS.has(value)
    ? value
    : undefined;
}

export function projectPrivateTerminationMessage(
  value: unknown,
  language: OutputLanguage,
): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : privateAnalysisFailureMessage(language);
}

export function projectPrivateAnalysisReceipt(
  receipt: AnalysisReceipt | undefined,
): AnalysisReceipt | undefined {
  if (!receipt) return undefined;
  const {
    capabilityManifest: storedCapabilityManifest,
    traceSummary: storedTraceSummary,
    ...receiptWithoutAttribution
  } = receipt;
  const capabilityManifest = sanitizeStoredCapabilityManifestAttribution(
    storedCapabilityManifest,
  );
  const traceSummary = sanitizeStoredTraceSummaryAttribution(storedTraceSummary);
  return {
    ...receiptWithoutAttribution,
    ...(capabilityManifest ? {capabilityManifest} : {}),
    ...(traceSummary ? {traceSummary} : {}),
    outputs: {
      ...(receipt.outputs.reportId ? {reportId: receipt.outputs.reportId} : {}),
      ...(receipt.outputs.reportUrl ? {reportUrl: receipt.outputs.reportUrl} : {}),
      ...(receipt.outputs.resultSnapshotId
        ? {resultSnapshotId: receipt.outputs.resultSnapshotId}
        : {}),
    },
  };
}

const PRIVATE_ENVELOPE_FORBIDDEN_KEYS = new Set([
  'sql',
  'rawsql',
  'executablesql',
  'query',
  'queryreview',
  'prompt',
  'arguments',
  'toolarguments',
]);

function projectPrivateEnvelopeValue(
  sessionId: string,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 24) return undefined;
  if (typeof value === 'string') return sanitizeCodeAwareText(sessionId, value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => projectPrivateEnvelopeValue(sessionId, item, depth + 1))
      .filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return undefined;

  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
    if (PRIVATE_ENVELOPE_FORBIDDEN_KEYS.has(normalizedKey)) continue;
    const projectedEntry = projectPrivateEnvelopeValue(sessionId, entry, depth + 1);
    if (projectedEntry !== undefined) projected[key] = projectedEntry;
  }
  return projected;
}

/**
 * Field-level projection for model-authored structured artifacts. It preserves
 * the contract shape and trace provenance while removing SQL/prompt/query
 * fields and applying the same registered-source echo guard to every string.
 */
export function projectPrivateStructuredValue<T>(sessionId: string, value: T): T {
  return projectPrivateEnvelopeValue(sessionId, value) as T;
}

export function projectPrivateFindings(
  sessionId: string,
  findings: readonly PrivateFinding[] | undefined,
): PrivateFinding[] {
  return (findings ?? []).map(finding => projectPrivateStructuredValue(sessionId, finding));
}

export function projectPrivateHypotheses(
  sessionId: string,
  hypotheses: readonly PrivateHypothesis[] | undefined,
): PrivateHypothesis[] {
  return (hypotheses ?? []).map(hypothesis => projectPrivateStructuredValue(sessionId, hypothesis));
}

export function projectPrivateConclusionContract(
  sessionId: string,
  contract: ConclusionContract | undefined,
): ConclusionContract | undefined {
  return contract ? projectPrivateStructuredValue(sessionId, contract) : undefined;
}

export function projectPrivateClaimSupport(
  sessionId: string,
  support: readonly ClaimSupportV1[] | undefined,
): ClaimSupportV1[] | undefined {
  return support ? support.map(item => projectPrivateStructuredValue(sessionId, item)) : undefined;
}

export function projectPrivateClaimVerification(
  sessionId: string,
  verification: ClaimVerificationResult | undefined,
): ClaimVerificationResult | undefined {
  return verification ? projectPrivateStructuredValue(sessionId, verification) : undefined;
}

export function projectPrivateIdentityResolutions(
  sessionId: string,
  resolutions: readonly IdentityResolutionV1[] | undefined,
): IdentityResolutionV1[] | undefined {
  return resolutions
    ? resolutions.map(resolution => projectPrivateStructuredValue(sessionId, resolution))
    : undefined;
}

export function projectPrivateUiActionProposals(
  sessionId: string,
  proposals: readonly UiActionProposalV1[] | undefined,
): UiActionProposalV1[] {
  return (proposals ?? []).map(proposal => projectPrivateStructuredValue(sessionId, proposal));
}

/**
 * Project trace-derived evidence before it crosses a live or durable private
 * boundary. Envelope shape validation is not a provenance proof: SQL literals
 * and model-authored metadata can otherwise carry retrieved source verbatim.
 */
export function projectPrivateDataEnvelope(
  sessionId: string,
  envelope: DataEnvelope,
): DataEnvelope {
  const meta = envelope.meta;
  const projectedMeta: DataEnvelope['meta'] = {
    type: meta.type,
    version: meta.version,
    source: sanitizeCodeAwareText(sessionId, meta.source),
    timestamp: meta.timestamp,
    ...(meta.skillId ? {skillId: sanitizeCodeAwareText(sessionId, meta.skillId)} : {}),
    ...(meta.stepId ? {stepId: sanitizeCodeAwareText(sessionId, meta.stepId)} : {}),
    ...(meta.executionStatus ? {executionStatus: meta.executionStatus} : {}),
    ...(meta.evidenceRefId ? {evidenceRefId: meta.evidenceRefId} : {}),
    ...(meta.traceSide ? {traceSide: meta.traceSide} : {}),
    ...(meta.paneSide ? {paneSide: meta.paneSide} : {}),
    ...(meta.traceId ? {traceId: meta.traceId} : {}),
    ...(meta.queryHash ? {queryHash: meta.queryHash} : {}),
    ...(meta.sourceToolCallId ? {sourceToolCallId: meta.sourceToolCallId} : {}),
    ...(meta.paramsHash ? {paramsHash: meta.paramsHash} : {}),
    ...(meta.artifactId ? {artifactId: meta.artifactId} : {}),
    ...(meta.sourceArtifactId ? {sourceArtifactId: meta.sourceArtifactId} : {}),
    ...(meta.identityRefId ? {identityRefId: meta.identityRefId} : {}),
    ...(meta.identityStatus ? {identityStatus: meta.identityStatus} : {}),
    ...(meta.planPhaseId ? {planPhaseId: meta.planPhaseId} : {}),
    ...(meta.planPhaseAttribution ? {planPhaseAttribution: meta.planPhaseAttribution} : {}),
  };
  return {
    meta: projectedMeta,
    data: projectPrivateEnvelopeValue(sessionId, envelope.data) as DataEnvelope['data'],
    display: projectPrivateEnvelopeValue(sessionId, envelope.display) as DataEnvelope['display'],
  };
}

export function projectPrivateDataEnvelopes(
  sessionId: string,
  envelopes: readonly DataEnvelope[],
): DataEnvelope[] {
  return envelopes.map(envelope => projectPrivateDataEnvelope(sessionId, envelope));
}

/** Durable/user-visible result projection shared by CLI and snapshot surfaces. */
export function projectPrivateAnalysisResult(
  sessionId: string,
  result: AnalysisResult,
  language: OutputLanguage,
): AnalysisResult {
  return {
    sessionId: result.sessionId,
    success: result.success,
    findings: projectPrivateFindings(sessionId, result.findings),
    hypotheses: projectPrivateHypotheses(sessionId, result.hypotheses),
    conclusion: projectPrivateConclusion({
      sessionId,
      conclusion: result.conclusion,
      success: result.success,
      language,
    }),
    confidence: result.confidence,
    rounds: result.rounds,
    totalDurationMs: result.totalDurationMs,
    ...(result.partial !== undefined ? {partial: result.partial} : {}),
    ...(projectPrivateTerminationReason(result.terminationReason)
      ? {terminationReason: projectPrivateTerminationReason(result.terminationReason) as AnalysisResult['terminationReason']}
      : {}),
    ...(projectPrivateTerminationMessage(result.terminationMessage, language)
      ? {terminationMessage: projectPrivateTerminationMessage(result.terminationMessage, language)}
      : {}),
    ...(result.quickRun ? {quickRun: result.quickRun} : {}),
    ...(projectPrivateConclusionContract(sessionId, result.conclusionContract)
      ? {conclusionContract: projectPrivateConclusionContract(sessionId, result.conclusionContract)}
      : {}),
    ...(projectPrivateClaimSupport(sessionId, result.claimSupport)
      ? {claimSupport: projectPrivateClaimSupport(sessionId, result.claimSupport)}
      : {}),
    ...(projectPrivateClaimVerification(sessionId, result.claimVerificationResult)
      ? {claimVerificationResult: projectPrivateClaimVerification(sessionId, result.claimVerificationResult)}
      : {}),
    ...(projectPrivateIdentityResolutions(sessionId, result.identityResolutions)
      ? {identityResolutions: projectPrivateIdentityResolutions(sessionId, result.identityResolutions)}
      : {}),
    ...(projectPrivateAnalysisReceipt(result.analysisReceipt)
      ? {analysisReceipt: projectPrivateAnalysisReceipt(result.analysisReceipt)}
      : {}),
    uiActionProposals: projectPrivateUiActionProposals(sessionId, result.uiActionProposals),
  };
}

/**
 * Private source sessions are intentionally non-resumable across process
 * restarts. Persist only deterministic trace envelopes and authorization
 * metadata; all model-authored/free-text runtime state is discarded.
 */
export function projectPrivateSessionStateSnapshot(
  snapshot: SessionStateSnapshot,
): SessionStateSnapshot {
  const codeLookupSummary = projectPrivateCodeLookupSummary(snapshot.codeLookupSummary);
  const codebaseSnapshot = projectPrivateCodebaseSnapshot(snapshot.codebaseSnapshot);
  const codebaseIds = projectPrivateIdList(snapshot.codebaseIds);
  const knowledgeSourceIds = projectPrivateIdList(snapshot.knowledgeSourceIds);
  const analysisReceipt = projectPrivateAnalysisReceipt(snapshot.analysisReceipt);
  const traceSummary = sanitizeStoredTraceSummaryAttribution(snapshot.traceSummary);
  return {
    version: snapshot.version,
    snapshotTimestamp: snapshot.snapshotTimestamp,
    sessionId: snapshot.sessionId,
    traceId: snapshot.traceId,
    ...(snapshot.outputLanguage ? {outputLanguage: snapshot.outputLanguage} : {}),
    ...(snapshot.referenceTraceId ? {referenceTraceId: snapshot.referenceTraceId} : {}),
    ...(snapshot.comparisonSource ? {comparisonSource: snapshot.comparisonSource} : {}),
    ...(analysisReceipt ? {analysisReceipt} : {}),
    ...(traceSummary ? {traceSummary} : {}),
    conversationSteps: [],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: projectPrivateDataEnvelopes(snapshot.sessionId, snapshot.dataEnvelopes),
    hypotheses: [],
    analysisNotes: [],
    analysisPlan: null,
    planHistory: [],
    uncertaintyFlags: [],
    claudeHypotheses: [],
    ...(snapshot.analysisContextFingerprint
      ? {analysisContextFingerprint: snapshot.analysisContextFingerprint}
      : {}),
    ...(snapshot.androidInternalsPackPin
      ? {androidInternalsPackPin: {...snapshot.androidInternalsPackPin}}
      : {}),
    ...(snapshot.backgroundKnowledgeReferences
      ? {
          backgroundKnowledgeReferences: snapshot.backgroundKnowledgeReferences.map(
            reference => ({...reference}),
          ),
        }
      : {}),
    ...(snapshot.codeAwareMode ? {codeAwareMode: snapshot.codeAwareMode} : {}),
    ...(codebaseIds ? {codebaseIds} : {}),
    ...(codebaseSnapshot
      ? {codebaseSnapshot}
      : {}),
    ...(knowledgeSourceIds ? {knowledgeSourceIds} : {}),
    ...(snapshot.knowledgeSourceSnapshot
      ? {knowledgeSourceSnapshot: snapshot.knowledgeSourceSnapshot.map(item => ({...item}))}
      : {}),
    ...(codeLookupSummary ? {codeLookupSummary} : {}),
    runSequence: snapshot.runSequence,
    conversationOrdinal: snapshot.conversationOrdinal,
  };
}
