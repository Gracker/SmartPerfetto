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
import type {CodeLookupLedger} from '../codebase/codeLookupLedger';
import {redactSecrets} from '../security/secretPatterns';
import {registerCodeAwareLookupForEcho} from '../security/codeAwareOutputRegistry';
import type {ExternalKnowledgeScope} from '../externalKnowledgeSourceRegistry';
import type {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';
import {
  backgroundKnowledgeReferenceFromChunk,
} from '../androidInternalsPack/backgroundKnowledgeReferences';
import type {BackgroundKnowledgeReference} from '../../types/sparkContracts';
import {
  registerSessionBackgroundKnowledgeReferences,
} from '../androidInternalsPack/sessionBackgroundKnowledgeRegistry';

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
  backgroundKnowledgeReferences?: BackgroundKnowledgeReference[];
}

export interface FilterContext {
  toolName: 'lookup_app_source' | 'lookup_kernel_source' | 'lookup_aosp_source' |
    'lookup_oem_sdk' | 'lookup_blog_knowledge';
  turn: number;
  codebaseRegistry?: CodebaseRegistry;
  ledger?: CodeLookupLedger;
  allowProviderSend?: boolean;
  sessionId?: string;
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  knowledgeSourceIds?: string[];
  knowledgeScope?: ExternalKnowledgeScope;
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

function isBuiltInKnowledgePackChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'android_internals_pack' &&
    chunk.registryOrigin === 'built_in_knowledge_pack';
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

function privateKnowledgeMetadata(chunk: RagChunk): SanitizedRagHit['metadata'] {
  const sourceStatus = chunk.sourceStatus?.toLowerCase();
  const sourceConfidence = chunk.sourceConfidence?.toLowerCase();
  const verifiedAt = Number.isFinite(chunk.verifiedAt) && Number(chunk.verifiedAt) >= 0
    ? Number(chunk.verifiedAt)
    : undefined;
  return {
    kind: chunk.kind,
    ...(chunk.knowledgeSourceId ? {knowledgeSourceId: chunk.knowledgeSourceId} : {}),
    ...(chunk.sourceGeneration ? {sourceGeneration: chunk.sourceGeneration} : {}),
    ...((sourceStatus === 'finalized' || sourceStatus === 'verified') ? {sourceStatus} : {}),
    ...((sourceConfidence === 'low' || sourceConfidence === 'medium' || sourceConfidence === 'high')
      ? {sourceConfidence}
      : {}),
    ...(verifiedAt !== undefined ? {verifiedAt} : {}),
    ...(chunk.contentFingerprint ? {contentFingerprint: chunk.contentFingerprint} : {}),
  };
}

function estimateTokens(chunk: RagChunk, snippet: string): number {
  return chunk.tokenCount ?? Math.max(1, Math.ceil(snippet.length / 4));
}

export async function filterRagLookup(
  raw: RagRetrievalResult,
  ctx: FilterContext,
): Promise<SanitizedRagResult> {
  const hits: SanitizedRagHit[] = [];
  const backgroundKnowledgeReferences: BackgroundKnowledgeReference[] = [];
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
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        snippet: chunk.snippet,
        unsupportedReason: hit.unsupportedReason,
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        codebaseId: chunk.codebaseId,
        chunkIds: [chunk.chunkId],
        consentApplied: false,
        tokensSpent: estimateTokens(chunk, chunk.snippet),
        outcome: 'success',
        legacyPath: true,
      });
      continue;
    }

    allLegacy = false;
    if (isBuiltInKnowledgePackChunk(chunk)) {
      const redacted = redactSecrets(chunk.snippet);
      const tokens = estimateTokens(chunk, redacted.text);
      if (ctx.ledger && tokens > ctx.ledger.remainingTokens()) {
        hits.push({
          chunkId: hit.chunkId,
          score: hit.score,
          metadata: metadata(chunk),
          unsupportedReason: 'budget_exceeded',
          redactedCount: redacted.redactedCount,
        });
        ctx.ledger.record({
          turn: ctx.turn,
          ts: Date.now(),
          toolName: ctx.toolName,
          chunkIds: [],
          consentApplied: false,
          tokensSpent: 0,
          outcome: 'budget_exceeded',
          legacyPath: false,
        });
        continue;
      }
      const reference = backgroundKnowledgeReferenceFromChunk(chunk);
      if (!reference) {
        hits.push({
          chunkId: hit.chunkId,
          score: hit.score,
          metadata: metadata(chunk),
          unsupportedReason: 'invalid_background_knowledge_reference',
          redactedCount: redacted.redactedCount,
        });
        continue;
      }
      backgroundKnowledgeReferences.push(reference);
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        snippet: redacted.text,
        redactedCount: redacted.redactedCount,
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        chunkIds: [chunk.chunkId],
        consentApplied: false,
        tokensSpent: tokens,
        outcome: 'success',
        legacyPath: false,
      });
      continue;
    }
    if (isExternalPrivateKnowledgeChunk(chunk)) {
      const access = chunk.knowledgeSourceId && ctx.externalKnowledgeRegistry
        ? ctx.externalKnowledgeRegistry.evaluateAccess(
            chunk.knowledgeSourceId,
            ctx.knowledgeScope ?? {},
            ctx.knowledgeSourceIds ?? [],
          )
        : {allowed: false as const, reason: 'source_not_found_or_out_of_scope' as const};
      const inactiveGeneration = access.allowed &&
        access.source.activeGeneration !== chunk.sourceGeneration;
      const blockedReason = !access.allowed
        ? access.reason
        : inactiveGeneration
          ? 'inactive_source_generation'
          : undefined;
      if (blockedReason) {
        hits.push({
          chunkId: hit.chunkId,
          score: hit.score,
          metadata: privateKnowledgeMetadata(chunk),
          unsupportedReason: blockedReason,
        });
        ctx.ledger?.record({
          turn: ctx.turn,
          ts: Date.now(),
          toolName: ctx.toolName,
          chunkIds: [],
          consentApplied: true,
          tokensSpent: 0,
          outcome: blockedReason === 'provider_send_not_consented'
            ? 'consent_blocked'
            : 'rejected',
          legacyPath: false,
        });
        continue;
      }
      const redacted = redactSecrets(chunk.snippet);
      const tokens = estimateTokens(chunk, redacted.text);
      if (ctx.ledger && tokens > ctx.ledger.remainingTokens()) {
        hits.push({
          chunkId: hit.chunkId,
          score: hit.score,
          metadata: privateKnowledgeMetadata(chunk),
          unsupportedReason: 'budget_exceeded',
          redactedCount: redacted.redactedCount,
        });
        ctx.ledger.record({
          turn: ctx.turn,
          ts: Date.now(),
          toolName: ctx.toolName,
          chunkIds: [],
          consentApplied: true,
          tokensSpent: 0,
          outcome: 'budget_exceeded',
          legacyPath: false,
        });
        continue;
      }
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: privateKnowledgeMetadata(chunk),
        snippet: redacted.text,
        redactedCount: redacted.redactedCount,
      });
      ctx.ledger?.record({
        turn: ctx.turn,
        ts: Date.now(),
        toolName: ctx.toolName,
        knowledgeSourceId: chunk.knowledgeSourceId,
        sourceGeneration: chunk.sourceGeneration,
        chunkIds: [chunk.chunkId],
        consentApplied: true,
        tokensSpent: tokens,
        outcome: 'success',
        legacyPath: false,
      });
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

    const redacted = redactSecrets(chunk.snippet);
    const tokens = estimateTokens(chunk, redacted.text);
    if (ctx.ledger && tokens > ctx.ledger.remainingTokens()) {
      hits.push({
        chunkId: hit.chunkId,
        score: hit.score,
        metadata: metadata(chunk),
        unsupportedReason: 'budget_exceeded',
        redactedCount: redacted.redactedCount,
      });
      ctx.ledger.record({
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

    hits.push({
      chunkId: hit.chunkId,
      score: hit.score,
      metadata: metadata(chunk),
      snippet: redacted.text,
      redactedCount: redacted.redactedCount,
    });
    ctx.ledger?.record({
      turn: ctx.turn,
      ts: Date.now(),
      toolName: ctx.toolName,
      codebaseId: chunk.codebaseId,
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
    ...(backgroundKnowledgeReferences.length > 0 ? {backgroundKnowledgeReferences} : {}),
  };
  registerSessionBackgroundKnowledgeReferences(
    ctx.sessionId,
    backgroundKnowledgeReferences,
  );
  registerCodeAwareLookupForEcho(ctx.sessionId, sanitized);
  return sanitized;
}
