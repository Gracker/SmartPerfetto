// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  activeCodebaseGeneration,
  codebaseProviderGrantScopeCurrent,
  codebaseRegistrationRequirements,
  codebaseRootAvailable,
  PENDING_GENERATION_TTL_MS,
  type CodebaseKind,
  type CodebaseRef,
  type CodebaseRefSummary,
  type CodebaseScope,
  type IndexCoverage,
} from './codebaseRegistry';
import {CodebaseRegistry} from './codebaseRegistry';
import {PathSecurityGate} from './pathSecurityGate';
import {SourceEnumerator, type EnumerationResult} from './sourceEnumerator';
import {buildSourceSelectionIR} from './sourceSelectionPolicy';
import {availableNotConsentedExtensions} from './sourceDisclosure';
import {
  readAospManifestProjects,
  type AospManifestProject,
} from './aospManifest';
import {RagStore} from '../ragStore';
import {resolveSourcePathPatterns} from '../rag/sourceFileSelection';

export type CodebaseManagementErrorCode =
  | 'CODEBASE_AUDIT_FAILED'
  | 'CODEBASE_BUSY'
  | 'CODEBASE_CONSENT_REQUIRED'
  | 'CODEBASE_DELETE_FAILED'
  | 'CODEBASE_DELETE_INCOMPLETE'
  | 'CODEBASE_DELETING'
  | 'CODEBASE_NOT_FOUND'
  | 'CODEBASE_OPERATION_FAILED'
  | 'CODEBASE_PREVIEW_FAILED'
  | 'CODEBASE_ROOT_DRIFT'
  | 'CODEBASE_SELECTION_EMPTY'
  | 'CODEBASE_SELECTION_INVALID'
  | 'CODEBASE_SELECTION_UNCHANGED'
  | 'PENDING_GENERATION_EXPIRED'
  | 'PENDING_GENERATION_NOT_FOUND'
  | 'PENDING_GENERATION_STALE';

export class CodebaseManagementError extends Error {
  constructor(
    public readonly code: CodebaseManagementErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = 'CodebaseManagementError';
  }
}

export interface PreviewCodebaseInput {
  rootPath: string;
  kind: CodebaseKind;
  pathFilters?: unknown;
  excludeGlobs?: unknown;
  additionalAllowlistRoots?: string[];
}

export interface SourceSelectionInput {
  pathFilters?: unknown;
  excludeGlobs?: unknown;
}

export interface PendingAcceptanceExpectation {
  selectionPolicyRevision: number;
  grantRevision: number;
}

export interface CodebasePreview {
  blocked: boolean;
  blockedReason?: string;
  complete?: boolean;
  enumerationComplete?: boolean;
  truncationReason?: string;
  acceptedFileCount: number;
  filesEnumerated?: number;
  filesSelected?: number;
  bytesSelected?: number;
  skippedFileCount: number;
  acceptedFiles: EnumerationResult['files'];
  skippedFiles: EnumerationResult['skipped'];
  enumerationBackend?: EnumerationResult['backend'];
  backendFidelity?: EnumerationResult['fidelity'];
  deterministic?: boolean;
  recommendedAction?: 'narrow_scope';
  scopeSuggestions?: Array<{prefix: string; fileCount: number}>;
  manifestProjects?: AospManifestProject[];
  manifestGroups?: string[];
  manifestUnavailableReason?: string;
}

export type RegisteredCodebase = Omit<
  CodebaseRef,
  'rootPath' | 'rootRealpath' | 'rootAuthorization' | 'consent' | 'lastIngestError'
> & {
  grantRevision: number;
  rootAvailable: boolean;
  eligibleForSendToProvider: boolean;
  consent: {
    sendToProvider: boolean;
    consentedAt: number;
    consentedBy: string;
    consentHash: string;
    grantRevision: number;
  };
  availableNotConsentedExtensions: string[];
  providerGrantScopeCurrent: boolean;
  lastIngestError?: string;
};

export type CodebaseListItem = Omit<CodebaseRefSummary, 'rootAuthorization' | 'lastIngestError'> & {
  lastIngestError?: string;
};

export interface CodebaseAudit {
  codebaseId: string;
  kind: CodebaseKind;
  indexGeneration: number;
  activeGeneration?: string;
  activeIndexState: 'active' | 'none';
  selectionPolicyRevision: number;
  grantRevision: number;
  activeIndexCoverage?: IndexCoverage;
  pendingGeneration?: CodebaseRef['pendingGeneration'];
  maintenanceWarning?: CodebaseRef['maintenanceWarning'];
  reindexRequired?: CodebaseRef['reindexRequired'];
  contentFingerprint?: string;
  indexedRevision?: string;
  indexedDirty?: boolean;
  commitProvenance?: CodebaseRef['commitProvenance'];
  lastIngestAt?: number;
  lastIngestStatus?: CodebaseRef['lastIngestStatus'];
  lastIngestError?: string;
  chunkCount: number;
  blockedFileCount: number;
  redactionHitCount: number;
}

export interface CodebaseDeleteResult {
  codebaseId: string;
  removedChunkCount: number;
  alreadyDeleted?: true;
}

export interface CodebaseManagementDependencies {
  registry: CodebaseRegistry;
  store: RagStore;
  gate: PathSecurityGate;
  sourceEnumerator?: CodebaseSourceEnumerator;
  readAospManifestProjects?: typeof readAospManifestProjects;
  now?: () => number;
}

export type CodebaseSourceEnumerator = Pick<SourceEnumerator, 'enumerate'>;

const SAFE_OPERATIONAL_DIAGNOSTICS = new Set([
  'codebase_deleting',
  'codebase_index_generation_changed',
  'codebase_reindex_in_progress',
  'codebase_reindex_lease_lost',
  'codebase_root_realpath_drift',
  'enumeration_budget',
  'pending_generation_expired',
  'root_not_found',
  'root_outside_allowlist',
  'source_enumeration_incomplete',
  'source_generation_empty',
  'source_selection_empty',
  'time_budget',
  'traversal_error',
]);

const SAFE_OPERATIONAL_PREFIX_CATEGORIES = [
  ['codebase_reindex_incomplete:', 'codebase_reindex_incomplete'],
  ['inactive_chunk_cleanup_failed:', 'inactive_chunk_cleanup_failed'],
  ['source_chunk_limit_exceeded:', 'source_chunk_limit_exceeded'],
  ['staged_chunk_count_mismatch:', 'staged_chunk_count_mismatch'],
] as const;

function safeOperationalDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (SAFE_OPERATIONAL_DIAGNOSTICS.has(value)) return value;
  for (const [prefix, category] of SAFE_OPERATIONAL_PREFIX_CATEGORIES) {
    if (value.startsWith(prefix)) return category;
  }
  return 'codebase_operation_failed';
}

export function projectRegisteredCodebase(ref: CodebaseRef): RegisteredCodebase {
  const {
    rootPath: _rootPath,
    rootRealpath: _rootRealpath,
    rootAuthorization: _rootAuthorization,
    consent,
    lastIngestError,
    ...rest
  } = ref;
  const safeError = safeOperationalDiagnostic(lastIngestError);
  return {
    ...rest,
    ...(safeError ? {lastIngestError: safeError} : {}),
    grantRevision: consent.grant?.revision ?? 1,
    rootAvailable: codebaseRootAvailable(ref),
    eligibleForSendToProvider: consent.sendToProvider,
    consent: {
      sendToProvider: consent.sendToProvider,
      consentedAt: consent.consentedAt,
      consentedBy: consent.consentedBy,
      consentHash: consent.consentHash,
      grantRevision: consent.grant?.revision ?? 1,
    },
    availableNotConsentedExtensions: availableNotConsentedExtensions(ref),
    providerGrantScopeCurrent: codebaseProviderGrantScopeCurrent(ref),
  };
}

function projectListItem(summary: CodebaseRefSummary): CodebaseListItem {
  const {
    rootAuthorization: _rootAuthorization,
    lastIngestError,
    ...safeSummary
  } = summary;
  const safeError = safeOperationalDiagnostic(lastIngestError);
  return {
    ...safeSummary,
    ...(safeError ? {lastIngestError: safeError} : {}),
  };
}

export function projectCodebaseEnumeration(result: EnumerationResult): CodebasePreview {
  const subtreeCounts = new Map<string, number>();
  for (const file of result.files) {
    const parts = file.relativePath.split('/');
    const prefix = parts.slice(0, Math.min(2, Math.max(1, parts.length - 1))).join('/');
    subtreeCounts.set(prefix, (subtreeCounts.get(prefix) ?? 0) + 1);
  }
  return {
    blocked: false,
    complete: result.enumerationComplete,
    enumerationComplete: result.enumerationComplete,
    ...(result.incompleteReason ? {truncationReason: result.incompleteReason} : {}),
    acceptedFileCount: result.files.length,
    filesEnumerated: result.files.length,
    filesSelected: result.files.length,
    bytesSelected: result.files.reduce((total, file) => total + file.sizeBytes, 0),
    skippedFileCount: result.skippedCount,
    acceptedFiles: result.files.slice(0, 200),
    skippedFiles: result.skipped.slice(0, 200),
    enumerationBackend: result.backend,
    backendFidelity: result.fidelity,
    deterministic: result.deterministic,
    ...(result.incompleteReason === 'time_budget' ? {recommendedAction: 'narrow_scope'} : {}),
    scopeSuggestions: [...subtreeCounts.entries()]
      .map(([prefix, fileCount]) => ({prefix, fileCount}))
      .sort((left, right) => right.fileCount - left.fileCount || left.prefix.localeCompare(right.prefix))
      .slice(0, 12),
  };
}

function blockedPreview(reason: 'root_not_found' | 'root_outside_allowlist'): CodebasePreview {
  return {
    blocked: true,
    blockedReason: reason,
    acceptedFileCount: 0,
    skippedFileCount: 0,
    acceptedFiles: [],
    skippedFiles: [],
  };
}

export class CodebaseManagementService {
  private readonly registry: CodebaseRegistry;
  private readonly store: RagStore;
  private readonly gate: PathSecurityGate;
  private readonly sourceEnumerator: CodebaseSourceEnumerator;
  private readonly manifestReader: typeof readAospManifestProjects;
  private readonly now: () => number;

  constructor(dependencies: CodebaseManagementDependencies) {
    this.registry = dependencies.registry;
    this.store = dependencies.store;
    this.gate = dependencies.gate;
    this.sourceEnumerator = dependencies.sourceEnumerator ?? new SourceEnumerator();
    this.manifestReader = dependencies.readAospManifestProjects ?? readAospManifestProjects;
    this.now = dependencies.now ?? Date.now;
  }

  async preview(input: PreviewCodebaseInput, scope: CodebaseScope): Promise<CodebasePreview> {
    void scope;
    let rootRealpath: string;
    try {
      rootRealpath = await this.gate.validateRoot(
        input.rootPath,
        input.additionalAllowlistRoots?.length
          ? {additionalAllowlistRoots: input.additionalAllowlistRoots}
          : undefined,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === 'root_not_found' || reason === 'root_outside_allowlist') {
        return blockedPreview(reason);
      }
      throw this.toError(error, input.rootPath, 'preview');
    }

    try {
      const result = await this.sourceEnumerator.enumerate({
        rootRealpath,
        policy: buildSourceSelectionIR({
          kind: input.kind,
          includePrefixes: resolveSourcePathPatterns(input.pathFilters, 'pathFilters'),
          excludeGlobs: resolveSourcePathPatterns(input.excludeGlobs, 'excludeGlobs'),
        }),
        gate: this.gate,
        expectedRootRealpath: rootRealpath,
        ...(input.additionalAllowlistRoots?.length
          ? {additionalAllowlistRoots: input.additionalAllowlistRoots}
          : {}),
      });
      const preview = projectCodebaseEnumeration(result);
      if (input.kind !== 'aosp' && input.kind !== 'oem_sdk') return preview;

      try {
        const manifestProjects = await this.manifestReader(rootRealpath, rootRealpath);
        if (manifestProjects.length === 0) return preview;
        return {
          ...preview,
          manifestProjects,
          manifestGroups: [...new Set(manifestProjects.flatMap(project => project.groups))].sort(),
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === 'codebase_root_realpath_drift') {
          throw new CodebaseManagementError(
            'CODEBASE_ROOT_DRIFT',
            400,
            'codebase_root_realpath_drift',
          );
        }
        return {...preview, manifestUnavailableReason: this.safeMetadataReason(reason)};
      }
    } catch (error) {
      throw this.toError(error, input.rootPath, 'preview');
    }
  }

  async list(scope: CodebaseScope): Promise<CodebaseListItem[]> {
    const now = this.now();
    for (const summary of this.registry.list(scope)) {
      if (summary.maintenanceWarning === 'inactive_chunk_cleanup_failed') {
        await this.cleanupInactiveCodebaseChunks(summary.codebaseId, scope);
      }
      const pending = summary.pendingGeneration;
      if (!pending || now - pending.createdAt < PENDING_GENERATION_TTL_MS) continue;
      this.registry.expirePendingGeneration(
        summary.codebaseId,
        scope,
        pending.candidateGenerationId,
        now,
      );
      await this.cleanupInactiveCodebaseChunks(summary.codebaseId, scope);
    }
    return this.registry.list(scope).map(projectListItem);
  }

  get(id: string, scope: CodebaseScope): RegisteredCodebase {
    return projectRegisteredCodebase(this.requireCodebase(id, scope));
  }

  async updateSelection(
    id: string,
    input: SourceSelectionInput,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    try {
      const hasPathFilters = Object.prototype.hasOwnProperty.call(input, 'pathFilters');
      const hasExcludeGlobs = Object.prototype.hasOwnProperty.call(input, 'excludeGlobs');
      if (!hasPathFilters && !hasExcludeGlobs) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_EMPTY',
          400,
          'selection_patch_empty',
        );
      }
      const existing = this.requireCodebase(id, scope);
      const pathFilters = hasPathFilters
        ? resolveSourcePathPatterns(input.pathFilters, 'pathFilters')
        : existing.pathFilters;
      const excludeGlobs = hasExcludeGlobs
        ? resolveSourcePathPatterns(input.excludeGlobs, 'excludeGlobs')
        : existing.excludeGlobs;
      const canonicalSelection = buildSourceSelectionIR({
        kind: existing.kind,
        includePrefixes: pathFilters,
        excludeGlobs,
      });
      const canonicalPathFilters = canonicalSelection.includePrefixes.length > 0
        ? canonicalSelection.includePrefixes
        : undefined;
      const canonicalExcludeGlobs = canonicalSelection.excludeGlobs.length > 0
        ? canonicalSelection.excludeGlobs
        : undefined;
      if (
        codebaseRegistrationRequirements(existing.kind).pathFilters &&
        !canonicalPathFilters?.length
      ) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_INVALID',
          400,
          '`pathFilters` is required for kernel_source codebases',
        );
      }
      const codebase = this.registry.updateSelectionPolicy(id, scope, {
        ...(hasPathFilters ? {pathFilters: canonicalPathFilters} : {}),
        ...(hasExcludeGlobs ? {excludeGlobs: canonicalExcludeGlobs} : {}),
      });
      if (codebase.selectionPolicyRevision === existing.selectionPolicyRevision) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_UNCHANGED',
          400,
          'selection_policy_unchanged',
        );
      }
      return projectRegisteredCodebase(
        await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase,
      );
    } catch (error) {
      throw this.toError(error, id, 'selection');
    }
  }

  async setConsent(
    id: string,
    enabled: boolean,
    actor: string,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    return this.runManagedMutation(id, scope, () =>
      this.registry.setProviderConsent(id, scope, enabled, actor));
  }

  async authorizeAvailableExtensions(
    id: string,
    actor: string,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    return this.runManagedMutation(id, scope, () =>
      this.registry.authorizeAvailableExtensions(id, scope, actor));
  }

  async authorizeCurrentSelection(
    id: string,
    actor: string,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    return this.runManagedMutation(id, scope, () =>
      this.registry.authorizeCurrentSelection(id, scope, actor));
  }

  async acceptPending(
    id: string,
    candidateId: string,
    scope: CodebaseScope,
    expected?: PendingAcceptanceExpectation,
  ): Promise<RegisteredCodebase> {
    try {
      const existing = this.requireCodebase(id, scope);
      const expectation = expected ?? {
        selectionPolicyRevision: existing.selectionPolicyRevision ?? 1,
        grantRevision: existing.consent.grant?.revision ?? 1,
      };
      const codebase = this.registry.acceptPendingGeneration(
        id,
        scope,
        expectation.selectionPolicyRevision,
        expectation.grantRevision,
        candidateId,
        this.now(),
      );
      return projectRegisteredCodebase(
        await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'pending_generation_expired') {
        try {
          this.registry.expirePendingGeneration(id, scope, candidateId, this.now());
          await this.cleanupInactiveCodebaseChunks(id, scope);
        } catch {
          // Preserve the original CAS error even if best-effort expiry cleanup fails.
        }
      }
      throw this.toError(error, id, 'pending');
    }
  }

  async rejectPending(
    id: string,
    candidateId: string,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    return this.runManagedMutation(id, scope, () =>
      this.registry.rejectPendingGeneration(id, scope, candidateId));
  }

  audit(id: string, scope: CodebaseScope): CodebaseAudit {
    try {
      const ref = this.requireCodebase(id, scope);
      const lastIngestError = safeOperationalDiagnostic(ref.lastIngestError);
      return {
        codebaseId: ref.codebaseId,
        kind: ref.kind,
        indexGeneration: ref.indexGeneration,
        ...(activeCodebaseGeneration(ref) ? {activeGeneration: activeCodebaseGeneration(ref)} : {}),
        activeIndexState: ref.activeIndexState ?? 'none',
        selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
        grantRevision: ref.consent.grant?.revision ?? 1,
        ...(ref.activeIndexCoverage ? {activeIndexCoverage: ref.activeIndexCoverage} : {}),
        ...(ref.pendingGeneration ? {pendingGeneration: ref.pendingGeneration} : {}),
        ...(ref.maintenanceWarning ? {maintenanceWarning: ref.maintenanceWarning} : {}),
        ...(ref.reindexRequired ? {reindexRequired: ref.reindexRequired} : {}),
        ...(ref.contentFingerprint ? {contentFingerprint: ref.contentFingerprint} : {}),
        ...(ref.indexedRevision ? {indexedRevision: ref.indexedRevision} : {}),
        ...(ref.indexedDirty !== undefined ? {indexedDirty: ref.indexedDirty} : {}),
        ...(ref.commitProvenance ? {commitProvenance: ref.commitProvenance} : {}),
        ...(ref.lastIngestAt !== undefined ? {lastIngestAt: ref.lastIngestAt} : {}),
        ...(ref.lastIngestStatus ? {lastIngestStatus: ref.lastIngestStatus} : {}),
        ...(lastIngestError ? {lastIngestError} : {}),
        chunkCount: ref.chunkCount ?? 0,
        blockedFileCount: ref.blockedFileCount ?? 0,
        redactionHitCount: ref.redactionHitCount ?? 0,
      };
    } catch (error) {
      throw this.toError(error, id, 'audit');
    }
  }

  async delete(id: string, scope: CodebaseScope): Promise<CodebaseDeleteResult> {
    if (!this.registry.get(id, scope)) {
      return {codebaseId: id, removedChunkCount: 0, alreadyDeleted: true};
    }
    let deletionStarted = false;
    try {
      return await this.registry.withIngestLease(id, scope, lease => {
        lease.beginDeletion(scope.userId ?? 'codebase-manager');
        deletionStarted = true;
        const removedChunkCount = this.store.removeCodebaseChunks(id, scope);
        lease.assertHeld();
        lease.deleteRegistration();
        return {codebaseId: id, removedChunkCount};
      }, 'delete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === 'codebase_reindex_in_progress' ||
        message === 'codebase_reindex_lease_lost'
      ) {
        throw new CodebaseManagementError(
          'CODEBASE_BUSY',
          409,
          'Codebase indexing is in progress; retry deletion after it finishes',
        );
      }
      if (message.includes('not found')) {
        return {codebaseId: id, removedChunkCount: 0, alreadyDeleted: true};
      }
      throw new CodebaseManagementError(
        deletionStarted ? 'CODEBASE_DELETE_INCOMPLETE' : 'CODEBASE_DELETE_FAILED',
        500,
        deletionStarted
          ? 'Codebase is retired from retrieval; retry deletion to finish physical cleanup'
          : 'Codebase deletion failed',
      );
    }
  }

  private async runManagedMutation(
    id: string,
    scope: CodebaseScope,
    operation: () => CodebaseRef,
  ): Promise<RegisteredCodebase> {
    try {
      const codebase = operation();
      return projectRegisteredCodebase(
        await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase,
      );
    } catch (error) {
      throw this.toError(error, id, 'mutation');
    }
  }

  private requireCodebase(id: string, scope: CodebaseScope): CodebaseRef {
    const ref = this.registry.get(id, scope);
    if (!ref) {
      throw new CodebaseManagementError(
        'CODEBASE_NOT_FOUND',
        404,
        `Codebase '${id}' not found`,
      );
    }
    return ref;
  }

  private async cleanupInactiveCodebaseChunks(
    id: string,
    scope: CodebaseScope,
  ): Promise<CodebaseRef | undefined> {
    if (!this.registry.get(id, scope)) return undefined;
    try {
      await this.registry.withIngestLease(id, scope, lease => {
        lease.assertHeld(true);
        const current = this.registry.get(id, scope);
        if (!current) return;
        const preserved = [
          activeCodebaseGeneration(current),
          current.pendingGeneration?.candidateGenerationId,
        ].filter((generation): generation is string => Boolean(generation));
        this.store.removeCodebaseChunksExceptGeneration(id, preserved, scope);
        lease.assertHeld(true);
        if (current.maintenanceWarning === 'inactive_chunk_cleanup_failed') {
          lease.updateIngestStatus({
            lastIngestStatus: current.lastIngestStatus ?? 'ok',
            maintenanceWarning: undefined,
            lastIngestError: current.lastIngestError?.startsWith('inactive_chunk_cleanup_failed:')
              ? undefined
              : current.lastIngestError,
          });
        }
      });
    } catch (error) {
      try {
        const current = this.registry.get(id, scope);
        if (!current) return undefined;
        this.registry.updateIngestStatus(id, {
          lastIngestStatus: current.lastIngestStatus ?? 'ok',
          maintenanceWarning: 'inactive_chunk_cleanup_failed',
          lastIngestError: `inactive_chunk_cleanup_failed:${error instanceof Error ? error.message : String(error)}`,
        }, scope);
      } catch {
        // Keep the original state readable even if warning persistence fails.
      }
    }
    return this.registry.get(id, scope);
  }

  private safeMetadataReason(reason: string): string {
    if (/^[a-z0-9_]{1,128}$/.test(reason)) return reason;
    return 'aosp_manifest_discovery_failed';
  }

  private toError(
    error: unknown,
    id: string,
    operation: 'audit' | 'mutation' | 'pending' | 'preview' | 'selection',
  ): CodebaseManagementError {
    if (error instanceof CodebaseManagementError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (operation !== 'preview' && message.includes('not found')) {
      return new CodebaseManagementError('CODEBASE_NOT_FOUND', 404, `Codebase '${id}' not found`);
    }
    if (message === 'codebase_deleting') {
      return new CodebaseManagementError('CODEBASE_DELETING', 409, message);
    }
    if (message === 'provider_send_consent_required') {
      return new CodebaseManagementError('CODEBASE_CONSENT_REQUIRED', 409, message);
    }
    if (message === 'selection_policy_unchanged') {
      return new CodebaseManagementError('CODEBASE_SELECTION_UNCHANGED', 400, message);
    }
    if (message === 'pending_generation_not_found') {
      return new CodebaseManagementError('PENDING_GENERATION_NOT_FOUND', 409, message);
    }
    if (message === 'pending_generation_stale') {
      return new CodebaseManagementError('PENDING_GENERATION_STALE', 409, message);
    }
    if (message === 'pending_generation_expired') {
      return new CodebaseManagementError('PENDING_GENERATION_EXPIRED', 409, message);
    }
    if (
      message === 'codebase_reindex_in_progress' ||
      message === 'codebase_reindex_lease_lost'
    ) {
      return new CodebaseManagementError('CODEBASE_BUSY', 409, message);
    }
    if (message === 'codebase_root_realpath_drift') {
      return new CodebaseManagementError('CODEBASE_ROOT_DRIFT', 400, message);
    }
    if (
      message.startsWith('`pathFilters`') ||
      message.startsWith('`excludeGlobs`') ||
      /^(?:pathFilters|excludeGlobs)(?:\[\d+\])? must /.test(message) ||
      message === 'kernel_source requires pathFilters'
    ) {
      return new CodebaseManagementError('CODEBASE_SELECTION_INVALID', 400, message);
    }
    if (operation === 'preview') {
      return new CodebaseManagementError(
        'CODEBASE_PREVIEW_FAILED',
        400,
        'Codebase preview failed',
      );
    }
    if (operation === 'audit') {
      return new CodebaseManagementError('CODEBASE_AUDIT_FAILED', 500, 'Codebase audit failed');
    }
    return new CodebaseManagementError(
      'CODEBASE_OPERATION_FAILED',
      500,
      'Codebase management operation failed',
    );
  }
}
