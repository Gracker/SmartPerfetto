// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  activeCodebaseGeneration,
  codebaseRegistrationRequirements,
  PENDING_GENERATION_TTL_MS,
  type CodebaseKind,
  summarizeCodebase,
  type CodebaseRef,
  type CodebaseRefSummary,
  type CodebaseScope,
  type IndexCoverage,
} from './codebaseRegistry';
import {CodebaseRegistry} from './codebaseRegistry';
import {
  channelAuthorizedRoots,
  codebaseProviderGrantScopeCurrent,
  evaluateCodebaseRoot,
  type CodebaseRootCapability,
  type CodebaseRootUnavailableReason,
} from './codebaseCapability';
import {PathSecurityGate} from './pathSecurityGate';
import {SourceEnumerator, type EnumerationResult} from './sourceEnumerator';
import {buildSourceSelectionIR, sourceSelectionForRef} from './sourceSelectionPolicy';
import {availableNotConsentedExtensions, contentDisclosureToken} from './sourceDisclosure';
import {
  readAospManifestProjects,
  type AospManifestProject,
} from './aospManifest';
import {RagStore} from '../ragStore';
import {resolveSourcePathPatterns} from '../rag/sourceFileSelection';
import {PublicRequestError} from '../../utils/publicRequestError';
import {
  CodebaseRequestError,
  type CodebaseRequestErrorCode,
  CodebaseStateError,
  type CodebaseStateReason,
  isCodebaseStateError,
} from './codebaseRequestError';

export type CodebaseManagementErrorCode =
  | 'CODEBASE_AUDIT_FAILED'
  | 'CODEBASE_BUSY'
  | 'CODEBASE_CONSENT_DISCLOSURE_STALE'
  | 'CODEBASE_CONSENT_REQUIRED'
  | 'CODEBASE_DELETE_FAILED'
  | 'CODEBASE_DELETE_INCOMPLETE'
  | 'CODEBASE_DELETING'
  | 'CODEBASE_OPERATION_FAILED'
  | 'CODEBASE_PREVIEW_FAILED'
  | 'CODEBASE_ROOT_DRIFT'
  | 'CODEBASE_SELECTION_EMPTY'
  | 'CODEBASE_SELECTION_EMPTY_MATCH'
  | 'CODEBASE_SELECTION_STALE'
  | 'CODEBASE_SELECTION_UNCHANGED'
  | 'PENDING_GENERATION_EXPIRED'
  | 'PENDING_GENERATION_NOT_FOUND'
  | 'PENDING_GENERATION_STALE'
  | CodebaseRequestErrorCode;

/** A codebase management failure with sanitized text: fixed for unknown causes (see toError). */
export class CodebaseManagementError extends PublicRequestError {
  declare readonly code: CodebaseManagementErrorCode;

  constructor(
    code: CodebaseManagementErrorCode,
    status: number,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(code, message, status, details);
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
  /** The revision the caller previewed; a save against a newer one is refused. */
  expectedSelectionPolicyRevision?: unknown;
}

/**
 * What a proposed selection of a registered codebase would admit, enumerated
 * exactly as indexing and on-demand access enumerate it. `complete` counts are
 * exact (a complete zero is a proven empty selection); `partial` counts are a
 * lower bound from a traversal that stopped early; `unavailable` enumerated
 * nothing. Paths are relative; the root is never returned.
 */
export interface CodebaseSelectionPreview {
  status: 'complete' | 'partial' | 'unavailable';
  selectionPolicyRevision: number;
  unavailableReason?: CodebaseRootUnavailableReason | 'enumeration_failed';
  preview?: CodebasePreview;
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
  /** Why the root cannot be read; absent when it can. */
  unavailableReason?: CodebaseRootUnavailableReason;
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
  /** What `authorizeContent` would grant now; pass it back to grant exactly that. */
  contentDisclosureToken: string;
  lastIngestError?: string;
};

export type CodebaseListItem = Omit<CodebaseRefSummary, 'rootAuthorization' | 'lastIngestError'> & {
  lastIngestError?: string;
  rootAvailable: boolean;
  unavailableReason?: CodebaseRootUnavailableReason;
  contentDisclosureToken: string;
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

/** The management answer to each codebase state; the message stays the reason token. */
const CODEBASE_STATE_ERRORS: Readonly<Record<CodebaseStateReason, {
  code: CodebaseManagementErrorCode;
  status: number;
}>> = {
  codebase_deleting: {code: 'CODEBASE_DELETING', status: 409},
  codebase_reindex_in_progress: {code: 'CODEBASE_BUSY', status: 409},
  codebase_reindex_lease_lost: {code: 'CODEBASE_BUSY', status: 409},
  codebase_root_realpath_drift: {code: 'CODEBASE_ROOT_DRIFT', status: 400},
  consent_disclosure_stale: {code: 'CODEBASE_CONSENT_DISCLOSURE_STALE', status: 409},
  pending_generation_expired: {code: 'PENDING_GENERATION_EXPIRED', status: 409},
  pending_generation_not_found: {code: 'PENDING_GENERATION_NOT_FOUND', status: 409},
  pending_generation_stale: {code: 'PENDING_GENERATION_STALE', status: 409},
  provider_send_consent_required: {code: 'CODEBASE_CONSENT_REQUIRED', status: 409},
  selection_policy_stale: {code: 'CODEBASE_SELECTION_STALE', status: 409},
};

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

const SAFE_MANIFEST_UNAVAILABLE_REASONS = new Set([
  'aosp_manifest_too_large',
  'aosp_manifest_discovery_failed',
  'aosp_manifest_outside_repo_metadata',
  'aosp_manifest_identity_changed',
  'source_metadata_time_budget',
  'source_metadata_not_regular_file',
  'source_metadata_too_large',
  'source_metadata_identity_changed',
]);

function safeOperationalDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (SAFE_OPERATIONAL_DIAGNOSTICS.has(value)) return value;
  for (const [prefix, category] of SAFE_OPERATIONAL_PREFIX_CATEGORIES) {
    if (value.startsWith(prefix)) return category;
  }
  return 'codebase_operation_failed';
}

function rootFields(root: CodebaseRootCapability): {rootAvailable: boolean; unavailableReason?: CodebaseRootUnavailableReason} {
  return root.available ? {rootAvailable: true} : {rootAvailable: false, unavailableReason: root.reason};
}

function projectRegisteredCodebase(
  ref: CodebaseRef,
  root: CodebaseRootCapability,
): RegisteredCodebase {
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
    ...rootFields(root),
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
    contentDisclosureToken: contentDisclosureToken(ref),
  };
}

function projectListItem(ref: CodebaseRef, root: CodebaseRootCapability): CodebaseListItem {
  const {
    rootAuthorization: _rootAuthorization,
    lastIngestError,
    ...safeSummary
  } = summarizeCodebase(ref);
  const safeError = safeOperationalDiagnostic(lastIngestError);
  return {
    ...safeSummary,
    ...(safeError ? {lastIngestError: safeError} : {}),
    ...rootFields(root),
    contentDisclosureToken: contentDisclosureToken(ref),
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

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The canonical selection an edit asks for; absent fields keep their current
 * value and an empty list clears one.
 */
function proposedSelection(
  existing: CodebaseRef,
  input: SourceSelectionInput,
): {pathFilters: string[]; excludeGlobs: string[]} {
  const canonical = buildSourceSelectionIR({
    kind: existing.kind,
    includePrefixes: Object.prototype.hasOwnProperty.call(input, 'pathFilters')
      ? resolveSourcePathPatterns(input.pathFilters, 'pathFilters')
      : existing.pathFilters,
    excludeGlobs: Object.prototype.hasOwnProperty.call(input, 'excludeGlobs')
      ? resolveSourcePathPatterns(input.excludeGlobs, 'excludeGlobs')
      : existing.excludeGlobs,
  });
  if (codebaseRegistrationRequirements(existing.kind).pathFilters && canonical.includePrefixes.length === 0) {
    throw new CodebaseManagementError(
      'CODEBASE_SELECTION_INVALID',
      400,
      '`pathFilters` is required for kernel_source codebases',
    );
  }
  return {pathFilters: canonical.includePrefixes, excludeGlobs: canonical.excludeGlobs};
}

/** An optional integer revision from a request body. */
function optionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new CodebaseManagementError(
      'CODEBASE_SELECTION_INVALID',
      400,
      '`expectedSelectionPolicyRevision` must be a positive integer',
    );
  }
  return value;
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
      throw this.toError(error, 'preview');
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
        if (isCodebaseStateError(error, 'codebase_root_realpath_drift')) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return {...preview, manifestUnavailableReason: this.safeMetadataReason(reason)};
      }
    } catch (error) {
      throw this.toError(error, 'preview');
    }
  }

  async list(scope: CodebaseScope): Promise<CodebaseListItem[]> {
    const now = this.now();
    for (const ref of this.registry.listRefs(scope)) {
      if (ref.maintenanceWarning === 'inactive_chunk_cleanup_failed') {
        await this.cleanupInactiveCodebaseChunks(ref.codebaseId, scope);
      }
      const pending = ref.pendingGeneration;
      if (!pending || now - pending.createdAt < PENDING_GENERATION_TTL_MS) continue;
      this.registry.expirePendingGeneration(
        ref.codebaseId,
        scope,
        pending.candidateGenerationId,
        now,
      );
      await this.cleanupInactiveCodebaseChunks(ref.codebaseId, scope);
    }
    return this.registry.listRefs(scope).map(ref => projectListItem(ref, this.evaluateRoot(ref)));
  }

  /**
   * The live root check under this service's allowlist, independent of
   * optional index state and provider consent (`evaluateCodebaseRoot`). A
   * codebase this scope cannot see reads as a missing root.
   */
  rootCapability(id: string, scope: CodebaseScope): CodebaseRootCapability {
    const ref = this.registry.get(id, scope);
    return ref ? this.evaluateRoot(ref) : {available: false, reason: 'root_missing'};
  }

  get(id: string, scope: CodebaseScope): RegisteredCodebase {
    return this.project(this.requireCodebase(id, scope));
  }

  /** A registration as management responses show it, with its root checked under this service's allowlist. */
  project(ref: CodebaseRef): RegisteredCodebase {
    return projectRegisteredCodebase(ref, this.evaluateRoot(ref));
  }

  /**
   * Enumerates a proposed selection of a registered codebase without saving
   * it. Fields absent from the input keep their current value, as in
   * `updateSelection`.
   */
  async previewSelection(
    id: string,
    input: SourceSelectionInput,
    scope: CodebaseScope,
  ): Promise<CodebaseSelectionPreview> {
    try {
      const existing = this.requireCodebase(id, scope);
      return await this.enumerateSelection(existing, proposedSelection(existing, input));
    } catch (error) {
      throw this.toError(error, 'selection');
    }
  }

  async updateSelection(
    id: string,
    input: SourceSelectionInput,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    try {
      if (
        !Object.prototype.hasOwnProperty.call(input, 'pathFilters') &&
        !Object.prototype.hasOwnProperty.call(input, 'excludeGlobs')
      ) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_EMPTY',
          400,
          'selection_patch_empty',
        );
      }
      const expectedSelectionPolicyRevision = optionalRevision(input.expectedSelectionPolicyRevision);
      const existing = this.requireCodebase(id, scope);
      const currentRevision = existing.selectionPolicyRevision ?? 1;
      if (expectedSelectionPolicyRevision !== undefined && expectedSelectionPolicyRevision !== currentRevision) {
        throw new CodebaseStateError('selection_policy_stale');
      }
      const selection = proposedSelection(existing, input);
      const current = sourceSelectionForRef(existing);
      if (
        sameList(selection.pathFilters, current.includePrefixes) &&
        sameList(selection.excludeGlobs, current.excludeGlobs)
      ) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_UNCHANGED',
          400,
          'selection_policy_unchanged',
        );
      }
      // Re-enumerated at save, never trusted from an earlier preview: only a
      // complete enumeration proves the selection admits nothing.
      const enumerated = await this.enumerateSelection(existing, selection);
      if (enumerated.status === 'complete' && enumerated.preview?.acceptedFileCount === 0) {
        throw new CodebaseManagementError(
          'CODEBASE_SELECTION_EMPTY_MATCH',
          400,
          'effective_source_selection_empty',
        );
      }
      // The revision this save previewed and enumerated, checked in the write.
      const codebase = this.registry.updateSelectionPolicy(id, scope, selection, {
        expectedSelectionPolicyRevision: currentRevision,
      });
      return this.project(await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase);
    } catch (error) {
      throw this.toError(error, 'selection');
    }
  }

  private async enumerateSelection(
    existing: CodebaseRef,
    selection: {pathFilters: string[]; excludeGlobs: string[]},
  ): Promise<CodebaseSelectionPreview> {
    const selectionPolicyRevision = existing.selectionPolicyRevision ?? 1;
    const root = this.evaluateRoot(existing);
    if (!root.available) return {status: 'unavailable', selectionPolicyRevision, unavailableReason: root.reason};
    let result: EnumerationResult;
    try {
      // The enumerator revalidates the root it walks; it walks the one checked above.
      result = await this.sourceEnumerator.enumerate({
        rootRealpath: root.rootRealpath,
        policy: buildSourceSelectionIR({
          kind: existing.kind,
          includePrefixes: selection.pathFilters,
          excludeGlobs: selection.excludeGlobs,
          maxFileBytes: this.gate.getSourceReadLimits().maxFileBytes,
        }),
        gate: this.gate,
        expectedRootRealpath: root.rootRealpath,
        ...channelAuthorizedRoots(existing),
      });
    } catch {
      return {status: 'unavailable', selectionPolicyRevision, unavailableReason: 'enumeration_failed'};
    }
    return {
      status: result.enumerationComplete ? 'complete' : 'partial',
      selectionPolicyRevision,
      preview: projectCodebaseEnumeration(result),
    };
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

  async authorizeContent(
    id: string,
    actor: string,
    disclosureToken: string,
    scope: CodebaseScope,
  ): Promise<RegisteredCodebase> {
    return this.runManagedMutation(id, scope, () =>
      this.registry.authorizeContent(id, scope, actor, disclosureToken));
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
      return this.project(await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase);
    } catch (error) {
      if (isCodebaseStateError(error, 'pending_generation_expired')) {
        try {
          this.registry.expirePendingGeneration(id, scope, candidateId, this.now());
          await this.cleanupInactiveCodebaseChunks(id, scope);
        } catch {
          // Preserve the original CAS error even if best-effort expiry cleanup fails.
        }
      }
      throw this.toError(error, 'pending');
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
      throw this.toError(error, 'audit');
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
      if (isCodebaseStateError(error, 'codebase_reindex_in_progress', 'codebase_reindex_lease_lost')) {
        throw new CodebaseManagementError(
          'CODEBASE_BUSY',
          409,
          'Codebase indexing is in progress; retry deletion after it finishes',
        );
      }
      if (error instanceof CodebaseRequestError && error.code === 'CODEBASE_NOT_FOUND') {
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
      return this.project(await this.cleanupInactiveCodebaseChunks(id, scope) ?? codebase);
    } catch (error) {
      throw this.toError(error, 'mutation');
    }
  }

  private evaluateRoot(ref: CodebaseRef): CodebaseRootCapability {
    return evaluateCodebaseRoot(ref, {gate: this.gate});
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
    if (SAFE_MANIFEST_UNAVAILABLE_REASONS.has(reason)) return reason;
    return 'aosp_manifest_discovery_failed';
  }

  private toError(
    error: unknown,
    operation: 'audit' | 'mutation' | 'pending' | 'preview' | 'selection',
  ): CodebaseManagementError {
    if (error instanceof CodebaseManagementError) return error;
    // Typed selection, metadata and not-found rejections keep their text;
    // preview has no stored codebase, so a not-found there is a preview failure.
    if (error instanceof CodebaseRequestError &&
      !(operation === 'preview' && error.code === 'CODEBASE_NOT_FOUND')) {
      return new CodebaseManagementError(error.code, error.status, error.message);
    }
    if (error instanceof CodebaseStateError) {
      const {code, status} = CODEBASE_STATE_ERRORS[error.reason];
      return new CodebaseManagementError(code, status, error.reason);
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
