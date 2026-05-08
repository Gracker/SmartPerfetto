// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import {
  Agent,
  MaxTurnsExceededError,
  OpenAIProvider,
  Runner,
  setTracingDisabled,
  type AgentInputItem,
  type RunStreamEvent,
} from '@openai/agents';

import type { TraceProcessorService } from '../services/traceProcessorService';
import { createSkillExecutor } from '../services/skillEngine/skillExecutor';
import { ensureSkillRegistryInitialized, skillRegistry } from '../services/skillEngine/skillLoader';
import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import { sessionContextManager } from '../agent/context/enhancedSessionContext';
import type { StreamingUpdate, Finding } from '../agent/types';
import type { Hypothesis as ProtocolHypothesis } from '../agent/types/agentProtocol';
import type {
  AnalysisOptions,
  AnalysisResult,
  AnalysisTerminationReason,
  IOrchestrator,
} from '../agent/core/orchestratorTypes';
import type { ArchitectureInfo } from '../agent/detectors/types';
import {
  createClaudeMcpServer,
  loadLearnedSqlFixPairs,
  MIN_PHASE_SUMMARY_CHARS,
} from '../agentv3/claudeMcpServer';
import {
  buildQuickSystemPrompt,
  buildSystemPrompt,
} from '../agentv3/claudeSystemPrompt';
import { extractFindingsFromText } from '../agentv3/claudeFindingExtractor';
import { detectFocusApps } from '../agentv3/focusAppDetector';
import { classifyScene, type SceneType } from '../agentv3/sceneClassifier';
import { getExtendedKnowledgeBase } from '../services/sqlKnowledgeBase';
import type {
  AnalysisNote,
  AnalysisPlanV3,
  ClaudeAnalysisContext,
  Hypothesis,
  PlanPhase,
  TraceCompleteness,
  UncertaintyFlag,
} from '../agentv3/types';
import { ArtifactStore } from '../agentv3/artifactStore';
import type { SessionFieldsForSnapshot, SessionStateSnapshot } from '../agentv3/sessionStateSnapshot';
import {
  extractTraceFeatures,
  buildPatternContextSection,
  buildNegativePatternSection,
} from '../agentv3/analysisPatternMemory';
import { SkillNotesBudget } from '../agentv3/selfImprove/skillNotesInjector';
import { probeTraceCompleteness } from '../agentv3/traceCompletenessProber';
import {
  captureEntitiesFromResponses,
  applyCapturedEntities,
} from '../agent/core/entityCapture';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from '../agentv3/outputLanguage';
import { loadOpenAIConfig, type OpenAIAgentConfig } from './openAiConfig';
import { createOpenAIToolsFromMcpDefinitions } from './openAiToolAdapter';

interface OpenAISessionEntry {
  history?: AgentInputItem[];
  lastResponseId?: string;
  runState?: string;
  updatedAt: number;
}

const OPENAI_SESSION_FRESHNESS_MS = 4 * 60 * 60 * 1000;
const OPENAI_MAX_PLAN_CONTINUATIONS = 3;
const OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS = 8_000;

interface PlanCompletionStatus {
  complete: boolean;
  hasPlan: boolean;
  pendingPhases: PlanPhase[];
}

function hasAdequateClosedPhaseSummary(phase: PlanPhase): boolean {
  if (phase.status !== 'completed' && phase.status !== 'skipped') return false;
  return typeof phase.summary === 'string' && phase.summary.trim().length >= MIN_PHASE_SUMMARY_CHARS;
}

function formatTraceContext(
  datasets: import('../agent/core/orchestratorTypes').TraceDataset[] | undefined,
  outputLanguage: OutputLanguage,
): string {
  if (!datasets || datasets.length === 0) return '';
  const parts = datasets.map((d) => {
    const header = `| ${d.columns.join(' | ')} |`;
    const sep = `| ${d.columns.map(() => '---').join(' | ')} |`;
    const rows = (d.rows as unknown[][]).slice(0, 100).map(
      (r) => `| ${r.map((v) => String(v ?? '-')).join(' | ')} |`,
    );
    const truncNote = d.rows.length > 100
      ? localize(outputLanguage, `\n*(前 100 行，共 ${d.rows.length} 行)*`, `\n*(first 100 rows out of ${d.rows.length})*`)
      : '';
    return `### ${d.label}\n${header}\n${sep}\n${rows.join('\n')}${truncNote}`;
  });
  return localize(
    outputLanguage,
    `## 前端预查询 Trace 数据\n\n以下数据已由前端查询完毕，直接使用，无需重复 SQL 查询：\n\n${parts.join('\n\n')}`,
    `## Frontend Pre-queried Trace Data\n\nThe frontend has already queried the following data. Use it directly; do not repeat the same SQL query.\n\n${parts.join('\n\n')}`,
  );
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeToolOutput(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

function isAbortLikeError(error: unknown): boolean {
  const maybe = error as { name?: unknown; constructor?: { name?: string }; message?: unknown };
  const name = typeof maybe?.name === 'string' ? maybe.name : '';
  const constructorName = maybe?.constructor?.name || '';
  const message = typeof maybe?.message === 'string' ? maybe.message.toLowerCase() : '';
  return name === 'AbortError'
    || name === 'APIUserAbortError'
    || constructorName === 'APIUserAbortError'
    || message.includes('aborted')
    || message.includes('abort');
}

export class OpenAIRuntime extends EventEmitter implements IOrchestrator {
  private readonly traceProcessorService: TraceProcessorService;
  private readonly architectureCache = new Map<string, ArchitectureInfo>();
  private readonly vendorCache = new Map<string, string>();
  private readonly completenessCache = new Map<string, TraceCompleteness>();
  private readonly artifactStores = new Map<string, ArtifactStore>();
  private readonly sessionNotes = new Map<string, AnalysisNote[]>();
  private readonly sessionSqlErrors = new Map<string, Array<{ errorSql: string; errorMessage: string; timestamp: number; fixedSql?: string }>>();
  private readonly sessionPlans = new Map<string, { current: AnalysisPlanV3 | null; history: AnalysisPlanV3[] }>();
  private readonly sessionHypotheses = new Map<string, Hypothesis[]>();
  private readonly sessionUncertaintyFlags = new Map<string, UncertaintyFlag[]>();
  private readonly sessionMap = new Map<string, OpenAISessionEntry>();
  private readonly activeAnalyses = new Set<string>();

  constructor(traceProcessorService: TraceProcessorService) {
    super();
    this.traceProcessorService = traceProcessorService;
  }

  getSdkSessionId(sessionId: string): string | undefined {
    return this.sessionMap.get(sessionId)?.lastResponseId;
  }

  restoreSessionMapping(sessionId: string, sdkSessionId: string): void {
    const existing = this.sessionMap.get(sessionId);
    this.sessionMap.set(sessionId, {
      ...existing,
      lastResponseId: sdkSessionId,
      updatedAt: Date.now(),
    });
  }

  restoreArchitectureCache(traceId: string, architecture: ArchitectureInfo): void {
    this.architectureCache.set(traceId, architecture);
  }

  getCachedArchitecture(traceId: string): ArchitectureInfo | undefined {
    return this.architectureCache.get(traceId);
  }

  getSessionNotes(sessionId: string): AnalysisNote[] {
    return this.sessionNotes.get(sessionId) || [];
  }

  getSessionPlan(sessionId: string): AnalysisPlanV3 | null {
    return this.sessionPlans.get(sessionId)?.current ?? null;
  }

  getSessionUncertaintyFlags(sessionId: string): UncertaintyFlag[] {
    return this.sessionUncertaintyFlags.get(sessionId) || [];
  }

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {},
  ): Promise<AnalysisResult> {
    if (this.activeAnalyses.has(sessionId)) {
      throw new Error(`Analysis already in progress for session ${sessionId}`);
    }
    this.activeAnalyses.add(sessionId);

    const startTime = Date.now();
    let accumulatedAnswer = '';
    let rounds = 0;
    const config = loadOpenAIConfig(options.providerId);
    const sceneType = classifyScene(query);
    const quickMode = options.analysisMode === 'fast';

    try {
      const context = await this.prepareAnalysisContext(query, sessionId, traceId, options, {
        config,
        sceneType,
        lightweight: quickMode,
      });

      const promptPrefix = formatTraceContext(options.traceContext, config.outputLanguage);
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n${query}` : query;
      const sessionEntry = this.sessionMap.get(context.sessionMapKey);
      const hasFreshHistory = !!sessionEntry?.history
        && Date.now() - sessionEntry.updatedAt < OPENAI_SESSION_FRESHNESS_MS;
      const usePreviousResponse = config.protocol === 'responses'
        && !!sessionEntry?.lastResponseId
        && Date.now() - sessionEntry.updatedAt < OPENAI_SESSION_FRESHNESS_MS;
      const input: string | AgentInputItem[] = usePreviousResponse
        ? effectivePrompt
        : hasFreshHistory
        ? [
            ...(sessionEntry.history as AgentInputItem[]),
            { role: 'user', content: effectivePrompt } as AgentInputItem,
          ]
        : effectivePrompt;

      setTracingDisabled(true);
      const provider = new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        useResponses: config.protocol === 'responses',
      });
      const runner = new Runner({
        modelProvider: provider,
        tracingDisabled: true,
        traceIncludeSensitiveData: false,
        workflowName: 'SmartPerfetto Analysis',
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const agent = new Agent({
        name: 'SmartPerfetto',
        instructions: context.systemPrompt,
        model: quickMode ? config.lightModel : config.model,
        tools: context.tools,
        toolUseBehavior: 'run_llm_again',
        modelSettings: {
          parallelToolCalls: false,
        },
      });

      const controller = new AbortController();
      const timeoutMs = (quickMode ? config.quickPathPerTurnMs : config.fullPathPerTurnMs)
        * (quickMode ? config.quickMaxTurns : config.maxTurns);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'answering',
          message: localize(
            config.outputLanguage,
            `OpenAI Agents SDK 分析中 (${agent.model})...`,
            `Analyzing with OpenAI Agents SDK (${agent.model})...`,
          ),
          runtime: 'openai-agents-sdk',
          model: agent.model,
        },
        timestamp: Date.now(),
      });

      try {
        let currentInput: string | AgentInputItem[] = input;
        let currentPreviousResponseId = usePreviousResponse ? sessionEntry.lastResponseId : undefined;
        let conclusion = '';
        let finalHistory: AgentInputItem[] | undefined;
        let finalLastResponseId: string | undefined;
        let finalRunState: string | undefined;
        let partial = false;
        let terminationReason: AnalysisTerminationReason | undefined;
        let terminationMessage: string | undefined;

        for (let continuation = 0; ; continuation++) {
          let runAnswer = '';
          let runTurns = 0;
          let completedByPlanIdle = false;
          let planCompleteIdleTimer: ReturnType<typeof setTimeout> | undefined;
          const clearPlanCompleteIdleTimer = () => {
            if (planCompleteIdleTimer) {
              clearTimeout(planCompleteIdleTimer);
              planCompleteIdleTimer = undefined;
            }
          };
          const schedulePlanCompleteIdleAbort = () => {
            clearPlanCompleteIdleTimer();
            if (!this.shouldFinalizeAfterPlanComplete(sessionId, quickMode, runAnswer)) {
              return;
            }
            planCompleteIdleTimer = setTimeout(() => {
              completedByPlanIdle = true;
              this.emitUpdate({
                type: 'progress',
                content: {
                  phase: 'concluding',
                  message: localize(
                    config.outputLanguage,
                    'OpenAI plan 已完成，provider 未主动结束 stream，按已完成计划收尾。',
                    'The OpenAI plan is complete; the provider did not close the stream, so finalizing from the completed plan.',
                  ),
                },
                timestamp: Date.now(),
              });
              controller.abort();
            }, OPENAI_PLAN_COMPLETE_IDLE_ABORT_MS);
          };
          const stream = await runner.run(agent, currentInput, {
            stream: true,
            maxTurns: quickMode ? config.quickMaxTurns : config.maxTurns,
            signal: controller.signal,
            ...(currentPreviousResponseId
              ? { previousResponseId: currentPreviousResponseId }
              : {}),
          });

          try {
            try {
              for await (const event of stream) {
                clearPlanCompleteIdleTimer();
                runTurns = stream.currentTurn || runTurns;
                const delta = this.handleStreamEvent(event, config.outputLanguage);
                if (delta) {
                  runAnswer += delta;
                  accumulatedAnswer += delta;
                }
                schedulePlanCompleteIdleAbort();
              }
              clearPlanCompleteIdleTimer();
              await stream.completed;
            } catch (error) {
              if (!(isAbortLikeError(error) && (completedByPlanIdle || timedOut))) {
                throw error;
              }
            }
          } finally {
            clearPlanCompleteIdleTimer();
          }

          rounds += runTurns || stream.currentTurn || 0;
          const finalOutput = typeof stream.finalOutput === 'string'
            ? stream.finalOutput
            : (stream.finalOutput ? JSON.stringify(stream.finalOutput) : runAnswer);
          conclusion = finalOutput || runAnswer || accumulatedAnswer;
          finalHistory = stream.history;
          finalLastResponseId = stream.lastResponseId;
          finalRunState = this.safeSerializeRunState(stream.state);

          const planStatus = this.getPlanCompletionStatus(sessionId, quickMode);
          if (timedOut && !completedByPlanIdle) {
            partial = true;
            terminationReason = 'timeout';
            terminationMessage = localize(
              config.outputLanguage,
              `OpenAI 分析超过 ${Math.round(timeoutMs / 1000)} 秒超时，结果可能不完整。`,
              `OpenAI analysis timed out after ${Math.round(timeoutMs / 1000)} seconds; the result may be incomplete.`,
            );
            conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'partial_result_after_timeout',
                partial: true,
                terminationReason,
                message: terminationMessage,
              },
              timestamp: Date.now(),
            });
            break;
          }
          if (planStatus.complete) break;

          if (continuation >= OPENAI_MAX_PLAN_CONTINUATIONS) {
            partial = true;
            terminationReason = 'plan_incomplete';
            terminationMessage = this.formatIncompletePlanMessage(planStatus, config.outputLanguage);
            conclusion = this.withIncompletePlanWarning(conclusion, planStatus, config.outputLanguage);
            this.emitUpdate({
              type: 'degraded',
              content: {
                module: 'openAiRuntime',
                fallback: 'partial_result_after_incomplete_plan',
                partial: true,
                terminationReason,
                message: terminationMessage,
              },
              timestamp: Date.now(),
            });
            break;
          }

          this.emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: this.formatPlanContinuationMessage(planStatus, config.outputLanguage),
            },
            timestamp: Date.now(),
          });
          currentInput = [
            ...(stream.history as AgentInputItem[]),
            {
              role: 'user',
              content: this.buildPlanContinuationPrompt(planStatus, config.outputLanguage),
            } as AgentInputItem,
          ];
          currentPreviousResponseId = undefined;
        }

        clearTimeout(timeout);
        const findings = extractFindingsFromText(conclusion);
        const confidence = partial
          ? Math.min(0.55, this.estimateConfidence(findings, conclusion))
          : this.estimateConfidence(findings, conclusion);

        this.sessionMap.set(context.sessionMapKey, {
          history: finalHistory,
          lastResponseId: finalLastResponseId,
          runState: finalRunState,
          updatedAt: Date.now(),
        });

        this.recordTurn({
          query,
          sessionId,
          conclusion,
          findings,
          confidence,
          sessionContext: context.sessionContext,
          previousTurnCount: context.previousTurns.length,
          quickMode,
        });

        this.emitUpdate({
          type: 'conclusion',
          content: { conclusion, durationMs: Date.now() - startTime, turns: rounds },
          timestamp: Date.now(),
        });
        this.emitUpdate({
          type: 'answer_token',
          content: { done: true, totalChars: conclusion.length },
          timestamp: Date.now(),
        });

        await provider.close().catch(() => undefined);

        return {
          sessionId,
          success: true,
          findings,
          hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
          conclusion,
          confidence,
          rounds,
          totalDurationMs: Date.now() - startTime,
          partial: partial || undefined,
          terminationReason,
          terminationMessage,
        };
      } catch (error) {
        clearTimeout(timeout);
        await provider.close().catch(() => undefined);
        if (error instanceof MaxTurnsExceededError) {
          const partialConclusion = accumulatedAnswer || localize(
            config.outputLanguage,
            '分析达到 OpenAI Agents SDK 轮次上限，尚未形成完整结论。',
            'The OpenAI Agents SDK run reached the turn limit before a complete conclusion was produced.',
          );
          const findings = extractFindingsFromText(partialConclusion);
          const confidence = Math.min(0.55, this.estimateConfidence(findings, partialConclusion));
          this.emitUpdate({
            type: 'degraded',
            content: {
              module: 'openAiRuntime',
              fallback: 'partial_result_after_max_turns',
              partial: true,
              terminationReason: 'max_turns',
              message: localize(
                config.outputLanguage,
                'OpenAI 分析达到轮次上限，结果可能不完整',
                'OpenAI analysis reached the turn limit; result may be incomplete',
              ),
            },
            timestamp: Date.now(),
          });
          return {
            sessionId,
            success: true,
            findings,
            hypotheses: context.hypotheses.map(h => this.toProtocolHypothesis(h)),
            conclusion: partialConclusion,
            confidence,
            rounds,
            totalDurationMs: Date.now() - startTime,
            partial: true,
            terminationReason: 'max_turns',
            terminationMessage: error.message,
          };
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitUpdate({
        type: 'error',
        content: { message: `OpenAI Agents SDK analysis failed: ${message}` },
        timestamp: Date.now(),
      });
      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: localize(
          config.outputLanguage,
          `OpenAI Agents SDK 分析失败：${message}`,
          `OpenAI Agents SDK analysis failed: ${message}`,
        ),
        confidence: 0,
        rounds,
        totalDurationMs: Date.now() - startTime,
        terminationReason: 'execution_error',
        terminationMessage: message,
      };
    } finally {
      this.activeAnalyses.delete(sessionId);
    }
  }

  reset(): void {
    this.architectureCache.clear();
    this.vendorCache.clear();
    this.completenessCache.clear();
    this.artifactStores.clear();
    this.sessionNotes.clear();
    this.sessionSqlErrors.clear();
    this.sessionPlans.clear();
    this.sessionHypotheses.clear();
    this.sessionUncertaintyFlags.clear();
    this.sessionMap.clear();
    this.activeAnalyses.clear();
  }

  cleanupSession(sessionId: string): void {
    this.sessionMap.delete(sessionId);
    for (const key of Array.from(this.sessionMap.keys())) {
      if (key.startsWith(`${sessionId}:ref:`)) this.sessionMap.delete(key);
    }
    this.artifactStores.delete(sessionId);
    this.sessionNotes.delete(sessionId);
    this.sessionSqlErrors.delete(sessionId);
    this.sessionPlans.delete(sessionId);
    this.sessionHypotheses.delete(sessionId);
    this.sessionUncertaintyFlags.delete(sessionId);
    this.activeAnalyses.delete(sessionId);
  }

  takeSnapshot(
    sessionId: string,
    traceId: string,
    sessionFields: SessionFieldsForSnapshot,
  ): SessionStateSnapshot {
    const planState = this.sessionPlans.get(sessionId);
    const artifactStore = this.artifactStores.get(sessionId);
    const sessionEntry = this.sessionMap.get(sessionId);
    return {
      version: 1,
      snapshotTimestamp: Date.now(),
      sessionId,
      traceId,
      ...sessionFields,
      analysisNotes: this.sessionNotes.get(sessionId) || [],
      analysisPlan: planState?.current ?? null,
      planHistory: planState?.history ?? [],
      uncertaintyFlags: this.sessionUncertaintyFlags.get(sessionId) || [],
      claudeHypotheses: this.sessionHypotheses.get(sessionId) || undefined,
      architecture: this.architectureCache.get(traceId),
      sdkSessionId: sessionEntry?.lastResponseId,
      agentRuntimeKind: 'openai-agents-sdk',
      agentRuntimeProviderId: sessionFields.agentRuntimeProviderId,
      openAIHistory: sessionEntry?.history,
      openAILastResponseId: sessionEntry?.lastResponseId,
      openAIRunState: sessionEntry?.runState,
      artifacts: artifactStore?.serialize(),
    };
  }

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
    if (snapshot.openAIHistory || snapshot.openAILastResponseId || snapshot.sdkSessionId) {
      this.sessionMap.set(sessionId, {
        history: snapshot.openAIHistory as AgentInputItem[] | undefined,
        lastResponseId: snapshot.openAILastResponseId || snapshot.sdkSessionId,
        runState: snapshot.openAIRunState,
        updatedAt: Date.now(),
      });
    }
  }

  private async prepareAnalysisContext(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions,
    runtime: {
      config: OpenAIAgentConfig;
      sceneType: SceneType;
      lightweight: boolean;
    },
  ) {
    const { config, sceneType, lightweight } = runtime;
    let effectivePackageName = options.packageName;
    const focusResult = await detectFocusApps(this.traceProcessorService, traceId);
    if (!effectivePackageName && focusResult.primaryApp) {
      effectivePackageName = focusResult.primaryApp;
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(
            config.outputLanguage,
            `检测到焦点应用: ${focusResult.primaryApp} (${focusResult.method})`,
            `Detected focus app: ${focusResult.primaryApp} (${focusResult.method})`,
          ),
        },
        timestamp: Date.now(),
      });
    }

    const skillExecutor = createSkillExecutor(this.traceProcessorService);
    await ensureSkillRegistryInitialized();
    skillExecutor.registerSkills(skillRegistry.getAllSkills());
    skillExecutor.setFragmentRegistry(skillRegistry.getFragmentCache());

    const architecture = await this.detectArchitecture(traceId, effectivePackageName);
    const detectedVendor = await this.detectVendor(traceId);
    const traceCompleteness = await this.detectCompleteness(traceId, architecture);
    const comparisonContext = options.referenceTraceId
      ? await this.buildComparisonContext(traceId, options.referenceTraceId, config.outputLanguage)
      : undefined;

    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const previousTurns = sessionContext.getAllTurns?.() || [];
    const previousFindings = this.collectPreviousFindings(sessionContext);
    const conversationSummary = previousTurns.length > 0
      ? sessionContext.generatePromptContext(2000)
      : undefined;
    const entityStore = sessionContext.getEntityStore();
    const entityContext = this.buildEntityContext(entityStore);

    if (!this.artifactStores.has(sessionId)) {
      this.artifactStores.set(sessionId, new ArtifactStore());
    }
    const artifactStore = this.artifactStores.get(sessionId)!;

    let notes = this.sessionNotes.get(sessionId);
    if (!notes) {
      notes = [];
      this.sessionNotes.set(sessionId, notes);
    }

    if (!this.sessionPlans.has(sessionId)) {
      this.sessionPlans.set(sessionId, { current: null, history: [] });
    }
    const analysisPlan = this.sessionPlans.get(sessionId)!;
    if (analysisPlan.current) {
      analysisPlan.history.push(analysisPlan.current);
      if (analysisPlan.history.length > 3) analysisPlan.history.shift();
    }
    const previousPlan = analysisPlan.current ?? undefined;
    analysisPlan.current = null;

    if (!this.sessionHypotheses.has(sessionId)) {
      this.sessionHypotheses.set(sessionId, []);
    }
    const hypotheses = this.sessionHypotheses.get(sessionId)!;
    hypotheses.splice(0);

    if (!this.sessionUncertaintyFlags.has(sessionId)) {
      this.sessionUncertaintyFlags.set(sessionId, []);
    }
    const uncertaintyFlags = this.sessionUncertaintyFlags.get(sessionId)!;
    uncertaintyFlags.splice(0);

    let sqlErrors = this.sessionSqlErrors.get(sessionId);
    if (!sqlErrors) {
      sqlErrors = loadLearnedSqlFixPairs(5);
      this.sessionSqlErrors.set(sessionId, sqlErrors);
    }

    const skillNotesBudget = !lightweight && process.env.SELF_IMPROVE_NOTES_INJECT_ENABLED === '1'
      ? new SkillNotesBudget({ mode: 'full' })
      : undefined;
    const { allowedTools, toolDefinitions } = createClaudeMcpServer({
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
      analysisPlan: lightweight ? undefined : analysisPlan,
      watchdogWarning: { current: null },
      hypotheses,
      sceneType,
      uncertaintyFlags,
      referenceTraceId: options.referenceTraceId,
      comparisonContext,
      lightweight,
      skillNotesBudget,
      outputLanguage: config.outputLanguage,
    });

    const tools = createOpenAIToolsFromMcpDefinitions(toolDefinitions);

    let knowledgeBaseContext: string | undefined;
    try {
      const kb = await getExtendedKnowledgeBase();
      knowledgeBaseContext = kb.getContextForAI(query, 8);
    } catch {
      // Optional context only.
    }

    const traceFeatures = extractTraceFeatures({
      architectureType: architecture?.type,
      sceneType,
      packageName: effectivePackageName,
    });
    const sqlErrorFixPairs = sqlErrors
      .filter((e: any) => e.fixedSql)
      .slice(-3)
      .map((e: any) => ({ errorSql: e.errorSql, errorMessage: e.errorMessage, fixedSql: e.fixedSql }));

    const systemPrompt = lightweight
      ? buildQuickSystemPrompt({
          architecture,
          packageName: effectivePackageName,
          focusApps: focusResult.apps.length > 0 ? focusResult.apps : undefined,
          focusMethod: focusResult.method,
          selectionContext: options.selectionContext,
          outputLanguage: config.outputLanguage,
        })
      : buildSystemPrompt({
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
          availableAgents: undefined,
          sqlErrorFixPairs: sqlErrorFixPairs.length > 0 ? sqlErrorFixPairs : undefined,
          patternContext: buildPatternContextSection(traceFeatures),
          negativePatternContext: buildNegativePatternSection(traceFeatures),
          previousPlan,
          planHistory: analysisPlan.history.length > 0 ? analysisPlan.history : undefined,
          selectionContext: options.selectionContext,
          comparison: comparisonContext,
          traceCompleteness,
          outputLanguage: config.outputLanguage,
        } satisfies ClaudeAnalysisContext);

    const sessionMapKey = options.referenceTraceId
      ? `${sessionId}:ref:${options.referenceTraceId}`
      : sessionId;

    return {
      systemPrompt,
      tools,
      sessionContext,
      previousTurns,
      architecture,
      hypotheses,
      allowedTools,
      sessionMapKey,
    };
  }

  private async detectArchitecture(
    traceId: string,
    packageName?: string,
  ): Promise<ArchitectureInfo | undefined> {
    const cached = this.architectureCache.get(traceId);
    if (cached) return cached;
    try {
      const detector = createArchitectureDetector();
      const architecture = await detector.detect({
        traceId,
        traceProcessorService: this.traceProcessorService,
        packageName,
      });
      if (architecture) {
        this.architectureCache.set(traceId, architecture);
        this.emitUpdate({ type: 'architecture_detected', content: { architecture }, timestamp: Date.now() });
      }
      return architecture;
    } catch (error) {
      console.warn('[OpenAIRuntime] Architecture detection failed:', (error as Error).message);
      return undefined;
    }
  }

  private async buildComparisonContext(
    traceId: string,
    referenceTraceId: string,
    outputLanguage: OutputLanguage,
  ): Promise<import('../agentv3/types').ComparisonContext> {
    this.emitUpdate({
      type: 'progress',
      content: {
        phase: 'starting',
        message: localize(
          outputLanguage,
          '对比模式：正在检测参考 Trace...',
          'Comparison mode: detecting the reference trace...',
        ),
      },
      timestamp: Date.now(),
    });

    const capSql = "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND (name LIKE 'android_%' OR name LIKE 'linux_%' OR name LIKE 'sched_%' OR name LIKE 'slices_%')";
    const [refFocusResult, refArchitecture, currentTables, refTables] = await Promise.all([
      detectFocusApps(this.traceProcessorService, referenceTraceId).catch(() => ({
        apps: [],
        method: 'none' as const,
        primaryApp: undefined,
      })),
      this.detectArchitecture(referenceTraceId, undefined).catch(() => undefined),
      this.traceProcessorService.query(traceId, capSql).catch((error) => {
        console.warn('[OpenAIRuntime] Capability query failed for current trace:', error.message);
        return null;
      }),
      this.traceProcessorService.query(referenceTraceId, capSql).catch((error) => {
        console.warn('[OpenAIRuntime] Capability query failed for reference trace:', error.message);
        return null;
      }),
    ]);

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
    }

    return {
      referenceTraceId,
      referencePackageName: refFocusResult.primaryApp,
      referenceFocusApps: refFocusResult.apps.length > 0 ? refFocusResult.apps : undefined,
      referenceArchitecture: refArchitecture,
      commonCapabilities,
      capabilityDiff,
    };
  }

  private async detectVendor(traceId: string): Promise<string | null> {
    const cached = this.vendorCache.get(traceId);
    if (cached) return cached;
    try {
      const adapter = getSkillAnalysisAdapter(this.traceProcessorService);
      await adapter.ensureInitialized();
      const result = await adapter.detectVendor(traceId);
      if (result.vendor && result.vendor !== 'aosp') this.vendorCache.set(traceId, result.vendor);
      return result.vendor;
    } catch (error) {
      console.warn('[OpenAIRuntime] Vendor detection failed:', (error as Error).message);
      return null;
    }
  }

  private async detectCompleteness(
    traceId: string,
    architecture?: ArchitectureInfo,
  ): Promise<TraceCompleteness | undefined> {
    const cached = this.completenessCache.get(traceId);
    if (cached) return cached;
    try {
      const completeness = await probeTraceCompleteness(
        this.traceProcessorService,
        traceId,
        architecture?.type,
      );
      this.completenessCache.set(traceId, completeness);
      return completeness;
    } catch (error) {
      console.warn('[OpenAIRuntime] Trace completeness probe failed:', (error as Error).message);
      return undefined;
    }
  }

  private getPlanCompletionStatus(sessionId: string, quickMode: boolean): PlanCompletionStatus {
    if (quickMode) {
      return { complete: true, hasPlan: false, pendingPhases: [] };
    }
    const plan = this.sessionPlans.get(sessionId)?.current ?? null;
    if (!plan) {
      return { complete: false, hasPlan: false, pendingPhases: [] };
    }
    const pendingPhases = plan.phases.filter(phase => !hasAdequateClosedPhaseSummary(phase));
    return {
      complete: pendingPhases.length === 0,
      hasPlan: true,
      pendingPhases,
    };
  }

  private shouldFinalizeAfterPlanComplete(
    sessionId: string,
    quickMode: boolean,
    answer: string,
  ): boolean {
    if (quickMode || answer.trim().length === 0) {
      return false;
    }
    return this.getPlanCompletionStatus(sessionId, quickMode).complete;
  }

  private formatPlanContinuationMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        'OpenAI 模型提前结束但尚未提交分析计划，继续执行...',
        'The OpenAI model stopped before submitting an analysis plan; continuing...',
      );
    }
    const phaseNames = status.pendingPhases.map(p => p.name || p.id).slice(0, 3).join('、');
    return localize(
      outputLanguage,
      `OpenAI 模型提前结束但 plan 未完成，继续执行剩余阶段：${phaseNames}`,
      `The OpenAI model stopped before the plan completed; continuing remaining phases: ${phaseNames}`,
    );
  }

  private formatIncompletePlanMessage(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    if (!status.hasPlan) {
      return localize(
        outputLanguage,
        'OpenAI 分析没有提交 plan，结果只能作为不完整分析使用。',
        'OpenAI analysis did not submit a plan; treat the result as incomplete.',
      );
    }
    const phaseNames = status.pendingPhases.map(p => `${p.id}:${p.name}`).join(', ');
    return localize(
      outputLanguage,
      `OpenAI 分析达到继续执行上限，但 plan 仍未完成。未完成阶段：${phaseNames}`,
      `OpenAI analysis reached the continuation limit, but the plan is still incomplete. Pending phases: ${phaseNames}`,
    );
  }

  private buildPlanContinuationPrompt(
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const pending = status.pendingPhases.map(phase => {
      const tools = phase.expectedTools?.length ? `；预期工具: ${phase.expectedTools.join(', ')}` : '';
      return `- ${phase.id} ${phase.name}: ${phase.goal}${tools}`;
    }).join('\n');

    return localize(
      outputLanguage,
      status.hasPlan
        ? `系统校验：你刚才给出了阶段性回答，但当前分析 plan 还没有完成，所以那不是最终答案。请继续执行剩余阶段，不要重述已完成内容。\n\n未完成阶段：\n${pending}\n\n要求：继续调用必要工具收集证据；完成或跳过每个阶段时必须调用 update_plan_phase；只有所有阶段 completed/skipped 后，才能输出最终结论。`
        : '系统校验：你刚才直接回答了用户，但当前是 full 分析模式，尚未调用 submit_plan。请先调用 submit_plan 建立分析计划，然后执行必要工具。只有所有计划阶段 completed/skipped 后，才能输出最终结论。',
      status.hasPlan
        ? `System check: you produced an interim answer, but the analysis plan is not complete, so that was not a final answer. Continue the remaining phases without restating completed work.\n\nPending phases:\n${pending}\n\nRequirements: call the necessary tools to collect evidence; call update_plan_phase whenever completing or skipping each phase; only produce the final conclusion after every phase is completed or skipped.`
        : 'System check: you answered directly, but this is full analysis mode and submit_plan has not been called. Call submit_plan first, then execute the necessary tools. Only produce the final conclusion after every planned phase is completed or skipped.',
    );
  }

  private withIncompletePlanWarning(
    conclusion: string,
    status: PlanCompletionStatus,
    outputLanguage: OutputLanguage,
  ): string {
    const warning = this.formatIncompletePlanMessage(status, outputLanguage);
    return conclusion.trim()
      ? `${warning}\n\n${conclusion}`
      : warning;
  }

  private handleStreamEvent(event: RunStreamEvent, outputLanguage: OutputLanguage): string {
    const now = Date.now();
    if (event.type === 'raw_model_stream_event') {
      const data = event.data as any;
      if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
        this.emitUpdate({ type: 'answer_token', content: { token: data.delta }, timestamp: now });
        return data.delta;
      }
      return '';
    }

    if (event.type === 'agent_updated_stream_event') {
      this.emitUpdate({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `切换到 OpenAI Agent: ${event.agent.name}`,
            `Switched to OpenAI Agent: ${event.agent.name}`,
          ),
        },
        timestamp: now,
      });
      return '';
    }

    const rawItem = (event.item as any)?.rawItem;
    if (event.name === 'tool_called') {
      const args = parseJsonObject(rawItem?.arguments) || {};
      this.emitUpdate({
        type: 'agent_task_dispatched',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          toolName: rawItem?.name || 'unknown',
          args,
          message: localize(
            outputLanguage,
            `调用工具: ${rawItem?.name || 'unknown'}`,
            `Call tool: ${rawItem?.name || 'unknown'}`,
          ),
        },
        timestamp: now,
      });
    } else if (event.name === 'tool_output') {
      this.emitUpdate({
        type: 'agent_response',
        content: {
          taskId: rawItem?.callId || rawItem?.id || 'unknown',
          result: summarizeToolOutput(rawItem?.output),
        },
        timestamp: now,
      });
    } else if (event.name === 'reasoning_item_created') {
      const text = Array.isArray(rawItem?.content)
        ? rawItem.content.map((c: any) => c.text).filter(Boolean).join('\n')
        : undefined;
      if (text) {
        this.emitUpdate({ type: 'thought', content: { thought: text }, timestamp: now });
      }
    }
    return '';
  }

  private safeSerializeRunState(state: unknown): string | undefined {
    try {
      const asSerializable = state as { toString?: () => string };
      const serialized = asSerializable?.toString?.();
      return serialized && serialized !== '[object Object]' ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  private estimateConfidence(findings: Finding[], conclusion: string): number {
    if (findings.length === 0) return conclusion.trim().length > 0 ? 0.55 : 0.25;
    const avg = findings.reduce((sum, f) => sum + (f.confidence ?? 0.5), 0) / findings.length;
    return Math.min(1, Math.max(0, avg));
  }

  private recordTurn(input: {
    query: string;
    sessionId: string;
    conclusion: string;
    findings: Finding[];
    confidence: number;
    sessionContext: ReturnType<typeof sessionContextManager.getOrCreate>;
    previousTurnCount: number;
    quickMode: boolean;
  }): void {
    input.sessionContext.addTurn(
      input.query,
      {
        primaryGoal: input.query,
        aspects: [],
        expectedOutputType: input.quickMode ? 'summary' : 'diagnosis',
        complexity: input.quickMode ? 'simple' : 'complex',
        followUpType: input.previousTurnCount > 0 ? 'extend' : 'initial',
      },
      {
        agentId: 'openai-agent',
        success: true,
        findings: input.findings,
        confidence: input.confidence,
        message: input.conclusion,
      },
      input.findings,
    );

    input.sessionContext.updateWorkingMemoryFromConclusion({
      turnIndex: input.previousTurnCount,
      query: input.query,
      conclusion: input.conclusion,
      confidence: input.confidence,
    });
  }

  private captureEntitiesFromSkillDisplayResults(
    displayResults: Array<{ stepId?: string; data?: any }>,
    entityStore: any,
  ): void {
    try {
      const data: Record<string, any> = {};
      for (const dr of displayResults) {
        if (dr.stepId && dr.data) data[dr.stepId] = dr.data;
      }
      const captured = captureEntitiesFromResponses([{
        agentId: 'openai-agent',
        success: true,
        toolResults: [{ toolName: 'invoke_skill', data }],
      } as any]);
      applyCapturedEntities(entityStore, captured);
    } catch (error) {
      console.warn('[OpenAIRuntime] Entity capture failed:', (error as Error).message);
    }
  }

  private collectPreviousFindings(sessionContext: any, maxTurns = 3): Finding[] {
    try {
      const turns = sessionContext.getAllTurns?.() || [];
      return turns.slice(-maxTurns).flatMap((turn: any) => turn.findings || []).slice(0, 5);
    } catch {
      return [];
    }
  }

  private buildEntityContext(entityStore: any): string | undefined {
    try {
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
      supportingEvidence: h.evidence && h.status === 'confirmed'
        ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source: 'openai', strength: 0.8 }]
        : [],
      contradictingEvidence: h.evidence && h.status === 'rejected'
        ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source: 'openai', strength: 0.8 }]
        : [],
      proposedBy: 'openai',
      relevantAgents: ['openai'],
      createdAt: h.formedAt,
      updatedAt: h.resolvedAt || h.formedAt,
    };
  }

  private emitUpdate(update: StreamingUpdate): void {
    this.emit('update', update);
  }
}

export function createOpenAIRuntime(traceProcessorService: TraceProcessorService): OpenAIRuntime {
  return new OpenAIRuntime(traceProcessorService);
}
