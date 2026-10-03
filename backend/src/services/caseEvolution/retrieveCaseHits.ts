// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { backendLogPath } from '../../runtimePaths';
import { CURATED_CASE_STATUSES, type CaseKnowledgeReportRecommendation } from '../../types/caseKnowledge';
import type { DataEnvelope } from '../../types/dataContract';
import { CaseLibrary } from '../caseLibrary';
import { getDefaultRagStore } from '../ragStore';
import type { KnowledgeScope } from '../scopedKnowledgeStore';
import { createCaseRetriever, type CaseRecommendationQuery } from './caseRecommendationRetriever';
import { projectScrollingCandidateClusters } from './scrollingCandidateProjector';

export interface RetrieveCaseHitsInput {
  dataEnvelopes: DataEnvelope[];
  /** The run's scene; retrieval covers scrolling only. */
  sceneType?: string;
  /** The trace's detected rendering architecture; required so a caller says whether it knows it. */
  architectureType: string | undefined;
  knowledgeScope?: KnowledgeScope;
  retrieve?: (query: CaseRecommendationQuery) => CaseKnowledgeReportRecommendation[];
}

const MAX_CASE_HITS = 8;

/**
 * Match curated cases against the trace's own frame clusters. Every query is
 * built from one cluster's data, so a hit's `evidenceRefs` name the envelope
 * its signatures were evaluated against; nothing the model wrote enters a query.
 */
export function retrieveCaseHits(input: RetrieveCaseHitsInput): CaseKnowledgeReportRecommendation[] {
  if ((input.sceneType ?? 'scrolling') !== 'scrolling') return [];
  const queries: CaseRecommendationQuery[] = projectScrollingCandidateClusters(input.dataEnvelopes).map(cluster => ({
    scene: cluster.scene,
    domainPack: cluster.domainPack,
    rootCause: cluster.rootCause,
    architectureType: input.architectureType,
    responsibility: cluster.responsibility,
    audiences: audienceForResponsibility(cluster.responsibility),
    evidenceSignatures: cluster.evidenceSignatures,
    evidenceRefIds: cluster.evidenceRefIds,
    textQuery: `${cluster.rootCause} ${cluster.evidenceSignatures.render_slices ?? ''}`,
    includeStatuses: CURATED_CASE_STATUSES,
    topK: MAX_CASE_HITS,
  }));
  if (queries.length === 0) return [];
  const retrieve = input.retrieve ?? defaultRetriever(input.knowledgeScope);
  const seen = new Set<string>();
  const hits: CaseKnowledgeReportRecommendation[] = [];
  for (const query of queries) {
    for (const hit of retrieve(query)) {
      if (seen.has(hit.caseId)) continue;
      seen.add(hit.caseId);
      hits.push(hit);
      if (hits.length >= MAX_CASE_HITS) return hits;
    }
  }
  return hits;
}

function audienceForResponsibility(responsibility: string): Array<'app' | 'oem'> {
  if (responsibility === 'oem') return ['oem'];
  if (responsibility === 'mixed') return ['app', 'oem'];
  return ['app'];
}

function defaultRetriever(scope: KnowledgeScope | undefined): (query: CaseRecommendationQuery) => CaseKnowledgeReportRecommendation[] {
  const retriever = createCaseRetriever({
    library: new CaseLibrary(backendLogPath('case_library.json')), ragStore: getDefaultRagStore(), scope,
  });
  return query => retriever.retrieve(query);
}
