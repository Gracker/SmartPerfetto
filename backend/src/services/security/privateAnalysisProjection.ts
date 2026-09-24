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
import type {ClaimVerificationResult, DeterministicNativeRowIdentity} from '../../types/claimVerification';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {sanitizeCodeAwareText, withOwnerCodeAwareProjection, isOwnerCodeAwareProjection, isCredentialField} from './codeAwareOutputRegistry';
import {projectSceneTimelineForOwner} from '../../agent/scene/sceneTimelineProjection';
import type {CodeLookupSummary} from '../codebase/codeLookupLedger';
import {sanitizeSourceUseDecision, type SourceUseDecisionV1, type SourceReferenceV1} from '../codebase/sourceUseDecision';
import {isCodebaseKind} from '../codebase/codebaseRegistry';
import {sanitizeStoredCapabilityManifestAttribution} from '../capabilityManifest';
import {sanitizeStoredTraceSummaryAttribution} from '../traceSummaryAttribution';
import {
  analysisProjectionChanged,
  copyAnalysisDeliveryFields,
  projectPrivateAnalysisDelivery,
  projectStoredConclusionSourceMetadata,
  preserveProjectedFieldOrder,
} from './analysisDeliveryProjection';
import {sanitizeSourceClaimBindings, sanitizeSourceReferences} from '../codebase/sourceUseDecision';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';
import {projectConclusionContractForDisplay, projectConclusionProtocol} from './conclusionProtocolProjection';

type PrivateFinding = AnalysisResult['findings'][number];
type PrivateHypothesis = AnalysisResult['hypotheses'][number];

function privateControl<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

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
  'quality_gate_failed',
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

function privateSourceTextUnchanged(sessionId: string, value: string): boolean {
  return sanitizeCodeAwareText(sessionId, value) === value;
}

/** Drop a changed locator instead of inventing a replacement source identity. */
function projectPrivateSourceReferences(sessionId: string, value: unknown): SourceReferenceV1[] {
  return sanitizeSourceReferences(value).filter(reference => Object.entries(reference).every(([key, entry]) =>
    key === 'lookupKind' || typeof entry !== 'string' || privateSourceTextUnchanged(sessionId, entry)));
}

function projectPrivateSourceUseDecision(
  sessionId: string,
  value: unknown,
  selectedCodebaseIds?: readonly string[],
): SourceUseDecisionV1 | undefined {
  const originalSafe = sanitizeSourceUseDecision(value);
  if (!originalSafe) return undefined;
  const safe = sanitizeSourceUseDecision(originalSafe, selectedCodebaseIds)!;
  const unchanged = (entry: string) => privateSourceTextUnchanged(sessionId, entry);
  const projected = sanitizeSourceUseDecision({...safe,
    selectedCodebaseIds: safe.selectedCodebaseIds.filter(unchanged),
    queriedCodebaseIds: safe.queriedCodebaseIds.filter(unchanged),
    usedCodebaseIds: safe.usedCodebaseIds.filter(unchanged),
    attemptedTools: safe.attemptedTools.filter(unchanged),
    ...(safe.incompleteReasons ? {incompleteReasons: safe.incompleteReasons.filter(unchanged)} : {}),
    references: projectPrivateSourceReferences(sessionId, safe.references),
  })!;
  if (analysisProjectionChanged(originalSafe, projected) && originalSafe.coverageComplete === true) projected.coverageComplete = false;
  return preserveProjectedFieldOrder(safe, projected);
}

function projectPrivateCodeLookupSummary(
  sessionId: string,
  summary: CodeLookupSummary | undefined,
  currentSelectedCodebaseIds: readonly string[],
): CodeLookupSummary | undefined {
  if (!summary) return undefined;
  const referencedCodebaseIds = summary.referencedCodebaseIds
    .map(strictBoundedIdentifier)
    .filter((value): value is string => Boolean(value))
    .filter(value => privateSourceTextUnchanged(sessionId, value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  const usedCodebaseIds = summary.usedCodebaseIds
    ?.map(strictBoundedIdentifier)
    .filter((value): value is string => Boolean(value))
    .filter(value => privateSourceTextUnchanged(sessionId, value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  const usedKnowledgeSources = summary.usedKnowledgeSources
    ?.map(source => {
      const knowledgeSourceId = boundedIdentifier(source.knowledgeSourceId);
      if (!knowledgeSourceId || !privateSourceTextUnchanged(sessionId, knowledgeSourceId)) return undefined;
      return {
        knowledgeSourceId,
        sourceGenerations: source.sourceGenerations
          .map(boundedIdentifier)
          .filter((value): value is string => Boolean(value))
          .filter(value => privateSourceTextUnchanged(sessionId, value))
          .slice(0, MAX_PRIVATE_SOURCE_GENERATIONS),
      };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))
    .slice(0, MAX_PRIVATE_PROVENANCE_IDS);
  const sourceUseDecision = projectPrivateSourceUseDecision(
    sessionId,
    summary.sourceUseDecision,
    currentSelectedCodebaseIds,
  );
  return {
    lookupCount: Math.max(0, Math.min(1_000_000, Math.floor(summary.lookupCount || 0))),
    patchCount: Math.max(0, Math.min(1_000_000, Math.floor(summary.patchCount || 0))),
    referencedCodebaseIds,
    ...(usedCodebaseIds?.length ? {usedCodebaseIds} : {}),
    ...(usedKnowledgeSources?.length ? {usedKnowledgeSources} : {}),
    ...(sourceUseDecision ? {sourceUseDecision} : {}),
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
  state?: Partial<Pick<AnalysisResult, 'completion' | 'partial'>> & {terminationReason?: unknown};
}): string {
  if (isOwnerCodeAwareProjection() && !String(input.conclusion ?? '').trim()) {
    return localize(input.language, '未生成可显示的分析结论。', 'No analysis conclusion was generated.');
  }
  if (!input.success && !isOwnerCodeAwareProjection()) {
    const completion = input.state?.completion?.status;
    if (completion === 'failed' || completion === 'cancelled' || completion === 'incomplete') {
      return privateAnalysisFailureMessage(input.language);
    }
    const reason = projectPrivateTerminationReason(input.state?.terminationReason);
    if (completion === 'completed' || reason === 'quality_gate_failed' || reason === 'plan_incomplete') {
      return localize(input.language,
        '回答已生成，但结果尚未通过检查；详细内容已按隐私策略隐藏。',
        'An answer was generated, but the result has not passed checks; details are hidden by the privacy policy.');
    }
    return localize(input.language,
      '分析结果未能确认；详细内容已按隐私策略隐藏。',
      'The analysis result could not be confirmed; details are hidden by the privacy policy.');
  }
  return projectConclusionProtocol(input.sessionId, String(input.conclusion ?? '')).text;
}

export function projectPrivateTerminationReason(value: unknown): AnalysisResult['terminationReason'] {
  return typeof value === 'string' && SAFE_TERMINATION_REASONS.has(value)
    ? value as AnalysisResult['terminationReason']
    : undefined;
}

export function projectPrivateTerminationMessage(
  value: unknown,
  language: OutputLanguage,
  state?: Partial<Pick<AnalysisResult, 'sessionId' | 'success' | 'partial' | 'completion'>> & {terminationReason?: unknown},
  sessionId?: string,
): string | undefined {
  if (isOwnerCodeAwareProjection()) {
    if (state?.completion?.status === 'completed' && state.success !== false && !state.partial && !state.terminationReason) return undefined;
    return typeof value === 'string' && value ? sanitizeCodeAwareText(sessionId ?? state?.sessionId, value) : undefined;
  }
  const completion = state?.completion?.status;
  if (completion === 'failed' || completion === 'cancelled' || completion === 'incomplete') {
    return privateAnalysisFailureMessage(language);
  }
  const reason = projectPrivateTerminationReason(state?.terminationReason);
  if (state?.partial === true || reason || completion === 'completed' && state?.success === false) {
    return localize(language,
      '分析结果存在未完成或未通过检查的部分；详细诊断已按隐私策略隐藏。',
      'Parts of this result remain incomplete or have not passed checks; detailed diagnostics are hidden by the privacy policy.');
  }
  if (completion === 'completed') return undefined;
  if (state?.success === false) return privateAnalysisFailureMessage(language);
  return value === undefined || value === null || value === '' ? undefined : localize(language,
    '详细分析诊断已按隐私策略隐藏。',
    'Detailed analysis diagnostics are hidden by the privacy policy.');
}

export function projectPrivateAnalysisReceipt(
  receipt: AnalysisReceipt | undefined,
): AnalysisReceipt | undefined {
  if (!isCompleteAnalysisReceipt(receipt)) return undefined;
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

/**
 * Projected claims are no longer the claims that were checked, so no check
 * result (verification, finite proof or reference match) carries over.
 */
function withdrawClaimAuditVerification(audit: AnalysisReceipt['claimAudit']): AnalysisReceipt['claimAudit'] {
  return {...audit, verifiedClaims: 0, uncertainClaims: audit.uncertainClaims + audit.verifiedClaims,
    ...(audit.referencesMatchedClaims !== undefined ? {referencesMatchedClaims: 0} : {}),
    ...(audit.propositionProvedClaims !== undefined ? {propositionProvedClaims: 0} : {})};
}

/** Historical JSON may be incomplete; it cannot supply missing audit counts. */
function isCompleteAnalysisReceipt(value: unknown): value is AnalysisReceipt {
  if (!isPlainJsonObject(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return false;
  if (value.schemaVersion === 2 && typeof value.runManifestId !== 'string') return false;
  if (['runId', 'sessionId', 'traceId'].some(key => typeof value[key] !== 'string')) return false;
  if (!isPlainJsonObject(value.outputs) || !isPlainJsonObject(value.qualityGates)) return false;
  const counts = [
    [value.claimAudit, ['totalClaims', 'verifiedClaims', 'unsupportedClaims', 'uncertainClaims']],
    [value.traceEvidence, ['sqlCount', 'skillCount', 'dataEnvelopeCount', 'artifactCount', 'evidenceRefCount']],
    [value.nonEvidenceContext, ['frontendPrequeryCount', 'memoryHintCount', 'conversationContextCount', 'strategyHintCount']],
  ] as const;
  return counts.every(([section, keys]) => isPlainJsonObject(section) && keys.every(key =>
    typeof section[key] === 'number' && Number.isSafeInteger(section[key]) && section[key] >= 0));
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
  'rawdeclaration',
  'rawclaims',
  'rawbody',
  'rawbodyfingerprint',
  'sourcebodyfingerprint',
  'parserdiagnostics',
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
    const projectedEntry = isOwnerCodeAwareProjection() && isCredentialField(key) && typeof entry === 'string' && entry.length >= 8
      ? '[REDACTED_SECRET]' : projectPrivateEnvelopeValue(sessionId, entry, depth + 1);
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
  return projectConclusionContractForDisplay(sessionId, contract);
}

export function projectPrivateClaimSupport(
  sessionId: string,
  support: readonly ClaimSupportV1[] | undefined,
): ClaimSupportV1[] | undefined {
  return support ? support.map(item => projectPrivateStructuredValue(sessionId, item)) : undefined;
}

/** Display metadata only. This never issues a witness or restores native proof authority. */
function projectPrivateNativeRows(sessionId: string, claim: ClaimVerificationResult['claimResults'][number]):
  {rows?: DeterministicNativeRowIdentity[]; invalid: boolean} {
  const proof = claim.deterministicProof;
  if (proof?.nativeRows === undefined) return {invalid: false};
  const input: unknown = proof.nativeRows;
  if (!Array.isArray(input) || input.length > MAX_PRIVATE_PROVENANCE_IDS ||
      !['numeric_cell', 'captured_cell', 'interval_overlap', 'comparison_delta'].includes(proof.kind)) return {invalid: true};
  const keys = ['anchorId', 'evidenceRefId', 'captureId', 'traceId', 'traceSide', 'relation', 'idColumn', 'id', 'schemaFingerprint'];
  const references = claim.referenceCells ?? claim.referenceResults ?? [];
  const anchors = new Set<string>();
  const rows: DeterministicNativeRowIdentity[] = [];
  for (const row of input) {
    if (!isPlainJsonObject(row) || Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key)) ||
        !['anchorId', 'evidenceRefId', 'captureId', 'traceId'].every(key => typeof row[key] === 'string' &&
          /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,159}$/.test(row[key] as string) && privateSourceTextUnchanged(sessionId, row[key] as string)) ||
        !['relation', 'idColumn'].every(key => typeof row[key] === 'string' && /^[a-z_][a-z0-9_]{0,159}$/.test(row[key] as string) &&
          privateSourceTextUnchanged(sessionId, row[key] as string)) ||
        (row.traceSide !== 'current' && row.traceSide !== 'reference') || !privateSourceTextUnchanged(sessionId, row.traceSide) ||
        typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 0 ||
        typeof row.schemaFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.schemaFingerprint) ||
        !privateSourceTextUnchanged(sessionId, row.schemaFingerprint) ||
        !proof.anchorIds.includes(row.anchorId as string) || !proof.evidenceRefIds.includes(row.evidenceRefId as string) ||
        !references.some(reference => reference.anchorId === row.anchorId && reference.evidenceRefId === row.evidenceRefId) ||
        anchors.has(row.anchorId as string)) return {invalid: true};
    anchors.add(row.anchorId as string);
    rows.push({anchorId: row.anchorId as string, evidenceRefId: row.evidenceRefId as string, captureId: row.captureId as string,
      traceId: row.traceId as string, traceSide: row.traceSide, relation: row.relation as string, idColumn: row.idColumn as string,
      id: row.id, schemaFingerprint: row.schemaFingerprint});
  }
  return {rows, invalid: false};
}

export function projectPrivateClaimVerification(
  sessionId: string,
  verification: ClaimVerificationResult | undefined,
): ClaimVerificationResult | undefined {
  if (!verification || !['claim_verifier@1', 'claim_verifier@2'].includes(verification.schemaVersion)) return undefined;
  const nativeRows = (verification.claimResults ?? []).map(claim => projectPrivateNativeRows(sessionId, claim));
  const text = (value: string) => sanitizeCodeAwareText(sessionId, value);
  const references = (values: NonNullable<ClaimVerificationResult['claimResults'][number]['referenceResults']>) =>
    values.map(reference => ({
      ...(reference.evidenceRefId !== undefined ? {evidenceRefId: text(reference.evidenceRefId)} : {}),
      ...(reference.sourceRef !== undefined ? {sourceRef: text(reference.sourceRef)} : {}),
      ...(reference.artifactId !== undefined ? {artifactId: text(reference.artifactId)} : {}),
      ...(reference.sourceToolCallId !== undefined ? {sourceToolCallId: text(reference.sourceToolCallId)} : {}),
      ...(reference.anchorId !== undefined ? {anchorId: text(reference.anchorId)} : {}),
      ...(reference.column !== undefined ? {column: text(reference.column)} : {}),
      status: privateControl(reference.status, ['matched', 'missing', 'ambiguous', 'value_mismatch', 'ineligible', 'not_checked'], 'not_checked'),
      ...(reference.message !== undefined ? {message: text(reference.message)} : {}),
    }));
  const projected: ClaimVerificationResult = {
    schemaVersion: verification.schemaVersion,
    status: privateControl(verification.status, ['passed', 'failed', 'partial', 'not_checked'], 'not_checked'),
    policy: privateControl(verification.policy, ['block', 'retry', 'warn_only', 'record_only'], 'record_only'),
    ...(verification.notCheckedReason !== undefined ? {notCheckedReason: text(verification.notCheckedReason)} : {}),
    ...(verification.notCheckedDetail !== undefined ? {notCheckedDetail: text(verification.notCheckedDetail)} : {}),
    passed: verification.status === 'passed' && verification.passed === true,
    checkedClaimCount: verification.checkedClaimCount,
    unsupportedClaimCount: verification.unsupportedClaimCount,
    claimResults: (verification.claimResults ?? []).map((claim, index) => ({
      claimId: text(claim.claimId), status: privateControl(claim.status,
        ['verified', 'partial', 'inference', 'unsupported', 'not_checked'], 'not_checked'),
      ...(claim.referenceResults ? {referenceResults: references(claim.referenceResults)} : {}),
      ...(claim.referenceCells ? {referenceCells: references(claim.referenceCells)} : {}),
      ...(claim.deterministicProof ? {deterministicProof: {
        kind: privateControl(claim.deterministicProof.kind,
          ['numeric_cell', 'captured_cell', 'source_location', 'interval_overlap', 'comparison_delta', 'none'], 'none'),
        status: privateControl(claim.deterministicProof.status, ['proved', 'candidate', 'rejected', 'not_checked'], 'not_checked'),
        reason: text(claim.deterministicProof.reason),
        anchorIds: claim.deterministicProof.anchorIds.map(text),
        evidenceRefIds: claim.deterministicProof.evidenceRefIds.map(text),
        ...(nativeRows[index].rows ? {nativeRows: nativeRows[index].rows} : {}),
      }} : {}),
      ...(claim.propositionCoverage ? {propositionCoverage: {
        status: privateControl(claim.propositionCoverage.status, ['complete', 'partial', 'none'], 'none'),
        covered: claim.propositionCoverage.covered.map(text),
        uncovered: claim.propositionCoverage.uncovered.map(text),
        reason: text(claim.propositionCoverage.reason),
      }} : {}),
    })),
    issues: (verification.issues ?? []).map(issue => ({
      claimId: text(issue.claimId), severity: privateControl(issue.severity, ['error', 'warning'], 'warning'),
      code: text(issue.code), message: text(issue.message),
      ...(issue.evidenceRefId !== undefined ? {evidenceRefId: text(issue.evidenceRefId)} : {}),
    })),
  };
  if (projected.status === 'passed' && !projected.passed) projected.status = 'not_checked';
  // This boundary also runs before finalization signs its verification binding.
  // Dropping unsafe identity must therefore invalidate here, not only on a later result diff.
  return preserveProjectedFieldOrder(verification, nativeRows.some(item => item.invalid)
    ? invalidatePrivateClaimVerification(projected) : projected);
}

function invalidatePrivateClaimVerification(verification: ClaimVerificationResult): ClaimVerificationResult {
  const claimResults = verification.claimResults.map(claim => {
    const references = (values: typeof claim.referenceResults) => values?.map(reference => ({...reference,
      status: reference.status === 'matched' ? 'not_checked' as const : reference.status}));
    return {...claim,
      status: claim.status === 'verified' || claim.status === 'inference' || claim.status === 'partial'
        ? 'not_checked' as const : claim.status,
      ...(claim.referenceResults ? {referenceResults: references(claim.referenceResults)} : {}),
      ...(claim.referenceCells ? {referenceCells: references(claim.referenceCells)} : {}),
      ...(claim.deterministicProof ? {deterministicProof: {...claim.deterministicProof,
        status: claim.deterministicProof.status === 'proved' || claim.deterministicProof.status === 'candidate'
          ? 'not_checked' as const : claim.deterministicProof.status}} : {}),
      ...(claim.propositionCoverage ? {propositionCoverage: {...claim.propositionCoverage,
        status: 'none' as const,
        covered: [], uncovered: [...claim.propositionCoverage.covered, ...claim.propositionCoverage.uncovered]}} : {}),
    };
  });
  const onlyUnchecked = claimResults.every(claim => claim.status === 'not_checked' &&
    claim.deterministicProof?.status !== 'rejected' &&
    [...(claim.referenceResults ?? []), ...(claim.referenceCells ?? [])].every(reference => reference.status === 'not_checked')) &&
    verification.issues.every(issue => issue.severity !== 'error');
  return {...verification,
    status: verification.status === 'passed' || (verification.status === 'partial' && onlyUnchecked)
      ? 'not_checked' : verification.status,
    passed: false, claimResults,
    checkedClaimCount: claimResults.filter(claim => claim.status !== 'not_checked').length,
    unsupportedClaimCount: claimResults.filter(claim => claim.status === 'unsupported').length,
  };
}

/** A known source-verifier failure remains a failure after diagnostic redaction. */
function projectPrivateSourceVerification(
  sessionId: string,
  verification: AnalysisResult['sourceClaimVerificationResult'],
  invalidate: boolean,
): AnalysisResult['sourceClaimVerificationResult'] {
  if (!verification || verification.schemaVersion !== 'source_claim_verifier@1') return undefined;
  const text = (value: string) => sanitizeCodeAwareText(sessionId, value);
  const projected: NonNullable<AnalysisResult['sourceClaimVerificationResult']> = {
    schemaVersion: verification.schemaVersion,
    status: invalidate && verification.status === 'passed' ? 'not_checked' :
      privateControl(verification.status, ['passed', 'failed', 'partial', 'not_checked'], 'not_checked'),
    bindings: sanitizeSourceClaimBindings(verification.bindings).map(binding => ({...binding,
      claimId: text(binding.claimId), sourceReferenceIds: binding.sourceReferenceIds.map(text),
      traceEvidenceRefIds: binding.traceEvidenceRefIds.map(text),
      mechanismStatus: invalidate && (binding.mechanismStatus === 'corroborated' || binding.mechanismStatus === 'compatible')
        ? 'unverified' : binding.mechanismStatus,
    })),
    issues: verification.issues.map(issue => ({
      ...(issue.claimId !== undefined ? {claimId: text(issue.claimId)} : {}),
      severity: privateControl(issue.severity, ['error', 'warning'], 'warning'), code: issue.code, message: text(issue.message),
      ...(issue.sourceReferenceId !== undefined ? {sourceReferenceId: text(issue.sourceReferenceId)} : {}),
      ...(issue.traceEvidenceRefId !== undefined ? {traceEvidenceRefId: text(issue.traceEvidenceRefId)} : {}),
    })),
  };
  return preserveProjectedFieldOrder(verification, projected);
}

export function projectPrivateIdentityResolutions(
  sessionId: string,
  resolutions: readonly IdentityResolutionV1[] | undefined,
): IdentityResolutionV1[] | undefined {
  return resolutions
    ? resolutions.filter(resolution => resolution.version === 'identity_contract@1').map<IdentityResolutionV1>(resolution => {
      const projected = projectPrivateStructuredValue(sessionId, resolution);
      const status = ['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error'].includes(resolution.status)
        ? resolution.status : 'error';
      const unchanged = !analysisProjectionChanged({...resolution, status: undefined}, {...projected, status: undefined});
      return {...projected, version: 'identity_contract@1',
        status: !unchanged && (status === 'verified' || status === 'not_required') ? 'weak' : status};
    })
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
  const conclusion = projectPrivateConclusion({sessionId, conclusion: result.conclusion, success: result.success, language, state: result});
  const sourceUseDecision = projectPrivateSourceUseDecision(sessionId, result.sourceUseDecision);
  const sourceReferences = result.sourceReferences ? projectPrivateSourceReferences(sessionId, result.sourceReferences) : undefined;
  const storedContract = projectStoredConclusionSourceMetadata(result.conclusionContract, sourceUseDecision);
  let conclusionContract = projectPrivateConclusionContract(sessionId, storedContract);
  if (conclusionContract && storedContract?.sourceUseDecision) {
    conclusionContract = {...conclusionContract,
      sourceUseDecision: projectPrivateSourceUseDecision(sessionId, storedContract.sourceUseDecision),
      sourceReferences: projectPrivateSourceReferences(sessionId, storedContract.sourceReferences)};
  }
  if (conclusionContract?.sourceClaimBindings && storedContract?.sourceClaimBindings) {
    conclusionContract = {...conclusionContract, sourceClaimBindings: conclusionContract.sourceClaimBindings.map((binding, index) => ({
      ...binding, mechanismStatus: storedContract.sourceClaimBindings![index].mechanismStatus,
    }))};
  }
  let claimSupport = projectPrivateClaimSupport(sessionId, result.claimSupport)?.map((support, index) => {
    const status = result.claimSupport?.[index].supportLevel;
    return {...support, supportLevel: status && ['verified', 'partial', 'inference', 'unsupported'].includes(status)
      ? status : 'partial' as const};
  });
  let claimVerificationResult = projectPrivateClaimVerification(sessionId, result.claimVerificationResult);
  const identityResolutions = projectPrivateIdentityResolutions(sessionId, result.identityResolutions);
  const claimsChanged = conclusion !== result.conclusion ||
    analysisProjectionChanged(result.conclusionContract, conclusionContract) ||
    analysisProjectionChanged(result.claimSupport, claimSupport) ||
    analysisProjectionChanged(result.claimVerificationResult, claimVerificationResult);
  if (claimsChanged) {
    if (claimVerificationResult) claimVerificationResult = invalidatePrivateClaimVerification(claimVerificationResult);
    claimSupport = claimSupport?.map(support => ({...support,
      supportLevel: support.supportLevel === 'verified' || support.supportLevel === 'inference' ? 'partial' : support.supportLevel,
      bindingEligibility: 'ineligible'}));
  }
  const sourceProjection = projectPrivateSourceVerification(sessionId, result.sourceClaimVerificationResult, false);
  const sourceChanged = analysisProjectionChanged(result.sourceUseDecision, sourceUseDecision) ||
    analysisProjectionChanged(result.sourceReferences, sourceReferences) ||
    analysisProjectionChanged(result.sourceClaimVerificationResult, sourceProjection);
  if ((claimsChanged || sourceChanged) && conclusionContract?.sourceClaimBindings) {
    conclusionContract = {...conclusionContract,
      sourceClaimBindings: sanitizeSourceClaimBindings(conclusionContract.sourceClaimBindings).map(binding => ({...binding,
        mechanismStatus: binding.mechanismStatus === 'corroborated' || binding.mechanismStatus === 'compatible'
          ? 'unverified' : binding.mechanismStatus}))};
  }
  const sourceClaimVerificationResult = claimsChanged || sourceChanged
    ? projectPrivateSourceVerification(sessionId, result.sourceClaimVerificationResult, true) : sourceProjection;
  const identityChanged = analysisProjectionChanged(result.identityResolutions, identityResolutions);
  const delivery = projectPrivateAnalysisDelivery(result, {conclusion, conclusionContract, claimsChanged,
    sourceChanged, identityChanged,
  }, text => sanitizeCodeAwareText(sessionId, text));
  let analysisReceipt = projectPrivateAnalysisReceipt(result.analysisReceipt);
  if (analysisReceipt && (claimsChanged || identityChanged ||
      delivery.deliveryAssurance?.report === 'not_checked' || delivery.deliveryAssurance?.report === 'coverage_incomplete')) {
    analysisReceipt = {...analysisReceipt,
      claimAudit: claimsChanged ? withdrawClaimAuditVerification(analysisReceipt.claimAudit) : analysisReceipt.claimAudit,
      qualityGates: {...analysisReceipt.qualityGates,
        ...(claimsChanged ? {claimVerification: 'partial' as const} : {}),
        ...(identityChanged ? {identityResolution: 'partial' as const} : {}),
        ...(claimsChanged || delivery.deliveryAssurance?.report === 'not_checked' || delivery.deliveryAssurance?.report === 'coverage_incomplete'
          ? {finalReportContract: 'partial' as const} : {})}};
  }
  return {
    sessionId: result.sessionId,
    success: result.success,
    findings: projectPrivateFindings(sessionId, result.findings),
    hypotheses: projectPrivateHypotheses(sessionId, result.hypotheses),
    conclusion,
    ...delivery,
    confidence: result.confidence,
    rounds: result.rounds,
    totalDurationMs: result.totalDurationMs,
    ...(result.partial !== undefined ? {partial: result.partial} : {}),
    ...(projectPrivateTerminationReason(result.terminationReason)
      ? {terminationReason: projectPrivateTerminationReason(result.terminationReason) as AnalysisResult['terminationReason']}
      : {}),
    ...(projectPrivateTerminationMessage(result.terminationMessage, language, result, sessionId)
      ? {terminationMessage: projectPrivateTerminationMessage(result.terminationMessage, language, result, sessionId)}
      : {}),
    ...(result.quickRun ? {quickRun: result.quickRun} : {}),
    ...(conclusionContract ? {conclusionContract} : {}),
    ...(claimSupport ? {claimSupport} : {}),
    ...(claimVerificationResult ? {claimVerificationResult} : {}),
    ...(identityResolutions ? {identityResolutions} : {}),
    ...(sourceUseDecision ? {sourceUseDecision} : {}),
    ...(sourceReferences ? {sourceReferences} : {}),
    ...(sourceClaimVerificationResult ? {sourceClaimVerificationResult} : {}),
    ...(analysisReceipt ? {analysisReceipt} : {}),
    uiActionProposals: projectPrivateUiActionProposals(sessionId, result.uiActionProposals),
    ...(isOwnerCodeAwareProjection() && result.sceneTimeline
      ? {sceneTimeline: projectSceneTimelineForOwner(result.sceneTimeline)} : {}),
    ...(isOwnerCodeAwareProjection() && result.sceneReport ? {sceneReport: {...result.sceneReport}} : {}),
  };
}

/** Copy only public result fields; private runtime callbacks and parser diagnostics cannot leak. */
export function copyAnalysisResultForSnapshot(result: AnalysisResult): AnalysisResult {
  const finalized = result.deliveryAssurance?.entry === 'new_finalization';
  const conclusionContract = finalized ? result.conclusionContract
    : projectStoredConclusionSourceMetadata(result.conclusionContract, result.sourceUseDecision);
  const sourceUseDecision = finalized ? result.sourceUseDecision : sanitizeSourceUseDecision(result.sourceUseDecision);
  const sourceReferences = finalized ? result.sourceReferences
    : result.sourceReferences ? sanitizeSourceReferences(result.sourceReferences) : undefined;
  const sourceProjection = finalized ? result.sourceClaimVerificationResult
    : projectPrivateSourceVerification('', result.sourceClaimVerificationResult, false);
  const claimVerificationResult = finalized ? result.claimVerificationResult
    : projectPrivateClaimVerification('', result.claimVerificationResult);
  const claimsChanged = analysisProjectionChanged(result.conclusionContract, conclusionContract) ||
    analysisProjectionChanged(result.claimVerificationResult, claimVerificationResult);
  const sourceChanged = analysisProjectionChanged(result.sourceUseDecision, sourceUseDecision) ||
    analysisProjectionChanged(result.sourceReferences, sourceReferences) ||
    analysisProjectionChanged(result.sourceClaimVerificationResult, sourceProjection);
  const sourceClaimVerificationResult = !finalized && (claimsChanged || sourceChanged)
    ? projectPrivateSourceVerification('', result.sourceClaimVerificationResult, true) : sourceProjection;
  const stored: AnalysisResult = {
    sessionId: result.sessionId, success: result.success, conclusion: result.conclusion,
    findings: result.findings, hypotheses: result.hypotheses, confidence: result.confidence,
    rounds: result.rounds, totalDurationMs: result.totalDurationMs,
    ...copyAnalysisDeliveryFields(result),
    ...(conclusionContract !== undefined ? {conclusionContract} : {}),
    ...(result.claimSupport !== undefined ? {claimSupport: result.claimSupport} : {}),
    ...(claimVerificationResult !== undefined ? {claimVerificationResult} : {}),
    ...(sourceUseDecision !== undefined ? {sourceUseDecision} : {}),
    ...(sourceReferences !== undefined ? {sourceReferences} : {}),
    ...(sourceClaimVerificationResult !== undefined ? {sourceClaimVerificationResult} : {}),
    ...(result.identityResolutions !== undefined ? {identityResolutions: result.identityResolutions} : {}),
    ...(result.partial !== undefined ? {partial: result.partial} : {}),
    ...(result.terminationReason !== undefined ? {terminationReason: result.terminationReason} : {}),
    ...(result.terminationMessage !== undefined ? {terminationMessage: result.terminationMessage} : {}),
    ...(result.analysisReceipt !== undefined ? {analysisReceipt: result.analysisReceipt} : {}),
    ...(result.uiActionProposals !== undefined ? {uiActionProposals: result.uiActionProposals} : {}),
    ...(result.quickRun !== undefined ? {quickRun: result.quickRun} : {}),
    ...(result.smartScenePreview !== undefined ? {smartScenePreview: result.smartScenePreview} : {}),
    ...(result.sceneTimeline !== undefined ? {sceneTimeline: structuredClone(result.sceneTimeline)} : {}),
    ...(result.sceneReport !== undefined ? {sceneReport: {...result.sceneReport}} : {}),
  };
  if (claimsChanged && stored.claimVerificationResult) {
    stored.claimVerificationResult = invalidatePrivateClaimVerification(stored.claimVerificationResult);
  }
  if (claimsChanged && stored.claimSupport) {
    stored.claimSupport = stored.claimSupport.map(support => ({...support,
      supportLevel: support.supportLevel === 'verified' || support.supportLevel === 'inference' ? 'partial' : support.supportLevel,
      bindingEligibility: 'ineligible'}));
  }
  if ((claimsChanged || sourceChanged) && stored.conclusionContract?.sourceClaimBindings) {
    stored.conclusionContract = {...stored.conclusionContract,
      sourceClaimBindings: stored.conclusionContract.sourceClaimBindings.map(binding => ({...binding,
        mechanismStatus: binding.mechanismStatus === 'corroborated' || binding.mechanismStatus === 'compatible'
          ? 'unverified' : binding.mechanismStatus}))};
  }
  const delivery = projectPrivateAnalysisDelivery(result, {conclusion: result.conclusion,
    conclusionContract: stored.conclusionContract, claimsChanged, sourceChanged}, text => text, {privateMetadata: false});
  const reportInvalidated = (result.reportAssessment?.status === 'checked' && delivery.reportAssessment?.status !== 'checked') ||
    ((result.deliveryAssurance?.report === 'passed' || result.deliveryAssurance?.report === 'not_applicable') &&
      delivery.deliveryAssurance?.report !== 'passed' && delivery.deliveryAssurance?.report !== 'not_applicable');
  if (stored.analysisReceipt && !isCompleteAnalysisReceipt(stored.analysisReceipt)) delete stored.analysisReceipt;
  if (stored.analysisReceipt && (claimsChanged || sourceChanged || reportInvalidated)) {
    stored.analysisReceipt = {...stored.analysisReceipt,
      claimAudit: claimsChanged ? withdrawClaimAuditVerification(stored.analysisReceipt.claimAudit) : stored.analysisReceipt.claimAudit,
      qualityGates: {...stored.analysisReceipt.qualityGates, finalReportContract: 'partial',
        ...(claimsChanged ? {claimVerification: 'partial' as const} : {})}};
  }
  return {...stored, ...delivery};
}

/**
 * Private source sessions are intentionally non-resumable across process
 * restarts. Persist only deterministic trace envelopes and authorization
 * metadata; all model-authored/free-text runtime state is discarded.
 */
export function projectPrivateSessionStateSnapshot(
  snapshot: SessionStateSnapshot,
): SessionStateSnapshot {
  const codebaseIds = projectPrivateIdList(snapshot.codebaseIds)?.filter(id => privateSourceTextUnchanged(snapshot.sessionId, id));
  const currentSelectedCodebaseIds = codebaseIds ?? [];
  const projectedCodeLookupSummary = projectPrivateCodeLookupSummary(
    snapshot.sessionId,
    snapshot.codeLookupSummary,
    currentSelectedCodebaseIds,
  );
  const sourceUseDecision = projectPrivateSourceUseDecision(
    snapshot.sessionId,
    snapshot.sourceUseDecision,
    currentSelectedCodebaseIds,
  ) ??
    projectedCodeLookupSummary?.sourceUseDecision;
  const codeLookupSummary = projectedCodeLookupSummary
    ? {
        ...projectedCodeLookupSummary,
        ...(sourceUseDecision ? {sourceUseDecision} : {}),
      }
    : undefined;
  const codebaseSnapshot = projectPrivateCodebaseSnapshot(snapshot.codebaseSnapshot)?.filter(item =>
    Object.entries(item).every(([key, value]) => key === 'kind' || key === 'commitProvenance' ||
      typeof value !== 'string' || privateSourceTextUnchanged(snapshot.sessionId, value)));
  const knowledgeSourceIds = projectPrivateIdList(snapshot.knowledgeSourceIds)?.filter(id => privateSourceTextUnchanged(snapshot.sessionId, id));
  const traceSummary = sanitizeStoredTraceSummaryAttribution(snapshot.traceSummary);
  const finalResult = snapshot.finalResult?.sessionId === snapshot.sessionId
    ? projectPrivateAnalysisResult(snapshot.sessionId, snapshot.finalResult, snapshot.outputLanguage ?? 'zh-CN')
    : undefined;
  const analysisReceipt = finalResult ? finalResult.analysisReceipt : projectPrivateAnalysisReceipt(snapshot.analysisReceipt);
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
    ...(finalResult ? {finalResult, claimSupport: finalResult.claimSupport,
      claimVerificationResult: finalResult.claimVerificationResult,
      sourceClaimVerificationResult: finalResult.sourceClaimVerificationResult,
      identityResolutions: finalResult.identityResolutions} : {}),
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
      ? {knowledgeSourceSnapshot: snapshot.knowledgeSourceSnapshot.filter(item => Object.values(item).every(value =>
          typeof value !== 'string' || privateSourceTextUnchanged(snapshot.sessionId, value))).map(item => ({...item}))}
      : {}),
    ...(codeLookupSummary ? {codeLookupSummary} : {}),
    ...(finalResult ? {sourceUseDecision: finalResult.sourceUseDecision}
      : sourceUseDecision ? {sourceUseDecision} : {}),
    runSequence: snapshot.runSequence,
    conversationOrdinal: snapshot.conversationOrdinal,
  };
}


/** Owner-authenticated surfaces retain source quotations; strict projectors remain the log/public default. */
export function projectOwnerAnalysisResult(...args: Parameters<typeof projectPrivateAnalysisResult>): AnalysisResult {
  return withOwnerCodeAwareProjection(() => projectPrivateAnalysisResult(...args));
}
export function projectOwnerConclusion(...args: Parameters<typeof projectPrivateConclusion>): string {
  return withOwnerCodeAwareProjection(() => projectPrivateConclusion(...args));
}
export function projectOwnerTerminationMessage(...args: Parameters<typeof projectPrivateTerminationMessage>): string | undefined {
  return withOwnerCodeAwareProjection(() => projectPrivateTerminationMessage(...args));
}
export function projectOwnerStructuredValue<T>(sessionId: string, value: T): T {
  return withOwnerCodeAwareProjection(() => projectPrivateStructuredValue(sessionId, value));
}
export function projectOwnerDataEnvelopes(...args: Parameters<typeof projectPrivateDataEnvelopes>): DataEnvelope[] {
  return withOwnerCodeAwareProjection(() => projectPrivateDataEnvelopes(...args));
}
export function projectOwnerFindings(...args: Parameters<typeof projectPrivateFindings>): ReturnType<typeof projectPrivateFindings> {
  return withOwnerCodeAwareProjection(() => projectPrivateFindings(...args));
}
export function projectOwnerUiActionProposals(...args: Parameters<typeof projectPrivateUiActionProposals>): ReturnType<typeof projectPrivateUiActionProposals> {
  return withOwnerCodeAwareProjection(() => projectPrivateUiActionProposals(...args));
}
export function projectOwnerSessionStateSnapshot(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  return withOwnerCodeAwareProjection(() => ({...projectPrivateSessionStateSnapshot(snapshot),
    conversationSteps: projectPrivateStructuredValue(snapshot.sessionId, snapshot.conversationSteps),
    conclusionHistory: projectPrivateStructuredValue(snapshot.sessionId, snapshot.conclusionHistory),
  }));
}

export function projectOwnerHypotheses(...args: Parameters<typeof projectPrivateHypotheses>): ReturnType<typeof projectPrivateHypotheses> {
  return withOwnerCodeAwareProjection(() => projectPrivateHypotheses(...args));
}

export function projectOwnerConclusionContract(
  ...args: Parameters<typeof projectPrivateConclusionContract>
): ReturnType<typeof projectPrivateConclusionContract> {
  return withOwnerCodeAwareProjection(() => projectPrivateConclusionContract(...args));
}

export function projectOwnerClaimVerification(...args: Parameters<typeof projectPrivateClaimVerification>): ReturnType<typeof projectPrivateClaimVerification> {
  return withOwnerCodeAwareProjection(() => projectPrivateClaimVerification(...args));
}
export function projectOwnerClaimSupport(...args: Parameters<typeof projectPrivateClaimSupport>): ReturnType<typeof projectPrivateClaimSupport> {
  return withOwnerCodeAwareProjection(() => projectPrivateClaimSupport(...args));
}


export function projectOwnerAnalysisError(sessionId: string | undefined, error: unknown, language: OutputLanguage): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return withOwnerCodeAwareProjection(() => sanitizeCodeAwareText(sessionId, message ||
    localize(language, '分析未能完成。', 'Analysis did not complete.')));
}
