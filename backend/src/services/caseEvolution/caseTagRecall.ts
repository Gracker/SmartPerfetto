// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {CURATED_CASE_STATUSES, caseStatusRank} from '../../types/caseKnowledge';
import type {CaseNode} from '../../types/sparkContracts';
import {caseAppliesToArchitecture} from '../caseArchitecture';
import type {CaseLibrary} from '../caseLibrary';
import type {KnowledgeScope} from '../scopedKnowledgeStore';

export interface CaseTagRecallQuery {
  tags?: readonly string[];
  appId?: string;
  deviceId?: string;
  cuj?: string;
  /** Also recall reviewed cases; published ones rank first on a tie. */
  includeReviewed?: boolean;
  topK?: number;
  /** The trace's detected rendering architecture; required so a caller says whether it knows it. */
  architectureType: string | undefined;
}

export type CaseTagRecallHit = Pick<CaseNode,
  'caseId' | 'title' | 'status' | 'tags' | 'findings' | 'traceArtifactId' | 'traceUnavailableReason'> & {
  score: number;
};

/**
 * `recall_similar_case` without evidence signatures, for both MCP servers:
 * admitted cases (`CaseLibrary.listAdmittedCases`) that apply to the trace's
 * architecture (`caseAppliesToArchitecture`), ranked by the share of the
 * requested tags they carry, optionally restricted to one App/Device/CUJ key.
 * Without tags, published cases rank above reviewed ones.
 */
export function recallCasesByTags(
  library: CaseLibrary,
  query: CaseTagRecallQuery,
  scope?: KnowledgeScope,
): CaseTagRecallHit[] {
  const wantedTags = query.tags ? new Set(query.tags) : null;
  const candidates: Array<{score: number; caseNode: CaseNode}> = [];
  for (const caseNode of library.listAdmittedCases(query.includeReviewed ? CURATED_CASE_STATUSES : ['published'], scope)) {
    if (query.appId && caseNode.key?.appId !== query.appId) continue;
    if (query.deviceId && caseNode.key?.deviceId !== query.deviceId) continue;
    if (query.cuj && caseNode.key?.cuj !== query.cuj) continue;
    if (!caseAppliesToArchitecture(caseNode, query.architectureType)) continue;
    let score: number;
    if (wantedTags) {
      const shared = caseNode.tags.filter(tag => wantedTags.has(tag)).length;
      if (shared === 0) continue;
      score = shared / wantedTags.size;
    } else {
      score = caseNode.status === 'published' ? 1 : 0.5;
    }
    candidates.push({score, caseNode});
  }
  candidates.sort((a, b) =>
    b.score - a.score || caseStatusRank(b.caseNode.status) - caseStatusRank(a.caseNode.status));
  return candidates.slice(0, query.topK ?? 5).map(({score, caseNode}) => ({
    caseId: caseNode.caseId,
    score,
    title: caseNode.title,
    status: caseNode.status,
    tags: caseNode.tags,
    findings: caseNode.findings,
    traceArtifactId: caseNode.traceArtifactId,
    traceUnavailableReason: caseNode.traceUnavailableReason,
  }));
}
