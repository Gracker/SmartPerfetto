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
  codebaseRegistrationRequirements,
  CodebaseRegistry,
  type CodebaseRef,
  isCodebaseKind,
} from '../services/codebase/codebaseRegistry';
import {getDefaultCodebaseRegistry} from '../services/codebase/defaultCodebaseServices';
import {PathSecurityGate, type PathPreviewResult} from '../services/codebase/pathSecurityGate';
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
    eligibleForSendToProvider: consent.sendToProvider,
    consent: {
      sendToProvider: consent.sendToProvider,
      consentedAt: consent.consentedAt,
      consentedBy: consent.consentedBy,
      consentHash: consent.consentHash,
    },
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

function sanitizePreview(preview: PathPreviewResult) {
  return {
    blocked: preview.blocked,
    ...(preview.blockedReason ? {blockedReason: preview.blockedReason} : {}),
    acceptedFileCount: preview.acceptedFiles.length,
    skippedFileCount: preview.skippedFileCount,
    acceptedFiles: preview.acceptedFiles.slice(0, 200),
    skippedFiles: preview.skippedFiles.slice(0, 200),
  };
}

function sanitizeExternalKnowledgeSource(source: ExternalKnowledgeSource) {
  const {rootRealpath: _rootRealpath, scope: _scope, ...safeSource} = source;
  return safeSource;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

/** Test/factory hook. */
export function createRagAdminRoutes(store?: RagStore, services: RagAdminRouteServices = {}): ExpressRouter {
  const s = store ?? getDefaultRagStore();
  const registry = services.registry ?? getDefaultCodebaseRegistry();
  const gate = services.gate ?? new PathSecurityGate();
  const appSourceIngester = services.appSourceIngester ?? new AppSourceIngester(s, registry, gate);
  const aospSourceIngester = services.aospSourceIngester ?? new AospSourceIngester(s, registry, gate);
  const kernelSourceIngester = services.kernelSourceIngester ?? new KernelSourceIngester(s, registry, gate);
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
          activeCodebaseGenerations: Object.fromEntries(authorizedCodebaseIds.map((codebaseId, index) => [
            codebaseId,
            activeCodebaseGeneration(authorizedCodebases![index]!),
          ])),
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

  router.get('/codebases', requireCodebaseScope('codebase:read'), (req, res) => {
    const scope = knowledgeScopeFromRequestContext(requireRequestContext(req));
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
    const {rootPath, directorySelectionId} = (req.body ?? {}) as {
      rootPath?: string;
      directorySelectionId?: string;
    };
    if (!rootPath || typeof rootPath !== 'string') {
      return res.status(400).json({success: false, error: '`rootPath` is required'});
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
      const preview = await gate.preview(
        rootPath,
        selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : undefined,
      );
      return res.json({success: true, preview: sanitizePreview(preview)});
    } catch (error) {
      if (error instanceof NativeDirectoryPickerError) {
        return sendDirectoryPickerError(res, error);
      }
      throw error;
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
    const preview = await gate.preview(
      rootPath,
      selectedRoot ? {additionalAllowlistRoots: [selectedRoot]} : undefined,
    );
    if (preview.blocked) {
      return res.status(400).json({
        success: false,
        error: preview.blockedReason ?? 'root blocked by path security gate',
        preview: sanitizePreview(preview),
      });
    }
    try {
      const register = () => registry.register({
        kind,
        displayName: normalizedDisplayName ||
          path.basename(preview.rootRealpath) ||
          'Source code',
        rootPath,
        rootRealpath: preview.rootRealpath,
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
      res.json({success: true, codebase: sanitizeCodebase(ref), preview: sanitizePreview(preview)});
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

  router.patch('/codebases/:id/consent', requireCodebaseScope('codebase:manage'), (req, res) => {
    if (typeof req.body?.sendToProvider !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: '`sendToProvider` must be an explicit boolean',
      });
    }
    const context = requireRequestContext(req);
    const scope = knowledgeScopeFromRequestContext(context);
    try {
      const codebase = registry.setProviderConsent(
        routeParam(req.params.id),
        scope,
        req.body.sendToProvider,
        context.userId,
      );
      return res.json({success: true, codebase: sanitizeCodebase(codebase)});
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
