// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {sanitizePublicArtifactData} from '../security/publicArtifactSanitizer';
import {
  EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION,
  type ExternalIssueContributionKind,
  type ExternalIssueDecision,
  type ExternalIssueOpportunityV1,
  type ExternalIssueOwnership,
  type ExternalIssueReferencesV1,
  type ExternalIssueReviewCandidateV1,
  type ExternalIssueReviewUnavailableReason,
  type ExternalIssueReviewV1,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';

const MAX_REVIEW_BYTES = 32 * 1024;
const MAX_CANDIDATES = 3;
const MAX_QUESTIONS = 2;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

const DECISIONS: readonly ExternalIssueDecision[] = [
  'report',
  'needs_user_input',
  'needs_verification',
  'not_reportable',
];
const OWNERS: readonly ExternalIssueOwnership[] = [
  'analysis',
  'skill',
  'strategy',
  'runtime',
  'trace_data',
  'product_ui',
  'unknown',
];
const CONTRIBUTIONS: readonly ExternalIssueContributionKind[] = [
  'bug_report',
  'skill_improvement',
  'strategy_improvement',
  'runtime_compatibility',
  'documentation',
  'ui_feedback',
  'trace_fixture',
  'none',
];
const CONFIDENCE = ['low', 'medium', 'high'] as const;

export type ExternalIssueReviewValidationResult =
  | {ok: true; value: ExternalIssueReviewV1; warnings: string[]}
  | {ok: false; errors: string[]; warnings: string[]};

export function validateExternalIssueReview(input: {
  raw: unknown;
  opportunity: ExternalIssueOpportunityV1;
  manifest: RunManifestV1;
  source: 'agent' | 'deterministic_fallback';
  model?: string;
  fallbackReason?: ExternalIssueReviewUnavailableReason | 'agent_invalid';
}): ExternalIssueReviewValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (serializedBytes(input.raw) > MAX_REVIEW_BYTES) {
    return {
      ok: false,
      errors: [`review exceeds ${MAX_REVIEW_BYTES} bytes`],
      warnings,
    };
  }

  const envelope = readEnvelope(input.raw, input.source, errors);
  if (!envelope) return {ok: false, errors, warnings};
  if (envelope.length > MAX_CANDIDATES) {
    errors.push(`candidates must contain at most ${MAX_CANDIDATES} items`);
  }
  if (input.opportunity.status === 'available' && envelope.length === 0) {
    errors.push('available opportunity requires at least one candidate');
  }

  const candidates: ExternalIssueReviewCandidateV1[] = [];
  const candidateIds = new Set<string>();
  for (let index = 0; index < envelope.length && index < MAX_CANDIDATES; index += 1) {
    const candidate = readCandidate(
      envelope[index],
      index,
      input.opportunity,
      input.manifest,
      errors,
    );
    if (!candidate) continue;
    if (candidateIds.has(candidate.candidateId)) {
      errors.push(`candidates[${index}].candidateId is duplicated`);
      continue;
    }
    candidateIds.add(candidate.candidateId);
    candidates.push(candidate);
  }
  if (errors.length > 0) return {ok: false, errors, warnings};

  const review: ExternalIssueReviewV1 = {
    schemaVersion: EXTERNAL_ISSUE_REVIEW_SCHEMA_VERSION,
    runId: input.opportunity.runId,
    runManifestId: input.opportunity.runManifestId,
    source: input.source,
    ...(input.model ? {model: input.model} : {}),
    ...(input.fallbackReason ? {fallbackReason: input.fallbackReason} : {}),
    candidates: [],
  };
  for (const candidate of candidates) {
    const sanitized = sanitizePublicArtifactData({
      title: candidate.title,
      agentAssessment: candidate.agentAssessment,
      missingEvidence: candidate.missingEvidence,
      questionPrompts: candidate.userQuestions.map(question => question.prompt),
      draftSeed: candidate.draftSeed,
    });
    warnings.push(...sanitized.warnings);
    if (!sanitized.ok) {
      return {ok: false, errors: sanitized.errors, warnings};
    }
    review.candidates.push({
      ...candidate,
      title: sanitized.value.title,
      agentAssessment: sanitized.value.agentAssessment,
      missingEvidence: sanitized.value.missingEvidence,
      userQuestions: candidate.userQuestions.map((question, index) => ({
        ...question,
        prompt: sanitized.value.questionPrompts[index],
      })),
      draftSeed: sanitized.value.draftSeed,
    });
  }
  return {ok: true, value: review, warnings};
}

function readEnvelope(
  raw: unknown,
  source: ExternalIssueReviewV1['source'],
  errors: string[],
): unknown[] | null {
  if (!isRecord(raw)) {
    errors.push('review must be an object');
    return null;
  }
  const allowedKeys = source === 'agent'
    ? ['candidates']
    : [
        'schemaVersion',
        'runId',
        'runManifestId',
        'source',
        'fallbackReason',
        'candidates',
      ];
  assertExactKeys(raw, allowedKeys, 'review', errors);
  if (!Array.isArray(raw.candidates)) {
    errors.push('review.candidates must be an array');
    return null;
  }
  return raw.candidates;
}

function readCandidate(
  value: unknown,
  index: number,
  opportunity: ExternalIssueOpportunityV1,
  manifest: RunManifestV1,
  errors: string[],
): ExternalIssueReviewCandidateV1 | null {
  const path = `candidates[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  assertExactKeys(value, [
    'candidateId',
    'decision',
    'ownership',
    'contributionKind',
    'confidence',
    'title',
    'agentAssessment',
    'basisSignalIds',
    'references',
    'missingEvidence',
    'userQuestions',
    'draftSeed',
  ], path, errors);

  const candidateId = readBoundedString(
    value.candidateId,
    `${path}.candidateId`,
    96,
    errors,
  );
  if (candidateId && !ID_RE.test(candidateId)) {
    errors.push(`${path}.candidateId has an invalid format`);
  }
  const decision = readEnum(
    value.decision,
    DECISIONS,
    `${path}.decision`,
    errors,
  );
  const ownership = readEnum(
    value.ownership,
    OWNERS,
    `${path}.ownership`,
    errors,
  );
  const contributionKind = readEnum(
    value.contributionKind,
    CONTRIBUTIONS,
    `${path}.contributionKind`,
    errors,
  );
  const confidence = readEnum(
    value.confidence,
    CONFIDENCE,
    `${path}.confidence`,
    errors,
  );
  const title = readBoundedString(value.title, `${path}.title`, 180, errors);
  const agentAssessment = readBoundedString(
    value.agentAssessment,
    `${path}.agentAssessment`,
    1200,
    errors,
  );
  const basisSignalIds = readStringArray(
    value.basisSignalIds,
    `${path}.basisSignalIds`,
    12,
    96,
    errors,
  );
  const basisSignals = opportunity.signals.filter(item =>
    basisSignalIds.includes(item.signalId));
  if (basisSignals.length !== basisSignalIds.length || basisSignals.length === 0) {
    errors.push(`${path}.basisSignalIds must reference existing signals`);
  }

  const allowedRefs = mergeReferences(
    basisSignals.map(item => item.references),
  );
  const references = readReferences(
    value.references,
    `${path}.references`,
    errors,
  );
  if (references) {
    assertSubset(references.claimIds, allowedRefs.claimIds, `${path}.references.claimIds`, errors);
    assertSubset(references.findingIds, allowedRefs.findingIds, `${path}.references.findingIds`, errors);
    assertSubset(references.evidenceRefIds, allowedRefs.evidenceRefIds, `${path}.references.evidenceRefIds`, errors);
    assertSubset(references.skillIds, allowedRefs.skillIds, `${path}.references.skillIds`, errors);
    const approvedSkills = new Set(
      manifest.skills
        .filter(skill =>
          skill.origin === 'built_in' ||
          (skill.origin === 'external_pack' && skill.trustState === 'approved'))
        .map(skill => skill.skillId),
    );
    assertSubset(
      references.skillIds,
      approvedSkills,
      `${path}.references.skillIds`,
      errors,
    );
  }

  const missingEvidence = readStringArray(
    value.missingEvidence,
    `${path}.missingEvidence`,
    8,
    500,
    errors,
  );
  const userQuestions = readQuestions(
    value.userQuestions,
    `${path}.userQuestions`,
    errors,
  );
  const draftSeed = readDraftSeed(
    value.draftSeed,
    `${path}.draftSeed`,
    errors,
  );

  if (
    decision === 'report' &&
    (
      confidence === 'low' ||
      !references ||
      referenceCount(references) === 0
    )
  ) {
    errors.push(
      `${path} cannot use decision report without medium/high confidence and concrete references`,
    );
  }
  if (decision === 'needs_user_input' && userQuestions.length === 0) {
    errors.push(`${path} needs_user_input requires at least one user question`);
  }
  if (
    !candidateId ||
    !decision ||
    !ownership ||
    !contributionKind ||
    !confidence ||
    !title ||
    !agentAssessment ||
    !references ||
    !draftSeed
  ) {
    return null;
  }
  return {
    candidateId,
    decision,
    ownership,
    contributionKind,
    confidence,
    title,
    agentAssessment,
    basisSignalIds,
    references,
    missingEvidence,
    userQuestions,
    draftSeed,
  };
}

function readReferences(
  value: unknown,
  path: string,
  errors: string[],
): ExternalIssueReferencesV1 | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  assertExactKeys(value, [
    'claimIds',
    'findingIds',
    'evidenceRefIds',
    'skillIds',
  ], path, errors);
  return {
    claimIds: readStringArray(value.claimIds, `${path}.claimIds`, 20, 160, errors),
    findingIds: readStringArray(value.findingIds, `${path}.findingIds`, 20, 160, errors),
    evidenceRefIds: readStringArray(value.evidenceRefIds, `${path}.evidenceRefIds`, 40, 200, errors),
    skillIds: readStringArray(value.skillIds, `${path}.skillIds`, 20, 160, errors),
  };
}

function readQuestions(
  value: unknown,
  path: string,
  errors: string[],
): ExternalIssueReviewCandidateV1['userQuestions'] {
  if (!Array.isArray(value) || value.length > MAX_QUESTIONS) {
    errors.push(`${path} must be an array with at most ${MAX_QUESTIONS} items`);
    return [];
  }
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemPath} must be an object`);
      return [];
    }
    assertExactKeys(item, ['questionId', 'prompt', 'required'], itemPath, errors);
    const questionId = readBoundedString(
      item.questionId,
      `${itemPath}.questionId`,
      96,
      errors,
    );
    const prompt = readBoundedString(
      item.prompt,
      `${itemPath}.prompt`,
      500,
      errors,
    );
    if (!questionId || !ID_RE.test(questionId)) {
      errors.push(`${itemPath}.questionId has an invalid format`);
      return [];
    }
    if (seen.has(questionId)) {
      errors.push(`${itemPath}.questionId is duplicated`);
      return [];
    }
    seen.add(questionId);
    if (!prompt || typeof item.required !== 'boolean') {
      if (typeof item.required !== 'boolean') {
        errors.push(`${itemPath}.required must be a boolean`);
      }
      return [];
    }
    return [{questionId, prompt, required: item.required}];
  });
}

function readDraftSeed(
  value: unknown,
  path: string,
  errors: string[],
): ExternalIssueReviewCandidateV1['draftSeed'] | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  assertExactKeys(value, [
    'problemStatement',
    'expectedBehavior',
    'reproductionHint',
    'suggestedContribution',
  ], path, errors);
  const problemStatement = readBoundedString(
    value.problemStatement,
    `${path}.problemStatement`,
    1200,
    errors,
  );
  const expectedBehavior = readBoundedString(
    value.expectedBehavior,
    `${path}.expectedBehavior`,
    1200,
    errors,
  );
  const reproductionHint = readBoundedString(
    value.reproductionHint,
    `${path}.reproductionHint`,
    1200,
    errors,
  );
  const suggestedContribution = readBoundedString(
    value.suggestedContribution,
    `${path}.suggestedContribution`,
    1200,
    errors,
  );
  return problemStatement &&
      expectedBehavior &&
      reproductionHint &&
      suggestedContribution
    ? {
        problemStatement,
        expectedBehavior,
        reproductionHint,
        suggestedContribution,
      }
    : null;
}

function readStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
  errors: string[],
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    errors.push(`${path} must be an array with at most ${maxItems} items`);
    return [];
  }
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = readBoundedString(
      value[index],
      `${path}[${index}]`,
      maxLength,
      errors,
    );
    if (item) output.push(item);
  }
  if (new Set(output).size !== output.length) {
    errors.push(`${path} must not contain duplicates`);
  }
  return output;
}

function readBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    errors.push(`${path} must be a non-empty string up to ${maxLength} characters`);
    return null;
  }
  return value.trim();
}

function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): T | null {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push(`${path} must be one of: ${allowed.join(', ')}`);
    return null;
  }
  return value as T;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
}

function mergeReferences(
  references: ExternalIssueReferencesV1[],
): Record<keyof ExternalIssueReferencesV1, Set<string>> {
  return {
    claimIds: new Set(references.flatMap(item => item.claimIds)),
    findingIds: new Set(references.flatMap(item => item.findingIds)),
    evidenceRefIds: new Set(references.flatMap(item => item.evidenceRefIds)),
    skillIds: new Set(references.flatMap(item => item.skillIds)),
  };
}

function assertSubset(
  values: string[],
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const value of values) {
    if (!allowed.has(value)) errors.push(`${path} contains unknown id: ${value}`);
  }
}

function referenceCount(references: ExternalIssueReferencesV1): number {
  return references.claimIds.length +
    references.findingIds.length +
    references.evidenceRefIds.length +
    references.skillIds.length;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const __testing = {
  MAX_REVIEW_BYTES,
  MAX_CANDIDATES,
  MAX_QUESTIONS,
};
