// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {decodeRuntimeToolResult, readRuntimeToolResultFacts, runtimeToolReceiptMetadata} from '../../agentRuntime/runtimeToolResult';
import {isSourceAccessRefusalAction} from '../codebase/sourceAccessRefusal';
import {isKnowledgeRefusalAction, KNOWLEDGE_TOOL_NAMES, knowledgeResultShape} from '../knowledge/knowledgeTools';

import type {RagSourceKind} from '../../types/sparkContracts';
import {sourceLookupOutcome, type CodeLookupOutcome} from '../codebase/codeLookupLedger';
import {ragChunkAudience} from './ragChunkAudience';
import type {SanitizedRagResult} from './lookupResponseFilter';

export interface ProjectedPayload {
  toolName: string;
  chunkRefs: Array<{
    chunkId: string;
    codebaseId?: string;
    knowledgeSourceId?: string;
    kind: RagSourceKind;
    title?: string;
    uri?: string;
    license?: string;
    attribution?: string;
    sourceStatus?: string;
    sourceConfidence?: string;
    lastVerifiedAgainst?: string;
    commitHash?: string;
    sourceDirty?: boolean;
    commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
    snippetHash?: string;
    snippetLength?: number;
    redactedCount?: number;
  }>;
  sourceRefs?: Array<{
    referenceId: string;
    codebaseId: string;
    lineRange?: {start: number; end: number};
    filePathHash?: string;
    symbolHash?: string;
    kindHash?: string;
    snippetHash?: string;
    snippetLength?: number;
    redactedCount?: number;
  }>;
  outcome: CodeLookupOutcome;
  legacyPath: boolean;
  /** A closed source-access refusal action; narration reads it to say "refused", not "failed". */
  action_required?: string;
  /** Present only as `false`: the search did not cover every admitted file. */
  coverageComplete?: false;
  /** Files a `find_codebase_files` call returned, by path hash only. */
  fileRefs?: Array<{filePathHash: string}>;
  /**
   * A document-collection tool's outcome without any document content: which
   * selected knowledge bases answered, how many references came back, and for
   * a read the part position. Titles, heading paths, relative paths and text
   * never cross this boundary.
   */
  knowledge?: {
    knowledgeBaseIds: string[];
    referenceCount: number;
    part?: number;
    partCount?: number;
    alreadyDelivered?: true;
    truncated?: true;
  };
}

const SENSITIVE_RAG_TOOL_NAMES = new Set([
  ...KNOWLEDGE_TOOL_NAMES,
  // Standalone public MCP server only (bin/smartperfetto-mcp.ts); its public
  // blog hits are projected below, anything else fails closed.
  'lookup_blog_knowledge',
  'lookup_app_source',
  'lookup_kernel_source',
  'lookup_aosp_source',
  'lookup_oem_sdk',
  'search_codebase',
  'locate_trace_anchor',
  'read_codebase_file',
  'find_codebase_files',
  'query_code_graph',
  'inspect_code_symbol',
]);

const ON_DEMAND_SOURCE_TOOL_NAMES = new Set([
  'search_codebase',
  'locate_trace_anchor',
  'read_codebase_file',
]);

const CODE_GRAPH_TOOL_NAMES = new Set([
  'query_code_graph',
  'inspect_code_symbol',
]);

export function isSensitiveRagToolName(toolName: string): boolean {
  return SENSITIVE_RAG_TOOL_NAMES.has(toolName.replace(/^mcp__smartperfetto__/, ''));
}

function rejectedProjection(toolName: string): ProjectedPayload {
  return {toolName, chunkRefs: [], outcome: 'rejected', legacyPath: false};
}

function hashSnippet(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex').slice(0, 12);
}

/** The facts every on-demand projection carries: outcome, refusal action and incomplete coverage. */
function onDemandEnvelope(candidate: Record<string, unknown>): Pick<ProjectedPayload,
'outcome' | 'action_required' | 'coverageComplete'> {
  return {
    outcome: sourceLookupOutcome(candidate),
    ...(candidate.success === false && isSourceAccessRefusalAction(candidate.action_required)
      ? {action_required: candidate.action_required}
      : {}),
    // Narration must not call an incomplete search "nothing found".
    ...(candidate.coverageComplete === false ? {coverageComplete: false as const} : {}),
  };
}

function onDemandCandidate(raw: unknown): Record<string, unknown> | undefined {
  const payload = unwrapMcpPayload(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return ((payload as {result?: unknown}).result ?? payload) as Record<string, unknown>;
}

/** A file find returns relative paths only; external surfaces get their hashes. */
function projectFileFindResult(toolName: string, raw: unknown): ProjectedPayload | undefined {
  if (toolName !== 'find_codebase_files') return undefined;
  const candidate = onDemandCandidate(raw);
  if (!candidate || !Array.isArray(candidate.files)) return undefined;
  const fileRefs = candidate.files.flatMap(file => {
    const filePath = file && typeof file === 'object' ? (file as {filePath?: unknown}).filePath : undefined;
    return typeof filePath === 'string' ? [{filePathHash: hashSnippet(filePath)}] : [];
  });
  return {toolName, chunkRefs: [], fileRefs, legacyPath: false, ...onDemandEnvelope(candidate)};
}

function projectOnDemandSourceResult(
  toolName: string,
  raw: unknown,
): ProjectedPayload | undefined {
  const isGraphTool = CODE_GRAPH_TOOL_NAMES.has(toolName);
  if (!ON_DEMAND_SOURCE_TOOL_NAMES.has(toolName) && !isGraphTool) return undefined;
  const candidate = onDemandCandidate(raw);
  if (!candidate) return undefined;
  const rawReferences = isGraphTool
    ? candidate.references
    : toolName === 'search_codebase' || toolName === 'locate_trace_anchor'
    ? candidate.matches
    : candidate.reference === undefined ? [] : [candidate.reference];
  if (!Array.isArray(rawReferences)) return undefined;
  const sourceRefs = rawReferences.flatMap(rawReference => {
    if (!rawReference || typeof rawReference !== 'object' || Array.isArray(rawReference)) return [];
    const reference = rawReference as Record<string, unknown>;
    // The model sees each item's issued `id`; older payloads carried `referenceId`.
    const referenceId = typeof reference.referenceId === 'string' ? reference.referenceId
      : typeof reference.id === 'string' ? reference.id : undefined;
    if (!referenceId || typeof reference.codebaseId !== 'string') return [];
    const lineRange = reference.lineRange && typeof reference.lineRange === 'object'
      ? reference.lineRange as Record<string, unknown>
      : undefined;
    const validLineRange = lineRange &&
      Number.isInteger(lineRange.start) &&
      Number.isInteger(lineRange.end) &&
      Number(lineRange.start) > 0 &&
      Number(lineRange.end) >= Number(lineRange.start)
      ? {start: Number(lineRange.start), end: Number(lineRange.end)}
      : undefined;
    // The model reads one numbered body; the raw text appears only when
    // numbering did not apply.
    const text = typeof reference.numberedText === 'string' ? reference.numberedText
      : typeof reference.text === 'string' ? reference.text : undefined;
    const filePath = typeof reference.filePath === 'string' ? reference.filePath : undefined;
    const symbol = typeof reference.symbol === 'string' ? reference.symbol : undefined;
    const kind = typeof reference.kind === 'string' ? reference.kind : undefined;
    return [{
      referenceId,
      codebaseId: reference.codebaseId,
      ...(validLineRange ? {lineRange: validLineRange} : {}),
      ...(filePath ? {filePathHash: hashSnippet(filePath)} : {}),
      ...(symbol ? {symbolHash: hashSnippet(symbol)} : {}),
      ...(kind ? {kindHash: hashSnippet(kind)} : {}),
      ...(text ? {snippetHash: hashSnippet(text), snippetLength: text.length} : {}),
      ...(Number.isInteger(reference.redactedCount)
        ? {redactedCount: Number(reference.redactedCount)}
        : {}),
    }];
  });
  return {toolName, chunkRefs: [], sourceRefs, legacyPath: false, ...onDemandEnvelope(candidate)};
}

/**
 * The content-free facts of a well-formed document-collection result, or
 * undefined for any other shape (`knowledgeResultShape`, shared with the
 * owner's narration, decides what is well formed).
 */
function knowledgeFacts(toolName: string, candidate: Record<string, unknown>): ProjectedPayload['knowledge'] | undefined {
  const shape = knowledgeResultShape(toolName, candidate);
  if (!shape) return undefined;
  const truncated = candidate.truncated === true ? {truncated: true as const} : {};
  if (shape.variant === 'search') {
    return {knowledgeBaseIds: shape.knowledgeBaseIds, referenceCount: (candidate.hits as unknown[]).length, ...truncated};
  }
  return {
    knowledgeBaseIds: [shape.knowledgeBaseId],
    referenceCount: 1,
    part: shape.part,
    partCount: shape.partCount,
    ...(shape.variant === 'already_delivered' ? {alreadyDelivered: true as const} : {}),
    ...truncated,
  };
}

/**
 * Document-collection results, failing closed: only counts, the server-minted
 * knowledge base ids, the part position and a closed refusal action survive.
 * A failure keeps its closed action; any shape this does not recognize is a
 * rejection, never a success and never read as the legacy RAG shape.
 */
function projectKnowledgeToolResult(toolName: string, raw: unknown): ProjectedPayload | undefined {
  if (!KNOWLEDGE_TOOL_NAMES.has(toolName)) return undefined;
  const candidate = onDemandCandidate(raw);
  if (candidate?.success === false) {
    return {
      ...rejectedProjection(toolName),
      ...(isKnowledgeRefusalAction(candidate.action_required) ? {action_required: candidate.action_required} : {}),
    };
  }
  // An error result or failed receipt is a failure whatever its body claims.
  const knowledge = candidate && readRuntimeToolResultFacts(raw).success !== false
    ? knowledgeFacts(toolName, candidate) : undefined;
  return knowledge
    ? {toolName, chunkRefs: [], legacyPath: false, outcome: 'success', knowledge}
    : rejectedProjection(toolName);
}

export function projectRagResultForSseAndLog(toolName: string, result: SanitizedRagResult): ProjectedPayload {
  let outcome: CodeLookupOutcome = 'success';
  const chunkRefs = result.hits.map(hit => {
    if (hit.unsupportedReason) outcome = hit.unsupportedReason === 'budget_exceeded'
      ? 'budget_exceeded'
      : 'rejected';
    const privateWiki = hit.metadata ? ragChunkAudience(hit.metadata) === 'retired_private' : false;
    return {
      chunkId: hit.chunkId,
      ...(hit.metadata?.codebaseId ? {codebaseId: hit.metadata.codebaseId} : {}),
      ...(hit.metadata?.knowledgeSourceId
        ? {knowledgeSourceId: hit.metadata.knowledgeSourceId}
        : {}),
      kind: hit.metadata?.kind ?? 'androidperformance.com',
      ...(!privateWiki && hit.metadata?.title ? {title: hit.metadata.title} : {}),
      ...(!privateWiki && hit.metadata?.uri ? {uri: hit.metadata.uri} : {}),
      ...(hit.metadata?.license ? {license: hit.metadata.license} : {}),
      ...(hit.metadata?.attribution ? {attribution: hit.metadata.attribution} : {}),
      ...(!privateWiki && hit.metadata?.sourceStatus ? {sourceStatus: hit.metadata.sourceStatus} : {}),
      ...(!privateWiki && hit.metadata?.sourceConfidence
        ? {sourceConfidence: hit.metadata.sourceConfidence}
        : {}),
      ...(!privateWiki && hit.metadata?.lastVerifiedAgainst
        ? {lastVerifiedAgainst: hit.metadata.lastVerifiedAgainst}
        : {}),
      ...(hit.metadata?.commitHash ? {commitHash: hit.metadata.commitHash} : {}),
      ...(hit.metadata?.sourceDirty !== undefined ? {sourceDirty: hit.metadata.sourceDirty} : {}),
      ...(hit.metadata?.commitProvenance ? {commitProvenance: hit.metadata.commitProvenance} : {}),
      ...(hit.snippet ? {snippetHash: hashSnippet(hit.snippet), snippetLength: hit.snippet.length} : {}),
      ...(hit.redactedCount !== undefined ? {redactedCount: hit.redactedCount} : {}),
    };
  });
  return {
    toolName,
    chunkRefs,
    outcome,
    legacyPath: result.legacyPath,
  };
}

function unwrapMcpPayload(raw: unknown): unknown {
  return decodeRuntimeToolResult(raw).body;
}

function projectRawRetrievalResult(toolName: string, candidate: Record<string, unknown>): ProjectedPayload | undefined {
  if (!Array.isArray(candidate.results)) return undefined;
  const hits = candidate.results.flatMap(rawHit => {
    if (!rawHit || typeof rawHit !== 'object') return [];
    const hit = rawHit as {chunk?: unknown; score?: unknown};
    if (!hit.chunk || typeof hit.chunk !== 'object') return [];
    const chunk = hit.chunk as Record<string, unknown>;
    if (typeof chunk.chunkId !== 'string' || typeof chunk.kind !== 'string') return [];
    return [{
      chunkId: chunk.chunkId,
      score: typeof hit.score === 'number' ? hit.score : 0,
      metadata: {
        kind: chunk.kind as RagSourceKind,
        ...(typeof chunk.codebaseId === 'string' ? {codebaseId: chunk.codebaseId} : {}),
        ...(typeof chunk.knowledgeSourceId === 'string' ? {knowledgeSourceId: chunk.knowledgeSourceId} : {}),
        ...(typeof chunk.title === 'string' ? {title: chunk.title} : {}),
        ...(typeof chunk.uri === 'string' ? {uri: chunk.uri} : {}),
        ...(typeof chunk.license === 'string' ? {license: chunk.license} : {}),
        ...(typeof chunk.attribution === 'string' ? {attribution: chunk.attribution} : {}),
        ...(typeof chunk.sourceStatus === 'string' ? {sourceStatus: chunk.sourceStatus} : {}),
        ...(typeof chunk.sourceConfidence === 'string' ? {sourceConfidence: chunk.sourceConfidence} : {}),
        ...(typeof chunk.lastVerifiedAgainst === 'string'
          ? {lastVerifiedAgainst: chunk.lastVerifiedAgainst}
          : {}),
        ...(typeof chunk.commitHash === 'string' ? {commitHash: chunk.commitHash} : {}),
        ...(typeof chunk.sourceDirty === 'boolean' ? {sourceDirty: chunk.sourceDirty} : {}),
        ...((chunk.commitProvenance === 'clean_git_revision' ||
          chunk.commitProvenance === 'dirty_git_worktree' ||
          chunk.commitProvenance === 'content_only')
          ? {commitProvenance: chunk.commitProvenance}
          : {}),
      } as SanitizedRagResult['hits'][number]['metadata'],
      ...(typeof chunk.snippet === 'string' ? {snippet: chunk.snippet} : {}),
    }];
  });
  const result: SanitizedRagResult = {
    query: typeof candidate.query === 'string' ? candidate.query : '',
    probed: Array.isArray(candidate.probed) ? candidate.probed as RagSourceKind[] : [],
    retrievedAt: typeof candidate.retrievedAt === 'number' ? candidate.retrievedAt : Date.now(),
    legacyPath: false,
    hits,
  };
  const projected = projectRagResultForSseAndLog(toolName, result);
  if (typeof candidate.unsupportedReason === 'string') projected.outcome = 'rejected';
  return projected;
}

/**
 * Extract a sanitized source-backed RAG result from provider-specific tool
 * output envelopes. Both user code and external private knowledge may contain
 * raw text that is valid model input but must never be copied into SSE, logs,
 * or replay artifacts.
 */
export function projectSensitiveRagToolResult(
  toolName: string,
  raw: unknown,
): ProjectedPayload | undefined {
  const payload = unwrapMcpPayload(raw);
  if (!payload || typeof payload !== 'object') return undefined;
  const candidate = (payload as {result?: unknown}).result ?? payload;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const result = candidate as SanitizedRagResult;
  if (!Array.isArray(result.hits)) return undefined;
  if (!result.hits.some(hit => hit.metadata ? ragChunkAudience(hit.metadata) !== 'public' : false)) {
    return undefined;
  }
  return projectRagResultForSseAndLog(toolName, result);
}

/** Fail closed for sensitive tool results copied to logs, SSE, or replay. */
export function projectToolResultForExternalSurface(toolName: string, raw: unknown): unknown {
  toolName = toolName.replace(/^mcp__smartperfetto__/, '');
  // Projection describes disclosure, not tool execution. Carry only the
  // producer's whitelisted facts, including an authoritative unknown receipt.
  const publish = (payload: ProjectedPayload) => ({
    ...payload, _meta: runtimeToolReceiptMetadata(readRuntimeToolResultFacts(raw)),
  });
  const onDemandProjection = projectOnDemandSourceResult(toolName, raw) ?? projectFileFindResult(toolName, raw) ??
    projectKnowledgeToolResult(toolName, raw);
  if (onDemandProjection) return publish(onDemandProjection);
  const projected = projectSensitiveRagToolResult(toolName, raw);
  if (projected) return publish(projected);
  const payload = unwrapMcpPayload(raw);
  const candidate = payload && typeof payload === 'object'
    ? ((payload as {result?: unknown}).result ?? payload)
    : undefined;
  if (toolName === 'lookup_blog_knowledge' && candidate && typeof candidate === 'object') {
    const publicProjection = projectRawRetrievalResult(toolName, candidate as Record<string, unknown>);
    if (publicProjection) return publish(publicProjection);
  }
  if (!isSensitiveRagToolName(toolName)) return raw;
  // A refused lookup keeps its closed source-access action, so narration can
  // say why nothing was read instead of calling it a failure.
  const refusal = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  return publish({
    ...rejectedProjection(toolName),
    ...(refusal.success === false && isSourceAccessRefusalAction(refusal.action_required)
      ? {action_required: refusal.action_required} : {}),
  });
}

/** @deprecated Use projectSensitiveRagToolResult. */
export const projectPrivateKnowledgeToolResult = projectSensitiveRagToolResult;
