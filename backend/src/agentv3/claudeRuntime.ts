// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { TraceProcessorService } from '../services/traceProcessorService';
import { createSkillExecutor } from '../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../services/skillEngine/skillLoader';
import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../agent/types/agentProtocol';
import type { AnalysisResult, AnalysisOptions, IOrchestrator } from '../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../agent/detectors/types';

import { createClaudeMcpServer, loadLearnedSqlFixPairs, MCP_NAME_PREFIX } from './claudeMcpServer';
import { buildSystemPrompt, buildQuickSystemPrompt, buildSelectionContextSection } from './claudeSystemPrompt';
import { createSseBridge } from './claudeSseBridge';
import {
  buildMaxTurnsFallbackConclusion,
  buildMaxTurnsTerminationMessage,
  capPartialConfidence,
  isSdkMaxTurnsSubtype,
  MAX_TURNS_TERMINATION_REASON,
  prependPartialNotice,
  SDK_MAX_TURNS_SUBTYPE,
} from './analysisTermination';
import { extractFindingsFromText, extractFindingsFromSkillResult, mergeFindings } from './claudeFindingExtractor';
import { loadClaudeConfig, resolveEffort, createSdkEnv, createQuickConfig, type ClaudeAgentConfig } from './claudeConfig';
import { detectFocusApps } from './focusAppDetector';
import { classifyScene, type SceneType } from './sceneClassifier';
import { classifyQueryComplexity } from './queryComplexityClassifier';
import { buildAgentDefinitions } from './claudeAgentDefinitions';
import { getExtendedKnowledgeBase } from '../services/sqlKnowledgeBase';
import type { AnalysisNote, AnalysisPlanV3, ClaudeAnalysisContext, ComplexityClassifierInput, FailedApproach, Hypothesis, QueryComplexity, TraceCompleteness, ToolCallRecord, UncertaintyFlag } from './types';
import { phaseMatchesCall } from './types';
import { ArtifactStore } from './artifactStore';
import { summarizeToolCallInput } from './toolCallSummary';
import { buildRecoveryNote } from './recoveryNoteBuilder';
import { evaluateThreshold as evaluateContextThreshold } from './contextTokenMeter';
import type { SessionStateSnapshot, SessionFieldsForSnapshot } from './sessionStateSnapshot';
import { AgentMetricsCollector, persistSessionMetrics } from './agentMetrics';
import {
  extractTraceFeatures,
  extractKeyInsights,
  saveAnalysisPattern,
  saveNegativePattern,
  saveQuickPathPattern,
  promoteQuickPatternIfMatching,
  buildPatternContextSection,
  buildNegativePatternSection,
} from './analysisPatternMemory';
import { SkillNotesBudget } from './selfImprove/skillNotesInjector';
import { runSnapshots } from './selfImprove/strategyFingerprint';
import { verifyConclusion, generateCorrectionPrompt, isConclusionIncomplete } from './claudeVerifier';

function parseQuickBudgetEnv(): number | undefined {
  const v = process.env.SELF_IMPROVE_QUICK_NOTES_BUDGET;
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
import { probeTraceCompleteness } from './traceCompletenessProber';
import {
  captureEntitiesFromResponses,
  applyCapturedEntities,
} from '../agent/core/entityCapture';

const SESSION_MAP_FILE = path.resolve(__dirname, '../../logs/claude_session_map.json');
/** Max age for session map entries before pruning (24 hours). */
const SESSION_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SessionMapEntry {
  sdkSessionId: string;
  updatedAt: number;
}

function loadPersistedSessionMap(): Map<string, SessionMapEntry> {
  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf-8'));
      const map = new Map<string, SessionMapEntry>();
      for (const [key, value] of Object.entries(data)) {
        // Migration: old format stored plain string, new format stores {sdkSessionId, updatedAt}
        if (typeof value === 'string') {
          map.set(key, { sdkSessionId: value, updatedAt: Date.now() });
        } else if (value && typeof value === 'object') {
          map.set(key, value as SessionMapEntry);
        }
      }
      return map;
    }
  } catch {
    // Ignore — start with empty map
  }
  return new Map();
}

/**
 * Debounce timer for session map persistence — avoids blocking event loop on every SDK message.
 * P2-1: Use a Map keyed by the Map reference to support multiple ClaudeRuntime instances.
 */
const saveTimers = new WeakMap<Map<string, SessionMapEntry>, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 2000;

function savePersistedSessionMap(map: Map<string, SessionMapEntry>): void {
  const existing = saveTimers.get(map);
  if (existing) clearTimeout(existing);
  saveTimers.set(map, setTimeout(() => {
    saveTimers.delete(map);
    savePersistedSessionMapSync(map);
  }, SAVE_DEBOUNCE_MS));
}

/** Immediate save — used by debounce timer and for critical operations (session removal). */
function savePersistedSessionMapSync(map: Map<string, SessionMapEntry>): void {
  try {
    const dir = path.dirname(SESSION_MAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Prune stale entries before saving
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.updatedAt > SESSION_MAP_MAX_AGE_MS) {
        map.delete(key);
      }
    }

    const tmpFile = SESSION_MAP_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(map)));
    fs.renameSync(tmpFile, SESSION_MAP_FILE);
  } catch (err) {
    console.warn('[ClaudeRuntime] Failed to persist session map:', (err as Error).message);
  }
}

// Notes persistence now handled by unified SessionStateSnapshot — no separate disk I/O.
// The old logs/session_notes/ directory is no longer written to.

// P2-G1: ALLOWED_TOOLS is now auto-derived from createClaudeMcpServer() return value.
// No longer hardcoded — adding a new MCP tool automatically includes it.

/**
 * Format pre-queried trace datasets as Markdown tables to prepend to the AI prompt.
 * Mirrors smartperfetto's approach: data is ready upfront so the AI skips basic SQL turns.
 */
function formatTraceContext(datasets: import('../agent/core/orchestratorTypes').TraceDataset[]): string {
  if (!datasets || datasets.length === 0) return '';
  const parts = datasets.map((d) => {
    const header = `| ${d.columns.join(' | ')} |`;
    const sep = `| ${d.columns.map(() => '---').join(' | ')} |`;
    const rows = (d.rows as unknown[][]).slice(0, 100).map(
      (r) => `| ${r.map((v) => String(v ?? '—')).join(' | ')} |`,
    );
    const truncNote = d.rows.length > 100 ? `\n*(前 100 行，共 ${d.rows.length} 行)*` : '';
    return `### ${d.label}\n${header}\n${sep}\n${rows.join('\n')}${truncNote}`;
  });
  return `## 前端预查询 Trace 数据\n\n以下数据已由前端查询完毕，直接使用，无需重复 SQL 查询：\n\n${parts.join('\n\n')}`;
}

/** Check if an error is retryable (API overload/server errors). */
function isRetryableError(err: Error): boolean {
  const msg = err.message || '';
  // Anthropic API errors: 529 (overload), 500 (server), 503 (service unavailable)
  return /529|overload|500|server error|503|service unavailable|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handle returned by sdkQueryWithRetry. `stream` is the (retry-wrapped)
 * async iterable of SDK messages; `close()` aborts the underlying SDK
 * subprocess and any in-flight MCP tool calls.
 *
 * Callers MUST invoke `close()` (typically from a timeout handler and as a
 * `finally` safety net) to prevent zombie MCP tool executions from running
 * after the session has been torn down.
 */
interface SdkQueryHandle {
  stream: ReturnType<typeof sdkQuery>;
  close: () => void;
}

/**
 * Wrap sdkQuery with exponential backoff retry for transient API errors
 * and expose a `close()` handle so timeout/abort paths can terminate the
 * SDK subprocess instead of just breaking out of the `for await` loop.
 *
 * Without `close()`, a consumer that `break`s out of the iterator leaves
 * the SDK free to continue executing queued MCP tool calls (e.g.
 * `execute_sql`). Those "ghost" calls hit trace_processor after the
 * session logger has closed, producing orphan errors no one handles.
 */
function sdkQueryWithRetry(
  params: Parameters<typeof sdkQuery>[0],
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    emitUpdate?: (update: StreamingUpdate) => void;
  } = {},
): SdkQueryHandle {
  const { maxRetries = 2, baseDelayMs = 2000, emitUpdate } = options;

  // Tracks the Query instance currently being iterated so `close()` can
  // forward termination to the underlying SDK subprocess across retries.
  let currentQuery: ReturnType<typeof sdkQuery> | undefined;
  let closed = false;

  // We can't directly retry an async iterable, so we use a generator wrapper.
  // On the first call to next(), we attempt sdkQuery. If it throws, we retry.
  async function* retryableStream() {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (closed) return;
      try {
        currentQuery = sdkQuery(params);
        // Yield all messages from the stream
        for await (const msg of currentQuery) {
          if (closed) return;
          yield msg;
        }
        return; // Success — exit generator
      } catch (err) {
        lastErr = err as Error;
        // If the caller invoked close(), treat the resulting error as
        // intentional termination rather than a retryable failure.
        if (closed) return;
        if (isRetryableError(lastErr) && attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.warn(`[ClaudeRuntime] API error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastErr.message}. Retrying in ${delay}ms...`);
          emitUpdate?.({
            type: 'progress',
            content: { phase: 'starting', message: `API 暂时不可用，${Math.round(delay / 1000)}s 后重试 (${attempt + 1}/${maxRetries})...` },
            timestamp: Date.now(),
          });
          await sleep(delay);
          continue;
        }
        throw lastErr; // Non-retryable or max retries exceeded
      }
    }
    if (lastErr) throw lastErr;
  }

  return {
    stream: retryableStream() as ReturnType<typeof sdkQuery>,
    close: () => {
      if (closed) return; // Idempotent — safe to call from timeout handler AND finally.
      closed = true;
      try {
        currentQuery?.close();
      } catch (err) {
        console.warn('[ClaudeRuntime] sdkQueryWithRetry close() failed (non-fatal):', (err as Error).message);
      }
    },
  };
}

/**
 * Claude Agent SDK runtime for SmartPerfetto.
 * Replaces the agentv2 governance pipeline with Claude-as-orchestrator.
 * Implements the same EventEmitter + analyze() interface as AgentRuntime.
 */
export class ClaudeRuntime extends EventEmitter implements IOrchestrator {
  private traceProcessorService: TraceProcessorService;
  private config: ClaudeAgentConfig;
  private sessionMap: Map<string, SessionMapEntry>;
  /** Cache architecture detection results per traceId (deterministic per trace). */
  private architectureCache: Map<string, ArchitectureInfo> = new Map();
  /** Cache vendor detection results per traceId (deterministic per trace). */
  private vendorCache: Map<string, string> = new Map();
  /** Cache trace completeness probe results per traceId (deterministic per trace). */
  private completenessCache: Map<string, TraceCompleteness> = new Map();
  /** Per-session artifact stores — persist across turns within a session. */
  private artifactStores: Map<string, ArtifactStore> = new Map();
  /** Per-session analysis notes — persist across turns within a session. */
  private sessionNotes: Map<string, AnalysisNote[]> = new Map();
  /** Per-session SQL error tracking for error-fix pair learning. */
  private sessionSqlErrors: Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number }>> = new Map();
  /** Per-session analysis plans for plan adherence tracking. */
  private sessionPlans: Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }> = new Map();
  /** Per-session hypotheses for hypothesis-verify cycle (P0-G4). */
  private sessionHypotheses: Map<string, Hypothesis[]> = new Map();
  /** Per-session uncertainty flags for non-blocking human interaction (P1-G1). */
  private sessionUncertaintyFlags: Map<string, UncertaintyFlag[]> = new Map();
  /** Guard against concurrent analyze() calls for the same session. */
  private activeAnalyses: Set<string> = new Set();

  constructor(traceProcessorService: TraceProcessorService, config?: Partial<ClaudeAgentConfig>) {
    super();
    this.traceProcessorService = traceProcessorService;
    this.config = loadClaudeConfig(config);
    this.sessionMap = loadPersistedSessionMap();
  }

  /** Restore a previously persisted SDK session mapping (e.g., after server restart). */
  restoreSessionMapping(smartPerfettoSessionId: string, sdkSessionId: string): void {
    this.sessionMap.set(smartPerfettoSessionId, { sdkSessionId, updatedAt: Date.now() });
  }

  /** Restore a cached architecture detection result (e.g., from session persistence). */
  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    this.architectureCache.set(traceId, architecture);
  }

  /** Get cached architecture for a traceId (used for persistence). */
  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
  }

  /** Get SDK session ID for persistence. */
  getSdkSessionId(smartPerfettoSessionId: string): string | undefined {
    return this.sessionMap.get(smartPerfettoSessionId)?.sdkSessionId;
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    // Prevent concurrent analyze() calls for the same session
    if (this.activeAnalyses.has(sessionId)) {
      throw new Error(`Analysis already in progress for session ${sessionId}`);
    }
    this.activeAnalyses.add(sessionId);

    const startTime = Date.now();
    const allFindings: Finding[][] = [];
    let conclusionText = '';
    let sdkSessionId: string | undefined;
    let rounds = 0;
    const metricsCollector = new AgentMetricsCollector(sessionId);

    try {
      // Phase 0: Complexity classification — runs in parallel with early context prep
      const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const previousTurns = sessionContext.getAllTurns?.() || [];
      const sceneType = classifyScene(query);
      // Freeze the strategy version for the duration of this analyze() call so
      // a hot-reload mid-flight can't split-brain the agent's reasoning.
      runSnapshots.capture(sessionId, sceneType);

      const classifierInput: ComplexityClassifierInput = {
        query,
        sceneType,
        hasSelectionContext: !!options.selectionContext,
        hasReferenceTrace: !!options.referenceTraceId,
        // Only count findings from full (non-simple) turns as "existing findings" for drill-down detection
        hasExistingFindings: previousTurns.some(t => t.intent?.complexity !== 'simple' && t.findings?.length > 0),
        // Distinguish: only full analysis turns trigger multi-turn continuity (not prior quick turns)
        hasPriorFullAnalysis: previousTurns.some(t => t.intent?.complexity !== 'simple'),
      };

      const cachedArch = this.architectureCache.get(traceId);

      // Focus detection runs for every path — kick it off once and let the classifier
      // (if needed) share the wait. Explicit 'fast'/'full' skips the classifier entirely.
      const explicitMode = options.analysisMode;
      const focusPromise = detectFocusApps(this.traceProcessorService, traceId).catch((err) => {
        console.warn('[ClaudeRuntime] Focus app detection failed (graceful):', (err as Error).message);
        return { apps: [], primaryApp: undefined, method: 'none' as const };
      });

      let queryComplexity: QueryComplexity;
      let classifierSource: 'user_explicit' | 'hard_rule' | 'ai';
      let classifierReason: string;

      if (explicitMode === 'fast' || explicitMode === 'full') {
        queryComplexity = explicitMode === 'fast' ? 'quick' : 'full';
        classifierSource = 'user_explicit';
        classifierReason = `user requested ${explicitMode}`;
      } else {
        const classifierResult = await classifyQueryComplexity(classifierInput, this.config);
        queryComplexity = classifierResult.complexity;
        classifierSource = classifierResult.source;
        classifierReason = classifierResult.reason;
      }

      const focusResult = await focusPromise;
      const displayMode: 'fast' | 'full' | 'auto' = explicitMode ?? 'auto';
      console.log(
        `[ClaudeRuntime] Query complexity: ${queryComplexity} ` +
        `(mode: ${displayMode}, source: ${classifierSource}, reason: ${classifierReason})`,
      );
      metricsCollector.recordAnalysisMode(displayMode, classifierSource);

      // Quick path: lightweight analysis for simple factual queries
      if (queryComplexity === 'quick') {
        return await this.analyzeQuick(query, sessionId, traceId, options, {
          sceneType,
          focusResult,
          cachedArch,
          sessionContext,
          previousTurns,
          metricsCollector,
          startTime,
        });
      }

      // Full path: original comprehensive analysis pipeline
      const ctx = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        focusResult,
        sessionContext,
        previousTurns,
        sceneType,
      });

      const { handleMessage: bridge, getAccumulatedAnswer } = createSseBridge((update: StreamingUpdate) => {
        this.emitUpdate(update);
        if (update.type === 'agent_response' && update.content?.result) {
          try {
            const parsed = typeof update.content.result === 'string'
              ? JSON.parse(update.content.result)
              : update.content.result;
            if (parsed?.success && parsed?.skillId) {
              allFindings.push(extractFindingsFromSkillResult(parsed));
            }
            if (parsed?.success && parsed?.displayResults) {
              this.captureEntitiesFromSkillDisplayResults(parsed.displayResults, ctx.entityStore);
            }
          } catch {
            // Not a skill result — ignore
          }
        }
      });

      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: `使用 ${this.config.model} 开始分析 (effort: ${ctx.effectiveEffort})...` },
        timestamp: Date.now(),
      });

      // Reuse composite key from prepareAnalysisContext for comparison mode session identity isolation
      const existingSdkSessionId = this.sessionMap.get(ctx.sessionMapKey)?.sdkSessionId;

      // When resuming an SDK session, systemPrompt is ignored by the SDK (mutually exclusive).
      // Prepend selectionContext directly into the prompt so the AI sees it in the conversation.
      let effectivePrompt = query;
      if (existingSdkSessionId && options.selectionContext) {
        const selSection = buildSelectionContextSection(options.selectionContext);
        if (selSection) {
          effectivePrompt = `${selSection}\n\n${query}`;
        }
      }
      // Prepend pre-queried trace data so the AI has all context without spending turns on SQL
      if (options.traceContext && options.traceContext.length > 0) {
        const traceSection = formatTraceContext(options.traceContext);
        effectivePrompt = `${traceSection}\n\n${effectivePrompt}`;
      }

      const sdkEnv = createSdkEnv();

      const { stream, close: closeSdk } = sdkQueryWithRetry({
        prompt: effectivePrompt,
        options: {
          model: this.config.model,
          maxTurns: this.config.maxTurns,
          systemPrompt: ctx.systemPrompt,
          mcpServers: { smartperfetto: ctx.mcpServer },
          includePartialMessages: true,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          cwd: this.config.cwd,
          effort: ctx.effectiveEffort,
          allowedTools: ctx.allowedTools,
          env: sdkEnv,
          stderr: (data: string) => {
            console.warn(`[ClaudeRuntime] SDK stderr [${sessionId}]: ${data.trimEnd()}`);
          },
          ...(this.config.maxBudgetUsd ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
          ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
          ...(ctx.agents ? { agents: ctx.agents } : {}),
        },
      }, { emitUpdate: (update) => this.emitUpdate(update) });

      let finalResult: string | undefined;
      let terminationReason: AnalysisResult['terminationReason'];
      let terminationMessage: string | undefined;

      // Safety timeout with stream cancellation via Promise.race.
      // Per-turn budget is env-configurable (CLAUDE_FULL_PER_TURN_MS, default 60s) so slower
      // LLMs (DeepSeek / Ollama / GLM) have room per turn without false timeouts.
      // Scrolling deep-drill (hypothesis + SQL + knowledge + conclusion) still needs ~6-8 min.
      const timeoutMs = (this.config.maxTurns || 15) * this.config.fullPathPerTurnMs;
      let timedOut = false;

      // Sub-agent timeout tracking — stop tasks that exceed subAgentTimeoutMs
      const activeSubAgentTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
      const subAgentTimeoutMs = this.config.subAgentTimeoutMs;

      // P2-1: Turn-level autonomy watchdog — detect repetitive tool failures
      // P1-G2: Per-tool tracking — each tool gets its own failure tracking
      const toolCallHistory: Array<{ name: string; success: boolean; startTime?: number; input?: unknown }> = [];
      const WATCHDOG_WINDOW = 3; // consecutive same-tool failures to trigger warning
      const watchdogFiredTools = new Set<string>(); // tracks which tools have triggered warnings

      // P0-G16: Circuit breaker — overall tool call failure rate monitoring
      let circuitBreakerFires = 0;
      const MAX_CIRCUIT_BREAKER_FIRES = 2;
      const CIRCUIT_BREAKER_WINDOW = 5;
      const CIRCUIT_BREAKER_THRESHOLD = 0.6; // 60% failure rate
      let lastCircuitBreakerFireIdx = -Infinity;

      // P1: Negative memory — collect failed approaches for cross-session learning
      const failedApproaches: FailedApproach[] = [];

      /** Track whether SDK auto-compact has fired during this turn.
       *  When true, the SDK has summarized prior conversation history,
       *  potentially losing early-turn details. We log this for diagnostics. */
      let sdkCompactDetected = false;

      // ── Per-turn metrics collection ──
      // Turn boundary: assistant message = start, next assistant message = end of previous turn.
      // Usage is attributed to the turn that triggered the API call.
      interface TurnMetrics {
        turnIndex: number;
        startMs: number;
        durationMs?: number;
        firstTokenLatencyMs?: number;
        toolCalls: string[];
        toolResultPayloadBytes: number;
        hasExtendedThinking: boolean;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
      const turnMetricsList: TurnMetrics[] = [];
      let currentTurnMetrics: TurnMetrics | null = null;
      let turnCounter = 0;
      let firstTokenReceived = false;

      // Phase 3-3 of v2.1 (monitor-only): track when the running conversation
      // crosses the pre-rot threshold so prod can quantify how often we *would*
      // have benefited from an interrupt+resume cycle. The actual interrupt+
      // resume orchestration is intentionally not wired yet — see
      // `docs/archive/context-engineering/v2.1-phase-3-active-compact-design.md`. Disable by setting
      // `CLAUDE_PRECOMPACT_WARN_ENABLED=false`.
      let preCompactWarned = false;
      const preCompactWarnEnabled = process.env.CLAUDE_PRECOMPACT_WARN_ENABLED !== 'false';
      const emitUpdate = this.emitUpdate.bind(this);

      function checkContextPressure(): void {
        if (!preCompactWarnEnabled || preCompactWarned) return;
        const cumulativeUncached = turnMetricsList.reduce((acc, t) => acc + (t.inputTokens ?? 0), 0);
        const cumulativeCacheCreation = turnMetricsList.reduce((acc, t) => acc + (t.cacheCreationTokens ?? 0), 0);
        const cumulativePayloadBytes = turnMetricsList.reduce((acc, t) => acc + t.toolResultPayloadBytes, 0);
        const decision = evaluateContextThreshold({
          uncachedInputTokens: cumulativeUncached,
          cacheCreationInputTokens: cumulativeCacheCreation,
          recentToolPayloadBytes: cumulativePayloadBytes,
        });
        if (decision.shouldPrecompact) {
          preCompactWarned = true;
          console.warn(
            `[ClaudeRuntime] Session ${sessionId}: pre-rot threshold crossed ` +
            `(pressure=${decision.pressureTokens} / ${decision.thresholdTokens} tokens, ratio=${decision.pressureRatio.toFixed(2)}). ` +
            `Phase 3-3 will eventually interrupt+resume here; for now we only log.`,
          );
          emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: `⚠️ 接近上下文上限（已用 ${(decision.pressureRatio * 100).toFixed(0)}%），后续轮次可能因压缩丢失细节`,
            },
            timestamp: Date.now(),
          });
        }
      }

      function finalizeTurnMetrics(): void {
        if (currentTurnMetrics) {
          currentTurnMetrics.durationMs = Date.now() - currentTurnMetrics.startMs;
          turnMetricsList.push(currentTurnMetrics);
          checkContextPressure();
        }
      }

      const processStream = async () => {
        for await (const msg of stream) {
          if (timedOut) break; // P0-1: Actually cancel stream on timeout

          // Detect SDK auto-compact boundary — conversation history was summarized
          if ((msg as any).type === 'system' && (msg as any).subtype === 'compact_boundary') {
            sdkCompactDetected = true;
            console.warn(`[ClaudeRuntime] SDK auto-compact detected for session ${sessionId} — prior turns summarized`);
          }

          if (msg.session_id && !sdkSessionId) {
            sdkSessionId = msg.session_id;
            this.sessionMap.set(ctx.sessionMapKey, { sdkSessionId, updatedAt: Date.now() });
            savePersistedSessionMap(this.sessionMap);
          }

          // Track sub-agent lifecycle for per-agent timeouts
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_started') {
            const taskId = (msg as any).task_id;
            if (taskId && subAgentTimeoutMs > 0) {
              const timer = setTimeout(() => {
                console.warn(`[ClaudeRuntime] Sub-agent timeout: stopping task ${taskId} after ${subAgentTimeoutMs / 1000}s`);
                activeSubAgentTimers.delete(taskId);
                if (typeof (stream as any).stopTask === 'function') {
                  (stream as any).stopTask(taskId).catch((err: Error) => {
                    console.warn(`[ClaudeRuntime] Failed to stop sub-agent task ${taskId}:`, err.message);
                  });
                }
                // P1-6: Record timeout as a finding so it's reflected in confidence
                allFindings.push([{
                  id: `sub-agent-timeout-${taskId}`,
                  title: `子代理超时`,
                  severity: 'medium' as const,
                  category: 'sub-agent',
                  description: `子代理 ${taskId} 超时 (${subAgentTimeoutMs / 1000}s)，分析可能不完整`,
                  confidence: 0.3,
                }]);
                this.emitUpdate({
                  type: 'progress',
                  content: { phase: 'analyzing', message: `子代理超时 (${subAgentTimeoutMs / 1000}s)，已停止` },
                  timestamp: Date.now(),
                });
              }, subAgentTimeoutMs);
              activeSubAgentTimers.set(taskId, timer);
            }
          }
          if ((msg as any).type === 'system' && (msg as any).subtype === 'task_notification') {
            const taskId = (msg as any).task_id;
            if (taskId) {
              const timer = activeSubAgentTimers.get(taskId);
              if (timer) {
                clearTimeout(timer);
                activeSubAgentTimers.delete(taskId);
              }
            }
            // P1-5: Extract findings from sub-agent completion summaries.
            // Without this, sub-agent evidence is only in the conclusion text
            // and not merged into allFindings for confidence estimation.
            const summary = (msg as any).summary || '';
            const status = (msg as any).status || 'completed';
            if (status === 'completed' && summary) {
              allFindings.push(extractFindingsFromText(summary));
            }
          }

          // Bridge SDK messages to SSE events
          try {
            bridge(msg);
          } catch (bridgeErr) {
            console.warn('[ClaudeRuntime] SSE bridge error (non-fatal):', (bridgeErr as Error).message);
          }

          // ── Per-turn metrics: track stream_event signals ──
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            // First token latency
            if (!firstTokenReceived &&
                event?.type === 'content_block_delta' &&
                (event.delta?.type === 'text_delta' || event.delta?.type === 'tool_use')) {
              firstTokenReceived = true;
              currentTurnMetrics.firstTokenLatencyMs = Date.now() - currentTurnMetrics.startMs;
            }
            // Extended thinking detection
            if (event?.type === 'content_block_start' && event.content_block?.type === 'thinking') {
              currentTurnMetrics.hasExtendedThinking = true;
            }
          }

          // assistant message = new turn starts; finalize previous turn + watchdog tracking
          if (msg.type === 'assistant' && Array.isArray((msg as any).message?.content)) {
            finalizeTurnMetrics();
            turnCounter++;
            firstTokenReceived = false;
            const toolNames: string[] = [];
            for (const block of (msg as any).message.content) {
              if (block.type === 'tool_use') {
                toolNames.push(block.name.replace(MCP_NAME_PREFIX, ''));
                // P2-1: Watchdog — track tool calls for repetitive failure detection
                toolCallHistory.push({
                  name: block.name,
                  success: true,
                  startTime: Date.now(),
                  input: block.input,
                });
              }
            }
            currentTurnMetrics = {
              turnIndex: turnCounter,
              startMs: Date.now(),
              toolCalls: toolNames,
              toolResultPayloadBytes: 0,
              hasExtendedThinking: false,
            };
          }

          if (msg.type === 'user' && (msg as any).tool_use_result !== undefined) {
            const result = (msg as any).tool_use_result;
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            // Per-turn metrics: track tool result payload size
            if (currentTurnMetrics) {
              currentTurnMetrics.toolResultPayloadBytes += Buffer.byteLength(resultStr, 'utf-8');
            }
            const isFailed = resultStr.includes('"success":false') || resultStr.includes('"isError":true');
            if (toolCallHistory.length > 0) {
              const lastTool = toolCallHistory[toolCallHistory.length - 1];
              lastTool.success = !isFailed;
              // Record tool execution in metrics collector (stream-observed timing)
              const toolName = lastTool.name.replace(MCP_NAME_PREFIX, '');
              const durationMs = lastTool.startTime ? Date.now() - lastTool.startTime : 0;
              metricsCollector.recordToolFromStream(toolName, durationMs, !isFailed);
            }
            // Check for consecutive same-tool failures (P1-G2: per-tool tracking)
            if (toolCallHistory.length >= WATCHDOG_WINDOW) {
              const recent = toolCallHistory.slice(-WATCHDOG_WINDOW);
              const allSameTool = recent.every(t => t.name === recent[0].name);
              const allFailed = recent.every(t => !t.success);
              const toolName = recent[0].name.replace(MCP_NAME_PREFIX, '');
              if (allSameTool && allFailed && !watchdogFiredTools.has(toolName)) {
                watchdogFiredTools.add(toolName);
                console.warn(`[ClaudeRuntime] Watchdog: ${WATCHDOG_WINDOW} consecutive failures for ${toolName}`);
                // P1-2: Inject warning into next MCP tool result (Claude reads this)
                ctx.watchdogWarning.current = `${toolName} 已连续失败 ${WATCHDOG_WINDOW} 次。请切换分析策略：尝试不同的 SQL 查询、使用其他 skill、或调整参数。不要重复相同的失败操作。`;
                // P1: Record for negative memory
                failedApproaches.push({
                  type: 'tool_failure',
                  approach: `连续调用 ${toolName} ${WATCHDOG_WINDOW} 次均失败`,
                  reason: '同一工具重复失败，需要切换策略',
                });
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: `⚠ 检测到 ${toolName} 连续 ${WATCHDOG_WINDOW} 次失败，已注入策略切换指令`,
                  },
                  timestamp: Date.now(),
                });
              }
            }
            // Track tool call for plan adherence with phase matching (P0-1 + P1-1)
            // P1-G5: Best-fit phase-tool matching — search all eligible phases, not just first
            if (ctx.analysisPlan.current && toolCallHistory.length > 0) {
              const lastTool = toolCallHistory[toolCallHistory.length - 1];
              const plan = ctx.analysisPlan.current;
              const shortToolName = lastTool.name.replace(MCP_NAME_PREFIX, '');
              const callSummary = summarizeToolCallInput(shortToolName, lastTool.input);
              const candidate: ToolCallRecord = {
                toolName: lastTool.name,
                timestamp: Date.now(),
                ...callSummary,
              };
              // Priority: in_progress phase first, then any pending phase whose expectations match
              const activePhase = plan.phases.find(p => p.status === 'in_progress');
              let matchedPhaseId: string | undefined;
              if (activePhase && phaseMatchesCall(activePhase, candidate)) {
                matchedPhaseId = activePhase.id;
              } else {
                const pendingMatch = plan.phases.find(p =>
                  p.status === 'pending' && phaseMatchesCall(p, candidate),
                );
                matchedPhaseId = pendingMatch?.id;
              }
              plan.toolCallLog.push({ ...candidate, matchedPhaseId });
              // P2-8: Cap toolCallLog to prevent unbounded growth within a turn
              if (plan.toolCallLog.length > 100) {
                plan.toolCallLog.splice(0, plan.toolCallLog.length - 100);
              }
            }

            // P0-G16: Circuit breaker — overall failure rate monitoring
            // Unlike watchdog (same-tool consecutive failures), this monitors aggregate health.
            // Fires when >60% of recent tool calls fail, regardless of which tools.
            // P1-G9: Circuit breaker can fire even with pending watchdog warning
            // (CB is higher priority — its "simplify scope" message overwrites per-tool warnings)
            if (circuitBreakerFires < MAX_CIRCUIT_BREAKER_FIRES
                && toolCallHistory.length >= CIRCUIT_BREAKER_WINDOW
                && toolCallHistory.length - lastCircuitBreakerFireIdx >= 3) {
              const recentWindow = toolCallHistory.slice(-CIRCUIT_BREAKER_WINDOW);
              const failCount = recentWindow.filter(t => !t.success).length;
              const failRate = failCount / recentWindow.length;
              if (failRate >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitBreakerFires++;
                lastCircuitBreakerFireIdx = toolCallHistory.length;
                ctx.watchdogWarning.current =
                  `⚠️ 分析断路器触发：最近 ${CIRCUIT_BREAKER_WINDOW} 次工具调用中 ${failCount} 次失败 (${(failRate * 100).toFixed(0)}%)。` +
                  `请：1) 简化分析范围，2) 使用更基础的查询，3) 如果数据不可用则基于已有证据出结论。不要继续尝试失败的操作。`;
                failedApproaches.push({
                  type: 'strategy_failure',
                  approach: `整体工具调用失败率过高 (${(failRate * 100).toFixed(0)}%)`,
                  reason: `最近 ${CIRCUIT_BREAKER_WINDOW} 次调用中 ${failCount} 次失败`,
                });
                this.emitUpdate({
                  type: 'progress',
                  content: {
                    phase: 'analyzing',
                    message: `⚠ 分析断路器触发：工具调用失败率 ${(failRate * 100).toFixed(0)}%，建议简化分析范围`,
                  },
                  timestamp: Date.now(),
                });
              }
            }
          }

          // Per-turn metrics: capture usage from stream_event message_delta (per API turn)
          if (msg.type === 'stream_event' && currentTurnMetrics) {
            const event = (msg as any).event;
            if (event?.type === 'message_delta' && event.usage) {
              currentTurnMetrics.outputTokens = event.usage.output_tokens;
            }
            if (event?.type === 'message_start' && event.message?.usage) {
              currentTurnMetrics.inputTokens = event.message.usage.input_tokens;
              currentTurnMetrics.cacheReadTokens = event.message.usage.cache_read_input_tokens;
              currentTurnMetrics.cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
            }
          }

          if (msg.type === 'result') {
            // Finalize last turn metrics before stream ends
            finalizeTurnMetrics();
            currentTurnMetrics = null;

            rounds = (msg as any).num_turns || rounds;
            const resultSubtype = (msg as any).subtype;
            if (resultSubtype === 'success') {
              finalResult = (msg as any).result;
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              terminationReason = MAX_TURNS_TERMINATION_REASON;
              terminationMessage = buildMaxTurnsTerminationMessage({
                mode: 'full',
                turns: rounds,
                maxTurns: this.config.maxTurns,
              });
            }
            // Record SDK token usage and prompt cache metrics
            metricsCollector.recordSdkUsage({
              usage: (msg as any).usage,
              modelUsage: (msg as any).modelUsage,
              total_cost_usd: (msg as any).total_cost_usd,
            });
          }
        }
        // Clean up any remaining sub-agent timers
        for (const timer of activeSubAgentTimers.values()) clearTimeout(timer);
        activeSubAgentTimers.clear();

        // Log per-turn metrics for performance analysis
        if (turnMetricsList.length > 0) {
          const summary = {
            totalTurns: turnMetricsList.length,
            totalDurationMs: turnMetricsList.reduce((s, t) => s + (t.durationMs || 0), 0),
            totalToolCalls: turnMetricsList.reduce((s, t) => s + t.toolCalls.length, 0),
            totalPayloadBytes: turnMetricsList.reduce((s, t) => s + t.toolResultPayloadBytes, 0),
            turns: turnMetricsList.map(t => ({
              turn: t.turnIndex,
              durationMs: t.durationMs,
              firstTokenMs: t.firstTokenLatencyMs,
              tools: t.toolCalls,
              payloadBytes: t.toolResultPayloadBytes,
              thinking: t.hasExtendedThinking,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              cacheReadTokens: t.cacheReadTokens,
              cacheCreationTokens: t.cacheCreationTokens,
            })),
          };
          console.log(`[ClaudeRuntime] Turn metrics [${sessionId}]:`, JSON.stringify(summary));
          metricsCollector.recordTurnMetrics(summary);
        }
      };

      let safetyTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((_, reject) => {
        safetyTimer = setTimeout(() => {
          timedOut = true;
          // Forcefully terminate the SDK subprocess — without this, queued
          // MCP tool calls (e.g. execute_sql) keep executing in the background
          // after the session logger has closed, producing orphan SQL errors.
          closeSdk();
          reject(new Error(`Analysis safety timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      try {
        await Promise.race([processStream(), timeoutPromise]);
      } catch (err) {
        if (timedOut) {
          console.error('[ClaudeRuntime] Analysis safety timeout reached — SDK subprocess has been closed');
          this.emitUpdate({
            type: 'progress',
            content: { phase: 'concluding', message: '分析超时，正在生成已有结果的结论...' },
            timestamp: Date.now(),
          });
        } else {
          throw err;
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
        closeSdk();
      }

      // Use SDK terminal result if available; fall back to accumulated streamed answer tokens.
      // On timeout, the SDK result message may never arrive, but answer_token events
      // were already streamed to the frontend — use that text to populate the report.
      conclusionText = finalResult || getAccumulatedAnswer() || '';
      if (!finalResult && conclusionText) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: SDK result was empty, recovered ${conclusionText.length} chars from streamed answer tokens`);
      }
      allFindings.push(extractFindingsFromText(conclusionText));
      let mergedFindings = mergeFindings(allFindings);

      // Log compaction for diagnostics — helps debug cases where Claude seems to lose context
      if (sdkCompactDetected) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: analysis completed after SDK auto-compact. Findings count: ${mergedFindings.length}`);
        // P1-C1: Write a structured compact recovery note so the next turn's system prompt
        // carries plan progress + findings + entity context that may have been lost.
        // Phase 3-2: also preserves the last N raw tool calls as structured digests
        // so the post-compact agent knows what it was just doing.
        const sessionNotes = this.sessionNotes.get(sessionId);
        if (sessionNotes) {
          const note = buildRecoveryNote({
            plan: ctx.analysisPlan.current ?? undefined,
            findings: mergedFindings,
            recentToolCalls: ctx.analysisPlan.current?.toolCallLog ?? [],
            entitySnapshot: this.buildEntityContext(ctx.entityStore),
          });

          sessionNotes.push({
            section: 'next_step',
            content: note.text,
            priority: 'high',
            timestamp: Date.now(),
          });
          if (sessionNotes.length > 20) sessionNotes.shift();

          console.log(`[ClaudeRuntime] Compact recovery note: ${note.sectionsIncluded.length} sections, ${note.usedChars} chars (${note.sectionsIncluded.join('/')})`);
        }
      }

      // Verification + reflection-driven retry (P0-2 + P2-2)
      // Default ON. Up to 2 correction retries, but second only if new/different errors.
      // Run unconditionally when enabled — plan adherence, hypothesis resolution,
      // and conclusion-length checks must fire even when zero findings are extracted.
      console.log(`[ClaudeRuntime] Pre-verification: conclusionText=${conclusionText.length} chars, sdkSessionId=${sdkSessionId ? 'set' : 'MISSING'}, enableVerification=${this.config.enableVerification}`);
      if (this.config.enableVerification) {
        const MAX_CORRECTION_ATTEMPTS = 2;
        let previousErrorSignatures = new Set<string>();

        try {
          for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt++) {
            const verification = await verifyConclusion(mergedFindings, conclusionText, {
              emitUpdate: (update) => this.emitUpdate(update),
              enableLLM: true, // P1-G6: LLM verification on all passes — 2nd correction quality is most uncertain
              plan: ctx.analysisPlan.current,
              hypotheses: ctx.hypotheses,
              sceneType: ctx.sceneType,
              lightModel: this.config.lightModel,
              verifierTimeoutMs: this.config.verifierTimeoutMs,
            });
            console.log(`[ClaudeRuntime] Verification (attempt ${attempt + 1}): ${verification.passed ? 'PASSED' : 'ISSUES FOUND'} (${verification.durationMs}ms, ${verification.heuristicIssues.length} heuristic + ${verification.llmIssues?.length || 0} LLM issues)`);

            if (verification.passed || !sdkSessionId) break;

            const allIssues = [...verification.heuristicIssues, ...(verification.llmIssues || [])];
            const errorIssues = allIssues.filter(i => i.severity === 'error');
            if (errorIssues.length === 0) break;

            // P2-2: Check if these are the SAME errors as last attempt — if so, stop retrying
            const currentSignatures = new Set(errorIssues.map(i => `${i.type}:${i.message.substring(0, 60)}`));
            if (attempt > 0) {
              const newErrors = [...currentSignatures].filter(s => !previousErrorSignatures.has(s));
              if (newErrors.length === 0) {
                console.log(`[ClaudeRuntime] Reflection retry: same ${errorIssues.length} errors persist after correction, stopping`);
                // P1: Record persistent verification failures as negative memory
                for (const issue of errorIssues) {
                  failedApproaches.push({
                    type: 'verification_failure',
                    approach: issue.message.substring(0, 150),
                    reason: `验证发现持续性问题 (${issue.type})，修正重试未能解决`,
                  });
                }
                break;
              }
              console.log(`[ClaudeRuntime] Reflection retry: ${newErrors.length} new errors detected, attempting correction ${attempt + 1}`);
            }
            previousErrorSignatures = currentSignatures;

            this.emitUpdate({
              type: 'progress',
              content: {
                phase: 'concluding',
                message: `发现 ${errorIssues.length} 个 ERROR 级问题，启动修正重试 (${attempt + 1}/${MAX_CORRECTION_ATTEMPTS})...`,
              },
              timestamp: Date.now(),
            });

            try {
              const correctionPrompt = generateCorrectionPrompt(allIssues, conclusionText);
              // When the conclusion is incomplete (just reasoning notes, no structured report),
              // the agent ran out of turns before generating a report. Give substantially more
              // budget so the correction can produce a complete structured output.
              const conclusionNeedsFullGeneration = isConclusionIncomplete(conclusionText);
              // P2-2: Give more turn budget on second attempt (may need additional data)
              const correctionTurns = conclusionNeedsFullGeneration
                ? (attempt === 0 ? 10 : 12)   // Full report generation needs more turns
                : (attempt === 0 ? 5 : 8);    // Normal correction (fixing specific issues)
              // Rebuild system prompt with reduced budget for correction retries.
              // After SDK auto-compact or verification failure, conversation history is longer,
              // so we shrink the system prompt to leave more room (4500 → 3000 tokens).
              const correctionSystemPrompt = sdkCompactDetected
                ? buildSystemPrompt(ctx.analysisContextForRebuild, 3000)
                : ctx.systemPrompt;

              const { stream: correctionStream, close: closeCorrection } = sdkQueryWithRetry({
                prompt: correctionPrompt,
                options: {
                  model: this.config.model,
                  maxTurns: correctionTurns,
                  systemPrompt: correctionSystemPrompt,
                  mcpServers: { smartperfetto: ctx.mcpServer },
                  includePartialMessages: true,
                  permissionMode: 'bypassPermissions' as const,
                  allowDangerouslySkipPermissions: true,
                  cwd: this.config.cwd,
                  effort: ctx.effectiveEffort,
                  allowedTools: ctx.allowedTools,
                  resume: sdkSessionId,
                  env: sdkEnv,
                  stderr: (data: string) => {
                    console.warn(`[ClaudeRuntime] SDK stderr (correction) [${sessionId}]: ${data.trimEnd()}`);
                  },
                },
              }, { emitUpdate: (update) => this.emitUpdate(update) });

              // P1-G8: Independent timeout for correction retries — prevents indefinite hangs.
              // When generating a full report from scratch (conclusionNeedsFullGeneration),
              // each turn needs more time (25s) since structured report output is verbose.
              // Normal corrections (fixing specific issues) use 10s per turn.
              const correctionTimeoutMs = correctionTurns * (conclusionNeedsFullGeneration ? 25_000 : 10_000);
              let correctionTimedOut = false;
              const correctionTimer = setTimeout(() => {
                correctionTimedOut = true;
                console.warn(`[ClaudeRuntime] Correction retry ${attempt + 1} timed out after ${correctionTimeoutMs}ms`);
                // Forcefully terminate the SDK subprocess so any queued MCP
                // tool calls (execute_sql, invoke_skill) stop running after
                // the main analyze() flow has moved on. Without this, those
                // calls hit trace_processor after the session has closed and
                // surface as orphan SQL errors with no owner.
                closeCorrection();
              }, correctionTimeoutMs);

              let correctedResult = '';
              try {
                for await (const msg of correctionStream) {
                  if (correctionTimedOut) break;
                  if (msg.type === 'result' && (msg as any).subtype === 'success') {
                    correctedResult = (msg as any).result || '';
                    rounds += (msg as any).num_turns || 0;
                  }
                  // Bridge tool call events (agent_task_dispatched, agent_response)
                  // but suppress text/conclusion events to avoid duplicating the report.
                  // The corrected conclusion is captured in correctedResult and will
                  // replace conclusionText below — no need to stream it again.
                  if (msg.type !== 'stream_event' && msg.type !== 'assistant' && msg.type !== 'result') {
                    try { bridge(msg); } catch { /* non-fatal */ }
                  }
                }
              } finally {
                clearTimeout(correctionTimer);
                // Safety net: guarantee the correction SDK subprocess is
                // closed on every exit (success, break, throw). Idempotent.
                closeCorrection();
              }

              if (correctionTimedOut) {
                console.warn(`[ClaudeRuntime] Correction attempt ${attempt + 1} timed out, using partial result (${correctedResult.length} chars)`);
              }

              // P2-G13: Compare correction quality by finding count and coverage, not text length.
              // A shorter corrected conclusion with more findings is better than a longer empty one.
              const correctedFindings = correctedResult ? extractFindingsFromText(correctedResult) : [];
              const previousFindingCount = mergedFindings.length;
              const hasSubstantiveCorrection = correctedResult && (
                correctedFindings.length >= previousFindingCount ||
                correctedResult.length > 100
              );

              if (hasSubstantiveCorrection) {
                conclusionText = correctedResult;
                // Re-extract findings from corrected conclusion and re-merge
                allFindings.push(correctedFindings);
                mergedFindings = mergeFindings(allFindings);
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: conclusion corrected (findings: ${previousFindingCount} → ${mergedFindings.length})`);
              } else {
                console.log(`[ClaudeRuntime] Reflection retry ${attempt + 1}: correction insufficient (findings: ${correctedFindings.length} vs ${previousFindingCount}), keeping previous`);
                break; // No point retrying if correction failed to improve
              }
            } catch (correctionErr) {
              console.warn(`[ClaudeRuntime] Reflection retry ${attempt + 1} failed (non-blocking):`, (correctionErr as Error).message);
              break;
            }
          }
        } catch (err) {
          console.warn('[ClaudeRuntime] Verification failed (non-blocking):', (err as Error).message);
        }
      }

      // Fallback: if conclusionText is still incomplete after verification (or verification was skipped),
      // check if accumulatedAnswer has more content. This handles the case where the SDK result
      // was a short summary but the streamed answer_tokens contained the full report.
      const accumulatedAnswer = getAccumulatedAnswer();
      if (isConclusionIncomplete(conclusionText) && accumulatedAnswer.length > conclusionText.length) {
        console.warn(`[ClaudeRuntime] Session ${sessionId}: conclusionText incomplete (${conclusionText.length} chars), using accumulatedAnswer (${accumulatedAnswer.length} chars) instead`);
        conclusionText = accumulatedAnswer;
        // Re-extract findings from the more complete text
        allFindings.push(extractFindingsFromText(conclusionText));
        mergedFindings = mergeFindings(allFindings);
      }

      const isPartialResult = terminationReason === MAX_TURNS_TERMINATION_REASON;
      if (isPartialResult) {
        terminationMessage ||= buildMaxTurnsTerminationMessage({
          mode: 'full',
          turns: rounds,
          maxTurns: this.config.maxTurns,
        });
        conclusionText = conclusionText.trim()
          ? prependPartialNotice(conclusionText, terminationMessage)
          : buildMaxTurnsFallbackConclusion({
              mode: 'full',
              turns: rounds,
              maxTurns: this.config.maxTurns,
            });
        allFindings.push(extractFindingsFromText(conclusionText));
        mergedFindings = mergeFindings(allFindings);
        failedApproaches.push({
          type: 'strategy_failure',
          approach: `analysis reached ${this.config.maxTurns} full-mode turns`,
          reason: 'SDK returned error_max_turns before a normal success result',
        });
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: 'partial_result_after_max_turns',
            error: SDK_MAX_TURNS_SUBTYPE,
            message: terminationMessage,
            partial: true,
            terminationReason,
            turns: rounds,
            maxTurns: this.config.maxTurns,
          },
          timestamp: Date.now(),
        });
      }

      const baseConfidence = this.estimateConfidence(mergedFindings);
      const turnConfidence = isPartialResult
        ? capPartialConfidence(baseConfidence, mergedFindings.length > 0)
        : baseConfidence;

      ctx.sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'diagnosis',
          complexity: 'complex',
          followUpType: ctx.previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: true,
          findings: mergedFindings,
          confidence: turnConfidence,
          message: conclusionText,
          partial: isPartialResult || undefined,
          terminationReason,
          terminationMessage,
        },
        mergedFindings,
      );

      ctx.sessionContext.updateWorkingMemoryFromConclusion({
        turnIndex: ctx.previousTurns.length,
        query,
        conclusion: conclusionText,
        confidence: turnConfidence,
      });

      // P2-2: Save analysis pattern to long-term memory (fire-and-forget)
      // Note: sceneType is from the outer analyze() scope (classified before context prep)
      const fullFeatures = extractTraceFeatures({
        architectureType: ctx.architecture?.type,
        sceneType,
        packageName: options.packageName,
        findingTitles: mergedFindings.map(f => f.title),
        findingCategories: mergedFindings.map(f => f.category).filter(Boolean) as string[],
      });
      // Per Self-Improving v3.3 §4.4: full-path patterns now save as
      // 'provisional' regardless of confidence. The state machine + 24h
      // auto-confirm decides whether they earn injection weight.
      if (!isPartialResult && mergedFindings.length > 0) {
        const insights = extractKeyInsights(mergedFindings, conclusionText);
        const patternExtras = {
          status: 'provisional' as const,
          provenance: {
            sessionId,
            turnIndex: ctx.previousTurns.length,
          },
        };
        saveAnalysisPattern(fullFeatures, insights, sceneType, ctx.architecture?.type, turnConfidence, patternExtras)
          .catch(err => console.warn('[ClaudeRuntime] Pattern save failed:', (err as Error).message));

        // Try to promote any matching quick-path pattern that has been waiting
        // for full-path verification. Best-effort — failure does not block.
        promoteQuickPatternIfMatching({
          fullPathFeatures: fullFeatures,
          fullPathInsights: insights,
          sceneType,
          architectureType: ctx.architecture?.type,
          verifierPassed: true,
        }).catch(err => console.warn('[ClaudeRuntime] Quick→full promote failed:', (err as Error).message));
      }

      // Derive sql_error FailedApproach entries from persistent SQL errors
      // (errors that were never auto-fixed during the session — still in the array)
      const persistentSqlErrors = this.sessionSqlErrors.get(sessionId)?.filter(
        (e: any) => !e.fixedSql && e.errorMessage,
      ) || [];
      for (const sqlErr of persistentSqlErrors.slice(-3)) { // cap at 3 to avoid noise
        failedApproaches.push({
          type: 'sql_error',
          approach: sqlErr.errorSql?.substring(0, 150) || 'unknown SQL',
          reason: sqlErr.errorMessage?.substring(0, 150) || 'SQL query error',
        });
      }

      // P1: Save negative patterns to long-term memory (fire-and-forget)
      if (failedApproaches.length > 0 && fullFeatures.length > 0) {
        saveNegativePattern(fullFeatures, failedApproaches, sceneType, ctx.architecture?.type)
          .catch(err => console.warn('[ClaudeRuntime] Negative pattern save failed:', (err as Error).message));
      }

      // P0-1: Export actual hypotheses from this turn (not hardcoded empty array)
      // Convert agentv3 Hypothesis to agentProtocol Hypothesis format for AnalysisResult
      const turnHypotheses = (this.sessionHypotheses.get(sessionId) || []).map(h => this.toProtocolHypothesis(h));

      return {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: turnHypotheses,
        conclusion: conclusionText,
        confidence: turnConfidence,
        rounds,
        totalDurationMs: Date.now() - startTime,
        partial: isPartialResult || undefined,
        terminationReason,
        terminationMessage,
      };
    } catch (error) {
      const errMsg = (error as Error).message || 'Unknown error';
      console.error('[ClaudeRuntime] Analysis failed:', errMsg);

      // P1-3: Preserve partial findings and generate partial conclusion on mid-stream errors
      const partialFindings = mergeFindings(allFindings);
      const hasPartialResults = partialFindings.length > 0;
      // P0-1: Export actual hypotheses even on error paths
      const errorHypotheses = (this.sessionHypotheses.get(sessionId) || []).map(h => this.toProtocolHypothesis(h));

      if (hasPartialResults) {
        const partialConclusion = `分析过程中出错 (${errMsg})，以下是已收集的部分发现：\n\n` +
          partialFindings.map(f => `- **[${f.severity.toUpperCase()}]** ${f.title}: ${f.description || ''}`).join('\n');
        this.emitUpdate({
          type: 'progress',
          content: { phase: 'concluding', message: `分析中断，已保留 ${partialFindings.length} 个部分发现` },
          timestamp: Date.now(),
        });
        return {
          sessionId,
          success: true, // partial success — downstream can check confidence < 1
          findings: partialFindings,
          hypotheses: errorHypotheses,
          conclusion: partialConclusion,
          confidence: this.estimateConfidence(partialFindings) * 0.7, // penalize for incomplete
          rounds,
          totalDurationMs: Date.now() - startTime,
          partial: true,
          terminationReason: 'execution_error',
          terminationMessage: errMsg,
        };
      }

      this.emitUpdate({ type: 'error', content: { message: `分析失败: ${errMsg}` }, timestamp: Date.now() });
      return {
        sessionId,
        success: false,
        findings: partialFindings,
        hypotheses: errorHypotheses,
        conclusion: `分析过程中出错: ${errMsg}`,
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
        terminationReason: 'execution_error',
        terminationMessage: errMsg,
      };
    } finally {
      this.activeAnalyses.delete(sessionId);
      runSnapshots.release(sessionId);
      // Notes persistence now handled by unified SessionStateSnapshot in the route layer.
      // No separate disk I/O needed here.

      // Persist session metrics (fire-and-forget, non-blocking)
      try {
        metricsCollector.recordTurn(); // Record final turn
        persistSessionMetrics(metricsCollector.summarize());
      } catch (metricsErr) {
        console.warn('[ClaudeRuntime] Failed to persist metrics:', (metricsErr as Error).message);
      }
    }
  }

  /**
   * Quick analysis path for simple factual queries.
   * Minimal context prep, 3 MCP tools, no planning/verification/report.
   * Target: 3-8s latency, 2k-5k tokens.
   */
  private async analyzeQuick(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    precomputed: {
      sceneType: SceneType;
      focusResult: Awaited<ReturnType<typeof detectFocusApps>>;
      cachedArch: ArchitectureInfo | undefined;
      sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns: any[];
      metricsCollector: AgentMetricsCollector;
      startTime: number;
    },
  ): Promise<AnalysisResult> {
    const { sceneType, focusResult, cachedArch, sessionContext, previousTurns, metricsCollector, startTime } = precomputed;

    try {
      let effectivePackageName = options.packageName;
      if (!effectivePackageName && focusResult.primaryApp) {
        effectivePackageName = focusResult.primaryApp;
      }

      // Architecture detection + skill registry init in parallel
      const [architecture, _skillRegistryReady] = await Promise.all([
        cachedArch ? Promise.resolve(cachedArch) : (async () => {
          try {
            const detector = createArchitectureDetector();
            const arch = await detector.detect({
              traceId,
              traceProcessorService: this.traceProcessorService,
              packageName: effectivePackageName,
            });
            if (arch) {
              this.architectureCache.set(traceId, arch);
              // LRU eviction: match full path's 50-entry cap
              if (this.architectureCache.size > 50) {
                const firstKey = this.architectureCache.keys().next().value;
                if (firstKey) this.architectureCache.delete(firstKey);
              }
            }
            return arch;
          } catch (err) {
            console.warn('[ClaudeRuntime] Quick: architecture detection failed:', (err as Error).message);
            return undefined;
          }
        })(),
        ensureSkillRegistryInitialized(),
      ]);

      const skillExecutor = createSkillExecutor(this.traceProcessorService);
      skillExecutor.registerSkills(skillRegistry.getAllSkills());
      skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

      const watchdogWarning: { current: string | null } = { current: null };
      // Quick path defaults to no skill-notes injection per §8 of the
      // self-improving design. Operators can opt-in via the env override.
      const quickNotesBudget = process.env.SELF_IMPROVE_NOTES_INJECT_ENABLED === '1'
        ? new SkillNotesBudget({
            mode: 'quick',
            quickOverrideTotal: parseQuickBudgetEnv(),
          })
        : undefined;
      const { server: mcpServer, allowedTools } = createClaudeMcpServer({
        traceId,
        traceProcessorService: this.traceProcessorService,
        skillExecutor,
        packageName: effectivePackageName,
        emitUpdate: (update) => this.emitUpdate(update),
        watchdogWarning,
        sceneType,
        lightweight: true,
        skillNotesBudget: quickNotesBudget,
      });

      const systemPrompt = buildQuickSystemPrompt({
        architecture,
        packageName: effectivePackageName,
        focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
        focusMethod: focusResult.method,
        selectionContext: options.selectionContext,
      });

      const quickConfig = createQuickConfig(this.config);

      const { handleMessage: bridge, getAccumulatedAnswer } = createSseBridge((update: StreamingUpdate) => {
        this.emitUpdate(update);
      });

      this.emitUpdate({
        type: 'progress',
        content: { phase: 'answering', message: `快速问答模式 (${quickConfig.model})...` },
        timestamp: Date.now(),
      });

      const sessionMapKey = sessionId;
      const sessionMapEntry = this.sessionMap.get(sessionMapKey);
      // Apply the same 4h freshness rule as the full path (see `SDK_SESSION_FRESHNESS_MS` below in
      // prepareAnalysisContext). A stale quick entry silently resumed here would cause context loss.
      const SDK_SESSION_FRESHNESS_MS = 4 * 60 * 60 * 1000;
      const existingSdkSessionId = sessionMapEntry
        && (Date.now() - (sessionMapEntry.updatedAt || 0) < SDK_SESSION_FRESHNESS_MS)
        ? sessionMapEntry.sdkSessionId
        : undefined;
      const sdkEnv = createSdkEnv();

      // Prepend pre-queried trace data so the AI skips basic SQL turns in fast mode
      let quickPrompt = query;
      if (options.traceContext && options.traceContext.length > 0) {
        quickPrompt = `${formatTraceContext(options.traceContext)}\n\n${query}`;
      }

      const { stream, close: closeSdk } = sdkQueryWithRetry({
        prompt: quickPrompt,
        options: {
          model: quickConfig.model,
          maxTurns: quickConfig.maxTurns,
          systemPrompt,
          mcpServers: { smartperfetto: mcpServer },
          includePartialMessages: true,
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          cwd: quickConfig.cwd,
          effort: quickConfig.effort,
          allowedTools,
          env: sdkEnv,
          stderr: (data: string) => {
            console.warn(`[ClaudeRuntime] Quick SDK stderr [${sessionId}]: ${data.trimEnd()}`);
          },
          ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
        },
      }, { emitUpdate: (update) => this.emitUpdate(update) });

      let finalResult: string | undefined;
      let quickSdkSessionId: string | undefined;
      let quickRounds = 0;
      let terminationReason: AnalysisResult['terminationReason'];
      let terminationMessage: string | undefined;

      // Quick path per-turn budget from env CLAUDE_QUICK_PER_TURN_MS (default 40s/turn).
      const timeoutMs = quickConfig.maxTurns * quickConfig.quickPathPerTurnMs;
      let timedOut = false;
      let safetyTimer: ReturnType<typeof setTimeout> | undefined;

      const timeoutPromise = new Promise<void>((_, reject) => {
        safetyTimer = setTimeout(() => {
          timedOut = true;
          // Forcefully terminate SDK subprocess so queued MCP tool calls
          // stop running after analyzeQuick returns (prevents orphan queries).
          closeSdk();
          reject(new Error(`Quick analysis timeout after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });

      const processStream = async () => {
        for await (const msg of stream) {
          if (timedOut) break;

          if (msg.session_id && !quickSdkSessionId) {
            quickSdkSessionId = msg.session_id;
            this.sessionMap.set(sessionMapKey, { sdkSessionId: quickSdkSessionId, updatedAt: Date.now() });
            savePersistedSessionMap(this.sessionMap);
          }

          try { bridge(msg); } catch { /* non-fatal */ }

          if (msg.type === 'result') {
            quickRounds = (msg as any).num_turns || quickRounds;
            const resultSubtype = (msg as any).subtype;
            if (resultSubtype === 'success') {
              finalResult = (msg as any).result;
            } else if (isSdkMaxTurnsSubtype(resultSubtype)) {
              terminationReason = MAX_TURNS_TERMINATION_REASON;
              terminationMessage = buildMaxTurnsTerminationMessage({
                mode: 'fast',
                turns: quickRounds,
                maxTurns: quickConfig.maxTurns,
              });
            }
          }
        }
      };

      try {
        await Promise.race([processStream(), timeoutPromise]);
      } catch (err) {
        if (timedOut) {
          console.warn('[ClaudeRuntime] Quick analysis timeout reached — SDK subprocess has been closed');
        } else {
          throw err;
        }
      } finally {
        if (safetyTimer) clearTimeout(safetyTimer);
        closeSdk();
      }

      let conclusionText = finalResult || getAccumulatedAnswer() || '';
      let mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
      const isPartialResult = terminationReason === MAX_TURNS_TERMINATION_REASON;
      if (isPartialResult) {
        terminationMessage ||= buildMaxTurnsTerminationMessage({
          mode: 'fast',
          turns: quickRounds,
          maxTurns: quickConfig.maxTurns,
        });
        conclusionText = conclusionText.trim()
          ? prependPartialNotice(conclusionText, terminationMessage)
          : buildMaxTurnsFallbackConclusion({
              mode: 'fast',
              turns: quickRounds,
              maxTurns: quickConfig.maxTurns,
            });
        mergedFindings = mergeFindings([extractFindingsFromText(conclusionText)]);
        this.emitUpdate({
          type: 'degraded',
          content: {
            module: 'claudeRuntime',
            fallback: 'partial_result_after_max_turns',
            error: SDK_MAX_TURNS_SUBTYPE,
            message: terminationMessage,
            partial: true,
            terminationReason,
            turns: quickRounds,
            maxTurns: quickConfig.maxTurns,
          },
          timestamp: Date.now(),
        });
      }
      const quickConfidenceBase = mergedFindings.length > 0 ? 0.8 : 0.5;
      const quickConfidence = isPartialResult
        ? capPartialConfidence(quickConfidenceBase, mergedFindings.length > 0)
        : quickConfidenceBase;

      if (conclusionText.length > 0 && conclusionText.length < 20) {
        console.warn(`[ClaudeRuntime] Quick: suspiciously short answer (${conclusionText.length} chars)`);
      }

      // Record turn in session context
      sessionContext.addTurn(
        query,
        {
          primaryGoal: query,
          aspects: [],
          expectedOutputType: 'summary',
          complexity: 'simple',
          followUpType: previousTurns.length > 0 ? 'extend' : 'initial',
        },
        {
          agentId: 'claude-agent',
          success: true,
          findings: mergedFindings,
          confidence: quickConfidence,
          message: conclusionText,
          partial: isPartialResult || undefined,
          terminationReason,
          terminationMessage,
        },
        mergedFindings,
      );

      console.log(`[ClaudeRuntime] Quick analysis completed: ${quickRounds} rounds, ${Date.now() - startTime}ms, ${conclusionText.length} chars`);

      // Quick path writes to a separate 7-day bucket — see Self-Improving v3.3 §6.
      // Insights are weaker (no verifier, 5-turn budget), so they only surface
      // as fallbacks at injection time. A future full-path run on similar
      // features may promote the bucket entry to long-term memory.
      if (!isPartialResult && mergedFindings.length > 0) {
        const insights = extractKeyInsights(mergedFindings, conclusionText);
        const quickFeatures = extractTraceFeatures({
          architectureType: cachedArch?.type,
          sceneType,
          packageName: effectivePackageName,
          findingTitles: mergedFindings.map(f => f.title),
          findingCategories: mergedFindings.map(f => f.category).filter(Boolean) as string[],
        });
        saveQuickPathPattern(quickFeatures, insights, sceneType, cachedArch?.type, {
          status: 'provisional',
          provenance: { sessionId, turnIndex: previousTurns.length },
        }).catch(err => console.warn('[ClaudeRuntime] Quick pattern save failed:', (err as Error).message));
      }

      return {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: [],
        conclusion: conclusionText,
        confidence: quickConfidence,
        rounds: quickRounds,
        totalDurationMs: Date.now() - startTime,
        partial: isPartialResult || undefined,
        terminationReason,
        terminationMessage,
      };
    } catch (error) {
      const errMsg = (error as Error).message || 'Unknown error';
      console.error('[ClaudeRuntime] Quick analysis failed:', errMsg);
      this.emitUpdate({ type: 'error', content: { message: `快速问答失败: ${errMsg}` }, timestamp: Date.now() });
      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `快速问答过程中出错: ${errMsg}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
      };
    } finally {
      this.activeAnalyses.delete(sessionId);
      try {
        metricsCollector.recordTurn();
        persistSessionMetrics(metricsCollector.summarize());
      } catch (metricsErr) {
        console.warn('[ClaudeRuntime] Failed to persist quick metrics:', (metricsErr as Error).message);
      }
    }
  }

  removeSession(sessionId: string): void {
    // Cancel any pending debounced save to prevent stale write after sync save
    const pendingTimer = saveTimers.get(this.sessionMap);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      saveTimers.delete(this.sessionMap);
    }
    this.sessionMap.delete(sessionId);
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
    // Use immediate save — session is being removed, must persist before cleanup completes
    savePersistedSessionMapSync(this.sessionMap);
  }

  /** Clean up all session-scoped state for a given session. */
  cleanupSession(sessionId: string): void {
    this.removeSession(sessionId);
  }

  /** P1-R3: Public getter for session notes — used by report generation. */
  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  /** P1-R3: Public getter for current analysis plan — used by report generation. */
  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  /** P1-R3: Public getter for uncertainty flags — used by report generation. */
  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  /** P1-1: Public getter for plan history — used for persistence. */
  getSessionPlanHistory(sessionId: string): AnalysisPlanV3[] {
    return this.sessionPlans.get(sessionId)?.history || [];
  }

  // ===========================================================================
  // Snapshot — atomic serialization / deserialization boundary
  // ===========================================================================

  /**
   * Take a snapshot of all session state for atomic persistence.
   *
   * Reads from ClaudeRuntime's 7 internal Maps (notes, plans, hypotheses,
   * flags, artifacts, architectureCache, sessionMap) and merges with
   * session-level arrays provided by the route layer.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID
   * @param sessionFields - Session-level arrays from AnalysisSession (route layer)
   */
  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const notes = this.sessionNotes.get(sessionId) || [];
    const planState = this.sessionPlans.get(sessionId);
    const claudeHypotheses = this.sessionHypotheses.get(sessionId) || [];
    const flags = this.sessionUncertaintyFlags.get(sessionId) || [];
    const artifactStore = this.artifactStores.get(sessionId);
    const architecture = this.architectureCache.get(traceId);
    const sdkSessionId = this.sessionMap.get(sessionId)?.sdkSessionId;

    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,

      // Session fields (route layer) — fields match SessionFieldsForSnapshot exactly
      ...sessionFields,

      // ClaudeRuntime Maps
      analysisNotes: notes,
      analysisPlan: planState?.current ?? null,
      planHistory: planState?.history ?? [],
      uncertaintyFlags: flags,
      claudeHypotheses: claudeHypotheses.length > 0 ? claudeHypotheses : undefined,

      // Cached detection
      architecture,
      sdkSessionId,

      // Artifacts
      artifacts: artifactStore?.serialize(),
    };
  }

  /**
   * Restore all ClaudeRuntime Maps from a persisted snapshot.
   *
   * Called during session resume to repopulate the 7 internal Maps
   * that are normally built up during analysis.
   *
   * @param sessionId - The SmartPerfetto session ID
   * @param traceId - The trace ID (for architectureCache key)
   * @param snapshot - The persisted snapshot to restore from
   */
  restoreFromSnapshot(sessionId: string, traceId: string, snapshot: SessionStateSnapshot): void {
    if (snapshot.analysisNotes.length > 0) {
      this.sessionNotes.set(sessionId, [...snapshot.analysisNotes]);
    }

    if (snapshot.analysisPlan || snapshot.planHistory.length > 0) {
      this.sessionPlans.set(sessionId, {
        current: snapshot.analysisPlan,
        history: snapshot.planHistory,
      });
    }

    if (snapshot.claudeHypotheses && snapshot.claudeHypotheses.length > 0) {
      this.sessionHypotheses.set(sessionId, [...snapshot.claudeHypotheses]);
    }

    if (snapshot.uncertaintyFlags.length > 0) {
      this.sessionUncertaintyFlags.set(sessionId, [...snapshot.uncertaintyFlags]);
    }

    if (snapshot.artifacts && snapshot.artifacts.length > 0) {
      this.artifactStores.set(sessionId, ArtifactStore.fromSnapshot(snapshot.artifacts));
    }

    if (snapshot.architecture) {
      this.architectureCache.set(traceId, snapshot.architecture);
    }

    if (snapshot.sdkSessionId) {
      this.sessionMap.set(sessionId, { sdkSessionId: snapshot.sdkSessionId, updatedAt: Date.now() });
    }
  }

  /** P0-1: Convert agentv3 Hypothesis to agentProtocol Hypothesis format for AnalysisResult. */
  private toProtocolHypothesis(h: Hypothesis): ProtocolHypothesis {
    const statusMap: Record<string, ProtocolHypothesis['status']> = {
      formed: 'proposed',
      confirmed: 'confirmed',
      rejected: 'rejected',
    };
    const confidenceMap: Record<string, number> = { formed: 0.5, confirmed: 0.85, rejected: 0.1 };
    return {
      id: h.id,
      description: h.statement,
      status: statusMap[h.status] || 'proposed',
      confidence: confidenceMap[h.status] ?? 0.5,
      supportingEvidence: h.evidence && h.status === 'confirmed' ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source: 'claude', strength: 0.8 }] : [],
      contradictingEvidence: h.evidence && h.status === 'rejected' ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source: 'claude', strength: 0.8 }] : [],
      proposedBy: 'claude',
      relevantAgents: ['claude'],
      createdAt: h.formedAt,
      updatedAt: h.resolvedAt || h.formedAt,
    };
  }

  reset(): void {
    this.architectureCache.clear();
    this.vendorCache.clear();
    this.completenessCache.clear();
    // Also clear all session-scoped stores to prevent unbounded growth
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.activeAnalyses.clear();
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }

  /**
   * Collect the most recent findings from previous turns for system prompt injection.
   * Caps at 5 findings to prevent unbounded prompt growth.
   */
  private collectPreviousFindings(sessionContext: any, maxTurns?: number): Finding[] {
    try {
      let turns = sessionContext.getAllTurns?.() || [];
      if (maxTurns && maxTurns > 0) {
        turns = turns.slice(-maxTurns);
      }
      return turns.flatMap((turn: any) => turn.findings || []).slice(-5);
    } catch {
      return [];
    }
  }

  /**
   * Build a compact entity context string for the system prompt.
   * Gives Claude awareness of known frames/sessions for drill-down resolution.
   */
  private buildEntityContext(entityStore: any): string | undefined {
    try {
      const stats = entityStore.getStats();
      if (stats.totalEntityCount === 0) return undefined;

      const lines: string[] = [];

      const frames = entityStore.getAllFrames?.() || [];
      if (frames.length > 0) {
        lines.push(`**帧 (${frames.length})**:`);
        for (const f of frames.slice(0, 15)) {
          const parts = [`frame_id=${f.frame_id}`];
          if (f.start_ts) parts.push(`ts=${f.start_ts}`);
          if (f.jank_type) parts.push(`jank=${f.jank_type}`);
          if (f.dur_ms) parts.push(`dur=${f.dur_ms}ms`);
          if (f.process_name) parts.push(`proc=${f.process_name}`);
          lines.push(`- ${parts.join(', ')}`);
        }
        if (frames.length > 15) lines.push(`- ...及其他 ${frames.length - 15} 帧`);
      }

      const sessions = entityStore.getAllSessions?.() || [];
      if (sessions.length > 0) {
        lines.push(`**滑动会话 (${sessions.length})**:`);
        for (const s of sessions.slice(0, 8)) {
          const parts = [`session_id=${s.session_id}`];
          if (s.start_ts) parts.push(`ts=${s.start_ts}`);
          if (s.jank_count) parts.push(`janks=${s.jank_count}`);
          if (s.process_name) parts.push(`proc=${s.process_name}`);
          lines.push(`- ${parts.join(', ')}`);
        }
      }

      return lines.length > 0 ? lines.join('\n') : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Prepare all context needed for a Claude analysis run.
   * Extracts focus app detection, architecture detection, session context,
   * scene classification, MCP server creation, and system prompt building
   * into a single cohesive preparation phase.
   */
  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    precomputed?: {
      focusResult?: Awaited<ReturnType<typeof detectFocusApps>>;
      sessionContext?: ReturnType<typeof sessionContextManager.getOrCreate>;
      previousTurns?: any[];
      sceneType?: SceneType;
    },
  ) {
    // Phase 0: Selection context logging
    if (options.selectionContext) {
      const sc = options.selectionContext;
      const detail = sc.kind === 'area'
        ? `startNs=${sc.startNs}, endNs=${sc.endNs}`
        : `eventId=${sc.eventId}, ts=${sc.ts}`;
      console.log(`[ClaudeRuntime] Selection context received: kind=${sc.kind}, ${detail}`);
    }

    // Phase 0.5: Detect focus apps from trace data (reuse precomputed if available)
    let effectivePackageName = options.packageName;
    const focusResult = precomputed?.focusResult ?? await detectFocusApps(this.traceProcessorService, traceId);

    if (focusResult.primaryApp) {
      if (!effectivePackageName) {
        effectivePackageName = focusResult.primaryApp;
        console.log(`[ClaudeRuntime] Auto-detected focus app: ${effectivePackageName} (via ${focusResult.method})`);
      } else {
        console.log(`[ClaudeRuntime] User-provided packageName: ${effectivePackageName}, also detected: ${focusResult.apps.map(a => a.packageName).join(', ')}`);
      }
      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})` },
        timestamp: Date.now(),
      });
    }

    // Phase 1: Skill executor setup
    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    await ensureSkillRegistryInitialized();
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    // Phase 2: Architecture detection (LRU cached per traceId)
    let architecture = this.architectureCache.get(traceId);
    if (architecture) {
      // LRU touch: delete and re-insert to move to end of Map iteration order
      this.architectureCache.delete(traceId);
      this.architectureCache.set(traceId, architecture);
    } else {
      try {
        const detector = createArchitectureDetector();
        architecture = await detector.detect({
          traceId,
          traceProcessorService: this.traceProcessorService,
          packageName: effectivePackageName,
        });
        if (architecture) {
          this.architectureCache.set(traceId, architecture);
          // LRU eviction: remove oldest entry (first key in Map)
          if (this.architectureCache.size > 50) {
            const firstKey = this.architectureCache.keys().next().value;
            if (firstKey) this.architectureCache.delete(firstKey);
          }
        }
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      } catch (err) {
        console.warn('[ClaudeRuntime] Architecture detection failed:', (err as Error).message);
      }
    }

    // Phase 2.5: Vendor detection (LRU cached per traceId, reuses SkillAnalysisAdapter.detectVendor)
    let detectedVendor = this.vendorCache.get(traceId) ?? null;
    if (!detectedVendor) {
      try {
        const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
        await adapter.ensureInitialized();
        const vendorResult = await adapter.detectVendor(traceId);
        detectedVendor = vendorResult.vendor;
        if (detectedVendor && detectedVendor !== 'aosp') {
          this.vendorCache.set(traceId, detectedVendor);
          // LRU eviction: match architectureCache limit
          if (this.vendorCache.size > 50) {
            const firstKey = this.vendorCache.keys().next().value;
            if (firstKey) this.vendorCache.delete(firstKey);
          }
        }
      } catch (err) {
        console.warn('[ClaudeRuntime] Vendor detection failed:', (err as Error).message);
      }
    }

    // Phase 2.8: Comparison context (dual-trace mode)
    let comparisonContext: import('./types').ComparisonContext | undefined;
    const referenceTraceId = options.referenceTraceId;
    if (referenceTraceId) {
      console.log(`[ClaudeRuntime] Comparison mode: current=${traceId}, reference=${referenceTraceId}`);
      this.emitUpdate({
        type: 'progress',
        content: { phase: 'starting', message: '对比模式：正在检测参考 Trace...' },
        timestamp: Date.now(),
      });

      // Detect reference trace focus app, architecture, AND capability handshake in parallel
      const capSql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE 'android_%' OR name LIKE 'linux_%' OR name LIKE 'sched_%' OR name LIKE 'slices_%')";
      const [refFocusResult, refArchitecture, currentTables, refTables] = await Promise.all([
        detectFocusApps(this.traceProcessorService, referenceTraceId).catch(() => ({ apps: [], method: 'none' as const, primaryApp: undefined })),
        (async () => {
          let refArch = this.architectureCache.get(referenceTraceId);
          if (!refArch) {
            try {
              const detector = createArchitectureDetector();
              refArch = await detector.detect({
                traceId: referenceTraceId,
                traceProcessorService: this.traceProcessorService,
                packageName: undefined,
              }) ?? undefined;
              if (refArch) this.architectureCache.set(referenceTraceId, refArch);
            } catch { /* non-fatal */ }
          }
          return refArch;
        })(),
        this.traceProcessorService.query(traceId, capSql).catch((e) => { console.warn('[ClaudeRuntime] Capability query failed for current trace:', e.message); return null; }),
        this.traceProcessorService.query(referenceTraceId, capSql).catch((e) => { console.warn('[ClaudeRuntime] Capability query failed for reference trace:', e.message); return null; }),
      ]);

      // Capability handshake: compute intersection of available tables on both trace processors
      // null = query failed (unhealthy processor), non-null = actual result
      let commonCapabilities: string[] = [];
      let capabilityDiff: { currentOnly: string[]; referenceOnly: string[] } | undefined;
      if (currentTables && refTables) {
        const currentSet = new Set(currentTables.rows.map((r: any[]) => r[0] as string));
        const refSet = new Set(refTables.rows.map((r: any[]) => r[0] as string));
        commonCapabilities = [...currentSet].filter(t => refSet.has(t));
        const currentOnly = [...currentSet].filter(t => !refSet.has(t));
        const referenceOnly = [...refSet].filter(t => !currentSet.has(t));
        if (currentOnly.length > 0 || referenceOnly.length > 0) {
          capabilityDiff = { currentOnly, referenceOnly };
        }
      } else {
        console.warn('[ClaudeRuntime] Capability handshake incomplete — one or both trace processors unhealthy');
      }

      comparisonContext = {
        referenceTraceId,
        referencePackageName: refFocusResult.primaryApp,
        referenceFocusApps: refFocusResult.apps.length > 0 ? refFocusResult.apps : undefined,
        referenceArchitecture: refArchitecture,
        commonCapabilities,
        capabilityDiff,
      };

      console.log(`[ClaudeRuntime] Comparison context built: refApp=${refFocusResult.primaryApp || 'unknown'}, ` +
        `refArch=${refArchitecture?.type || 'unknown'}, commonCaps=${commonCapabilities.length}, ` +
        `capDiff=${capabilityDiff ? `cur=${capabilityDiff.currentOnly.length}/ref=${capabilityDiff.referenceOnly.length}` : 'none'}`);
    }

    // Phase 2.9: Trace data completeness probe (cached per traceId, ~50ms first run)
    let traceCompleteness = this.completenessCache.get(traceId);
    if (!traceCompleteness) {
      try {
        traceCompleteness = await probeTraceCompleteness(
          this.traceProcessorService,
          traceId,
          architecture?.type,
        );
        this.completenessCache.set(traceId, traceCompleteness);
        if (this.completenessCache.size > 50) {
          const firstKey = this.completenessCache.keys().next().value;
          if (firstKey) this.completenessCache.delete(firstKey);
        }
      } catch (err) {
        console.warn('[ClaudeRuntime] Trace completeness probe failed (non-fatal):', (err as Error).message);
      }
    }

    // Phase 3: Session context + conversation history (reuse precomputed if available)
    const sessionContext = precomputed?.sessionContext ?? sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = precomputed?.previousTurns ?? (sessionContext.getAllTurns?.() || []);
    // Composite key for comparison mode session identity isolation
    const sessionMapKey = referenceTraceId
      ? `${sessionId}:ref:${referenceTraceId}`
      : sessionId;
    const sessionMapEntry = this.sessionMap.get(sessionMapKey);
    const existingSdkSession = sessionMapEntry?.sdkSessionId;
    // P0-3: SDK sessions on Anthropic's side expire after ~4 hours.
    // If the local sessionMap entry is stale, treat it as expired and inject full manual context.
    // Without this check, `hasActiveResume` stays true for stale entries, causing the system
    // to skip both SDK context (expired) AND manual context injection → silent context loss.
    const SDK_SESSION_FRESHNESS_MS = 4 * 60 * 60 * 1000; // 4 hours
    const sdkSessionFresh = !!sessionMapEntry && (Date.now() - (sessionMapEntry.updatedAt || 0) < SDK_SESSION_FRESHNESS_MS);
    const hasActiveResume = !!existingSdkSession && sdkSessionFresh;
    const previousFindings = hasActiveResume
      ? [] // SDK already has these in conversation history
      : this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0 && !hasActiveResume
      ? sessionContext.generatePromptContext(2000)
      : undefined;

    // Phase 4: Entity store + entity context for drill-down
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);

    // Phase 5: Scene classification + effort resolution (reuse precomputed if available)
    const sceneType = precomputed?.sceneType ?? classifyScene(query);
    const effectiveEffort = resolveEffort(this.config, sceneType);

    // Phase 5.5: Pattern memory — match similar historical traces (P2-2)
    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const patternContext = buildPatternContextSection(traceFeatures);
    const negativePatternContext = buildNegativePatternSection(traceFeatures);

    // Phase 6: Session-scoped artifact store + analysis notes
    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;
    // Notes restored from SessionStateSnapshot on resume — no separate disk I/O.
    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    // Phase 6.5: Session-scoped analysis plan (P0-1: Planning capability)
    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    // P1-B1: Preserve plan history (max 3 recent plans) for deeper cross-turn context
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    const previousPlan = analysisPlan.current ?? undefined;
    analysisPlan.current = null;

    // Phase 6.6: Watchdog feedback ref — shared between runtime watchdog and MCP tools
    const watchdogWarning: { current: string | null } = { current: null };

    // Phase 6.7: Session-scoped hypotheses for hypothesis-verify cycle (P0-G4)
    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    // Reset for new turn (hypotheses are per-turn, resolved within each analysis cycle)
    hypotheses.splice(0);

    // Phase 6.8: Session-scoped uncertainty flags (P1-G1)
    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0); // Reset per turn

    // Phase 7: SQL error tracking for in-context learning
    // Seed new sessions with previously learned fix pairs from disk (cross-session learning)
    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = loadLearnedSqlFixPairs(5);
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    // Phase 8: MCP server with all session-scoped state
    // P2-G1: Destructure to get both server and auto-derived allowedTools
    const fullNotesBudget = process.env.SELF_IMPROVE_NOTES_INJECT_ENABLED === '1'
      ? new SkillNotesBudget({ mode: 'full' })
      : undefined;
    const { server: mcpServer, allowedTools } = createClaudeMcpServer({
      traceId,
      traceProcessorService: this.traceProcessorService,
      skillExecutor,
      packageName: effectivePackageName,
      emitUpdate: (update) => this.emitUpdate(update),
      onSkillResult: (result) => {
        if (result.displayResults) {
          this.captureEntitiesFromSkillDisplayResults(result.displayResults, entityStore);
        }
      },
      analysisNotes: notes,
      artifactStore,
      cachedArchitecture: architecture,
      cachedVendor: detectedVendor,
      recentSqlErrors: sqlErrors,
      analysisPlan,
      watchdogWarning,
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId,
      comparisonContext,
      skillNotesBudget: fullNotesBudget,
    });

    // Phase 9: (removed — skillCatalog was populated but never used in prompt;
    //           Claude uses list_skills MCP tool on demand instead)

    // Phase 10: Knowledge base context (non-fatal — Claude can use lookup_sql_schema tool)
    let knowledgeBaseContext: string | undefined;
    try {
      const kb = await getExtendedKnowledgeBase();
      knowledgeBaseContext = kb.getContextForAI(query, 8);
    } catch {
      // Non-fatal
    }

    // Phase 11: Sub-agent definitions (feature-gated)
    let agents: Record<string, any> | undefined;
    if (this.config.enableSubAgents && sceneType !== 'anr') {
      agents = buildAgentDefinitions(sceneType, {
        architecture,
        packageName: effectivePackageName,
        allowedTools,
        subAgentModel: this.config.subAgentModel,
      });
    }

    // Phase 12: SQL error-fix pairs for prompt injection
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));

    // Phase 13: System prompt assembly
    const analysisContextForRebuild: ClaudeAnalysisContext = {
      query,
      architecture,
      packageName: effectivePackageName,
      focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
      focusMethod: focusResult.method,
      previousFindings,
      conversationSummary,
      knowledgeBaseContext,
      entityContext,
      sceneType,
      analysisNotes: notes.length > 0 ? notes : undefined,
      availableAgents: agents ? Object.keys(agents) : undefined,
      sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
      patternContext,
      negativePatternContext,
      previousPlan,
      planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
      selectionContext: options.selectionContext,
      comparison: comparisonContext,
      traceCompleteness,
    };
    const systemPrompt = buildSystemPrompt(analysisContextForRebuild);

    return {
      mcpServer,
      systemPrompt,
      effectiveEffort,
      agents,
      sessionContext,
      previousTurns,
      entityStore,
      analysisPlan,
      architecture,
      watchdogWarning,
      hypotheses,
      sceneType,
      allowedTools, // P2-G1: auto-derived from MCP server registration
      analysisContextForRebuild, // Used by correction retry to rebuild prompt with reduced budget
      sessionMapKey, // Composite key for comparison mode session identity isolation
    };
  }

  private estimateConfidence(findings: Finding[]): number {
    if (findings.length === 0) return 0.3;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }

  /** Capture entities from skill displayResults into EntityStore for multi-turn drill-down. */
  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    try {
      const data: Record<string, any> = {};
      for (const dr of displayResults) {
        if (dr.stepId && dr.data) {
          data[dr.stepId] = dr.data;
        }
      }
      const captured = captureEntitiesFromResponses([{
        agentId: 'claude-agent',
        success: true,
        toolResults: [{ toolName: 'invoke_skill', data }],
      } as any]);
      applyCapturedEntities(entityStore, captured);
    } catch (err) {
      console.warn('[ClaudeRuntime] Entity capture failed:', (err as Error).message);
    }
  }
}
