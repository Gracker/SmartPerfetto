/**
 * SmartPerfetto Agent-Driven Orchestrator (Thin Coordinator)
 *
 * This orchestrator is a thin coordination layer that:
 * 1. Initializes infrastructure (message bus, agent registry, etc.)
 * 2. Understands user intent and generates hypotheses
 * 3. Selects the appropriate executor (Strategy or Hypothesis)
 * 4. Delegates execution to the chosen executor
 * 5. Generates conclusion from executor results
 *
 * All heavy logic lives in extracted modules:
 * - intentUnderstanding.ts — intent parsing
 * - hypothesisGenerator.ts — hypothesis generation
 * - taskGraphPlanner.ts — task planning
 * - taskGraphExecutor.ts — dependency-ordered execution
 * - feedbackSynthesizer.ts — LLM synthesis
 * - conclusionGenerator.ts — conclusion generation
 * - executors/strategyExecutor.ts — deterministic pipeline
 * - executors/hypothesisExecutor.ts — adaptive loop
 */

import { EventEmitter } from 'events';
import { StreamingUpdate } from '../types';
import { ModelRouter } from './modelRouter';
import { AgentMessageBus, createAgentMessageBus } from '../communication';
import { DomainAgentRegistry, createDomainAgentRegistry } from '../agents/domain';
import {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
} from '../agents/iterationStrategyPlanner';
import {
  createEnhancedStrategyRegistry,
  StrategyRegistry,
  type StrategyMatchResult,
} from '../strategies';
import {
  sessionContextManager,
  EnhancedSessionContext,
} from '../context/enhancedSessionContext';
import { resolveFollowUp, FollowUpResolution } from './followUpHandler';
import { CircuitBreaker } from './circuitBreaker';
import { resolveDrillDown, DrillDownResolved } from './drillDownResolver';
import { applyCapturedEntities } from './entityCapture';
import { detectAdbContext } from '../../services/adb';
import { summarizeTraceAgentState } from '../state/traceAgentState';
import type { FocusInterval } from '../strategies/types';
import { detectTraceConfig } from './executors/traceConfigDetector';
import {
  DEFAULT_DOMAIN_MANIFEST,
  getAspectEvidenceChecklist,
  getModeSpecificEvidenceChecklist,
  shouldPreferHypothesisLoop,
} from '../config/domainManifest';

// New Agent-Driven Architecture components (v2.0)
import { InterventionController, InterventionPoint, InterventionOption } from './interventionController';
import { FocusStore, FocusInteraction } from '../context/focusStore';
import { IncrementalAnalyzer, PreviousAnalysisState, IncrementalScope } from './incrementalAnalyzer';
import { detectTraceContext } from './strategySelector';
import { createEmittedEnvelopeRegistry } from './emittedEnvelopeRegistry';

import {
  AgentDrivenOrchestratorConfig,
  DEFAULT_CONFIG,
  AnalysisResult,
  AnalysisOptions,
  AnalysisServices,
  ProgressEmitter,
  ExecutionContext,
  AnalysisPlanMode,
  AnalysisPlanPayload,
  AnalysisPlanStep,
} from './orchestratorTypes';
import type { Hypothesis } from '../types/agentProtocol';
import { understandIntent } from './intentUnderstanding';
import { generateInitialHypotheses, translateFollowUpType } from './hypothesisGenerator';
import { deriveConclusionContract, generateConclusion } from './conclusionGenerator';
import { StrategyExecutor } from './executors/strategyExecutor';
import { HypothesisExecutor } from './executors/hypothesisExecutor';
import { DirectDrillDownExecutor } from './executors/directDrillDownExecutor';
import { ClarifyExecutor } from './executors/clarifyExecutor';
import { ComparisonExecutor } from './executors/comparisonExecutor';
import { ExtendExecutor } from './executors/extendExecutor';
import type { AnalysisExecutor } from './executors/analysisExecutor';

// =============================================================================
// Agent-Driven Orchestrator
// =============================================================================

export class AgentDrivenOrchestrator extends EventEmitter {
  private config: AgentDrivenOrchestratorConfig;
  private modelRouter: ModelRouter;
  private messageBus: AgentMessageBus;
  private agentRegistry: DomainAgentRegistry;
  private strategyPlanner: IterationStrategyPlanner;
  private strategyRegistry: StrategyRegistry;
  private circuitBreaker: CircuitBreaker;

  // New Agent-Driven Architecture components (v2.0)
  private interventionController: InterventionController;
  private focusStore: FocusStore;
  private incrementalAnalyzer: IncrementalAnalyzer;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentDrivenOrchestratorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = modelRouter;

    this.messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      enableLogging: this.config.enableLogging,
    });

    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);

    // Use enhanced registry with LLM semantic matching (keyword_first mode for backward compatibility)
    this.strategyRegistry = createEnhancedStrategyRegistry(modelRouter, 'keyword_first');
    this.circuitBreaker = new CircuitBreaker();

    // Initialize new Agent-Driven Architecture components
    this.interventionController = new InterventionController({
      confidenceThreshold: this.config.confidenceThreshold,
      timeoutThresholdMs: 120000, // 2 minutes default
      userResponseTimeoutMs: 60000, // 1 minute for user to respond
    });
    this.focusStore = new FocusStore();
    this.incrementalAnalyzer = new IncrementalAnalyzer();

    // Forward intervention events to SSE stream
    this.setupInterventionEventForwarding();

    // Register all agents with message bus
    for (const agent of this.agentRegistry.getAll()) {
      this.messageBus.registerAgent(agent);
    }

    this.setupEventForwarding();
  }

  // ==========================================================================
  // Core Analysis Method
  // ==========================================================================

  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: AnalysisOptions = {}
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    this.strategyPlanner.resetProgressTracking();
    // NOTE: CircuitBreaker is NOT reset per-call — failure history persists
    // across multi-turn sessions. Use orchestrator.reset() for full cleanup.

    const emitter = this.createProgressEmitter();
    emitter.log(`Starting agent-driven analysis for: ${query}`);
    emitter.emitUpdate('progress', { phase: 'starting', message: '开始 AI Agent 分析' });

    // Get or create session context for multi-turn support
    const sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
    const turnCount = sessionContext.getAllTurns().length;
    emitter.log(`Session has ${turnCount} previous turns`);

    // Initialize goal-driven TraceAgentState (v1 scaffold, persisted via SessionContext).
    const traceAgentState = sessionContext.getOrCreateTraceAgentState(query);
    emitter.emitUpdate('progress', {
      phase: 'agent_state_loaded',
      message: '加载 Agent 状态（目标/偏好/历史摘要）',
      state: summarizeTraceAgentState(traceAgentState),
    });

    // Per-turn experiment budget:
    // - maxRounds is a hard safety cap (prevents runaway cost/latency).
    // - maxExperimentsPerTurn is a *preference* (soft budget): stop early only if results are good enough.
    const maxExperimentsPerTurn = Number(traceAgentState?.preferences?.maxExperimentsPerTurn || 3);
    const hardMaxRounds = Math.max(1, this.config.maxRounds);
    const softMaxRounds = Math.max(1, Math.floor(maxExperimentsPerTurn));
    const effectiveConfig: AgentDrivenOrchestratorConfig = {
      ...this.config,
      maxRounds: hardMaxRounds,
      softMaxRounds: Math.min(hardMaxRounds, softMaxRounds),
    };

    try {
      // 1. Initialize shared context
      const sharedContext = this.messageBus.createSharedContext(sessionId, traceId);

      // 1.1 Detect ADB collaboration context (best-effort; never fail analysis)
      let adbContext: any = undefined;
      try {
        adbContext = await detectAdbContext(options.adb, options.traceProcessorService, traceId);
        sharedContext.userContext = {
          ...(sharedContext.userContext || {}),
          adb: adbContext,
        };

        const selectedSerial = adbContext?.availability?.selectedSerial;
        const matchStatus = adbContext?.traceMatch?.status;
        emitter.emitUpdate('progress', {
          phase: 'adb_context',
          message: adbContext?.availability?.installed
            ? (adbContext?.enabled
              ? `检测到 ADB 设备${selectedSerial ? ` (${selectedSerial})` : ''}，已启用协同`
              : `检测到 ADB${selectedSerial ? ` 设备 (${selectedSerial})` : ''}，但未启用协同（mode=${adbContext?.mode || 'auto'}，match=${matchStatus || 'unknown'}）`)
            : '未检测到 ADB（已忽略）',
          adb: {
            mode: adbContext?.mode,
            enabled: adbContext?.enabled,
            installed: adbContext?.availability?.installed,
            selectedSerial,
            deviceCount: Array.isArray(adbContext?.availability?.devices)
              ? adbContext.availability.devices.length
              : 0,
            matchStatus,
            matchConfidence: adbContext?.traceMatch?.confidence,
            warnings: adbContext?.warnings,
          },
        });
      } catch (e: any) {
        emitter.log(`[ADB] detectAdbContext failed: ${e?.message || 'unknown error'}`);
      }

      // Enrich options with resolved adbContext for downstream task planning/tools.
      const effectiveOptions: AnalysisOptions = {
        ...options,
        ...(adbContext ? { adbContext } : {}),
      };

      // 1.2 Detect trace configuration (VSync/refresh rate) once per turn.
      // StrategyExecutor does this too, but the default hypothesis+exp loop needs it as well
      // for accurate jank thresholds and contradiction resolution.
      if (!sharedContext.traceConfig && effectiveOptions.traceProcessorService) {
        try {
          const traceConfig = await detectTraceConfig(
            effectiveOptions.traceProcessorService,
            this.modelRouter,
            traceId,
            emitter
          );
          sharedContext.traceConfig = traceConfig;

          // Also mirror into globalMetrics for backward compatibility.
          sharedContext.globalMetrics = sharedContext.globalMetrics || {};
          sharedContext.globalMetrics.refreshRateHz = traceConfig.refreshRateHz;
          sharedContext.globalMetrics.vsyncPeriodMs = traceConfig.vsyncPeriodMs;
          sharedContext.globalMetrics.isVRR = traceConfig.isVRR;

          emitter.emitUpdate('progress', {
            phase: 'trace_config',
            message: `刷新率/帧预算: ${traceConfig.refreshRateHz}Hz / ${traceConfig.vsyncPeriodMs}ms${traceConfig.isVRR ? ` (VRR:${traceConfig.vrrMode})` : ''}`,
            traceConfig,
          });
        } catch (e: any) {
          emitter.log(`[TraceConfig] Detection failed (ignored): ${e?.message || e}`);
        }
      }

      // 2. Understand intent WITH session context for multi-turn awareness
      emitter.emitUpdate('progress', { phase: 'understanding', message: '理解用户意图' });
      const intent = await understandIntent(query, sessionContext, this.modelRouter, emitter);
      // Update goal from intent (best-effort)
      sessionContext.updateTraceAgentGoalFromIntent(intent.primaryGoal);

      // Log follow-up detection
      if (intent.followUpType && intent.followUpType !== 'initial') {
        emitter.log(`Detected follow-up: ${intent.followUpType}, entities: ${JSON.stringify(intent.referencedEntities)}`);
        emitter.emitUpdate('progress', {
          phase: 'follow_up_detected',
          message: `检测到${translateFollowUpType(intent.followUpType!)}请求`,
          followUpType: intent.followUpType,
          referencedEntities: intent.referencedEntities,
        });
      }

      // 3. Resolve follow-up query - enriches params with details from previous findings
      const followUpResolution = resolveFollowUp(intent, sessionContext);
      if (followUpResolution.isFollowUp) {
        emitter.log(`Follow-up resolved: ${followUpResolution.resolutionDetails || 'params merged'}`);
        if (followUpResolution.focusIntervals?.length) {
          emitter.log(`Built ${followUpResolution.focusIntervals.length} focus interval(s) for drill-down`);
        }
      }

      // 3.5 Record input focus early so it can influence incremental scope/task planning (v2.0).
      // This captures explicit entities/time ranges from follow-up resolution before we decide scope.
      this.recordInputFocus(query, intent, followUpResolution, sessionContext, emitter);

      // 4. Generate hypotheses - with smart skip for drill-down on cached entities
      // Fix: 对于 drill-down follow-up，如果目标实体已在 EntityStore 中有完整分析，
      // 跳过假设生成，避免重复工作
      let initialHypotheses: Hypothesis[] = [];
      const isClarifyFollowUp = intent.followUpType === 'clarify';
      const isDrillDownFollowUp = intent.followUpType === 'drill_down';
      const entityStore = sessionContext?.getEntityStore();
      const targetFrameId = intent.extractedParams?.frame_id;
      const targetSessionId = intent.extractedParams?.session_id;

      // Check if this is a drill-down with cached entity data
      // Use wasFrameAnalyzed/wasSessionAnalyzed to check if entity was already analyzed
      const isDrillDownWithCachedFrame =
        intent.followUpType === 'drill_down' &&
        targetFrameId &&
        entityStore?.wasFrameAnalyzed(String(targetFrameId));

      const isDrillDownWithCachedSession =
        intent.followUpType === 'drill_down' &&
        targetSessionId &&
        entityStore?.wasSessionAnalyzed(String(targetSessionId));

      // For explicit drill-down, hypothesis generation is usually noise:
      // we already know the target entity and should execute deterministic deep analysis directly.
      if (isClarifyFollowUp) {
        emitter.log('[Clarify] Skipping hypothesis generation for clarification follow-up');
        initialHypotheses = [];
      } else if (isDrillDownFollowUp) {
        const entityType = targetFrameId ? 'frame' : (targetSessionId ? 'session' : 'entity');
        const entityId = targetFrameId ?? targetSessionId ?? 'target';

        if (isDrillDownWithCachedFrame || isDrillDownWithCachedSession) {
          emitter.log(`[DrillDown] Skipping hypothesis generation - ${entityType} ${entityId} already cached in EntityStore`);
        } else {
          emitter.log(`[DrillDown] Skipping hypothesis generation - explicit drill-down target ${entityType}:${entityId}`);
        }

        // Minimal targeted hypothesis keeps downstream context coherent without generic LLM guesses.
        if (targetFrameId || targetSessionId) {
          initialHypotheses = [{
            id: `drill_down_${entityType}_${entityId}`,
            description: `深入分析 ${entityType === 'frame' ? '帧' : '会话'} ${entityId} 的详细数据`,
            status: 'investigating',
            confidence: 0.8,
            relevantAgents: ['frame_agent'],
            supportingEvidence: [],
            contradictingEvidence: [],
            proposedBy: 'drill_down_resolver',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }];
        } else {
          initialHypotheses = [];
        }
      } else {
        // Normal hypothesis generation for initial queries or new entities
        initialHypotheses = await generateInitialHypotheses(
          query, intent, sessionContext, this.modelRouter, this.agentRegistry, emitter
        );
      }

      for (const hypothesis of initialHypotheses) {
        this.messageBus.updateHypothesis(hypothesis);
      }

      // 5. Enhanced drill-down resolution using EntityStore cache
      let drillDownResolved: DrillDownResolved | null = null;
      let effectiveIntervals = followUpResolution.focusIntervals;

      if (intent.followUpType === 'drill_down') {
        // Try cache-first resolution via drillDownResolver
        drillDownResolved = await resolveDrillDown(
          intent,
          followUpResolution,
          sessionContext,
          options.traceProcessorService,
          traceId
        );

        if (drillDownResolved && drillDownResolved.intervals.length > 0) {
          effectiveIntervals = drillDownResolved.intervals;
          // Record resolved drill-down targets with real timestamps (v2.0).
          this.recordFocusFromIntervals(
            drillDownResolved.intervals,
            'drill_down',
            'system',
            sessionContext,
            emitter
          );

          // Log resolution traces for observability
          for (const trace of drillDownResolved.traces) {
            emitter.log(`[DrillDownResolver] ${trace.entityType}:${trace.entityId} resolved via [${trace.used.join(' → ')}]${trace.enriched ? ' (enriched)' : ''}`);
          }

          emitter.emitUpdate('progress', {
            phase: 'follow_up_resolved',
            message: `已解析 ${drillDownResolved.intervals.length} 个目标区间`,
            resolutionTraces: drillDownResolved.traces,
          });
        }
      }

      // 5.25 Pre-routing decision: determine executor mode and expose first-turn plan.
      const followUpType = intent.followUpType;
      const isDrillDown = followUpResolution.isFollowUp &&
        followUpType === 'drill_down' &&
        effectiveIntervals &&
        effectiveIntervals.length > 0;

      let strategyMatchResult: StrategyMatchResult | null = null;
      let preferHypothesisLoop = false;
      const blockedStrategyIds = new Set(
        (effectiveOptions.blockedStrategyIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      );

      if (followUpType !== 'clarify' && followUpType !== 'compare' && followUpType !== 'extend' && !isDrillDown) {
        // Normal path: enhanced strategy matching with LLM semantic understanding.
        let traceContext = undefined;
        try {
          traceContext = await detectTraceContext(options.traceProcessorService, traceId);
        } catch (e: any) {
          emitter.log(`[StrategySelection] Failed to detect trace context: ${e.message}`);
        }

        strategyMatchResult = await this.strategyRegistry.matchEnhanced(query, intent, traceContext);
        if (
          strategyMatchResult.strategy &&
          blockedStrategyIds.has(strategyMatchResult.strategy.id)
        ) {
          const blockedId = strategyMatchResult.strategy.id;
          emitter.log(`[StrategySelection] Matched strategy "${blockedId}" is blocked by route options, falling back`);
          strategyMatchResult = {
            strategy: null,
            matchMethod: 'none',
            confidence: 0,
            shouldFallback: true,
            fallbackReason: `策略 ${blockedId} 已被当前入口禁用`,
          };
        }
        if (strategyMatchResult.strategy) {
          const forceStrategy = ['1', 'true', 'yes', 'on'].includes(
            String(process.env.SMARTPERFETTO_FORCE_STRATEGY || '').trim().toLowerCase()
          );
          // Domain-manifest policy decides whether strategy should keep deterministic path
          // even when user preference is hypothesis_experiment.
          preferHypothesisLoop = shouldPreferHypothesisLoop({
            strategyId: strategyMatchResult.strategy.id,
            forceStrategy,
            preferredLoopMode: traceAgentState.preferences?.defaultLoopMode,
          });
        }
      }

      const analysisPlanMode = this.determineAnalysisPlanMode(
        followUpType,
        strategyMatchResult,
        preferHypothesisLoop
      );
      const analysisPlan = this.buildAnalysisPlanPayload(
        analysisPlanMode,
        intent.primaryGoal,
        intent.aspects,
        strategyMatchResult
      );
      emitter.emitUpdate('progress', {
        phase: 'analysis_plan',
        message: '已确认分析计划：先收集证据，再定位根因',
        plan: analysisPlan,
      });

      // 5.5 Determine incremental analysis scope (v2.0)
      // Uses FocusStore to decide if full or incremental analysis is needed
      // Note: entityStore already declared above (line ~225), reuse it
      const previousFindings = sessionContext.getAllFindings();
      const previousState: PreviousAnalysisState | undefined = (previousFindings.length > 0 && entityStore)
        ? {
            findings: previousFindings,
            analyzedEntityIds: new Set(
              [
                ...entityStore.getAnalyzedFrameIds().map(id => `frame_${id}`),
                ...entityStore.getAnalyzedSessionIds().map(id => `session_${id}`),
              ]
            ),
            analyzedTimeRanges: [], // Could be tracked in future
            analyzedQuestions: new Set(),
          }
        : undefined;

      const incrementalScope: IncrementalScope = entityStore
        ? this.incrementalAnalyzer.determineScope(
            query,
            this.focusStore,
            entityStore,
            previousState
          )
        : { type: 'full', isExtension: false, reason: 'No entity store', relevantAgents: [], relevantSkills: [] };

      // Emit scope information for observability
      emitter.emitUpdate('incremental_scope', {
        scopeType: incrementalScope.type,
        entitiesCount: incrementalScope.entities?.length || 0,
        timeRangesCount: incrementalScope.timeRanges?.length || 0,
        isExtension: incrementalScope.isExtension,
        reason: incrementalScope.reason,
        relevantAgents: incrementalScope.relevantAgents,
      });

      emitter.log(`[IncrementalAnalysis] Scope: ${incrementalScope.type}, reason: ${incrementalScope.reason}`);

      // 6. Build execution context with follow-up resolution
      const executionCtx: ExecutionContext = {
        query,
        sessionId,
        traceId,
        intent,
        initialHypotheses,
        sharedContext,
        options: {
          ...effectiveOptions,
          // Pass resolved parameters from follow-up for skill invocation
          ...(followUpResolution.resolvedParams && {
            resolvedFollowUpParams: followUpResolution.resolvedParams,
          }),
          // Pass pre-built focus intervals for drill-down (may be from drillDownResolver)
          ...(effectiveIntervals && {
            prebuiltIntervals: effectiveIntervals,
          }),
        },
        sessionContext,
        incrementalScope,
        config: effectiveConfig,
      };
      if (strategyMatchResult?.strategy) {
        // Keep strategy hint for downstream task planning even when we route to hypothesis loop.
        executionCtx.options.suggestedStrategy = {
          id: strategyMatchResult.strategy.id,
          name: strategyMatchResult.strategy.name,
          confidence: strategyMatchResult.confidence,
          matchMethod: strategyMatchResult.matchMethod,
          reasoning: strategyMatchResult.reasoning,
        };
      }

      // 7. Select and run executor
      // Create session-scoped envelope registry to prevent duplicate data emission
      const emittedEnvelopeRegistry = createEmittedEnvelopeRegistry();

      const services: AnalysisServices = {
        modelRouter: this.modelRouter,
        messageBus: this.messageBus,
        circuitBreaker: this.circuitBreaker,
        emittedEnvelopeRegistry,
      };

      // Executor selection priority:
      // 1. Clarify executor for clarification follow-ups (read-only, no SQL)
      // 2. Comparison executor for compare follow-ups (multiple entities)
      // 3. Extend executor for extend follow-ups (analyze more entities)
      // 4. Direct drill-down executor for explicit drill-down follow-ups with focus intervals
      // 5. Strategy executor if a strategy matches the query
      // 6. Hypothesis executor as fallback for adaptive analysis
      let executor: AnalysisExecutor;

      if (followUpType === 'clarify') {
        // Clarify: read-only explanation, no SQL queries
        emitter.log('[Routing] Using ClarifyExecutor for clarification request');
        executor = new ClarifyExecutor(sessionContext, services);
      } else if (followUpType === 'compare') {
        // Compare: resolve multiple entities and produce comparison
        emitter.log('[Routing] Using ComparisonExecutor for comparison request');
        executor = new ComparisonExecutor(
          sessionContext,
          services,
          options.traceProcessorService,
          traceId
        );
      } else if (followUpType === 'extend') {
        // Extend: analyze unanalyzed candidate entities with focus-aware prioritization (v2.0)
        emitter.log('[Routing] Using ExtendExecutor for extend request');
        const extendExecutor = new ExtendExecutor(
          sessionContext,
          services,
          options.traceProcessorService,
          traceId
        );
        // Set FocusStore for focus-aware entity prioritization
        extendExecutor.setFocusStore(this.focusStore);
        executor = extendExecutor;
      } else if (isDrillDown) {
        // Direct drill-down: bypasses strategy pipeline, runs target skill directly
        // Update followUpResolution with resolved intervals
        const enhancedFollowUp: FollowUpResolution = {
          ...followUpResolution,
          focusIntervals: effectiveIntervals,
        };
        emitter.log(`[Routing] Using DirectDrillDownExecutor for ${effectiveIntervals!.length} interval(s)`);
        executor = new DirectDrillDownExecutor(enhancedFollowUp, services);
      } else if (strategyMatchResult?.strategy) {
        // Emit strategy selection event for observability
        emitter.emitUpdate('strategy_selected', {
          strategyId: strategyMatchResult.strategy.id,
          strategyName: strategyMatchResult.strategy.name,
          confidence: strategyMatchResult.confidence,
          reasoning: strategyMatchResult.reasoning || 'Keyword match',
          selectionMethod: strategyMatchResult.matchMethod === 'keyword' ? 'keyword' : 'llm',
        });

        if (preferHypothesisLoop) {
          emitter.emitUpdate('strategy_fallback', {
            reason: 'prefer_hypothesis_experiment_loop',
            candidatesEvaluated: this.strategyRegistry.getAll().length,
            topCandidateConfidence: strategyMatchResult.confidence,
            fallbackTo: 'hypothesis_driven',
          });

          emitter.log(`[Routing] Strategy matched (${strategyMatchResult.strategy.name}) but prefer hypothesis+exp loop; using HypothesisExecutor`);
          const hypothesisExecutor = new HypothesisExecutor(services, this.agentRegistry, this.strategyPlanner);
          hypothesisExecutor.setFocusStore(this.focusStore);
          executor = hypothesisExecutor;
        } else {
          emitter.log(`[Routing] Using StrategyExecutor: ${strategyMatchResult.strategy.name} (method: ${strategyMatchResult.matchMethod}, confidence: ${strategyMatchResult.confidence.toFixed(2)})`);
          executor = new StrategyExecutor(strategyMatchResult.strategy, services);
        }
      } else {
        // No strategy match - emit fallback event
        if (strategyMatchResult?.fallbackReason) {
          emitter.emitUpdate('strategy_fallback', {
            reason: strategyMatchResult.fallbackReason,
            candidatesEvaluated: this.strategyRegistry.getAll().length,
            topCandidateConfidence: strategyMatchResult.confidence,
            fallbackTo: 'hypothesis_driven',
          });
        }

        emitter.log(`[Routing] Using HypothesisExecutor (${strategyMatchResult?.fallbackReason || 'no strategy match'})`);
        const hypothesisExecutor = new HypothesisExecutor(services, this.agentRegistry, this.strategyPlanner);
        // Set FocusStore for focus-aware analysis planning (v2.0)
        hypothesisExecutor.setFocusStore(this.focusStore);
        executor = hypothesisExecutor;
      }

      const executorResult = await executor.execute(executionCtx, emitter);

      // 7.5 Handle intervention request if present (v2.0)
      if (executorResult.interventionRequest) {
        const ir = executorResult.interventionRequest;
        emitter.log(`[Orchestrator] Executor requested intervention: ${ir.type} - ${ir.reason}`);

        // Build options for intervention
        const focusOptions: InterventionOption[] = ir.possibleDirections.map(dir => ({
          id: `focus_${dir.id}`,
          label: dir.description,
          description: `置信度 ${(dir.confidence * 100).toFixed(0)}%`,
          action: 'focus',
          params: { directions: [dir.id] },
          recommended: false,
        }));

        // Build complete options list
        const options: InterventionOption[] = [
          {
            id: 'continue',
            label: '继续分析',
            description: '继续当前分析策略',
            action: 'continue',
            recommended: true,
          },
          ...focusOptions,
          {
            id: 'abort',
            label: '结束分析',
            description: '以当前结果结束',
            action: 'abort',
            recommended: false,
          },
        ];

        // Create intervention through controller (triggers SSE event)
        this.interventionController.createAgentIntervention(
          sessionId,
          ir.reason,
          options,
          {
            currentFindings: executorResult.findings,
            possibleDirections: ir.possibleDirections.map(dir => ({
              id: dir.id,
              description: dir.description,
              confidence: dir.confidence,
              requiredAgents: [],
            })),
            elapsedTimeMs: ir.elapsedTimeMs,
            confidence: ir.confidence,
            roundsCompleted: ir.roundsCompleted,
            progressSummary: ir.progressSummary,
          }
        );

        // Note: Analysis continues (non-blocking intervention).
        // User can respond via /api/agent/:sessionId/intervene endpoint.
        // The response will be handled in the next analysis turn.
      }

      // 8. Apply captured entities to EntityStore (single write-back point)
      if (executorResult.capturedEntities) {
        applyCapturedEntities(sessionContext.getEntityStore(), executorResult.capturedEntities);
        emitter.log(`[EntityStore] Applied ${executorResult.capturedEntities.frames.length} frames, ${executorResult.capturedEntities.sessions.length} sessions`);
      }

      // Mark analyzed entity IDs
      if (executorResult.analyzedEntityIds) {
        const store = sessionContext.getEntityStore();
        for (const frameId of executorResult.analyzedEntityIds.frames || []) {
          store.markFrameAnalyzed(frameId);
        }
        for (const sessionId of executorResult.analyzedEntityIds.sessions || []) {
          store.markSessionAnalyzed(sessionId);
        }
      }

      // 8.25 Refresh deterministic coverage snapshot for planning & conclusions (v1 scaffold).
      // Uses EntityStore analyzed IDs + evidence provenance to build "what we covered" context.
      sessionContext.refreshTraceAgentCoverage();

      // 8.5 Merge findings with previous analysis (v2.0 incremental analysis)
      // If this is an incremental turn, merge new findings with existing ones
      let mergedFindings = executorResult.findings;
      const shouldMergeHistoricalFindings =
        incrementalScope.isExtension &&
        previousFindings.length > 0 &&
        followUpType !== 'drill_down';

      if (shouldMergeHistoricalFindings) {
        mergedFindings = this.incrementalAnalyzer.mergeFindings(
          previousFindings,
          executorResult.findings
        );
        emitter.log(`[IncrementalAnalysis] Merged ${executorResult.findings.length} new findings with ${previousFindings.length} previous → ${mergedFindings.length} total`);
      } else if (incrementalScope.isExtension && previousFindings.length > 0 && followUpType === 'drill_down') {
        emitter.log('[IncrementalAnalysis] Drill-down turn keeps findings scope-local; skipped historical merge');
      }

      // 9. Generate conclusion
      emitter.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
      // Dynamic history budget: more findings → more tokens needed for evidence in the
      // conclusion prompt → less room for history context. Thresholds tuned empirically:
      // ≤12 findings (~typical): 600 tokens history, >12: 500, >24 (large trace): 380.
      const conclusionHistoryBudget = mergedFindings.length > 24
        ? 380
        : mergedFindings.length > 12
          ? 500
          : 600;
      const conclusion = await generateConclusion(
        sharedContext, mergedFindings, intent,
        this.modelRouter, emitter, executorResult.stopReason || undefined, {
          turnCount,
          // Always provide compact context so conclusion can cite current-turn evidence digests too.
          // (Turn 1 has no turns yet, but TraceAgentState evidence/experiments already exist.)
          historyContext: sessionContext.generatePromptContext(conclusionHistoryBudget),
        }
      );
      const singleFrameRefs = (intent.referencedEntities || [])
        .filter((entity: any) => entity?.type === 'frame').length;
      const isSingleFrameDrillDown =
        intent.followUpType === 'drill_down' &&
        (
          singleFrameRefs === 1 ||
          intent.extractedParams?.frame_id !== undefined ||
          intent.extractedParams?.frameId !== undefined
        );
      const conclusionContract = deriveConclusionContract(conclusion, {
        mode: turnCount >= 1 ? 'focused_answer' : 'initial_report',
        singleFrameDrillDown: isSingleFrameDrillDown,
      }) || undefined;
      if (!conclusionContract) {
        console.warn(
          `[Orchestrator] deriveConclusionContract returned null for session ${sessionId}. ` +
          `Conclusion preview: "${conclusion.slice(0, 200)}..."`
        );
      }

      emitter.emitUpdate('conclusion', {
        sessionId,
        summary: conclusion,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
      });

      // 10. Build result
      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings: mergedFindings,
        hypotheses: Array.from(sharedContext.hypotheses.values()),
        conclusion,
        conclusionContract,
        confidence: executorResult.confidence,
        rounds: executorResult.rounds,
        totalDurationMs: Date.now() - startTime,
      };

      // 11. Record this turn in session context for future follow-ups
      // Note: Only record the new findings from this turn, not merged ones
      const recordedTurn = sessionContext.addTurn(query, intent, {
        success: result.success,
        findings: executorResult.findings, // New findings only for this turn
        confidence: result.confidence,
        message: conclusion,
      }, executorResult.findings);

      // v2.0: Update semantic working memory from the final conclusion for better multi-turn coherence.
      sessionContext.updateWorkingMemoryFromConclusion({
        turnIndex: recordedTurn.turnIndex,
        query,
        conclusion,
        confidence: result.confidence,
      });

      // v1: Record TraceAgentState audit entry for this turn (goal-driven agent scaffold).
      sessionContext.recordTraceAgentTurn({
        turnId: recordedTurn.id,
        turnIndex: recordedTurn.turnIndex,
        query,
        followUpType: intent.followUpType,
        intentPrimaryGoal: intent.primaryGoal,
        conclusion,
        confidence: result.confidence,
      });

      // Emit a compact state summary after saving updates (frontend can ignore if unsupported).
      const updatedState = sessionContext.getTraceAgentState();
      if (updatedState) {
        emitter.emitUpdate('progress', {
          phase: 'agent_state_saved',
          message: '更新 Agent 状态（本轮审计）',
          state: summarizeTraceAgentState(updatedState),
        });
      }

      // 12. Update FocusStore with user interaction patterns
      this.updateFocusStore(query, intent, result, emitter);

      emitter.log(`Analysis complete: ${executorResult.findings.length} new findings (${mergedFindings.length} total), ${executorResult.rounds} rounds (turn ${turnCount + 1})`);
      return result;

    } catch (error: any) {
      emitter.log(`Analysis failed: ${error.message}`);
      emitter.emitUpdate('error', { message: error.message });

      // Record failed turn for context continuity
      sessionContext.addTurn(query, {
        primaryGoal: query,
        aspects: ['general'],
        expectedOutputType: 'diagnosis',
        complexity: 'moderate',
        followUpType: 'initial',
      }, undefined);

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `分析失败: ${error.message}`,
        confidence: 0,
        rounds: 0,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  private determineAnalysisPlanMode(
    followUpType: string | undefined,
    strategyMatchResult: StrategyMatchResult | null,
    preferHypothesisLoop: boolean
  ): AnalysisPlanMode {
    if (followUpType === 'clarify') return 'clarify';
    if (followUpType === 'compare') return 'compare';
    if (followUpType === 'extend') return 'extend';
    if (followUpType === 'drill_down') return 'drill_down';
    if (strategyMatchResult?.strategy && !preferHypothesisLoop) return 'strategy';
    return 'hypothesis';
  }

  private buildAnalysisPlanPayload(
    mode: AnalysisPlanMode,
    objective: string,
    aspects: string[],
    strategyMatchResult: StrategyMatchResult | null
  ): AnalysisPlanPayload {
    const plan: AnalysisPlanPayload = {
      mode,
      objective,
      steps: this.buildAnalysisPlanSteps(mode),
      evidence: this.buildEvidenceChecklist(aspects, mode),
      hypothesisPolicy: 'after_first_evidence',
    };

    if (mode === 'strategy' && strategyMatchResult?.strategy) {
      plan.strategy = {
        id: strategyMatchResult.strategy.id,
        name: strategyMatchResult.strategy.name,
        confidence: strategyMatchResult.confidence,
        selectionMethod: strategyMatchResult.matchMethod,
      };
    }

    return plan;
  }

  private buildAnalysisPlanSteps(mode: AnalysisPlanMode): AnalysisPlanStep[] {
    const byMode: Record<AnalysisPlanMode, AnalysisPlanStep[]> = {
      strategy: [
        { order: 1, title: '基线采集', action: '按匹配策略先收集全局概览指标与异常分布' },
        { order: 2, title: '区间定位', action: '定位关键时间窗或目标实体并缩小范围' },
        { order: 3, title: '深度验证', action: '对关键区间执行逐层验证后输出结论' },
      ],
      hypothesis: [
        { order: 1, title: '证据采集', action: '先采集最小必要证据，建立性能基线' },
        { order: 2, title: '形成假设', action: '基于首轮证据形成待验证假设，不做先验猜测' },
        { order: 3, title: '验证收敛', action: '按信息增益执行实验并收敛到可解释根因' },
      ],
      clarify: [
        { order: 1, title: '证据回放', action: '回放并归纳已有 findings/evidence 事实' },
        { order: 2, title: '概念澄清', action: '解释术语、分类标准与判定依据' },
        { order: 3, title: '结论对齐', action: '给出可追溯的解释结论与下一步建议' },
      ],
      compare: [
        { order: 1, title: '口径对齐', action: '统一时间窗、刷新率与统计口径' },
        { order: 2, title: '差异量化', action: '量化对象间关键指标差异与显著性' },
        { order: 3, title: '归因验证', action: '对主要差异进行证据归因与可信度标注' },
      ],
      extend: [
        { order: 1, title: '扩展范围', action: '在未覆盖实体/区间中扩展同类问题检索' },
        { order: 2, title: '模式归纳', action: '识别重复模式并补齐关键证据缺口' },
        { order: 3, title: '风险评估', action: '输出扩展后的影响面与优先级建议' },
      ],
      drill_down: [
        { order: 1, title: '锁定目标', action: '锁定指定实体或时间区间并确认边界' },
        { order: 2, title: '细粒度分析', action: '在目标范围内执行逐层细粒度证据采集' },
        { order: 3, title: '根因解释', action: '输出目标问题的直接证据链与根因解释' },
      ],
    };

    return byMode[mode];
  }

  private buildEvidenceChecklist(aspects: string[], mode: AnalysisPlanMode): string[] {
    const evidences = new Set<string>();
    const normalizedAspects = Array.isArray(aspects)
      ? aspects.map(a => String(a || '').toLowerCase())
      : [];

    for (const evidence of getAspectEvidenceChecklist(normalizedAspects, DEFAULT_DOMAIN_MANIFEST)) {
      evidences.add(evidence);
    }

    // Baseline evidence always comes first.
    evidences.add(DEFAULT_DOMAIN_MANIFEST.baselineEvidence);

    for (const evidence of getModeSpecificEvidenceChecklist(mode, DEFAULT_DOMAIN_MANIFEST)) {
      evidences.add(evidence);
    }

    if (evidences.size === 1) {
      for (const evidence of DEFAULT_DOMAIN_MANIFEST.fallbackEvidence) {
        evidences.add(evidence);
      }
    }

    return Array.from(evidences);
  }

  // ==========================================================================
  // Infrastructure
  // ==========================================================================

  private createProgressEmitter(): ProgressEmitter {
    return {
      emitUpdate: (type, content) => {
        const update: StreamingUpdate = { type, content, timestamp: Date.now() };
        this.emit('update', update);
        if (this.config.streamingCallback) {
          this.config.streamingCallback(update);
        }
      },
      log: (message) => {
        if (this.config.enableLogging) {
          console.log(`[AgentDrivenOrchestrator] ${message}`);
        }
      },
    };
  }

  private setupEventForwarding(): void {
    this.messageBus.on('task_dispatched', (data) => {
      this.emitRaw('progress', { phase: 'task_dispatched', ...data });
    });
    this.messageBus.on('task_completed', (data) => {
      this.emitRaw('progress', { phase: 'task_completed', ...data });
    });
    this.messageBus.on('agent_question', (question) => {
      this.emitRaw('progress', { phase: 'agent_question', ...question });
    });
    this.messageBus.on('broadcast', (message) => {
      this.emitRaw('progress', { phase: 'broadcast', ...message });
    });
  }

  private emitRaw(type: StreamingUpdate['type'], content: any): void {
    const update: StreamingUpdate = { type, content, timestamp: Date.now() };
    this.emit('update', update);
    if (this.config.streamingCallback) {
      this.config.streamingCallback(update);
    }
  }

  reset(): void {
    this.messageBus.reset();
    this.circuitBreaker.reset();
    // Note: InterventionController is session-scoped, no global clear needed
    this.focusStore.clear();
  }

  // ==========================================================================
  // New Agent-Driven Architecture Methods (v2.0)
  // ==========================================================================

  /**
   * Set up intervention event forwarding to SSE stream.
   * This enables the frontend to display intervention panels when needed.
   */
  private setupInterventionEventForwarding(): void {
    this.interventionController.on('intervention_required', (intervention: InterventionPoint) => {
      this.emitRaw('intervention_required', {
        interventionId: intervention.id,
        type: intervention.type,
        options: intervention.options.map(opt => ({
          id: opt.id,
          label: opt.label,
          description: opt.description,
          action: opt.action,
          recommended: opt.recommended,
        })),
        context: {
          confidence: intervention.context.confidence,
          elapsedTimeMs: intervention.context.elapsedTimeMs,
          roundsCompleted: intervention.context.roundsCompleted || 0,
          progressSummary: intervention.context.progressSummary || '',
          triggerReason: intervention.context.triggerReason || '',
          findingsCount: intervention.context.currentFindings?.length || 0,
        },
        timeout: intervention.timeout || 60000,
      });
    });

    this.interventionController.on('intervention_resolved', (data: any) => {
      this.emitRaw('intervention_resolved', {
        interventionId: data.interventionId,
        action: data.action,
        sessionId: data.sessionId,
        directive: data.directive,
      });
    });

    this.interventionController.on('intervention_timeout', (data: any) => {
      this.emitRaw('intervention_timeout', {
        interventionId: data.interventionId,
        sessionId: data.sessionId,
        defaultAction: data.defaultAction,
        timeoutMs: data.timeoutMs,
      });
    });
  }

  /**
   * Update FocusStore based on query intent and analysis results.
   * This enables incremental analysis for follow-up queries.
   */
  private updateFocusStore(
    query: string,
    intent: any,
    result: AnalysisResult,
    emitter: ProgressEmitter
  ): void {
    // Extract entity focuses from findings
    for (const finding of result.findings) {
      // Check for process references in description or title
      const processMatch = finding.description?.match(/process:\s*([^\s,]+)/i) ||
                          finding.title?.match(/process:\s*([^\s,]+)/i);
      if (processMatch) {
        const processName = processMatch[1];
        this.focusStore.recordInteraction({
          type: 'explicit',
          target: { entityType: 'process', entityId: processName },
          source: 'agent',
          timestamp: Date.now(),
        });
      }

      // Check for thread references in description or title
      const threadMatch = finding.description?.match(/thread:\s*([^\s,]+)/i) ||
                         finding.title?.match(/thread:\s*([^\s,]+)/i);
      if (threadMatch) {
        const threadName = threadMatch[1];
        this.focusStore.recordInteraction({
          type: 'explicit',
          target: { entityType: 'thread', entityId: threadName },
          source: 'agent',
          timestamp: Date.now(),
        });
      }

      // Check for frame references in evidence or related data
      const frameMatch = finding.description?.match(/frame[_\s]?id:\s*(\d+)/i);
      if (frameMatch) {
        this.focusStore.recordInteraction({
          type: 'explicit',
          target: { entityType: 'frame', entityId: frameMatch[1] },
          source: 'agent',
          timestamp: Date.now(),
        });
      }

      // Check for time range references in timestamps
      if (finding.timestampsNs && finding.timestampsNs.length >= 2) {
        const sortedTs = [...finding.timestampsNs].sort((a, b) => a - b);
        this.focusStore.recordInteraction({
          type: 'explicit',
          target: {
            timeRange: {
              start: BigInt(sortedTs[0]),
              end: BigInt(sortedTs[sortedTs.length - 1]),
            },
          },
          source: 'agent',
          timestamp: Date.now(),
        });
      }
    }

    // Emit focus update event for observability
    const topFocuses = this.focusStore.getTopFocuses(3);
    if (topFocuses.length > 0) {
      const focus = topFocuses[0];

      // Convert target for SSE (bigint → string for JSON serialization)
      const target: {
        entityType?: string;
        entityId?: string;
        timeRange?: { start: string; end: string };
        metricName?: string;
        question?: string;
      } = {
        entityType: focus.target.entityType,
        entityId: focus.target.entityId,
        metricName: focus.target.metricName,
        question: focus.target.question,
      };

      if (focus.target.timeRange) {
        target.timeRange = {
          start: String(focus.target.timeRange.start),
          end: String(focus.target.timeRange.end),
        };
      }

      emitter.emitUpdate('focus_updated', {
        focusType: focus.type,
        target,
        weight: focus.weight,
        interactionType: 'analysis_complete',
      });
    }
  }

  /**
   * Get the FocusStore for external access (e.g., route handlers for user interaction events).
   */
  getFocusStore(): FocusStore {
    return this.focusStore;
  }

  /**
   * Get the InterventionController for external access (e.g., route handlers for user responses).
   */
  getInterventionController(): InterventionController {
    return this.interventionController;
  }

  /**
   * Record a user interaction from the frontend (e.g., clicking a timestamp in the table).
   * This updates the FocusStore for incremental analysis.
   */
  recordUserInteraction(interaction: FocusInteraction): void {
    this.focusStore.recordInteraction(interaction);
    const focusType =
      interaction.target.entityType && interaction.target.entityId ? 'entity'
      : interaction.target.timeRange ? 'timeRange'
      : interaction.target.metricName ? 'metric'
      : interaction.target.question ? 'question'
      : 'question';
    this.emitRaw('focus_updated', {
      focusType,
      target: interaction.target,
      weight: 0.5, // Initial weight
      interactionType: interaction.source,
    });
  }

  // ==========================================================================
  // Focus capture helpers (v2.0)
  // ==========================================================================

  private recordInputFocus(
    query: string,
    intent: any,
    followUpResolution: FollowUpResolution,
    sessionContext: EnhancedSessionContext,
    emitter: ProgressEmitter
  ): void {
    // Always record current query as a question focus so "what user asked now"
    // can dominate incremental scope decisions.
    this.focusStore.recordInteraction({
      type: 'query',
      target: { question: query, questionCategory: intent?.followUpType || undefined },
      source: 'query',
      timestamp: Date.now(),
    });

    // If follow-up resolution produced explicit focus intervals, record them.
    if (followUpResolution.focusIntervals && followUpResolution.focusIntervals.length > 0) {
      const interactionType: FocusInteraction['type'] =
        intent?.followUpType === 'compare' ? 'compare'
        : intent?.followUpType === 'extend' ? 'extend'
        : intent?.followUpType === 'drill_down' ? 'drill_down'
        : 'query';

      this.recordFocusFromIntervals(
        followUpResolution.focusIntervals,
        interactionType,
        'query',
        sessionContext,
        emitter
      );
      return;
    }

    // Fallback: record referenced entities even when timestamps are missing.
    for (const entity of intent?.referencedEntities || []) {
      if (entity.type !== 'frame' && entity.type !== 'session') continue;
      const entityId = entity.value !== undefined ? entity.value : entity.id;
      if (entityId === undefined || entityId === null) continue;
      this.focusStore.recordInteraction({
        type: intent?.followUpType === 'compare' ? 'compare' : 'drill_down',
        target: {
          entityType: entity.type,
          entityId: String(entityId),
        },
        source: 'query',
        timestamp: Date.now(),
      });
    }

    // Fallback: record time range when present in resolved params.
    const startTs = followUpResolution.resolvedParams?.start_ts ?? followUpResolution.resolvedParams?.startTs;
    const endTs = followUpResolution.resolvedParams?.end_ts ?? followUpResolution.resolvedParams?.endTs;
    if (startTs && endTs) {
      this.focusStore.recordInteraction({
        type: 'query',
        target: { timeRange: { start: String(startTs), end: String(endTs) } },
        source: 'query',
        timestamp: Date.now(),
      });
    }

    // Keep focuses consistent with cached entities.
    this.focusStore.syncWithEntityStore(sessionContext.getEntityStore());
  }

  private recordFocusFromIntervals(
    intervals: FocusInterval[],
    interactionType: FocusInteraction['type'],
    source: FocusInteraction['source'],
    sessionContext: EnhancedSessionContext,
    emitter: ProgressEmitter
  ): void {
    for (const interval of intervals) {
      const meta = interval.metadata || {};
      const sourceEntityType = meta.sourceEntityType;
      const sourceEntityId =
        meta.sourceEntityId ??
        meta.frame_id ?? meta.frameId ??
        meta.session_id ?? meta.sessionId;

      if ((sourceEntityType === 'frame' || sourceEntityType === 'session') && sourceEntityId !== undefined) {
        this.focusStore.recordInteraction({
          type: interactionType,
          target: {
            entityType: sourceEntityType,
            entityId: String(sourceEntityId),
            entityName: interval.processName || undefined,
          },
          source,
          timestamp: Date.now(),
          context: { label: interval.label },
        });
      }

      if (interval.startTs && interval.endTs && interval.startTs !== '0' && interval.endTs !== '0') {
        this.focusStore.recordInteraction({
          type: interactionType,
          target: { timeRange: { start: interval.startTs, end: interval.endTs } },
          source,
          timestamp: Date.now(),
          context: { label: interval.label },
        });
      }
    }

    // Keep focuses consistent with cached entities.
    this.focusStore.syncWithEntityStore(sessionContext.getEntityStore());

    // Emit a lightweight debug log for observability.
    const primary = this.focusStore.getPrimaryFocus();
    if (primary) {
      emitter.log(`[FocusStore] Primary focus: ${primary.type} (${primary.id}) w=${primary.weight.toFixed(2)}`);
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAgentDrivenOrchestrator(
  modelRouter: ModelRouter,
  config?: Partial<AgentDrivenOrchestratorConfig>
): AgentDrivenOrchestrator {
  return new AgentDrivenOrchestrator(modelRouter, config);
}

// Re-export types for backward compatibility
export type { AgentDrivenOrchestratorConfig, AnalysisResult } from './orchestratorTypes';

export default AgentDrivenOrchestrator;
