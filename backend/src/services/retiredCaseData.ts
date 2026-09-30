// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Learned cases are retired. The pipeline that derived cases from runs could
 * not prove those runs public, and never worked with production ids; what it
 * left in a store (case nodes, their RAG chunks and graph edges, including
 * copies that went through a Markdown export and re-import) is never read,
 * exported or written again. Every store applies these checks on read and
 * write, so data an older process writes stays invisible to upgraded ones.
 */

import type {ConclusionContract} from '../agent/core/conclusionContract';

const RETIRED_CASE_SOURCE = 'runtime_analysis_candidate';
const RETIRED_CASE_ID_PREFIX = 'learned:';
const RETIRED_CHUNK_ID_PREFIX = 'case:learned:';
const RETIRED_CASE_URI_PREFIXES = ['case://learned/', 'case://learned:'] as const;
const RETIRED_EDGE_ID_PREFIX = 'case-learned-edge:';
const CASE_LIBRARY_RAG_KIND = 'case_library';

function startsWith(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix);
}

export function isRetiredCaseId(caseId: unknown): boolean {
  return startsWith(caseId, RETIRED_CASE_ID_PREFIX);
}

export function isRetiredCaseNode(node: {caseId?: unknown; source?: unknown}): boolean {
  return node.source === RETIRED_CASE_SOURCE || isRetiredCaseId(node.caseId);
}

export function isRetiredRagChunk(chunk: {kind?: unknown; chunkId?: unknown; uri?: unknown}): boolean {
  return chunk.kind === CASE_LIBRARY_RAG_KIND && (
    startsWith(chunk.chunkId, RETIRED_CHUNK_ID_PREFIX) ||
    RETIRED_CASE_URI_PREFIXES.some(prefix => startsWith(chunk.uri, prefix))
  );
}

/**
 * An edge is retired when its own id says so or either end is a retired case:
 * by id, or by the node facts of the same scope and store (`retiredCaseIds`),
 * since a retired node may carry an ordinary id.
 */
export function isRetiredCaseEdge(
  edge: {edgeId?: unknown; fromCaseId?: unknown; toCaseId?: unknown},
  retiredCaseIds: ReadonlySet<string>,
): boolean {
  return startsWith(edge.edgeId, RETIRED_EDGE_ID_PREFIX) ||
    [edge.fromCaseId, edge.toCaseId].some(id =>
      isRetiredCaseId(id) || (typeof id === 'string' && retiredCaseIds.has(id)));
}

/**
 * The SQL twin of isRetiredRagChunk over `memory_entries`, whose RAG rows keep
 * the chunk as the envelope's record in `content_json` and its kind in `scope`
 * (`rag:<kind>`). Prefix tests use `substr` (case-sensitive, like startsWith)
 * and COALESCE, so a missing field never turns the predicate NULL.
 */
function sqlStartsWith(field: string, prefix: string): string {
  return `COALESCE(substr(json_extract(memory_entries.content_json, '$.record.${field}'), 1, ${prefix.length}), '') = '${prefix}'`;
}

export const RETIRED_RAG_CHUNK_SQL = `(
  memory_entries.scope = 'rag:${CASE_LIBRARY_RAG_KIND}' AND (
    ${[
      sqlStartsWith('chunkId', RETIRED_CHUNK_ID_PREFIX),
      ...RETIRED_CASE_URI_PREFIXES.map(prefix => sqlStartsWith('uri', prefix)),
    ].join('\n    OR ')}
  )
)`;

/**
 * A new result's contract without retired learned data: no learned
 * provenance and no recommendation of a retired case. Returns the contract
 * itself when there is nothing to drop. Only accepting a new result applies
 * it; a restored result keeps what its report showed.
 */
export function withoutRetiredCaseLearning(contract: ConclusionContract | undefined): ConclusionContract | undefined {
  const recommendations = contract?.caseRecommendations;
  if (!contract || !recommendations?.some(item => isRetiredCaseId(item.caseId) || 'learnedProvenance' in item)) {
    return contract;
  }
  return {...contract, caseRecommendations: recommendations
    .filter(item => !isRetiredCaseId(item.caseId))
    .map(({learnedProvenance: _learnedProvenance, ...item}) => item)};
}

/** Refuse to write retired case data through any store's shared entry. */
export function assertNotRetiredCaseWrite(kind: 'case' | 'chunk' | 'edge', retired: boolean, id: unknown): void {
  if (retired) throw new Error(`retired_case_data_write_refused: ${kind} '${String(id)}' belongs to the retired learned cases`);
}
