// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express from 'express';
import {
  type AgentRuntimeAnalysisResult,
  type Hypothesis,
  type IOrchestrator,
  type StreamingUpdate,
} from '../agent';
import { featureFlagsConfig } from '../config';
import {
  AssistantApplicationService,
  type ManagedAssistantSession,
} from '../assistant/application/assistantApplicationService';
import type { SessionLogger } from '../services/sessionLogger';
import type {AnalysisRunDispatchInput, AnalysisRunDispatchResponse} from '../assistant/application/analysisRunDispatchService';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import {sceneRunOwnerKey} from '../agent/scene/sceneRuntimeBinding';
import {SCENE_TIMELINE_REPORT_PREFIX} from '../agent/scene/sceneTimelineReportAdapter';
import {projectSceneTimelineForClient} from '../agent/scene/sceneTimelineProjection';
import { getTraceProcessorService } from '../services/traceProcessorService';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import { getSceneDeepDiveRoute } from '../agent/config/domainManifest';
import {
  SceneStoryService,
  projectSceneReport,
} from '../agent/scene/sceneStoryService';
import type { SceneReport } from '../agent/scene/types';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import { requireRequestContext } from '../middleware/auth';
import {
  isOwnedByContext,
  ownerFieldsFromContext,
  sendResourceNotFound,
} from '../services/resourceOwnership';
import { readTraceMetadataForContext } from '../services/traceMetadataStore';
import {
  sendAiDisabledErrorIfPresent,
} from './aiCapabilityPolicyHttp';

export interface SceneReconstructConversationStep {
  eventId: string;
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp: number;
  sourceEventType?: string;
}

export interface SceneReconstructSession extends ManagedAssistantSession {
  sceneReconstructionRunId?: string;
  sceneExecutionInFlightRunId?: string;
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  traceId: string;
  query: string;
  outputLanguage?: OutputLanguage;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  logger: SessionLogger;
  /**
   * Only the fields routing needs. Bodies and claims reach a client solely
   * through `projectSceneResult`, which applies the owner projection.
   */
  result?: Pick<AgentRuntimeAnalysisResult, 'sceneTimeline'>;
  /** Set by SceneStoryService once the pipeline completes (fresh or cached). */
  sceneStoryReport?: SceneReport;
  hypotheses: Hypothesis[];
  scenes?: any[];
  trackEvents?: any[];
  agentDialogue: Array<{
    agentId: string;
    type: 'task' | 'response' | 'question';
    content: any;
    timestamp: number;
  }>;
  dataEnvelopes: any[];
  agentResponses: Array<{
    taskId: string;
    agentId: string;
    response: any;
    timestamp: number;
  }>;
  conversationOrdinal: number;
  conversationSteps: SceneReconstructConversationStep[];
}

export function normalizeSceneOutputLanguage(value: unknown): OutputLanguage | null {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_OUTPUT_LANGUAGE;
  }
  return value === 'en' || value === 'zh-CN' ? value : null;
}

export function projectSceneStoryStatusResult(
  report: SceneReport,
  outputLanguage: OutputLanguage,
) {
  const projected = projectSceneReport(report, outputLanguage);
  return {
    reportId: projected.reportId,
    summary: projected.summary,
    scenesCount: projected.displayedScenes.length,
    jobCount: projected.jobs.length,
    partialReport: projected.partialReport,
    executionTimeMs: projected.totalDurationMs,
    cachePolicy: projected.cachePolicy,
  };
}

async function ensureTraceAccessible(
  req: express.Request,
  res: express.Response,
  traceId: string,
): Promise<boolean> {
  if (!await readTraceMetadataForContext(traceId, requireRequestContext(req))) {
    sendResourceNotFound(res, 'Trace not found in backend');
    return false;
  }
  return true;
}

function getAuthorizedSceneSession<TSession extends SceneReconstructSession>(
  req: express.Request,
  res: express.Response,
  deps: RegisterSceneReconstructRoutesDeps<TSession>,
  analysisId: string,
): TSession | null {
  const session = deps.assistantAppService.getSession(analysisId);
  if (!session || !isOwnedByContext(session, requireRequestContext(req))) {
    sendResourceNotFound(res, 'Scene reconstruction session not found');
    return null;
  }
  return session;
}

interface RegisterSceneReconstructRoutesDeps<TSession extends SceneReconstructSession> {
  assistantAppService: AssistantApplicationService<TSession>;
  dispatchSceneAnalysis(input: AnalysisRunDispatchInput): Promise<AnalysisRunDispatchResponse>;
  getRequestId(req: express.Request): string;
  streamSceneAnalysis(req: express.Request, res: express.Response, sessionId: string): Promise<void>;
  checkSceneHistory(req: express.Request, res: express.Response, sessionId: string): Promise<boolean>;
  projectSceneResult(session: TSession): AgentRuntimeAnalysisResult | undefined;
  projectSceneError(session: TSession): string | undefined;
  cancelSceneRun(sessionId: string, runId: string): Promise<{status: number; body: Record<string, unknown>}>;
  isSceneReplayOnlyQuery: (query: string) => boolean;
  buildSceneReplayNarrative: (scenes: any[]) => string;
  /** Historical report access and publication adapter; execution uses shared dispatch. */
  sceneStoryService: SceneStoryService;
}

export function registerSceneReconstructRoutes<TSession extends SceneReconstructSession>(
  router: express.Router,
  deps: RegisterSceneReconstructRoutesDeps<TSession>
): void {
  router.use('/scene-reconstruct', (_req, res, next) => {
    if (!featureFlagsConfig.enableAgentSceneReconstruct) {
      return res.status(503).json({
        success: false,
        error: 'Scene reconstruction feature is disabled by FEATURE_AGENT_SCENE_RECONSTRUCT',
        code: 'FEATURE_DISABLED',
      });
    }
    next();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Preview — cheap cache lookup + cost estimate.
  //
  // Always returns within ~50ms when there's nothing on disk to hash, and
  // within seconds even for multi-GB traces (sha256 streaming). Never
  // starts the heavy pipeline; the response either contains a cached
  // SceneReport (so the client can short-circuit straight to "show me
  // this") or just an estimate the client can use to decide whether to
  // POST /scene-reconstruct.
  // ────────────────────────────────────────────────────────────────────────
  router.post('/scene-reconstruct/preview', async (req, res) => {
    try {
      const { traceId } = req.body ?? {};
      if (!traceId || typeof traceId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }

      if (!await ensureTraceAccessible(req, res, traceId)) {
        return;
      }

      // 404 fast if the trace isn't known to the backend, mirroring the
      // primary POST /scene-reconstruct handler so callers see a consistent
      // error shape.
      const traceProcessorService = getTraceProcessorService();
      const trace = await traceProcessorService.getOrLoadTrace(traceId);
      if (!trace) {
        return res.status(404).json({
          success: false,
          error: 'Trace not found in backend',
          hint: 'Please upload the trace to the backend first',
          code: 'TRACE_NOT_UPLOADED',
        });
      }

      const preview = await deps.sceneStoryService.previewOnly({
        traceId,
        owner: ownerFieldsFromContext(requireRequestContext(req)),
      });

      return res.json({
        success: true,
        traceDurationSec: preview.traceDurationSec,
        estimate: preview.estimate,
        // Only include the cached report's identity here — the full body is
        // available via GET /report/:id so we don't bloat the preview
        // response with potentially-large payloads.
        cached: preview.cached
          ? {
              reportId: preview.cached.reportId,
              createdAt: preview.cached.createdAt,
              expiresAt: preview.cached.expiresAt,
              cachePolicy: preview.cached.cachePolicy,
              partialReport: preview.cached.partialReport,
              sceneCount: preview.cached.displayedScenes.length,
              jobCount: preview.cached.jobs.length,
            }
          : null,
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Scene reconstruction preview error:', error);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'Failed to compute scene reconstruction preview',
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET a previously persisted SceneReport by reportId.
  //
  // Returns the FULL SceneReport so the client can rebuild the entire UI
  // (lane overlays via cachedDataEnvelopes, scene list, jobs, summary).
  // 404s when the report has expired or never existed.
  // ────────────────────────────────────────────────────────────────────────
  router.get('/scene-reconstruct/report/:reportId', async (req, res) => {
    try {
      const { reportId } = req.params;
      const outputLanguage = normalizeSceneOutputLanguage(req.query.outputLanguage);
      if (!outputLanguage) {
        return res.status(400).json({
          success: false,
          error: 'outputLanguage must be en or zh-CN',
          code: 'UNSUPPORTED_OUTPUT_LANGUAGE',
        });
      }
      const report = reportId.startsWith(SCENE_TIMELINE_REPORT_PREFIX)
        ? await deps.sceneStoryService.getFinalizedReport(sceneRunOwnerKey(ownerFieldsFromContext(requireRequestContext(req))), reportId)
        : await deps.sceneStoryService.getReport(reportId);
      if (!report || !isOwnedByContext(report, requireRequestContext(req)) ||
          !await readTraceMetadataForContext(report.traceId, requireRequestContext(req))) {
        return sendResourceNotFound(res, 'Report not found or expired');
      }
      return res.json({
        success: true,
        report: projectSceneReport(report, outputLanguage),
      });
    } catch (error: any) {
      console.error('[AgentRoutes] getReport error:', error);
      return res.status(500).json({
        success: false,
        error: error?.message ?? 'Failed to load scene reconstruction report',
      });
    }
  });

  router.post('/scene-reconstruct', async (req, res) => {
    try {
      const { traceId } = req.body ?? {};
      const rawOptions = req.body?.options;
      if (
        rawOptions !== undefined &&
        (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
      ) {
        return res.status(400).json({
          success: false,
          error: 'options must be an object',
          code: 'INVALID_SCENE_OPTIONS',
        });
      }
      const options = (rawOptions ?? {}) as Record<string, unknown>;
      for (const field of ['generateTracks', 'forceRefresh'] as const) {
        if (options[field] !== undefined && typeof options[field] !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: `${field} must be a boolean`,
            code: 'INVALID_SCENE_OPTIONS',
          });
        }
      }

      if (!traceId || typeof traceId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'traceId is required',
        });
      }
      const outputLanguage = normalizeSceneOutputLanguage(options.outputLanguage);
      if (!outputLanguage) {
        return res.status(400).json({
          success: false,
          error: 'outputLanguage must be en or zh-CN',
          code: 'UNSUPPORTED_OUTPUT_LANGUAGE',
        });
      }

      const query = renderRequiredLocalizedStrategyTemplate('prompt-scene-reconstruction-query', outputLanguage, {});
      // Shared admission owns permissions, provider pinning, one run and terminal cleanup.
      // Legacy cache flags remain accepted, but never select a separate model pipeline.
      const {generateTracks: _tracks, forceRefresh: _refresh, ...analysisOptions} = options;
      const response = await deps.dispatchSceneAnalysis({entry: 'scene_reconstruction',
        requestId: deps.getRequestId(req), context: requireRequestContext(req),
        body: {traceId, query, providerId: req.body?.providerId,
          options: {...analysisOptions, outputLanguage, analysisMode: 'full'}}});
      return res.status(response.status).json({...response.body,
        ...(response.body.sessionId ? {analysisId: response.body.sessionId} : {})});
    } catch (error: any) {
      if (sendAiDisabledErrorIfPresent(res, error)) {
        return;
      }
      console.error('[AgentRoutes] Scene reconstruction start error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to start scene reconstruction',
      });
    }
  });

  router.get('/scene-reconstruct/:analysisId/stream', async (req, res) => {
    await deps.streamSceneAnalysis(req, res, req.params.analysisId);
  });

  router.get('/scene-reconstruct/:analysisId/tracks', async (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session || !await deps.checkSceneHistory(req, res, analysisId)) return;

    const canonical = deps.projectSceneResult(session);
    if (session.status !== 'completed' && !canonical?.sceneTimeline) {
      return res.status(400).json({
        success: false,
        error: 'Analysis not yet completed',
        status: session.status,
      });
    }

    res.json({
      success: true,
      tracks: session.trackEvents || [],
      scenes: session.scenes || [],
      sceneTimeline: canonical?.sceneTimeline ? projectSceneTimelineForClient(canonical.sceneTimeline) : undefined,
    });
  });

  router.get('/scene-reconstruct/:analysisId/status', async (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session || !await deps.checkSceneHistory(req, res, analysisId)) return;

    const response: any = {
      success: true,
      analysisId,
      status: session.status,
    };
    // Every body comes from `projectSceneResult`: the stored result for this
    // run, owner-projected exactly as `/:sessionId/status` serves it.
    const canonical = deps.projectSceneResult(session);
    if (canonical?.sceneTimeline) {
      response.result = {narrative: canonical.conclusion, partial: canonical.partial,
        sceneTimeline: projectSceneTimelineForClient(canonical.sceneTimeline), sceneReport: canonical.sceneReport,
        confidence: canonical.confidence, executionTimeMs: canonical.totalDurationMs,
        scenesCount: canonical.sceneTimeline.segments.length};
    } else if (session.status === 'completed' && canonical) {
      // An agent-driven run without a scene timeline.
      response.result = {
        narrative: deps.isSceneReplayOnlyQuery(session.query)
          ? deps.buildSceneReplayNarrative(session.scenes || [])
          : canonical.conclusion,
        confidence: canonical.confidence,
        executionTimeMs: canonical.totalDurationMs,
        scenesCount: session.scenes?.length || 0,
        tracksCount: session.trackEvents?.length || 0,
      };
    } else if (session.status === 'completed' && session.sceneStoryReport) {
      // The Scene Story pipeline.
      response.result = projectSceneStoryStatusResult(
        session.sceneStoryReport,
        session.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
      );
    }

    if (session.status === 'failed') {
      response.error = deps.projectSceneError(session);
    }

    res.json(response);
  });

  // Deep-dive: execute a skill scoped to a specific event.
  // Route resolution lives in domainManifest.sceneDeepDiveRoutes — see
  // getSceneDeepDiveRoute() for the lookup implementation.
  router.post('/scene-reconstruct/:analysisId/deep-dive', async (req, res) => {
    try {
      const { analysisId } = req.params;
      const { eventId, eventType, startTs, endTs, appPackage } = req.body;

      const session = getAuthorizedSceneSession(req, res, deps, analysisId);
      if (!session || !await deps.checkSceneHistory(req, res, analysisId)) return;
      if (session.sceneReconstructionRunId || session.result?.sceneTimeline) {
        return res.status(409).json({success: false, code: 'SCENE_INVESTIGATION_REQUIRED',
          error: 'Continue through the analysis entrypoint to investigate a scene with current run authorization'});
      }

      const route = getSceneDeepDiveRoute(eventType);
      if (!route) {
        return res.status(400).json({
          success: false,
          error: `No deep-dive route for event type: ${eventType}`,
        });
      }

      await ensureSkillRegistryInitialized();
      const traceProcessorService = getTraceProcessorService();
      const skillExecutor = new SkillExecutor(traceProcessorService);
      skillExecutor.registerSkills(skillRegistry.getAllSkills());

      // Params built from the flat request body for now; the manifest's
      // paramMapping will start being exercised once the frontend sends
      // full scene context instead of {startTs,endTs,appPackage}.
      const params: Record<string, any> = {
        start_ts: startTs,
        end_ts: endTs,
      };
      if (appPackage) params.package = appPackage;

      const result = await skillExecutor.execute(route.skillId, session.traceId, params);

      res.json({
        success: true,
        eventId,
        skillId: route.skillId,
        description: route.description,
        result: result.displayResults,
      });
    } catch (error: any) {
      console.error('[AgentRoutes] Deep-dive error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Deep-dive analysis failed',
      });
    }
  });

  // User-requested cancel for an in-flight Scene Story run. Distinct from
  // DELETE which tears down the whole session — cancel keeps the session
  // and any partial results so the frontend can render whatever jobs
  // already completed before the cancel landed.
  router.post('/scene-reconstruct/:analysisId/cancel', async (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;
    const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
    if (!runId) return res.status(400).json({success: false, code: 'RUN_ID_REQUIRED', error: 'runId is required for cancellation'});
    const response = await deps.cancelSceneRun(analysisId, runId);
    return res.status(response.status).json(response.body);
  });

  router.delete('/scene-reconstruct/:analysisId', async (req, res) => {
    const { analysisId } = req.params;
    const session = getAuthorizedSceneSession(req, res, deps, analysisId);
    if (!session) return;
    if (session.sceneExecutionInFlightRunId || ['pending', 'running', 'awaiting_user'].includes(session.status)) {
      return res.status(409).json({success: false, code: 'RUN_ALREADY_ACTIVE',
        error: 'Cancel the active scene run and wait for cleanup before deleting its session'});
    }
    // Keep the exact object registered and closed to admission across async
    // runtime cleanup. Removing it early would let persistence restore this ID.
    const deletionMarker = `delete:${analysisId}`;
    session.sceneExecutionInFlightRunId = deletionMarker;
    session.lastActivityAt = Date.now();

    session.sseClients.forEach((client) => {
      try {
        client.end();
      } catch {
        // Ignore closed sockets.
      }
    });

    try {
      await Promise.resolve(session.orchestrator.cleanupSession?.(analysisId));
      if (deps.assistantAppService.getSession(analysisId) === session) deps.assistantAppService.deleteSession(analysisId);
      return res.json({success: true});
    } catch {
      return res.status(500).json({success: false, error: 'Failed to clean up scene session'});
    } finally {
      if (session.sceneExecutionInFlightRunId === deletionMarker) session.sceneExecutionInFlightRunId = undefined;
    }
  });
}
