// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {CodeAwareMode} from './codebase/codeAwareFeature';
import {activeCodebaseGeneration, type CodebaseRegistry} from './codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from './codebase/defaultCodebaseServices';
import {
  externalKnowledgeSourceHasActiveIndex,
  type ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
} from './externalKnowledgeSourceRegistry';
import type {KnowledgeScope} from './scopedKnowledgeStore';

export interface AnalysisContextSelection {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
}

export class AnalysisContextAuthorizationChangedError extends Error {
  readonly code = 'analysis_context_changed_restart_required';

  constructor() {
    super('analysis_context_changed_restart_required');
    this.name = 'AnalysisContextAuthorizationChangedError';
  }
}

/**
 * Whether a run is authorized to consume user/private knowledge. This is the
 * shared boundary for disabling cross-session learning and raw diagnostic
 * persistence; tenant scoping alone does not make model-authored text safe to
 * retain.
 */
export function analysisContextUsesPrivateKnowledge(
  selection: AnalysisContextSelection,
): boolean {
  return selectedIds(selection.codebaseIds).length > 0 ||
    selectedIds(selection.knowledgeSourceIds).length > 0;
}

/** In-memory partition for raw SQL correction state; contains no source text. */
export function analysisContextMemoryPartitionKey(
  selection: AnalysisContextSelection,
): string {
  if (!analysisContextUsesPrivateKnowledge(selection)) return 'trace-public';
  return `private-${createHash('sha256').update(JSON.stringify({
    codeAwareMode: selection.codeAwareMode ?? 'off',
    codebaseIds: selectedIds(selection.codebaseIds),
    knowledgeSourceIds: selectedIds(selection.knowledgeSourceIds),
  })).digest('hex').slice(0, 24)}`;
}

function selectedIds(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).filter(Boolean))).sort();
}

/** Non-secret authorization partition for provider/runtime continuation. */
export function buildAnalysisContextAuthorizationFingerprint(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  registries: {
    codebaseRegistry?: CodebaseRegistry;
    knowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  } = {},
): string {
  const codebaseRegistry = registries.codebaseRegistry ?? getDefaultCodebaseRegistry();
  const knowledgeRegistry = registries.knowledgeRegistry ?? getDefaultExternalKnowledgeSourceRegistry();
  const payload = {
    scope: {
      tenantId: scope.tenantId ?? '',
      workspaceId: scope.workspaceId ?? '',
      userId: scope.userId ?? '',
    },
    codeAwareMode: selection.codeAwareMode ?? 'off',
    codebases: selectedIds(selection.codebaseIds).map(codebaseId => {
      const ref = codebaseRegistry.get(codebaseId, scope);
      return ref
        ? {
            codebaseId,
            lifecycleState: ref.lifecycleState ?? 'active',
            selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
            indexGeneration: ref.indexGeneration,
            activeGeneration: activeCodebaseGeneration(ref),
            contentFingerprint: ref.contentFingerprint ?? null,
            indexedRevision: ref.indexedRevision ?? null,
            indexedDirty: ref.indexedDirty ?? null,
            commitProvenance: ref.commitProvenance ?? null,
            licenseTag: ref.licenseTag ?? null,
            consentHash: ref.consent.consentHash,
            grantRevision: ref.consent.grant?.revision ?? 1,
            sendToProvider: ref.consent.sendToProvider,
          }
        : {codebaseId, unavailable: true};
    }),
    knowledgeSources: selectedIds(selection.knowledgeSourceIds).map(sourceId => {
      const source = knowledgeRegistry.get(sourceId, scope);
      return source
        ? {
            sourceId,
            indexGeneration: source.indexGeneration,
            activeGeneration: source.activeGeneration ?? null,
            contentFingerprint: source.contentFingerprint,
            license: source.license,
            indexedChunkCount: source.indexedChunkCount ?? 0,
            activeIndexAvailable: externalKnowledgeSourceHasActiveIndex(source),
            rightsAcknowledged: source.rightsAcknowledged,
            sendToProvider: source.sendToProvider,
            consentedAt: source.consentedAt ?? null,
          }
        : {sourceId, unavailable: true};
    }),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Final run-boundary authorization fence for consent/generation TOCTOU. */
export function assertCurrentAnalysisContextAuthorization(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  expectedFingerprint: string,
  registries: {
    codebaseRegistry?: CodebaseRegistry;
    knowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  } = {},
): void {
  const current = buildAnalysisContextAuthorizationFingerprint(selection, scope, registries);
  if (current !== expectedFingerprint) {
    throw new AnalysisContextAuthorizationChangedError();
  }
}
