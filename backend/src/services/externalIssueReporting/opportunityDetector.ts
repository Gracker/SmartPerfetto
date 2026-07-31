// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import type {
  ClaimSupportV1,
  EvidenceSupportLevel,
} from '../../types/evidenceContract';
import type {ClaimVerificationResult} from '../../types/claimVerification';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {
  EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION,
  type ExternalIssueOpportunityV1,
  type ExternalIssueReferencesV1,
  type ExternalIssueReviewUnavailableReason,
  type ExternalIssueSignalKind,
  type ExternalIssueSignalSeverity,
  type ExternalIssueSignalV1,
} from '../../types/externalIssueReporting';
import type {ExternalIssueSourceRun} from './sourceRunResolver';

const LOW_SCENE_CONFIDENCE = 0.65;

export interface DetectExternalIssueOpportunityOptions {
  agentReviewUnavailableReason?: ExternalIssueReviewUnavailableReason;
}

export function detectExternalIssueOpportunity(
  source: ExternalIssueSourceRun,
  options: DetectExternalIssueOpportunityOptions = {},
): ExternalIssueOpportunityV1 {
  if (source.privateAnalysis) {
    return {
      schemaVersion: EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION,
      runId: source.manifest.runId,
      runManifestId: source.manifest.runManifestId,
      ...(source.snapshot ? {resultSnapshotId: source.snapshot.id} : {}),
      status: 'disabled',
      signals: [],
      agentReviewAvailable: false,
      agentReviewUnavailableReason: 'private_analysis',
    };
  }

  const language = parseOutputLanguage(source.manifest.outputLanguage);
  const signals: ExternalIssueSignalV1[] = [];
  const claims = readClaimSupport(source);
  for (const claim of claims) {
    if (claim.supportLevel === 'unsupported') {
      signals.push(signal({
        kind: 'unsupported_claim',
        severity: 'warning',
        identity: claim.claimId,
        summary: localize(
          language,
          `结论“${claim.text}”缺少可验证证据。`,
          `The claim "${claim.text}" does not have verifiable evidence.`,
        ),
        references: claimReferences(claim),
      }));
    } else if (isUncertainSupport(claim.supportLevel)) {
      signals.push(signal({
        kind: 'uncertain_claim',
        severity: 'info',
        identity: claim.claimId,
        summary: localize(
          language,
          `结论“${claim.text}”仍包含推断或部分证据。`,
          `The claim "${claim.text}" still relies on inference or partial evidence.`,
        ),
        references: claimReferences(claim),
      }));
    }
  }

  const verification = readClaimVerification(source);
  for (const issue of verification?.issues ?? []) {
    const existing = signals.some(
      item =>
        item.references.claimIds.includes(issue.claimId) &&
        (item.kind === 'unsupported_claim' || item.kind === 'uncertain_claim'),
    );
    if (existing) continue;
    signals.push(signal({
      kind: issue.severity === 'error'
        ? 'unsupported_claim'
        : 'uncertain_claim',
      severity: issue.severity,
      identity: `${issue.claimId}:${issue.code}`,
      summary: issue.message,
      references: {
        claimIds: [issue.claimId],
        findingIds: [],
        evidenceRefIds: issue.evidenceRefId ? [issue.evidenceRefId] : [],
        skillIds: [],
      },
    }));
  }

  for (const [gate, status] of Object.entries(source.receipt.qualityGates)) {
    if (status !== 'partial') continue;
    signals.push(signal({
      kind: 'partial_quality_gate',
      severity: 'warning',
      identity: gate,
      summary: localize(
        language,
        `质量门禁 ${gate} 仅部分通过。`,
        `Quality gate ${gate} only partially passed.`,
      ),
    }));
  }

  for (const skill of source.manifest.skills) {
    if (skill.errorCount > 0) {
      signals.push(signal({
        kind: 'skill_error',
        severity: 'error',
        identity: skill.skillId,
        summary: localize(
          language,
          `Skill ${skill.skillId} 出现 ${skill.errorCount} 次执行错误。`,
          `Skill ${skill.skillId} recorded ${skill.errorCount} execution error(s).`,
        ),
        references: emptyReferences({skillIds: [skill.skillId]}),
      }));
    }
    if (skill.emptyResultCount > 0) {
      signals.push(signal({
        kind: 'skill_empty_result',
        severity: 'warning',
        identity: skill.skillId,
        summary: localize(
          language,
          `Skill ${skill.skillId} 有 ${skill.emptyResultCount} 次未返回结果。`,
          `Skill ${skill.skillId} returned no result ${skill.emptyResultCount} time(s).`,
        ),
        references: emptyReferences({skillIds: [skill.skillId]}),
      }));
    }
  }

  if (
    source.manifest.sceneConfidence !== undefined &&
    source.manifest.sceneConfidence < LOW_SCENE_CONFIDENCE
  ) {
    signals.push(signal({
      kind: 'low_scene_confidence',
      severity: 'info',
      identity: source.manifest.sceneType,
      summary: localize(
        language,
        `场景识别置信度为 ${source.manifest.sceneConfidence.toFixed(2)}，可能需要补充复现背景。`,
        `Scene detection confidence is ${source.manifest.sceneConfidence.toFixed(2)}; reproduction context may be missing.`,
      ),
    }));
  }

  for (const identity of readIdentityResolutions(source)) {
    if (identity.status === 'verified' || identity.status === 'not_required') {
      continue;
    }
    signals.push(signal({
      kind: 'identity_unresolved',
      severity: identity.status === 'error' || identity.status === 'missing'
        ? 'error'
        : 'warning',
      identity: identity.identityRefId,
      summary: localize(
        language,
        `身份 ${identity.identityRefId} 的解析状态为 ${identity.status}。`,
        `Identity ${identity.identityRefId} resolved as ${identity.status}.`,
      ),
    }));
  }

  const reportError = readString(source.completedData.reportError)
    ?? source.receipt.outputs.reportError;
  if (reportError) {
    signals.push(signal({
      kind: 'report_generation_failed',
      severity: 'error',
      identity: reportError,
      summary: localize(
        language,
        `分析报告生成失败：${reportError}`,
        `Analysis report generation failed: ${reportError}`,
      ),
    }));
  }

  if (source.userReportedInaccuracy) {
    signals.push(signal({
      kind: 'user_reported_inaccuracy',
      severity: 'warning',
      identity: source.manifest.runId,
      summary: localize(
        language,
        '用户已将本次分析标记为不准确，需要 Agent 判断问题归属、可反馈性与应补充的材料。',
        'The user marked this analysis inaccurate; the Agent should determine ownership, reportability, and required supporting material.',
      ),
      references: emptyReferences({
        skillIds: source.manifest.skills
          .filter(skill =>
            skill.invocations > 0 &&
            (
              skill.origin === 'built_in' ||
              (
                skill.origin === 'external_pack' &&
                skill.trustState === 'approved'
              )
            ))
          .map(skill => skill.skillId),
      }),
    }));
  }

  const unavailableReason = options.agentReviewUnavailableReason ??
    (source.manifest.providerSnapshotHash
      ? undefined
      : 'legacy_provider_pin_missing');
  return {
    schemaVersion: EXTERNAL_ISSUE_OPPORTUNITY_SCHEMA_VERSION,
    runId: source.manifest.runId,
    runManifestId: source.manifest.runManifestId,
    ...(source.snapshot ? {resultSnapshotId: source.snapshot.id} : {}),
    status: signals.length > 0 ? 'available' : 'not_needed',
    signals: dedupeSignals(signals),
    agentReviewAvailable: unavailableReason === undefined && signals.length > 0,
    ...(unavailableReason
      ? {agentReviewUnavailableReason: unavailableReason}
      : {}),
  };
}

function readClaimSupport(source: ExternalIssueSourceRun): ClaimSupportV1[] {
  const value = source.completedData.claimSupport
    ?? source.snapshot?.claimSupport;
  return Array.isArray(value) ? value as ClaimSupportV1[] : [];
}

function readClaimVerification(
  source: ExternalIssueSourceRun,
): ClaimVerificationResult | undefined {
  const value = source.completedData.claimVerificationResult
    ?? source.snapshot?.claimVerificationResult;
  return isRecord(value) ? value as unknown as ClaimVerificationResult : undefined;
}

function readIdentityResolutions(
  source: ExternalIssueSourceRun,
): IdentityResolutionV1[] {
  const value = source.completedData.identityResolutions
    ?? source.snapshot?.identityResolutions;
  return Array.isArray(value) ? value as IdentityResolutionV1[] : [];
}

function isUncertainSupport(level: EvidenceSupportLevel): boolean {
  return level === 'partial' || level === 'inference';
}

function claimReferences(claim: ClaimSupportV1): ExternalIssueReferencesV1 {
  return {
    claimIds: [claim.claimId],
    findingIds: [],
    evidenceRefIds: claim.anchors
      .map(anchor => anchor.evidenceRefId)
      .filter(Boolean),
    skillIds: [
      ...new Set(
        claim.anchors
          .map(anchor => anchor.context.skillId)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
  };
}

function signal(input: {
  kind: ExternalIssueSignalKind;
  severity: ExternalIssueSignalSeverity;
  identity: string;
  summary: string;
  references?: ExternalIssueReferencesV1;
}): ExternalIssueSignalV1 {
  const digest = createHash('sha256')
    .update(`${input.kind}\u0000${input.identity}`)
    .digest('hex')
    .slice(0, 16);
  return {
    signalId: `issue-signal-${digest}`,
    kind: input.kind,
    severity: input.severity,
    summary: input.summary,
    references: input.references ?? emptyReferences(),
  };
}

function emptyReferences(
  overrides: Partial<ExternalIssueReferencesV1> = {},
): ExternalIssueReferencesV1 {
  return {
    claimIds: [],
    findingIds: [],
    evidenceRefIds: [],
    skillIds: [],
    ...overrides,
  };
}

function dedupeSignals(
  signals: ExternalIssueSignalV1[],
): ExternalIssueSignalV1[] {
  return [...new Map(signals.map(item => [item.signalId, item])).values()];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
