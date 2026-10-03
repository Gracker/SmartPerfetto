// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash, randomUUID} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {backendLogPath} from '../runtimePaths';
import {withFilesystemRegistryLock} from './filesystemRegistryLock';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  getScopedKnowledgeRecord,
  legacyKnowledgeFilesystemWritesEnabled,
  listScopedKnowledgeRecords,
  mutateScopedKnowledgeRecord,
  upsertScopedKnowledgeRecord,
} from './scopedKnowledgeStore';
import {
  type ScopedIngestLease,
  type ScopedIngestLeaseConfig,
  withScopedIngestLease,
} from './scopedIngestLease';
import {PublicRequestError} from '../utils/publicRequestError';

/** An external knowledge source request the caller has to change: an unknown source or a missing acknowledgement. */
export class KnowledgeSourceRequestError extends PublicRequestError {}

function knowledgeSourceNotFound(sourceId: string): KnowledgeSourceRequestError {
  return new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_NOT_FOUND',
    `External knowledge source '${sourceId}' not found`, 404);
}

export interface ExternalKnowledgeScope {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

export interface RegisterExternalKnowledgeSourceInput {
  kind: 'android_internals_wiki';
  displayName: string;
  rootRealpath: string;
  revision: string;
  contentFingerprint: string;
  dirty: boolean;
  license: string;
  rightsAcknowledged: boolean;
  sendToProvider: boolean;
  consentedBy: string;
  scope: ExternalKnowledgeScope;
}

export interface ExternalKnowledgeSource extends RegisterExternalKnowledgeSourceInput {
  sourceId: string;
  rightsAcknowledgedAt: number;
  consentedAt?: number;
  indexGeneration: number;
  activeGeneration?: string;
  indexedArticleCount?: number;
  indexedChunkCount?: number;
}

/**
 * A generation is consumable only after its immutable identity and at least
 * one indexed chunk have been activated. This mirrors the source-code index
 * boundary and rejects legacy or partially-written registry records.
 */
export function externalKnowledgeSourceHasActiveIndex(
  source: Pick<
    ExternalKnowledgeSource,
    'activeGeneration' | 'contentFingerprint' | 'indexedChunkCount'
  >,
): boolean {
  return Boolean(
    source.activeGeneration &&
    source.contentFingerprint &&
    (source.indexedChunkCount ?? 0) > 0
  );
}

export type ExternalKnowledgeAccessDecision =
  | {allowed: true; source: ExternalKnowledgeSource}
  | {allowed: false; reason: 'source_not_found_or_out_of_scope' |
      'source_not_whitelisted' | 'right_to_use_not_acknowledged' |
      'provider_send_not_consented'};

export interface ActivateExternalKnowledgeGenerationInput {
  generation: string;
  revision: string;
  contentFingerprint: string;
  dirty: boolean;
  indexedArticleCount: number;
  indexedChunkCount: number;
}

interface StorageEnvelope {
  schemaVersion: 1;
  sources: ExternalKnowledgeSource[];
}

const REGISTRY_KNOWLEDGE_KIND = 'external_knowledge_source';
const REGISTRY_ROW_SCOPE = 'external-knowledge-source';
const INGEST_LEASE: ScopedIngestLeaseConfig = {
  kind: 'external_knowledge_ingest_lease',
  rowScope: 'external-knowledge-ingest-lease',
  ttlMs: 10 * 60 * 1000,
  inProgressError: () => new Error('external_knowledge_reindex_in_progress'),
  lostError: () => new Error('external_knowledge_reindex_lease_lost'),
  logPrefix: 'ExternalKnowledgeSourceRegistry',
};

export interface ExternalKnowledgeIngestLeaseGuard {
  /** Unique generation seed; prevents a later lease from reusing staged chunk ids. */
  operationId: string;
  /** Preflight check for non-destructive work performed outside the registry. */
  assertHeld(): void;
  /** Atomically validates the lease and activates the generation. */
  activateGeneration(input: ActivateExternalKnowledgeGenerationInput): ExternalKnowledgeSource;
  /** Atomically validates the lease and clears the active generation. */
  clearActiveGeneration(): ExternalKnowledgeSource;
}

function scopeKey(scope: ExternalKnowledgeScope): string {
  return [scope.tenantId ?? '', scope.workspaceId ?? '', scope.userId ?? ''].join('\0');
}

function sameScope(left: ExternalKnowledgeScope, right: ExternalKnowledgeScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function mergeDualWriteExternalSourceFailClosed(
  filesystemSource: ExternalKnowledgeSource | undefined,
  databaseSource: ExternalKnowledgeSource | undefined,
  scope: ExternalKnowledgeScope,
): ExternalKnowledgeSource | undefined {
  if (!filesystemSource || !sameScope(filesystemSource.scope, scope)) return undefined;
  if (!databaseSource || !sameScope(databaseSource.scope, scope)) return filesystemSource;
  let effective = filesystemSource;
  if (filesystemSource.sendToProvider && !databaseSource.sendToProvider) {
    effective = {
      ...effective,
      sendToProvider: false,
      consentedAt: undefined,
      consentedBy: databaseSource.consentedBy,
    };
  }
  if (
    filesystemSource.activeGeneration !== databaseSource.activeGeneration ||
    filesystemSource.contentFingerprint !== databaseSource.contentFingerprint
  ) {
    effective = {
      ...effective,
      activeGeneration: undefined,
      indexedArticleCount: 0,
      indexedChunkCount: 0,
    };
  }
  return effective;
}

/** Persistent policy boundary for operator-registered private knowledge. */
export class ExternalKnowledgeSourceRegistry {
  private readonly sources = new Map<string, ExternalKnowledgeSource>();
  private loaded = false;

  constructor(private readonly storagePath: string) {}

  register(input: RegisterExternalKnowledgeSourceInput): ExternalKnowledgeSource {
    if (!input.rightsAcknowledged) {
      throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_RIGHTS_REQUIRED', 'A separate right-to-use acknowledgement is required');
    }
    const sourceId = `eks_${createHash('sha256')
      .update(`${input.kind}\0${path.resolve(input.rootRealpath)}\0${scopeKey(input.scope)}`)
      .digest('hex')
      .slice(0, 24)}`;
    return this.mutateSource(sourceId, input.scope, previous => {
      const now = Date.now();
      const activeIdentity = previous?.activeGeneration
        ? {
            revision: previous.revision,
            contentFingerprint: previous.contentFingerprint,
            dirty: previous.dirty,
          }
        : {
            revision: input.revision,
            contentFingerprint: input.contentFingerprint,
            dirty: input.dirty,
          };
      return {
        ...input,
        ...activeIdentity,
        rootRealpath: path.resolve(input.rootRealpath),
        sourceId,
        rightsAcknowledgedAt: previous?.rightsAcknowledgedAt ?? now,
        ...(input.sendToProvider ? {consentedAt: now} : {}),
        indexGeneration: previous?.indexGeneration ?? 0,
        ...(previous?.activeGeneration ? {activeGeneration: previous.activeGeneration} : {}),
        ...(previous?.indexedArticleCount !== undefined
          ? {indexedArticleCount: previous.indexedArticleCount}
          : {}),
        ...(previous?.indexedChunkCount !== undefined
          ? {indexedChunkCount: previous.indexedChunkCount}
          : {}),
      };
    });
  }

  get(sourceId: string, scope: ExternalKnowledgeScope): ExternalKnowledgeSource | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      const source = getScopedKnowledgeRecord<ExternalKnowledgeSource>(
          REGISTRY_KNOWLEDGE_KIND,
          sourceId,
          scope,
        )?.record;
      return source && sameScope(source.scope, scope) ? source : undefined;
    }
    const filesystemSource = this.getFilesystemSource(sourceId);
    const databaseSource = enterpriseKnowledgeDbWritesEnabled()
      ? getScopedKnowledgeRecord<ExternalKnowledgeSource>(
          REGISTRY_KNOWLEDGE_KIND,
          sourceId,
          scope,
        )?.record
      : undefined;
    return mergeDualWriteExternalSourceFailClosed(
      filesystemSource,
      databaseSource,
      scope,
    );
  }

  list(scope: ExternalKnowledgeScope): ExternalKnowledgeSource[] {
    const dualWriteSourcesById = !enterpriseKnowledgeStoreEnabled()
      && enterpriseKnowledgeDbWritesEnabled()
      ? new Map(
          listScopedKnowledgeRecords<ExternalKnowledgeSource>(
            REGISTRY_KNOWLEDGE_KIND,
            scope,
            {rowScope: REGISTRY_ROW_SCOPE},
          ).map(row => [row.record.sourceId, row.record] as const),
        )
      : new Map<string, ExternalKnowledgeSource>();
    const sources = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<ExternalKnowledgeSource>(
          REGISTRY_KNOWLEDGE_KIND,
          scope,
          {rowScope: REGISTRY_ROW_SCOPE},
        ).map(record => record.record)
      : this.listFilesystemSources().flatMap(source => {
          const effective = enterpriseKnowledgeDbWritesEnabled()
            ? mergeDualWriteExternalSourceFailClosed(
                source,
                dualWriteSourcesById.get(source.sourceId),
                scope,
              )
            : source;
          return effective ? [effective] : [];
        });
    return sources
      .filter(source => sameScope(source.scope, scope))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  }

  setProviderConsent(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    sendToProvider: boolean,
    actor: string,
  ): ExternalKnowledgeSource {
    return this.mutateSource(sourceId, scope, source => {
      if (!source) throw knowledgeSourceNotFound(sourceId);
      return {
        ...source,
        sendToProvider,
        consentedBy: actor,
        ...(sendToProvider ? {consentedAt: Date.now()} : {consentedAt: undefined}),
      };
    });
  }

  evaluateAccess(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    whitelistedSourceIds: readonly string[],
  ): ExternalKnowledgeAccessDecision {
    const source = this.get(sourceId, scope);
    if (!source) return {allowed: false, reason: 'source_not_found_or_out_of_scope'};
    if (!whitelistedSourceIds.includes(sourceId)) {
      return {allowed: false, reason: 'source_not_whitelisted'};
    }
    if (!source.rightsAcknowledged) {
      return {allowed: false, reason: 'right_to_use_not_acknowledged'};
    }
    if (!source.sendToProvider) {
      return {allowed: false, reason: 'provider_send_not_consented'};
    }
    return {allowed: true, source};
  }

  /** Serialize source generation changes across enterprise instances. */
  async withIngestLease<T>(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    operation: (lease: ExternalKnowledgeIngestLeaseGuard) => Promise<T> | T,
  ): Promise<T> {
    return withScopedIngestLease(
      INGEST_LEASE,
      sourceId,
      scope,
      {registryPath: this.storagePath, key: `${sourceId}\0${scopeKey(scope)}`},
      lease => operation({
        operationId: lease.ownerToken,
        // The wiki ingester calls assertHeld() only as a fence: before staging,
        // before each chunk batch and before the staged count that gates
        // activation. Throttling would skip exactly the checks that must reach
        // the lease row, so every call is a durable check.
        assertHeld: () => lease.assertHeld(true),
        activateGeneration: input => this.mutateSourceWithLease(
          sourceId,
          scope,
          lease,
          source => this.activateSource(sourceId, source, input),
        ),
        clearActiveGeneration: () => this.mutateSourceWithLease(
          sourceId,
          scope,
          lease,
          source => this.clearSource(sourceId, source),
        ),
      }),
    );
  }

  private activateSource(
    sourceId: string,
    source: ExternalKnowledgeSource | undefined,
    input: ActivateExternalKnowledgeGenerationInput,
  ): ExternalKnowledgeSource {
    if (!source) throw knowledgeSourceNotFound(sourceId);
    return {
      ...source,
      revision: input.revision,
      contentFingerprint: input.contentFingerprint,
      dirty: input.dirty,
      activeGeneration: input.generation,
      indexGeneration: source.indexGeneration + 1,
      indexedArticleCount: input.indexedArticleCount,
      indexedChunkCount: input.indexedChunkCount,
    };
  }

  private clearSource(
    sourceId: string,
    source: ExternalKnowledgeSource | undefined,
  ): ExternalKnowledgeSource {
    if (!source) throw knowledgeSourceNotFound(sourceId);
    const {
      activeGeneration: _activeGeneration,
      indexedArticleCount: _indexedArticleCount,
      indexedChunkCount: _indexedChunkCount,
      ...unchanged
    } = source;
    return {
      ...unchanged,
      indexedArticleCount: 0,
      indexedChunkCount: 0,
    };
  }

  private mutateSourceWithLease(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    lease: ScopedIngestLease,
    mutate: (source: ExternalKnowledgeSource | undefined) => ExternalKnowledgeSource,
  ): ExternalKnowledgeSource {
    if (!lease.distributed) {
      lease.assertHeld(true);
      return this.mutateSource(sourceId, scope, mutate);
    }
    const activate = (): ExternalKnowledgeSource => {
      const updated = lease.mutateFenced<ExternalKnowledgeSource>({
        kind: REGISTRY_KNOWLEDGE_KIND,
        externalId: sourceId,
        options: {rowScope: REGISTRY_ROW_SCOPE},
        mutate: current => {
          if (current && !sameScope(current.scope, scope)) {
            throw knowledgeSourceNotFound(sourceId);
          }
          return mutate(current);
        },
      });
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        this.sources.set(sourceId, updated);
        this.persist();
      }
      return updated;
    };
    return legacyKnowledgeFilesystemWritesEnabled()
      ? withFilesystemRegistryLock(
          this.storagePath,
          'external_knowledge_registry_busy',
          activate,
        )
      : activate();
  }

  private load(refresh = false): void {
    if (this.loaded && !refresh) return;
    this.loaded = true;
    this.sources.clear();
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8')) as StorageEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) return;
      for (const source of parsed.sources) this.sources.set(source.sourceId, source);
    } catch {
      // Preserve an unreadable file for operator inspection; start empty.
    }
  }

  private getFilesystemSource(sourceId: string): ExternalKnowledgeSource | undefined {
    this.load(true);
    return this.sources.get(sourceId);
  }

  private listFilesystemSources(): ExternalKnowledgeSource[] {
    this.load(true);
    return Array.from(this.sources.values());
  }

  private mutateSource(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    mutate: (current: ExternalKnowledgeSource | undefined) => ExternalKnowledgeSource,
  ): ExternalKnowledgeSource {
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      return withFilesystemRegistryLock(
        this.storagePath,
        'external_knowledge_registry_busy',
        () => this.mutateSourceUnlocked(sourceId, scope, mutate),
      );
    }
    return this.mutateSourceUnlocked(sourceId, scope, mutate);
  }

  private mutateSourceUnlocked(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    mutate: (current: ExternalKnowledgeSource | undefined) => ExternalKnowledgeSource,
  ): ExternalKnowledgeSource {
    if (enterpriseKnowledgeStoreEnabled()) {
      return mutateScopedKnowledgeRecord(
        REGISTRY_KNOWLEDGE_KIND,
        sourceId,
        scope,
        current => {
          if (current && !sameScope(current.scope, scope)) {
            throw knowledgeSourceNotFound(sourceId);
          }
          return mutate(current);
        },
        {rowScope: REGISTRY_ROW_SCOPE},
      );
    }

    this.load(true);
    const current = this.sources.get(sourceId);
    if (current && !sameScope(current.scope, scope)) {
      throw knowledgeSourceNotFound(sourceId);
    }
    const updated = mutate(current);
    if (enterpriseKnowledgeDbWritesEnabled()) {
      upsertScopedKnowledgeRecord(
        REGISTRY_KNOWLEDGE_KIND,
        sourceId,
        REGISTRY_ROW_SCOPE,
        updated,
        scope,
      );
    }
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      this.sources.set(sourceId, updated);
      this.persist();
    }
    return updated;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storagePath), {recursive: true});
    const tempPath = `${this.storagePath}.tmp.${process.pid}.${randomUUID()}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      sources: Array.from(this.sources.values()).sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId)),
    };
    fs.writeFileSync(tempPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.storagePath);
  }
}

let defaultRegistry: ExternalKnowledgeSourceRegistry | undefined;

/** Process-wide registry shared by admin mutation and runtime authorization. */
export function getDefaultExternalKnowledgeSourceRegistry(): ExternalKnowledgeSourceRegistry {
  defaultRegistry ??= new ExternalKnowledgeSourceRegistry(
    backendLogPath('external_knowledge_sources.json'),
  );
  return defaultRegistry;
}
