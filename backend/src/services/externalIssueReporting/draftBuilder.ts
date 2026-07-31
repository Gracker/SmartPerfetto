// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import {localize, parseOutputLanguage} from '../../agentv3/outputLanguage';
import {
  EXTERNAL_ISSUE_DRAFT_SCHEMA_VERSION,
  type ExternalIssueDraftV1,
  type ExternalIssueOpportunityV1,
  type ExternalIssueReviewV1,
  type ExternalIssueUserAnswerV1,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';
import {sanitizePublicArtifactData} from '../security/publicArtifactSanitizer';

const DEFAULT_GITHUB_ISSUES_URL =
  'https://github.com/Gracker/SmartPerfetto/issues/new';
const MAX_GITHUB_DRAFT_BODY_CHARS = 8_000;

export type ExternalIssueDraftBuildResult =
  | {ok: true; draft: ExternalIssueDraftV1}
  | {ok: false; code: 'candidate_not_found' | 'confirmation_required' | 'unsafe_content'; errors: string[]};

export function buildExternalIssueDraft(input: {
  opportunity: ExternalIssueOpportunityV1;
  review: ExternalIssueReviewV1;
  manifest: RunManifestV1;
  candidateId: string;
  answers: ExternalIssueUserAnswerV1[];
  sensitiveDataReviewed: boolean;
}): ExternalIssueDraftBuildResult {
  if (!input.sensitiveDataReviewed) {
    return {
      ok: false,
      code: 'confirmation_required',
      errors: ['The user must confirm the public draft contains no sensitive data'],
    };
  }
  const candidate = input.review.candidates.find(
    item => item.candidateId === input.candidateId,
  );
  if (!candidate) {
    return {
      ok: false,
      code: 'candidate_not_found',
      errors: ['Selected candidate was not found in the validated review'],
    };
  }
  if (
    candidate.decision === 'not_reportable' ||
    candidate.decision === 'needs_verification'
  ) {
    return {
      ok: false,
      code: 'confirmation_required',
      errors: [`Candidate decision ${candidate.decision} is not ready for a public draft`],
    };
  }

  const answerMap = new Map(
    input.answers.map(answer => [answer.questionId, answer.answer.trim()]),
  );
  const missingAnswers = candidate.userQuestions
    .filter(question => question.required && !answerMap.get(question.questionId))
    .map(question => question.questionId);
  if (missingAnswers.length > 0) {
    return {
      ok: false,
      code: 'confirmation_required',
      errors: [`Required answers are missing: ${missingAnswers.join(', ')}`],
    };
  }

  const basisSignals = input.opportunity.signals.filter(signal =>
    candidate.basisSignalIds.includes(signal.signalId));
  const language = parseOutputLanguage(input.manifest.outputLanguage);
  const sections = {
    title: candidate.title,
    observedFacts: basisSignals.map(signal => `- ${signal.summary}`),
    agentAssessment: candidate.agentAssessment,
    userConfirmation: candidate.userQuestions.map(question =>
      `- ${question.prompt}\n  - ${answerMap.get(question.questionId) || localize(language, '未提供', 'Not provided')}`),
    missingEvidence: candidate.missingEvidence,
    contribution: candidate.draftSeed.suggestedContribution,
    reproduction: candidate.draftSeed.reproductionHint,
    expected: candidate.draftSeed.expectedBehavior,
  };
  const sanitized = sanitizePublicArtifactData(sections);
  if (!sanitized.ok) {
    return {
      ok: false,
      code: 'unsafe_content',
      errors: sanitized.errors,
    };
  }
  const safe = sanitized.value;
  const redactions = sanitized.warnings;
  const bodyWithoutFingerprint = [
    `## ${localize(language, '已观察事实', 'Observed facts')}`,
    safe.observedFacts.join('\n') || localize(language, '无', 'None'),
    '',
    `## ${localize(language, 'Agent 判断', 'Agent assessment')}`,
    safe.agentAssessment,
    '',
    `## ${localize(language, '用户确认', 'User confirmation')}`,
    safe.userConfirmation.join('\n') || localize(language, '无补充', 'No additional confirmation'),
    '',
    `## ${localize(language, '期望行为', 'Expected behavior')}`,
    safe.expected,
    '',
    `## ${localize(language, '复现提示', 'Reproduction hint')}`,
    safe.reproduction,
    '',
    `## ${localize(language, '可贡献内容', 'Suggested contribution')}`,
    safe.contribution,
    '',
    `## ${localize(language, '缺失证据', 'Missing evidence')}`,
    safe.missingEvidence.map(item => `- ${item}`).join('\n') ||
      localize(language, '无', 'None'),
    '',
    `## ${localize(language, '脱敏记录', 'Redactions')}`,
    redactions.map(item => `- ${item}`).join('\n') ||
      localize(language, '未自动发现需脱敏内容；提交前仍需人工复核。', 'No automatic redaction was needed; manual review is still required before submission.'),
  ].join('\n');
  const bodyPrefix = bodyWithoutFingerprint.length > MAX_GITHUB_DRAFT_BODY_CHARS
    ? `${bodyWithoutFingerprint.slice(0, MAX_GITHUB_DRAFT_BODY_CHARS)}\n\n...[draft truncated]`
    : bodyWithoutFingerprint;
  if (bodyPrefix !== bodyWithoutFingerprint) {
    redactions.push('truncated oversized GitHub draft body');
  }
  const body = [
    bodyPrefix,
    '',
    `<!-- SmartPerfetto run fingerprint: ${fingerprint(input, safe)} -->`,
  ].join('\n');
  const draftFingerprint = fingerprint(input, {title: safe.title, body});
  const githubUrl = buildGitHubDraftUrl(safe.title, body);
  return {
    ok: true,
    draft: {
      schemaVersion: EXTERNAL_ISSUE_DRAFT_SCHEMA_VERSION,
      runId: input.opportunity.runId,
      candidateId: candidate.candidateId,
      title: safe.title,
      body,
      githubUrl,
      fingerprint: draftFingerprint,
      redactions,
      notSubmitted: true,
    },
  };
}

function buildGitHubDraftUrl(title: string, body: string): string {
  const configured = process.env.SMARTPERFETTO_EXTERNAL_ISSUE_URL?.trim();
  const base = new URL(configured || DEFAULT_GITHUB_ISSUES_URL);
  base.searchParams.set('title', title);
  base.searchParams.set('body', body);
  return base.toString();
}

function fingerprint(input: {
  opportunity: ExternalIssueOpportunityV1;
  candidateId: string;
}, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify({
      runId: input.opportunity.runId,
      runManifestId: input.opportunity.runManifestId,
      candidateId: input.candidateId,
      value,
    }))
    .digest('hex');
}

export const __testing = {
  DEFAULT_GITHUB_ISSUES_URL,
  MAX_GITHUB_DRAFT_BODY_CHARS,
};
