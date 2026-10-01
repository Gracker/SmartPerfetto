// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { backendLogPath } from '../../runtimePaths';
import {
  CASE_CANDIDATE_REVIEW_SCHEMA_VERSION,
  type CaseCandidate,
  type CaseCandidateReview,
  type CaseEvolutionConfidenceBucket,
} from '../../types/caseEvolution';
import type {
  CaseEvidenceSignature,
  CaseEvidenceSignatureOperator,
  CaseKnowledgeFinding,
  CaseKnowledgeFrontmatter,
  CaseKnowledgeRecommendation,
  CaseKnowledgeRecommendationPriority,
  CaseKnowledgeRelations,
  CaseKnowledgeResponsibility,
  CaseKnowledgeSeverity,
} from '../../types/caseKnowledge';
import type { CaseNode } from '../../types/sparkContracts';
import {
  formatThreats,
  scanContent as defaultScanContent,
  type ThreatMatch,
} from '../../agentv3/selfImprove/contentScanner';
import { detectedCaseArchitecture } from '../caseArchitecture';
import { validateCaseDomainPack } from '../caseDomainPacks';
import { CaseLibrary } from '../caseLibrary';

const MAX_REVIEW_BYTES = 16 * 1024;

const DECISIONS = new Set<CaseCandidateReview['decision']>([
  'promote',
  'reject',
  'needs_more_evidence',
]);
const CONFIDENCE_BUCKETS = new Set<CaseEvolutionConfidenceBucket>([
  'high',
  'medium',
  'low',
]);
const RESPONSIBILITIES = new Set<CaseKnowledgeResponsibility>([
  'app',
  'oem',
  'mixed',
  'unknown',
]);
const SEVERITIES = new Set<CaseKnowledgeSeverity>([
  'critical',
  'warning',
  'info',
]);
const SIGNATURE_OPERATORS = new Set<CaseEvidenceSignatureOperator>([
  'eq',
  'contains_any',
  'gte',
  'lte',
]);
const FINDING_CONFIDENCE = new Set<CaseKnowledgeFinding['confidence']>([
  'low',
  'medium',
  'high',
]);
const RECOMMENDATION_PRIORITIES = new Set<CaseKnowledgeRecommendationPriority>([
  'P0',
  'P1',
  'P2',
  'P3',
]);
export const CASE_EVOLUTION_ALLOWED_RELATION_KINDS = [
  'similar_root_cause',
  'derived_pattern',
] as const;
const ALLOWED_RELATION_KINDS = new Set<string>(CASE_EVOLUTION_ALLOWED_RELATION_KINDS);
const RELATION_TARGET_STATUSES = new Set(['published', 'reviewed']);

export type CaseCandidateReviewValidationResult =
  | {ok: true; review: CaseCandidateReview; warnings: string[]}
  | {ok: false; errors: string[]; warnings: string[]};

export interface CaseCandidateReviewValidatorDeps {
  maxBytes?: number;
  scanContent?: (text: unknown) => ThreatMatch[];
  validateDomainPack?: typeof validateCaseDomainPack;
  listCases?: () => Array<Pick<CaseNode, 'caseId' | 'status'>>;
  caseLibrary?: Pick<CaseLibrary, 'listCases'>;
  caseLibraryPath?: string;
}

export function validateCaseCandidateReview(
  raw: unknown,
  candidate: CaseCandidate,
  deps: CaseCandidateReviewValidatorDeps = {},
): CaseCandidateReviewValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const payload = parsePayload(raw, errors);
  if (!payload) return {ok: false, errors, warnings};

  const maxBytes = deps.maxBytes ?? MAX_REVIEW_BYTES;
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > maxBytes) {
    errors.push(`review payload exceeds 16KB cap (${payloadBytes} bytes)`);
  }

  const proposed = readRecord(payload.proposed, 'proposed', errors);
  const evidenceSignatures = proposed
    ? readEvidenceSignatures(proposed.evidenceSignatures, errors)
    : emptyEvidenceSignatures();
  const recommendations = proposed
    ? readRecommendations(proposed.recommendations, errors)
    : emptyRecommendations();
  const relations = proposed
    ? filterRelations(proposed.relations, deps, warnings, errors)
    : {};

  const review: CaseCandidateReview = {
    schemaVersion: readLiteral(
      payload.schemaVersion,
      'schemaVersion',
      CASE_CANDIDATE_REVIEW_SCHEMA_VERSION,
      errors,
    ),
    candidateId: readString(payload.candidateId, 'candidateId', errors),
    decision: readEnum(payload.decision, 'decision', DECISIONS, errors),
    confidence: readEnum(payload.confidence, 'confidence', CONFIDENCE_BUCKETS, errors),
    proposed: {
      title: readString(proposed?.title, 'proposed.title', errors),
      primaryRootCause: readString(proposed?.primaryRootCause, 'proposed.primaryRootCause', errors),
      secondaryRootCauses: readStringArray(
        proposed?.secondaryRootCauses,
        'proposed.secondaryRootCauses',
        errors,
      ),
      responsibility: readEnum(
        proposed?.responsibility,
        'proposed.responsibility',
        RESPONSIBILITIES,
        errors,
      ),
      severity: readEnum(proposed?.severity, 'proposed.severity', SEVERITIES, errors),
      evidenceSignatures,
      findings: readFindings(proposed?.findings, errors),
      recommendations,
      relations,
    },
    evidenceSummary: readString(payload.evidenceSummary, 'evidenceSummary', errors),
    risks: readStringArray(payload.risks, 'risks', errors),
  };

  if (review.candidateId && review.candidateId !== candidate.candidateId) {
    errors.push(`candidateId '${review.candidateId}' does not match candidate '${candidate.candidateId}'`);
  }
  if (review.proposed.evidenceSignatures.required.length === 0) {
    errors.push('proposed.evidenceSignatures.required must contain at least one signature');
  }

  errors.push(...scanFreeText(review, deps.scanContent ?? defaultScanContent));
  errors.push(...validateDomainReview(review, candidate, deps));

  if (errors.length > 0) return {ok: false, errors, warnings};
  return {ok: true, review, warnings};
}

function parsePayload(raw: unknown, errors: string[]): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
      errors.push('review payload must be a JSON object');
      return null;
    } catch (err) {
      errors.push(`review payload is not valid JSON: ${(err as Error).message}`);
      return null;
    }
  }
  if (!isRecord(raw)) {
    errors.push('review payload must be an object');
    return null;
  }
  return raw;
}

function readLiteral<T extends string>(
  value: unknown,
  path: string,
  expected: T,
  errors: string[],
): T {
  if (value !== expected) {
    errors.push(`${path} must be '${expected}'`);
  }
  return expected;
}

function readString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return '';
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: ReadonlySet<T>,
  errors: string[],
): T {
  if (typeof value === 'string' && allowed.has(value as T)) {
    return value as T;
  }
  errors.push(`${path} must be one of: ${Array.from(allowed).join(', ')}`);
  return Array.from(allowed)[0];
}

function readStringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    } else {
      out.push(item);
    }
  });
  return out;
}

function readEvidenceSignatures(
  value: unknown,
  errors: string[],
): CaseCandidateReview['proposed']['evidenceSignatures'] {
  const record = readRecord(value, 'proposed.evidenceSignatures', errors);
  if (!record) return emptyEvidenceSignatures();
  return {
    required: readSignatureArray(record.required, 'proposed.evidenceSignatures.required', errors),
    supportive: readSignatureArray(record.supportive, 'proposed.evidenceSignatures.supportive', errors),
  };
}

function readSignatureArray(
  value: unknown,
  path: string,
  errors: string[],
): CaseEvidenceSignature[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const signatures: CaseEvidenceSignature[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    const field = readString(item.field, `${path}[${index}].field`, errors);
    const op = readEnum(item.op, `${path}[${index}].op`, SIGNATURE_OPERATORS, errors);
    if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
      errors.push(`${path}[${index}].value is required`);
    }
    signatures.push({field, op, value: item.value});
  });
  return signatures;
}

function readFindings(value: unknown, errors: string[]): CaseKnowledgeFinding[] {
  if (!Array.isArray(value)) {
    errors.push('proposed.findings must be an array');
    return [];
  }
  const findings: CaseKnowledgeFinding[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`proposed.findings[${index}] must be an object`);
      return;
    }
    findings.push({
      id: readString(item.id, `proposed.findings[${index}].id`, errors),
      title: readString(item.title, `proposed.findings[${index}].title`, errors),
      evidence_refs: readStringArray(item.evidence_refs, `proposed.findings[${index}].evidence_refs`, errors),
      confidence: readEnum(
        item.confidence,
        `proposed.findings[${index}].confidence`,
        FINDING_CONFIDENCE,
        errors,
      ),
    });
  });
  return findings;
}

function readRecommendations(
  value: unknown,
  errors: string[],
): CaseCandidateReview['proposed']['recommendations'] {
  const record = readRecord(value, 'proposed.recommendations', errors);
  if (!record) return emptyRecommendations();
  return {
    app: readRecommendationArray(record.app, 'proposed.recommendations.app', errors),
    oem: readRecommendationArray(record.oem, 'proposed.recommendations.oem', errors),
  };
}

function readRecommendationArray(
  value: unknown,
  path: string,
  errors: string[],
): CaseKnowledgeRecommendation[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const recommendations: CaseKnowledgeRecommendation[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${path}[${index}] must be an object`);
      return;
    }
    recommendations.push({
      id: readString(item.id, `${path}[${index}].id`, errors),
      priority: readEnum(item.priority, `${path}[${index}].priority`, RECOMMENDATION_PRIORITIES, errors),
      action: readString(item.action, `${path}[${index}].action`, errors),
      applies_when: readString(item.applies_when, `${path}[${index}].applies_when`, errors),
      risks: readString(item.risks, `${path}[${index}].risks`, errors),
    });
  });
  return recommendations;
}

function filterRelations(
  value: unknown,
  deps: CaseCandidateReviewValidatorDeps,
  warnings: string[],
  errors: string[],
): CaseKnowledgeRelations {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push('proposed.relations must be an object');
    return {};
  }
  const validTargets = new Set(
    listRelationTargetCases(deps)
      .filter(c => RELATION_TARGET_STATUSES.has(c.status))
      .map(c => c.caseId),
  );
  const filtered: CaseKnowledgeRelations = {};
  for (const [kind, targets] of Object.entries(value)) {
    if (!ALLOWED_RELATION_KINDS.has(kind)) {
      errors.push(`unsupported relation kind '${kind}'`);
      continue;
    }
    if (!Array.isArray(targets)) {
      errors.push(`proposed.relations.${kind} must be an array`);
      continue;
    }
    const kept: string[] = [];
    targets.forEach((target, index) => {
      if (typeof target !== 'string' || target.trim().length === 0) {
        errors.push(`proposed.relations.${kind}[${index}] must be a non-empty string`);
        return;
      }
      if (validTargets.has(target)) {
        kept.push(target);
      } else {
        warnings.push(`dropped unknown relation target '${target}' from ${kind}`);
      }
    });
    if (kept.length > 0) filtered[kind] = kept;
  }
  return filtered;
}

function listRelationTargetCases(
  deps: CaseCandidateReviewValidatorDeps,
): Array<Pick<CaseNode, 'caseId' | 'status'>> {
  if (deps.listCases) return deps.listCases();
  const library = deps.caseLibrary ?? new CaseLibrary(
    deps.caseLibraryPath ?? backendLogPath('case_library.json'),
  );
  return [
    ...library.listCases({status: 'published'}),
    ...library.listCases({status: 'reviewed'}),
  ];
}

function scanFreeText(
  review: CaseCandidateReview,
  scanContent: (text: unknown) => ThreatMatch[],
): string[] {
  const errors: string[] = [];
  const fields = [
    review.proposed.title,
    review.evidenceSummary,
    ...review.risks,
    ...review.proposed.findings.map(f => f.title),
    ...review.proposed.recommendations.app.flatMap(r => [
      r.action,
      r.applies_when,
      r.risks,
    ]),
    ...review.proposed.recommendations.oem.flatMap(r => [
      r.action,
      r.applies_when,
      r.risks,
    ]),
  ];
  for (const field of fields) {
    const threats = scanContent(field);
    if (threats.length > 0) {
      errors.push(`review text rejected by content scanner: ${formatThreats(threats)}`);
    }
  }
  return errors;
}

function validateDomainReview(
  review: CaseCandidateReview,
  candidate: CaseCandidate,
  deps: CaseCandidateReviewValidatorDeps,
): string[] {
  const frontmatter: CaseKnowledgeFrontmatter = {
    case_id: candidate.candidateId,
    title: review.proposed.title || candidate.cluster.rootCause,
    status: 'reviewed',
    quality: 'imported',
    scene: candidate.cluster.scene,
    domain_pack: candidate.cluster.domainPack,
    taxonomy: {
      primary_root_cause: review.proposed.primaryRootCause,
      secondary_root_causes: review.proposed.secondaryRootCauses,
      responsibility: review.proposed.responsibility,
      severity: review.proposed.severity,
    },
    context: {
      ...detectedCaseArchitecture(candidate.provenance.architectureType),
      source_candidate_id: candidate.candidateId,
    },
    evidence_signatures: review.proposed.evidenceSignatures,
    findings: review.proposed.findings,
    recommendations: review.proposed.recommendations,
    relations: review.proposed.relations,
  };
  const issues = (deps.validateDomainPack ?? validateCaseDomainPack)(
    frontmatter,
    `case-evolution:${candidate.candidateId}`,
  );
  return issues.map(issue =>
    `${issue.fieldPath ? `${issue.fieldPath}: ` : ''}${issue.message}`,
  );
}

function readRecord(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyEvidenceSignatures(): CaseCandidateReview['proposed']['evidenceSignatures'] {
  return {required: [], supportive: []};
}

function emptyRecommendations(): CaseCandidateReview['proposed']['recommendations'] {
  return {app: [], oem: []};
}

export const __testing = {
  MAX_REVIEW_BYTES,
  CASE_EVOLUTION_ALLOWED_RELATION_KINDS,
};
