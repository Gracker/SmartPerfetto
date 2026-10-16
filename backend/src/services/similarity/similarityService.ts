// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import { localize, parseOutputLanguage, type OutputLanguage } from '../../agentv3/outputLanguage';
import type { CaseKnowledgeMatchStrength } from '../../types/caseKnowledge';
import type {
  AnalysisResultSnapshot,
  SimilarityHintBand,
  SimilarityHintV1,
  TraceSimilaritySignatureV1,
} from '../../types/multiTraceComparison';
import type {
  AnalysisResultSnapshotListFilters,
  SnapshotAccessScope,
  SnapshotReadOptions,
} from '../analysisResultSnapshotStore';
import type { CaseLibrary } from '../caseLibrary';
import {
  type CaseRecommendationHit,
  createCaseRetriever,
} from '../caseEvolution/caseRecommendationRetriever';
import type { RagStore } from '../ragStore';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import { boundedSimilarityLimit, rankSnapshotSimilarityHints } from './similarityMatcher';
import { buildTraceSimilaritySignature } from './traceSimilaritySignature';

const SNAPSHOT_CANDIDATE_LIMIT = 200;

export interface TraceSimilarityServiceDeps {
  snapshotRepository: TraceSimilaritySnapshotRepository;
  caseLibrary?: CaseLibrary;
  ragStore?: RagStore;
}

export interface TraceSimilaritySnapshotRepository {
  getSnapshot(
    scope: SnapshotAccessScope,
    snapshotId: string,
    options?: SnapshotReadOptions,
  ): AnalysisResultSnapshot | null;
  listSnapshots(scope: SnapshotAccessScope, filters?: AnalysisResultSnapshotListFilters): AnalysisResultSnapshot[];
}

export interface FindTraceSimilarityInput extends SnapshotReadOptions {
  scope: SnapshotAccessScope;
  knowledgeScope?: KnowledgeScope;
  snapshotId: string;
  includeCases?: boolean;
  limit?: number;
  outputLanguage?: OutputLanguage;
}

export interface TraceSimilarityResultV1 {
  schemaVersion: 1;
  snapshotId: string;
  signature: TraceSimilaritySignatureV1;
  snapshotHints: SimilarityHintV1[];
  caseHints: SimilarityHintV1[];
  hints: SimilarityHintV1[];
  count: number;
}

export function createTraceSimilarityService(
  deps: TraceSimilarityServiceDeps,
): {
  findSimilarAnalysisResult(input: FindTraceSimilarityInput): TraceSimilarityResultV1 | null;
} {
  return {
    findSimilarAnalysisResult(input: FindTraceSimilarityInput): TraceSimilarityResultV1 | null {
      const readOptions = {excludeRestricted: input.excludeRestricted};
      const currentSnapshot = deps.snapshotRepository.getSnapshot(input.scope, input.snapshotId, readOptions);
      if (!currentSnapshot) return null;
      const limit = boundedSimilarityLimit(input.limit);
      const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
      const signature = buildTraceSimilaritySignature(currentSnapshot);
      const candidates = collectCandidateSnapshots(deps.snapshotRepository, input.scope, currentSnapshot, readOptions);
      const snapshotHints = rankSnapshotSimilarityHints({
        currentSnapshot,
        currentSignature: signature,
        candidates: candidates.map(snapshot => ({
          snapshot,
          signature: buildTraceSimilaritySignature(snapshot),
        })),
        limit,
        outputLanguage,
      });
      const caseHints = input.includeCases
        ? buildCaseHints({
          deps,
          currentSnapshotId: currentSnapshot.id,
          signature,
          knowledgeScope: input.knowledgeScope,
          limit,
          outputLanguage,
        })
        : [];
      const hints = [...snapshotHints, ...caseHints];
      return {
        schemaVersion: 1,
        snapshotId: currentSnapshot.id,
        signature,
        snapshotHints,
        caseHints,
        hints,
        count: hints.length,
      };
    },
  };
}

function collectCandidateSnapshots(
  repository: TraceSimilaritySnapshotRepository,
  scope: SnapshotAccessScope,
  currentSnapshot: AnalysisResultSnapshot,
  readOptions: SnapshotReadOptions,
): AnalysisResultSnapshot[] {
  const byId = new Map<string, AnalysisResultSnapshot>();
  for (const candidate of repository.listSnapshots(scope, {
    sceneType: currentSnapshot.sceneType,
    includeConclusionContract: true,
    limit: SNAPSHOT_CANDIDATE_LIMIT,
    ...readOptions,
  })) {
    byId.set(candidate.id, candidate);
  }
  if (byId.size <= 1) {
    for (const candidate of repository.listSnapshots(scope, {
      includeConclusionContract: true,
      limit: SNAPSHOT_CANDIDATE_LIMIT,
      ...readOptions,
    })) {
      byId.set(candidate.id, candidate);
    }
  }
  byId.delete(currentSnapshot.id);
  return [...byId.values()];
}

function buildCaseHints(input: {
  deps: TraceSimilarityServiceDeps;
  currentSnapshotId: string;
  signature: TraceSimilaritySignatureV1;
  knowledgeScope?: KnowledgeScope;
  limit: number;
  outputLanguage: OutputLanguage;
}): SimilarityHintV1[] {
  if (!input.deps.caseLibrary || !input.deps.ragStore || !input.signature.caseQuery) return [];
  if (Object.keys(input.signature.caseEvidenceSignatures).length === 0) return [];
  const retriever = createCaseRetriever({
    library: input.deps.caseLibrary,
    ragStore: input.deps.ragStore,
    scope: input.knowledgeScope,
  });
  const query = input.signature.caseQuery;
  const hits = retriever.retrieve({
    scene: query.scene,
    domainPack: query.domainPack,
    rootCause: query.rootCause,
    secondaryRootCauses: query.secondaryRootCauses,
    responsibility: query.responsibility,
    // A similarity signature records no rendering architecture, so it cannot rule a case out.
    architectureType: undefined,
    audiences: query.audiences ?? ['app'],
    evidenceSignatures: input.signature.caseEvidenceSignatures,
    topK: input.limit,
    includeStatuses: ['published'],
  });
  return hits.map(hit => caseHitToSimilarityHint(
    input.currentSnapshotId,
    input.signature,
    hit,
    input.outputLanguage,
  ));
}

function caseHitToSimilarityHint(
  currentSnapshotId: string,
  signature: TraceSimilaritySignatureV1,
  hit: CaseRecommendationHit,
  outputLanguage: OutputLanguage,
): SimilarityHintV1 {
  const score = caseScore(hit.matchStrength, hit.matchedSignatures.length);
  return {
    schemaVersion: 1,
    id: caseSimilarityHintId(currentSnapshotId, hit.caseId),
    source: 'case_library',
    sourceId: hit.caseId,
    score,
    band: caseBand(hit.matchStrength),
    matchReasons: [
      {
        feature: 'case:scene',
        currentValue: signature.caseQuery?.scene,
        matchedValue: hit.scene,
        weight: 0.12,
      },
      {
        feature: 'case:rootCause',
        currentValue: signature.caseQuery?.rootCause,
        matchedValue: hit.primaryRootCause,
        weight: 0.18,
      },
      ...hit.matchedSignatures.slice(0, 8).map(field => ({
        feature: `caseSignature:${field}`,
        currentValue: scalarReasonValue(signature.caseEvidenceSignatures[field]),
        matchedValue: field,
        weight: 0.05,
      })),
    ],
    limitations: caseLimitations(hit, outputLanguage),
    allowedUse: 'navigation_hint_only',
  };
}

function caseScore(strength: CaseKnowledgeMatchStrength, matchedCount: number): number {
  const base = strength === 'strong'
    ? 0.80
    : strength === 'partial'
      ? 0.55
      : 0.25;
  return Math.min(1, Number((base + Math.min(matchedCount, 5) * 0.03).toFixed(3)));
}

function caseBand(strength: CaseKnowledgeMatchStrength): SimilarityHintBand {
  return strength === 'strong'
    ? 'strong'
    : strength === 'partial'
      ? 'partial'
      : 'background';
}

function caseLimitations(hit: CaseRecommendationHit, outputLanguage: OutputLanguage): string[] {
  const limitations = [localize(
    outputLanguage,
    '案例相似性只是导航提示，不是诊断证据。',
    'Case similarity is a navigation hint only and not diagnostic evidence.',
  )];
  if (hit.matchStrength !== 'strong') limitations.push(localize(
    outputLanguage,
    '除非在当前 trace 中验证了证据签名，否则该案例命中只能作为上下文参考。',
    'Case hit is contextual unless its evidence signatures are verified in this trace.',
  ));
  if (hit.evidenceGap) limitations.push(hit.evidenceGap);
  if (hit.missingRequiredSignatures.length > 0) {
    limitations.push(localize(
      outputLanguage,
      `缺少必要案例签名：${hit.missingRequiredSignatures.join(', ')}`,
      `Missing required case signatures: ${hit.missingRequiredSignatures.join(', ')}`,
    ));
  }
  return limitations;
}

function scalarReasonValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(', ');
  return undefined;
}

function caseSimilarityHintId(currentSnapshotId: string, caseId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${currentSnapshotId}\0${caseId}`)
    .digest('hex')
    .slice(0, 16);
  return `similarity:case:${digest}`;
}
