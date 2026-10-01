// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';

import type { CaseCandidate, CaseCandidateReview } from '../../types/caseEvolution';
import type {
  CaseKnowledgeExtension,
  CaseKnowledgeFinding,
  CaseKnowledgeQuality,
} from '../../types/caseKnowledge';
import type { CaseEdge, CaseFindingLink, CaseNode, RagChunk, SparkEvidenceRef } from '../../types/sparkContracts';
import { makeSparkProvenance } from '../../types/sparkContracts';
import { detectedCaseArchitecture } from '../caseArchitecture';
import { CaseGraph } from '../caseGraph';
import { CaseLibrary } from '../caseLibrary';
import { RagStore } from '../ragStore';
import {resolveKnowledgeScope, type KnowledgeScope} from '../scopedKnowledgeStore';
import { anonymizeCaseEvolutionInput } from './caseAnonymizer';
import type { CaseCandidateOutboxHandle } from './caseCandidateOutbox';
import {caseCandidateKnowledgeScope} from './caseCandidateBuilder';

export const LEARNED_CASE_SOURCE = 'runtime_analysis_candidate';
export const LEARNED_CASE_EDGE_PREFIX = 'case-learned-edge:';
export const LEARNED_CASE_RAG_URI_PREFIX = 'case://learned/';

export interface IngestReviewedCaseCandidateOptions {
  candidate: CaseCandidate;
  review: CaseCandidateReview;
  library: CaseLibrary;
  graph: CaseGraph;
  ragStore: RagStore;
  sidecarRelativePath?: string;
  knowledgeScope?: KnowledgeScope;
}

export interface IngestReviewedCaseCandidateResult {
  learnedCaseId: string;
  warnings: string[];
}

export interface RehydrateLearnedCandidatesOptions {
  outbox: Pick<CaseCandidateOutboxHandle, 'listCandidates' | 'setLearnedCaseId'>;
  library: CaseLibrary;
  graph: CaseGraph;
  ragStore: RagStore;
  knowledgeScope?: KnowledgeScope;
}

interface BuiltCandidateArtifacts {
  caseNode: CaseNode;
  edges: CaseEdge[];
  chunk: RagChunk;
  warnings: string[];
}

/**
 * Derive a stable, collision-safe learned-case id from a full candidate id.
 *
 * Candidate ids have the shape `casecand-${runId}-${16-char digest}`. Naively
 * slicing the candidate id (`slice(0, 16)`) collapses many distinct candidate
 * ids onto the same prefix once `runId` is long (the `casecand-` prefix plus a
 * long runId can consume all 16 chars, dropping the disambiguating digest
 * entirely). That lets two distinct reviewed candidates overwrite the same
 * CaseNode / RAG chunk / edge and silently breaks the rederive convergence
 * invariant (§3.5.1).
 *
 * Instead we hash the FULL candidate id with sha256 and take a wide slice (32
 * hex chars = 128 bits). Distinct candidate ids map to distinct learned ids
 * with negligible collision probability, and the id length stays bounded and
 * filesystem-safe.
 */
export function learnedCaseIdForCandidate(candidateId: string): string {
  const digest = crypto.createHash('sha256').update(candidateId).digest('hex').slice(0, 32);
  return `learned:${digest}`;
}

export function ingestReviewedCaseCandidate(
  opts: IngestReviewedCaseCandidateOptions,
): IngestReviewedCaseCandidateResult {
  const artifacts = buildArtifacts(opts.candidate, opts.review, opts.sidecarRelativePath);
  opts.library.saveCase(artifacts.caseNode, opts.knowledgeScope);
  for (const edge of artifacts.edges) opts.graph.addEdge(edge, opts.knowledgeScope);
  opts.ragStore.addChunk(artifacts.chunk, opts.knowledgeScope);
  opts.ragStore.flush();
  return { learnedCaseId: artifacts.caseNode.caseId, warnings: artifacts.warnings };
}

export function rederiveLearnedCandidates(
  opts: RehydrateLearnedCandidatesOptions,
): { reviewed: number; demotedPrivate: number; warnings: string[] } {
  const warnings: string[] = [];
  const reviewedRows = opts.outbox.listCandidates({ states: ['reviewed'] });
  const rejectedRows = opts.outbox.listCandidates({ states: ['rejected'] });
  const requestedScope = opts.knowledgeScope
    ? resolveKnowledgeScope(opts.knowledgeScope)
    : null;
  const scopes = new Map<string, KnowledgeScope>();
  if (requestedScope) {
    scopes.set(`${requestedScope.tenantId}\0${requestedScope.workspaceId}`, {
      tenantId: requestedScope.tenantId,
      workspaceId: requestedScope.workspaceId,
    });
  }
  for (const row of [...reviewedRows, ...rejectedRows]) {
    const scope = caseCandidateKnowledgeScope(row.candidate);
    if (!scope) {
      warnings.push(`skipped legacy unscoped candidate ${row.candidateId}`);
      continue;
    }
    const resolved = resolveKnowledgeScope(scope);
    if (requestedScope && (
      requestedScope.tenantId !== resolved.tenantId ||
      requestedScope.workspaceId !== resolved.workspaceId
    )) continue;
    scopes.set(`${resolved.tenantId}\0${resolved.workspaceId}`, scope);
  }

  let reviewed = 0;
  let demotedPrivate = 0;
  for (const scope of scopes.values()) {
    const rowsForScope = reviewedRows.filter(row => {
      const rowScope = caseCandidateKnowledgeScope(row.candidate);
      return rowScope && sameKnowledgePartition(rowScope, scope) &&
        row.review?.decision === 'promote';
    });
    const artifacts = rowsForScope.map(row => {
      const built = buildArtifacts(
        row.candidate,
        row.review!,
        row.notePath ?? `logs/case_candidates/${row.candidateId}.json`,
      );
      if (row.learnedCaseId !== built.caseNode.caseId) {
        opts.outbox.setLearnedCaseId(row.candidateId, built.caseNode.caseId);
      }
      warnings.push(...built.warnings);
      return built;
    });
    reviewed += artifacts.length;

    for (const edge of opts.graph.listEdges(scope)) {
      if (edge.edgeId.startsWith(LEARNED_CASE_EDGE_PREFIX)) {
        opts.graph.removeEdge(edge.edgeId, scope);
      }
    }
    for (const chunk of opts.ragStore.listChunks({
      kind: 'case_library',
      registryOrigin: 'plan54_cases',
      uriPrefix: LEARNED_CASE_RAG_URI_PREFIX,
      scope,
    })) {
      opts.ragStore.removeChunk(chunk.chunkId, scope);
    }
    for (const built of artifacts) {
      for (const edge of built.edges) opts.graph.addEdge(edge, scope);
      opts.ragStore.addChunk(built.chunk, scope);
      opts.library.saveCase(built.caseNode, scope);
    }

    const reviewedCaseIds = new Set(artifacts.map(built => built.caseNode.caseId));
    for (const existing of opts.library.listCases({}, scope)) {
      if (existing.source !== LEARNED_CASE_SOURCE) continue;
      if (reviewedCaseIds.has(existing.caseId) || existing.status === 'private') continue;
      opts.library.saveCase({ ...existing, status: 'private' }, scope);
      demotedPrivate++;
    }

    for (const row of rejectedRows) {
      const rowScope = caseCandidateKnowledgeScope(row.candidate);
      if (!rowScope || !sameKnowledgePartition(rowScope, scope)) continue;
      const learnedCaseId = row.learnedCaseId ?? learnedCaseIdForCandidate(row.candidateId);
      const existing = opts.library.getCase(learnedCaseId, scope);
      if (existing && existing.status !== 'private') {
        opts.library.saveCase({ ...existing, status: 'private' }, scope);
        demotedPrivate++;
      }
    }
  }
  opts.ragStore.flush();

  return { reviewed, demotedPrivate, warnings };
}

function sameKnowledgePartition(a: KnowledgeScope, b: KnowledgeScope): boolean {
  const left = resolveKnowledgeScope(a);
  const right = resolveKnowledgeScope(b);
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId;
}

function buildArtifacts(
  candidate: CaseCandidate,
  review: CaseCandidateReview,
  sidecarRelativePath?: string,
): BuiltCandidateArtifacts {
  const anonymized = anonymizeCaseEvolutionInput(candidate, review);
  if (!anonymized.ok) {
    throw new Error(`case anonymizer rejected candidate: ${anonymized.errors.join('; ')}`);
  }
  const cleanCandidate = anonymized.candidate;
  const cleanReview = anonymized.review;
  const caseId = learnedCaseIdForCandidate(cleanCandidate.candidateId);
  const extension = buildKnowledgeExtension(
    cleanCandidate,
    cleanReview,
    sidecarRelativePath ?? `logs/case_candidates/${cleanCandidate.candidateId}.json`,
  );
  const caseNode: CaseNode = {
    ...makeSparkProvenance({
      source: LEARNED_CASE_SOURCE,
      notes: `learned from run ${cleanCandidate.provenance.sourceAnalysisRunId}; candidate=${cleanCandidate.candidateId}`,
    }),
    caseId,
    title: cleanReview.proposed.title,
    status: 'draft',
    redactionState: 'redacted',
    tags: [
      cleanCandidate.cluster.scene,
      cleanReview.proposed.primaryRootCause,
      cleanReview.proposed.responsibility,
      'learned',
    ],
    findings: cleanReview.proposed.findings.map(findingToLink),
    knowledge: extension,
  };

  return {
    caseNode,
    edges: buildEdges(caseId, cleanReview),
    chunk: buildRagChunk(caseNode),
    warnings: anonymized.warnings,
  };
}

function buildKnowledgeExtension(
  candidate: CaseCandidate,
  review: CaseCandidateReview,
  sourceFile: string,
): CaseKnowledgeExtension {
  return {
    sourceFile,
    body: review.evidenceSummary,
    quality: 'imported',
    scene: candidate.cluster.scene,
    domainPack: candidate.cluster.domainPack,
    taxonomy: {
      primary_root_cause: review.proposed.primaryRootCause,
      secondary_root_causes: review.proposed.secondaryRootCauses,
      responsibility: review.proposed.responsibility,
      severity: review.proposed.severity,
    },
    context: {
      ...detectedCaseArchitecture(candidate.provenance.architectureType),
      frameCount: candidate.cluster.frameCount,
      percentage: candidate.cluster.percentage,
      representativeFrame: candidate.cluster.representativeFrame,
      'caseEvolution.v1': {
        candidateId: candidate.candidateId,
        supportingEvidence: 0,
        contradictingEvidence: 0,
        maintainerPromoted: false,
        supported: false,
      },
    },
    evidenceSignatures: review.proposed.evidenceSignatures,
    recommendations: review.proposed.recommendations,
  };
}

function findingToLink(finding: CaseKnowledgeFinding): CaseFindingLink {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.confidence === 'high' ? 'critical' : finding.confidence === 'medium' ? 'warning' : 'info',
    ...(finding.evidence_refs.length > 0 ? { evidence: evidenceRef(finding.evidence_refs) } : {}),
  };
}

function evidenceRef(refIds: string[]): SparkEvidenceRef {
  return {
    externalRef: `data-envelope:${refIds.join(',')}`,
    description: `DataEnvelope refs: ${refIds.join(', ')}`,
  };
}

function buildEdges(caseId: string, review: CaseCandidateReview): CaseEdge[] {
  const edges: CaseEdge[] = [];
  for (const [relation, targets] of Object.entries(review.proposed.relations)) {
    for (const target of targets) {
      edges.push({
        edgeId: `${LEARNED_CASE_EDGE_PREFIX}${caseId}:${relation}:${target}`,
        fromCaseId: caseId,
        toCaseId: target,
        relation,
      });
    }
  }
  edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return edges;
}

function buildRagChunk(caseNode: CaseNode): RagChunk {
  const knowledge = caseNode.knowledge!;
  const snippet = [
    caseNode.title,
    `scene: ${knowledge.scene}`,
    `root_cause: ${knowledge.taxonomy.primary_root_cause}`,
    `responsibility: ${knowledge.taxonomy.responsibility}`,
    caseNode.findings.map(finding => `${finding.id}: ${finding.title}`).join('\n'),
    knowledge.recommendations.app.map(rec => `${rec.id}: ${rec.action}`).join('\n'),
    knowledge.recommendations.oem.map(rec => `${rec.id}: ${rec.action}`).join('\n'),
    knowledge.body.trim(),
  ].filter(Boolean).join('\n\n');
  return {
    chunkId: `case:${caseNode.caseId}:summary`,
    kind: 'case_library',
    uri: `${LEARNED_CASE_RAG_URI_PREFIX}${caseNode.caseId}`,
    title: caseNode.title,
    snippet,
    tokenCount: snippet.split(/\s+/).filter(Boolean).length,
    indexedAt: Date.now(),
    registryOrigin: 'plan54_cases',
    author: 'case-evolution',
  };
}

export function caseKnowledgeQualityRank(quality: CaseKnowledgeQuality | undefined): number {
  switch (quality) {
    case 'curated':
      return 3;
    case 'imported':
      return 2;
    case 'weak':
      return 1;
    default:
      return 0;
  }
}
