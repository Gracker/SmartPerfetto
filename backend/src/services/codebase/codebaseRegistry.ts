// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import {createHash, randomUUID} from 'crypto';

import type {RagSourceKind} from '../../types/sparkContracts';
import {
  withFilesystemRegistryLock,
  withFilesystemRegistryLockAsync,
} from '../filesystemRegistryLock';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  getScopedKnowledgeRecord,
  legacyKnowledgeFilesystemWritesEnabled,
  listScopedKnowledgeRecords,
  mutateScopedKnowledgeRecord,
  mutateScopedKnowledgeRecordPair,
  removeScopedKnowledgeRecord,
  upsertScopedKnowledgeRecord,
} from '../scopedKnowledgeStore';

export type CodebaseKind = Extract<RagSourceKind, 'app_source' | 'aosp' | 'kernel_source' | 'oem_sdk'>;
export type CodebaseRootAuthorization = 'configured_allowlist' | 'native_picker';
const CODEBASE_KINDS: readonly CodebaseKind[] = ['app_source', 'aosp', 'kernel_source', 'oem_sdk'];
const DEFAULT_TENANT_ID = 'default-dev-tenant';
const DEFAULT_WORKSPACE_ID = 'default-workspace';
const DEFAULT_USER_ID = 'dev-user-123';
const REGISTRY_KNOWLEDGE_KIND = 'codebase_registry_ref';
const REGISTRY_ROW_SCOPE = 'codebase-registry-ref';
const INGEST_LEASE_KNOWLEDGE_KIND = 'codebase_ingest_lease';
const INGEST_LEASE_ROW_SCOPE = 'codebase-ingest-lease';
const INGEST_LEASE_TTL_MS = 10 * 60 * 1000;

export interface CodebaseRegistrationRequirements {
  vendor: boolean;
  licenseTag: boolean;
  pathFilters: boolean;
}

export function isCodebaseKind(value: unknown): value is CodebaseKind {
  return typeof value === 'string' &&
    CODEBASE_KINDS.includes(value as CodebaseKind);
}

export function codebaseRegistrationRequirements(
  kind: CodebaseKind,
): CodebaseRegistrationRequirements {
  return {
    vendor: kind === 'kernel_source' || kind === 'oem_sdk',
    licenseTag: kind === 'aosp' || kind === 'oem_sdk',
    pathFilters: kind === 'kernel_source',
  };
}

export interface CodebaseScope {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

export interface CodebaseRef {
  codebaseId: string;
  lifecycleState?: 'active' | 'deleting';
  kind: CodebaseKind;
  displayName: string;
  rootPath: string;
  rootRealpath: string;
  /**
   * How the canonical root was authorized. Older registrations omit this
   * field and retain the configured allowlist behavior.
   */
  rootAuthorization?: CodebaseRootAuthorization;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  consent: {
    sendToProvider: boolean;
    consentedAt: number;
    consentedBy: string;
    consentHash: string;
  };
  indexGeneration: number;
  /** Immutable generation id currently authorized for retrieval. */
  activeGeneration?: string;
  /** Hash of the exact selected file paths and bytes used by the active generation. */
  contentFingerprint?: string;
  /** Git HEAD observed while the active generation was indexed, when available. */
  indexedRevision?: string;
  /** Whether the indexed checkout had uncommitted or untracked changes. */
  indexedDirty?: boolean;
  /** How commit/content provenance should be interpreted by downstream consumers. */
  commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
  lastIngestAt?: number;
  lastIngestStatus?: 'ok' | 'partial' | 'failed' | 'blocked_by_security';
  lastIngestError?: string;
  chunkCount?: number;
  blockedFileCount?: number;
  redactionHitCount?: number;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CodebaseRefSummary {
  codebaseId: string;
  lifecycleState: 'active' | 'deleting';
  kind: CodebaseRef['kind'];
  displayName: string;
  rootAuthorization: CodebaseRootAuthorization;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  indexGeneration: number;
  activeGeneration?: string;
  contentFingerprint?: string;
  indexedRevision?: string;
  indexedDirty?: boolean;
  commitProvenance?: CodebaseRef['commitProvenance'];
  chunkCount: number;
  lastIngestAt?: number;
  lastIngestStatus?: CodebaseRef['lastIngestStatus'];
  lastIngestError?: string;
  blockedFileCount: number;
  redactionHitCount: number;
  eligibleForSendToProvider: boolean;
}

export interface RegisterCodebaseInput {
  kind: CodebaseKind;
  displayName: string;
  rootPath: string;
  rootRealpath?: string;
  rootAuthorization?: CodebaseRootAuthorization;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  sendToProvider?: boolean;
  consentedBy?: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

interface CodebaseIngestLease {
  ownerToken: string;
  expiresAt: number;
}

export interface CodebaseIngestLeaseGuard {
  /** Makes staged chunk ids unique even if a previous lease expired mid-run. */
  operationId: string;
  /** Renews the lease and fails before more source data is staged if ownership changed. */
  assertHeld(): void;
  /** Updates ingest metadata only while this operation still owns the lease. */
  updateIngestStatus(
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
  ): CodebaseRef;
  /** Atomically fences lease ownership and switches the active index generation. */
  activateIndexGeneration(
    expectedCurrentGeneration: number,
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
  ): CodebaseRef;
  /** Makes the registration non-retrievable before destructive cleanup starts. */
  beginDeletion(actor: string): CodebaseRef;
  /** Permanently removes the fenced registration after its chunks are gone. */
  deleteRegistration(): CodebaseRef;
}

interface RegistryEnvelope {
  schemaVersion: 1;
  codebases: CodebaseRef[];
}

function consentHash(input: Pick<CodebaseRef, 'kind' | 'rootRealpath' | 'commitHash' | 'buildId' | 'vendor'>): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

export function resolveCodebaseScope(scope: CodebaseScope = {}): Required<CodebaseScope> {
  return {
    tenantId: scope.tenantId || DEFAULT_TENANT_ID,
    workspaceId: scope.workspaceId || DEFAULT_WORKSPACE_ID,
    userId: scope.userId || DEFAULT_USER_ID,
  };
}

export function codebaseScopeFromRef(ref: CodebaseRef): Required<CodebaseScope> {
  return resolveCodebaseScope(ref);
}

function sameScope(ref: CodebaseRef, scope: CodebaseScope = {}): boolean {
  const left = codebaseScopeFromRef(ref);
  const right = resolveCodebaseScope(scope);
  return left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.userId === right.userId;
}

function ingestLeaseKey(codebaseId: string, scope: CodebaseScope): string {
  const resolved = resolveCodebaseScope(scope);
  return [codebaseId, resolved.tenantId, resolved.workspaceId, resolved.userId].join('\0');
}

function toSummary(ref: CodebaseRef): CodebaseRefSummary {
  return {
    codebaseId: ref.codebaseId,
    lifecycleState: ref.lifecycleState ?? 'active',
    kind: ref.kind,
    displayName: ref.displayName,
    rootAuthorization: ref.rootAuthorization ?? 'configured_allowlist',
    ...(ref.commitHash ? {commitHash: ref.commitHash} : {}),
    ...(ref.vendor ? {vendor: ref.vendor} : {}),
    ...(ref.buildId ? {buildId: ref.buildId} : {}),
    indexGeneration: ref.indexGeneration,
    ...(ref.activeGeneration ? {activeGeneration: ref.activeGeneration} : {}),
    ...(ref.contentFingerprint ? {contentFingerprint: ref.contentFingerprint} : {}),
    ...(ref.indexedRevision ? {indexedRevision: ref.indexedRevision} : {}),
    ...(ref.indexedDirty !== undefined ? {indexedDirty: ref.indexedDirty} : {}),
    ...(ref.commitProvenance ? {commitProvenance: ref.commitProvenance} : {}),
    chunkCount: ref.chunkCount ?? 0,
    ...(ref.lastIngestAt !== undefined ? {lastIngestAt: ref.lastIngestAt} : {}),
    ...(ref.lastIngestStatus ? {lastIngestStatus: ref.lastIngestStatus} : {}),
    ...(ref.lastIngestError ? {lastIngestError: ref.lastIngestError} : {}),
    blockedFileCount: ref.blockedFileCount ?? 0,
    redactionHitCount: ref.redactionHitCount ?? 0,
    eligibleForSendToProvider: ref.consent.sendToProvider,
  };
}

function mergeDualWriteCodebaseFailClosed(
  filesystemRef: CodebaseRef | undefined,
  databaseRef: CodebaseRef | undefined,
  scope: CodebaseScope,
): CodebaseRef | undefined {
  if (!filesystemRef || !sameScope(filesystemRef, scope)) return undefined;
  if (!databaseRef || !sameScope(databaseRef, scope)) return filesystemRef;
  if (databaseRef.lifecycleState === 'deleting') return databaseRef;
  let effective = filesystemRef;
  if (filesystemRef.consent.sendToProvider && !databaseRef.consent.sendToProvider) {
    effective = {...effective, consent: databaseRef.consent};
  }
  if (
    filesystemRef.activeGeneration !== databaseRef.activeGeneration ||
    filesystemRef.contentFingerprint !== databaseRef.contentFingerprint
  ) {
    effective = {
      ...effective,
      activeGeneration: undefined,
      contentFingerprint: undefined,
      chunkCount: 0,
    };
  }
  return effective;
}

export function activeCodebaseGeneration(ref: Pick<CodebaseRef, 'indexGeneration' | 'activeGeneration'>): string {
  return ref.activeGeneration ?? `codebase_${ref.indexGeneration}`;
}

export function codebaseHasActiveIndex(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'activeGeneration' | 'contentFingerprint' | 'chunkCount'>,
): boolean {
  return (ref.lifecycleState ?? 'active') === 'active' &&
    Boolean(ref.activeGeneration && ref.contentFingerprint && (ref.chunkCount ?? 0) > 0);
}

export class CodebaseRegistry {
  private readonly registryPath: string;
  private readonly codebases = new Map<string, CodebaseRef>();
  private loaded = false;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
  }

  load(refresh = false): void {
    if (this.loaded && !refresh) return;
    this.loaded = true;
    this.codebases.clear();
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8')) as RegistryEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.codebases)) return;
      for (const ref of parsed.codebases) {
        this.codebases.set(ref.codebaseId, ref);
      }
    } catch {
      // Preserve corrupt registry for operator inspection.
    }
  }

  register(input: RegisterCodebaseInput): CodebaseRef {
    this.load();
    if (!CODEBASE_KINDS.includes(input.kind)) {
      throw new Error(`Unsupported codebase kind: ${input.kind}`);
    }
    // rootRealpath is a security identity, not a caller-provided display path.
    // Canonicalize even trusted preview input so consent and later drift checks
    // never inherit aliases such as macOS /var -> /private/var.
    const rootRealpath = fs.realpathSync(input.rootRealpath ?? input.rootPath);
    const now = Date.now();
    const ref: CodebaseRef = {
      codebaseId: `cb_${randomUUID()}`,
      lifecycleState: 'active',
      kind: input.kind,
      displayName: input.displayName,
      rootPath: input.rootPath,
      rootRealpath,
      ...(input.rootAuthorization && input.rootAuthorization !== 'configured_allowlist'
        ? {rootAuthorization: input.rootAuthorization}
        : {}),
      ...(input.commitHash ? {commitHash: input.commitHash} : {}),
      ...(input.vendor ? {vendor: input.vendor} : {}),
      ...(input.buildId ? {buildId: input.buildId} : {}),
      ...(input.pathFilters ? {pathFilters: input.pathFilters} : {}),
      ...(input.excludeGlobs ? {excludeGlobs: input.excludeGlobs} : {}),
      ...(input.symbolMapPaths ? {symbolMapPaths: input.symbolMapPaths} : {}),
      ...(input.licenseTag ? {licenseTag: input.licenseTag} : {}),
      consent: {
        sendToProvider: input.sendToProvider ?? false,
        consentedAt: now,
        consentedBy: input.consentedBy ?? input.userId ?? 'local-user',
        consentHash: consentHash({
          kind: input.kind,
          rootRealpath,
          commitHash: input.commitHash,
          buildId: input.buildId,
          vendor: input.vendor,
        }),
      },
      indexGeneration: 1,
      ...resolveCodebaseScope(input),
      createdAt: now,
      updatedAt: now,
    };
    const scope = resolveCodebaseScope(input);
    const persistRegistration = (): void => {
      if (enterpriseKnowledgeDbWritesEnabled()) {
        upsertScopedKnowledgeRecord(
          REGISTRY_KNOWLEDGE_KIND,
          ref.codebaseId,
          REGISTRY_ROW_SCOPE,
          ref,
          scope,
          {createdAt: now, updatedAt: now},
        );
      }
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        this.codebases.set(ref.codebaseId, ref);
        this.persist();
      }
    };
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      withFilesystemRegistryLock(this.registryPath, 'codebase_registry_busy', persistRegistration);
    } else {
      persistRegistration();
    }
    return ref;
  }

  get(codebaseId: string, scope: CodebaseScope = {}): CodebaseRef | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      const ref = getScopedKnowledgeRecord<CodebaseRef>(
          REGISTRY_KNOWLEDGE_KIND,
          codebaseId,
          scope,
        )?.record;
      return ref && sameScope(ref, scope) ? ref : undefined;
    }
    const filesystemRef = this.getFilesystemRef(codebaseId);
    const databaseRef = enterpriseKnowledgeDbWritesEnabled()
      ? getScopedKnowledgeRecord<CodebaseRef>(
          REGISTRY_KNOWLEDGE_KIND,
          codebaseId,
          scope,
        )?.record
      : undefined;
    return mergeDualWriteCodebaseFailClosed(filesystemRef, databaseRef, scope);
  }

  list(scope: CodebaseScope = {}): CodebaseRefSummary[] {
    const refsById = new Map<string, CodebaseRef>();
    if (!enterpriseKnowledgeStoreEnabled()) {
      const dualWriteRefsById = enterpriseKnowledgeDbWritesEnabled()
        ? new Map(
            listScopedKnowledgeRecords<CodebaseRef>(
              REGISTRY_KNOWLEDGE_KIND,
              scope,
              {rowScope: REGISTRY_ROW_SCOPE},
            ).map(row => [row.record.codebaseId, row.record] as const),
          )
        : new Map<string, CodebaseRef>();
      for (const ref of this.listFilesystemRefs()) {
        const effective = enterpriseKnowledgeDbWritesEnabled()
          ? mergeDualWriteCodebaseFailClosed(
              ref,
              dualWriteRefsById.get(ref.codebaseId),
              scope,
            )
          : ref;
        if (effective) refsById.set(ref.codebaseId, effective);
      }
    }
    if (enterpriseKnowledgeStoreEnabled()) {
      for (const row of listScopedKnowledgeRecords<CodebaseRef>(
        REGISTRY_KNOWLEDGE_KIND,
        scope,
        {rowScope: REGISTRY_ROW_SCOPE},
      )) {
        refsById.set(row.record.codebaseId, row.record);
      }
    }
    return Array.from(refsById.values())
      .filter(ref => sameScope(ref, scope))
      .sort((left, right) => left.codebaseId.localeCompare(right.codebaseId))
      .map(toSummary);
  }

  updateIngestStatus(
    codebaseId: string,
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
    scope: CodebaseScope = {},
  ): void {
    const updated = this.mutate(codebaseId, scope, existing => ({
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }));
    if (!updated) return;
  }

  setProviderConsent(
    codebaseId: string,
    scope: CodebaseScope,
    sendToProvider: boolean,
    actor: string,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') {
        throw new Error('codebase_deleting');
      }
      const consentedAt = Date.now();
      return {
        ...existing,
        consent: {
          sendToProvider,
          consentedAt,
          consentedBy: actor,
          consentHash: createHash('sha256')
            .update(`${existing.consent.consentHash}\0${sendToProvider}\0${actor}\0${consentedAt}`)
            .digest('hex')
            .slice(0, 16),
        },
        updatedAt: consentedAt,
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  activateIndexGeneration(
    codebaseId: string,
    scope: CodebaseScope,
    expectedCurrentGeneration: number,
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') {
        throw new Error('codebase_deleting');
      }
      if (existing.indexGeneration !== expectedCurrentGeneration) {
        throw new Error('codebase_index_generation_changed');
      }
      return {
        ...existing,
        ...patch,
        indexGeneration: expectedCurrentGeneration + 1,
        updatedAt: Date.now(),
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  /** Serialize generation changes across requests and enterprise instances. */
  async withIngestLease<T>(
    codebaseId: string,
    scope: CodebaseScope,
    operation: (lease: CodebaseIngestLeaseGuard) => Promise<T> | T,
    purpose: 'ingest' | 'delete' = 'ingest',
  ): Promise<T> {
    const ownerToken = randomUUID();
    const localLeaseKey = ingestLeaseKey(codebaseId, scope);
    const useDistributedLease = enterpriseKnowledgeDbWritesEnabled();
    if (!useDistributedLease) {
      const leasePath = `${this.registryPath}.ingest.${createHash('sha256')
        .update(localLeaseKey)
        .digest('hex')
        .slice(0, 24)}`;
      return withFilesystemRegistryLockAsync(
        leasePath,
        'codebase_reindex_in_progress',
        async filesystemLease => {
          const assertHeld = (): void => {
            try {
              filesystemLease.assertHeld();
            } catch {
              throw new Error('codebase_reindex_lease_lost');
            }
          };
          const lease: CodebaseIngestLeaseGuard = {
            operationId: ownerToken,
            assertHeld,
            updateIngestStatus: patch => {
              assertHeld();
              this.updateIngestStatus(codebaseId, patch, scope);
              const updated = this.get(codebaseId, scope);
              if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
              return updated;
            },
            activateIndexGeneration: (expectedCurrentGeneration, patch) => {
              assertHeld();
              return this.activateIndexGeneration(
                codebaseId,
                scope,
                expectedCurrentGeneration,
                patch,
              );
            },
            beginDeletion: actor => {
              assertHeld();
              return this.beginDeletionWithLease(
                codebaseId,
                scope,
                ownerToken,
                false,
                actor,
              );
            },
            deleteRegistration: () => {
              assertHeld();
              return this.deleteRegistrationWithLease(
                codebaseId,
                scope,
                ownerToken,
                false,
              );
            },
          };
          const current = this.get(codebaseId, scope);
          if (!current) {
            throw new Error(`Codebase '${codebaseId}' not found`);
          }
          if (purpose === 'ingest' && current.lifecycleState === 'deleting') {
            throw new Error('codebase_deleting');
          }
          return operation(lease);
        },
        INGEST_LEASE_TTL_MS,
      );
    }
    if (useDistributedLease) {
      mutateScopedKnowledgeRecord<CodebaseIngestLease>(
        INGEST_LEASE_KNOWLEDGE_KIND,
        codebaseId,
        scope,
        current => {
          const now = Date.now();
          if (current && current.expiresAt > now) {
            throw new Error('codebase_reindex_in_progress');
          }
          return {ownerToken, expiresAt: now + INGEST_LEASE_TTL_MS};
        },
        {rowScope: INGEST_LEASE_ROW_SCOPE},
      );
    }

    const lease: CodebaseIngestLeaseGuard = {
      operationId: ownerToken,
      assertHeld: () => {
        if (useDistributedLease) {
          mutateScopedKnowledgeRecord<CodebaseIngestLease>(
            INGEST_LEASE_KNOWLEDGE_KIND,
            codebaseId,
            scope,
            current => {
              const now = Date.now();
              if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
                throw new Error('codebase_reindex_lease_lost');
              }
              return {...current, expiresAt: now + INGEST_LEASE_TTL_MS};
            },
            {rowScope: INGEST_LEASE_ROW_SCOPE},
          );
        }
      },
      updateIngestStatus: patch =>
        this.updateIngestStatusWithLease(
          codebaseId,
          scope,
          ownerToken,
          patch,
        ),
      activateIndexGeneration: (expectedCurrentGeneration, patch) =>
        this.activateIndexGenerationWithLease(
          codebaseId,
          scope,
          ownerToken,
          useDistributedLease,
          expectedCurrentGeneration,
          patch,
        ),
      beginDeletion: actor => this.beginDeletionWithLease(
        codebaseId,
        scope,
        ownerToken,
        useDistributedLease,
        actor,
      ),
      deleteRegistration: () => this.deleteRegistrationWithLease(
        codebaseId,
        scope,
        ownerToken,
        useDistributedLease,
      ),
    };

    try {
      const current = this.get(codebaseId, scope);
      if (!current) {
        throw new Error(`Codebase '${codebaseId}' not found`);
      }
      if (purpose === 'ingest' && current.lifecycleState === 'deleting') {
        throw new Error('codebase_deleting');
      }
      return await operation(lease);
    } finally {
      if (useDistributedLease) {
        try {
          mutateScopedKnowledgeRecord<CodebaseIngestLease>(
            INGEST_LEASE_KNOWLEDGE_KIND,
            codebaseId,
            scope,
            current => current?.ownerToken === ownerToken
              ? {...current, expiresAt: 0}
              : current ?? {ownerToken: 'released', expiresAt: 0},
            {rowScope: INGEST_LEASE_ROW_SCOPE},
          );
        } catch (error) {
          console.warn(
            `[CodebaseRegistry] Lease release failed for ${codebaseId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  private updateIngestStatusWithLease(
    codebaseId: string,
    scope: CodebaseScope,
    ownerToken: string,
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
  ): CodebaseRef {
    const update = (): CodebaseRef => {
      const now = Date.now();
      const result = mutateScopedKnowledgeRecordPair<CodebaseIngestLease, CodebaseRef>(
        {
          kind: INGEST_LEASE_KNOWLEDGE_KIND,
          externalId: codebaseId,
          options: {rowScope: INGEST_LEASE_ROW_SCOPE},
          mutate: current => {
            if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
              throw new Error('codebase_reindex_lease_lost');
            }
            return {...current, expiresAt: now + INGEST_LEASE_TTL_MS};
          },
        },
        {
          kind: REGISTRY_KNOWLEDGE_KIND,
          externalId: codebaseId,
          options: {rowScope: REGISTRY_ROW_SCOPE},
          mutate: existing => {
            if (!existing || !sameScope(existing, scope)) {
              throw new Error(`Codebase '${codebaseId}' not found`);
            }
            return {...existing, ...patch, updatedAt: now};
          },
        },
        scope,
      );
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        this.codebases.set(codebaseId, result.second);
        this.persist();
      }
      return result.second;
    };
    return legacyKnowledgeFilesystemWritesEnabled()
      ? withFilesystemRegistryLock(this.registryPath, 'codebase_registry_busy', update)
      : update();
  }

  private activateIndexGenerationWithLease(
    codebaseId: string,
    scope: CodebaseScope,
    ownerToken: string,
    useDistributedLease: boolean,
    expectedCurrentGeneration: number,
    patch: Pick<CodebaseRef, 'lastIngestStatus'> & Partial<CodebaseRef>,
  ): CodebaseRef {
    const activate = (): CodebaseRef => {
      const now = Date.now();
      const result = mutateScopedKnowledgeRecordPair<CodebaseIngestLease, CodebaseRef>(
        {
          kind: INGEST_LEASE_KNOWLEDGE_KIND,
          externalId: codebaseId,
          options: {rowScope: INGEST_LEASE_ROW_SCOPE},
          mutate: current => {
            if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
              throw new Error('codebase_reindex_lease_lost');
            }
            return {...current, expiresAt: now + INGEST_LEASE_TTL_MS};
          },
        },
        {
          kind: REGISTRY_KNOWLEDGE_KIND,
          externalId: codebaseId,
          options: {rowScope: REGISTRY_ROW_SCOPE},
          mutate: existing => {
            if (!existing || !sameScope(existing, scope)) {
              throw new Error(`Codebase '${codebaseId}' not found`);
            }
            if (existing.indexGeneration !== expectedCurrentGeneration) {
              throw new Error('codebase_index_generation_changed');
            }
            if (existing.lifecycleState === 'deleting') {
              throw new Error('codebase_deleting');
            }
            return {
              ...existing,
              ...patch,
              indexGeneration: expectedCurrentGeneration + 1,
              updatedAt: now,
            };
          },
        },
        scope,
      );
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        this.codebases.set(codebaseId, result.second);
        this.persist();
      }
      return result.second;
    };
    return legacyKnowledgeFilesystemWritesEnabled()
      ? withFilesystemRegistryLock(this.registryPath, 'codebase_registry_busy', activate)
      : activate();
  }

  private beginDeletionWithLease(
    codebaseId: string,
    scope: CodebaseScope,
    ownerToken: string,
    useDistributedLease: boolean,
    actor: string,
  ): CodebaseRef {
    const markDeleting = (existing: CodebaseRef, now: number): CodebaseRef => ({
      ...existing,
      lifecycleState: 'deleting',
      activeGeneration: `deleted_${ownerToken}`,
      contentFingerprint: undefined,
      chunkCount: 0,
      consent: {
        sendToProvider: false,
        consentedAt: now,
        consentedBy: actor,
        consentHash: createHash('sha256')
          .update(`${existing.consent.consentHash}\0delete\0${actor}\0${now}`)
          .digest('hex')
          .slice(0, 16),
      },
      updatedAt: now,
    });
    const begin = (): CodebaseRef => {
      const now = Date.now();
      let updated: CodebaseRef;
      if (useDistributedLease) {
        updated = mutateScopedKnowledgeRecordPair<CodebaseIngestLease, CodebaseRef>(
          {
            kind: INGEST_LEASE_KNOWLEDGE_KIND,
            externalId: codebaseId,
            options: {rowScope: INGEST_LEASE_ROW_SCOPE},
            mutate: current => {
              if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
                throw new Error('codebase_reindex_lease_lost');
              }
              return {...current, expiresAt: now + INGEST_LEASE_TTL_MS};
            },
          },
          {
            kind: REGISTRY_KNOWLEDGE_KIND,
            externalId: codebaseId,
            options: {rowScope: REGISTRY_ROW_SCOPE},
            mutate: existing => {
              if (!existing || !sameScope(existing, scope)) {
                throw new Error(`Codebase '${codebaseId}' not found`);
              }
              return markDeleting(existing, now);
            },
          },
          scope,
        ).second;
      } else {
        const existing = this.get(codebaseId, scope);
        if (!existing) throw new Error(`Codebase '${codebaseId}' not found`);
        updated = markDeleting(existing, now);
      }
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        this.codebases.set(codebaseId, updated);
        this.persist();
      }
      return updated;
    };
    return legacyKnowledgeFilesystemWritesEnabled()
      ? withFilesystemRegistryLock(this.registryPath, 'codebase_registry_busy', begin)
      : begin();
  }

  private deleteRegistrationWithLease(
    codebaseId: string,
    scope: CodebaseScope,
    ownerToken: string,
    useDistributedLease: boolean,
  ): CodebaseRef {
    const remove = (): CodebaseRef => {
      if (useDistributedLease) {
        mutateScopedKnowledgeRecord<CodebaseIngestLease>(
          INGEST_LEASE_KNOWLEDGE_KIND,
          codebaseId,
          scope,
          current => {
            const now = Date.now();
            if (current?.ownerToken !== ownerToken || current.expiresAt <= now) {
              throw new Error('codebase_reindex_lease_lost');
            }
            return {...current, expiresAt: now + INGEST_LEASE_TTL_MS};
          },
          {rowScope: INGEST_LEASE_ROW_SCOPE},
        );
      }
      const existing = this.get(codebaseId, scope);
      if (!existing) throw new Error(`Codebase '${codebaseId}' not found`);
      if (existing.lifecycleState !== 'deleting') {
        throw new Error('codebase_delete_not_started');
      }
      // In dual-write migration the filesystem is the read authority. Remove
      // the secondary DB projection first so every failure leaves the
      // authoritative filesystem tombstone available for an idempotent retry.
      if (enterpriseKnowledgeDbWritesEnabled()) {
        removeScopedKnowledgeRecord(REGISTRY_KNOWLEDGE_KIND, codebaseId, scope);
      }
      if (legacyKnowledgeFilesystemWritesEnabled()) {
        this.load(true);
        const filesystemRef = this.codebases.get(codebaseId);
        if (!filesystemRef || !sameScope(filesystemRef, scope)) {
          if (!enterpriseKnowledgeDbWritesEnabled()) {
            throw new Error(`Codebase '${codebaseId}' not found`);
          }
        } else {
          this.codebases.delete(codebaseId);
          this.persist();
        }
      }
      return existing;
    };
    return legacyKnowledgeFilesystemWritesEnabled()
      ? withFilesystemRegistryLock(this.registryPath, 'codebase_registry_busy', remove)
      : remove();
  }

  private mutate(
    codebaseId: string,
    scope: CodebaseScope,
    mutate: (existing: CodebaseRef) => CodebaseRef,
  ): CodebaseRef | undefined {
    if (legacyKnowledgeFilesystemWritesEnabled()) {
      return withFilesystemRegistryLock(
        this.registryPath,
        'codebase_registry_busy',
        () => this.mutateUnlocked(codebaseId, scope, mutate),
      );
    }
    return this.mutateUnlocked(codebaseId, scope, mutate);
  }

  private mutateUnlocked(
    codebaseId: string,
    scope: CodebaseScope,
    mutate: (existing: CodebaseRef) => CodebaseRef,
  ): CodebaseRef | undefined {
    let updated: CodebaseRef | undefined;
    if (enterpriseKnowledgeStoreEnabled()) {
      updated = mutateScopedKnowledgeRecord<CodebaseRef>(
        REGISTRY_KNOWLEDGE_KIND,
        codebaseId,
        scope,
        existing => {
          if (!existing || !sameScope(existing, scope)) {
            throw new Error(`Codebase '${codebaseId}' not found`);
          }
          return mutate(existing);
        },
        {rowScope: REGISTRY_ROW_SCOPE},
      );
    } else {
      const existing = this.get(codebaseId, scope);
      if (!existing) return undefined;
      updated = mutate(existing);
      if (enterpriseKnowledgeDbWritesEnabled()) {
        upsertScopedKnowledgeRecord(
          REGISTRY_KNOWLEDGE_KIND,
          codebaseId,
          REGISTRY_ROW_SCOPE,
          updated,
          scope,
          {createdAt: existing.createdAt, updatedAt: updated.updatedAt},
        );
      }
    }
    if (legacyKnowledgeFilesystemWritesEnabled() && updated) {
      this.load(true);
      this.codebases.set(codebaseId, updated);
      this.persist();
    }
    return updated;
  }

  private getFilesystemRef(codebaseId: string): CodebaseRef | undefined {
    this.load(true);
    return this.codebases.get(codebaseId);
  }

  private listFilesystemRefs(): CodebaseRef[] {
    this.load(true);
    return Array.from(this.codebases.values());
  }

  private persist(): void {
    const dir = path.dirname(this.registryPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    const tmp = `${this.registryPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: RegistryEnvelope = {
      schemaVersion: 1,
      codebases: Array.from(this.codebases.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.registryPath);
  }
}
