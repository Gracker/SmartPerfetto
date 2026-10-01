// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { backendLogPath } from '../../runtimePaths';
import type { ConclusionContract } from '../../agent/core/conclusionContract';
import type { CaseKnowledgeReportRecommendation } from '../../types/caseKnowledge';
import type { ClaimVerificationIssue } from '../../types/claimVerification';
import type { DataEnvelope } from '../../types/dataContract';
import type { CaseNode } from '../../types/sparkContracts';
import { CaseLibrary } from '../caseLibrary';
import { getDefaultRagStore, type RagStore } from '../ragStore';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import {
  createCaseRetriever,
  evaluateCaseEvidenceSignature,
  type CaseRecommendationQuery,
} from './caseRecommendationRetriever';
import { recordCaseEvolutionCaseHitsPruned } from './caseEvolutionRuntimeMetrics';
import { projectScrollingCandidateClusters } from './scrollingCandidateProjector';

export interface AttachCaseHitsToContractInput {
  conclusionContract: ConclusionContract;
  dataEnvelopes: DataEnvelope[];
  sceneType?: string;
  architectureType?: string;
  knowledgeScope?: KnowledgeScope;
  library?: CaseLibrary;
  ragStore?: RagStore;
  retrieve?: (query: CaseRecommendationQuery) => CaseKnowledgeReportRecommendation[];
}

export interface AttachCaseHitsToContractResult {
  contract: ConclusionContract;
  hits: CaseKnowledgeReportRecommendation[];
}

export interface VerifyAndPruneCaseRecommendationsInput {
  contract: ConclusionContract;
  narrative?: string;
  evidenceSignaturesByCluster: Record<string, Record<string, unknown>>;
  library?: CaseLibrary;
  scope?: KnowledgeScope;
  getCase?: (caseId: string) => CaseNode | undefined;
}

export interface VerifyAndPruneCaseRecommendationsResult {
  contract: ConclusionContract;
  issues: ClaimVerificationIssue[];
}

const MAX_ATTACHED_CASES = 8;

export function attachCaseHitsToContractSync(
  input: AttachCaseHitsToContractInput,
): AttachCaseHitsToContractResult {
  const queries = projectContractQueries(input);
  if (queries.length === 0) return { contract: input.conclusionContract, hits: [] };
  const retrieve = input.retrieve ?? defaultRetriever(input);
  const seen = new Set<string>();
  const hits: CaseKnowledgeReportRecommendation[] = [];
  for (const query of queries) {
    for (const hit of retrieve(query)) {
      if (seen.has(hit.caseId)) continue;
      seen.add(hit.caseId);
      hits.push(hit);
      if (hits.length >= MAX_ATTACHED_CASES) break;
    }
    if (hits.length >= MAX_ATTACHED_CASES) break;
  }
  if (hits.length === 0) return { contract: input.conclusionContract, hits };
  return {
    contract: {
      ...input.conclusionContract,
      caseRecommendations: hits,
    },
    hits,
  };
}

export function verifyAndPruneCaseRecommendations(
  input: VerifyAndPruneCaseRecommendationsInput,
): VerifyAndPruneCaseRecommendationsResult {
  const recommendations = input.contract.caseRecommendations ?? [];
  if (recommendations.length === 0) return { contract: input.contract, issues: [] };
  const getCase = input.getCase ?? ((caseId: string) => {
    const library = input.library ?? new CaseLibrary(backendLogPath('case_library.json'));
    return library.getCase(caseId, input.scope);
  });
  const issues: ClaimVerificationIssue[] = [];
  const kept: CaseKnowledgeReportRecommendation[] = [];
  for (const hit of recommendations) {
    const caseNode = getCase(hit.caseId);
    if (!caseNode?.knowledge) {
      issues.push(issue(hit.caseId, `Case recommendation '${hit.caseId}' no longer exists`));
      continue;
    }
    const evidence = input.evidenceSignaturesByCluster[
      hit.primaryRootCause ?? caseNode.knowledge.taxonomy.primary_root_cause
    ] ?? {};
    const missing = caseNode.knowledge.evidenceSignatures.required
      .filter(signature => !evaluateCaseEvidenceSignature(signature, evidence).satisfied)
      .map(signature => signature.field);
    if (hit.matchStrength === 'strong' && missing.length > 0) {
      issues.push(issue(hit.caseId, `Case recommendation '${hit.caseId}' was pruned: missing ${missing.join(', ')}`));
      continue;
    }
    kept.push(hit);
  }

  recordCaseEvolutionCaseHitsPruned(issues.length);
  return {
    contract: {
      ...input.contract,
      ...(kept.length > 0 ? { caseRecommendations: kept } : { caseRecommendations: [] }),
    },
    issues,
  };
}

export function projectEvidenceSignaturesByCluster(
  dataEnvelopes: DataEnvelope[],
  contract?: ConclusionContract,
): Record<string, Record<string, unknown>> {
  const projected: Record<string, Record<string, unknown>> = {};
  for (const cluster of projectScrollingCandidateClusters(dataEnvelopes)) {
    projected[cluster.rootCause] = cluster.evidenceSignatures;
  }
  for (const cluster of contract?.clusters ?? []) {
    if (!projected[cluster.cluster]) projected[cluster.cluster] = { reason_code: cluster.cluster };
  }
  return projected;
}

function projectContractQueries(input: AttachCaseHitsToContractInput): CaseRecommendationQuery[] {
  const scene = input.sceneType || input.conclusionContract.metadata?.sceneId || 'scrolling';
  if (scene !== 'scrolling') return [];
  const clustersFromData = projectScrollingCandidateClusters(input.dataEnvelopes);
  if (clustersFromData.length > 0) {
    return clustersFromData.map(cluster => ({
      scene: cluster.scene,
      domainPack: cluster.domainPack,
      rootCause: cluster.rootCause,
      responsibility: cluster.responsibility,
      architectureType: input.architectureType,
      audiences: audienceForResponsibility(cluster.responsibility),
      evidenceSignatures: cluster.evidenceSignatures,
      textQuery: `${cluster.rootCause} ${cluster.evidenceSignatures.render_slices ?? ''}`,
      includeStatuses: ['published', 'reviewed'],
      topK: MAX_ATTACHED_CASES,
    }));
  }
  return input.conclusionContract.clusters.map(cluster => ({
    scene: 'scrolling',
    domainPack: 'scrolling.v1',
    rootCause: cluster.cluster,
    architectureType: input.architectureType,
    audiences: ['app', 'oem'],
    evidenceSignatures: { reason_code: cluster.cluster },
    textQuery: `${cluster.cluster} ${input.conclusionContract.conclusions.map(c => c.statement).join(' ')}`,
    includeStatuses: ['published', 'reviewed'],
    topK: MAX_ATTACHED_CASES,
  }));
}

function audienceForResponsibility(responsibility: string): Array<'app' | 'oem'> {
  if (responsibility === 'oem') return ['oem'];
  if (responsibility === 'mixed') return ['app', 'oem'];
  return ['app'];
}

function defaultRetriever(input: AttachCaseHitsToContractInput): (query: CaseRecommendationQuery) => CaseKnowledgeReportRecommendation[] {
  const library = input.library ?? new CaseLibrary(backendLogPath('case_library.json'));
  const ragStore = input.ragStore ?? getDefaultRagStore();
  const retriever = createCaseRetriever({ library, ragStore, scope: input.knowledgeScope });
  return query => retriever.retrieve(query);
}

function issue(caseId: string, message: string): ClaimVerificationIssue {
  return {
    claimId: `case:${caseId}`,
    severity: 'warning',
    code: 'case_recommendation_pruned',
    message,
  };
}
