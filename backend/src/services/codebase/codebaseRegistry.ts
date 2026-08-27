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
import {effectiveConsentGrant, legacyConsentGrant} from './sourceDisclosure';
import {buildSourceSelectionIR, sourceExtensionsForKind} from './sourceSelectionPolicy';

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
const INGEST_LEASE_HEARTBEAT_MS = Math.max(1_000, Math.floor(INGEST_LEASE_TTL_MS / 3));
export const PENDING_GENERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface CodebaseConsentGrant {
  revision: number;
  grantedAt: number;
  grantedBy: string;
  extensions: string[];
  includePrefixes: string[];
  excludeGlobs: string[];
}

export interface IndexCoverage {
  selectionPolicyRevision: number;
  enumerationBackend: 'ripgrep' | 'git' | 'node-walk';
  backendFidelity: 'exact' | 'degraded';
  enumerationComplete: boolean;
  deterministic: boolean;
  filesEnumerated: number;
  filesSelected: number;
  bytesSelected: number;
  chunksIndexed: number;
  truncated: boolean;
  complete: boolean;
  truncationReason?: 'file_budget' | 'byte_budget' | 'enumeration_budget' | 'time_budget';
}

export interface PendingCodebaseGeneration {
  candidateGenerationId: string;
  coverage: IndexCoverage;
  contentFingerprint: string;
  chunkCount: number;
  createdAt: number;
  indexedRevision?: string;
  indexedDirty?: boolean;
  commitProvenance?: CodebaseRef['commitProvenance'];
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
  selectionPolicyRevision?: number;
  symbolMapPaths?: string[];
  licenseTag?: string;
  consent: {
    sendToProvider: boolean;
    consentedAt: number;
    consentedBy: string;
    consentHash: string;
    grant?: CodebaseConsentGrant;
  };
  indexGeneration: number;
  /** Immutable generation id currently authorized for retrieval. */
  activeGeneration?: string;
  /** Explicit retrieval state; `none` never falls back to a synthetic id. */
  activeIndexState?: 'active' | 'none';
  /** Hash of the exact selected file paths and bytes used by the active generation. */
  contentFingerprint?: string;
  activeIndexCoverage?: IndexCoverage;
  pendingGeneration?: PendingCodebaseGeneration;
  lastAttemptCoverage?: IndexCoverage;
  maintenanceWarning?: 'inactive_chunk_cleanup_failed' | 'pending_generation_expired';
  reindexRequired?:
    | 'selection_scope_narrowed'
    | 'selection_scope_changed'
    | 'provider_language_scope_expanded';
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
  rootAvailable: boolean;
  rootAuthorization: CodebaseRootAuthorization;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  indexGeneration: number;
  activeGeneration?: string;
  activeIndexState: 'active' | 'none';
  selectionPolicyRevision: number;
  grantRevision: number;
  providerGrantScopeCurrent: boolean;
  availableNotConsentedExtensions: string[];
  activeIndexCoverage?: IndexCoverage;
  pendingGeneration?: PendingCodebaseGeneration;
  maintenanceWarning?: CodebaseRef['maintenanceWarning'];
  reindexRequired?: CodebaseRef['reindexRequired'];
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
  assertHeld(forceDurableCheck?: boolean): void;
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
  schemaVersion: 1 | 2;
  codebases: CodebaseRef[];
}

function normalizeCodebaseRef(ref: CodebaseRef): CodebaseRef {
  const legacyGeneration = ref.activeGeneration ?? (
    ref.contentFingerprint && (ref.chunkCount ?? 0) > 0
      ? `codebase_${ref.indexGeneration}`
      : undefined
  );
  const legacyPartial = ref.lastIngestStatus === 'partial';
  return {
    ...ref,
    activeIndexState: ref.activeIndexState ?? (legacyGeneration ? 'active' : 'none'),
    ...(legacyGeneration ? {activeGeneration: legacyGeneration} : {}),
    selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
    consent: {
      ...ref.consent,
      grant: ref.consent.grant ?? legacyConsentGrant(ref),
    },
    ...(legacyPartial
      ? {
          lastIngestStatus: 'ok' as const,
          maintenanceWarning: ref.maintenanceWarning ?? 'inactive_chunk_cleanup_failed' as const,
        }
      : {}),
  };
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

function listsEqual(left?: readonly string[], right?: readonly string[]): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function codebaseProviderGrantScopeCurrent(ref: CodebaseRef): boolean {
  const grant = effectiveConsentGrant(ref);
  const selection = buildSourceSelectionIR({
    kind: ref.kind,
    includePrefixes: ref.pathFilters,
    excludeGlobs: ref.excludeGlobs,
  });
  return listsEqual(grant.includePrefixes, selection.includePrefixes) &&
    listsEqual(grant.excludeGlobs, selection.excludeGlobs);
}

function ingestLeaseKey(codebaseId: string, scope: CodebaseScope): string {
  const resolved = resolveCodebaseScope(scope);
  return [codebaseId, resolved.tenantId, resolved.workspaceId, resolved.userId].join('\0');
}

function toSummary(ref: CodebaseRef): CodebaseRefSummary {
  const normalized = normalizeCodebaseRef(ref);
  ref = normalized;
  return {
    codebaseId: ref.codebaseId,
    lifecycleState: ref.lifecycleState ?? 'active',
    kind: ref.kind,
    displayName: ref.displayName,
    rootAvailable: codebaseRootAvailable(ref),
    rootAuthorization: ref.rootAuthorization ?? 'configured_allowlist',
    ...(ref.commitHash ? {commitHash: ref.commitHash} : {}),
    ...(ref.vendor ? {vendor: ref.vendor} : {}),
    ...(ref.buildId ? {buildId: ref.buildId} : {}),
    ...(ref.pathFilters ? {pathFilters: [...ref.pathFilters]} : {}),
    ...(ref.excludeGlobs ? {excludeGlobs: [...ref.excludeGlobs]} : {}),
    indexGeneration: ref.indexGeneration,
    ...(ref.activeGeneration ? {activeGeneration: ref.activeGeneration} : {}),
    activeIndexState: ref.activeIndexState ?? 'none',
    selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
    grantRevision: effectiveConsentGrant(ref).revision,
    providerGrantScopeCurrent: codebaseProviderGrantScopeCurrent(ref),
    availableNotConsentedExtensions: sourceExtensionsForKind(ref.kind)
      .filter(extension => !effectiveConsentGrant(ref).extensions.includes(extension)),
    ...(ref.activeIndexCoverage ? {activeIndexCoverage: ref.activeIndexCoverage} : {}),
    ...(ref.pendingGeneration ? {pendingGeneration: ref.pendingGeneration} : {}),
    ...(ref.maintenanceWarning ? {maintenanceWarning: ref.maintenanceWarning} : {}),
    ...(ref.reindexRequired ? {reindexRequired: ref.reindexRequired} : {}),
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
  filesystemRef = filesystemRef ? normalizeCodebaseRef(filesystemRef) : undefined;
  databaseRef = databaseRef ? normalizeCodebaseRef(databaseRef) : undefined;
  if (!filesystemRef || !sameScope(filesystemRef, scope)) return undefined;
  if (!databaseRef || !sameScope(databaseRef, scope)) return filesystemRef;
  if (databaseRef.lifecycleState === 'deleting') return databaseRef;
  let effective = filesystemRef;
  if (filesystemRef.consent.sendToProvider && !databaseRef.consent.sendToProvider) {
    effective = {...effective, consent: databaseRef.consent};
  }
  const grantMismatch = JSON.stringify(effectiveConsentGrant(filesystemRef)) !==
    JSON.stringify(effectiveConsentGrant(databaseRef));
  if (grantMismatch) {
    effective = {
      ...effective,
      consent: {
        ...effective.consent,
        sendToProvider: false,
      },
      pendingGeneration: undefined,
    };
  }
  if (
    (filesystemRef.selectionPolicyRevision ?? 1) !== (databaseRef.selectionPolicyRevision ?? 1) ||
    filesystemRef.activeGeneration !== databaseRef.activeGeneration ||
    filesystemRef.contentFingerprint !== databaseRef.contentFingerprint
  ) {
    effective = {
      ...effective,
      activeGeneration: undefined,
      activeIndexState: 'none',
      contentFingerprint: undefined,
      chunkCount: 0,
    };
  }
  return effective;
}

export function activeCodebaseGeneration(
  ref: Pick<CodebaseRef, 'activeGeneration' | 'activeIndexState'>,
): string | undefined {
  return ref.activeIndexState === 'active' ? ref.activeGeneration : undefined;
}

export function codebaseHasActiveIndex(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'activeGeneration' | 'activeIndexState' | 'contentFingerprint' | 'chunkCount'>,
): boolean {
  return (ref.lifecycleState ?? 'active') === 'active' &&
    ref.activeIndexState === 'active' &&
    Boolean(ref.activeGeneration && ref.contentFingerprint && (ref.chunkCount ?? 0) > 0);
}

export function codebaseRootAvailable(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'rootRealpath'>,
): boolean {
  if ((ref.lifecycleState ?? 'active') !== 'active') return false;
  try {
    const current = fs.realpathSync(ref.rootRealpath);
    const normalize = (value: string): string => process.platform === 'win32'
      ? path.resolve(value).toLocaleLowerCase('en-US')
      : path.resolve(value);
    return normalize(current) === normalize(ref.rootRealpath);
  } catch {
    return false;
  }
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
      if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || !Array.isArray(parsed.codebases)) return;
      for (const ref of parsed.codebases) {
        this.codebases.set(ref.codebaseId, normalizeCodebaseRef(ref));
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
    const selection = buildSourceSelectionIR({
      kind: input.kind,
      includePrefixes: input.pathFilters,
      excludeGlobs: input.excludeGlobs,
    });
    const pathFilters = selection.includePrefixes.length > 0
      ? selection.includePrefixes
      : undefined;
    const excludeGlobs = selection.excludeGlobs.length > 0
      ? selection.excludeGlobs
      : undefined;
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
      ...(pathFilters ? {pathFilters} : {}),
      ...(excludeGlobs ? {excludeGlobs} : {}),
      selectionPolicyRevision: 1,
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
        grant: {
          revision: 1,
          grantedAt: now,
          grantedBy: input.consentedBy ?? input.userId ?? 'local-user',
          extensions: [...sourceExtensionsForKind(input.kind)],
          includePrefixes: [...selection.includePrefixes],
          excludeGlobs: [...selection.excludeGlobs],
        },
      },
      indexGeneration: 1,
      activeIndexState: 'none',
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
      return ref && sameScope(ref, scope) ? normalizeCodebaseRef(ref) : undefined;
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
        refsById.set(row.record.codebaseId, normalizeCodebaseRef(row.record));
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
      const previousGrant = effectiveConsentGrant(existing);
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
          grant: {
            ...previousGrant,
            revision: previousGrant.revision + 1,
            grantedAt: consentedAt,
            grantedBy: actor,
          },
        },
        pendingGeneration: undefined,
        updatedAt: consentedAt,
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  updateSelectionPolicy(
    codebaseId: string,
    scope: CodebaseScope,
    patch: {pathFilters?: string[]; excludeGlobs?: string[]},
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      const requestedPathFilters = patch.pathFilters === undefined
        ? existing.pathFilters
        : patch.pathFilters;
      const requestedExcludeGlobs = patch.excludeGlobs === undefined
        ? existing.excludeGlobs
        : patch.excludeGlobs;
      const selection = buildSourceSelectionIR({
        kind: existing.kind,
        includePrefixes: requestedPathFilters,
        excludeGlobs: requestedExcludeGlobs,
      });
      const pathFilters = selection.includePrefixes.length > 0
        ? selection.includePrefixes
        : undefined;
      const excludeGlobs = selection.excludeGlobs.length > 0
        ? selection.excludeGlobs
        : undefined;
      if (existing.kind === 'kernel_source' && !pathFilters?.length) {
        throw new Error('kernel_source requires pathFilters');
      }
      if (
        listsEqual(existing.pathFilters, pathFilters) &&
        listsEqual(existing.excludeGlobs, excludeGlobs)
      ) return existing;
      return {
        ...existing,
        pathFilters,
        excludeGlobs,
        selectionPolicyRevision: (existing.selectionPolicyRevision ?? 1) + 1,
        indexGeneration: existing.indexGeneration + 1,
        activeIndexState: 'none',
        activeGeneration: undefined,
        activeIndexCoverage: undefined,
        contentFingerprint: undefined,
        chunkCount: 0,
        pendingGeneration: undefined,
        reindexRequired: 'selection_scope_changed',
        updatedAt: Date.now(),
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  authorizeAvailableExtensions(
    codebaseId: string,
    scope: CodebaseScope,
    actor: string,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      if (!existing.consent.sendToProvider) throw new Error('provider_send_consent_required');
      const now = Date.now();
      const grant = effectiveConsentGrant(existing);
      const extensions = [...sourceExtensionsForKind(existing.kind)];
      const scopeExpanded = extensions.some(extension => !grant.extensions.includes(extension));
      return {
        ...existing,
        consent: {
          ...existing.consent,
          consentedAt: now,
          consentedBy: actor,
          grant: {
            ...grant,
            revision: grant.revision + 1,
            grantedAt: now,
            grantedBy: actor,
            extensions,
          },
        },
        pendingGeneration: undefined,
        reindexRequired: scopeExpanded && activeCodebaseGeneration(existing)
          ? 'provider_language_scope_expanded'
          : existing.reindexRequired,
        updatedAt: now,
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  authorizeCurrentSelection(
    codebaseId: string,
    scope: CodebaseScope,
    actor: string,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      if (!existing.consent.sendToProvider) throw new Error('provider_send_consent_required');
      const now = Date.now();
      const grant = effectiveConsentGrant(existing);
      const selection = buildSourceSelectionIR({
        kind: existing.kind,
        includePrefixes: existing.pathFilters,
        excludeGlobs: existing.excludeGlobs,
      });
      if (
        listsEqual(grant.includePrefixes, selection.includePrefixes) &&
        listsEqual(grant.excludeGlobs, selection.excludeGlobs)
      ) return existing;
      return {
        ...existing,
        consent: {
          ...existing.consent,
          consentedAt: now,
          consentedBy: actor,
          grant: {
            ...grant,
            revision: grant.revision + 1,
            grantedAt: now,
            grantedBy: actor,
            includePrefixes: [...selection.includePrefixes],
            excludeGlobs: [...selection.excludeGlobs],
          },
        },
        pendingGeneration: undefined,
        updatedAt: now,
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  setPendingGeneration(
    codebaseId: string,
    scope: CodebaseScope,
    expectedCurrentGeneration: number,
    pending: PendingCodebaseGeneration,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      if (existing.indexGeneration !== expectedCurrentGeneration) {
        throw new Error('codebase_index_generation_changed');
      }
      if (pending.coverage.selectionPolicyRevision !== (existing.selectionPolicyRevision ?? 1)) {
        throw new Error('pending_generation_stale');
      }
      return {
        ...existing,
        pendingGeneration: pending,
        lastAttemptCoverage: pending.coverage,
        updatedAt: Date.now(),
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  acceptPendingGeneration(
    codebaseId: string,
    scope: CodebaseScope,
    expectedSelectionPolicyRevision: number,
    expectedGrantRevision: number,
    expectedCandidateGenerationId: string,
    now = Date.now(),
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      const pending = existing.pendingGeneration;
      if (!pending) throw new Error('pending_generation_not_found');
      if (
        pending.candidateGenerationId !== expectedCandidateGenerationId ||
        (existing.selectionPolicyRevision ?? 1) !== expectedSelectionPolicyRevision ||
        effectiveConsentGrant(existing).revision !== expectedGrantRevision ||
        pending.coverage.selectionPolicyRevision !== expectedSelectionPolicyRevision
      ) throw new Error('pending_generation_stale');
      if (now - pending.createdAt >= PENDING_GENERATION_TTL_MS) {
        throw new Error('pending_generation_expired');
      }
      return {
        ...existing,
        activeIndexState: 'active',
        activeGeneration: pending.candidateGenerationId,
        activeIndexCoverage: pending.coverage,
        contentFingerprint: pending.contentFingerprint,
        chunkCount: pending.chunkCount,
        indexedRevision: pending.indexedRevision,
        indexedDirty: pending.indexedDirty,
        commitProvenance: pending.commitProvenance,
        indexGeneration: existing.indexGeneration + 1,
        pendingGeneration: undefined,
        reindexRequired: undefined,
        lastIngestStatus: 'ok',
        updatedAt: now,
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  rejectPendingGeneration(
    codebaseId: string,
    scope: CodebaseScope,
    expectedCandidateGenerationId: string,
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (existing.lifecycleState === 'deleting') throw new Error('codebase_deleting');
      if (!existing.pendingGeneration) throw new Error('pending_generation_not_found');
      if (existing.pendingGeneration.candidateGenerationId !== expectedCandidateGenerationId) {
        throw new Error('pending_generation_stale');
      }
      return {
        ...existing,
        pendingGeneration: undefined,
        updatedAt: Date.now(),
      };
    });
    if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
    return updated;
  }

  expirePendingGeneration(
    codebaseId: string,
    scope: CodebaseScope,
    expectedCandidateGenerationId: string,
    now = Date.now(),
  ): CodebaseRef {
    const updated = this.mutate(codebaseId, scope, existing => {
      if (
        !existing.pendingGeneration ||
        existing.pendingGeneration.candidateGenerationId !== expectedCandidateGenerationId ||
        now - existing.pendingGeneration.createdAt < PENDING_GENERATION_TTL_MS
      ) return existing;
      return {
        ...existing,
        pendingGeneration: undefined,
        maintenanceWarning: 'pending_generation_expired',
        updatedAt: now,
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
        activeIndexState: patch.activeGeneration ? 'active' : existing.activeIndexState,
        ...(patch.activeGeneration ? {pendingGeneration: undefined} : {}),
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
          let lastDurableCheckAt = 0;
          const assertHeld = (forceDurableCheck = false): void => {
            const now = Date.now();
            if (!forceDurableCheck && now - lastDurableCheckAt < INGEST_LEASE_HEARTBEAT_MS) {
              return;
            }
            try {
              filesystemLease.assertHeld();
              lastDurableCheckAt = now;
            } catch {
              throw new Error('codebase_reindex_lease_lost');
            }
          };
          const lease: CodebaseIngestLeaseGuard = {
            operationId: ownerToken,
            assertHeld,
            updateIngestStatus: patch => {
              assertHeld(true);
              this.updateIngestStatus(codebaseId, patch, scope);
              const updated = this.get(codebaseId, scope);
              if (!updated) throw new Error(`Codebase '${codebaseId}' not found`);
              return updated;
            },
            activateIndexGeneration: (expectedCurrentGeneration, patch) => {
              assertHeld(true);
              return this.activateIndexGeneration(
                codebaseId,
                scope,
                expectedCurrentGeneration,
                patch,
              );
            },
            beginDeletion: actor => {
              assertHeld(true);
              return this.beginDeletionWithLease(
                codebaseId,
                scope,
                ownerToken,
                false,
                actor,
              );
            },
            deleteRegistration: () => {
              assertHeld(true);
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

    let lastDurableCheckAt = 0;
    const lease: CodebaseIngestLeaseGuard = {
      operationId: ownerToken,
      assertHeld: (forceDurableCheck = false) => {
        if (useDistributedLease) {
          const startedAt = Date.now();
          if (
            !forceDurableCheck &&
            startedAt - lastDurableCheckAt < INGEST_LEASE_HEARTBEAT_MS
          ) return;
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
          lastDurableCheckAt = startedAt;
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
              activeIndexState: patch.activeGeneration ? 'active' : existing.activeIndexState,
              ...(patch.activeGeneration ? {pendingGeneration: undefined} : {}),
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
      activeIndexState: 'none',
      pendingGeneration: undefined,
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
          return mutate(normalizeCodebaseRef(existing));
        },
        {rowScope: REGISTRY_ROW_SCOPE},
      );
    } else {
      const existing = this.get(codebaseId, scope);
      if (!existing) return undefined;
      updated = mutate(normalizeCodebaseRef(existing));
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
      schemaVersion: 2,
      codebases: Array.from(this.codebases.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.registryPath);
  }
}
