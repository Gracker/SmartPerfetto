// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  RagChunk,
  RagRetrievalResult,
  RagSourceKind,
} from '../../types/sparkContracts';
import {activeCodebaseGeneration, type CodebaseRegistry} from '../codebase/codebaseRegistry';
import {sourcePathAllowedForProvider} from '../codebase/sourceDisclosure';
import {sourceSelectionAdmits, sourceSelectionForRef} from '../codebase/sourceSelectionPolicy';
import {estimateTextTokens, type SourceBudget} from '../codebase/sourceBudget';
import type {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {credentialContextForPath, redactSecrets} from '../security/secretPatterns';
import {registerCodeAwareLookupForEcho} from '../security/codeAwareOutputRegistry';
import type {ExternalKnowledgeScope} from '../externalKnowledgeSourceRegistry';

export interface SanitizedRagHit {
  chunkId: string;
  score: number;
  metadata?: {
    codebaseId?: string;
    kind: RagSourceKind;
    filePath?: string;
    lineRange?: {start: number; end: number};
    symbol?: string;
    language?: string;
    commitHash?: string;
    vendor?: string;
    buildId?: string;
    knowledgeSourceId?: string;
    sourceGeneration?: string;
    title?: string;
    uri?: string;
    license?: string;
    attribution?: string;
    sourceStatus?: string;
    sourceConfidence?: string;
    verifiedAt?: number;
    lastVerifiedAgainst?: string;
    contentFingerprint?: string;
    articleId?: string;
    sectionId?: string;
    sectionHeading?: string;
    chunkHash?: string;
    knowledgePackVersion?: string;
    knowledgePackFingerprint?: string;
    sourceDirty?: boolean;
    commitProvenance?: RagChunk['commitProvenance'];
  };
  snippet?: string;
  unsupportedReason?: string;
  redactedCount?: number;
}

export interface SanitizedRagResult {
  query: string;
  hits: SanitizedRagHit[];
  probed: RagSourceKind[];
  retrievedAt: number;
  unsupportedReason?: string;
  legacyPath: boolean;
}

export interface FilterContext {
  toolName: 'lookup_app_source' | 'lookup_kernel_source' | 'lookup_aosp_source' | 'lookup_oem_sdk';
  turn: number;
  codebaseRegistry?: CodebaseRegistry;
  /** Audit trail and patch authority; records every delivery and refusal. */
  ledger?: CodeLookupLedger;
  /**
   * The run's delivered-token pools: knowledge text and user codebase source
   * are budgeted apart.
   */
  budget?: Pick<SourceBudget, 'sourceTokens' | 'knowledgeTokens'>;
  allowProviderSend?: boolean;
  sessionId?: string;
  knowledgeScope?: ExternalKnowledgeScope;
  /** Runs after source authorization/redaction, before body delivery or patch-ledger grants. */
  admitSourceHit?: (hit: SanitizedRagHit) => boolean;
}

function isUserCodebaseChunk(chunk: RagChunk): boolean {
  if (chunk.kind === 'app_source' || chunk.kind === 'kernel_source') return true;
  return (chunk.kind === 'aosp' || chunk.kind === 'oem_sdk') &&
    chunk.registryOrigin === 'codebase_registry';
}

function isLegacyChunk(chunk: RagChunk): boolean {
  if (
    chunk.kind === 'androidperformance.com' ||
    chunk.kind === 'project_memory' ||
    chunk.kind === 'world_memory' ||
    chunk.kind === 'case_library'
  ) return true;
  if (chunk.kind === 'aosp' || chunk.kind === 'oem_sdk') {
    return chunk.registryOrigin === undefined || chunk.registryOrigin === 'legacy_plan55';
  }
  return false;
}

function isExternalPrivateKnowledgeChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'android_internals_wiki' &&
    chunk.registryOrigin === 'external_knowledge_registry';
}

function metadata(chunk: RagChunk): SanitizedRagHit['metadata'] {
  return {
    kind: chunk.kind,
    ...(chunk.codebaseId ? {codebaseId: chunk.codebaseId} : {}),
    ...(chunk.filePath ? {filePath: chunk.filePath} : {}),
    ...(chunk.lineRange ? {lineRange: chunk.lineRange} : {}),
    ...(chunk.symbol ? {symbol: chunk.symbol} : {}),
    ...(chunk.language ? {language: chunk.language} : {}),
    ...(chunk.commitHash ? {commitHash: chunk.commitHash} : {}),
    ...(chunk.vendor ? {vendor: chunk.vendor} : {}),
    ...(chunk.buildId ? {buildId: chunk.buildId} : {}),
    ...(chunk.knowledgeSourceId ? {knowledgeSourceId: chunk.knowledgeSourceId} : {}),
    ...(chunk.sourceGeneration ? {sourceGeneration: chunk.sourceGeneration} : {}),
    ...(chunk.title ? {title: chunk.title} : {}),
    ...(chunk.uri ? {uri: chunk.uri} : {}),
    ...(chunk.license ? {license: chunk.license} : {}),
    ...(chunk.attribution ? {attribution: chunk.attribution} : {}),
    ...(chunk.sourceStatus ? {sourceStatus: chunk.sourceStatus} : {}),
    ...(chunk.sourceConfidence ? {sourceConfidence: chunk.sourceConfidence} : {}),
    ...(chunk.lastVerifiedAgainst ? {lastVerifiedAgainst: chunk.lastVerifiedAgainst} : {}),
    ...(chunk.contentFingerprint ? {contentFingerprint: chunk.contentFingerprint} : {}),
    ...(chunk.articleId ? {articleId: chunk.articleId} : {}),
    ...(chunk.sectionId ? {sectionId: chunk.sectionId} : {}),
    ...(chunk.sectionHeading ? {sectionHeading: chunk.sectionHeading} : {}),
    ...(chunk.chunkHash ? {chunkHash: chunk.chunkHash} : {}),
    ...(chunk.knowledgePackVersion
      ? {knowledgePackVersion: chunk.knowledgePackVersion}
      : {}),
    ...(chunk.knowledgePackFingerprint
      ? {knowledgePackFingerprint: chunk.knowledgePackFingerprint}
      : {}),
    ...(chunk.sourceDirty !== undefined ? {sourceDirty: chunk.sourceDirty} : {}),
    ...(chunk.commitProvenance ? {commitProvenance: chunk.commitProvenance} : {}),
  };
}

function estimateTokens(chunk: RagChunk, snippet: string): number {
  return chunk.tokenCount ?? Math.max(1, estimateTextTokens(snippet));
}

export async function filterRagLookup(
  raw: RagRetrievalResult,
  ctx: FilterContext,
): Promise<SanitizedRagResult> {
  const hits: SanitizedRagHit[] = [];
  let allLegacy = true;

  for (const hit of raw.results) {
    if (!hit.chunk) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        unsupportedReason: hit.unsupportedReason ?? 'chunk_missing',
      });
      continue;
    }

    const chunk = hit.chunk;
    if (isLegacyChunk(chunk)) {
      // Public retrieved knowledge draws on the knowledge pool like the rest.
      const tokens = estimateTokens(chunk, chunk.snippet);
      if (ctx.budget && tokens > ctx.budget.knowledgeTokens.left()) {
        hits.push({chunkId: hit.chunkId, score: hit.score, metadata: metadata(chunk),
          unsupportedReason: 'budget_exceeded'});
        ctx.ledger?.record({turn: ctx.turn, ts: Date.now(), toolName: ctx.toolName, chunkIds: [],
          consentApplied: false, tokensSpent: 0, outcome: 'budget_exceeded', legacyPath: true});
        continue;
      }
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        snippet: chunk.snippet,
        unsupportedReason: hit.unsupportedReason,
      });
      ctx.budget?.knowledgeTokens.spend(tokens);
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [chunk.chunkId],
        consentApplied: false,
        tokensSpent: tokens,
        outcome: 'success',
        legacyPath: true,
      });
      continue;
    }

    allLegacy = false;
    // A retired Wiki chunk is never served: no remaining lookup searches its
    // kind, and one that surfaces anyway is refused without its text.
    if (isExternalPrivateKnowledgeChunk(chunk)) {
      hits.push({chunkId: hit.chunkId, score: hit.score, unsupportedReason: 'knowledge_kind_retired'});
      ctx.ledger?.record({turn: ctx.turn, ts: Date.now(), toolName: ctx.toolName, chunkIds: [],
        consentApplied: true, tokensSpent: 0, outcome: 'rejected', legacyPath: false});
      continue;
    }
    if (!isUserCodebaseChunk(chunk)) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'unknown_kind_origin',
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        chunkIds: [],
        consentApplied: false,
        tokensSpent: 0,
        outcome: 'rejected',
        legacyPath: false,
      });
      continue;
    }

    const ref = chunk.codebaseId
      ? ctx.codebaseRegistry?.get(chunk.codebaseId, ctx.knowledgeScope)
      : undefined;
    if (!chunk.codebaseId || !ref) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'invalid_codebase_metadata',
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: false,
        tokensSpent: 0,
        outcome: 'rejected',
        legacyPath: false,
      });
      continue;
    }

    if (!chunk.filePath) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'invalid_codebase_metadata',
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: false,
        tokensSpent: 0,
        outcome: 'rejected',
        legacyPath: false,
      });
      continue;
    }

    if (!sourceSelectionAdmits(sourceSelectionForRef(ref), chunk.filePath)) {
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: false,
        tokensSpent: 0,
        outcome: 'rejected',
        legacyPath: false,
      });
      continue;
    }

    if (
      ref.consent.sendToProvider &&
      ctx.allowProviderSend !== false &&
      !sourcePathAllowedForProvider(ref, chunk.filePath)
    ) {
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: true,
        tokensSpent: 0,
        outcome: 'rejected',
        legacyPath: false,
      });
      continue;
    }

    const activeGeneration = activeCodebaseGeneration(ref);
    if (
      (chunk.sourceGeneration && chunk.sourceGeneration !== activeGeneration) ||
      (!chunk.sourceGeneration && ref.indexGeneration > 1)
    ) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'inactive_source_generation',
      });
      continue;
    }

    if (!ref.consent.sendToProvider || ctx.allowProviderSend === false) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: ctx.allowProviderSend === false
          ? 'provider_send_disabled_for_session'
          : 'no_send_to_provider_consent',
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: true,
        tokensSpent: 0,
        outcome: 'consent_blocked',
        legacyPath: false,
      });
      continue;
    }

    const redacted = redactSecrets(chunk.snippet, credentialContextForPath(chunk.filePath));
    const tokens = estimateTokens(chunk, redacted.text);
    if (ctx.budget && tokens > ctx.budget.sourceTokens.left()) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'budget_exceeded',
        redactedCount: redacted.redactedCount,
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [],
        consentApplied: true,
        tokensSpent: 0,
        outcome: 'budget_exceeded',
        legacyPath: false,
      });
      continue;
    }

    const sourceHit: SanitizedRagHit = {
      chunkId: hit.chunkId,
      score: hit.score,
      metadata: metadata(chunk),
      snippet: redacted.text,
      redactedCount: redacted.redactedCount,
    };
    if (ctx.admitSourceHit && !ctx.admitSourceHit(sourceHit)) {
      ctx.ledger?.record({turn: ctx.turn, ts: Date.now(), toolName: ctx.toolName,
        codebaseId: chunk.codebaseId, chunkIds: [], consentApplied: true,
        tokensSpent: 0, outcome: 'budget_exceeded', legacyPath: false});
      continue;
    }
    hits.push(sourceHit);
    ctx.budget?.sourceTokens.spend(tokens);
    ctx.ledger?.record({
      turn: ctx.turn,
      ts: Date.now(),
      toolName: ctx.toolName,
      codebaseId: chunk.codebaseId,
      // The generation the chunk came from, so a later patch can tell it was rebuilt.
      ...(chunk.sourceGeneration ? {sourceGeneration: chunk.sourceGeneration} : {}),
      chunkIds: [chunk.chunkId],
      consentApplied: true,
      tokensSpent: tokens,
      outcome: 'success',
      legacyPath: false,
    });
  }

  const sanitized = {
    query: raw.query,
    hits,
    probed: raw.probed,
    retrievedAt: raw.retrievedAt,
    ...(raw.unsupportedReason ? {unsupportedReason: raw.unsupportedReason} : {}),
    legacyPath: allLegacy,
  };
  registerCodeAwareLookupForEcho(ctx.sessionId, sanitized);
  return sanitized;
}
