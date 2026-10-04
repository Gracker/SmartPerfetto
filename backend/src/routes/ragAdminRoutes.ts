// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * RAG admin routes — operator-side surface for the Plan 55 RAG
 * store. Lets a curator inspect index population per source kind,
 * delete blocked / stale chunks, and search the index directly
 * (without going through the agent).
 *
 * Endpoints (all under `/api/rag`):
 *   GET    /stats              per-kind chunk counts + last indexed
 *   GET    /chunks/:chunkId    fetch one chunk
 *   DELETE /chunks/:chunkId    remove a chunk (license-blocked
 *                              entries can be evicted permanently
 *                              once the curator decides to)
 *   POST   /search             body `{query, kinds?, topK?}` —
 *                              run a search like the agent would
 *
 * The Android Internals endpoints only register and index an operator-
 * allowlisted local checkout. Remote blog, AOSP, and OEM fetchers remain
 * operator-script-only because their authenticated source credentials do
 * not belong in the HTTP surface.
 *
 * The `/knowledge` endpoints register, index, search and delete document
 * collections (any allowlisted folder of documents) and delete any external
 * knowledge source. Responses carry relative paths and counts, never the
 * registered absolute root.
 *
 * @module ragAdminRoutes
 */

import {createHash} from 'crypto';
import * as path from 'path';

import {
  Router,
  type Response,
  type Router as ExpressRouter,
} from 'express';

import {authenticate, requireRequestContext} from '../middleware/auth';
import {
  logRouteFailure,
  sendPublicRequestError,
  sendRouteError,
  sendRouteReasonError,
} from '../middleware/routeFailure';
import {messageReasonCode, thrownReasonCode} from '../utils/publicRequestError';
import {
  CodebaseRequestError,
  invalidCodebaseMetadata,
} from '../services/codebase/codebaseRequestError';
import {
  RagSearchInputError,
  RagStore,
  getDefaultRagStore,
  validateRagSearchInput,
  type RagStoreSearchOptions,
} from '../services/ragStore';
import {knowledgeScopeFromRequestContext, type KnowledgeScope} from '../services/scopedKnowledgeStore';
import type {RagChunk, RagRetrievalResult, RagSourceKind} from '../types/sparkContracts';
import {requireCodebaseScope} from '../services/auth/codebaseScopes';
import {
  activeCodebaseGeneration,
  codebaseRegistrationRequirements,
  CodebaseRegistry,
  isCodebaseKind,
} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {PathSecurityGate} from '../services/codebase/pathSecurityGate';
import {SourceEnumerator} from '../services/codebase/sourceEnumerator';
import {buildSourceSelectionIR} from '../services/codebase/sourceSelectionPolicy';
import {
  CodebaseManagementError,
  CodebaseManagementService,
  projectCodebaseEnumeration,
  projectRegisteredCodebase,
} from '../services/codebase/codebaseManagementService';
import {
  isLocalDirectoryPickerRequest,
  NativeDirectoryPicker,
  NativeDirectoryPickerError,
} from '../services/codebase/nativeDirectoryPicker';
import {AppSourceIngester} from '../services/rag/appSourceIngester';
import {AospSourceIngester} from '../services/rag/aospSourceIngester';
import {KernelSourceIngester} from '../services/rag/kernelSourceIngester';
import {isSourceChunkLimitExceeded, resolveSourcePathPatterns} from '../services/rag/sourceFileSelection';
import {SymbolResolver} from '../services/symbol/symbolResolver';
import {codeAwareFeatureEnabled} from '../services/codebase/codeAwareFeature';
import {
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
  KnowledgeSourceRequestError,
  projectKnowledgeSourceForManagement,
  sanitizeExternalKnowledgeSource,
  type ExternalKnowledgeKind,
  type ExternalKnowledgeSource,
  type KnowledgeCleanupFence,
} from '../services/externalKnowledgeSourceRegistry';
import {DocumentCollectionIngester} from '../services/knowledge/documentCollectionIngester';
import {KnowledgeIndexUnavailableError} from '../services/knowledge/documentCollectionStore';
import {AndroidInternalsWikiIngester} from '../services/androidInternalsWiki/androidInternalsWikiIngester';
import {
  inspectAndroidInternalsWikiIdentity,
  scanAndroidInternalsWiki,
} from '../services/androidInternalsWiki/androidInternalsWikiCorpus';
import {
  auditAndroidInternalsWiki,
  loadAuditableSkills,
  loadValidatedAssertionRefs,
  loadWikiCapabilityMap,
} from '../services/androidInternalsWiki/androidInternalsWikiAudit';

export interface RagAdminRouteServices {
  registry?: CodebaseRegistry;
  gate?: PathSecurityGate;
  sourceEnumerator?: SourceEnumerator;
  codebaseManagementService?: CodebaseManagementService;
  appSourceIngester?: AppSourceIngester;
  aospSourceIngester?: AospSourceIngester;
  kernelSourceIngester?: KernelSourceIngester;
  directoryPicker?: NativeDirectoryPicker;
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  androidInternalsWikiIngester?: AndroidInternalsWikiIngester;
  documentCollectionIngester?: DocumentCollectionIngester;
  androidInternalsWikiAuditPaths?: {
    capabilityMapPath: string;
    skillsPath: string;
    fixtureManifestPath: string;
  };
}

function snippetHash(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex').slice(0, 12);
}

function isCodeAwareChunk(chunk: RagChunk): boolean {
  return chunk.kind === 'app_source' ||
    chunk.kind === 'kernel_source' ||
    chunk.registryOrigin === 'codebase_registry';
}

function isSensitiveKnowledgeChunk(chunk: RagChunk): boolean {
  return isCodeAwareChunk(chunk) || chunk.kind === 'android_internals_wiki';
}

function sanitizeChunk(chunk: RagChunk): RagChunk & {snippetHash?: string; snippetLength?: number} {
  if (!isSensitiveKnowledgeChunk(chunk)) return chunk;
  // Wiki chunks stored before article tags stopped being indexed still carry them.
  const {snippet, knowledgeScopeFingerprint: _knowledgeScopeFingerprint, sourceTags: _legacyTags, ...rest} =
    chunk as RagChunk & {sourceTags?: unknown};
  return {
    ...rest,
    snippet: undefined as any,
    ...(chunk.kind === 'android_internals_wiki'
      ? {
          title: undefined,
          uri: undefined as any,
          filePath: undefined,
        }
      : {}),
    snippetHash: snippetHash(snippet),
    snippetLength: snippet.length,
  };
}

function sanitizeRetrieval(result: RagRetrievalResult): RagRetrievalResult {
  return {
    ...result,
    results: result.results.map(hit => ({
      ...hit,
      ...(hit.chunk ? {chunk: sanitizeChunk(hit.chunk)} : {}),
    })),
  };
}

function optionalRequestString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw invalidCodebaseMetadata(`\`${fieldName}\` must be a string when provided`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1024 || trimmed.includes('\0')) {
    throw invalidCodebaseMetadata(`\`${fieldName}\` must be at most 1024 characters`);
  }
  return trimmed;
}

function sendDirectoryPickerError(
  res: Response,
  error: unknown,
) {
  sendRouteError(res, error, {
    code: 'DIRECTORY_PICKER_FAILED',
    error: 'Directory picker failed',
    logLabel: '[RagAdmin] Directory picker error',
  }, [NativeDirectoryPickerError]);
}

/**
 * The reason tokens a RAG admin caller can act on: a root or path the gate
 * refused, a selection or file the source policy rejected, a lifecycle state
 * to wait out (deletion, reindex, pending generation, a busy registry) and a
 * consent or rights step. Only these are echoed. Any other token a service
 * throws (store corruption, staging invariants, lock bookkeeping, subprocess
 * failures) gets the route's fixed failure, whatever its prefix.
 * ragAdminReasonCatalog.test.ts fails when a producer of these routes' errors
 * adds a token it has not classified here or as internal.
 */
export const CALLER_FACING_RAG_REASONS: ReadonlySet<string> = new Set([
  // Root and knowledge-root gate
  'root_not_found',
  'root_outside_allowlist',
  'knowledge_root_blocked',
  'knowledge_root_realpath_drift',
  'codebase_root_realpath_drift',
  'codebase_root_unavailable',
  'submodule_not_initialized',
  'submodule_outside_root',
  'submodule_unavailable',
  // Source selection and per-file policy
  'source_changed_during_ingest',
  'source_chunk_limit_exceeded',
  'source_directory_invalid',
  'source_enumeration_incomplete',
  'source_exclude_glob_invalid',
  'source_extension_not_allowed',
  'source_file_changed_during_open',
  'source_file_changed_during_read',
  'source_file_identity_changed',
  'source_file_identity_unavailable',
  'source_file_not_found',
  'source_file_too_large',
  'source_file_unreadable',
  'source_generation_empty',
  'source_include_prefix_invalid',
  'source_max_file_bytes_invalid',
  'source_metadata_identity_changed',
  'source_metadata_not_regular_file',
  'source_metadata_time_budget',
  'source_metadata_too_large',
  'source_not_found_or_out_of_scope',
  'source_not_whitelisted',
  'source_path_changed_during_read',
  'source_path_excluded',
  'source_path_invalid',
  'source_path_not_materialized',
  'source_path_not_regular_file',
  'source_path_outside_root',
  'source_path_prefix_invalid',
  'source_selection_empty',
  'source_total_bytes_exceeded',
  // Index lifecycle
  'codebase_deleting',
  'codebase_index_generation_changed',
  'codebase_registry_busy',
  'codebase_reindex_blocked_by_security',
  'codebase_reindex_in_progress',
  'codebase_reindex_incomplete',
  'codebase_reindex_lease_lost',
  'external_knowledge_registry_busy',
  'external_knowledge_reindex_in_progress',
  'external_knowledge_reindex_lease_lost',
  'pending_generation_expired',
  'pending_generation_not_found',
  'pending_generation_stale',
  // Consent and rights
  'provider_send_consent_required',
  'provider_send_disabled_for_session',
  'provider_send_not_consented',
  'right_to_use_not_acknowledged',
]);

function callerFacing(reason: string | undefined): string | undefined {
  return reason && CALLER_FACING_RAG_REASONS.has(reason) ? reason : undefined;
}

function callerFacingRagReason(status: number): (reason: string) => number | undefined {
  return reason => (callerFacing(reason) ? status : undefined);
}

const LEGACY_WIKI_KIND = 'android_internals_wiki';

/**
 * An optional request string. Routes check only presence and type; the
 * registry and the stores own every length and content limit.
 */
function optionalKnowledgeString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new KnowledgeSourceRequestError('KNOWLEDGE_REQUEST_INVALID', `\`${field}\` must be a string`);
  }
  return value;
}

function requiredKnowledgeString(value: unknown, field: string): string {
  const text = optionalKnowledgeString(value, field);
  if (!text?.trim()) throw new KnowledgeSourceRequestError('KNOWLEDGE_REQUEST_INVALID', `\`${field}\` is required`);
  return text;
}

const KNOWLEDGE_ROUTE_ERRORS = [KnowledgeSourceRequestError, KnowledgeIndexUnavailableError];

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const PENDING_GENERATION_FAILURE = {
  code: 'CODEBASE_PENDING_FAILED',
  error: 'Codebase pending generation request failed',
};

function pendingCandidateGenerationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes('\0')
  ) {
    throw new CodebaseRequestError('PENDING_GENERATION_ID_INVALID',
      '`candidateGenerationId` must be a non-empty string of at most 256 characters');
  }
  return value;
}

/** Test/factory hook. */
export function createRagAdminRoutes(store?: RagStore, services: RagAdminRouteServices = {}): ExpressRouter {
  const s = store ?? getDefaultRagStore();
  const registry = services.registry ?? getDefaultCodebaseRegistry();
  const gate = services.gate ?? new PathSecurityGate();
  const sourceEnumerator = services.sourceEnumerator ?? new SourceEnumerator();
  const appSourceIngester = services.appSourceIngester ??
    new AppSourceIngester(s, registry, gate, sourceEnumerator);
  const aospSourceIngester = services.aospSourceIngester ??
    new AospSourceIngester(s, registry, gate, sourceEnumerator);
  const kernelSourceIngester = services.kernelSourceIngester ??
    new KernelSourceIngester(s, registry, gate, sourceEnumerator);
  const codebaseManagementService = services.codebaseManagementService ??
    new CodebaseManagementService({
      registry,
      store: s,
      gate,
      sourceEnumerator,
    });
  const directoryPicker = services.directoryPicker ?? new NativeDirectoryPicker();
  const externalKnowledgeRegistry = services.externalKnowledgeRegistry ??
    getDefaultExternalKnowledgeSourceRegistry();
  const androidInternalsWikiIngester = services.androidInternalsWikiIngester ??
    new AndroidInternalsWikiIngester(
      s,
      externalKnowledgeRegistry,
      new PathSecurityGate({
        allowlistEnvironmentVariable: 'SMARTPERFETTO_KNOWLEDGE_ROOTS',
        allowedExtensions: ['.md'],
        maxFiles: 5_000,
        maxTotalBytes: 64 * 1024 * 1024,
      }),
    );
  const documentCollectionIngester = services.documentCollectionIngester ??
    new DocumentCollectionIngester(externalKnowledgeRegistry);
  /** How each kind's index goes when its source is deleted; the Record type covers every kind. */
  const removeIndexByKind: Readonly<Record<
    ExternalKnowledgeKind,
    (scope: KnowledgeScope, sourceId: string, fence: KnowledgeCleanupFence) => Promise<void> | void
  >> = {
    android_internals_wiki: (scope, sourceId) => {
      removeWikiChunks(sourceId, scope);
    },
    document_collection: (scope, sourceId, fence) => documentCollectionIngester.removeIndex(scope, sourceId, fence),
  };
  /** The legacy Wiki connector's sources; a document collection is managed under `/knowledge`. */
  const legacyWikiSource = (sourceId: string, scope: KnowledgeScope): ExternalKnowledgeSource | undefined => {
    const source = externalKnowledgeRegistry.get(sourceId, scope);
    return source?.kind === LEGACY_WIKI_KIND ? source : undefined;
  };
  const removeWikiChunks = (sourceId: string, scope: KnowledgeScope): number => {
    const chunkIds = s.listChunks({
      kind: 'android_internals_wiki',
      registryOrigin: 'external_knowledge_registry',
      scope,
    }).filter(chunk => chunk.knowledgeSourceId === sourceId)
      .map(chunk => chunk.chunkId);
    return s.removeKnowledgeSourceChunkIds(sourceId, chunkIds, scope);
  };
  const backendRoot = path.resolve(__dirname, '../..');
  const androidInternalsWikiAuditPaths = services.androidInternalsWikiAuditPaths ?? {
    capabilityMapPath: path.join(backendRoot, 'knowledge/android-internals-capability-map.yaml'),
    skillsPath: path.join(backendRoot, 'skills'),
    fixtureManifestPath: path.join(backendRoot, 'skills/public-fixtures.yaml'),
  };
  const symbolResolverFor = (scope: KnowledgeScope) => new SymbolResolver(s, scope, registry);
  const router = Router();
  router.use(authenticate);

  router.get('/stats', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    res.json({success: true, stats: s.getStats(scope)});
  });

  router.get('/chunks/:chunkId', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const chunkId = routeParam(req.params.chunkId);
    const chunk = s.getChunk(chunkId, scope);
    if (!chunk || chunk.kind === 'android_internals_wiki') {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    res.json({success: true, chunk: sanitizeChunk(chunk)});
  });

  router.delete('/chunks/:chunkId', requireCodebaseScope('codebase:admin'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const chunkId = routeParam(req.params.chunkId);
    const chunk = s.getChunk(chunkId, scope);
    if (!chunk || isSensitiveKnowledgeChunk(chunk)) {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    const removed = s.removeChunk(chunkId, scope);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: `Chunk '${chunkId}' not found`,
      });
    }
    res.json({success: true});
  });

  router.post('/search', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const {query, kinds, topK, codebaseIds, vendor, buildId, pathPrefix, symbolExact, filePathExact, languages} = (req.body ?? {}) as {
      query?: string;
      kinds?: RagSourceKind[];
      topK?: number;
    } & RagStoreSearchOptions;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({
        success: false,
        error: '`query` (string) is required',
      });
    }
    try {
      validateRagSearchInput(query, {
        ...(kinds !== undefined ? {kinds} : {}),
        ...(topK !== undefined ? {topK} : {}),
        ...(codebaseIds !== undefined ? {codebaseIds} : {}),
        ...(languages !== undefined ? {languages} : {}),
      });
      const authorizedCodebases = codebaseIds?.map(id => registry.get(id, scope));
      if (authorizedCodebases?.some(codebase => !codebase)) {
        return res.status(404).json({success: false, error: 'One or more codebases were not found'});
      }
      const authorizedCodebaseIds = codebaseIds;
      const result = s.search(query, {
        ...(kinds !== undefined ? {kinds} : {}),
        ...(topK !== undefined ? {topK} : {}),
        ...(authorizedCodebaseIds ? {codebaseIds: authorizedCodebaseIds} : {}),
        ...(authorizedCodebaseIds ? {
          activeCodebaseGenerations: Object.fromEntries(authorizedCodebaseIds.flatMap((codebaseId, index) => {
            const generation = activeCodebaseGeneration(authorizedCodebases![index]!);
            return generation ? [[codebaseId, generation]] : [];
          })),
        } : {}),
        ...(vendor ? {vendor} : {}),
        ...(buildId ? {buildId} : {}),
        ...(pathPrefix ? {pathPrefix} : {}),
        ...(symbolExact ? {symbolExact} : {}),
        ...(filePathExact ? {filePathExact} : {}),
        ...(languages !== undefined ? {languages} : {}),
        scope,
      });
      res.json({success: true, result: sanitizeRetrieval(result)});
    } catch (error) {
      if (error instanceof RagSearchInputError) return sendPublicRequestError(res, error);
      throw error;
    }
  });

  router.post('/android-internals/preview', requireCodebaseScope('codebase:read'), async (req, res) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    if (!rootPath) {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    const preview = await androidInternalsWikiIngester.preview(rootPath);
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'knowledge root blocked',
        preview: {
          blocked: true,
          blockedReason: preview.blockedReason,
          acceptedFileCount: preview.acceptedFiles.length,
          skippedFileCount: preview.skippedFileCount,
        },
      });
    }
    try {
      const corpus = scanAndroidInternalsWiki(
        preview.rootRealpath,
        preview.acceptedFiles.map(file => file.relativePath),
        androidInternalsWikiIngester.getSourceReadLimits(),
      );
      const identity = inspectAndroidInternalsWikiIdentity(corpus);
      const statusCounts: Record<string, number> = {};
      for (const article of corpus.articles) {
        const status = article.status ?? 'unknown';
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }
      return res.json({
        success: true,
        preview: {
          blocked: false,
          acceptedFileCount: preview.acceptedFiles.length,
          skippedFileCount: preview.skippedFileCount,
          totalArticles: corpus.totalArticles,
          metadataErrorCount: corpus.articles.filter(article => !article.metadataValid).length,
          statusCounts,
          revision: identity.revision,
          contentFingerprint: identity.contentFingerprint,
          dirtyAcceptedArticleCount: identity.dirtyAcceptedArticlePaths.length,
        },
      });
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'knowledge_source_preview_failed',
        error: 'Knowledge source preview failed',
        logLabel: '[RagAdmin] Knowledge source preview error',
      });
    }
  });

  router.post('/android-internals/sources', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const rootPath = typeof req.body?.rootPath === 'string' ? req.body.rootPath : '';
    const displayName = typeof req.body?.displayName === 'string'
      ? req.body.displayName.trim()
      : 'Android Internals Wiki';
    if (!rootPath) return res.status(400).json({success: false, error: '`rootPath` is required'});
    if (req.body?.rightsAcknowledged !== true) {
      return res.status(400).json({
        success: false,
        error: '`rightsAcknowledged: true` is required for CC BY-NC-SA use',
      });
    }
    // Omitted keeps the consent already on record; a boolean grants or revokes it.
    const sendToProvider: unknown = req.body?.sendToProvider;
    if (sendToProvider !== undefined && typeof sendToProvider !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: '`sendToProvider` must be a boolean when provided',
      });
    }
    const preview = await androidInternalsWikiIngester.preview(rootPath);
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'knowledge root blocked',
      });
    }
    try {
      const corpus = scanAndroidInternalsWiki(
        preview.rootRealpath,
        preview.acceptedFiles.map(file => file.relativePath),
        androidInternalsWikiIngester.getSourceReadLimits(),
      );
      const identity = inspectAndroidInternalsWikiIdentity(corpus);
      const context = requireRequestContext(req);
      const scope = knowledgeScopeFromRequestContext(context);
      const source = externalKnowledgeRegistry.register({
        kind: LEGACY_WIKI_KIND,
        displayName,
        rootRealpath: preview.rootRealpath,
        revision: identity.revision,
        contentFingerprint: identity.contentFingerprint,
        dirty: identity.dirty,
        license: 'CC-BY-NC-SA-4.0',
        rightsAcknowledged: true,
        sendToProvider,
        consentedBy: context.userId,
        scope,
      });
      return res.json({success: true, source: sanitizeExternalKnowledgeSource(source)});
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'knowledge_source_register_failed',
        error: 'Knowledge source registration failed',
        logLabel: '[RagAdmin] Knowledge source register error',
      }, [KnowledgeSourceRequestError]);
    }
  });

  router.get('/android-internals/sources', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const sources = externalKnowledgeRegistry.list(scope)
      .filter(source => source.kind === LEGACY_WIKI_KIND)
      .map(sanitizeExternalKnowledgeSource);
    return res.json({success: true, sources});
  });

  router.post(
    '/android-internals/sources/:id/reindex',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!legacyWikiSource(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        const result = await androidInternalsWikiIngester.ingest(sourceId, scope);
        return res.json({success: true, result});
      } catch (error) {
        return sendRouteReasonError(res, error, callerFacingRagReason(400), {
          code: 'knowledge_source_reindex_failed',
          error: 'Knowledge source reindex failed',
          logLabel: '[RagAdmin] Knowledge source reindex error',
        }, [KnowledgeSourceRequestError]);
      }
    },
  );

  router.patch(
    '/android-internals/sources/:id/consent',
    requireCodebaseScope('codebase:manage'),
    (req, res) => {
      if (typeof req.body?.sendToProvider !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: '`sendToProvider` must be an explicit boolean',
        });
      }
      const context = requireRequestContext(req);
      const scope = knowledgeScopeFromRequestContext(context);
      try {
        const source = externalKnowledgeRegistry.setProviderConsent(
          routeParam(req.params.id),
          scope,
          req.body.sendToProvider,
          context.userId,
        );
        return res.json({success: true, source: sanitizeExternalKnowledgeSource(source)});
      } catch (error) {
        return sendRouteError(res, error, {
          code: 'knowledge_source_consent_failed',
          error: 'Knowledge source consent update failed',
          logLabel: '[RagAdmin] Knowledge source consent error',
        }, [KnowledgeSourceRequestError]);
      }
    },
  );

  router.delete(
    '/android-internals/sources/:id/index',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!legacyWikiSource(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        return await externalKnowledgeRegistry.withIngestLease(sourceId, scope, lease => {
          const source = lease.clearActiveGeneration();
          const removedChunkCount = removeWikiChunks(sourceId, scope);
          return res.json({
            success: true,
            removedChunkCount,
            source: sanitizeExternalKnowledgeSource(source),
          });
        });
      } catch (error) {
        return sendRouteReasonError(res, error, callerFacingRagReason(409), {
          code: 'knowledge_source_index_delete_failed',
          error: 'Knowledge source index deletion failed',
          logLabel: '[RagAdmin] Knowledge source index delete error',
        }, [KnowledgeSourceRequestError]);
      }
    },
  );

  router.get(
    '/android-internals/sources/:id/audit',
    requireCodebaseScope('codebase:read'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      const source = legacyWikiSource(sourceId, scope);
      if (!source) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        const preview = await androidInternalsWikiIngester.preview(source.rootRealpath);
        if (preview.blocked) {
          throw new Error(preview.blockedReason ?? 'knowledge_root_blocked');
        }
        if (preview.rootRealpath !== source.rootRealpath) {
          throw new Error('knowledge_root_realpath_drift');
        }
        const corpus = scanAndroidInternalsWiki(
          preview.rootRealpath,
          preview.acceptedFiles.map(file => file.relativePath),
          androidInternalsWikiIngester.getSourceReadLimits(),
        );
        const identity = inspectAndroidInternalsWikiIdentity(corpus);
        const report = auditAndroidInternalsWiki(
          corpus,
          loadWikiCapabilityMap(androidInternalsWikiAuditPaths.capabilityMapPath),
          loadAuditableSkills(androidInternalsWikiAuditPaths.skillsPath),
          loadValidatedAssertionRefs(androidInternalsWikiAuditPaths.fixtureManifestPath),
        );
        return res.json({
          success: true,
          audit: {
            repository: {
              revision: identity.revision,
              contentFingerprint: identity.contentFingerprint,
              dirtyAcceptedArticlePaths: identity.dirtyAcceptedArticlePaths,
            },
            report,
          },
        });
      } catch (error) {
        return sendRouteReasonError(res, error, callerFacingRagReason(400), {
          code: 'knowledge_source_audit_failed',
          error: 'Knowledge source audit failed',
          logLabel: '[RagAdmin] Knowledge source audit error',
        }, [KnowledgeSourceRequestError]);
      }
    },
  );

  router.get('/knowledge', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    return res.json({
      success: true,
      sources: externalKnowledgeRegistry.list(scope).map(projectKnowledgeSourceForManagement),
    });
  });

  router.post('/knowledge/preview', requireCodebaseScope('codebase:manage'), async (req, res) => {
    try {
      const preview = await documentCollectionIngester.previewIndexable(
        requiredKnowledgeString(req.body?.rootPath, 'rootPath'));
      return res.json({success: true, preview: preview.summary});
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'KNOWLEDGE_COLLECTION_PREVIEW_FAILED',
        error: 'Knowledge collection preview failed',
        logLabel: '[RagAdmin] Knowledge collection preview error',
      }, KNOWLEDGE_ROUTE_ERRORS);
    }
  });

  router.post('/knowledge/register', requireCodebaseScope('codebase:manage'), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rootPath = requiredKnowledgeString(body.rootPath, 'rootPath');
      // Omitted keeps the consent in effect; a boolean grants or revokes it.
      if (body.sendToProvider !== undefined && typeof body.sendToProvider !== 'boolean') {
        throw new KnowledgeSourceRequestError('KNOWLEDGE_REQUEST_INVALID',
          '`sendToProvider` must be a boolean when provided');
      }
      const context = requireRequestContext(req);
      const {source, preview} = await documentCollectionIngester.register({
        rootPath,
        displayName: optionalKnowledgeString(body.displayName, 'displayName'),
        description: optionalKnowledgeString(body.description, 'description'),
        attribution: optionalKnowledgeString(body.attribution, 'attribution'),
        license: optionalKnowledgeString(body.license, 'license'),
        rightsAcknowledged: body.rightsAcknowledged === true,
        sendToProvider: body.sendToProvider as boolean | undefined,
        consentedBy: context.userId,
        scope: knowledgeScopeFromRequestContext(context),
      });
      return res.json({success: true, source: projectKnowledgeSourceForManagement(source), preview: preview.summary});
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'KNOWLEDGE_COLLECTION_REGISTER_FAILED',
        error: 'Knowledge collection registration failed',
        logLabel: '[RagAdmin] Knowledge collection register error',
      }, KNOWLEDGE_ROUTE_ERRORS);
    }
  });

  router.post('/knowledge/:sourceId/reindex', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const result = await documentCollectionIngester.ingest(routeParam(req.params.sourceId), scope);
      return res.json({success: true, result});
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'KNOWLEDGE_COLLECTION_REINDEX_FAILED',
        error: 'Knowledge collection reindex failed',
        logLabel: '[RagAdmin] Knowledge collection reindex error',
      }, KNOWLEDGE_ROUTE_ERRORS);
    }
  });

  router.post('/knowledge/:sourceId/search', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const query = requiredKnowledgeString(req.body?.query, 'query');
      const topK = req.body?.topK ?? 5;
      if (!Number.isInteger(topK)) {
        throw new KnowledgeSourceRequestError('KNOWLEDGE_REQUEST_INVALID', '`topK` must be an integer');
      }
      return res.json({
        success: true,
        ...documentCollectionIngester.search(routeParam(req.params.sourceId), scope, query, topK),
      });
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'KNOWLEDGE_COLLECTION_SEARCH_FAILED',
        error: 'Knowledge collection search failed',
        logLabel: '[RagAdmin] Knowledge collection search error',
      }, KNOWLEDGE_ROUTE_ERRORS);
    }
  });

  router.delete('/knowledge/:sourceId', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const sourceId = routeParam(req.params.sourceId);
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    try {
      await externalKnowledgeRegistry.remove(sourceId, scope, context.userId, (tombstone, fence) => {
        // A stored record of a kind this build does not know keeps its tombstone.
        const removeIndex = removeIndexByKind[tombstone.kind] as typeof removeIndexByKind[ExternalKnowledgeKind] | undefined;
        if (!removeIndex) throw new Error('Unknown external knowledge kind');
        return removeIndex(scope, sourceId, fence);
      });
      return res.json({success: true, sourceId, deleted: true});
    } catch (error) {
      return sendRouteReasonError(res, error, callerFacingRagReason(409), {
        code: 'KNOWLEDGE_SOURCE_DELETE_FAILED',
        error: 'Knowledge source deletion failed',
        logLabel: '[RagAdmin] Knowledge source delete error',
      }, KNOWLEDGE_ROUTE_ERRORS);
    }
  });

  router.get('/codebases', requireCodebaseScope('codebase:read'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    res.json({
      success: true,
      featureEnabled: codeAwareFeatureEnabled(),
      codebases: await codebaseManagementService.list(scope),
    });
  });

  router.get(
    '/codebases/directory-picker',
    requireCodebaseScope('codebase:manage'),
    (req, res) => {
      const capability = directoryPicker.capability();
      const localRequest = isLocalDirectoryPickerRequest({
        hostname: req.hostname,
        remoteAddress: req.socket.remoteAddress,
        origin: req.get('origin'),
      }, {allowMissingOrigin: true});
      res.json({
        success: true,
        capability: localRequest
          ? capability
          : {
              available: false,
              platform: capability.platform,
              reason: 'remote_request',
            },
      });
    },
  );

  router.post(
    '/codebases/directory-picker',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      if (!isLocalDirectoryPickerRequest({
        hostname: req.hostname,
        remoteAddress: req.socket.remoteAddress,
        origin: req.get('origin'),
      })) {
        return res.status(403).json({
          success: false,
          code: 'DIRECTORY_PICKER_UNAVAILABLE',
          error: 'System directory selection is available only from the local SmartPerfetto UI',
        });
      }
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      try {
        const result = await directoryPicker.chooseDirectory(scope);
        return res.json({success: true, ...result});
      } catch (error) {
        return sendDirectoryPickerError(res, error);
      }
    },
  );

  router.post('/codebases/preview', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const {rootPath, directorySelectionId, kind = 'app_source', pathFilters, excludeGlobs} =
      (req.body ?? {}) as Record<string, unknown>;
    if (!rootPath || typeof rootPath !== 'string') {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    if (!isCodebaseKind(kind)) {
      return res.status(400).json({success: false, error: '`kind` is invalid'});
    }
    if (
      directorySelectionId !== undefined &&
      typeof directorySelectionId !== 'string'
    ) {
      return res.status(400).json({
        success: false,
        error: '`directorySelectionId` must be a string when provided',
      });
    }
    if (directorySelectionId && !isLocalDirectoryPickerRequest({
      hostname: req.hostname,
      remoteAddress: req.socket.remoteAddress,
      origin: req.get('origin'),
    })) {
      return res.status(403).json({
        success: false,
        code: 'DIRECTORY_PICKER_UNAVAILABLE',
        error: 'Directory selections can be used only from the local SmartPerfetto UI',
      });
    }
    try {
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      const selectedRoot = directorySelectionId
        ? directoryPicker.validateSelection(directorySelectionId, rootPath, scope)
        : undefined;
      return res.json({
        success: true,
        preview: await codebaseManagementService.preview({
          rootPath,
          kind,
          pathFilters,
          excludeGlobs,
          ...(selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : {}),
        }, scope),
      });
    } catch (error) {
      if (error instanceof NativeDirectoryPickerError) {
        return sendDirectoryPickerError(res, error);
      }
      return sendRouteError(res, error, {
        code: 'CODEBASE_PREVIEW_FAILED',
        error: 'Codebase preview failed',
        logLabel: '[RagAdmin] Codebase preview error',
      }, [CodebaseManagementError]);
    }
  });

  router.post('/codebases/register', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const {
      kind = 'app_source',
      displayName,
      rootPath,
      commitHash,
      vendor,
      buildId,
      pathFilters,
      excludeGlobs,
      symbolMapPaths,
      licenseTag,
      sendToProvider,
      directorySelectionId,
    } = (req.body ?? {}) as Record<string, any>;
    if (!rootPath || typeof rootPath !== 'string') {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
    }
    if (sendToProvider !== undefined && typeof sendToProvider !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: '`sendToProvider` must be an explicit boolean when provided',
      });
    }
    if (!isCodebaseKind(kind)) {
      return res.status(400).json({success: false, error: '`kind` is invalid'});
    }
    if (
      directorySelectionId !== undefined &&
      typeof directorySelectionId !== 'string'
    ) {
      return res.status(400).json({
        success: false,
        error: '`directorySelectionId` must be a string when provided',
      });
    }
    if (directorySelectionId && !isLocalDirectoryPickerRequest({
      hostname: req.hostname,
      remoteAddress: req.socket.remoteAddress,
      origin: req.get('origin'),
    })) {
      return res.status(403).json({
        success: false,
        code: 'DIRECTORY_PICKER_UNAVAILABLE',
        error: 'Directory selections can be used only from the local SmartPerfetto UI',
      });
    }
    let normalizedPathFilters: string[] | undefined;
    let normalizedExcludeGlobs: string[] | undefined;
    let normalizedDisplayName: string | undefined;
    let normalizedCommitHash: string | undefined;
    let normalizedVendor: string | undefined;
    let normalizedBuildId: string | undefined;
    let normalizedLicenseTag: string | undefined;
    try {
      normalizedPathFilters = resolveSourcePathPatterns(pathFilters, 'pathFilters');
      normalizedExcludeGlobs = resolveSourcePathPatterns(excludeGlobs, 'excludeGlobs');
      normalizedDisplayName = optionalRequestString(displayName, 'displayName');
      normalizedCommitHash = optionalRequestString(commitHash, 'commitHash');
      normalizedVendor = optionalRequestString(vendor, 'vendor');
      normalizedBuildId = optionalRequestString(buildId, 'buildId');
      normalizedLicenseTag = optionalRequestString(licenseTag, 'licenseTag');
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_REGISTER_FAILED',
        error: 'Codebase registration failed',
        logLabel: '[RagAdmin] Codebase register input error',
      }, [CodebaseRequestError]);
    }
    if (Array.isArray(symbolMapPaths) && symbolMapPaths.length > 0) {
      return res.status(501).json({
        success: false,
        code: 'SYMBOL_ARTIFACT_INGESTION_NOT_CONFIGURED',
        error: 'Native symbol-map artifact ingestion is not configured; source-derived symbol indexing remains available',
      });
    }
    const requirements = codebaseRegistrationRequirements(kind);
    if (requirements.vendor && !normalizedVendor) {
      return res.status(400).json({
        success: false,
        error: '`vendor` is required for kernel_source and oem_sdk codebases',
      });
    }
    if (requirements.licenseTag && !normalizedLicenseTag) {
      return res.status(400).json({
        success: false,
        error: '`licenseTag` is required for aosp and oem_sdk codebases',
      });
    }
    if (requirements.pathFilters && !normalizedPathFilters?.length) {
      return res.status(400).json({
        success: false,
        error: '`pathFilters` is required for kernel_source codebases',
      });
    }
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    let selectedRoot: string | undefined;
    try {
      selectedRoot = directorySelectionId
        ? directoryPicker.validateSelection(directorySelectionId, rootPath, scope)
        : undefined;
    } catch (error) {
      return sendDirectoryPickerError(res, error);
    }
    try {
      const rootRealpath = await gate.validateRoot(
        rootPath,
        selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : undefined,
      );
      const enumeration = await sourceEnumerator.enumerate({
        rootRealpath,
        policy: buildSourceSelectionIR({
          kind,
          includePrefixes: normalizedPathFilters,
          excludeGlobs: normalizedExcludeGlobs,
        }),
        gate,
        ...(selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : {}),
      });
      if (enumeration.enumerationComplete && enumeration.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'effective_source_selection_empty',
          message: 'No source files matched the effective selection.',
          hint: 'Check the path filters, exclude globs, ignored files, and supported extensions.',
          preview: projectCodebaseEnumeration(enumeration),
        });
      }
      const register = () => registry.register({
        kind,
        displayName: normalizedDisplayName ||
          path.basename(rootRealpath) ||
          'Source code',
        rootPath,
        rootRealpath,
        ...(directorySelectionId ? {rootAuthorization: 'native_picker'} : {}),
        ...(normalizedCommitHash ? {commitHash: normalizedCommitHash} : {}),
        ...(normalizedVendor ? {vendor: normalizedVendor} : {}),
        ...(normalizedBuildId ? {buildId: normalizedBuildId} : {}),
        ...(normalizedPathFilters ? {pathFilters: normalizedPathFilters} : {}),
        ...(normalizedExcludeGlobs ? {excludeGlobs: normalizedExcludeGlobs} : {}),
        ...(normalizedLicenseTag ? {licenseTag: normalizedLicenseTag} : {}),
        sendToProvider: sendToProvider ?? false,
        consentedBy: context.userId,
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        userId: context.userId,
      });
      const ref = directorySelectionId
        ? directoryPicker.runWithSelection(
            directorySelectionId,
            rootPath,
            scope,
            register,
          )
        : register();
      res.json({
        success: true,
        codebase: projectRegisteredCodebase(ref),
        preview: projectCodebaseEnumeration(enumeration),
      });
    } catch (error) {
      if (error instanceof NativeDirectoryPickerError) {
        return sendDirectoryPickerError(res, error);
      }
      // Path gate and registry rejections are reason tokens; filesystem and
      // database failures get fixed text.
      return sendRouteReasonError(res, error, callerFacingRagReason(400), {
        code: 'CODEBASE_REGISTER_FAILED',
        error: 'Codebase registration failed',
        logLabel: '[RagAdmin] Codebase register error',
      }, [CodebaseRequestError]);
    }
  });

  router.get('/codebases/:id', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      return res.json({success: true, codebase: codebaseManagementService.get(codebaseId, scope)});
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_READ_FAILED',
        error: 'Failed to read codebase',
        logLabel: '[RagAdmin] Codebase read error',
      }, [CodebaseManagementError]);
    }
  });

  router.get('/codebases/:id/symbols', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const ref = registry.get(codebaseId, scope);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    const symbol = typeof req.query.symbol === 'string'
      ? req.query.symbol
      : typeof req.query.query === 'string'
        ? req.query.query
        : '';
    if (!symbol) {
      return res.status(400).json({success: false, error: '`symbol` or `query` is required'});
    }
    const common = {
      codebaseId,
      buildId: typeof req.query.buildId === 'string' ? req.query.buildId : undefined,
      topK: typeof req.query.topK === 'string' ? Number(req.query.topK) : undefined,
    };
    try {
      const symbolResolver = symbolResolverFor(scope);
      const result = ref.kind === 'kernel_source'
        ? symbolResolver.resolveKernel({
            symbol,
            vendor: ref.vendor,
            ...common,
          })
        : ref.kind === 'aosp' || ref.kind === 'oem_sdk'
          ? symbolResolver.resolveNative({
              symbol,
              ...common,
            })
          : symbolResolver.resolveApp({
              symbol,
              codebaseId,
              buildId: common.buildId,
              topK: common.topK,
              filePath: typeof req.query.filePath === 'string' ? req.query.filePath : undefined,
            });
      res.json({success: true, result});
    } catch (error) {
      if (error instanceof RagSearchInputError) return sendPublicRequestError(res, error);
      throw error;
    }
  });

  router.get('/codebases/:id/excerpt', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const ref = registry.get(codebaseId, scope);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    const chunkId = typeof req.query.chunkId === 'string' ? req.query.chunkId : '';
    if (!chunkId) {
      return res.status(400).json({success: false, error: '`chunkId` is required'});
    }
    const chunk = s.getChunk(chunkId, scope);
    if (
      !chunk ||
      chunk.codebaseId !== codebaseId ||
      !isCodeAwareChunk(chunk) ||
      chunk.sourceGeneration !== activeCodebaseGeneration(ref)
    ) {
      return res.status(404).json({success: false, error: `Code excerpt '${chunkId}' not found`});
    }
    const maxLines = typeof req.query.maxLines === 'string'
      ? Math.max(1, Math.min(80, Number(req.query.maxLines) || 20))
      : 20;
    const lines = chunk.snippet.split(/\r?\n/).slice(0, maxLines);
    res.json({
      success: true,
      excerpt: {
        chunkId,
        codebaseId,
        filePath: chunk.filePath,
        lineRange: chunk.lineRange,
        symbol: chunk.symbol,
        language: chunk.language,
        text: lines.join('\n'),
        truncated: lines.length < chunk.snippet.split(/\r?\n/).length,
      },
    });
  });

  router.post('/codebases/:id/reindex', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const ref = registry.get(codebaseId, scope);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    const sendIndexFailure = async (error: unknown) => {
      const capacityExceeded = isSourceChunkLimitExceeded(error);
      const code = capacityExceeded ? 'CODEBASE_INDEX_CAPACITY_EXCEEDED' : 'CODEBASE_INDEX_FAILED';
      const requestId = logRouteFailure(res, '[RagAdmin] Codebase index error', 400, code, error);
      const onDemandAvailable = await codebaseManagementService.onDemandAvailable(codebaseId, scope);
      const message = capacityExceeded
        ? 'Optional source index reached its capacity; this index attempt was rolled back.'
        : 'Optional source index could not be built.';
      // The legacy error field keeps the request error or the ingester's
      // reason token; new UIs use the stable code and a fresh root check.
      return res.status(400).json({
        success: false,
        code,
        error: error instanceof CodebaseRequestError
          ? error.message
          : callerFacing(thrownReasonCode(error)) ?? message,
        message,
        onDemandAvailable,
        requestId,
      });
    };
    try {
      const result = await (ref.kind === 'kernel_source'
        ? kernelSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope})
        : ref.kind === 'aosp' || ref.kind === 'oem_sdk'
          ? aospSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope})
          : appSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope}));
      if (!result.activationDisposition || !result.coverage) {
        return await sendIndexFailure(new Error(result.errors[0]?.reason ?? 'codebase_reindex_blocked_by_security'));
      }
      // A skipped file's reason can be a raw filesystem error with an absolute
      // path; the caller gets its reason token only.
      res.json({success: true, result: {
        ...result,
        errors: result.errors.map(fileError => ({
          ...fileError,
          reason: callerFacing(messageReasonCode(fileError.reason)) ?? 'source_file_unreadable',
        })),
      }});
    } catch (error) {
      return await sendIndexFailure(error);
    }
  });

  router.get('/codebases/:id/audit', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      return res.json({success: true, audit: codebaseManagementService.audit(codebaseId, scope)});
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_AUDIT_FAILED',
        error: 'Codebase audit failed',
        logLabel: '[RagAdmin] Codebase audit error',
      }, [CodebaseManagementError]);
    }
  });

  router.patch('/codebases/:id/consent', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const authorizeAvailableExtensions = req.body?.authorizeAvailableExtensions === true;
    const authorizeCurrentSelection = req.body?.authorizeCurrentSelection === true;
    const updatesProviderConsent = typeof req.body?.sendToProvider === 'boolean';
    const actionCount = Number(authorizeAvailableExtensions) +
      Number(authorizeCurrentSelection) +
      Number(updatesProviderConsent);
    if (actionCount > 1) {
      return res.status(400).json({
        success: false,
        error: '`authorizeAvailableExtensions`, `authorizeCurrentSelection`, and `sendToProvider` are mutually exclusive',
      });
    }
    if (actionCount !== 1) {
      return res.status(400).json({
        success: false,
        error: 'exactly one consent action is required',
      });
    }
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    try {
      const codebase = authorizeAvailableExtensions
        ? await codebaseManagementService.authorizeAvailableExtensions(
            routeParam(req.params.id),
            context.userId,
            scope,
          )
        : authorizeCurrentSelection
          ? await codebaseManagementService.authorizeCurrentSelection(
              routeParam(req.params.id),
              context.userId,
              scope,
            )
        : await codebaseManagementService.setConsent(
            routeParam(req.params.id),
            req.body.sendToProvider,
            context.userId,
            scope,
          );
      return res.json({success: true, codebase});
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_CONSENT_FAILED',
        error: 'Codebase consent update failed',
        logLabel: '[RagAdmin] Codebase consent error',
      }, [CodebaseManagementError]);
    }
  });

  router.patch('/codebases/:id/selection', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const body = req.body ?? {};
      const codebaseId = routeParam(req.params.id);
      const codebase = await codebaseManagementService.updateSelection(codebaseId, body, scope);
      return res.json({success: true, codebase});
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_SELECTION_FAILED',
        error: 'Codebase selection update failed',
        logLabel: '[RagAdmin] Codebase selection error',
      }, [CodebaseManagementError]);
    }
  });

  router.post('/codebases/:id/pending/accept', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const selectionPolicyRevision = Number(req.body?.selectionPolicyRevision);
    const grantRevision = Number(req.body?.grantRevision);
    let candidateGenerationId: string;
    try {
      candidateGenerationId = pendingCandidateGenerationId(req.body?.candidateGenerationId);
    } catch (error) {
      return sendRouteError(res, error, {
        ...PENDING_GENERATION_FAILURE,
        logLabel: '[RagAdmin] Pending generation input error',
      }, [CodebaseRequestError]);
    }
    if (!Number.isInteger(selectionPolicyRevision) || !Number.isInteger(grantRevision)) {
      return res.status(400).json({
        success: false,
        error: '`selectionPolicyRevision` and `grantRevision` must be integers',
      });
    }
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const codebase = await codebaseManagementService.acceptPending(
        routeParam(req.params.id),
        candidateGenerationId,
        scope,
        {selectionPolicyRevision, grantRevision},
      );
      return res.json({success: true, codebase});
    } catch (error) {
      return sendRouteError(res, error, {
        ...PENDING_GENERATION_FAILURE,
        logLabel: '[RagAdmin] Pending generation accept error',
      }, [CodebaseManagementError]);
    }
  });

  router.post('/codebases/:id/pending/reject', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    let candidateGenerationId: string;
    try {
      candidateGenerationId = pendingCandidateGenerationId(req.body?.candidateGenerationId);
    } catch (error) {
      return sendRouteError(res, error, {
        ...PENDING_GENERATION_FAILURE,
        logLabel: '[RagAdmin] Pending generation input error',
      }, [CodebaseRequestError]);
    }
    try {
      const codebase = await codebaseManagementService.rejectPending(
        routeParam(req.params.id),
        candidateGenerationId,
        scope,
      );
      return res.json({success: true, codebase});
    } catch (error) {
      return sendRouteError(res, error, {
        ...PENDING_GENERATION_FAILURE,
        logLabel: '[RagAdmin] Pending generation reject error',
      }, [CodebaseManagementError]);
    }
  });

  router.delete('/codebases/:id', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      return res.json({success: true, ...await codebaseManagementService.delete(codebaseId, scope)});
    } catch (error) {
      return sendRouteError(res, error, {
        code: 'CODEBASE_DELETE_FAILED',
        error: 'Codebase deletion failed',
        logLabel: '[RagAdmin] Codebase delete error',
      }, [CodebaseManagementError]);
    }
  });

  return router;
}

const ragAdminRoutes = createRagAdminRoutes();
export default ragAdminRoutes;
