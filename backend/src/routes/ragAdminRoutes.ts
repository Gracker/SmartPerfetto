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
  codebaseProviderGrantScopeCurrent,
  codebaseRegistrationRequirements,
  codebaseRootAvailable,
  CodebaseRegistry,
  PENDING_GENERATION_TTL_MS,
  type CodebaseRef,
  type CodebaseScope,
  isCodebaseKind,
} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {PathSecurityGate} from '../services/codebase/pathSecurityGate';
import {SourceEnumerator, type EnumerationResult} from '../services/codebase/sourceEnumerator';
import {buildSourceSelectionIR} from '../services/codebase/sourceSelectionPolicy';
import {availableNotConsentedExtensions} from '../services/codebase/sourceDisclosure';
import {readAospManifestProjects} from '../services/codebase/aospManifest';
import {
  isLocalDirectoryPickerRequest,
  NativeDirectoryPicker,
  NativeDirectoryPickerError,
} from '../services/codebase/nativeDirectoryPicker';
import {AppSourceIngester} from '../services/rag/appSourceIngester';
import {AospSourceIngester} from '../services/rag/aospSourceIngester';
import {KernelSourceIngester} from '../services/rag/kernelSourceIngester';
import {resolveSourcePathPatterns} from '../services/rag/sourceFileSelection';
import {SymbolResolver} from '../services/symbol/symbolResolver';
import {codeAwareFeatureEnabled} from '../services/codebase/codeAwareFeature';
import {
  ExternalKnowledgeSourceRegistry,
  getDefaultExternalKnowledgeSourceRegistry,
  type ExternalKnowledgeSource,
} from '../services/externalKnowledgeSourceRegistry';
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
  appSourceIngester?: AppSourceIngester;
  aospSourceIngester?: AospSourceIngester;
  kernelSourceIngester?: KernelSourceIngester;
  directoryPicker?: NativeDirectoryPicker;
  externalKnowledgeRegistry?: ExternalKnowledgeSourceRegistry;
  androidInternalsWikiIngester?: AndroidInternalsWikiIngester;
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
  const {snippet, knowledgeScopeFingerprint: _knowledgeScopeFingerprint, ...rest} = chunk;
  return {
    ...rest,
    snippet: undefined as any,
    ...(chunk.kind === 'android_internals_wiki'
      ? {
          title: undefined,
          uri: undefined as any,
          filePath: undefined,
          sourceTags: undefined,
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

function sanitizeCodebase(ref: CodebaseRef) {
  const {
    rootPath: _rootPath,
    rootRealpath: _rootRealpath,
    rootAuthorization: _rootAuthorization,
    consent,
    ...rest
  } = ref;
  return {
    ...rest,
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

function optionalRequestString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`\`${fieldName}\` must be a string when provided`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1024 || trimmed.includes('\0')) {
    throw new Error(`\`${fieldName}\` must be at most 1024 characters`);
  }
  return trimmed;
}

function sendDirectoryPickerError(
  res: Response,
  error: unknown,
) {
  if (error instanceof NativeDirectoryPickerError) {
    return res.status(error.httpStatus).json({
      success: false,
      code: error.code,
      error: error.message,
    });
  }
  return res.status(500).json({
    success: false,
    code: 'DIRECTORY_PICKER_FAILED',
    error: 'Directory picker failed',
  });
}

function sanitizeEnumeration(result: EnumerationResult) {
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
    recommendedAction: result.incompleteReason === 'time_budget' ? 'narrow_scope' : undefined,
    scopeSuggestions: [...subtreeCounts.entries()]
      .map(([prefix, fileCount]) => ({prefix, fileCount}))
      .sort((left, right) => right.fileCount - left.fileCount || left.prefix.localeCompare(right.prefix))
      .slice(0, 12),
  };
}

function sanitizeExternalKnowledgeSource(source: ExternalKnowledgeSource) {
  const {rootRealpath: _rootRealpath, scope: _scope, ...safeSource} = source;
  return safeSource;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function pendingCandidateGenerationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.includes('\0')
  ) throw new Error('`candidateGenerationId` must be a non-empty string of at most 256 characters');
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
  const backendRoot = path.resolve(__dirname, '../..');
  const androidInternalsWikiAuditPaths = services.androidInternalsWikiAuditPaths ?? {
    capabilityMapPath: path.join(backendRoot, 'knowledge/android-internals-capability-map.yaml'),
    skillsPath: path.join(backendRoot, 'skills'),
    fixtureManifestPath: path.join(backendRoot, 'skills/public-fixtures.yaml'),
  };
  const cleanupInactiveCodebaseChunks = async (
    codebaseId: string,
    scope: CodebaseScope,
  ): Promise<CodebaseRef | undefined> => {
    if (!registry.get(codebaseId, scope)) return undefined;
    try {
      await registry.withIngestLease(codebaseId, scope, lease => {
        lease.assertHeld(true);
        const current = registry.get(codebaseId, scope);
        if (!current) return;
        const preserved = [
          activeCodebaseGeneration(current),
          current.pendingGeneration?.candidateGenerationId,
        ].filter((generation): generation is string => Boolean(generation));
        s.removeCodebaseChunksExceptGeneration(codebaseId, preserved, scope);
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
        const current = registry.get(codebaseId, scope);
        if (!current) return undefined;
        registry.updateIngestStatus(codebaseId, {
          lastIngestStatus: current.lastIngestStatus ?? 'ok',
          maintenanceWarning: 'inactive_chunk_cleanup_failed',
          lastIngestError: `inactive_chunk_cleanup_failed:${error instanceof Error ? error.message : String(error)}`,
        }, scope);
      } catch {
        // Keep the original state readable even if warning persistence also fails.
      }
    }
    return registry.get(codebaseId, scope);
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
      if (error instanceof RagSearchInputError) {
        return res.status(400).json({success: false, code: error.code, error: error.message});
      }
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
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
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
    if (typeof req.body?.sendToProvider !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: '`sendToProvider` must be an explicit boolean',
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
        kind: 'android_internals_wiki',
        displayName,
        rootRealpath: preview.rootRealpath,
        revision: identity.revision,
        contentFingerprint: identity.contentFingerprint,
        dirty: identity.dirty,
        license: 'CC-BY-NC-SA-4.0',
        rightsAcknowledged: true,
        sendToProvider: req.body.sendToProvider,
        consentedBy: context.userId,
        scope,
      });
      return res.json({success: true, source: sanitizeExternalKnowledgeSource(source)});
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/android-internals/sources', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const sources = externalKnowledgeRegistry.list(scope).map(sanitizeExternalKnowledgeSource);
    return res.json({success: true, sources});
  });

  router.post(
    '/android-internals/sources/:id/reindex',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!externalKnowledgeRegistry.get(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        const result = await androidInternalsWikiIngester.ingest(sourceId, scope);
        return res.json({success: true, result});
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
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
        return res.status(404).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.delete(
    '/android-internals/sources/:id/index',
    requireCodebaseScope('codebase:manage'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      if (!externalKnowledgeRegistry.get(sourceId, scope)) {
        return res.status(404).json({
          success: false,
          error: `External knowledge source '${sourceId}' not found`,
        });
      }
      try {
        return await externalKnowledgeRegistry.withIngestLease(sourceId, scope, lease => {
          const chunkIds = s.listChunks({
            kind: 'android_internals_wiki',
            registryOrigin: 'external_knowledge_registry',
            scope,
          }).filter(chunk => chunk.knowledgeSourceId === sourceId)
            .map(chunk => chunk.chunkId);
          const source = lease.clearActiveGeneration();
          const removedChunkCount = s.removeKnowledgeSourceChunkIds(sourceId, chunkIds, scope);
          return res.json({
            success: true,
            removedChunkCount,
            source: sanitizeExternalKnowledgeSource(source),
          });
        });
      } catch (error) {
        return res.status(409).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.get(
    '/android-internals/sources/:id/audit',
    requireCodebaseScope('codebase:read'),
    async (req, res) => {
      const sourceId = routeParam(req.params.id);
      const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
      const source = externalKnowledgeRegistry.get(sourceId, scope);
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
        const acceptedPaths = new Set(
          preview.acceptedFiles.map(file => file.relativePath.split('\\').join('/')),
        );
        const excludedArticleCount = corpus.articles.filter(
          article => !acceptedPaths.has(article.relativePath),
        ).length;
        if (excludedArticleCount > 0) {
          throw new Error(`knowledge_path_gate_excluded_${excludedArticleCount}_articles`);
        }
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
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  router.get('/codebases', requireCodebaseScope('codebase:read'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const now = Date.now();
    for (const summary of registry.list(scope)) {
      if (summary.maintenanceWarning === 'inactive_chunk_cleanup_failed') {
        await cleanupInactiveCodebaseChunks(summary.codebaseId, scope);
      }
      const pending = summary.pendingGeneration;
      if (!pending || now - pending.createdAt < PENDING_GENERATION_TTL_MS) continue;
      registry.expirePendingGeneration(
        summary.codebaseId,
        scope,
        pending.candidateGenerationId,
        now,
      );
      await cleanupInactiveCodebaseChunks(summary.codebaseId, scope);
    }
    res.json({
      success: true,
      featureEnabled: codeAwareFeatureEnabled(),
      codebases: registry.list(scope),
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
      const rootRealpath = await gate.validateRoot(
        rootPath,
        selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : undefined,
      );
      const result = await sourceEnumerator.enumerate({
        rootRealpath,
        policy: buildSourceSelectionIR({
          kind,
          includePrefixes: resolveSourcePathPatterns(pathFilters, 'pathFilters'),
          excludeGlobs: resolveSourcePathPatterns(excludeGlobs, 'excludeGlobs'),
        }),
        gate,
        expectedRootRealpath: rootRealpath,
        ...(selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : {}),
      });
      let manifestProjects = [] as Awaited<ReturnType<typeof readAospManifestProjects>>;
      let manifestUnavailableReason: string | undefined;
      if (kind === 'aosp' || kind === 'oem_sdk') {
        try {
          manifestProjects = await readAospManifestProjects(rootRealpath, rootRealpath);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (reason === 'codebase_root_realpath_drift') throw error;
          manifestUnavailableReason = reason;
        }
      }
      const manifestGroups = [...new Set(manifestProjects.flatMap(project => project.groups))].sort();
      return res.json({
        success: true,
        preview: {
          ...sanitizeEnumeration(result),
          ...(manifestProjects.length > 0 ? {manifestProjects, manifestGroups} : {}),
          ...(manifestUnavailableReason ? {manifestUnavailableReason} : {}),
        },
      });
    } catch (error) {
      if (error instanceof NativeDirectoryPickerError) {
        return sendDirectoryPickerError(res, error);
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === 'root_not_found' || reason === 'root_outside_allowlist') {
        return res.json({
          success: true,
          preview: {
            blocked: true,
            blockedReason: reason,
            acceptedFileCount: 0,
            skippedFileCount: 0,
            acceptedFiles: [],
            skippedFiles: [],
          },
        });
      }
      return res.status(400).json({success: false, error: reason});
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
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
          preview: sanitizeEnumeration(enumeration),
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
      res.json({success: true, codebase: sanitizeCodebase(ref), preview: sanitizeEnumeration(enumeration)});
    } catch (error) {
      if (error instanceof NativeDirectoryPickerError) {
        return sendDirectoryPickerError(res, error);
      }
      res.status(400).json({success: false, error: error instanceof Error ? error.message : String(error)});
    }
  });

  router.get('/codebases/:id', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const ref = registry.get(codebaseId, scope);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    res.json({success: true, codebase: sanitizeCodebase(ref)});
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
      if (error instanceof RagSearchInputError) {
        return res.status(400).json({success: false, code: error.code, error: error.message});
      }
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
    try {
      const result = await (ref.kind === 'kernel_source'
        ? kernelSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope})
        : ref.kind === 'aosp' || ref.kind === 'oem_sdk'
          ? aospSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope})
          : appSourceIngester.ingest(codebaseId, {...(req.body ?? {}), scope}));
      if (!result.activationDisposition || !result.coverage) {
        return res.status(400).json({
          success: false,
          error: result.errors[0]?.reason ?? 'codebase_reindex_blocked_by_security',
        });
      }
      res.json({success: true, result});
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get('/codebases/:id/audit', requireCodebaseScope('codebase:read'), (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    const ref = registry.get(codebaseId, scope);
    if (!ref) {
      return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
    }
    res.json({
      success: true,
      audit: {
        codebaseId: ref.codebaseId,
        kind: ref.kind,
        rootAuthorization: ref.rootAuthorization ?? 'configured_allowlist',
        indexGeneration: ref.indexGeneration,
        activeGeneration: activeCodebaseGeneration(ref),
        activeIndexState: ref.activeIndexState ?? 'none',
        selectionPolicyRevision: ref.selectionPolicyRevision ?? 1,
        grantRevision: ref.consent.grant?.revision ?? 1,
        activeIndexCoverage: ref.activeIndexCoverage,
        pendingGeneration: ref.pendingGeneration,
        maintenanceWarning: ref.maintenanceWarning,
        reindexRequired: ref.reindexRequired,
        contentFingerprint: ref.contentFingerprint,
        indexedRevision: ref.indexedRevision,
        indexedDirty: ref.indexedDirty,
        commitProvenance: ref.commitProvenance,
        lastIngestAt: ref.lastIngestAt,
        lastIngestStatus: ref.lastIngestStatus,
        lastIngestError: ref.lastIngestError,
        chunkCount: ref.chunkCount ?? 0,
        blockedFileCount: ref.blockedFileCount ?? 0,
        redactionHitCount: ref.redactionHitCount ?? 0,
      },
    });
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
        ? registry.authorizeAvailableExtensions(routeParam(req.params.id), scope, context.userId)
        : authorizeCurrentSelection
          ? registry.authorizeCurrentSelection(routeParam(req.params.id), scope, context.userId)
        : registry.setProviderConsent(
            routeParam(req.params.id),
            scope,
            req.body.sendToProvider,
            context.userId,
          );
      const cleaned = await cleanupInactiveCodebaseChunks(codebase.codebaseId, scope) ?? codebase;
      return res.json({success: true, codebase: sanitizeCodebase(cleaned)});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return res.status(message.includes('not found') ? 404 : 409).json({
        success: false,
        error: message,
      });
    }
  });

  router.patch('/codebases/:id/selection', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const body = req.body ?? {};
      const hasPathFilters = Object.prototype.hasOwnProperty.call(body, 'pathFilters');
      const hasExcludeGlobs = Object.prototype.hasOwnProperty.call(body, 'excludeGlobs');
      if (!hasPathFilters && !hasExcludeGlobs) throw new Error('selection_patch_empty');
      const codebaseId = routeParam(req.params.id);
      const existing = registry.get(codebaseId, scope);
      if (!existing) {
        return res.status(404).json({success: false, error: `Codebase '${codebaseId}' not found`});
      }
      const pathFilters = hasPathFilters
        ? resolveSourcePathPatterns(body.pathFilters, 'pathFilters')
        : existing.pathFilters;
      const excludeGlobs = hasExcludeGlobs
        ? resolveSourcePathPatterns(body.excludeGlobs, 'excludeGlobs')
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
        throw new Error('`pathFilters` is required for kernel_source codebases');
      }
      const codebase = registry.updateSelectionPolicy(codebaseId, scope, {
        ...(hasPathFilters ? {pathFilters: canonicalPathFilters} : {}),
        ...(hasExcludeGlobs ? {excludeGlobs: canonicalExcludeGlobs} : {}),
      });
      if (codebase.selectionPolicyRevision === existing.selectionPolicyRevision) {
        throw new Error('selection_policy_unchanged');
      }
      const cleaned = await cleanupInactiveCodebaseChunks(codebase.codebaseId, scope) ?? codebase;
      return res.json({success: true, codebase: sanitizeCodebase(cleaned)});
    } catch (error) {
      return res.status(400).json({success: false, error: error instanceof Error ? error.message : String(error)});
    }
  });

  router.post('/codebases/:id/pending/accept', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const selectionPolicyRevision = Number(req.body?.selectionPolicyRevision);
    const grantRevision = Number(req.body?.grantRevision);
    let candidateGenerationId: string;
    try {
      candidateGenerationId = pendingCandidateGenerationId(req.body?.candidateGenerationId);
    } catch (error) {
      return res.status(400).json({success: false, error: (error as Error).message});
    }
    if (!Number.isInteger(selectionPolicyRevision) || !Number.isInteger(grantRevision)) {
      return res.status(400).json({
        success: false,
        error: '`selectionPolicyRevision` and `grantRevision` must be integers',
      });
    }
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    try {
      const codebase = registry.acceptPendingGeneration(
        routeParam(req.params.id),
        scope,
        selectionPolicyRevision,
        grantRevision,
        candidateGenerationId,
      );
      const cleaned = await cleanupInactiveCodebaseChunks(codebase.codebaseId, scope) ?? codebase;
      return res.json({success: true, codebase: sanitizeCodebase(cleaned)});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'pending_generation_expired') {
        const codebaseId = routeParam(req.params.id);
        registry.expirePendingGeneration(codebaseId, scope, candidateGenerationId, Date.now());
        await cleanupInactiveCodebaseChunks(codebaseId, scope);
      }
      return res.status(409).json({success: false, error: message});
    }
  });

  router.post('/codebases/:id/pending/reject', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
    let candidateGenerationId: string;
    try {
      candidateGenerationId = pendingCandidateGenerationId(req.body?.candidateGenerationId);
    } catch (error) {
      return res.status(400).json({success: false, error: (error as Error).message});
    }
    try {
      const before = registry.get(routeParam(req.params.id), scope);
      if (!before) return res.status(404).json({success: false, error: 'codebase_not_found'});
      const codebase = registry.rejectPendingGeneration(
        before.codebaseId,
        scope,
        candidateGenerationId,
      );
      const cleaned = await cleanupInactiveCodebaseChunks(codebase.codebaseId, scope) ?? codebase;
      return res.json({success: true, codebase: sanitizeCodebase(cleaned)});
    } catch (error) {
      return res.status(409).json({success: false, error: error instanceof Error ? error.message : String(error)});
    }
  });

  router.delete('/codebases/:id', requireCodebaseScope('codebase:manage'), async (req, res) => {
    const codebaseId = routeParam(req.params.id);
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    if (!registry.get(codebaseId, scope)) {
      return res.json({
        success: true,
        codebaseId,
        removedChunkCount: 0,
        alreadyDeleted: true,
      });
    }
    let deletionStarted = false;
    try {
      return await registry.withIngestLease(codebaseId, scope, lease => {
        lease.beginDeletion(context.userId);
        deletionStarted = true;
        const removedChunkCount = s.removeCodebaseChunks(codebaseId, scope);
        lease.assertHeld();
        lease.deleteRegistration();
        return res.json({success: true, codebaseId, removedChunkCount});
      }, 'delete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === 'codebase_reindex_in_progress' ||
        message === 'codebase_reindex_lease_lost'
      ) {
        return res.status(409).json({
          success: false,
          code: 'CODEBASE_BUSY',
          error: 'Codebase indexing is in progress; retry deletion after it finishes',
        });
      }
      if (message.includes('not found')) {
        return res.json({
          success: true,
          codebaseId,
          removedChunkCount: 0,
          alreadyDeleted: true,
        });
      }
      return res.status(500).json({
        success: false,
        code: deletionStarted ? 'CODEBASE_DELETE_INCOMPLETE' : 'CODEBASE_DELETE_FAILED',
        error: deletionStarted
          ? 'Codebase is retired from retrieval; retry deletion to finish physical cleanup'
          : 'Codebase deletion failed',
      });
    }
  });

  return router;
}

const ragAdminRoutes = createRagAdminRoutes();
export default ragAdminRoutes;
