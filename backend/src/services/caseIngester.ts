// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import {backendLogPath} from '../runtimePaths';
import type {
  CaseKnowledgeFrontmatter,
  ValidatedCaseKnowledgeFile,
} from '../types/caseKnowledge';
import {
  type CaseEdge,
  type CaseFindingSeverity,
  type CaseNode,
  type CurationStatus,
  type RagChunk,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {CaseGraph} from './caseGraph';
import {CaseLibrary, type CuratedCaseView} from './caseLibrary';
import {RagStore, getDefaultRagStore} from './ragStore';
import type {KnowledgeScope} from './scopedKnowledgeStore';
import {validateCaseKnowledgeFiles} from './caseSchemaValidator';
import type {CaseCurationGrant} from './security/caseCuration';
import {storedJsonContentHash} from './selfEvolution/canonicalJson';

export const GENERATED_CASE_SOURCE = 'curated_markdown_case';
const GENERATED_EDGE_PREFIX = 'case-edge:';
const GENERATED_RAG_URI_PREFIX = 'case://';

export interface CaseKnowledgeIngestOptions {
  casesDir: string;
  /** The operator's authority, which attests every case written (`caseCurationGrantForMarkdownIngest`). */
  grant: CaseCurationGrant;
  caseLibraryPath?: string;
  caseGraphPath?: string;
  ragStorePath?: string;
  caseLibrary?: CaseLibrary;
  caseGraph?: CaseGraph;
  ragStore?: RagStore;
  knowledgeScope?: KnowledgeScope;
  failAfterStore?: 'caseLibrary' | 'caseGraph' | 'ragStore';
}

export interface CaseKnowledgeIngestResult {
  caseCount: number;
  writtenCaseCount: number;
  edgeCount: number;
  chunkCount: number;
  warnings: string[];
  caseLibraryPath: string;
  caseGraphPath: string;
  ragStorePath: string;
}

export function ingestCaseKnowledge(
  options: CaseKnowledgeIngestOptions,
): CaseKnowledgeIngestResult {
  const validation = validateCaseKnowledgeFiles(options.casesDir);
  if (!validation.ok) {
    throw new Error(
      validation.issues
        .map(issue => `${issue.filePath}: ${issue.message}`)
        .join('\n'),
    );
  }

  const caseLibraryPath =
    options.caseLibraryPath ?? backendLogPath('case_library.json');
  const caseGraphPath = options.caseGraphPath ?? backendLogPath('case_graph.json');
  const ragStorePath = options.ragStorePath ?? backendLogPath('rag_store.json');
  const library = options.caseLibrary ?? new CaseLibrary(caseLibraryPath);
  // Every case is written before the first edge and no retired case can be
  // written, so one read of the retired ids serves the whole edge pass.
  let retiredCaseIds: ReadonlySet<string> | undefined;
  const graph = options.caseGraph ?? new CaseGraph(caseGraphPath, {
    retiredCaseIds: scope => (retiredCaseIds ??= library.retiredCaseIds(scope)),
  });
  const ragStore = options.ragStore ?? (
    options.ragStorePath ? new RagStore(ragStorePath) : getDefaultRagStore()
  );
  const warnings: string[] = [];

  const cases = [...validation.cases].sort((a, b) =>
    a.frontmatter.case_id.localeCompare(b.frontmatter.case_id),
  );
  const targetCaseIds = new Set(cases.map(entry => entry.frontmatter.case_id));

  removeStaleGeneratedCases(library, targetCaseIds, options.knowledgeScope);
  let writtenCaseCount = 0;
  for (const entry of cases) {
    writeCaseNode(library, entry, options.grant, warnings, options.knowledgeScope);
    writtenCaseCount++;
  }
  if (options.failAfterStore === 'caseLibrary') {
    throw new Error('simulated ingest crash after CaseLibrary write');
  }

  const edges = buildEdges(cases);
  replaceGeneratedEdges(graph, edges, options.knowledgeScope);
  if (options.failAfterStore === 'caseGraph') {
    throw new Error('simulated ingest crash after CaseGraph write');
  }

  const chunks = cases.map(buildRagChunk);
  replaceGeneratedChunks(ragStore, chunks, options.knowledgeScope);
  if (options.failAfterStore === 'ragStore') {
    throw new Error('simulated ingest crash after RagStore write');
  }

  return {
    caseCount: cases.length,
    writtenCaseCount,
    edgeCount: edges.length,
    chunkCount: chunks.length,
    warnings,
    caseLibraryPath,
    caseGraphPath,
    ragStorePath,
  };
}

function removeStaleGeneratedCases(
  library: CaseLibrary,
  targetCaseIds: Set<string>,
  scope?: KnowledgeScope,
): void {
  for (const existing of library.listCases({}, scope)) {
    if (
      existing.source === GENERATED_CASE_SOURCE &&
      !targetCaseIds.has(existing.caseId)
    ) {
      library.removeCase(existing.caseId, scope);
    }
  }
}

/**
 * The import attests every case it writes under the operator's grant; the
 * reviewer of a published case is the one the case names, or the curator who
 * published this same content earlier.
 */
function writeCaseNode(
  library: CaseLibrary,
  entry: ValidatedCaseKnowledgeFile,
  grant: CaseCurationGrant,
  warnings: string[],
  scope?: KnowledgeScope,
): void {
  const existing = library.getCaseForCuration(entry.frontmatter.case_id, scope);
  const target = buildCaseNode(entry, existing?.createdAt);
  const unchanged = !!existing && markdownContentHash(existing) === markdownContentHash(target);
  // A re-import of unchanged content by the same curator keeps that curator's curation time.
  if (unchanged && target.curatedBy && existing.curatedBy === target.curatedBy && existing.curatedAt !== undefined) {
    target.curatedAt = existing.curatedAt;
  }
  const preserved = mergeRuntimeCuration(existing, target, unchanged, warnings);
  if (preserved.status === 'published') {
    if (!preserved.curatedBy) {
      throw new Error(
        `Cannot publish case '${preserved.caseId}' without curator provenance`,
      );
    }
    library.saveCase({...preserved, status: 'reviewed'}, grant, scope);
    library.publishCase(preserved.caseId, {reviewer: preserved.curatedBy, curatedAt: preserved.curatedAt}, grant, scope);
    return;
  }
  library.saveCase(preserved, grant, scope);
}

/**
 * A curator who raised a Markdown case's status through the API attested the
 * content it had then; a re-import keeps that curation only while the stored
 * copy is still attested and the content unchanged. A raised status nobody
 * attested, such as one written before attestations, is not kept.
 */
function mergeRuntimeCuration(
  existing: CuratedCaseView | undefined,
  target: CaseNode,
  unchanged: boolean,
  warnings: string[],
): CaseNode {
  if (
    !existing ||
    existing.source !== GENERATED_CASE_SOURCE ||
    statusRank(existing.status) <= statusRank(target.status)
  ) {
    return target;
  }
  if (!existing.curation || !unchanged) {
    warnings.push(
      `did not keep the ${existing.status} status of case '${target.caseId}': ${existing.curation ? 'its Markdown content changed since' : 'no curator attested it'}; review and publish it again`,
    );
    return target;
  }
  warnings.push(
    `preserved ${existing.status} runtime curation for case '${target.caseId}' over Markdown status '${target.status}'`,
  );
  return {
    ...target,
    status: existing.status,
    curatedBy: existing.curatedBy,
    curatedAt: existing.curatedAt,
    redactionState:
      existing.redactionState === 'redacted' ? 'redacted' : target.redactionState,
  };
}

function statusRank(status: CurationStatus): number {
  switch (status) {
    case 'draft':
      return 0;
    case 'reviewed':
    case 'private':
      return 1;
    case 'published':
      return 2;
  }
}

/** What Markdown defines of a case, apart from the file it was read from. */
function markdownContentHash(node: CaseNode): string {
  const knowledge = node.knowledge && {...node.knowledge, sourceFile: undefined};
  return storedJsonContentHash({title: node.title, tags: node.tags, findings: node.findings, knowledge});
}

function buildCaseNode(
  entry: ValidatedCaseKnowledgeFile,
  createdAt = Date.now(),
): CaseNode {
  const frontmatter = entry.frontmatter;
  const curator = frontmatter.curator?.trim();
  const status = frontmatter.status as CurationStatus;
  return {
    ...makeSparkProvenance({source: GENERATED_CASE_SOURCE}),
    createdAt,
    caseId: frontmatter.case_id,
    title: frontmatter.title,
    status,
    redactionState: curator ? 'redacted' : 'raw',
    tags: frontmatter.tags ?? [frontmatter.scene, frontmatter.taxonomy.primary_root_cause],
    findings: frontmatter.findings.map(finding => ({
      id: finding.id,
      severity: frontmatter.taxonomy.severity as CaseFindingSeverity,
      title: finding.title,
    })),
    ...(curator ? {curatedBy: curator, curatedAt: Date.now()} : {}),
    knowledge: {
      sourceFile: path.normalize(entry.filePath),
      body: entry.body,
      quality: frontmatter.quality,
      scene: frontmatter.scene,
      domainPack: frontmatter.domain_pack,
      taxonomy: frontmatter.taxonomy,
      context: frontmatter.context,
      evidenceSignatures: frontmatter.evidence_signatures,
      recommendations: frontmatter.recommendations,
    },
  };
}

function buildEdges(cases: ValidatedCaseKnowledgeFile[]): CaseEdge[] {
  const edges: CaseEdge[] = [];
  for (const entry of cases) {
    const fromCaseId = entry.frontmatter.case_id;
    for (const [relation, targets] of Object.entries(entry.frontmatter.relations)) {
      for (const toCaseId of targets) {
        edges.push({
          edgeId: `${GENERATED_EDGE_PREFIX}${fromCaseId}:${relation}:${toCaseId}`,
          fromCaseId,
          toCaseId,
          relation,
        });
      }
    }
  }
  edges.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return edges;
}

function replaceGeneratedEdges(
  graph: CaseGraph,
  edges: CaseEdge[],
  scope?: KnowledgeScope,
): void {
  for (const edge of graph.listEdges(scope)) {
    if (edge.edgeId.startsWith(GENERATED_EDGE_PREFIX)) {
      graph.removeEdge(edge.edgeId, scope);
    }
  }
  for (const edge of edges) {
    graph.addEdge(edge, scope);
  }
}

function buildRagChunk(entry: ValidatedCaseKnowledgeFile): RagChunk {
  const frontmatter = entry.frontmatter;
  const snippet = buildRagSnippet(frontmatter, entry.body);
  return {
    chunkId: `case:${frontmatter.case_id}:summary`,
    kind: 'case_library',
    uri: `${GENERATED_RAG_URI_PREFIX}${frontmatter.case_id}`,
    title: frontmatter.title,
    snippet,
    tokenCount: snippet.split(/\s+/).filter(Boolean).length,
    indexedAt: Date.now(),
    author: frontmatter.curator,
    registryOrigin: 'plan54_cases',
  };
}

function buildRagSnippet(
  frontmatter: CaseKnowledgeFrontmatter,
  body: string,
): string {
  const findingText = frontmatter.findings
    .map(finding => `${finding.id}: ${finding.title}`)
    .join('\n');
  const appRecommendations = frontmatter.recommendations.app
    .map(rec => `${rec.id}: ${rec.action}`)
    .join('\n');
  const oemRecommendations = frontmatter.recommendations.oem
    .map(rec => `${rec.id}: ${rec.action}`)
    .join('\n');
  return [
    frontmatter.title,
    `scene: ${frontmatter.scene}`,
    `root_cause: ${frontmatter.taxonomy.primary_root_cause}`,
    `responsibility: ${frontmatter.taxonomy.responsibility}`,
    findingText,
    appRecommendations,
    oemRecommendations,
    body.trim(),
  ]
    .filter(part => part.length > 0)
    .join('\n\n');
}

function replaceGeneratedChunks(
  ragStore: RagStore,
  chunks: RagChunk[],
  scope?: KnowledgeScope,
): void {
  for (const chunk of ragStore.listChunks({
    kind: 'case_library',
    registryOrigin: 'plan54_cases',
    uriPrefix: GENERATED_RAG_URI_PREFIX,
    scope,
  })) {
    ragStore.removeChunk(chunk.chunkId, scope);
  }
  for (const chunk of chunks) {
    ragStore.addChunk(chunk, scope);
  }
  ragStore.flush();
}
