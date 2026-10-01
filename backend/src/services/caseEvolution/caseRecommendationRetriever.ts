// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  caseKnowledgeQualityRank,
  caseStatusRank,
  type CaseEvidenceSignature,
  type CaseKnowledgeMatchStrength,
  type CaseKnowledgeRecommendation,
  type CaseKnowledgeReportRecommendation,
  type CaseKnowledgeResponsibility,
  type CuratedCaseStatus,
  CURATED_CASE_STATUSES,
} from '../../types/caseKnowledge';
import type { CaseNode } from '../../types/sparkContracts';
import { CaseLibrary } from '../caseLibrary';
import { RagStore } from '../ragStore';
import type { KnowledgeScope } from '../scopedKnowledgeStore';

export interface CaseRecommendationQuery {
  scene: string;
  domainPack: string;
  rootCause: string;
  secondaryRootCauses?: string[];
  responsibility?: CaseKnowledgeResponsibility;
  audiences: Array<'app' | 'oem'>;
  context?: Record<string, unknown>;
  evidenceSignatures: Record<string, unknown>;
  /** Trace evidence `evidenceSignatures` were read from; absent when a caller supplied the values itself. */
  evidenceRefIds?: readonly string[];
  textQuery?: string;
  topK?: number;
  includeStatuses?: readonly CuratedCaseStatus[];
}

export interface CaseRecommendationHit extends CaseKnowledgeReportRecommendation {
  matchedSignatures: string[];
  missingRequiredSignatures: string[];
  recommendations: {
    app: CaseKnowledgeRecommendation[];
    oem: CaseKnowledgeRecommendation[];
  };
}

export interface SignatureEvaluationResult {
  satisfied: boolean;
  reason: 'matched' | 'missing' | 'type_mismatch' | 'non_numeric';
}

export interface CaseRetrieverDeps {
  library: CaseLibrary;
  ragStore: RagStore;
  scope?: KnowledgeScope;
}

type RankedCase = {
  caseNode: CaseNode;
  matchStrength: CaseKnowledgeMatchStrength;
  matchedSignatures: string[];
  missingRequiredSignatures: string[];
  evidenceGap?: string;
  keywordScore: number;
};

const DEFAULT_STATUSES: readonly CuratedCaseStatus[] = ['published'];

export function evaluateCaseEvidenceSignature(
  signature: CaseEvidenceSignature,
  evidence: Record<string, unknown>,
): SignatureEvaluationResult {
  if (!Object.prototype.hasOwnProperty.call(evidence, signature.field)) {
    return { satisfied: false, reason: 'missing' };
  }
  const actual = evidence[signature.field];
  switch (signature.op) {
    case 'eq':
      if (!isScalar(actual) || !isScalar(signature.value) || typeof actual !== typeof signature.value) {
        return { satisfied: false, reason: 'type_mismatch' };
      }
      return { satisfied: actual === signature.value, reason: actual === signature.value ? 'matched' : 'type_mismatch' };
    case 'contains_any':
      return evaluateContainsAny(actual, signature.value);
    case 'gte':
    case 'lte':
      if (typeof actual !== 'number' || typeof signature.value !== 'number') {
        return { satisfied: false, reason: 'type_mismatch' };
      }
      if (!Number.isFinite(actual) || !Number.isFinite(signature.value)) {
        return { satisfied: false, reason: 'non_numeric' };
      }
      return {
        satisfied: signature.op === 'gte' ? actual >= signature.value : actual <= signature.value,
        reason: signature.op === 'gte'
          ? actual >= signature.value ? 'matched' : 'non_numeric'
          : actual <= signature.value ? 'matched' : 'non_numeric',
      };
  }
}

export function createCaseRetriever(deps: CaseRetrieverDeps): { retrieve(query: CaseRecommendationQuery): CaseRecommendationHit[] } {
  // A retriever serves one retrieval, so the admitted cases are listed once for all its queries.
  let admitted: CaseNode[] | undefined;
  return {
    retrieve(query: CaseRecommendationQuery) {
      const statuses: readonly string[] = query.includeStatuses && query.includeStatuses.length > 0
        ? query.includeStatuses
        : DEFAULT_STATUSES;
      admitted ??= deps.library.listAdmittedCases(CURATED_CASE_STATUSES, deps.scope);
      const cases = admitted.filter(caseNode => statuses.includes(caseNode.status));
      const keywordScores = buildKeywordScoreMap(deps.ragStore, query, deps.scope);
      const ranked: RankedCase[] = [];
      for (const caseNode of cases) {
        if (!matchesStructuredQuery(caseNode, query)) continue;
        const evaluation = evaluateCaseNode(caseNode, query.evidenceSignatures);
        ranked.push({
          caseNode,
          keywordScore: keywordScores.get(caseNode.caseId) ?? 0,
          ...evaluation,
        });
      }
      ranked.sort(rankCases);
      return ranked.slice(0, query.topK ?? 8).map(item => toHit(item, query.evidenceRefIds));
    },
  };
}

function evaluateContainsAny(actual: unknown, expected: unknown): SignatureEvaluationResult {
  if (!Array.isArray(expected) || !expected.every(item => typeof item === 'string')) {
    return { satisfied: false, reason: 'type_mismatch' };
  }
  const actualValues = typeof actual === 'string'
    ? [actual]
    : Array.isArray(actual) && actual.every(item => typeof item === 'string')
      ? actual
      : null;
  if (!actualValues) return { satisfied: false, reason: 'type_mismatch' };
  const actualSet = new Set(actualValues);
  return {
    satisfied: expected.some(item => actualSet.has(item)),
    reason: expected.some(item => actualSet.has(item)) ? 'matched' : 'type_mismatch',
  };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function matchesStructuredQuery(caseNode: CaseNode, query: CaseRecommendationQuery): boolean {
  const knowledge = caseNode.knowledge;
  if (!knowledge) return false;
  if (knowledge.scene !== query.scene) return false;
  if (knowledge.domainPack !== query.domainPack) return false;
  const taxonomy = knowledge.taxonomy;
  const rootCauses = new Set([query.rootCause, ...(query.secondaryRootCauses ?? [])]);
  if (!rootCauses.has(taxonomy.primary_root_cause)) return false;
  if (query.responsibility && !responsibilityCompatible(taxonomy.responsibility, query.responsibility)) return false;
  return true;
}

function responsibilityCompatible(caseResp: CaseKnowledgeResponsibility, queryResp: CaseKnowledgeResponsibility): boolean {
  if (caseResp === queryResp) return true;
  if (caseResp === 'mixed') return queryResp === 'app' || queryResp === 'oem' || queryResp === 'mixed';
  if (queryResp === 'mixed') return caseResp === 'app' || caseResp === 'oem';
  if (caseResp === 'unknown' || queryResp === 'unknown') return true;
  return false;
}

function evaluateCaseNode(
  caseNode: CaseNode,
  evidence: Record<string, unknown>,
): Pick<RankedCase, 'matchStrength' | 'matchedSignatures' | 'missingRequiredSignatures' | 'evidenceGap'> {
  const signatures = caseNode.knowledge?.evidenceSignatures;
  const matchedSignatures: string[] = [];
  const missingRequiredSignatures: string[] = [];
  for (const signature of signatures?.required ?? []) {
    const result = evaluateCaseEvidenceSignature(signature, evidence);
    if (result.satisfied) matchedSignatures.push(signature.field);
    else missingRequiredSignatures.push(signature.field);
  }
  let supportiveMatches = 0;
  for (const signature of signatures?.supportive ?? []) {
    const result = evaluateCaseEvidenceSignature(signature, evidence);
    if (result.satisfied) {
      supportiveMatches++;
      matchedSignatures.push(signature.field);
    }
  }
  if (missingRequiredSignatures.length > 0) {
    return {
      matchStrength: 'background',
      matchedSignatures,
      missingRequiredSignatures,
      evidenceGap: `Missing required evidence: ${missingRequiredSignatures.join(', ')}`,
    };
  }
  return {
    matchStrength: supportiveMatches > 0 ? 'strong' : 'partial',
    matchedSignatures,
    missingRequiredSignatures,
  };
}

function buildKeywordScoreMap(
  ragStore: RagStore,
  query: CaseRecommendationQuery,
  scope?: KnowledgeScope,
): Map<string, number> {
  const scores = new Map<string, number>();
  const textQuery = query.textQuery?.trim();
  if (!textQuery) return scores;
  const result = ragStore.search(textQuery, {
    kinds: ['case_library'],
    topK: 50,
    scope,
  });
  for (const hit of result.results) {
    const uri = hit.chunk?.uri;
    if (!uri) continue;
    const caseId = caseIdFromCaseUri(uri);
    if (caseId) scores.set(caseId, Math.max(scores.get(caseId) ?? 0, hit.score));
  }
  return scores;
}

function caseIdFromCaseUri(uri: string): string | null {
  return uri.startsWith('case://') ? uri.slice('case://'.length) : null;
}

function rankCases(a: RankedCase, b: RankedCase): number {
  return matchStrengthRank(b.matchStrength) - matchStrengthRank(a.matchStrength)
    || caseStatusRank(b.caseNode.status) - caseStatusRank(a.caseNode.status)
    || caseKnowledgeQualityRank(b.caseNode.knowledge?.quality) - caseKnowledgeQualityRank(a.caseNode.knowledge?.quality)
    || b.keywordScore - a.keywordScore
    || a.caseNode.caseId.localeCompare(b.caseNode.caseId);
}

function matchStrengthRank(value: CaseKnowledgeMatchStrength): number {
  return value === 'strong' ? 3 : value === 'partial' ? 2 : 1;
}

function toHit(item: RankedCase, evidenceRefIds: readonly string[] | undefined): CaseRecommendationHit {
  const knowledge = item.caseNode.knowledge!;
  return {
    caseId: item.caseNode.caseId,
    title: item.caseNode.title,
    scene: knowledge.scene,
    primaryRootCause: knowledge.taxonomy.primary_root_cause,
    matchStrength: item.matchStrength,
    matchedSignatures: item.matchedSignatures,
    missingRequiredSignatures: item.missingRequiredSignatures,
    evidenceGap: item.evidenceGap,
    ...(evidenceRefIds?.length ? { evidenceRefs: [...evidenceRefIds] } : {}),
    recommendations: knowledge.recommendations,
  };
}
