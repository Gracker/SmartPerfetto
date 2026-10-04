// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

import type {CodeAwareMode} from './codebase/codeAwareFeature';
import type {CodebaseRef, CodebaseRegistry} from './codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from './codebase/defaultCodebaseServices';
import {
  type ExternalKnowledgeSource,
  type ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
} from './externalKnowledgeSourceRegistry';
import type {KnowledgeScope} from './scopedKnowledgeStore';
import {analysisHasPrivateContext} from './security/analysisPrivateContext';
import {effectiveAnalysisSelection, type EffectiveAnalysisSelection} from './effectiveAnalysisSelection';
import {PublicRequestError} from '../utils/publicRequestError';

export interface AnalysisContextSelection {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
}

export class AnalysisContextAuthorizationChangedError extends PublicRequestError {
  declare readonly code: 'analysis_context_changed_restart_required';

  constructor() {
    super('analysis_context_changed_restart_required', 'analysis_context_changed_restart_required', 409);
  }
}

/** In-memory partition for raw SQL correction state; contains no source text. */
export function analysisContextMemoryPartitionKey(
  selection: AnalysisContextSelection,
): string {
  const effective = effectiveAnalysisSelection(selection);
  if (!analysisHasPrivateContext(effective)) return 'trace-public';
  return `private-${createHash('sha256').update(JSON.stringify({
    codeAwareMode: effective.codeAwareMode,
    codebaseIds: selectedIds(effective.codebaseIds),
    knowledgeSourceIds: selectedIds(effective.knowledgeSourceIds),
  })).digest('hex').slice(0, 24)}`;
}

function selectedIds(values: readonly string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

/**
 * The fingerprint's format. A fingerprint of another format never equals one
 * of this format, so a stored record from before a format change reads as
 * "authorization changed": nothing is re-stamped with the new value.
 * `acf2` dropped the index generation (P7c).
 */
const ANALYSIS_CONTEXT_FINGERPRINT_FORMAT = 'acf2';

/**
 * Non-secret authorization partition for provider/runtime continuation: who
 * may use which selected codebases and knowledge sources, with what consent,
 * selection scope, lifecycle and license, read through the effective
 * selection (`effectiveAnalysisSelection`), so an `off` run's hidden ids and
 * an unset mode cannot split one authorization into two. It holds no index
 * generation, so a rebuild elsewhere neither revokes a session nor hides its
 * history; every index entry point checks the generation its run pinned
 * instead (`indexGenerationPins.ts`).
 */
export function buildAnalysisContextAuthorizationFingerprint(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  registries: AnalysisContextRegistries = {},
): string {
  const effective = effectiveAnalysisSelection(selection);
  return fingerprintOfEffective(effective, scope, readRegistrationsOf(effective, scope, registries));
}

export interface AnalysisContextRegistries {
  codebaseRegistry?: CodebaseRegistry;
  knowledgeRegistry?: ExternalKnowledgeSourceRegistry;
}

/** The selected registrations as read at one moment; an id that is gone maps to undefined. */
export interface AnalysisContextRegistrations {
  codebases: ReadonlyMap<string, CodebaseRef | undefined>;
  knowledgeSources: ReadonlyMap<string, ExternalKnowledgeSource | undefined>;
}

/**
 * One read of every selected registration. A caller that checks more than
 * authorization at the same moment (the index tools also check the generation
 * their run pinned) reads once and derives both from it.
 */
export function readAnalysisContextRegistrations(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  registries: AnalysisContextRegistries = {},
): AnalysisContextRegistrations {
  return readRegistrationsOf(effectiveAnalysisSelection(selection), scope, registries);
}

function readRegistrationsOf(
  effective: EffectiveAnalysisSelection,
  scope: KnowledgeScope,
  registries: AnalysisContextRegistries,
): AnalysisContextRegistrations {
  const codebaseIds = selectedIds(effective.codebaseIds);
  const knowledgeSourceIds = selectedIds(effective.knowledgeSourceIds);
  // One fresh read of each store for every selected id. A store that cannot
  // be read throws `StoreUnreadableError`: a failed read is not a revoke.
  return {
    codebases: codebaseIds.length === 0 ? new Map()
      : readSelected(registries.codebaseRegistry ?? getDefaultCodebaseRegistry(), codebaseIds, scope),
    knowledgeSources: knowledgeSourceIds.length === 0 ? new Map()
      : readSelected(registries.knowledgeRegistry ?? getDefaultExternalKnowledgeSourceRegistry(), knowledgeSourceIds, scope),
  };
}

/** A registry offering only `get` (an injected port) is read one id at a time. */
function readSelected<T>(
  registry: {get(id: string, scope: KnowledgeScope): T | undefined; getSelected?(ids: readonly string[], scope: KnowledgeScope): Map<string, T | undefined>},
  ids: readonly string[],
  scope: KnowledgeScope,
): ReadonlyMap<string, T | undefined> {
  return typeof registry.getSelected === 'function'
    ? registry.getSelected(ids, scope) : new Map(ids.map(id => [id, registry.get(id, scope)]));
}

/** The fingerprint of registrations already read (`readAnalysisContextRegistrations`). */
export function analysisContextFingerprintOf(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  registrations: AnalysisContextRegistrations,
): string {
  return fingerprintOfEffective(effectiveAnalysisSelection(selection), scope, registrations);
}

function fingerprintOfEffective(
  effective: EffectiveAnalysisSelection,
  scope: KnowledgeScope,
  registrations: AnalysisContextRegistrations,
): string {
  const payload = {
    scope: {
      tenantId: scope.tenantId ?? '',
      workspaceId: scope.workspaceId ?? '',
      userId: scope.userId ?? '',
    },
    codeAwareMode: effective.codeAwareMode,
    codebases: [...registrations.codebases].map(([codebaseId, ref]) => ref
      ? {
          codebaseId,
          lifecycleState: ref.lifecycleState ?? 'active',
          selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
          licenseTag: ref.licenseTag ?? null,
          consentHash: ref.consent.consentHash,
          grantRevision: ref.consent.grant?.revision ?? 1,
          sendToProvider: ref.consent.sendToProvider,
        }
      : {codebaseId, unavailable: true}),
    knowledgeSources: [...registrations.knowledgeSources].map(([sourceId, source]) => source
      ? {
          sourceId,
          license: source.license,
          rightsAcknowledged: source.rightsAcknowledged,
          sendToProvider: source.sendToProvider,
          consentedAt: source.consentedAt ?? null,
        }
      : {sourceId, unavailable: true}),
  };
  return `${ANALYSIS_CONTEXT_FINGERPRINT_FORMAT}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

/**
 * The fingerprint a run was admitted under, which every later check compares
 * against. It has to come from admission (`prepareSession`, the conversation
 * and CLI entry points all compute it): rebuilding it at run time would pin
 * whatever the registries hold by then, so a revoke between admission and the
 * run would pass every check.
 */
export function requireAdmittedAnalysisContextFingerprint(fingerprint: string | undefined): string {
  if (typeof fingerprint !== 'string' || !fingerprint.trim()) {
    throw new Error('analysis_context_fingerprint_required');
  }
  return fingerprint;
}

/** Final run-boundary authorization fence for consent/selection/deletion TOCTOU; index generations are checked per tool. */
export function assertCurrentAnalysisContextAuthorization(
  selection: AnalysisContextSelection,
  scope: KnowledgeScope,
  expectedFingerprint: string,
  registries: AnalysisContextRegistries = {},
): void {
  const current = buildAnalysisContextAuthorizationFingerprint(selection, scope, registries);
  if (current !== expectedFingerprint) {
    throw new AnalysisContextAuthorizationChangedError();
  }
}
