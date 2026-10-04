// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {noteAuthorizationRegistryWrite} from './authorizationRegistryWrites';
import {createHash, randomUUID} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {backendLogPath} from '../runtimePaths';
import {type RootAuthorizationChannel, withoutUnsharedRootChannel} from './codebase/codebaseCapability';
import {withFilesystemRegistryLock} from './filesystemRegistryLock';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  getScopedKnowledgeRecord,
  legacyKnowledgeFilesystemWritesEnabled,
  listScopedKnowledgeRecords,
  mutateScopedKnowledgeRecord,
  removeScopedKnowledgeRecordIf,
  upsertScopedKnowledgeRecord,
} from './scopedKnowledgeStore';
import {
  type ScopedIngestLease,
  type ScopedIngestLeaseConfig,
  withScopedIngestLease,
} from './scopedIngestLease';
import {PublicRequestError} from '../utils/publicRequestError';
import {logStoredReadFailure, parseStoredJson, StoreUnreadableError} from '../utils/storedData';

/** An external knowledge source request the caller has to change: an unknown source or a missing acknowledgement. */
export class KnowledgeSourceRequestError extends PublicRequestError {}

function knowledgeSourceNotFound(sourceId: string): KnowledgeSourceRequestError {
  return new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_NOT_FOUND',
    `External knowledge source '${sourceId}' not found`, 404);
}

function knowledgeSourceDeleting(sourceId: string): KnowledgeSourceRequestError {
  return new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_DELETING',
    `External knowledge source '${sourceId}' is being deleted`, 409);
}

export interface ExternalKnowledgeScope {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

/**
 * `document_collection` is any folder of documents, indexed into its own
 * SQLite generation files (`services/knowledge/`). `android_internals_wiki`
 * is the retired connector for one Wiki layout: its stored records are still
 * read, listed and deletable, but none is registered or served to a run.
 */
export type ExternalKnowledgeKind = 'android_internals_wiki' | 'document_collection';

type DescriptiveField = 'description' | 'attribution' | 'license';

const TEXT_LIMITS: Readonly<Record<DescriptiveField | 'displayName', number>> = {
  displayName: 120,
  description: 280,
  attribution: 280,
  license: 120,
};

interface ExternalKnowledgeKindPolicy {
  /** No run may use the kind: its records stay listed and deletable, and the folder is re-registered as a document collection. */
  retired: boolean;
  /** Owner-written fields a registration carries: omitted keeps the recorded value, empty clears it. */
  descriptiveFields: readonly DescriptiveField[];
  /** Activation records the replaced generation, whose files a pinned reader may still hold. */
  retainsPreviousGeneration: boolean;
}

/** Every kind's policy; the Record type makes a new kind a compile error until it is described here. */
const KIND_POLICIES: Readonly<Record<ExternalKnowledgeKind, ExternalKnowledgeKindPolicy>> = {
  android_internals_wiki: {retired: true, descriptiveFields: ['license'], retainsPreviousGeneration: false},
  document_collection: {
    retired: false,
    descriptiveFields: ['description', 'attribution', 'license'],
    retainsPreviousGeneration: true,
  },
};

/** A stored kind no run may use: `retired` in its policy, or a kind this build does not know. */
export function externalKnowledgeKindRetired(kind: ExternalKnowledgeKind): boolean {
  return KIND_POLICIES[kind]?.retired ?? true;
}

/**
 * How a registered root was authorized when it is not by
 * `SMARTPERFETTO_KNOWLEDGE_ROOTS`: `native_picker` is a folder the owner chose
 * in the local directory picker. Each registration records its own channel,
 * and only that source's own root is trusted through it
 * (`channelAuthorizedRoots`); deleting the source revokes it.
 */
export type KnowledgeRootAuthorization = Extract<RootAuthorizationChannel, 'native_picker'>;

interface RegisterExternalKnowledgeSourceBase {
  displayName: string;
  rootRealpath: string;
  /** Absent: the configured allowlist authorized the root. */
  rootAuthorization?: KnowledgeRootAuthorization;
  revision: string;
  contentFingerprint: string;
  dirty: boolean;
  rightsAcknowledged: boolean;
  /**
   * Omitted keeps the provider-send consent in effect (none for a new
   * source); a boolean grants or revokes it. Re-registering a path must not
   * silently revoke what the owner granted, nor restore what was revoked.
   */
  sendToProvider?: boolean;
  consentedBy: string;
  scope: ExternalKnowledgeScope;
}

interface ExternalKnowledgeDescriptiveText {
  /** Owner-written, at most 280 characters: what the collection covers. */
  description?: string;
  attribution?: string;
  /** The owner's own license statement. */
  license?: string;
}

/** Only a document collection is registered; a retired kind is never written anew. */
export type RegisterExternalKnowledgeSourceInput =
  RegisterExternalKnowledgeSourceBase & ExternalKnowledgeDescriptiveText & {kind: 'document_collection'};

export type ExternalKnowledgeSource =
  Omit<RegisterExternalKnowledgeSourceBase, 'sendToProvider'> & ExternalKnowledgeDescriptiveText & {
    kind: ExternalKnowledgeKind;
    sendToProvider: boolean;
    sourceId: string;
    rightsAcknowledgedAt: number;
    consentedAt?: number;
    indexGeneration: number;
    activeGeneration?: string;
    /** The generation the active one replaced (`retainsPreviousGeneration`). */
    previousGeneration?: string;
    indexedArticleCount?: number;
    indexedChunkCount?: number;
    /**
     * `deleting` is the fenced tombstone `remove` writes on every store side
     * before deleting anything: the source reads as absent everywhere and
     * refuses every mutation until the record is gone.
     */
    lifecycleState?: 'active' | 'deleting';
  };

function isDeleting(source: Pick<ExternalKnowledgeSource, 'lifecycleState'>): boolean {
  return source.lifecycleState === 'deleting';
}

function boundedText(value: string, field: keyof typeof TEXT_LIMITS): string {
  const trimmed = value.trim();
  if (trimmed.length > TEXT_LIMITS[field] || trimmed.includes('\0')) {
    throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_METADATA_INVALID',
      `\`${field}\` must be at most ${TEXT_LIMITS[field]} characters`);
  }
  return trimmed;
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
      'source_not_whitelisted' | 'knowledge_kind_retired' | 'right_to_use_not_acknowledged' |
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

/** What a destructive cleanup step checks before it runs: the caller still owns the source. */
export interface KnowledgeCleanupFence {
  assertHeld(): void;
}

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

const SOURCE_ID_PREFIX = 'eks_';
const SOURCE_ID_HEX_CHARS = 24;
const SOURCE_ID_PATTERN = new RegExp(`^${SOURCE_ID_PREFIX}[0-9a-f]{${SOURCE_ID_HEX_CHARS}}$`);

/** A source as its owner's management surfaces show it: no root path, no scope, no root channel. */
export function sanitizeExternalKnowledgeSource(source: ExternalKnowledgeSource) {
  const {rootRealpath: _rootRealpath, scope: _scope, rootAuthorization: _rootAuthorization, ...safeSource} = source;
  return safeSource;
}

/** A knowledge source as the `/knowledge` routes and `smp knowledge` list it: no root, plus its index state. */
export function projectKnowledgeSourceForManagement(source: ExternalKnowledgeSource) {
  return {
    ...sanitizeExternalKnowledgeSource(source),
    documentCount: source.indexedArticleCount ?? 0,
    hasActiveIndex: externalKnowledgeSourceHasActiveIndex(source),
    retired: externalKnowledgeKindRetired(source.kind),
  };
}

/** True only for an id this registry mints: safe as a path segment and in projected output. */
export function isExternalKnowledgeSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ID_PATTERN.test(value);
}

/** The scope identity every store of external knowledge partitions by. */
export function scopeKey(scope: ExternalKnowledgeScope): string {
  return [scope.tenantId ?? '', scope.workspaceId ?? '', scope.userId ?? ''].join('\0');
}

function sameScope(left: ExternalKnowledgeScope, right: ExternalKnowledgeScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

/**
 * `primary` carrying every denial `other` holds: a tombstone on either side
 * deletes, a consent revoked on either side stays revoked (with the
 * revoking side's audit fields), and a root channel missing on either side
 * is not trusted. Without `primary`, only an in-scope
 * tombstone of `other` survives, so a deletion half done stays in force.
 */
function withDenialsOf(
  primary: ExternalKnowledgeSource | undefined,
  other: ExternalKnowledgeSource | undefined,
  scope: ExternalKnowledgeScope,
): ExternalKnowledgeSource | undefined {
  const counterpart = other && sameScope(other.scope, scope) ? other : undefined;
  if (!primary) return counterpart && isDeleting(counterpart) ? counterpart : undefined;
  if (!counterpart || isDeleting(primary)) return primary;
  if (isDeleting(counterpart)) return {...primary, lifecycleState: 'deleting'};
  let effective = withoutUnsharedRootChannel(primary, counterpart);
  if (effective.sendToProvider && !counterpart.sendToProvider) {
    const {consentedAt: _consentedAt, ...granted} = effective;
    effective = {...granted, sendToProvider: false, consentedBy: counterpart.consentedBy};
  }
  return effective;
}

/**
 * The dual-write read: the filesystem copy is the authority, with the DB
 * copy's denials, and two different active generations serve neither.
 */
function mergeDualWriteExternalSourceFailClosed(
  filesystemSource: ExternalKnowledgeSource | undefined,
  databaseSource: ExternalKnowledgeSource | undefined,
  scope: ExternalKnowledgeScope,
): ExternalKnowledgeSource | undefined {
  const authority = filesystemSource && sameScope(filesystemSource.scope, scope) ? filesystemSource : undefined;
  const effective = withDenialsOf(authority, databaseSource, scope);
  if (
    !effective || isDeleting(effective) || !authority ||
    !databaseSource || !sameScope(databaseSource.scope, scope)
  ) {
    return effective;
  }
  if (
    authority.activeGeneration !== databaseSource.activeGeneration ||
    authority.contentFingerprint !== databaseSource.contentFingerprint
  ) {
    return {...effective, activeGeneration: undefined, indexedArticleCount: 0, indexedChunkCount: 0};
  }
  return effective;
}

function markDeleting(source: ExternalKnowledgeSource, actor: string): ExternalKnowledgeSource {
  const {
    activeGeneration: _activeGeneration,
    previousGeneration: _previousGeneration,
    consentedAt: _consentedAt,
    ...unchanged
  } = source;
  return {
    ...unchanged,
    lifecycleState: 'deleting',
    sendToProvider: false,
    consentedBy: actor,
    indexedArticleCount: 0,
    indexedChunkCount: 0,
  };
}

/** Persistent policy boundary for operator-registered private knowledge. */
const KNOWLEDGE_REGISTRY_STORE = 'knowledge source registry';

export class ExternalKnowledgeSourceRegistry {
  private readonly sources = new Map<string, ExternalKnowledgeSource>();
  private loaded = false;

  constructor(private readonly storagePath: string) {}

  register(input: RegisterExternalKnowledgeSourceInput): ExternalKnowledgeSource {
    if (!input.rightsAcknowledged) {
      throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_RIGHTS_REQUIRED', 'A separate right-to-use acknowledgement is required');
    }
    const descriptive: Partial<Record<DescriptiveField, string>> = {};
    for (const field of KIND_POLICIES[input.kind].descriptiveFields) {
      const value = (input as ExternalKnowledgeDescriptiveText)[field];
      if (value !== undefined) descriptive[field] = boundedText(value, field);
    }
    const sourceId = `${SOURCE_ID_PREFIX}${createHash('sha256')
      .update(`${input.kind}\0${path.resolve(input.rootRealpath)}\0${scopeKey(input.scope)}`)
      .digest('hex')
      .slice(0, SOURCE_ID_HEX_CHARS)}`;
    return this.mutateSource(sourceId, input.scope, previous => {
      if (previous && isDeleting(previous)) throw knowledgeSourceDeleting(sourceId);
      // A record kept from before the limit may keep its own name; a new or changed name is bounded.
      const displayName = previous && previous.displayName === input.displayName.trim()
        ? previous.displayName : boundedText(input.displayName, 'displayName');
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
      // `previous` already carries every store side's denials, so an omitted
      // consent keeps the consent in effect, never one a side revoked.
      const consent = input.sendToProvider === undefined
        ? {
            sendToProvider: previous?.sendToProvider ?? false,
            consentedBy: previous?.consentedBy ?? input.consentedBy,
            consentedAt: previous?.consentedAt,
          }
        : {
            sendToProvider: input.sendToProvider,
            consentedBy: input.consentedBy,
            consentedAt: input.sendToProvider ? now : undefined,
          };
      const descriptiveFields: Partial<Record<DescriptiveField, string>> = {};
      for (const field of KIND_POLICIES[input.kind].descriptiveFields) {
        const kept = descriptive[field] ?? previous?.[field];
        if (kept) descriptiveFields[field] = kept;
      }
      return {
        kind: input.kind,
        displayName,
        rootRealpath: path.resolve(input.rootRealpath),
        // The channel of this registration, never one an earlier registration recorded.
        ...(input.rootAuthorization ? {rootAuthorization: input.rootAuthorization} : {}),
        ...activeIdentity,
        ...descriptiveFields,
        rightsAcknowledged: true,
        sendToProvider: consent.sendToProvider,
        consentedBy: consent.consentedBy,
        ...(consent.sendToProvider && consent.consentedAt !== undefined ? {consentedAt: consent.consentedAt} : {}),
        scope: input.scope,
        sourceId,
        rightsAcknowledgedAt: previous?.rightsAcknowledgedAt ?? now,
        indexGeneration: previous?.indexGeneration ?? 0,
        ...(previous?.activeGeneration ? {activeGeneration: previous.activeGeneration} : {}),
        ...(previous?.previousGeneration ? {previousGeneration: previous.previousGeneration} : {}),
        ...(previous?.indexedArticleCount !== undefined
          ? {indexedArticleCount: previous.indexedArticleCount}
          : {}),
        ...(previous?.indexedChunkCount !== undefined
          ? {indexedChunkCount: previous.indexedChunkCount}
          : {}),
      };
    });
  }

  /**
   * The selected sources from one fresh read of the store, for an
   * authorization check; a source being deleted reads as absent. Unlike `get`,
   * a store file that exists but cannot be read or parsed throws
   * `StoreUnreadableError` instead of reading as empty.
   */
  getSelected(sourceIds: readonly string[], scope: ExternalKnowledgeScope): Map<string, ExternalKnowledgeSource | undefined> {
    if (enterpriseKnowledgeStoreEnabled()) return new Map(sourceIds.map(id => [id, this.get(id, scope)]));
    const filesystem = this.readFilesystemSourcesStrict();
    return new Map(sourceIds.map(id => {
      const filesystemSource = filesystem.get(id);
      const source = enterpriseKnowledgeDbWritesEnabled()
        ? mergeDualWriteExternalSourceFailClosed(filesystemSource, this.databaseSource(id, scope), scope)
        : filesystemSource && sameScope(filesystemSource.scope, scope) ? filesystemSource : undefined;
      return [id, source && !isDeleting(source) ? source : undefined];
    }));
  }

  /** A source being deleted reads as absent. */
  get(sourceId: string, scope: ExternalKnowledgeScope): ExternalKnowledgeSource | undefined {
    const source = this.getIncludingDeleting(sourceId, scope);
    return source && !isDeleting(source) ? source : undefined;
  }

  private getIncludingDeleting(
    sourceId: string,
    scope: ExternalKnowledgeScope,
  ): ExternalKnowledgeSource | undefined {
    if (enterpriseKnowledgeStoreEnabled()) return this.databaseSource(sourceId, scope);
    const filesystemSource = this.getFilesystemSource(sourceId);
    return enterpriseKnowledgeDbWritesEnabled()
      ? mergeDualWriteExternalSourceFailClosed(filesystemSource, this.databaseSource(sourceId, scope), scope)
      : filesystemSource && sameScope(filesystemSource.scope, scope) ? filesystemSource : undefined;
  }

  /** The DB copy, when it belongs to `scope`. */
  private databaseSource(sourceId: string, scope: ExternalKnowledgeScope): ExternalKnowledgeSource | undefined {
    const source = getScopedKnowledgeRecord<ExternalKnowledgeSource>(
      REGISTRY_KNOWLEDGE_KIND,
      sourceId,
      scope,
    )?.record;
    return source && sameScope(source.scope, scope) ? source : undefined;
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
      .filter(source => sameScope(source.scope, scope) && !isDeleting(source))
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
      if (isDeleting(source)) throw knowledgeSourceDeleting(sourceId);
      // A retired source may still be revoked, never granted a consent it cannot use.
      if (sendToProvider && externalKnowledgeKindRetired(source.kind)) {
        throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_RETIRED',
          `External knowledge source '${sourceId}' is retired; register its folder as a document collection`, 409);
      }
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
    if (externalKnowledgeKindRetired(source.kind)) {
      return {allowed: false, reason: 'knowledge_kind_retired'};
    }
    if (!source.rightsAcknowledged) {
      return {allowed: false, reason: 'right_to_use_not_acknowledged'};
    }
    if (!source.sendToProvider) {
      return {allowed: false, reason: 'provider_send_not_consented'};
    }
    return {allowed: true, source};
  }

  /**
   * The source, for local indexing and its owner's search: rights are
   * required, provider-send consent is not, since nothing leaves the machine.
   * Body text reaching a provider still needs `evaluateAccess`.
   */
  requireIndexAccess(sourceId: string, scope: ExternalKnowledgeScope): ExternalKnowledgeSource {
    const source = this.get(sourceId, scope);
    if (!source) throw knowledgeSourceNotFound(sourceId);
    if (!source.rightsAcknowledged) {
      throw new KnowledgeSourceRequestError('KNOWLEDGE_SOURCE_RIGHTS_REQUIRED',
        'A separate right-to-use acknowledgement is required');
    }
    return source;
  }

  /**
   * Every generation either store side still names as active or previous.
   * After a failed activation this is what decides whether a new generation's
   * files may go: a pointer on either side keeps them.
   */
  referencedGenerations(sourceId: string, scope: ExternalKnowledgeScope): Set<string> {
    const records: Array<ExternalKnowledgeSource | undefined> = [];
    if (enterpriseKnowledgeStoreEnabled() || enterpriseKnowledgeDbWritesEnabled()) {
      records.push(this.databaseSource(sourceId, scope));
    }
    if (!enterpriseKnowledgeStoreEnabled() || legacyKnowledgeFilesystemWritesEnabled()) {
      records.push(this.getFilesystemSource(sourceId));
    }
    const generations = new Set<string>();
    for (const record of records) {
      if (!record || !sameScope(record.scope, scope)) continue;
      if (record.activeGeneration) generations.add(record.activeGeneration);
      if (record.previousGeneration) generations.add(record.previousGeneration);
    }
    return generations;
  }

  /**
   * Delete a source under its ingest lease. The fenced tombstone is written
   * to every store side first, even when one side already holds it from an
   * earlier attempt, which revokes access at once; then `removeIndex` (the
   * kind's index files or chunks) runs with the lease as its fence; then the
   * records go, DB copy first. Whatever step fails, every remaining record is
   * a tombstone, so access stays denied and a retry finishes the deletion.
   */
  async remove(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    actor: string,
    removeIndex: (tombstone: ExternalKnowledgeSource, fence: KnowledgeCleanupFence) => Promise<void> | void,
  ): Promise<ExternalKnowledgeSource> {
    const requireRemovable = () => {
      if (!this.getIncludingDeleting(sourceId, scope)) throw knowledgeSourceNotFound(sourceId);
    };
    // Checked before the lease too, so an unknown id never creates a lease record.
    requireRemovable();
    return this.withLease(sourceId, scope, async lease => {
      requireRemovable();
      const tombstone = this.mutateSourceWithLease(sourceId, scope, lease, current => {
        if (!current) throw knowledgeSourceNotFound(sourceId);
        return markDeleting(current, actor);
      });
      const fence: KnowledgeCleanupFence = {assertHeld: () => lease.assertHeld(true)};
      fence.assertHeld();
      await removeIndex(tombstone, fence);
      this.deleteTombstoneWithLease(sourceId, scope, lease);
      return tombstone;
    });
  }

  /** Serialize source generation changes across enterprise instances. */
  async withIngestLease<T>(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    operation: (lease: ExternalKnowledgeIngestLeaseGuard) => Promise<T> | T,
  ): Promise<T> {
    return this.withLease(sourceId, scope, lease => operation({
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
      }));
  }

  private withLease<T>(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    operation: (lease: ScopedIngestLease) => Promise<T> | T,
  ): Promise<T> {
    return withScopedIngestLease(
      INGEST_LEASE,
      sourceId,
      scope,
      {registryPath: this.storagePath, key: `${sourceId}\0${scopeKey(scope)}`},
      operation,
    );
  }

  /**
   * Remove a tombstoned record. Both copies are tombstones by now; the DB
   * copy goes first, so a failure leaves the filesystem tombstone, which
   * dual-write reads as the authority.
   */
  private deleteTombstoneWithLease(
    sourceId: string,
    scope: ExternalKnowledgeScope,
    lease: ScopedIngestLease,
  ): void {
    const deleteRecord = (): void => {
      lease.assertHeld(true);
      if (lease.distributed) {
        noteAuthorizationRegistryWrite();
        removeScopedKnowledgeRecordIf<ExternalKnowledgeSource>(
          REGISTRY_KNOWLEDGE_KIND,
          sourceId,
          scope,
          current => isDeleting(current) && sameScope(current.scope, scope),
        );
      }
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        const filesystemSource = this.sources.get(sourceId);
        if (filesystemSource && sameScope(filesystemSource.scope, scope)) {
          this.sources.delete(sourceId);
          this.persist();
        }
      }
    };
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      withFilesystemRegistryLock(this.storagePath, 'external_knowledge_registry_busy', deleteRecord);
    } else {
      deleteRecord();
    }
  }

  private activateSource(
    sourceId: string,
    source: ExternalKnowledgeSource | undefined,
    input: ActivateExternalKnowledgeGenerationInput,
  ): ExternalKnowledgeSource {
    if (!source) throw knowledgeSourceNotFound(sourceId);
    if (isDeleting(source)) throw knowledgeSourceDeleting(sourceId);
    const replaced = KIND_POLICIES[source.kind].retainsPreviousGeneration &&
      source.activeGeneration && source.activeGeneration !== input.generation
      ? source.activeGeneration
      : source.previousGeneration;
    return {
      ...source,
      ...(replaced ? {previousGeneration: replaced} : {}),
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
    if (isDeleting(source)) throw knowledgeSourceDeleting(sourceId);
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
      // Read under the filesystem lock: a filesystem tombstone or revoked
      // consent must reach the mutation, which then overwrites that copy.
      let filesystemSource: ExternalKnowledgeSource | undefined;
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        filesystemSource = this.getFilesystemSource(sourceId);
        if (filesystemSource && !sameScope(filesystemSource.scope, scope)) {
          throw knowledgeSourceNotFound(sourceId);
        }
      }
      const updated = lease.mutateFenced<ExternalKnowledgeSource>({
        kind: REGISTRY_KNOWLEDGE_KIND,
        externalId: sourceId,
        options: {rowScope: REGISTRY_ROW_SCOPE},
        mutate: current => {
          if (current && !sameScope(current.scope, scope)) {
            throw knowledgeSourceNotFound(sourceId);
          }
          return mutate(withDenialsOf(current, filesystemSource, scope));
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

  /** The store file read whole; a missing file is empty, an unreadable one throws. */
  private readFilesystemSourcesStrict(): Map<string, ExternalKnowledgeSource> {
    if (!fs.existsSync(this.storagePath)) return new Map();
    try {
      const parsed = parseStoredJson<StorageEnvelope>(fs.readFileSync(this.storagePath, 'utf8'), KNOWLEDGE_REGISTRY_STORE);
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) throw new StoreUnreadableError(KNOWLEDGE_REGISTRY_STORE);
      return new Map(parsed.sources.map(source => [source.sourceId, source]));
    } catch (error) {
      logStoredReadFailure('[ExternalKnowledgeSourceRegistry] Registry could not be read', error);
      throw new StoreUnreadableError(KNOWLEDGE_REGISTRY_STORE);
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
      noteAuthorizationRegistryWrite();
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
    const filesystemSource = this.sources.get(sourceId);
    if (filesystemSource && !sameScope(filesystemSource.scope, scope)) {
      throw knowledgeSourceNotFound(sourceId);
    }
    // The filesystem is the read authority here, but a tombstone or a revoked
    // consent that only reached the DB copy must still reach the mutation.
    const current = enterpriseKnowledgeDbWritesEnabled()
      ? withDenialsOf(filesystemSource, this.databaseSource(sourceId, scope), scope)
      : filesystemSource;
    const updated = mutate(current);
    if (enterpriseKnowledgeDbWritesEnabled()) {
      noteAuthorizationRegistryWrite();
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
    noteAuthorizationRegistryWrite();
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
