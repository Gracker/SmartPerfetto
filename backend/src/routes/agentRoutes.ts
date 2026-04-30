// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Agent Analysis Routes
 *
 * API endpoints for Agent-based trace analysis using the agent-driven architecture
 */

import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getTraceProcessorService } from '../services/traceProcessorService';
import {
  createSessionLogger,
  SessionLogger,
} from '../services/sessionLogger';
import { getHTMLReportGenerator } from '../services/htmlReportGenerator';
import { buildAgentDrivenReportData } from '../services/agentReportData';
import { persistAgentTurn } from '../services/persistAgentSession';
import { normalizeNarrativeForClient as sharedNormalizeNarrative } from '../services/agentResultNormalizer';
import { reportStore, persistReport } from './reportRoutes';
import { SessionPersistenceService } from '../services/sessionPersistenceService';
import { authenticate } from '../middleware/auth';
import {
  sessionContextManager,
  EnhancedSessionContext,
} from '../agent/context/enhancedSessionContext';
import {
  registerCoreTools,
  StreamingUpdate,
  createAgentRuntime,
  AgentRuntimeAnalysisResult,
  ModelRouter,
  Hypothesis,
} from '../agent';
import type { IOrchestrator } from '../agent/core/orchestratorTypes';
import {
  deriveConclusionContract,
  normalizeConclusionOutput,
  shouldNormalizeConclusionOutput,
} from '../agent/core/conclusionGenerator';
import { resolveConclusionScene } from '../agent/core/conclusionSceneTemplates';
import { DEEP_REASON_LABEL } from '../utils/analysisNarrative';
import { sanitizeNarrativeForClient } from './narrativeSanitizer';
import { registerSceneReconstructRoutes } from './agentSceneReconstructRoutes';
import { SceneStoryService } from '../agent/scene/sceneStoryService';
import { FileSystemSceneReportStore } from '../services/sceneReport/sceneReportStore';
import { SceneReportMemoryCache } from '../services/sceneReport/sceneReportMemoryCache';
import { computeTraceContentHash } from '../agent/scene/traceHash';
import { probeTraceDuration } from '../agent/scene/sceneTraceDurationProbe';
import { sceneStoryConfig } from '../config';
import { registerAgentLogsRoutes } from './agentLogsRoutes';
import { registerAgentQuickSceneRoutes } from './agentQuickSceneRoutes';
import { registerAgentReportRoutes } from './agentReportRoutes';
import { registerAgentResumeRoutes } from './agentResumeRoutes';
import { registerAgentSessionCatalogRoutes } from './agentSessionCatalogRoutes';
import { registerTeachingRoutes } from './agentTeachingRoutes';
import { AssistantApplicationService } from '../assistant/application/assistantApplicationService';
import { StreamProjector, SSE_RING_BUFFER_SIZE } from '../assistant/stream/streamProjector';
import {
  AgentAnalyzeSessionService,
  AnalyzeSessionPreparationError,
  type AnalyzeSessionRunContext,
} from '../assistant/application/agentAnalyzeSessionService';
import { buildAssistantResultContract } from '../assistant/contracts/assistantResultContract';
// Agent-Driven Architecture v2.0 - Intervention & Focus
import type { UserDecision, AnalysisDirective } from '../agent/core/interventionController';
import type { FocusInteraction } from '../agent/context/focusStore';
// DataEnvelope types for v2.0 data contract
import {
  createDataEnvelope,
  generateEventId,
  type DataEnvelope,
} from '../types/dataContract';
import { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { skillRegistry, ensureSkillRegistryInitialized } from '../services/skillEngine/skillLoader';
import type { ConversationTurn, Finding, Intent } from '../agent/types';
import {
  validateFeedbackInput,
  enrichFeedbackEntry,
  type SessionLookup as FeedbackSessionLookup,
} from '../agentv3/selfImprove/feedbackEnricher';
import { applyFeedbackToPattern } from '../agentv3/analysisPatternMemory';

const router = express.Router();

interface AgentRequestWithObservability extends express.Request {
  assistantRequestId?: string;
}

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 128;

function sanitizeRequestId(raw: unknown): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  const normalized = text.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, MAX_REQUEST_ID_LENGTH);
  return normalized;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resolveRequestIdFromRequest(req: express.Request): string {
  const headerId =
    req.header(REQUEST_ID_HEADER) ||
    req.header('x-correlation-id') ||
    req.header('x-amzn-trace-id');
  const bodyId =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).requestId
      : undefined;

  return sanitizeRequestId(headerId) || sanitizeRequestId(bodyId) || generateRequestId();
}

function getRequestId(req: express.Request): string {
  return (req as AgentRequestWithObservability).assistantRequestId || resolveRequestIdFromRequest(req);
}

function normalizeRunSequence(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(Number(value)));
}

function buildRunId(sessionId: string, sequence: number): string {
  return `run-${sessionId}-${sequence}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildSessionObservability(
  session: AnalysisSession
): { runId: string; requestId: string; runSequence: number; status: string } | undefined {
  const run = session.activeRun || session.lastRun;
  if (!run) return undefined;
  return {
    runId: run.runId,
    requestId: run.requestId,
    runSequence: normalizeRunSequence(run.sequence),
    status: run.status,
  };
}

function buildStreamObservability(
  session: AnalysisSession
): { runId?: string; requestId?: string; runSequence?: number } {
  const run = session.activeRun || session.lastRun;
  if (!run) return {};
  return {
    runId: run.runId,
    requestId: run.requestId,
    runSequence: normalizeRunSequence(run.sequence),
  };
}

function startSessionRun(
  session: AnalysisSession,
  query: string,
  requestId: string
): AnalyzeSessionRunContext {
  const nextSequence = normalizeRunSequence(session.runSequence) + 1;
  session.runSequence = nextSequence;

  const run: AnalyzeSessionRunContext = {
    runId: buildRunId(session.sessionId, nextSequence),
    requestId: sanitizeRequestId(requestId) || generateRequestId(),
    sequence: nextSequence,
    query,
    startedAt: Date.now(),
    status: 'pending',
  };
  session.activeRun = run;
  session.lastRun = run;

  // Record query in cross-turn history (append-only, never overwritten)
  if (!session.queryHistory) session.queryHistory = [];
  session.queryHistory.push({ turn: nextSequence, query, timestamp: Date.now() });

  // Inject turn boundary marker for multi-turn conversations
  if (nextSequence > 1) {
    session.conversationOrdinal = (Number.isFinite(session.conversationOrdinal) ? session.conversationOrdinal : 0) + 1;
    const boundaryOrdinal = session.conversationOrdinal;
    session.conversationSteps.push({
      eventId: `turn-boundary-${session.sessionId}-${nextSequence}`,
      ordinal: boundaryOrdinal,
      phase: 'progress',
      role: 'system',
      text: `── 第 ${nextSequence} 轮对话开始 ──`,
      timestamp: Date.now(),
      sourceEventType: 'turn_boundary',
    });
  }

  return run;
}

function markSessionRunStatus(
  session: AnalysisSession,
  status: AnalyzeSessionRunContext['status'],
  error?: string
): void {
  if (!session.activeRun) return;
  session.activeRun.status = status;
  if (status === 'completed' || status === 'failed') {
    session.activeRun.completedAt = Date.now();
  }
  session.activeRun.error = error;
  session.lastRun = { ...session.activeRun };
}

// Attach/echo requestId for all agent endpoints.
router.use((req, res, next) => {
  const requestId = resolveRequestIdFromRequest(req);
  (req as AgentRequestWithObservability).assistantRequestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
});

// Apply API-key auth to all Agent endpoints (dev fallback still applies when key is not configured).
router.use(authenticate);

// ============================================================================
// Session Tracking (Agent-Driven)
// ============================================================================

interface AnalysisSession {
  orchestrator: IOrchestrator;
  orchestratorUpdateHandler?: (update: StreamingUpdate) => void;
  sessionId: string;
  sseClients: express.Response[];
  result?: AgentRuntimeAnalysisResult;
  status: 'pending' | 'running' | 'awaiting_user' | 'completed' | 'failed';
  error?: string;
  traceId: string;
  /** Reference trace ID for comparison mode (dual-trace analysis) */
  referenceTraceId?: string;
  query: string;
  createdAt: number;
  lastActivityAt: number;
  logger: SessionLogger;
  hypotheses: Hypothesis[];
  // Optional scene reconstruction artifacts (unified into agent-driven sessions)
  scenes?: DetectedScene[];
  trackEvents?: TrackEvent[];
  // Continuous state timeline lanes (from state_timeline skill)
  stateTimeline?: Record<string, StateLaneSegment[]>;
  laneAvailability?: Record<string, 'available' | 'table_missing' | 'no_data'>;
  agentDialogue: Array<{
    agentId: string;
    type: 'task' | 'response' | 'question';
    content: any;
    timestamp: number;
  }>;
  dataEnvelopes: DataEnvelope[];
  agentResponses: Array<{
    taskId: string;
    agentId: string;
    response: any;
    timestamp: number;
  }>;
  conversationOrdinal: number;
  conversationSteps: Array<{
    eventId: string;
    ordinal: number;
    phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
    role: 'agent' | 'system';
    text: string;
    timestamp: number;
    sourceEventType?: string;
  }>;
  runSequence?: number;
  activeRun?: AnalyzeSessionRunContext;
  lastRun?: AnalyzeSessionRunContext;
  /** Cross-turn query history — appended on each turn, never overwritten */
  queryHistory: Array<{ turn: number; query: string; timestamp: number }>;
  /** Cross-turn conclusion history — appended after each turn completes */
  conclusionHistory: Array<{ turn: number; conclusion: string; confidence: number; timestamp: number }>;
  /** F3: Monotonic SSE event counter for replay on reconnect */
  sseEventSeq: number;
  /** F3: Ring buffer of recent SSE events for replay on reconnect */
  sseEventBuffer: import('../assistant/stream/streamProjector').BufferedSseEvent[];
}
const assistantAppService = new AssistantApplicationService<AnalysisSession>();
const streamProjector = new StreamProjector();

let modelRouterInstance: ModelRouter | null = null;

function getModelRouter(): ModelRouter {
  if (!modelRouterInstance) {
    modelRouterInstance = new ModelRouter();
  }
  return modelRouterInstance;
}

type TurnHistorySource = 'memory' | 'persistence';

interface ResolvedSessionContext {
  context: EnhancedSessionContext;
  source: TurnHistorySource;
  traceId: string;
  query?: string;
  createdAt?: number;
}

function resolveSessionContextForReview(sessionId: string): ResolvedSessionContext | null {
  const activeSession = assistantAppService.getSession(sessionId);
  if (activeSession) {
    const activeContext =
      sessionContextManager.get(sessionId, activeSession.traceId) ||
      sessionContextManager.get(sessionId);
    if (activeContext) {
      return {
        context: activeContext,
        source: 'memory',
        traceId: activeSession.traceId,
        query: activeSession.query,
        createdAt: activeSession.createdAt,
      };
    }
  }

  const memoryContext = sessionContextManager.get(sessionId);
  if (memoryContext) {
    return {
      context: memoryContext,
      source: 'memory',
      traceId: memoryContext.getTraceId(),
      query: activeSession?.query,
      createdAt: activeSession?.createdAt,
    };
  }

  const persistenceService = SessionPersistenceService.getInstance();
  const persistedSession = persistenceService.getSession(sessionId);
  if (!persistedSession) {
    return null;
  }

  const persistedContext = persistenceService.loadSessionContext(sessionId);
  if (!persistedContext) {
    return null;
  }

  return {
    context: persistedContext,
    source: 'persistence',
    traceId: persistedSession.traceId,
    query: persistedSession.question,
    createdAt: persistedSession.createdAt,
  };
}

function buildTurnSeverityCounts(turn: ConversationTurn): Record<string, number> {
  const counts: Record<string, number> = {
    critical: 0,
    high: 0,
    warning: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const finding of turn.findings || []) {
    const severity = String(finding?.severity || '').toLowerCase();
    if (severity in counts) {
      counts[severity] += 1;
    } else {
      counts.info += 1;
    }
  }

  return counts;
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
  ) as T;
}

function buildTurnSummary(turn: ConversationTurn) {
  const confidence =
    typeof turn.result?.confidence === 'number'
      ? turn.result.confidence
      : undefined;
  const sanitizedConclusion = typeof turn.result?.message === 'string'
    ? normalizeNarrativeForClient(turn.result.message)
    : '';
  const conclusionPreview = sanitizedConclusion
    ? sanitizedConclusion.replace(/\s+/g, ' ').slice(0, 240)
    : undefined;

  return {
    turnId: turn.id,
    turnIndex: turn.turnIndex,
    timestamp: turn.timestamp,
    query: turn.query,
    intent: {
      primaryGoal: turn.intent?.primaryGoal || '',
      followUpType: turn.intent?.followUpType || 'initial',
      aspects: Array.isArray(turn.intent?.aspects) ? turn.intent.aspects : [],
    },
    completed: !!turn.completed,
    success: typeof turn.result?.success === 'boolean' ? turn.result.success : null,
    confidence,
    findingCount: Array.isArray(turn.findings) ? turn.findings.length : 0,
    severityCounts: buildTurnSeverityCounts(turn),
    conclusionPreview,
  };
}

function buildTurnDetail(turn: ConversationTurn) {
  const summary = buildTurnSummary(turn);
  return {
    ...summary,
    intent: toJsonSafe(turn.intent),
    result: turn.result
      ? toJsonSafe({
          ...turn.result,
          message:
            typeof turn.result.message === 'string'
              ? normalizeNarrativeForClient(turn.result.message)
              : turn.result.message,
        })
      : null,
    findings: toJsonSafe(turn.findings || []),
  };
}

function getLastCompletedTurn(context: EnhancedSessionContext): ConversationTurn | null {
  const turns = context.getAllTurns();
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.completed && turn.result) {
      return turn;
    }
  }
  return null;
}

function buildRecoveredResultFromContext(
  sessionId: string,
  context: EnhancedSessionContext
): AgentRuntimeAnalysisResult | null {
  const turn = getLastCompletedTurn(context);
  if (!turn || !turn.result) {
    return null;
  }

  const conclusion = typeof turn.result.message === 'string' && turn.result.message.trim().length > 0
    ? turn.result.message
    : `已恢复会话历史。可通过 /api/agent/v1/${sessionId}/turns 查看历史轮次。`;
  const confidence =
    typeof turn.result.confidence === 'number'
      ? turn.result.confidence
      : 0.5;

  return {
    sessionId,
    success: turn.result.success !== false,
    findings: Array.isArray(turn.findings) ? turn.findings : [],
    hypotheses: [],
    conclusion,
    confidence,
    rounds: 1,
    totalDurationMs: 0,
    partial: turn.result.partial,
    terminationReason: turn.result.terminationReason as AgentRuntimeAnalysisResult['terminationReason'],
    terminationMessage: turn.result.terminationMessage,
  };
}

function recoverResultForSessionIfNeeded(sessionId: string, session: AnalysisSession): AgentRuntimeAnalysisResult | null {
  if (session.result) {
    return session.result;
  }

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return null;
  }

  const recovered = buildRecoveredResultFromContext(sessionId, resolved.context);
  if (!recovered) {
    return null;
  }

  session.result = recovered;
  const turns = resolved.context.getAllTurns();
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  if (latestTurn?.query) {
    session.query = latestTurn.query;
  }
  return recovered;
}

function buildFallbackIntentFromQuery(query?: string): Intent | null {
  const primaryGoal = String(query || '').trim();
  if (!primaryGoal) return null;

  return {
    primaryGoal,
    aspects: [],
    expectedOutputType: 'summary',
    complexity: 'simple',
    followUpType: 'initial',
  };
}

function resolveConclusionSceneIdHint(params: {
  sessionId: string;
  query?: string;
  findings?: Finding[];
  intent?: Intent;
}): string | undefined {
  const findings = Array.isArray(params.findings) ? params.findings : [];
  let intent = params.intent;

  if (!intent) {
    const resolved = resolveSessionContextForReview(params.sessionId);
    const turn = resolved ? getLastCompletedTurn(resolved.context) : null;
    if (turn?.intent) {
      intent = turn.intent;
    }
  }

  if (!intent) {
    intent = buildFallbackIntentFromQuery(params.query) || undefined;
  }

  if (!intent) return undefined;

  try {
    return resolveConclusionScene({
      intent,
      findings,
      deepReasonLabel: DEEP_REASON_LABEL,
    }).selectedTemplate.id;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Scene Reconstruction Types (kept for backward-compatible API responses)
// =============================================================================

type SceneCategory =
  | 'cold_start'
  | 'warm_start'
  | 'hot_start'
  | 'scroll_start'
  | 'scroll'
  | 'inertial_scroll'
  | 'navigation'
  | 'app_switch'
  | 'home_screen'
  | 'app_foreground'
  | 'screen_on'
  | 'screen_off'
  | 'screen_sleep'
  | 'screen_unlock'
  | 'notification'
  | 'split_screen'
  | 'tap'
  | 'long_press'
  | 'idle'
  | 'jank_region'
  | 'back_key'
  | 'home_key'
  | 'recents_key'
  | 'anr'
  | 'ime_show'
  | 'ime_hide'
  | 'window_transition';

interface DetectedScene {
  type: SceneCategory;
  startTs: string;
  endTs: string;
  durationMs: number;
  confidence: number;
  appPackage?: string;
  metadata?: Record<string, any>;
}

interface TrackEvent {
  ts: string;
  dur: string;
  name: string;
  category: 'scene' | 'action' | 'performance' | 'finding';
  colorScheme: 'scroll' | 'tap' | 'launch' | 'system' | 'jank' | 'navigation';
  details?: Record<string, any>;
}

// Initialize Agent tools once
let toolsRegistered = false;
const SCENE_STRATEGY_IDS = ['scene_reconstruction', 'scene_reconstruction_quick'];
const MAX_SESSION_DATA_ENVELOPES = 1200;
const MAX_SESSION_AGENT_DIALOGUE = 800;
const MAX_SESSION_AGENT_RESPONSES = 400;
const TERMINAL_SESSION_MAX_IDLE_MS = 30 * 60 * 1000;
const NON_TERMINAL_SESSION_MAX_IDLE_MS = 2 * 60 * 60 * 1000;

function trimSessionArray<T>(items: T[], maxEntries: number): void {
  if (items.length > maxEntries) {
    items.splice(0, items.length - maxEntries);
  }
}

function pushWithSessionCap<T>(items: T[], value: T, maxEntries: number): void {
  items.push(value);
  trimSessionArray(items, maxEntries);
}

function ensureToolsRegistered() {
  if (!toolsRegistered) {
    registerCoreTools();
    toolsRegistered = true;
    console.log('[AgentRoutes] Core tools registered');
  }
}

function isDedicatedSceneReplayRequest(query: string): boolean {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return false;
  return (
    q === '/scene' ||
    q.includes('场景还原') ||
    q.includes('scene reconstruction') ||
    q.includes('scene replay')
  );
}

// ============================================================================
// Main Analysis Endpoints
// ============================================================================

/**
 * POST /api/agent/v1/analyze
 *
 * Start analysis using AgentRuntime
 *
 * Features:
 * - Agent-driven task graph planning
 * - Domain agent evidence collection
 * - Multi-round analysis with strategy planning
 * - DataEnvelope streaming
 *
 * Body:
 * {
 *   "traceId": "uuid-of-trace",
 *   "query": "分析这个 trace 的滑动性能",
 *   "options": {
 *     "maxRounds": 5,
 *     "confidenceThreshold": 0.7,
 *     "maxNoProgressRounds": 2,
 *     "maxFailureRounds": 2,
 *     "maxConcurrentTasks": 3
 *   }
 * }
 */
router.post('/analyze', async (req, res) => {
  try {
    const requestId = getRequestId(req);
    const { traceId, query, sessionId: requestedSessionId, options = {}, selectionContext: rawSelectionContext, referenceTraceId, traceContext: rawTraceContext } = req.body;

    if (!traceId) {
      return res.status(400).json({
        success: false,
        error: 'traceId is required',
      });
    }

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'query is required',
      });
    }

    if (isDedicatedSceneReplayRequest(query)) {
      return res.status(400).json({
        success: false,
        code: 'SCENE_REPLAY_SEPARATED',
        error: '场景还原已独立为专用功能',
        hint: '请使用 /scene 命令（前端）或 POST /api/agent/v1/scene-reconstruct（后端）',
      });
    }

    // Validate selectionContext — strip invalid payloads silently instead of rejecting
    let selectionContext: typeof rawSelectionContext | undefined;
    if (rawSelectionContext && typeof rawSelectionContext === 'object') {
      const sc = rawSelectionContext;
      if (sc.kind === 'area' && typeof sc.startNs === 'number' && typeof sc.endNs === 'number') {
        selectionContext = sc;
      } else if (sc.kind === 'track_event' && typeof sc.eventId === 'number' && typeof sc.ts === 'number') {
        selectionContext = sc;
      }
      // Otherwise: invalid kind or missing required fields — selectionContext stays undefined
    }

    // Verify trace exists
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

    // Comparison mode: validate reference trace if provided
    if (referenceTraceId) {
      if (referenceTraceId === traceId) {
        return res.status(400).json({
          success: false,
          error: 'referenceTraceId must be different from traceId',
          code: 'SAME_TRACE_COMPARISON',
        });
      }
      const refTrace = await traceProcessorService.getOrLoadTrace(referenceTraceId);
      if (!refTrace) {
        return res.status(404).json({
          success: false,
          error: 'Reference trace not found in backend',
          hint: 'Please upload the reference trace to the backend first',
          code: 'REFERENCE_TRACE_NOT_UPLOADED',
        });
      }
      console.log(`[AgentRoutes] Comparison mode: current=${traceId}, reference=${referenceTraceId}`);
    }

    // Initialize tools
    ensureToolsRegistered();

    const analyzeSessionService = new AgentAnalyzeSessionService<AnalysisSession>({
      assistantAppService,
      getModelRouter,
      createSessionLogger,
      sessionPersistenceService: SessionPersistenceService.getInstance(),
      buildRecoveredResultFromContext,
    });

    let sessionId: string;
    let preparedSession: AnalysisSession | undefined;
    let isNewSession = true;
    try {
      const prepared = analyzeSessionService.prepareSession({
        traceId,
        query,
        requestedSessionId,
        options,
      });
      sessionId = prepared.sessionId;
      preparedSession = prepared.session as AnalysisSession;
      isNewSession = prepared.isNewSession;
    } catch (error: any) {
      if (error instanceof AnalyzeSessionPreparationError) {
        return res.status(error.httpStatus).json({
          success: false,
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
        });
      }
      throw error;
    }

    const blockedStrategyIds = Array.from(new Set([
      ...SCENE_STRATEGY_IDS,
      ...(Array.isArray(options.blockedStrategyIds) ? options.blockedStrategyIds : []),
    ]));
    const sessionForRun = preparedSession || assistantAppService.getSession(sessionId);
    if (!sessionForRun) {
      throw new Error(`Session ${sessionId} not found after preparation`);
    }

    const runContext = startSessionRun(sessionForRun, query, requestId);
    sessionForRun.logger.setMetadata({
      requestId: runContext.requestId,
      runId: runContext.runId,
      runSequence: runContext.sequence,
    });

    // Validate traceContext — must be array of objects with columns/rows
    const traceContext = Array.isArray(rawTraceContext)
      ? rawTraceContext.filter(
          (d: any) => d && typeof d === 'object' && Array.isArray(d.columns) && Array.isArray(d.rows),
        )
      : undefined;

    runAgentDrivenAnalysis(sessionId, query, traceId, {
      ...options,
      selectionContext,
      blockedStrategyIds,
      traceProcessorService,
      runContext,
      referenceTraceId,
      traceContext: traceContext && traceContext.length > 0 ? traceContext : undefined,
    }).catch((error) => {
      const session = assistantAppService.getSession(sessionId);
      if (session) {
        session.logger.error('AgentRoutes', 'Agent-driven analysis failed', error);
        session.status = 'failed';
        session.error = error.message;
        markSessionRunStatus(session, 'failed', error.message);
        broadcastToAgentDrivenClients(sessionId, {
          type: 'error',
          content: { message: error.message, error: error.message },
          timestamp: Date.now(),
        });
      }
    });

    res.json({
      success: true,
      sessionId,
      message: isNewSession ? 'Analysis started' : 'Continuing analysis (multi-turn)',
      isNewSession,
      architecture: 'agent-driven',
      runId: runContext.runId,
      requestId: runContext.requestId,
      runSequence: runContext.sequence,
      observability: {
        runId: runContext.runId,
        requestId: runContext.requestId,
        runSequence: runContext.sequence,
      },
    });
  } catch (error: any) {
    console.error('[AgentRoutes] Analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Agent analysis failed',
    });
  }
});

/**
 * GET /api/agent/v1/:sessionId/stream
 *
 * SSE endpoint for real-time analysis updates
 *
 * Events:
 * - connected: SSE connection established
 * - conversation_step: Ordered conversational timeline step
 * - progress: Progress updates (task graph, rounds, strategy)
 * - data: DataEnvelope(s) from skill execution
 * - agent_task_dispatched: Task sent to domain agent
 * - agent_response: Agent completed task
 * - synthesis_complete: Feedback synthesis complete
 * - strategy_decision: Next iteration strategy decided
 * - analysis_completed: Final analysis result
 * - error: Error occurred
 * - end: Stream ended
 */
router.get('/:sessionId/stream', (req, res) => {
  const { sessionId } = req.params;

  const session = assistantAppService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  // F3: Check for Last-Event-ID (reconnect replay support)
  // Accepts both standard header (EventSource) and query param (fetch-based clients)
  const lastEventIdRaw = req.headers['last-event-id'] || req.query.lastEventId;
  const lastEventId = lastEventIdRaw ? parseInt(String(lastEventIdRaw), 10) : NaN;

  streamProjector.setSseHeaders(res);
  streamProjector.sendConnected(res, {
    sessionId,
    status: session.status,
    traceId: session.traceId,
    query: session.query,
    architecture: 'agent-driven',
    timestamp: Date.now(),
    ...buildStreamObservability(session),
  });

  // F3: Replay missed events from ring buffer if reconnecting
  if (!isNaN(lastEventId) && session.sseEventBuffer.length > 0) {
    const replayed = streamProjector.replayBufferedEvents(res, session.sseEventBuffer, lastEventId);
    if (replayed > 0) {
      console.log(`[AgentRoutes] Replayed ${replayed} missed SSE events for ${sessionId} (after seqId ${lastEventId})`);
    }
  }

  // Add client to session
  assistantAppService.addSseClient(sessionId, res);
  console.log(`[AgentRoutes] SSE client connected for ${sessionId}`);

  // If analysis is already completed, send the result.
  // Resumed sessions may not have session.result in memory; recover from persisted turn context.
  if (session.status === 'completed') {
    recoverResultForSessionIfNeeded(sessionId, session);
    if (session.result) {
      sendAgentDrivenResult(res, session);
      streamProjector.sendEnd(res, buildStreamObservability(session));
      res.end();
      return;
    }
  }

  // If analysis failed, send error
  if (session.status === 'failed') {
    streamProjector.sendError(res, session.error, buildStreamObservability(session));
    streamProjector.sendEnd(res, buildStreamObservability(session));
    res.end();
    return;
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[AgentRoutes] SSE client disconnected for ${sessionId}`);
    assistantAppService.removeSseClient(sessionId, res);
  });

  // Handle write errors (EPIPE when client disconnects mid-write).
  // Without this handler, EPIPE propagates as uncaughtException and can crash
  // the SDK subprocess (which inherits the process's pipe state).
  res.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
      // Expected when SSE client disconnects (e.g., curl timeout, browser navigation)
      assistantAppService.removeSseClient(sessionId, res);
      return;
    }
    console.error(`[AgentRoutes] SSE response error for ${sessionId}:`, err.message);
  });

  streamProjector.bindKeepAlive(req, res);
});

/**
 * GET /api/agent/v1/:sessionId/status
 *
 * Get analysis status (for polling)
 */
router.get('/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;

  const session = assistantAppService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const response: any = {
    success: true,
    sessionId,
    status: session.status,
    traceId: session.traceId,
    query: session.query,
    createdAt: session.createdAt,
    observability: buildSessionObservability(session),
  };

  if (session.status === 'completed') {
    const recoveredResult = recoverResultForSessionIfNeeded(sessionId, session);
    if (recoveredResult) {
      const conclusion = normalizeNarrativeForClient(recoveredResult.conclusion);
      const clientFindings = buildClientFindings(recoveredResult.findings, session.scenes || []);
      const resultContract = buildSessionResultContract(session, clientFindings);
      const sceneIdHint = resolveConclusionSceneIdHint({
        sessionId,
        query: session.query,
        findings: recoveredResult.findings,
      });
      const conclusionContract =
        recoveredResult.conclusionContract ||
        deriveConclusionContract(conclusion, {
          mode: recoveredResult.rounds > 1 ? 'focused_answer' : 'initial_report',
          sceneId: sceneIdHint,
        }) ||
        undefined;
      response.result = {
        answer: conclusion,
        conclusion,
        conclusionContract,
        confidence: recoveredResult.confidence,
        totalDurationMs: recoveredResult.totalDurationMs,
        rounds: recoveredResult.rounds,
        partial: recoveredResult.partial,
        terminationReason: recoveredResult.terminationReason,
        terminationMessage: recoveredResult.terminationMessage,
        findings: recoveredResult.findings,
        findingsCount: recoveredResult.findings.length,
        resultContract,
      };
    }
  }

  if (session.status === 'failed') {
    response.error = session.error;
  }

  res.json(response);
});

/**
 * GET /api/agent/v1/:sessionId/turns
 *
 * List persisted turns for a session.
 * Supports in-memory sessions and persisted (recoverable) sessions.
 *
 * Query params:
 * - limit: default 20, max 200
 * - offset: default 0
 * - order: asc | desc (default desc)
 */
router.get('/:sessionId/turns', (req, res) => {
  const { sessionId } = req.params;
  const rawLimit = parseInt(String(req.query.limit || '20'), 10);
  const rawOffset = parseInt(String(req.query.offset || '0'), 10);
  const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return res.status(404).json({
      success: false,
      error: 'Session context not found',
      hint: 'Session may not exist or was not persisted with context snapshots',
    });
  }

  const allTurns = resolved.context.getAllTurns();
  const ordered = order === 'desc' ? [...allTurns].reverse() : [...allTurns];
  const paged = ordered.slice(offset, offset + limit);

  const latestTurn = allTurns.length > 0 ? allTurns[allTurns.length - 1] : null;

  return res.json({
    success: true,
    sessionId,
    traceId: resolved.traceId,
    source: resolved.source,
    query: resolved.query,
    createdAt: resolved.createdAt,
    totalTurns: allTurns.length,
    turns: paged.map(buildTurnSummary),
    latestTurn: latestTurn ? buildTurnSummary(latestTurn) : null,
    pagination: {
      limit,
      offset,
      order,
      hasMore: offset + limit < ordered.length,
    },
  });
});

/**
 * GET /api/agent/v1/:sessionId/turns/:turnId
 *
 * Get details for a specific turn.
 * `turnId` supports:
 * - UUID turn ID
 * - numeric turn index (0-based or 1-based)
 * - literal `latest`
 */
router.get('/:sessionId/turns/:turnId', (req, res) => {
  const { sessionId, turnId } = req.params;

  const resolved = resolveSessionContextForReview(sessionId);
  if (!resolved) {
    return res.status(404).json({
      success: false,
      error: 'Session context not found',
      hint: 'Session may not exist or was not persisted with context snapshots',
    });
  }

  const turns = resolved.context.getAllTurns();
  if (turns.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'No turns recorded for this session',
    });
  }

  let turn: ConversationTurn | undefined;
  if (turnId === 'latest') {
    turn = turns[turns.length - 1];
  } else {
    turn = turns.find(t => t.id === turnId);
    if (!turn && /^\d+$/.test(turnId)) {
      const parsed = parseInt(turnId, 10);
      turn = turns.find(t => t.turnIndex === parsed) || turns.find(t => t.turnIndex === parsed - 1);
    }
  }

  if (!turn) {
    return res.status(404).json({
      success: false,
      error: `Turn not found: ${turnId}`,
      hint: 'Use /api/agent/v1/:sessionId/turns to inspect available turn IDs',
    });
  }

  const previousTurn = turns.find(t => t.turnIndex === turn!.turnIndex - 1) || null;
  const nextTurn = turns.find(t => t.turnIndex === turn!.turnIndex + 1) || null;

  return res.json({
    success: true,
    sessionId,
    traceId: resolved.traceId,
    source: resolved.source,
    turn: buildTurnDetail(turn),
    navigation: {
      previousTurnId: previousTurn?.id || null,
      nextTurnId: nextTurn?.id || null,
      previousTurnIndex: previousTurn?.turnIndex ?? null,
      nextTurnIndex: nextTurn?.turnIndex ?? null,
    },
  });
});

/**
 * DELETE /api/agent/v1/:sessionId
 *
 * Clean up an analysis session
 */
router.delete('/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const session = assistantAppService.getSession(sessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  // Close all SSE connections
  session.sseClients.forEach((client) => {
    try {
      client.end();
    } catch {}
  });

  // Clean up session-scoped state only — do NOT call reset() which clears
  // global caches (architectureCache) shared across all active sessions.
  if (typeof session.orchestrator.cleanupSession === 'function') {
    session.orchestrator.cleanupSession(sessionId);
  }
  // Also clean up the EnhancedSessionContext (EntityStore, turns, working memory)
  sessionContextManager.remove(sessionId);
  assistantAppService.deleteSession(sessionId);

  res.json({ success: true });
});

const FEEDBACK_DIR = path.join(process.cwd(), 'logs', 'feedback');
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'feedback.jsonl');

/**
 * POST /api/agent/v1/:sessionId/feedback
 *
 * Submit user feedback on analysis quality (thumbs up/down + optional comment).
 * Stored as append-only JSONL in logs/feedback/ with versioned schema
 * (see backend/src/agentv3/selfImprove/feedbackEnricher.ts).
 */
router.post('/:sessionId/feedback', async (req, res) => {
  const { sessionId } = req.params;

  const validated = validateFeedbackInput(req.body);
  if (!validated.ok) {
    return res.status(400).json({ success: false, error: validated.error });
  }

  const session = assistantAppService.getSession(sessionId);
  const lookup: FeedbackSessionLookup | null = session
    ? { traceId: session.traceId, referenceTraceId: session.referenceTraceId }
    : null;

  const entry = enrichFeedbackEntry(sessionId, validated.value, lookup);

  try {
    fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[Feedback] Failed to save feedback:', (err as Error).message);
    return res.status(500).json({ success: false, error: 'Failed to save feedback' });
  }

  // Feed the rating into the pattern state machine when the client
  // identified the pattern. Best-effort: log and continue if it fails so
  // the JSONL audit trail is the canonical record either way.
  let patternStatusAfter: string | null = null;
  if (validated.value.patternId) {
    try {
      patternStatusAfter = await applyFeedbackToPattern(
        validated.value.patternId,
        validated.value.rating,
      );
    } catch (err) {
      console.warn('[Feedback] Pattern state update failed:', (err as Error).message);
    }
  }

  res.json({
    success: true,
    schemaVersion: entry.schemaVersion,
    patternStatus: patternStatusAfter,
  });
});

/**
 * POST /api/agent/v1/:sessionId/respond
 *
 * Respond to an interactive session (e.g. continue/abort).
 *
 * Note: AgentRuntime currently does not pause for user input in v2;
 * this endpoint mainly exists for API compatibility and future multi-turn UX.
 */
router.post('/:sessionId/respond', async (req, res) => {
  const { sessionId } = req.params;
  const session = assistantAppService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const action = req.body?.action;
  const allowedActions = new Set(['continue', 'abort']);

  if (!action || typeof action !== 'string' || !allowedActions.has(action)) {
    return res.status(400).json({
      success: false,
      error: `Invalid action: ${String(action)}. Allowed: continue, abort`,
    });
  }

  if (action === 'abort') {
    session.status = 'failed';
    session.error = 'Aborted by user';
    return res.json({ success: true, sessionId, status: session.status });
  }

  // continue
  if (session.status !== 'awaiting_user') {
    return res.status(400).json({
      success: false,
      error: `Session is not awaiting user input (current status: ${session.status})`,
    });
  }

  session.status = 'running';
  return res.json({ success: true, sessionId, status: session.status });
});

// =============================================================================
// Agent-Driven Architecture v2.0 - Intervention & Focus Endpoints
// =============================================================================

/**
 * POST /api/agent/v1/:sessionId/intervene
 *
 * Handle user intervention response during analysis.
 * Called when the frontend receives an 'intervention_required' event and
 * the user selects an option.
 *
 * Request body:
 * {
 *   interventionId: string,    // ID from intervention_required event
 *   action: 'continue' | 'focus' | 'abort' | 'custom' | 'select_option',
 *   selectedOptionId?: string, // ID of selected option
 *   customInput?: string,      // User's custom input (for action='custom')
 *   params?: Record<string, any> // Additional parameters
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   directive?: AnalysisDirective  // How analysis should proceed
 * }
 */
router.post('/:sessionId/intervene', async (req, res) => {
  const { sessionId } = req.params;
  const session = assistantAppService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const { interventionId, action, selectedOptionId, customInput, params } = req.body;

  // Validate required fields
  if (!interventionId || typeof interventionId !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'interventionId is required',
    });
  }

  const allowedActions = new Set(['continue', 'focus', 'abort', 'custom', 'select_option']);
  if (!action || !allowedActions.has(action)) {
    return res.status(400).json({
      success: false,
      error: `Invalid action: ${String(action)}. Allowed: ${Array.from(allowedActions).join(', ')}`,
    });
  }

  try {
    // ClaudeRuntime (agentv3) doesn't implement getInterventionController — reject gracefully.
    if (typeof session.orchestrator.getInterventionController !== 'function') {
      return res.status(400).json({ success: false, error: 'Intervention not supported in this runtime mode' });
    }
    const interventionController = session.orchestrator.getInterventionController();

    // Check if there's a pending intervention
    if (!interventionController.hasPendingIntervention(sessionId)) {
      return res.status(400).json({
        success: false,
        error: 'No pending intervention for this session',
      });
    }

    // Build user decision
    const decision: UserDecision = {
      interventionId,
      action,
      selectedOptionId,
      customInput,
      params,
    };

    // Process the decision (interventionId is used internally to find the session)
    const directive = interventionController.handleUserDecision(decision);

    // Update session status if needed
    if (directive.action === 'abort') {
      session.status = 'failed';
      session.error = 'Aborted by user intervention';
    } else if (session.status === 'awaiting_user') {
      session.status = 'running';
    }

    return res.json({
      success: true,
      sessionId,
      directive,
    });
  } catch (error: any) {
    console.error(`[Intervene] Error processing intervention for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process intervention',
    });
  }
});

/**
 * POST /api/agent/v1/:sessionId/interaction
 *
 * Record user interaction from the frontend.
 * Used to update the FocusStore for incremental analysis support.
 *
 * Request body:
 * {
 *   type: 'click' | 'query' | 'drill_down' | 'compare' | 'extend' | 'explicit',
 *   target: {
 *     entityType?: 'frame' | 'process' | 'thread' | 'session',
 *     entityId?: string,
 *     timeRange?: { start: string, end: string },  // ns as string
 *     metricName?: string,
 *     question?: string
 *   },
 *   context?: Record<string, any>  // Additional context
 * }
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focusCount: number  // Current number of tracked focuses
 * }
 */
// P1-4: Cancel endpoint — allows frontend to signal the backend to stop analysis
router.post('/:sessionId/cancel', (req, res) => {
  const { sessionId } = req.params;
  const session = assistantAppService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  // Mark session as failed/cancelled
  if (session.status === 'running' || session.status === 'pending') {
    session.status = 'failed';
    session.error = 'Cancelled by user';
    markSessionRunStatus(session, 'failed', 'Cancelled by user');
    // Close SSE connections to signal the frontend
    for (const client of session.sseClients) {
      try {
        streamProjector.sendEvent(client, 'error', JSON.stringify({ message: 'Analysis cancelled by user' }));
        client.end();
      } catch { /* client may already be closed */ }
    }
    session.sseClients = [];
    session.logger.info('AgentRoutes', 'Session cancelled by user', { sessionId });
  }

  return res.json({ success: true, sessionId, status: session.status });
});

router.post('/:sessionId/interaction', async (req, res) => {
  const { sessionId } = req.params;
  const session = assistantAppService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  const { type, target, context } = req.body;

  // Validate type
  const allowedTypes = new Set(['click', 'query', 'drill_down', 'compare', 'extend', 'explicit']);
  if (!type || !allowedTypes.has(type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid interaction type: ${String(type)}. Allowed: ${Array.from(allowedTypes).join(', ')}`,
    });
  }

  // Validate target
  if (!target || typeof target !== 'object') {
    return res.status(400).json({
      success: false,
      error: 'target is required and must be an object',
    });
  }

  try {
    // Convert timeRange strings to BigInt if present
    const processedTarget = { ...target };
    if (target.timeRange) {
      processedTarget.timeRange = {
        start: BigInt(target.timeRange.start),
        end: BigInt(target.timeRange.end),
      };
    }

    // Build interaction
    const interaction: FocusInteraction = {
      type,
      target: processedTarget,
      source: 'ui',
      timestamp: Date.now(),
      context,
    };

    // Record the interaction — ClaudeRuntime (agentv3) doesn't implement these methods.
    if (typeof session.orchestrator.recordUserInteraction === 'function') {
      session.orchestrator.recordUserInteraction(interaction);
      const focusStore = typeof session.orchestrator.getFocusStore === 'function'
        ? session.orchestrator.getFocusStore()
        : null;
      const focusCount = focusStore ? focusStore.getTopFocuses(100).length : 0;
      return res.json({ success: true, sessionId, focusCount });
    }

    return res.json({ success: true, sessionId, focusCount: 0 });
  } catch (error: any) {
    console.error(`[Interaction] Error recording interaction for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to record interaction',
    });
  }
});

/**
 * GET /api/agent/v1/:sessionId/focus
 *
 * Get current user focus state for a session.
 * Useful for debugging and displaying focus indicators in the UI.
 *
 * Query params:
 * - limit: Max number of focuses to return (default: 10)
 *
 * Response:
 * {
 *   success: boolean,
 *   sessionId: string,
 *   focuses: UserFocus[],
 *   context: string  // LLM-ready focus context summary
 * }
 */
router.get('/:sessionId/focus', (req, res) => {
  const { sessionId } = req.params;
  const session = assistantAppService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  try {
    // ClaudeRuntime (agentv3) doesn't implement getFocusStore — return empty.
    if (typeof session.orchestrator.getFocusStore !== 'function') {
      return res.json({ success: true, sessionId, focuses: [], context: '' });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const focusStore = session.orchestrator.getFocusStore();

    // Get top focuses
    const focuses = focusStore.getTopFocuses(limit).map((f: any) => ({
      id: f.id,
      type: f.type,
      target: {
        ...f.target,
        // Convert BigInt to string for JSON serialization
        ...(f.target.timeRange && {
          timeRange: {
            start: String(f.target.timeRange.start),
            end: String(f.target.timeRange.end),
          },
        }),
      },
      weight: f.weight,
      lastInteractionTime: f.lastInteractionTime,
      interactionCount: f.interactionHistory.length,
    }));

    // Get LLM-ready context
    const context = focusStore.buildFocusContext();

    return res.json({
      success: true,
      sessionId,
      focuses,
      context,
    });
  } catch (error: any) {
    console.error(`[Focus] Error getting focus for session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get focus state',
    });
  }
});

registerAgentSessionCatalogRoutes(router, {
  sessionStore: assistantAppService,
  buildSessionObservability,
});

registerAgentResumeRoutes(router, {
  sessionStore: assistantAppService,
  buildSessionObservability,
  buildRecoveredResultFromContext,
  buildTurnSummary,
  getModelRouter,
});

// ============================================================================
// Scene Reconstruction Endpoints
// ============================================================================

// Scene-report cache layer singletons. The disk store backs file-backed
// traces with a 7-day TTL; the memory LRU is the fallback for external RPC
// traces (no content hash, so they live for the lifetime of the backend).
const sceneReportStore = new FileSystemSceneReportStore(sceneStoryConfig.reportDir);
const sceneReportMemoryCache = new SceneReportMemoryCache(sceneStoryConfig.memoryCacheMaxSize);

// Singleton — sceneStoryService holds per-session JobRunner state for cancel
// lookup, so it must outlive a single request. SkillExecutor is still created
// per-request inside the route handler.
const sceneStoryService = new SceneStoryService({
  broadcast: broadcastToAgentDrivenClients,
  getSession: (id) => assistantAppService.getSession(id) as any,
  reportStore: sceneReportStore,
  memoryCache: sceneReportMemoryCache,
  computeHash: (traceId) => computeTraceContentHash(getTraceProcessorService(), traceId),
  probeDuration: (traceId) => probeTraceDuration(getTraceProcessorService(), traceId),
});

registerSceneReconstructRoutes(router, {
  assistantAppService,
  streamProjector,
  ensureToolsRegistered,
  getModelRouter,
  runAgentDrivenAnalysis,
  broadcastToAgentDrivenClients,
  sendAgentDrivenResult,
  isSceneReplayOnlyQuery,
  buildSceneReplayNarrative,
  normalizeNarrativeForClient,
  sceneStoryService,
});

registerAgentQuickSceneRoutes(router, {
  detectScenesQuick,
});

// ============================================================================
// Scene Detection Cache + Parallel Helpers
// ============================================================================

const sceneCache = new Map<string, { scenes: DetectedScene[]; timestamp: number }>();
const SCENE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const SCENE_EXTRACTION_STEP_IDS = new Set([
  'screen_state_changes',
  'app_launches',
  'user_gestures',
  'scroll_initiation',
  'inertial_scrolls',
  'idle_periods',
  'top_app_changes',
  'system_events',
  'jank_events',
  'clean_timeline',
]);

function objectRowsToEnvelopePayload(rows: Array<Record<string, any>>): { columns: string[]; rows: any[][] } {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  return {
    columns,
    rows: rows.map((row) => columns.map((col) => (row ? row[col] : null))),
  };
}

function buildSceneExtractionEnvelopesFromRawResults(rawResults: any): DataEnvelope[] {
  const envelopes: DataEnvelope[] = [];
  if (!rawResults || typeof rawResults !== 'object') return envelopes;

  for (const [stepId, stepResult] of Object.entries(rawResults as Record<string, any>)) {
    if (!SCENE_EXTRACTION_STEP_IDS.has(stepId)) continue;
    const rows = Array.isArray((stepResult as any)?.data)
      ? ((stepResult as any).data as Array<Record<string, any>>)
      : [];
    if (rows.length === 0) continue;

    const payload = objectRowsToEnvelopePayload(rows);
    if (payload.columns.length === 0) continue;

    envelopes.push(createDataEnvelope(payload, {
      type: 'skill_result',
      source: `scene_reconstruction.${stepId}`,
      skillId: 'scene_reconstruction',
      stepId,
      title: stepId,
      layer: 'list',
      format: 'table',
    }));
  }

  return envelopes;
}

/**
 * Execute the state_timeline skill directly (bypasses Agent decision-making).
 * Returns DataEnvelopes suitable for SSE broadcast and track overlay rendering.
 * agentv3's ClaudeRuntime doesn't auto-execute strategy tasks, so this must be
 * called explicitly from the scene reconstruction flow.
 */
async function executeStateTimelineSkill(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string
): Promise<DataEnvelope[]> {
  await ensureSkillRegistryInitialized();

  const skillExecutor = new SkillExecutor(traceProcessorService);
  skillExecutor.registerSkills(skillRegistry.getAllSkills());

  const skillResult = await skillExecutor.execute('state_timeline', traceId, {
    trace_id: traceId,
  });

  if (!skillResult.success) {
    console.warn('[StateTimeline] state_timeline skill failed:', skillResult.error);
    return [];
  }

  // Convert rawResults to DataEnvelopes (same pattern as scene_reconstruction)
  const envelopes: DataEnvelope[] = [];
  if (!skillResult.rawResults || typeof skillResult.rawResults !== 'object') return envelopes;

  for (const [stepId, stepResult] of Object.entries(skillResult.rawResults as Record<string, any>)) {
    const rows = Array.isArray((stepResult as any)?.data)
      ? ((stepResult as any).data as Array<Record<string, any>>)
      : [];
    if (rows.length === 0) continue;

    const payload = objectRowsToEnvelopePayload(rows);
    if (payload.columns.length === 0) continue;

    envelopes.push(createDataEnvelope(payload, {
      type: 'skill_result',
      source: `state_timeline:${stepId}`,
      skillId: 'state_timeline',
      stepId,
      title: stepId,
      layer: 'list',
      format: 'table',
    }));
  }

  return envelopes;
}

async function detectScenesQuickViaSkill(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string
): Promise<DetectedScene[]> {
  await ensureSkillRegistryInitialized();

  const skillExecutor = new SkillExecutor(traceProcessorService);
  skillExecutor.registerSkills(skillRegistry.getAllSkills());

  const skillResult = await skillExecutor.execute('scene_reconstruction', traceId, {
    trace_id: traceId,
  });

  if (!skillResult.success) {
    throw new Error(skillResult.error || 'scene_reconstruction execution failed');
  }

  const envelopes = buildSceneExtractionEnvelopesFromRawResults(skillResult.rawResults);
  return extractDetectedScenesFromEnvelopes(envelopes);
}

/** Detect app startups from android_startups stdlib view */
async function detectStartups(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  // Reclassify startup_type: platform may report 'warm' even when
  // bindApplication exists (process killed + ActivityRecord survives).
  const result = await tps.query(traceId, `
    SELECT
      s.ts,
      s.dur,
      s.package,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM android_startup_threads st
          JOIN thread_track tt ON tt.utid = st.utid
          JOIN slice sl ON sl.track_id = tt.id
          WHERE st.startup_id = s.startup_id
            AND st.is_main_thread = 1
            AND sl.name = 'bindApplication'
            AND sl.ts + sl.dur > st.ts AND sl.ts < st.ts + st.dur
        ) THEN 'cold'
        ELSE s.startup_type
      END AS startup_type,
      CAST(s.dur / 1000000 AS INT) AS dur_ms
    FROM android_startups s
    WHERE s.dur > 0
    ORDER BY s.ts
  `);

  const scenes: DetectedScene[] = [];
  if (result.rows) {
    for (const row of result.rows) {
      const [ts, dur, pkg, startupType, durMs] = row;
      let sceneType: SceneCategory = 'cold_start';
      if (startupType === 'warm') sceneType = 'warm_start';
      else if (startupType === 'hot') sceneType = 'hot_start';

      scenes.push({
        type: sceneType,
        startTs: String(ts),
        endTs: String(BigInt(ts) + BigInt(dur)),
        durationMs: Number(durMs),
        confidence: 0.95,
        appPackage: pkg,
        metadata: { startupType },
      });
    }
  }
  return scenes;
}

/** Detect scroll sessions from input events + frame timeline */
async function detectScrollSessions(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const scrollResult = await tps.query(traceId, `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    gesture_markers AS (
      SELECT
        ts,
        event_action,
        SUM(CASE WHEN event_action = 'DOWN' THEN 1 ELSE 0 END) OVER (ORDER BY ts) AS gesture_id
      FROM motion_events
    ),
    gestures AS (
      SELECT
        gesture_id,
        MIN(ts) AS down_ts,
        MAX(CASE WHEN event_action = 'UP' THEN ts ELSE NULL END) AS up_ts,
        COUNT(*) AS event_count
      FROM gesture_markers
      WHERE gesture_id > 0
      GROUP BY gesture_id
      HAVING COUNT(*) >= 4
    ),
    frame_with_stats AS (
      SELECT
        ts,
        dur,
        ts + dur AS frame_end,
        jank_type,
        COALESCE(LEAD(ts) OVER (ORDER BY ts) - (ts + dur), 999999999) AS gap_to_next
      FROM actual_frame_timeline_slice
      WHERE surface_frame_token IS NOT NULL AND dur > 0
    ),
    scroll_sessions AS (
      SELECT
        g.gesture_id,
        g.down_ts AS start_ts,
        COALESCE(
          (SELECT MIN(f.frame_end)
           FROM frame_with_stats f
           WHERE f.ts >= g.up_ts AND f.gap_to_next > 100000000),
          g.up_ts + 500000000
        ) AS end_ts
      FROM gestures g
      WHERE g.up_ts IS NOT NULL
    )
    SELECT
      s.start_ts,
      s.end_ts,
      CAST((s.end_ts - s.start_ts) / 1000000 AS INT) AS dur_ms,
      (SELECT COUNT(*) FROM frame_with_stats f WHERE f.ts >= s.start_ts AND f.frame_end <= s.end_ts) AS frame_count
    FROM scroll_sessions s
    WHERE s.end_ts > s.start_ts + 100000000
    ORDER BY s.start_ts
  `);

  const scenes: DetectedScene[] = [];
  if (scrollResult.rows) {
    for (const row of scrollResult.rows) {
      const [startTs, endTs, durMs, frameCount] = row;
      if (Number(frameCount) >= 3) {
        const fps = (Number(frameCount) * 1000) / Math.max(Number(durMs), 1);
        scenes.push({
          type: 'scroll',
          startTs: String(startTs),
          endTs: String(endTs),
          durationMs: Number(durMs),
          confidence: 0.85,
          metadata: {
            frameCount: Number(frameCount),
            averageFps: Math.round(fps * 10) / 10,
          },
        });
      }
    }
  }
  return scenes;
}

/** Detect tap/click events from input events */
async function detectTapEvents(
  tps: ReturnType<typeof getTraceProcessorService>,
  traceId: string,
): Promise<DetectedScene[]> {
  const tapResult = await tps.query(traceId, `
    WITH
    input_exists AS (
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = 'android_input_events'
      )
    ),
    motion_events AS (
      SELECT
        read_time AS ts,
        event_action
      FROM android_input_events
      WHERE event_type = 'MOTION'
        AND EXISTS (SELECT ok FROM input_exists)
    ),
    tap_events AS (
      SELECT
        ts AS down_ts,
        LEAD(ts) OVER (ORDER BY ts) AS up_ts,
        event_action
      FROM motion_events
      WHERE event_action IN ('DOWN', 'UP')
    )
    SELECT
      down_ts AS start_ts,
      up_ts AS end_ts,
      CAST((up_ts - down_ts) / 1000000 AS INT) AS dur_ms
    FROM tap_events
    WHERE event_action = 'DOWN'
      AND up_ts IS NOT NULL
      AND (up_ts - down_ts) < 300000000
    ORDER BY down_ts
    LIMIT 50
  `);

  const scenes: DetectedScene[] = [];
  if (tapResult.rows) {
    for (const row of tapResult.rows) {
      const [startTs, endTs, durMs] = row;
      scenes.push({
        type: 'tap',
        startTs: String(startTs),
        endTs: String(endTs),
        durationMs: Number(durMs),
        confidence: 0.75,
      });
    }
  }
  return scenes;
}

/**
 * Legacy quick scene detection path.
 * Kept as fallback when skill-based extraction is unavailable.
 */
async function detectScenesQuickLegacy(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string
): Promise<DetectedScene[]> {
  // =========================================================================
  // Pre-load Perfetto stdlib modules (parallel)
  // =========================================================================
  // `android_input_events` and `android_startups` are stdlib VIEWS, not
  // intrinsic tables. They only exist after loading the corresponding modules.
  const REQUIRED_MODULES = [
    'android.input',            // Creates android_input_events, android_key_events
    'android.startup.startups', // Creates android_startups
  ];

  await Promise.all(
    REQUIRED_MODULES.map(module =>
      traceProcessorService.query(traceId, `INCLUDE PERFETTO MODULE ${module};`)
        .catch(e => console.warn(`[QuickSceneDetect] Module not available: ${module}`, e))
    )
  );

  // =========================================================================
  // Run all 3 detection queries in parallel
  // =========================================================================
  const [startupResult, scrollResult, tapResult] = await Promise.allSettled([
    detectStartups(traceProcessorService, traceId),
    detectScrollSessions(traceProcessorService, traceId),
    detectTapEvents(traceProcessorService, traceId),
  ]);

  // Merge results from fulfilled promises
  const scenes: DetectedScene[] = [];
  if (startupResult.status === 'fulfilled') {
    scenes.push(...startupResult.value);
  } else {
    console.warn('[QuickSceneDetect] Startup detection failed:', startupResult.reason);
  }
  if (scrollResult.status === 'fulfilled') {
    scenes.push(...scrollResult.value);
  } else {
    console.warn('[QuickSceneDetect] Scroll detection failed:', scrollResult.reason);
  }
  if (tapResult.status === 'fulfilled') {
    scenes.push(...tapResult.value);
  } else {
    console.warn('[QuickSceneDetect] Tap detection failed:', tapResult.reason);
  }

  // Sort scenes by start timestamp
  scenes.sort((a, b) => {
    const aTs = BigInt(a.startTs);
    const bTs = BigInt(b.startTs);
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  return scenes;
}

async function detectScenesQuick(
  traceProcessorService: ReturnType<typeof getTraceProcessorService>,
  traceId: string
): Promise<DetectedScene[]> {
  const cached = sceneCache.get(traceId);
  if (cached && Date.now() - cached.timestamp < SCENE_CACHE_TTL) {
    console.log('[QuickSceneDetect] Cache hit for traceId:', traceId);
    return cached.scenes;
  }

  const t0 = Date.now();

  let scenes: DetectedScene[] = [];
  try {
    scenes = await detectScenesQuickViaSkill(traceProcessorService, traceId);
    console.log(`[QuickSceneDetect] Skill extraction path returned ${scenes.length} scenes`);
    if (scenes.length === 0) {
      const legacyScenes = await detectScenesQuickLegacy(traceProcessorService, traceId);
      if (legacyScenes.length > 0) {
        console.log(`[QuickSceneDetect] Legacy fallback provided ${legacyScenes.length} scenes after empty skill extraction`);
        scenes = legacyScenes;
      }
    }
  } catch (error: any) {
    console.warn('[QuickSceneDetect] Skill extraction failed, falling back to legacy SQL path:', error?.message || error);
    scenes = await detectScenesQuickLegacy(traceProcessorService, traceId);
  }

  scenes.sort((a, b) => {
    const aTs = BigInt(a.startTs);
    const bTs = BigInt(b.startTs);
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  console.log(`[QuickSceneDetect] Completed in ${Date.now() - t0}ms, ${scenes.length} scenes`);
  sceneCache.set(traceId, { scenes, timestamp: Date.now() });
  return scenes;
}

// ============================================================================
// Teaching Pipeline Endpoints
// ============================================================================

registerTeachingRoutes(router);

registerAgentReportRoutes(router, {
  getSession: (sessionId) => assistantAppService.getSession(sessionId),
  recoverResultForSessionIfNeeded,
  normalizeNarrativeForClient,
  buildClientFindings,
  buildSessionResultContract,
});

// ============================================================================
// Agent-Driven Analysis Helper Functions (Phase 2-4)
// ============================================================================

async function runAgentDrivenAnalysis(
  sessionId: string,
  query: string,
  traceId: string,
  options: any = {}
) {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return;

  const inputRun = options.runContext as AnalyzeSessionRunContext | undefined;
  if (inputRun) {
    session.activeRun = {
      ...inputRun,
      query,
      status: 'running',
      startedAt: inputRun.startedAt || Date.now(),
    };
    session.lastRun = { ...session.activeRun };
    session.runSequence = Math.max(
      normalizeRunSequence(session.runSequence),
      normalizeRunSequence(inputRun.sequence)
    );
  } else if (!session.activeRun) {
    const fallback = startSessionRun(session, query, generateRequestId());
    session.activeRun = {
      ...fallback,
      status: 'running',
    };
    session.lastRun = { ...session.activeRun };
  } else {
    session.activeRun.query = query;
    session.activeRun.status = 'running';
    if (!session.activeRun.startedAt) {
      session.activeRun.startedAt = Date.now();
    }
    session.lastRun = { ...session.activeRun };
  }

  const { logger } = session;
  session.status = 'running';
  session.lastActivityAt = Date.now();
  logger.info('AgentDrivenAnalysis', 'Starting agent-driven analysis', {
    query,
    traceId,
    runId: session.activeRun?.runId,
    requestId: session.activeRun?.requestId,
    runSequence: session.activeRun?.sequence,
  });

  // Track generation is a lightweight derivation step from DataEnvelopes.
  // Enable by default (unless explicitly disabled) so `/api/agent/v1/analyze` can
  // also produce TrackEvent(s) when the scene reconstruction skill runs.
  const shouldGenerateTracks = options.generateTracks !== false;

  // Capture LLM call telemetry into session logs (privacy-safe: hashes + params only)
  const modelRouter = getModelRouter();
  const onLlmTelemetry = (event: any) => {
    if (!event || event.sessionId !== sessionId) return;
    logger.debug('LLM', 'llmTelemetry', event);
  };
  modelRouter.on('llmTelemetry', onLlmTelemetry);

  // Set up streaming via event listener on orchestrator
  const handleUpdate = (update: StreamingUpdate) => {
    session.lastActivityAt = Date.now();
    console.log(`[AgentRoutes.AgentDriven] Received event: ${update.type}`, update.content?.phase);
    logger.debug('Stream', `Update: ${update.type}`, update.content);
    const normalizedUpdate = normalizeAgentDrivenUpdate(update);

    // Broadcast the original event so the frontend receives raw events
    // (answer_token, thought, agent_response, conclusion, etc.) for rendering.
    broadcastToAgentDrivenClients(sessionId, normalizedUpdate);

    // Also derive a conversation_step for the timeline/observability layer.
    const conversationStep = buildConversationStepUpdate(session, normalizedUpdate);
    if (conversationStep) {
      appendConversationStep(session, conversationStep);
      broadcastToAgentDrivenClients(sessionId, conversationStep);
    }

    // Derive TrackEvent(s) for scene reconstruction sessions from emitted DataEnvelopes.
    // This keeps the TrackEvent feature while unifying on the agent-driven architecture.
    if (shouldGenerateTracks && normalizedUpdate.type === 'data') {
      const envelopes = (Array.isArray(normalizedUpdate.content) ? normalizedUpdate.content : [normalizedUpdate.content])
        .filter((e): e is DataEnvelope => !!e && typeof e === 'object');
      const changed = updateSceneReconstructionArtifactsFromEnvelopes(session, envelopes);
      if (changed) {
        broadcastToAgentDrivenClients(sessionId, {
          type: 'track_data',
          content: {
            tracks: session.trackEvents || [],
            scenes: session.scenes || [],
          },
          timestamp: update.timestamp,
          id: generateEventId('track_data', sessionId),
        });
      }
    }

    // Track agent dialogue events
    if (normalizedUpdate.content?.phase === 'task_dispatched' || normalizedUpdate.content?.phase === 'task_completed') {
      pushWithSessionCap(session.agentDialogue, {
        agentId: normalizedUpdate.content.agentId || 'master',
        type: normalizedUpdate.content.phase === 'task_dispatched' ? 'task' : 'response',
        content: normalizedUpdate.content,
        timestamp: normalizedUpdate.timestamp,
      }, MAX_SESSION_AGENT_DIALOGUE);

      // Collect full agent responses for HTML report enrichment
      if (normalizedUpdate.content.phase === 'task_completed') {
        pushWithSessionCap(session.agentResponses, {
          taskId: normalizedUpdate.content.taskId || '',
          agentId: normalizedUpdate.content.agentId || 'unknown',
          response: normalizedUpdate.content.response || normalizedUpdate.content,
          timestamp: normalizedUpdate.timestamp,
        }, MAX_SESSION_AGENT_RESPONSES);
      }
    }

    // Broadcast specialized events for frontend visualization.
    // Skip if the mapped type is the same as the original — agentv3 events
    // (answer_token, thought, conclusion, etc.) are already broadcast above
    // and remapping would cause duplicate delivery to the frontend.
    const eventType = mapToAgentDrivenEventType(normalizedUpdate);
    if (eventType !== normalizedUpdate.type) {
      broadcastToAgentDrivenClients(sessionId, {
        type: eventType,
        content: normalizedUpdate.content,
        timestamp: normalizedUpdate.timestamp,
        id: normalizedUpdate.id,
      });
    }
  };

  // Listen to orchestrator events
  if (session.orchestratorUpdateHandler) {
    session.orchestrator.off('update', session.orchestratorUpdateHandler);
  }
  session.orchestratorUpdateHandler = handleUpdate;
  session.orchestrator.on('update', handleUpdate);

  // Run state_timeline skill in parallel with Agent analysis (fire-and-forget).
  // Only execute when explicitly requested (e.g. scene reconstruction flow),
  // NOT on every analyze call — raw state lane data needs LLM reasoning before display.
  if (options.executeStateTimeline && options.traceProcessorService) {
    executeStateTimelineSkill(options.traceProcessorService, traceId)
      .then((envelopes) => {
        if (envelopes.length === 0) return;
        // Process envelopes through the same pipeline as Agent-produced data
        const changed = updateSceneReconstructionArtifactsFromEnvelopes(session, envelopes);
        // Broadcast each envelope as a 'data' event so frontend track_overlay picks it up
        for (const env of envelopes) {
          broadcastToAgentDrivenClients(sessionId, {
            type: 'data',
            content: env,
            timestamp: Date.now(),
            id: generateEventId('data', sessionId),
          });
        }
        if (changed) {
          broadcastToAgentDrivenClients(sessionId, {
            type: 'track_data',
            content: { tracks: session.trackEvents || [], scenes: session.scenes || [] },
            timestamp: Date.now(),
            id: generateEventId('track_data', sessionId),
          });
        }
        logger.info('StateTimeline', 'State timeline lanes broadcast', {
          laneCount: Object.keys(session.stateTimeline || {}).length,
          envelopeCount: envelopes.length,
        });
      })
      .catch((err) => {
        logger.warn('StateTimeline', 'state_timeline skill failed (non-fatal)', {
          error: String(err?.message || err),
        });
      });
  }

  try {
    console.log('[AgentRoutes.AgentDriven] Starting orchestrator.analyze...');
    const result = await logger.timed('AgentDrivenAnalysis', 'analyze', async () => {
      return session.orchestrator.analyze(query, sessionId, traceId, {
        traceProcessorService: options.traceProcessorService,
        packageName: options.packageName,
        timeRange: options.timeRange,
        taskTimeoutMs: options.taskTimeoutMs,
        blockedStrategyIds: options.blockedStrategyIds,
        adb: options.adb,
        selectionContext: options.selectionContext,
        analysisMode: options.analysisMode,
        traceContext: options.traceContext,
      });
    });
    console.log('[AgentRoutes.AgentDriven] analyze completed, success:', result.success);

    session.result = result;
    // Accumulate hypotheses across turns (deduplicate by id)
    const existingIds = new Set(session.hypotheses.map(h => h.id));
    for (const h of result.hypotheses) {
      if (!existingIds.has(h.id)) {
        session.hypotheses.push(h);
      } else {
        // Update existing hypothesis with latest status
        const idx = session.hypotheses.findIndex(eh => eh.id === h.id);
        if (idx >= 0) session.hypotheses[idx] = h;
      }
    }
    session.status = result.success ? 'completed' : 'failed';
    markSessionRunStatus(session, result.success ? 'completed' : 'failed');

    // Record conclusion in cross-turn history
    if (!session.conclusionHistory) session.conclusionHistory = [];
    if (result.conclusion) {
      session.conclusionHistory.push({
        turn: session.runSequence || 1,
        conclusion: result.conclusion,
        confidence: result.confidence ?? 0,
        timestamp: Date.now(),
      });
    }

    // Ensure trackEvents/scenes are computed for completed sessions (even without SSE clients)
    if (shouldGenerateTracks) {
      updateSceneReconstructionArtifactsFromEnvelopes(session, session.dataEnvelopes as DataEnvelope[]);
    }

    // Log completion details
    logger.info('AgentDrivenAnalysis', 'Agent-driven analysis completed', {
      confidence: result.confidence,
      rounds: result.rounds,
      findingsCount: result.findings.length,
      hypothesesCount: result.hypotheses.length,
      partial: result.partial,
      terminationReason: result.terminationReason,
      runId: session.activeRun?.runId,
      requestId: session.activeRun?.requestId,
      runSequence: session.activeRun?.sequence,
    });

    // Persist session state via shared helper — see services/persistAgentSession.ts.
    // CLI's cliAnalyzeService routes through the same function.
    persistAgentTurn({
      session,
      sessionId,
      traceId,
      query,
      result: { conclusion: result.conclusion, totalDurationMs: result.totalDurationMs },
      logger,
      // Preserve the legacy component label so any log filters / alerts keyed
      // on 'AgentDrivenAnalysis' keep matching persist-related events.
      logComponent: 'AgentDrivenAnalysis',
    });

    // Send final result
    const clientCount = session.sseClients.length;
    logger.info('AgentRoutes', 'Sending agent-driven result', { clientCount });

    session.sseClients.forEach((client, index) => {
      try {
        logger.info('AgentRoutes', `Sending agent-driven result to client ${index + 1}/${clientCount}`);
        sendAgentDrivenResult(client, session);
        streamProjector.sendEnd(client, buildStreamObservability(session));
      } catch (e: any) {
        logger.error('AgentRoutes', `Error sending agent-driven result to client ${index + 1}`, e);
      }
    });

    logger.close();
  } catch (error: any) {
    session.status = 'failed';
    session.error = error.message;
    markSessionRunStatus(session, 'failed', error.message);
    logger.error('AgentDrivenAnalysis', 'Agent-driven analysis failed', error);

    broadcastToAgentDrivenClients(sessionId, {
      type: 'error',
      content: { message: error.message, error: error.message },
      timestamp: Date.now(),
    });

    logger.close();
    throw error;
  } finally {
    // Prevent listener accumulation across multi-turn requests in the same session.
    if (session.orchestratorUpdateHandler) {
      session.orchestrator.off('update', session.orchestratorUpdateHandler);
      if (session.orchestratorUpdateHandler === handleUpdate) {
        session.orchestratorUpdateHandler = undefined;
      }
    }
    modelRouter.off('llmTelemetry', onLlmTelemetry);
  }
}

function sanitizeConversationText(value: unknown, maxLen = 240): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function appendConversationStep(session: AnalysisSession, update: StreamingUpdate): void {
  if (update.type !== 'conversation_step') return;

  const payload =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};
  const contentRecord =
    payload.content && typeof payload.content === 'object' && !Array.isArray(payload.content)
      ? (payload.content as Record<string, any>)
      : {};

  const text = sanitizeConversationText(contentRecord.text);
  const ordinal = Number(payload.ordinal);
  if (!text || !Number.isFinite(ordinal) || ordinal <= 0) return;

  const phaseRaw = sanitizeConversationText(payload.phase, 24) as AnalysisSession['conversationSteps'][number]['phase'];
  const phase = ((
    phaseRaw === 'thinking' ||
    phaseRaw === 'tool' ||
    phaseRaw === 'result' ||
    phaseRaw === 'error'
  ) ? phaseRaw : 'progress');

  const roleRaw = sanitizeConversationText(payload.role, 16) as AnalysisSession['conversationSteps'][number]['role'];
  const role = roleRaw === 'system' ? 'system' : 'agent';

  const eventId =
    sanitizeConversationText(payload.eventId, 128) ||
    sanitizeConversationText(update.id, 128) ||
    `conversation-step-${session.sessionId}-${ordinal}`;

  if (session.conversationSteps.some((step) => step.eventId === eventId || step.ordinal === ordinal)) {
    return;
  }

  session.conversationSteps.push({
    eventId,
    ordinal,
    phase,
    role,
    text,
    timestamp: typeof update.timestamp === 'number' && Number.isFinite(update.timestamp)
      ? update.timestamp
      : Date.now(),
    sourceEventType: sanitizeConversationText(payload?.source?.eventType, 48) || undefined,
  });

  session.conversationSteps.sort((a, b) => a.ordinal - b.ordinal);
  if (session.conversationSteps.length > 400) {
    session.conversationSteps.splice(0, session.conversationSteps.length - 400);
  }
}

function buildConversationStepUpdate(
  session: AnalysisSession,
  update: StreamingUpdate
): StreamingUpdate | null {
  if (update.type === 'conversation_step') return null;

  const contentRecord =
    update.content && typeof update.content === 'object' && !Array.isArray(update.content)
      ? (update.content as Record<string, any>)
      : {};

  let phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error' = 'progress';
  let role: 'agent' | 'system' = 'agent';
  let text = '';

  switch (update.type) {
    case 'progress':
    case 'degraded':
    case 'stage_transition':
    case 'round_start':
    case 'strategy_decision':
    case 'synthesis_complete':
    case 'hypothesis_generated':
      phase = 'progress';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.fallback && `降级处理: ${contentRecord.fallback}`) ||
        sanitizeConversationText(contentRecord.reasoning) ||
        sanitizeConversationText(contentRecord.phase && `阶段: ${contentRecord.phase}`);
      if (!text && update.type === 'hypothesis_generated' && Array.isArray(contentRecord.hypotheses)) {
        text = `形成 ${contentRecord.hypotheses.length} 个待验证假设`;
      }
      break;
    case 'thought':
    case 'worker_thought':
      phase = 'thinking';
      role = update.type === 'worker_thought' ? 'system' : 'agent';
      text =
        sanitizeConversationText(contentRecord.thought) ||
        sanitizeConversationText(contentRecord.content) ||
        sanitizeConversationText(contentRecord.message);
      break;
    case 'tool_call':
    case 'agent_task_dispatched':
    case 'agent_dialogue':
      phase = 'tool';
      role = 'agent';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.taskTitle) ||
        sanitizeConversationText(contentRecord.toolName);
      break;
    case 'agent_response':
    case 'finding':
      phase = 'result';
      role = 'agent';
      if (update.type === 'finding' && Array.isArray(contentRecord.findings)) {
        const firstFinding = contentRecord.findings.find(
          (entry) => entry && typeof entry === 'object'
        ) as Record<string, any> | undefined;
        const firstTitle = sanitizeConversationText(firstFinding?.title || firstFinding?.description);
        text = firstTitle
          ? `新增发现 ${contentRecord.findings.length} 条: ${firstTitle}`
          : `新增发现 ${contentRecord.findings.length} 条`;
      } else {
        text =
          sanitizeConversationText(contentRecord.summary) ||
          sanitizeConversationText(contentRecord.message) ||
          (contentRecord.taskId ? `工具调用完成 (#${String(contentRecord.taskId).slice(-6)})` : '');
      }
      break;
    case 'data': {
      phase = 'result';
      role = 'system';
      const envelopes = (Array.isArray(update.content) ? update.content : [update.content])
        .filter((entry) => entry && typeof entry === 'object') as Array<Record<string, any>>;
      if (envelopes.length > 0) {
        const titles = envelopes
          .map((env) => sanitizeConversationText(env?.display?.title || env?.meta?.stepId || env?.meta?.source))
          .filter(Boolean)
          .slice(0, 2);
        text = titles.length > 0
          ? `收到 ${envelopes.length} 份数据结果: ${titles.join(' / ')}`
          : `收到 ${envelopes.length} 份数据结果`;
      }
      break;
    }
    case 'conclusion':
      phase = 'result';
      role = 'agent';
      text =
        sanitizeConversationText(contentRecord.summary) ||
        sanitizeConversationText(contentRecord.message) ||
        '最终结论已生成';
      break;
    case 'answer_token':
      if (contentRecord.done === true) {
        phase = 'result';
        role = 'agent';
        text = '最终回答生成完成';
      }
      break;
    case 'error':
      phase = 'error';
      role = 'system';
      text =
        sanitizeConversationText(contentRecord.message) ||
        sanitizeConversationText(contentRecord.error) ||
        '分析过程中发生错误';
      break;
    default:
      return null;
  }

  if (!text) return null;

  session.conversationOrdinal = (Number.isFinite(session.conversationOrdinal) ? session.conversationOrdinal : 0) + 1;
  const ordinal = session.conversationOrdinal;
  const eventId = generateEventId('conversation_step', session.sessionId);

  const metadata: Record<string, unknown> = {};
  if (typeof contentRecord.round === 'number' && Number.isFinite(contentRecord.round)) {
    metadata.round = contentRecord.round;
  }
  if (typeof contentRecord.strategyId === 'string' && contentRecord.strategyId.trim()) {
    metadata.strategyId = contentRecord.strategyId.trim();
  }
  if (contentRecord.partial === true) {
    metadata.partial = true;
  }
  if (typeof contentRecord.terminationReason === 'string' && contentRecord.terminationReason.trim()) {
    metadata.terminationReason = contentRecord.terminationReason.trim();
  }
  if (session.activeRun?.runId) {
    metadata.runId = session.activeRun.runId;
  }
  if (session.activeRun?.requestId) {
    metadata.requestId = session.activeRun.requestId;
  }
  if (typeof session.activeRun?.sequence === 'number' && Number.isFinite(session.activeRun.sequence)) {
    metadata.runSequence = session.activeRun.sequence;
  }

  return {
    type: 'conversation_step',
    id: eventId,
    timestamp: update.timestamp || Date.now(),
    content: {
      eventId,
      sessionId: session.sessionId,
      traceId: session.traceId,
      phase,
      role,
      ordinal,
      content: {
        text,
      },
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      source: {
        eventType: update.type,
        phase: typeof contentRecord.phase === 'string' ? contentRecord.phase : undefined,
      },
    },
  };
}

/**
 * Normalize orchestrator updates before mapping/broadcasting
 */
function normalizeAgentDrivenUpdate(update: StreamingUpdate): StreamingUpdate {
  const rawContent = update.content;
  if (!rawContent || typeof rawContent !== 'object' || Array.isArray(rawContent)) {
    return update;
  }

  const content: Record<string, any> = { ...(rawContent as Record<string, any>) };

  if (update.type === 'stage_transition') {
    const stageName = typeof content.stageName === 'string' ? content.stageName : 'unknown';
    const hasStageIndex = typeof content.stageIndex === 'number' && Number.isFinite(content.stageIndex);
    const hasTotalStages = typeof content.totalStages === 'number' && Number.isFinite(content.totalStages) && content.totalStages > 0;
    const skipped = content.skipped === true;
    const skipReason = typeof content.skipReason === 'string' ? content.skipReason.trim() : '';
    const stageSeq = hasStageIndex && hasTotalStages
      ? ` (${content.stageIndex + 1}/${content.totalStages})`
      : '';
    if (typeof content.phase !== 'string' || !content.phase.trim()) {
      content.phase = 'stage_transition';
    }
    if (typeof content.message !== 'string' || !content.message.trim()) {
      const prefix = skipped ? '跳过阶段' : '进入阶段';
      const reason = skipped && skipReason ? `: ${skipReason}` : '';
      content.message = `${prefix} ${stageName}${stageSeq}${reason}`;
    }
  }

  if (update.type === 'tool_call') {
    const phase = typeof content.phase === 'string' ? content.phase : '';
    const phaseLower = phase.toLowerCase();
    const isDone = phaseLower.includes('completed') || phaseLower.includes('done') || phaseLower.includes('finished');
    if (typeof content.phase !== 'string' || !content.phase.trim()) {
      content.phase = isDone ? 'task_completed' : 'task_dispatched';
    }
    if (typeof content.message !== 'string' || !content.message.trim()) {
      const taskTitle = typeof content.taskTitle === 'string' ? content.taskTitle : '';
      const toolName = typeof content.toolName === 'string' ? content.toolName : '';
      const displayName = taskTitle || toolName || '工具任务';
      content.message = isDone ? `完成 ${displayName}` : `调用 ${displayName}`;
    }
  }

  return {
    ...update,
    content,
  };
}

function mapToAgentDrivenEventType(update: StreamingUpdate): StreamingUpdate['type'] {
  const phase = update.content?.phase;

  if (update.type === 'conversation_step') {
    return 'conversation_step';
  }

  if (update.type === 'stage_transition') {
    return 'progress';
  }

  if (update.type === 'tool_call') {
    const phaseText = typeof phase === 'string' ? phase.toLowerCase() : '';
    const isComplete = phaseText.includes('completed') || phaseText.includes('done') || phaseText.includes('finished');
    return isComplete ? 'agent_response' : 'agent_dialogue';
  }

  switch (phase) {
    case 'starting':
    case 'understanding':
      return 'progress';
    case 'hypotheses_generated':
      return 'hypothesis_generated';
    case 'round_start':
      return 'round_start';
    case 'tasks_dispatched':
      return 'agent_task_dispatched';
    case 'task_dispatched':
      return 'agent_dialogue';
    case 'task_completed':
      return 'agent_response';
    case 'synthesis_complete':
      return 'synthesis_complete';
    case 'strategy_decision':
      return 'strategy_decision';
    case 'concluding':
      return 'progress';
    default:
      return update.type;
  }
}

/**
 * Broadcast update to all SSE clients for an agent-driven session
 */
function broadcastToAgentDrivenClients(sessionId: string, update: StreamingUpdate) {
  const session = assistantAppService.getSession(sessionId);
  if (!session) return;
  session.lastActivityAt = Date.now();

  // F3: Assign monotonic sequence ID for replay on reconnect
  const seqId = ++session.sseEventSeq;

  streamProjector.broadcastStreamingUpdate(sessionId, session.sseClients, update, {
    observability: buildStreamObservability(session),
    seqId,
    onBufferedEvent: (event) => {
      session.sseEventBuffer.push(event);
      // Trim ring buffer to cap
      if (session.sseEventBuffer.length > SSE_RING_BUFFER_SIZE) {
        session.sseEventBuffer.splice(0, session.sseEventBuffer.length - SSE_RING_BUFFER_SIZE);
      }
    },
    onDataEnvelopeValidationWarning: (payload) => {
      console.warn(
        `[AgentRoutes.broadcastToAgentDrivenClients] DataEnvelope validation warning (envelope ${payload.envelopeIndex}):`,
        {
          sessionId: payload.sessionId,
          errors: payload.errors.slice(0, 5),
          totalErrors: payload.errors.length,
          envelope: payload.envelope,
        }
      );
    },
    onValidDataEnvelopes: (validEnvelopes) => {
      if (validEnvelopes.length > 0) {
        console.log(
          `[AgentRoutes.broadcastToAgentDrivenClients] Sending ${validEnvelopes.length} DataEnvelope(s) for session ${sessionId}`
        );
        // P2-4: Tag envelopes with current turn number for multi-turn attribution
        const turnNumber = session.runSequence || 1;
        for (const env of validEnvelopes) {
          if (env.meta) (env.meta as any).turn = turnNumber;
        }
        session.dataEnvelopes.push(...validEnvelopes);
        trimSessionArray(session.dataEnvelopes, MAX_SESSION_DATA_ENVELOPES);
      }
    },
  });
}

// =============================================================================
// Scene Reconstruction: Derive scenes + TrackEvent(s) from DataEnvelopes
// =============================================================================

const SCENE_DISPLAY_NAMES: Record<SceneCategory, string> = {
  cold_start: '冷启动',
  warm_start: '温启动',
  hot_start: '热启动',
  scroll_start: '滑动启动',
  scroll: '滑动',
  inertial_scroll: '惯性滑动',
  navigation: '跳转',
  app_switch: '应用切换',
  home_screen: '桌面',
  app_foreground: '应用内',
  screen_on: '屏幕点亮',
  screen_off: '屏幕熄灭',
  screen_sleep: '屏幕休眠',
  screen_unlock: '解锁屏幕',
  notification: '通知操作',
  split_screen: '分屏操作',
  tap: '点击',
  long_press: '长按',
  idle: '空闲',
  jank_region: '性能问题区间',
  back_key: '返回键',
  home_key: 'Home键',
  recents_key: '最近任务键',
  anr: 'ANR',
  ime_show: '键盘弹出',
  ime_hide: '键盘收起',
  window_transition: '窗口转场',
};

const SCENE_COLOR_SCHEMES: Record<SceneCategory, TrackEvent['colorScheme']> = {
  cold_start: 'launch',
  warm_start: 'launch',
  hot_start: 'launch',
  scroll_start: 'scroll',
  scroll: 'scroll',
  inertial_scroll: 'scroll',
  navigation: 'navigation',
  app_switch: 'system',
  home_screen: 'system',
  app_foreground: 'system',
  screen_on: 'system',
  screen_off: 'system',
  screen_sleep: 'system',
  screen_unlock: 'system',
  notification: 'system',
  split_screen: 'system',
  tap: 'tap',
  long_press: 'tap',
  idle: 'system',
  jank_region: 'jank',  // Use jank color to highlight performance issues
  back_key: 'system',
  home_key: 'system',
  recents_key: 'system',
  anr: 'jank',
  ime_show: 'system',
  ime_hide: 'system',
  window_transition: 'navigation',
};

/** A single continuous segment in a state timeline lane. */
interface StateLaneSegment {
  lane: string;
  state: string;
  stateLabel: string;
  startTs: string;
  endTs: string;
  durMs: number;
  sourceStatus: string;
  confidence?: string;
}

/** Lane step IDs from state_timeline skill */
const STATE_LANE_STEP_IDS = new Set([
  'device_state_lane',
  'device_state_lane_fallback',
  'input_state_lane_frames',
  'input_state_lane_fallback',
  'app_state_lane',
  'app_state_lane_fallback',
  'system_state_lane',
]);

/** Map stepId → lane name */
const STEP_TO_LANE: Record<string, string> = {
  device_state_lane: 'device',
  device_state_lane_fallback: 'device',
  input_state_lane_frames: 'input',
  input_state_lane_fallback: 'input',
  app_state_lane: 'app',
  app_state_lane_fallback: 'app',
  system_state_lane: 'system',
};

type LaneStatus = 'available' | 'available_frame_based' | 'available_heuristic' | 'table_missing' | 'no_data';
const VALID_LANE_STATUSES = new Set<string>(['available', 'available_frame_based', 'available_heuristic', 'table_missing', 'no_data']);
/** Statuses indicating data is expected (table exists, may have rows). */
const DATA_PRESENT_STATUSES = new Set<string>(['available', 'available_frame_based', 'available_heuristic']);

/**
 * Single-pass extraction of state timeline lanes + lane availability from DataEnvelopes.
 * Combines what would otherwise be two separate iterations over the same envelope array.
 */
function extractStateTimelineData(envelopes: DataEnvelope[]): {
  timeline: Record<string, StateLaneSegment[]>;
  availability: Record<string, LaneStatus>;
} {
  const timeline: Record<string, StateLaneSegment[]> = {};
  const availability: Record<string, LaneStatus> = {};

  for (const env of envelopes) {
    if (!env || env.meta?.skillId !== 'state_timeline') continue;
    const stepId = env.meta.stepId || '';

    // Lane summary → extract availability
    if (stepId === 'lane_summary') {
      const rows = payloadToObjectRowsLocal(env.data);
      for (const row of rows) {
        const lane = String(row.lane || '');
        const status = String(row.source_status || 'available');
        if (lane) {
          availability[lane] = VALID_LANE_STATUSES.has(status) ? status as LaneStatus : 'available';
        }
      }
      continue;
    }

    // Lane data steps → extract segments
    if (!STATE_LANE_STEP_IDS.has(stepId)) continue;

    const laneName = STEP_TO_LANE[stepId] || stepId;

    // Real data over fallback: conditions are mutually exclusive, but be safe.
    const isFallbackStep = stepId.endsWith('_fallback');
    if (isFallbackStep && timeline[laneName]?.length > 0) {
      continue;
    }

    const rows = payloadToObjectRowsLocal(env.data);
    if (rows.length === 0) continue;

    const segments: StateLaneSegment[] = [];
    for (const row of rows) {
      const startTs = String(row.start_ts || '');
      const endTs = String(row.end_ts || '');
      const durMs = Number(row.dur_ms || 0);
      if (!startTs || !endTs || durMs <= 0) continue;

      segments.push({
        lane: laneName,
        state: String(row.state || 'UNKNOWN'),
        stateLabel: String(row.state_label || ''),
        startTs,
        endTs,
        durMs,
        sourceStatus: String(row.source_status || 'available'),
        confidence: row.confidence ? String(row.confidence) : undefined,
      });
    }

    if (segments.length > 0) {
      timeline[laneName] = segments;
    }
  }

  // Reconcile: if a lane has segments, it's available; if lane_summary said
  // 'available' but we got no segments, it's really 'no_data'.
  for (const lane of [...new Set(Object.values(STEP_TO_LANE))]) {
    if (timeline[lane] && timeline[lane].length > 0) {
      // Has real data — check if it's all UNKNOWN (empty-source fallback)
      const allUnknown = timeline[lane].every(s => s.state === 'UNKNOWN' || s.state === 'IDLE');
      if (!availability[lane]) {
        availability[lane] = allUnknown ? 'no_data' : 'available';
      }
    } else if (DATA_PRESENT_STATUSES.has(availability[lane])) {
      // lane_summary said available, but no segments arrived → no_data
      availability[lane] = 'no_data';
    }
  }

  return { timeline, availability };
}

function updateSceneReconstructionArtifactsFromEnvelopes(
  session: AnalysisSession,
  envelopes: DataEnvelope[]
): boolean {
  if (!Array.isArray(envelopes) || envelopes.length === 0) return false;

  // Extract scene events (from scene_reconstruction skill)
  const extractedScenes = extractDetectedScenesFromEnvelopes(envelopes);

  // Extract state timeline + lane availability in a single pass
  const { timeline, availability } = extractStateTimelineData(envelopes);
  let hasTimelineUpdate = false;

  if (Object.keys(timeline).length > 0) {
    session.stateTimeline = Object.assign(session.stateTimeline || {}, timeline);
    hasTimelineUpdate = true;
  }
  if (Object.keys(availability).length > 0) {
    session.laneAvailability = Object.assign(session.laneAvailability || {}, availability);
  }

  if (extractedScenes.length === 0) return hasTimelineUpdate;

  const mergedScenes = mergeDetectedScenes(session.scenes || [], extractedScenes);
  const mergedTracks = buildTrackEventsFromScenes(mergedScenes);

  const prevFingerprint = fingerprintTrackEvents(session.trackEvents || []);
  const nextFingerprint = fingerprintTrackEvents(mergedTracks);

  session.scenes = mergedScenes;
  session.trackEvents = mergedTracks;

  return prevFingerprint !== nextFingerprint;
}

function extractDetectedScenesFromEnvelopes(envelopes: DataEnvelope[]): DetectedScene[] {
  const scenes: DetectedScene[] = [];
  const jankRowsForFallback: Array<Record<string, any>> = [];

  for (const env of envelopes) {
    if (!env || env.meta?.skillId !== 'scene_reconstruction') continue;

    const stepId = env.meta.stepId || '';
    const rows = payloadToObjectRowsLocal(env.data);
    if (rows.length === 0) continue;

    // Step: screen_state_changes (screen on/off/sleep)
    if (stepId === 'screen_state_changes') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const eventText = String(row.event || '');
        const type = mapScreenStateEventToSceneType(eventText);
        if (!type) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          metadata: {
            source: 'scene_reconstruction:screen_state_changes',
            event: eventText,
          },
        });
      }
      continue;
    }

    // Step: app_launches (startup events)
    if (stepId === 'app_launches') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startupType = String(row.startup_type || '').toLowerCase();
        const type: SceneCategory =
          startupType === 'warm' ? 'warm_start'
          : startupType === 'hot' ? 'hot_start'
          : 'cold_start';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.95,
          appPackage: extractRowAppPackage(row, ['package']),
          metadata: {
            source: 'scene_reconstruction:app_launches',
            startupType: startupType || undefined,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: user_gestures (tap/scroll/long_press)
    if (stepId === 'user_gestures') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const gestureType = String(row.gesture_type || '').toLowerCase();
        const type: SceneCategory =
          gestureType === 'scroll' ? 'scroll'
          : gestureType === 'long_press' ? 'long_press'
          : 'tap';

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:user_gestures',
            moveCount: row.move_count,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: scroll_initiation (precise scroll start marker)
    if (stepId === 'scroll_initiation') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'scroll_start',
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row, ['app']),
          metadata: {
            source: 'scene_reconstruction:scroll_initiation',
            gestureId: row.gesture_id,
            event: row.event,
            explanation: row.explanation,
          },
        });
      }
      continue;
    }

    // Step: inertial_scrolls (fling inertia region after finger up)
    if (stepId === 'inertial_scrolls') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);
        const frameCount = Number(row.frame_count || 0);

        scenes.push({
          type: 'inertial_scroll',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: frameCount >= 12 ? 0.9 : frameCount >= 8 ? 0.8 : 0.7,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:inertial_scrolls',
            frameCount,
            jankFrames: Number(row.jank_frames || 0),
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: idle_periods (no obvious operation gap)
    if (stepId === 'idle_periods') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'idle',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: confidenceToScore(row.confidence),
          metadata: {
            source: 'scene_reconstruction:idle_periods',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: top_app_changes (app switches)
    if (stepId === 'top_app_changes') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: 'app_switch',
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:top_app_changes',
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: system_events (unlock/notification/split screen)
    if (stepId === 'system_events') {
      for (const row of rows) {
        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const eventText = String(row.event || '');
        const type = mapSystemEventToSceneType(eventText);
        if (!type) continue;
        // Guardrail: ignore very short unlock slices (usually render/mutex noise).
        if (type === 'screen_unlock' && durNs < 100_000_000n) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type,
          startTs: startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.85,
          metadata: {
            source: 'scene_reconstruction:system_events',
            event: eventText,
          },
        });
      }
      continue;
    }

    // Step: clean_timeline (quality-gated unified timeline)
    if (stepId === 'clean_timeline') {
      const cleanTimelineTypeMapping: Record<string, SceneCategory> = {
        'cold_start': 'cold_start',
        'warm_start': 'warm_start',
        'hot_start': 'hot_start',
        'scroll': 'scroll',
        'tap': 'tap',
        'long_press': 'long_press',
        'screen_on': 'screen_on',
        'screen_off': 'screen_off',
        'screen_sleep': 'screen_sleep',
        'screen_unlock': 'screen_unlock',
        'notification': 'notification',
        'split_screen': 'split_screen',
        'pip': 'navigation',
        'app_switch': 'app_switch',
        'home_screen': 'home_screen',
        'app_foreground': 'app_foreground',
        'back_key': 'back_key',
        'home_key': 'home_key',
        'recents_key': 'recents_key',
        'anr': 'anr',
        'ime_show': 'ime_show',
        'ime_hide': 'ime_hide',
        'window_transition': 'window_transition',
        'idle': 'idle',
      };

      for (const row of rows) {
        const eventType = String(row.event_type || '');
        const sceneType = cleanTimelineTypeMapping[eventType];
        if (!sceneType) continue;

        const startTs = normalizeNs(row.ts);
        const durNs = toBigInt(row.dur);
        if (!startTs || durNs === null) continue;

        const startNs = BigInt(startTs);
        const endNs = startNs + durNs;
        const durationMs = Number(durNs / 1_000_000n);

        scenes.push({
          type: sceneType,
          startTs,
          endTs: endNs.toString(),
          durationMs,
          confidence: 0.9,
          appPackage: extractRowAppPackage(row),
          metadata: {
            source: 'scene_reconstruction:clean_timeline',
            eventId: row.event_id,
            timeOffset: row.time_offset,
            rating: row.rating,
            event: row.event,
          },
        });
      }
      continue;
    }

    // Step: jank_events (performance issue regions) - FALLBACK
    // Collected first; only used if no gesture-like scenes are found.
    if (stepId === 'jank_events') {
      jankRowsForFallback.push(...rows);
      continue;
    }
  }

  const hasGestureLikeScene = scenes.some((scene) => (
    scene.type === 'tap' ||
    scene.type === 'scroll' ||
    scene.type === 'long_press' ||
    scene.type === 'inertial_scroll'
  ));

  if (!hasGestureLikeScene && jankRowsForFallback.length > 0) {
    const jankIntervals = aggregateJankFramesToIntervals(jankRowsForFallback);
    for (const interval of jankIntervals) {
      if (interval.jankCount < 3) continue;
      scenes.push({
        type: 'jank_region',
        startTs: interval.startTs,
        endTs: interval.endTs,
        durationMs: interval.durationMs,
        confidence: 0.8,
        metadata: {
          source: 'scene_reconstruction:jank_events',
          jankCount: interval.jankCount,
          severity: interval.severity,
        },
      });
    }
  }

  scenes.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return scenes;
}

// =============================================================================
// Jank Frame Aggregation Helper
// =============================================================================

interface JankInterval {
  startTs: string;
  endTs: string;
  durationMs: number;
  jankCount: number;
  severity: 'severe' | 'mild';
}

/**
 * Aggregates consecutive jank frames into intervals.
 * Adjacent jank frames within 500ms gap are merged into one interval.
 * This creates meaningful analysis targets from scattered jank events.
 */
function aggregateJankFramesToIntervals(rows: Array<Record<string, any>>): JankInterval[] {
  if (!rows.length) return [];

  const MERGE_GAP_NS = 500_000_000n; // 500ms
  const intervals: JankInterval[] = [];

  // Sort by timestamp first
  const sortedRows = [...rows].sort((a, b) => {
    const aTs = toBigInt(a.ts);
    const bTs = toBigInt(b.ts);
    if (aTs === null || bTs === null) return 0;
    return aTs < bTs ? -1 : aTs > bTs ? 1 : 0;
  });

  let currentStart = toBigInt(sortedRows[0].ts);
  let currentEnd = currentStart !== null
    ? currentStart + (toBigInt(sortedRows[0].dur) || 0n)
    : null;
  let jankCount = 1;
  let severities: string[] = [String(sortedRows[0].jank_severity_type || '')];

  if (currentStart === null || currentEnd === null) {
    return []; // Invalid first row
  }

  for (let i = 1; i < sortedRows.length; i++) {
    const rowTs = toBigInt(sortedRows[i].ts);
    const rowDur = toBigInt(sortedRows[i].dur) || 0n;

    if (rowTs === null) continue;

    if (rowTs - currentEnd! < MERGE_GAP_NS) {
      // Merge into current interval
      const rowEnd = rowTs + rowDur;
      if (rowEnd > currentEnd!) {
        currentEnd = rowEnd;
      }
      jankCount++;
      severities.push(String(sortedRows[i].jank_severity_type || ''));
    } else {
      // Save current interval and start a new one
      intervals.push({
        startTs: currentStart!.toString(),
        endTs: currentEnd!.toString(),
        durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
        jankCount,
        severity: severities.includes('Full') ? 'severe' : 'mild',
      });
      currentStart = rowTs;
      currentEnd = rowTs + rowDur;
      jankCount = 1;
      severities = [String(sortedRows[i].jank_severity_type || '')];
    }
  }

  // Save the last interval
  intervals.push({
    startTs: currentStart!.toString(),
    endTs: currentEnd!.toString(),
    durationMs: Number((currentEnd! - currentStart!) / 1_000_000n),
    jankCount,
    severity: severities.includes('Full') ? 'severe' : 'mild',
  });

  return intervals;
}

function mergeDetectedScenes(existing: DetectedScene[], incoming: DetectedScene[]): DetectedScene[] {
  const merged = new Map<string, DetectedScene>();

  for (const s of existing) merged.set(sceneKey(s), s);
  for (const s of incoming) merged.set(sceneKey(s), s);

  const out = Array.from(merged.values());
  out.sort((a, b) => (BigInt(a.startTs) > BigInt(b.startTs) ? 1 : -1));
  return out;
}

function sceneKey(scene: DetectedScene): string {
  return `${scene.type}:${scene.startTs}:${scene.endTs}:${scene.appPackage || ''}`;
}

function buildTrackEventsFromScenes(scenes: DetectedScene[]): TrackEvent[] {
  return scenes.map((scene) => {
    const displayName = SCENE_DISPLAY_NAMES[scene.type] || scene.type;
    const colorScheme = SCENE_COLOR_SCHEMES[scene.type] || 'system';

    const appName = scene.appPackage
      ? scene.appPackage.replace('com.', '').replace('android.', '')
      : '';

    let name = displayName;
    if (appName) name += ` [${appName}]`;
    if (Number.isFinite(scene.durationMs) && scene.durationMs > 0) name += ` ${scene.durationMs}ms`;

    let dur = '0';
    try {
      dur = (BigInt(scene.endTs) - BigInt(scene.startTs)).toString();
    } catch {}

    return {
      ts: scene.startTs,
      dur,
      name,
      category: 'scene',
      colorScheme,
      details: {
        sceneType: scene.type,
        appPackage: scene.appPackage,
        durationMs: scene.durationMs,
        confidence: scene.confidence,
        ...scene.metadata,
      },
    };
  });
}

function fingerprintTrackEvents(events: TrackEvent[]): string {
  return events.map(e => `${e.ts}:${e.dur}:${e.name}:${e.colorScheme}`).join('|');
}

function payloadToObjectRowsLocal(payload: any): Array<Record<string, any>> {
  if (!payload || typeof payload !== 'object') return [];
  const cols = (payload as any).columns;
  const rows = (payload as any).rows;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];

  const out: Array<Record<string, any>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const obj: Record<string, any> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[String(cols[i])] = row[i];
    }
    out.push(obj);
  }
  return out;
}

function normalizeNs(value: any): string | null {
  const n = toBigInt(value);
  return n === null ? null : n.toString();
}

function toBigInt(value: any): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (!/^-?\d+$/.test(s)) return null;
    try {
      return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

function confidenceToScore(value: any): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  const s = String(value || '').trim();
  if (!s) return 0.85;
  if (s === '高') return 0.9;
  if (s === '中') return 0.7;
  if (s === '低') return 0.5;
  return 0.8;
}

function extractRowAppPackage(row: Record<string, any>, extraFields: string[] = []): string | undefined {
  const candidateFields = ['app_package', 'appPackage', ...extraFields];
  for (const field of candidateFields) {
    const value = row[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const eventApp = extractBracketContent(String(row.event || ''));
  if (eventApp) return eventApp;
  return undefined;
}

function extractBracketContent(text: string): string | null {
  const m = text.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : null;
}

function mapSystemEventToSceneType(eventText: string): SceneCategory | null {
  const e = eventText.trim();
  if (!e) return null;
  // Keep unlock mapping strict; broad substring matching causes false positives.
  if (e === '解锁屏幕' || e.includes('锁屏解锁')) return 'screen_unlock';
  if (e.includes('画中画')) return 'navigation';
  if (e.includes('通知栏') || e.includes('通知')) return 'notification';
  if (e.includes('分屏')) return 'split_screen';
  if (e.includes('Activity')) return 'navigation';
  return null;
}

function mapScreenStateEventToSceneType(eventText: string): SceneCategory | null {
  const e = eventText.trim();
  if (!e) return null;
  if (e.includes('点亮')) return 'screen_on';
  if (e.includes('熄灭')) return 'screen_off';
  if (e.includes('休眠')) return 'screen_sleep';
  return null;
}

type ClientFindingPayload = {
  id: string;
  category?: string;
  severity?: string;
  title?: string;
  description?: string;
  timestampsNs?: any;
  evidence?: any;
  details?: any;
  recommendations?: any;
  confidence?: number;
};

function buildClientFindings(
  findings: AgentRuntimeAnalysisResult['findings'],
  scenes: DetectedScene[]
): ClientFindingPayload[] {
  const base: ClientFindingPayload[] = (findings || []).map((f: any) => ({
    id: String(f?.id || `finding_${Date.now()}`),
    category: f?.category,
    severity: f?.severity,
    title: f?.title,
    description: f?.description,
    timestampsNs: f?.timestampsNs,
    evidence: f?.evidence,
    details: f?.details,
    recommendations: f?.recommendations,
    confidence: f?.confidence,
  }));

  const hasIssueLikeFinding = base.some((f) => {
    const severity = String(f.severity || '').toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'warning') return true;
    return hasIssueSignalText(`${f.title || ''} ${f.description || ''}`);
  });

  const filtered = hasIssueLikeFinding
    ? base.filter((f) => !isNoIssueText(`${f.title || ''} ${f.description || ''}`))
    : base;

  const derived = deriveSceneIssueFindings(scenes);
  const merged = [...filtered, ...derived];

  const dedup = new Map<string, ClientFindingPayload>();
  for (const f of merged) {
    const key = `${String(f.title || '').trim()}::${String(f.description || '').trim()}`;
    if (!key || key === '::') {
      dedup.set(f.id, f);
      continue;
    }
    if (!dedup.has(key)) dedup.set(key, f);
  }

  return Array.from(dedup.values());
}

function buildSessionResultContract(
  session: AnalysisSession,
  findings: ClientFindingPayload[]
) {
  return buildAssistantResultContract({
    dataEnvelopes: session.dataEnvelopes,
    findings,
  });
}

function deriveSceneIssueFindings(scenes: DetectedScene[]): ClientFindingPayload[] {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  const scrollScenes = scenes.filter((s) => s.type === 'scroll');

  const inertialCandidates = scenes
    .filter((s) => s.type === 'inertial_scroll')
    .map((s) => ({
      scene: s,
      jankFrames: Number((s.metadata as any)?.jankFrames || 0),
    }))
    .filter((item) => item.jankFrames > 0)
    .sort((a, b) => b.jankFrames - a.jankFrames)
    .slice(0, 3);

  const derived: ClientFindingPayload[] = [];
  for (const item of inertialCandidates) {
    const s = item.scene;
    const severity =
      item.jankFrames >= 100 ? 'critical'
        : item.jankFrames >= 40 ? 'warning'
          : 'info';
    const app = s.appPackage || 'unknown';
    const inertialStartNs = toBigInt(s.startTs);
    const inertialEndNs = toBigInt(s.endTs);
    let totalScrollDurationMs = s.durationMs;
    if (inertialStartNs !== null && inertialEndNs !== null) {
      let parentScroll: DetectedScene | null = null;
      let parentStartNs: bigint | null = null;
      for (const scroll of scrollScenes) {
        const startNs = toBigInt(scroll.startTs);
        const endNs = toBigInt(scroll.endTs);
        if (startNs === null || endNs === null) continue;
        if (startNs <= inertialStartNs && endNs >= inertialStartNs) {
          if (!parentScroll || (parentStartNs !== null && startNs > parentStartNs)) {
            parentScroll = scroll;
            parentStartNs = startNs;
          }
        }
      }
      if (parentStartNs !== null && inertialEndNs > parentStartNs) {
        totalScrollDurationMs = Number((inertialEndNs - parentStartNs) / 1_000_000n);
      }
    }

    derived.push({
      id: `scene_inertial_${s.startTs}`,
      category: 'scroll',
      severity,
      title: `惯性滑动卡顿：${item.jankFrames} 帧异常`,
      description: `惯性 ${s.durationMs}ms，总滑动约 ${totalScrollDurationMs}ms，应用 ${app}，建议重点排查滑动后渲染路径`,
      details: {
        sceneType: s.type,
        startTs: s.startTs,
        endTs: s.endTs,
        durationMs: s.durationMs,
        totalScrollDurationMs,
        jankFrames: item.jankFrames,
        source: 'scene_reconstruction:derived',
      },
      confidence: 0.85,
    });
  }

  return derived;
}

function isNoIssueText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('未发现明显性能问题') ||
    t.includes('整体流畅度良好') ||
    t.includes('分析未发现明显问题')
  );
}

function hasIssueSignalText(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('卡顿') ||
    t.includes('掉帧') ||
    t.includes('缓冲区积压') ||
    t.includes('jank') ||
    t.includes('stutter') ||
    t.includes('deadline missed') ||
    t.includes('renderthread') ||
    t.includes('主线程阻塞')
  );
}

function isSceneReplayOnlyQuery(query: string): boolean {
  const q = String(query || '').toLowerCase();
  const isSceneQuery = q.includes('场景还原') || q.includes('scene reconstruction');
  if (!isSceneQuery) return false;
  // Scene reconstruction in this product is replay-first; quick/replay variants are explicit.
  return q.includes('仅检测') || q.includes('只检测') || q.includes('quick') || q.includes('replay');
}

const SCENE_RESPONSE_THRESHOLDS: Record<string, { good: number; acceptable: number }> = {
  cold_start: { good: 500, acceptable: 1000 },
  warm_start: { good: 300, acceptable: 600 },
  hot_start: { good: 100, acceptable: 200 },
  inertial_scroll: { good: 500, acceptable: 1000 },
  tap: { good: 100, acceptable: 200 },
  navigation: { good: 300, acceptable: 500 },
  app_switch: { good: 500, acceptable: 1000 },
};

function classifySceneResponse(scene: DetectedScene): '流畅' | '轻微波动' | '明显波动' | '未知' {
  const metadata = scene.metadata as Record<string, any> | undefined;

  if ((scene.type === 'scroll' || scene.type === 'inertial_scroll') && Number.isFinite(Number(metadata?.averageFps))) {
    const fps = Number(metadata?.averageFps);
    if (fps >= 55) return '流畅';
    if (fps >= 45) return '轻微波动';
    return '明显波动';
  }

  const thresholds = SCENE_RESPONSE_THRESHOLDS[scene.type];
  if (!thresholds) return '未知';
  if (scene.durationMs <= thresholds.good) return '流畅';
  if (scene.durationMs <= thresholds.acceptable) return '轻微波动';
  return '明显波动';
}

function formatSceneDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '-';
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

function formatSceneStartTsForNarrative(tsNs: string): string {
  const ns = toBigInt(tsNs);
  if (ns === null) return tsNs;
  const totalMs = Number(ns / 1_000_000n);
  const seconds = totalMs / 1000;
  if (!Number.isFinite(seconds)) return tsNs;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
}

function buildSceneReplayNarrative(scenes: DetectedScene[]): string {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return '未检测到可回放的用户操作场景。';
  }

  const sorted = [...scenes].sort((a, b) => {
    const aTs = toBigInt(a.startTs);
    const bTs = toBigInt(b.startTs);
    if (aTs === null || bTs === null) return 0;
    if (aTs > bTs) return 1;
    if (aTs < bTs) return -1;
    return 0;
  });
  const maxItems = 12;
  const sequenceLines = sorted.slice(0, maxItems).map((scene, idx) => {
    const displayName = SCENE_DISPLAY_NAMES[scene.type] || scene.type;
    const startTs = formatSceneStartTsForNarrative(scene.startTs);
    const duration = formatSceneDurationMs(scene.durationMs);
    const response = classifySceneResponse(scene);
    const appText = scene.appPackage ? `，应用 ${scene.appPackage}` : '';
    return `${idx + 1}. [${startTs}] ${displayName}，持续 ${duration}${appText}，响应状态：${response}`;
  });

  const extraLine = sorted.length > maxItems
    ? `- 其余 ${sorted.length - maxItems} 个场景可在表格中继续查看。`
    : '';

  return [
    `共还原 ${sorted.length} 个操作场景。以下为操作与设备响应事实回放（不含根因推断）：`,
    '',
    ...sequenceLines.map((line) => `- ${line}`),
    extraLine,
  ].filter(Boolean).join('\n');
}

// Delegates to the shared normalizer so CLI's buildReportHtml gets identical
// conclusion text for the same run. The HTTP-specific pieces (scene replay,
// sceneIdHint) stay inline in sendAgentDrivenResult.
function normalizeNarrativeForClient(narrative: string): string {
  return sharedNormalizeNarrative(narrative);
}

/**
 * Send agent-driven analysis result to SSE client
 */
function sendAgentDrivenResult(res: express.Response, session: AnalysisSession) {
  const result = session.result;
  if (!result) return;
  const observability = buildStreamObservability(session);
  const replayOnlyScene = isSceneReplayOnlyQuery(session.query);
  const normalizedConclusion = replayOnlyScene
    ? buildSceneReplayNarrative(session.scenes || [])
    : normalizeNarrativeForClient(result.conclusion);
  const sceneIdHint = replayOnlyScene
    ? undefined
    : resolveConclusionSceneIdHint({
      sessionId: session.sessionId,
      query: session.query,
      findings: result.findings,
    });
  // Fallback: re-derive contract if the orchestrator didn't populate it.
  // Note: mode heuristic uses rounds (available here) as proxy for turnCount
  // (which only the orchestrator knows). Both signal "multi-interaction" analysis.
  const normalizedConclusionContract = replayOnlyScene
    ? undefined
    : (
      result.conclusionContract ||
      deriveConclusionContract(normalizedConclusion, {
        mode: result.rounds > 1 ? 'focused_answer' : 'initial_report',
        sceneId: sceneIdHint,
      }) ||
      undefined
    );
  const resultForClient =
    normalizedConclusion === result.conclusion && normalizedConclusionContract === result.conclusionContract
      ? result
      : { ...result, conclusion: normalizedConclusion, conclusionContract: normalizedConclusionContract };
  const clientFindings = replayOnlyScene ? [] : buildClientFindings(result.findings, session.scenes || []);
  const resultContract = buildSessionResultContract(session, clientFindings);

  // Generate HTML report
  let reportUrl: string | undefined;
  let reportError: string | undefined;
  try {
    const generator = getHTMLReportGenerator();
    // Report assembly (cumulative findings dedup, empty-conclusion fallback,
    // snapshot-first analysisNotes/Plan/Flags) lives in the shared builder so
    // the CLI path produces identical output.
    const reportData = buildAgentDrivenReportData({
      session,
      result: resultForClient as any,
    });
    console.log(`[AgentRoutes] Generating HTML report, data keys:`, {
      hasResult: !!result,
      conclusionLength: normalizedConclusion?.length || 0,
      conclusionPreview: (normalizedConclusion || '').substring(0, 100),
      hasConclusionContract: !!normalizedConclusionContract,
      findingsCount: result.findings?.length || 0,
      hypothesesCount: session.hypotheses?.length || 0,
      dialogueCount: session.agentDialogue?.length || 0,
      conversationStepCount: session.conversationSteps?.length || 0,
      dataEnvelopesCount: session.dataEnvelopes?.length || 0,
      agentResponsesCount: session.agentResponses?.length || 0,
      conclusionHistoryCount: session.conclusionHistory?.length || 0,
      hasSnapshot: !!(session as any)._lastSnapshot,
      snapshotNotes: (session as any)._lastSnapshot?.analysisNotes?.length ?? 'n/a',
      snapshotPlan: !!(session as any)._lastSnapshot?.analysisPlan,
      snapshotFlags: (session as any)._lastSnapshot?.uncertaintyFlags?.length ?? 'n/a',
    });

    const html = generator.generateAgentDrivenHTML(reportData);

    // Store report
    const reportId = `agent-report-${session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    persistReport(reportId, {
      html,
      generatedAt: Date.now(),
      sessionId: session.sessionId,
    });

    reportUrl = `/api/reports/${reportId}`;
    console.log(`[AgentRoutes] Generated agent-driven HTML report: ${reportId} (${html.length} bytes)`);
  } catch (error: any) {
    reportError = error.message || 'Unknown error';
    console.error('[AgentRoutes] Failed to generate agent-driven HTML report:', {
      error: reportError,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
      resultConclusion: result?.conclusion ? `${result.conclusion.length} chars` : 'EMPTY/NULL',
      resultConfidence: result?.confidence,
      resultRounds: result?.rounds,
    });
  }

  // Send analysis_completed event with full result
  res.write(`event: analysis_completed\n`);
  res.write(`data: ${JSON.stringify({
    type: 'analysis_completed',
    architecture: 'agent-driven',
    ...observability,
    data: {
      conclusion: normalizedConclusion,
      conclusionContract: normalizedConclusionContract,
      confidence: result.confidence,
      rounds: result.rounds,
      totalDurationMs: result.totalDurationMs,
      partial: result.partial,
      terminationReason: result.terminationReason,
      terminationMessage: result.terminationMessage,
      findings: clientFindings,
      resultContract,
      hypotheses: result.hypotheses.map((h: AgentRuntimeAnalysisResult['hypotheses'][number]) => ({
        id: h.id,
        description: h.description,
        status: h.status,
        confidence: h.confidence,
        supportingEvidence: h.supportingEvidence,
        contradictingEvidence: h.contradictingEvidence,
      })),
      agentDialogueCount: session.agentDialogue.length,
      conversationTimelineCount: session.conversationSteps.length,
      conversationTimeline: session.conversationSteps,
      reportUrl,
      reportError,
      observability,
    },
    timestamp: Date.now(),
  })}\n\n`);

  // Backward-compatible scene reconstruction payload (used by the legacy /scene-reconstruct clients).
  if ((session.scenes?.length || 0) > 0 || (session.trackEvents?.length || 0) > 0) {
    res.write(`event: scene_reconstruction_completed\n`);
    res.write(`data: ${JSON.stringify({
      type: 'scene_reconstruction_completed',
      ...observability,
      data: {
        narrative: normalizedConclusion,
        confidence: result.confidence,
        executionTimeMs: result.totalDurationMs,
        scenes: (session.scenes || []).map((s) => ({
          type: s.type,
          startTs: s.startTs,
          endTs: s.endTs,
          durationMs: s.durationMs,
          confidence: s.confidence,
          appPackage: s.appPackage,
        })),
        trackEvents: session.trackEvents || [],
        findings: clientFindings.map((f) => ({
          id: f.id,
          category: f.category,
          severity: f.severity,
          title: f.title,
          description: f.description,
          timestampsNs: f.timestampsNs,
        })),
        suggestions: [],
        observability,
      },
      timestamp: Date.now(),
    })}\n\n`);
  }
}

registerAgentLogsRoutes(router);

// ============================================================================
// Cleanup
// ============================================================================

// Cleanup old sessions every 30 minutes
const sessionCleanupInterval = setInterval(() => {
  assistantAppService.cleanupIdleSessions({
    terminalMaxIdleMs: TERMINAL_SESSION_MAX_IDLE_MS,
    nonTerminalMaxIdleMs: NON_TERMINAL_SESSION_MAX_IDLE_MS,
    onCleanup: (sessionId, session) => {
      console.log(`[AgentRoutes] Cleaning up stale session: ${sessionId}`);
      session.sseClients.forEach((client) => {
        try {
          client.end();
        } catch {
          // Ignore closed sockets during cleanup.
        }
      });
      // Clean up session-scoped state only — do NOT call reset() which clears
      // global caches (architectureCache) shared across all active sessions.
      if (typeof session.orchestrator.cleanupSession === 'function') {
        session.orchestrator.cleanupSession(sessionId);
      }
      // Also clean up the EnhancedSessionContext (EntityStore, turns, working memory)
      sessionContextManager.remove(sessionId);
    },
  });

  // Piggyback the Scene Story disk cache cleanup on the same 30-min cadence.
  // It's idempotent and self-contained, so a failed sweep here only delays
  // expired-report removal by another 30 minutes — never blocks session
  // cleanup or throws into the interval.
  void sceneReportStore
    .cleanupExpired(Date.now())
    .then((removed) => {
      if (removed > 0) {
        console.log(`[AgentRoutes] SceneReportStore expired ${removed} report(s)`);
      }
    })
    .catch((err) => {
      console.warn('[AgentRoutes] SceneReportStore cleanupExpired failed:', err?.message ?? err);
    });
}, 30 * 60 * 1000);
sessionCleanupInterval.unref?.();

export default router;
