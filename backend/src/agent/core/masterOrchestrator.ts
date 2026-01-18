/**
 * SmartPerfetto Master Orchestrator
 *
 * 主编排者，负责：
 * 1. 协调整个分析流程
 * 2. 管理状态机和检查点
 * 3. 控制断路器和迭代
 * 4. 整合所有 SubAgent 的结果
 * 5. 生命周期钩子支持
 */

import { EventEmitter } from 'events';
import {
  MasterOrchestratorConfig,
  MasterOrchestratorResult,
  SubAgentContext,
  SubAgentResult,
  Intent,
  AnalysisPlan,
  Evaluation,
  StageResult,
  Finding,
  StreamingUpdate,
  ModelUsageSummary,
  PipelineStage,
  CircuitDecision,
} from '../types';
import { AgentStateMachine } from './stateMachine';
import { CircuitBreaker } from './circuitBreaker';
import { ModelRouter } from './modelRouter';
import { PipelineExecutor, StageExecutor } from './pipelineExecutor';
import { CheckpointManager } from '../state/checkpointManager';
import { SessionStore } from '../state/sessionStore';
import { PlannerAgent } from '../agents/plannerAgent';
import { EvaluatorAgent } from '../agents/evaluatorAgent';
import { AnalysisWorker } from '../agents/workers/analysisWorker';
import {
  HookRegistry,
  getHookRegistry,
  HookContext,
  createHookContext,
  SessionEventData,
} from '../hooks';
import {
  ContextCompactor,
  getContextCompactor,
} from '../compaction';
import {
  ForkManager,
  createForkManager,
  ForkOptions,
  ForkResult,
  MergeOptions,
  MergeResult,
  ComparisonResult,
  SessionNode,
  SessionNodeSummary,
} from '../fork';
import {
  ArchitectureDetector,
  createArchitectureDetector,
  ArchitectureInfo,
} from '../detectors';
import {
  expertRegistry,
  initializeExperts,
  parseAnalysisIntent,
  getExpertForIntent,
  BaseExpertInterface,
  ExpertInput,
  ExpertOutput,
  AnalysisIntent,
} from '../experts';
import {
  EnhancedSessionContext,
  sessionContextManager,
} from '../context/enhancedSessionContext';
import {
  agentConfig,
  circuitBreakerConfig as cbConfig,
  pipelineConfig as pipeConfig,
  modelRouterConfig as mrConfig,
} from '../../config';

// 默认配置 (从统一配置文件获取)
const DEFAULT_CONFIG: Partial<MasterOrchestratorConfig> = {
  maxTotalIterations: agentConfig.maxTotalIterations,
  enableTraceRecording: agentConfig.enableTraceRecording,
  evaluationCriteria: {
    minQualityScore: agentConfig.evaluation.minQualityScore,
    minCompletenessScore: agentConfig.evaluation.minCompletenessScore,
    maxContradictions: agentConfig.evaluation.maxContradictions,
    requiredAspects: [],
  },
};

/**
 * 主编排者实现
 */
export class MasterOrchestrator extends EventEmitter {
  private config: MasterOrchestratorConfig;
  private stateMachine!: AgentStateMachine;
  private circuitBreaker: CircuitBreaker;
  private modelRouter: ModelRouter;
  private pipelineExecutor: PipelineExecutor;
  private checkpointManager: CheckpointManager;
  private sessionStore: SessionStore;
  private hookRegistry: HookRegistry;
  private hookContext: HookContext | null = null;
  private contextCompactor: ContextCompactor;
  private forkManager: ForkManager;
  private architectureDetector: ArchitectureDetector;

  // SubAgents
  private plannerAgent: PlannerAgent;
  private evaluatorAgent: EvaluatorAgent;
  private analysisWorker: AnalysisWorker;
  private workerAgents: Map<string, StageExecutor>;

  // 执行状态
  private currentSessionId: string | null = null;
  private totalIterations: number = 0;
  private emittedFindingIds: Set<string> = new Set();  // 已发送的 Finding IDs，防止重复
  private emittedDiagnosticHashes: Set<string> = new Set();  // 内容哈希去重 diagnostics
  private currentArchitecture: ArchitectureInfo | null = null;  // 当前检测到的渲染架构
  private expertModeEnabled: boolean = false;  // 是否启用专家模式（Phase 3）
  private sessionContext: EnhancedSessionContext | null = null;  // 多轮对话上下文（Phase 5）

  constructor(config: Partial<MasterOrchestratorConfig> = {}) {
    super();

    // 合并配置 (使用统一配置文件的默认值)
    this.config = {
      ...DEFAULT_CONFIG,
      stateMachineConfig: config.stateMachineConfig || { sessionId: '', traceId: '' },
      circuitBreakerConfig: config.circuitBreakerConfig || {
        maxRetriesPerAgent: cbConfig.maxRetriesPerAgent,
        maxIterationsPerStage: cbConfig.maxIterationsPerStage,
        cooldownMs: cbConfig.cooldownMs,
        halfOpenAttempts: cbConfig.halfOpenAttempts,
        failureThreshold: cbConfig.failureThreshold,
        successThreshold: cbConfig.successThreshold,
      },
      // Don't pass empty models array - let ModelRouter use its DEFAULT_MODELS
      modelRouterConfig: config.modelRouterConfig || {
        defaultModel: mrConfig.defaultModel,
        taskModelMapping: {},
        fallbackChain: mrConfig.fallbackChain,
        enableEnsemble: mrConfig.enableEnsemble,
        ensembleThreshold: mrConfig.ensembleThreshold,
      },
      pipelineConfig: config.pipelineConfig || {
        stages: [],
        maxTotalDuration: pipeConfig.maxTotalDurationMs,
        enableParallelization: pipeConfig.enableParallelization,
      },
      evaluationCriteria: { ...DEFAULT_CONFIG.evaluationCriteria!, ...config.evaluationCriteria },
      maxTotalIterations: config.maxTotalIterations || DEFAULT_CONFIG.maxTotalIterations!,
      enableTraceRecording: config.enableTraceRecording ?? agentConfig.enableTraceRecording,
      streamingCallback: config.streamingCallback,
    } as MasterOrchestratorConfig;

    // 初始化核心组件
    this.hookRegistry = getHookRegistry();
    this.contextCompactor = getContextCompactor();
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreakerConfig);
    this.modelRouter = new ModelRouter(this.config.modelRouterConfig);
    this.pipelineExecutor = new PipelineExecutor(this.config.pipelineConfig, this.hookRegistry);
    this.checkpointManager = new CheckpointManager();
    this.sessionStore = new SessionStore();
    this.forkManager = createForkManager(this.checkpointManager, {
      enabled: false,  // 默认禁用，向后兼容
    });
    this.architectureDetector = createArchitectureDetector();

    // 初始化 SubAgents
    this.plannerAgent = new PlannerAgent(this.modelRouter);
    this.evaluatorAgent = new EvaluatorAgent(
      this.modelRouter,
      undefined,
      this.config.evaluationCriteria
    );
    this.analysisWorker = new AnalysisWorker(this.modelRouter);
    this.workerAgents = new Map();

    // 注册阶段执行器
    this.registerDefaultExecutors();

    // 初始化专家系统 (Phase 3)
    this.initializeExpertSystem();

    // 设置事件监听
    this.setupEventListeners();
  }

  /**
   * 初始化专家系统
   */
  private initializeExpertSystem(): void {
    try {
      initializeExperts();
      console.log(`[MasterOrchestrator] Expert system initialized, supported intents: ${expertRegistry.getSupportedIntents().join(', ')}`);
    } catch (error: any) {
      console.warn(`[MasterOrchestrator] Failed to initialize expert system: ${error.message}`);
    }
  }

  // ==========================================================================
  // 核心执行方法
  // ==========================================================================

  /**
   * 处理用户查询
   */
  async handleQuery(
    query: string,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<MasterOrchestratorResult> {
    const startTime = Date.now();

    try {
      // 1. 创建会话
      const session = await this.sessionStore.createSession(traceId, query);
      this.currentSessionId = session.sessionId;
      this.emittedFindingIds.clear();  // 重置已发送的 Finding IDs
      this.emittedDiagnosticHashes.clear();  // 重置内容哈希
      this.totalIterations = 0;  // 重置迭代计数

      // 初始化多轮对话上下文（Phase 5）
      this.sessionContext = sessionContextManager.getOrCreate(session.sessionId, traceId);

      // 初始化会话树（用于 Fork）
      if (this.forkManager.isEnabled()) {
        this.forkManager.initializeSession(session.sessionId, 'main');
      }

      // 初始化 hook context
      this.hookContext = createHookContext(session.sessionId, traceId, 'session');

      // === Session Start Hook ===
      const sessionEventData: SessionEventData = {
        query,
        traceId,
      };
      const preResult = await this.hookRegistry.executePre(
        'session:start',
        session.sessionId,
        sessionEventData,
        this.hookContext
      );
      if (!preResult.continue) {
        throw new Error('Session start blocked by hook');
      }

      // 重置 AnalysisWorker 的会话状态（用于 skill_data 去重）
      this.analysisWorker.resetForNewSession(session.sessionId);

      // 2. 初始化状态机
      this.stateMachine = AgentStateMachine.create(session.sessionId, traceId);
      this.stateMachine.transition({ type: 'START_ANALYSIS' });

      this.emitUpdate('progress', { phase: 'starting', message: '开始分析' });

      // 2.5 检测渲染架构 (Phase 1 新增)
      this.currentArchitecture = null;
      if (options.traceProcessorService) {
        try {
          this.emitUpdate('progress', { phase: 'detecting_architecture', message: '检测渲染架构' });
          this.currentArchitecture = await this.architectureDetector.detect({
            traceId,
            traceProcessorService: options.traceProcessorService,
          });
          console.log(`[MasterOrchestrator] Detected architecture: ${this.currentArchitecture.type} (${(this.currentArchitecture.confidence * 100).toFixed(1)}%)`);
          this.emitUpdate('architecture_detected', {
            type: this.currentArchitecture.type,
            confidence: this.currentArchitecture.confidence,
            flutter: this.currentArchitecture.flutter,
            webview: this.currentArchitecture.webview,
            compose: this.currentArchitecture.compose,
          });
        } catch (error: any) {
          console.warn(`[MasterOrchestrator] Architecture detection failed:`, error.message);
          // 继续执行，不阻塞分析流程
        }
      }

      // 3. 理解意图
      const intent = await this.understandIntent(query, traceId, options);
      await this.sessionStore.updateIntent(session.sessionId, intent);
      this.stateMachine.transition({ type: 'INTENT_UNDERSTOOD', payload: { intent } });

      // 记录对话轮次（Phase 5: Multi-turn Dialogue）
      const currentTurn = this.sessionContext?.addTurn(query, intent);

      this.emitUpdate('progress', { phase: 'planning', message: '规划分析任务' });

      // 4. 创建计划
      const plan = await this.createPlan(intent, traceId, options);
      await this.sessionStore.updatePlan(session.sessionId, plan);
      this.stateMachine.transition({ type: 'PLAN_CREATED', payload: { plan } });

      // 5. 执行分析循环
      let evaluation: Evaluation | null = null;
      let stageResults: StageResult[] = [];

      while (this.totalIterations < this.config.maxTotalIterations) {
        this.totalIterations++;

        // emit iteration_state 事件：通知前端当前迭代状态
        this.emitUpdate('iteration_state' as any, {
          current: this.totalIterations,
          max: this.config.maxTotalIterations,
          phase: 'execute',
          previousScore: evaluation?.qualityScore,
        });

        // 检查断路器
        const circuitCheck = this.circuitBreaker.canExecute();
        if (circuitCheck.action === 'ask_user') {
          return this.createAwaitingUserResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            circuitCheck.reason!,
            startTime
          );
        }

        // 如果当前是 refining 状态，需要先转换到 executing
        if (this.stateMachine.phase === 'refining') {
          this.stateMachine.transition({
            type: 'NEEDS_REFINEMENT',
            payload: { iteration: this.totalIterations },
          });
        }

        // 执行流水线
        this.emitUpdate('progress', {
          phase: 'executing',
          iteration: this.totalIterations,
          message: `执行分析 (迭代 ${this.totalIterations})`,
        });

        const context = await this.buildContext(session.sessionId, traceId, intent, plan, stageResults, options);
        const pipelineResult = await this.pipelineExecutor.execute(context, {
          onStageStart: (stage) => {
            this.emitUpdate('progress', { phase: 'stage', stage: stage.id, message: stage.name });
          },
          onStageComplete: (stage, result) => {
            this.handleStageComplete(session.sessionId, stage, result);
          },
          onError: async (stage, error) => {
            return this.handleStageError(stage, error);
          },
          onProgress: (progress) => {
            // Format progress as human-readable message
            const message = `执行阶段 ${progress.currentStage} (${progress.completedStages}/${progress.totalStages})`;
            this.emitUpdate('progress', {
              phase: 'stage_progress',
              message,
              ...progress,  // Include raw data for advanced UI usage
            });
          },
        });

        stageResults = pipelineResult.stageResults;

        // 检查是否暂停
        if (pipelineResult.pausedAt) {
          return this.createPausedResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            pipelineResult.pausedAt,
            startTime
          );
        }

        // 转换到评估阶段 (executing -> evaluating)
        this.stateMachine.transition({
          type: 'STAGE_COMPLETED',
          payload: { stageResults },
        });

        // 评估结果
        this.emitUpdate('progress', { phase: 'evaluating', message: '评估分析结果' });
        evaluation = await this.evaluateResults(stageResults, intent);

        this.stateMachine.transition({
          type: 'EVALUATION_COMPLETE',
          payload: { evaluation, passed: evaluation.passed },
        });

        // First iteration optimization: Skills produce deterministic high-quality results
        // If skills executed successfully with data, pass on first iteration
        const hasSuccessfulSkillData = stageResults.some(r =>
          r.success && r.data && Object.keys(r.data).length > 0
        );
        if (this.totalIterations === 1 && hasSuccessfulSkillData) {
          console.log('[MasterOrchestrator] First iteration with successful skill data - auto-passing');
          evaluation.passed = true;
        }

        // 检查是否通过
        if (evaluation.passed) {
          break;
        }

        // 检查迭代次数
        const iterationDecision = this.circuitBreaker.recordIteration('main');
        if (iterationDecision.action === 'ask_user') {
          return this.createAwaitingUserResult(
            session.sessionId,
            intent,
            plan,
            stageResults,
            iterationDecision.reason!,
            startTime
          );
        }

        // 继续迭代
        this.emitUpdate('progress', {
          phase: 'refining',
          message: '根据反馈优化分析',
          feedback: evaluation.feedback,
        });
      }

      // 6. 综合最终答案
      console.log('[MasterOrchestrator] Step 6: Starting synthesis phase');
      this.emitUpdate('progress', { phase: 'synthesizing', message: '综合分析结论' });
      console.log('[MasterOrchestrator] Step 6: Calling synthesize()...');
      const synthesizedAnswer = await this.synthesize(stageResults, intent, evaluation!);
      console.log('[MasterOrchestrator] Step 6: Synthesis complete, answer length:', synthesizedAnswer?.length || 0);

      // 7. 完成对话轮次（Phase 5: Multi-turn Dialogue）
      if (currentTurn && this.sessionContext) {
        const allFindings = this.collectFindings(stageResults);
        this.sessionContext.completeTurn(currentTurn.id, {
          success: true,
          findings: allFindings,
          data: { answer: synthesizedAnswer },
          confidence: evaluation!.qualityScore,
        }, allFindings);
      }

      // 8. 完成
      console.log('[MasterOrchestrator] Step 8: Completing analysis...');
      this.stateMachine.transition({ type: 'ANALYSIS_COMPLETE' });
      await this.sessionStore.updatePhase(session.sessionId, 'completed');

      console.log('[MasterOrchestrator] Step 8: Emitting conclusion event...');
      this.emitUpdate('conclusion', { answer: synthesizedAnswer });

      console.log('[MasterOrchestrator] Step 8: Creating success result...');
      const result = this.createSuccessResult(
        session.sessionId,
        intent,
        plan,
        stageResults,
        evaluation!,
        synthesizedAnswer,
        startTime
      );

      // === Session End Hook (Success) ===
      await this.hookRegistry.executePost(
        'session:end',
        session.sessionId,
        {
          query,
          traceId,
          result,
          iterationCount: this.totalIterations,
          totalDurationMs: Date.now() - startTime,
        },
        this.hookContext || undefined
      );

      // 清理 hook context
      this.hookContext = null;

      console.log('[MasterOrchestrator] Returning success result, sessionId:', result.sessionId);
      return result;
    } catch (error: any) {
      this.stateMachine?.transition({ type: 'ERROR_OCCURRED', payload: { error: error.message } });

      if (this.currentSessionId) {
        await this.sessionStore.setError(this.currentSessionId, error.message);
      }

      // === Session Error Hook ===
      await this.hookRegistry.executePost(
        'session:error',
        this.currentSessionId || 'unknown',
        {
          query,
          traceId,
          error: error instanceof Error ? error : new Error(String(error)),
          totalDurationMs: Date.now() - startTime,
        },
        this.hookContext || undefined
      );

      // 清理 hook context
      this.hookContext = null;

      this.emitUpdate('error', { message: error.message });

      throw error;
    }
  }

  /**
   * 从检查点恢复
   */
  async resumeFromCheckpoint(
    sessionId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<MasterOrchestratorResult> {
    // 加载会话
    const session = await this.sessionStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // 加载最新检查点
    const checkpoint = await this.checkpointManager.getLatestCheckpoint(sessionId);
    if (!checkpoint) {
      throw new Error(`No checkpoint found for session: ${sessionId}`);
    }

    // 恢复状态机
    this.stateMachine = (await AgentStateMachine.load(sessionId, session.traceId)) ||
      AgentStateMachine.create(sessionId, session.traceId);
    this.stateMachine.restoreFromCheckpoint(checkpoint);

    // 恢复执行
    const intent = session.intent || await this.understandIntent(session.query, session.traceId, options);
    const plan = session.plan || await this.createPlan(intent, session.traceId, options);

    // 从检查点继续执行
    return this.handleQuery(session.query, session.traceId, options);
  }

  // ==========================================================================
  // 子步骤方法
  // ==========================================================================

  /**
   * 理解意图
   */
  private async understandIntent(
    query: string,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): Promise<Intent> {
    const context: SubAgentContext = {
      sessionId: this.currentSessionId || '',
      traceId,
      ...options,
    };

    return this.plannerAgent.understandIntent(query, context);
  }

  /**
   * 创建计划
   */
  private async createPlan(
    intent: Intent,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): Promise<AnalysisPlan> {
    const context: SubAgentContext = {
      sessionId: this.currentSessionId || '',
      traceId,
      intent,
      ...options,
    };

    return this.plannerAgent.createPlan(intent, context);
  }

  /**
   * 评估结果
   */
  private async evaluateResults(results: StageResult[], intent: Intent): Promise<Evaluation> {
    return this.evaluatorAgent.evaluate(results, intent);
  }

  /**
   * 综合最终答案
   * Phase 5: 支持多轮对话上下文感知
   */
  private async synthesize(
    results: StageResult[],
    intent: Intent,
    evaluation: Evaluation
  ): Promise<string> {
    const findings = this.collectFindings(results);

    // 构建上下文部分（Phase 5: Multi-turn Dialogue）
    let contextSection = '';
    if (this.sessionContext) {
      const turns = this.sessionContext.getAllTurns();
      if (turns.length > 1) {
        // 有多轮对话时，添加上下文
        const contextSummary = this.sessionContext.generatePromptContext(300);
        contextSection = `
## 对话上下文
${contextSummary}

`;
      }
    }

    const prompt = `基于以下分析结果，生成简洁的分析结论：
${contextSection}
用户意图: ${intent.primaryGoal}

分析发现:
${findings.map(f => `- [${f.severity}] ${f.title}`).join('\n')}

评估结果:
- 质量分数: ${evaluation.qualityScore.toFixed(2)}
- 完整性: ${evaluation.completenessScore.toFixed(2)}

请生成简洁的分析结论，只包括：
1. 发现的关键问题（简要列出）
2. 可能的根因（一句话概括）
${contextSection ? '\n注意：请结合对话上下文，回答应与之前的讨论保持连贯。' : ''}
注意：不要给出优化建议或改进方案，只需要指出问题所在。`;

    try {
      // Add timeout to prevent getting stuck (use configured synthesis timeout, default 60s)
      const SYNTHESIS_TIMEOUT_MS = pipeConfig.stageTimeouts.synthesis || 60000;
      console.log(`[MasterOrchestrator.synthesize] Starting LLM call with ${SYNTHESIS_TIMEOUT_MS}ms timeout...`);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Synthesis timeout after ${SYNTHESIS_TIMEOUT_MS}ms`)), SYNTHESIS_TIMEOUT_MS);
      });

      const response = await Promise.race([
        this.modelRouter.callWithFallback(prompt, 'synthesis'),
        timeoutPromise,
      ]);
      console.log('[MasterOrchestrator.synthesize] LLM call succeeded, response length:', response.response?.length || 0);
      return response.response;
    } catch (error) {
      // Fallback to simple synthesis on timeout or error
      console.warn('[MasterOrchestrator.synthesize] LLM call failed or timed out, using simple synthesis:', error);
      const simpleSynthesis = this.generateSimpleSynthesis(findings, evaluation);
      console.log('[MasterOrchestrator.synthesize] Generated simple synthesis, length:', simpleSynthesis?.length || 0);
      return simpleSynthesis;
    }
  }

  /**
   * 生成简单综合
   * 只列出关键问题，不包含优化建议
   */
  private generateSimpleSynthesis(findings: Finding[], _evaluation: Evaluation): string {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const infos = findings.filter(f => f.severity === 'info');

    let synthesis = '## 分析结论\n\n';

    if (critical.length > 0) {
      synthesis += `### 🔴 严重问题 (${critical.length})\n`;
      for (const f of critical) {
        synthesis += `- **${f.title}**\n`;
      }
      synthesis += '\n';
    }

    if (warnings.length > 0) {
      synthesis += `### 🟡 需要关注 (${warnings.length})\n`;
      for (const f of warnings) {
        synthesis += `- ${f.title}\n`;
      }
      synthesis += '\n';
    }

    if (infos.length > 0 && critical.length === 0 && warnings.length === 0) {
      synthesis += `### ℹ️ 发现 (${infos.length})\n`;
      for (const f of infos) {
        synthesis += `- ${f.title}\n`;
      }
      synthesis += '\n';
    }

    if (findings.length === 0) {
      synthesis += '未发现明显的性能问题。\n';
    }

    return synthesis;
  }

  // ==========================================================================
  // 事件处理
  // ==========================================================================

  /**
   * 处理阶段完成
   */
  private async handleStageComplete(sessionId: string, stage: PipelineStage, result: StageResult): Promise<void> {
    // 创建检查点
    const checkpoint = await this.checkpointManager.createCheckpoint(
      sessionId,
      stage.id,
      this.stateMachine.phase,
      [result],
      result.findings
    );

    // === Session Checkpoint Hook ===
    await this.hookRegistry.executePost(
      'session:checkpoint',
      sessionId,
      {
        checkpointId: checkpoint.id,
        traceId: this.hookContext?.traceId,
      },
      this.hookContext || undefined
    );

    // 过滤已发送的 Finding，防止重复（双重去重：ID + 内容哈希）
    const newFindings = result.findings.filter(f => {
      // 1. ID 去重
      if (this.emittedFindingIds.has(f.id)) {
        return false;
      }

      // 2. 内容哈希去重（防止相同诊断文字重复出现）
      const contentHash = this.hashFindingContent(f);
      if (this.emittedDiagnosticHashes.has(contentHash)) {
        console.log(`[MasterOrchestrator] Skipping duplicate finding by content hash: ${f.title}`);
        return false;
      }

      this.emittedFindingIds.add(f.id);
      this.emittedDiagnosticHashes.add(contentHash);
      return true;
    });

    // 只发送新的 findings
    if (newFindings.length > 0) {
      this.emitUpdate('finding', { stage: stage.id, findings: newFindings });
    }
  }

  /**
   * 计算 Finding 内容哈希（用于去重）
   */
  private hashFindingContent(f: Finding): string {
    // 使用标题+描述+严重程度作为内容标识
    return `${f.title}::${f.description}::${f.severity}`;
  }

  /**
   * 处理阶段错误
   */
  private async handleStageError(stage: PipelineStage, error: Error): Promise<'retry' | 'skip' | 'abort' | 'ask_user'> {
    const decision = this.circuitBreaker.recordFailure(stage.id, error.message);

    this.emitUpdate('error', { stage: stage.id, error: error.message, decision });

    return decision.action as 'retry' | 'skip' | 'abort' | 'ask_user';
  }

  // ==========================================================================
  // 结果构建
  // ==========================================================================

  /**
   * 构建执行上下文
   */
  private async buildContext(
    sessionId: string,
    traceId: string,
    intent: Intent,
    plan: AnalysisPlan,
    previousResults: StageResult[],
    options: { traceProcessor?: any; traceProcessorService?: any }
  ): Promise<SubAgentContext> {
    // Debug: Log whether traceProcessorService is in options
    console.log(`[MasterOrchestrator] buildContext called`);
    console.log(`[MasterOrchestrator] options keys: ${Object.keys(options).join(', ')}`);
    console.log(`[MasterOrchestrator] has traceProcessorService: ${!!options.traceProcessorService}`);
    if (options.traceProcessorService) {
      console.log(`[MasterOrchestrator] traceProcessorService type: ${typeof options.traceProcessorService}`);
      console.log(`[MasterOrchestrator] traceProcessorService has getTrace: ${typeof options.traceProcessorService?.getTrace === 'function'}`);
    }

    let context: SubAgentContext = {
      sessionId,
      traceId,
      intent,
      plan,
      previousResults,
      architecture: this.currentArchitecture || undefined,  // 添加架构信息到上下文
      ...options,
    };

    // 检查是否需要压缩上下文
    if (this.contextCompactor.needsCompaction(context)) {
      console.log(`[MasterOrchestrator] Context needs compaction, applying...`);
      context = await this.contextCompactor.compactIfNeeded(context);
    }

    // Debug: Verify context was built correctly
    console.log(`[MasterOrchestrator] built context keys: ${Object.keys(context).join(', ')}`);
    console.log(`[MasterOrchestrator] context.traceProcessorService: ${!!context.traceProcessorService}`);

    return context;
  }

  /**
   * 收集所有发现
   */
  private collectFindings(results: StageResult[]): Finding[] {
    const findings: Finding[] = [];
    for (const result of results) {
      findings.push(...result.findings);
    }
    return findings;
  }

  /**
   * 创建成功结果
   */
  private createSuccessResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    evaluation: Evaluation,
    synthesizedAnswer: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation,
      synthesizedAnswer,
      confidence: evaluation.qualityScore,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: false,
    };
  }

  /**
   * 创建暂停结果
   */
  private createPausedResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    pausedAt: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation: {
        passed: false,
        qualityScore: 0,
        completenessScore: 0,
        contradictions: [],
        feedback: { strengths: [], weaknesses: [], missingAspects: [], improvementSuggestions: [], priorityActions: [] },
        needsImprovement: true,
        suggestedActions: [`已在阶段 ${pausedAt} 暂停`],
      },
      synthesizedAnswer: `分析已暂停，可以恢复执行`,
      confidence: 0,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: true,
      checkpointId: pausedAt,
    };
  }

  /**
   * 创建等待用户结果
   */
  private createAwaitingUserResult(
    sessionId: string,
    intent: Intent,
    plan: AnalysisPlan,
    stageResults: StageResult[],
    reason: string,
    startTime: number
  ): MasterOrchestratorResult {
    return {
      sessionId,
      intent,
      plan,
      stageResults,
      evaluation: {
        passed: false,
        qualityScore: 0,
        completenessScore: 0,
        contradictions: [],
        feedback: { strengths: [], weaknesses: [], missingAspects: [], improvementSuggestions: [], priorityActions: [reason] },
        needsImprovement: true,
        suggestedActions: [reason],
      },
      synthesizedAnswer: `需要用户决策: ${reason}`,
      confidence: 0,
      totalDuration: Date.now() - startTime,
      iterationCount: this.totalIterations,
      modelUsage: this.getModelUsage(),
      canResume: true,
    };
  }

  /**
   * 获取模型使用统计
   */
  private getModelUsage(): ModelUsageSummary {
    const stats = this.modelRouter.getStats();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    const modelBreakdown: Record<string, { calls: number; tokens: number; cost: number }> = {};

    for (const [modelId, modelStats] of Object.entries(stats)) {
      totalInputTokens += modelStats.tokens;
      totalOutputTokens += modelStats.tokens; // 简化
      totalCost += modelStats.cost;
      modelBreakdown[modelId] = modelStats;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      modelBreakdown,
    };
  }

  // ==========================================================================
  // 事件发送
  // ==========================================================================

  /**
   * 发送更新事件
   */
  private emitUpdate(type: StreamingUpdate['type'], content: any): void {
    const update: StreamingUpdate = {
      type,
      content,
      timestamp: Date.now(),
    };

    this.emit('update', update);

    if (this.config.streamingCallback) {
      this.config.streamingCallback(update);
    }
  }

  // ==========================================================================
  // 执行器注册
  // ==========================================================================

  /**
   * 注册默认执行器
   */
  private registerDefaultExecutors(): void {
    this.pipelineExecutor.registerExecutor('plan', this.plannerAgent);
    this.pipelineExecutor.registerExecutor('execute', this.analysisWorker);
    this.pipelineExecutor.registerExecutor('evaluate', this.evaluatorAgent);
    this.pipelineExecutor.registerExecutor('refine', this.analysisWorker);
    this.pipelineExecutor.registerExecutor('conclude', this.analysisWorker);
  }

  /**
   * 注册工作 Agent
   */
  registerWorkerAgent(stageId: string, executor: StageExecutor): void {
    this.workerAgents.set(stageId, executor);
    this.pipelineExecutor.registerExecutor(stageId, executor);
  }

  // ==========================================================================
  // 事件监听设置
  // ==========================================================================

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    // 断路器事件
    this.circuitBreaker.on('tripped', (data) => {
      this.emitUpdate('error', { type: 'circuit_tripped', ...data });
    });

    // 模型路由事件
    this.modelRouter.on('modelError', (data) => {
      this.emitUpdate('error', { type: 'model_error', ...data });
    });

    // SubAgent 事件
    this.plannerAgent.on('complete', (data) => {
      this.emitUpdate('thought', { agent: 'planner', ...data });
    });

    this.evaluatorAgent.on('complete', (data) => {
      this.emitUpdate('thought', { agent: 'evaluator', ...data });
    });

    // AnalysisWorker 的 skill_data 事件 - 发送层级数据到前端
    this.analysisWorker.on('skill_data', (data) => {
      // 兼容新旧层级命名
      const layers = data.layers || {};
      console.log('[MasterOrchestrator] Received skill_data event from AnalysisWorker:', {
        skillId: data.skillId,
        skillName: data.skillName,
        hasLayers: !!layers,
        overviewKeys: layers.overview ? Object.keys(layers.overview) : [],
        listKeys: layers.list ? Object.keys(layers.list) : [],
        deepKeys: layers.deep ? Object.keys(layers.deep) : [],
        diagnosticsCount: data.diagnostics?.length || 0,
      });
      console.log('[MasterOrchestrator] Forwarding skill_data to frontend via emitUpdate');
      this.emitUpdate('skill_data' as any, data);
    });

    // AnalysisWorker 的 worker_thought 事件 - 发送 Worker 思考过程到前端
    this.analysisWorker.on('worker_thought', (data) => {
      console.log('[MasterOrchestrator] Received worker_thought event:', {
        agent: data.agent,
        skillId: data.skillId,
        step: data.step,
      });
      this.emitUpdate('worker_thought' as any, data);
    });
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  /**
   * 关闭编排者
   */
  async close(): Promise<void> {
    await this.sessionStore.close();
    this.stateMachine?.destroy();
    this.removeAllListeners();
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.totalIterations = 0;
    this.currentSessionId = null;
    this.currentArchitecture = null;
    this.circuitBreaker.reset();
    this.modelRouter.resetStats();
    this.pipelineExecutor.reset();
  }

  /**
   * 获取当前检测到的渲染架构
   */
  getCurrentArchitecture(): ArchitectureInfo | null {
    return this.currentArchitecture;
  }

  // ==========================================================================
  // Expert System Integration (Phase 3)
  // ==========================================================================

  /**
   * 启用/禁用专家模式
   * 专家模式使用决策树驱动的分析，而非传统的 LLM 规划
   */
  setExpertModeEnabled(enabled: boolean): void {
    this.expertModeEnabled = enabled;
    console.log(`[MasterOrchestrator] Expert mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * 检查专家模式是否启用
   */
  isExpertModeEnabled(): boolean {
    return this.expertModeEnabled;
  }

  // ==========================================================================
  // Multi-turn Dialogue Context Methods (Phase 5)
  // ==========================================================================

  /**
   * 获取当前会话的对话上下文
   */
  getSessionContext(): EnhancedSessionContext | null {
    return this.sessionContext;
  }

  /**
   * 获取会话的上下文摘要（用于 API）
   */
  getContextSummary(): ReturnType<EnhancedSessionContext['generateContextSummary']> | null {
    return this.sessionContext?.generateContextSummary() || null;
  }

  /**
   * 查询与关键词相关的对话历史
   */
  queryConversationContext(keywords: string[]): ReturnType<EnhancedSessionContext['queryContext']> {
    return this.sessionContext?.queryContext(keywords) || [];
  }

  /**
   * 获取特定 Finding 详情
   */
  getFindingById(findingId: string) {
    return this.sessionContext?.getFinding(findingId);
  }

  /**
   * 使用专家系统处理查询 (Phase 3 新功能)
   *
   * 与 handleQuery 不同，此方法直接路由到领域专家进行分析，
   * 跳过 LLM 规划阶段，使用决策树驱动的分析流程。
   */
  async handleQueryWithExpert(
    query: string,
    traceId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<ExpertOutput> {
    const startTime = Date.now();

    try {
      // 1. 创建会话
      const session = await this.sessionStore.createSession(traceId, query);
      this.currentSessionId = session.sessionId;

      this.emitUpdate('progress', { phase: 'starting', message: '开始专家分析' });

      // 2. 检测渲染架构
      this.currentArchitecture = null;
      if (options.traceProcessorService) {
        try {
          this.emitUpdate('progress', { phase: 'detecting_architecture', message: '检测渲染架构' });
          this.currentArchitecture = await this.architectureDetector.detect({
            traceId,
            traceProcessorService: options.traceProcessorService,
          });
          console.log(`[MasterOrchestrator] Expert mode - Detected architecture: ${this.currentArchitecture.type}`);
        } catch (error: any) {
          console.warn(`[MasterOrchestrator] Architecture detection failed:`, error.message);
        }
      }

      // 3. 解析用户意图
      this.emitUpdate('progress', { phase: 'parsing_intent', message: '解析分析意图' });
      const intent = parseAnalysisIntent(query);
      console.log(`[MasterOrchestrator] Parsed intent: ${intent.category} (confidence: ${intent.confidence.toFixed(2)})`);

      // 4. 路由到专家
      const expert = getExpertForIntent(intent);
      if (!expert) {
        console.warn(`[MasterOrchestrator] No expert found for intent: ${intent.category}, falling back to general`);
        // 如果没有专家，返回一个通用结果
        return {
          expertId: 'none',
          domain: 'general',
          success: false,
          findings: [],
          suggestions: ['请尝试更具体的查询，或使用标准分析模式'],
          error: `没有找到处理 "${intent.category}" 意图的专家`,
          confidence: 0,
        };
      }

      // 5. 构建专家输入
      this.emitUpdate('progress', {
        phase: 'executing_expert',
        message: `执行 ${expert.config.name}`,
        expertId: expert.config.id,
      });

      const expertInput: ExpertInput = {
        sessionId: session.sessionId,
        traceId,
        query,
        intent,
        architecture: this.currentArchitecture || undefined,
        traceProcessorService: options.traceProcessorService,
        packageName: undefined, // 可以从 trace 中提取
        timeRange: undefined,   // 可以从 trace 中提取
      };

      // 6. 执行专家分析
      console.log(`[MasterOrchestrator] Routing to expert: ${expert.config.name} (${expert.config.id})`);

      // 监听专家事件 (experts extend EventEmitter)
      const expertEmitter = expert as unknown as EventEmitter;
      expertEmitter.on('analysis:start', (data: any) => {
        this.emitUpdate('progress', { phase: 'expert_start', ...data });
      });
      expertEmitter.on('node:start', (data: any) => {
        this.emitUpdate('progress', { phase: 'decision_node', ...data });
      });
      expertEmitter.on('node:complete', (data: any) => {
        this.emitUpdate('progress', { phase: 'decision_node_complete', ...data });
      });
      expertEmitter.on('analysis:complete', (data: any) => {
        this.emitUpdate('progress', { phase: 'expert_complete', ...data });
      });

      const expertOutput = await expert.analyze(expertInput);

      // 7. 发送结果
      this.emitUpdate('conclusion', {
        expertId: expertOutput.expertId,
        domain: expertOutput.domain,
        conclusion: expertOutput.conclusion,
        findings: expertOutput.findings,
        confidence: expertOutput.confidence,
      });

      // 发送 findings
      if (expertOutput.findings.length > 0) {
        this.emitUpdate('finding', {
          stage: 'expert_analysis',
          findings: expertOutput.findings,
        });
      }

      console.log(`[MasterOrchestrator] Expert analysis completed in ${Date.now() - startTime}ms`);
      return expertOutput;

    } catch (error: any) {
      console.error(`[MasterOrchestrator] Expert analysis failed:`, error);
      this.emitUpdate('error', { message: error.message });

      return {
        expertId: 'error',
        domain: 'general',
        success: false,
        findings: [],
        suggestions: ['分析过程中发生错误，请检查 trace 数据'],
        error: error.message,
        confidence: 0,
      };
    }
  }

  /**
   * 获取可用的专家列表
   */
  listExperts(): { id: string; name: string; domain: string; intents: string[] }[] {
    return expertRegistry.list().map((config) => ({
      id: config.id,
      name: config.name,
      domain: config.domain,
      intents: config.handlesIntents,
    }));
  }

  /**
   * 检查是否有专家可以处理指定的意图
   */
  hasExpertFor(query: string): boolean {
    const intent = parseAnalysisIntent(query);
    return expertRegistry.hasExpertFor(intent.category);
  }

  // ==========================================================================
  // Fork 操作
  // ==========================================================================

  /**
   * 启用/禁用 Fork 功能
   */
  setForkEnabled(enabled: boolean): void {
    this.forkManager.updateConfig({ enabled });
  }

  /**
   * 检查 Fork 是否启用
   */
  isForkEnabled(): boolean {
    return this.forkManager.isEnabled();
  }

  /**
   * 从检查点创建分叉
   */
  async forkFromCheckpoint(
    checkpointId: string,
    options: Partial<ForkOptions> = {}
  ): Promise<ForkResult> {
    if (!this.currentSessionId) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId: '',
        sourceCheckpointId: checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: 'No active session',
      };
    }

    // 获取当前会话信息
    const session = await this.sessionStore.getSession(this.currentSessionId);
    if (!session) {
      return {
        success: false,
        forkedSessionId: '',
        parentSessionId: this.currentSessionId,
        sourceCheckpointId: checkpointId,
        branchName: options.branchName || 'fork',
        forkTime: Date.now(),
        error: 'Session not found',
      };
    }

    const forkOptions: ForkOptions = {
      checkpointId,
      branchName: options.branchName,
      description: options.description,
      runParallel: options.runParallel ?? false,
      hypothesis: options.hypothesis,
      inheritConfig: options.inheritConfig ?? true,
    };

    const result = await this.forkManager.fork(this.currentSessionId, forkOptions);

    if (result.success && session.intent && session.plan) {
      // 注册上下文
      const parentContext = await this.buildContext(
        this.currentSessionId,
        session.traceId,
        session.intent,
        session.plan,
        [],
        {}
      );
      this.forkManager.registerContext(result.forkedSessionId, {
        ...parentContext,
        sessionId: result.forkedSessionId,
      });

      this.emitUpdate('progress', {
        phase: 'fork_created',
        message: `分叉已创建: ${result.branchName}`,
        forkedSessionId: result.forkedSessionId,
      });
    }

    return result;
  }

  /**
   * 恢复分叉会话继续执行
   */
  async resumeForkedSession(
    forkedSessionId: string,
    options: { traceProcessor?: any; traceProcessorService?: any } = {}
  ): Promise<MasterOrchestratorResult> {
    // 获取分叉会话的上下文
    const context = this.forkManager.getContext(forkedSessionId);
    if (!context) {
      throw new Error(`Fork session context not found: ${forkedSessionId}`);
    }

    // 获取会话节点信息
    const node = this.forkManager.getSessionNode(forkedSessionId);
    if (!node) {
      throw new Error(`Fork session node not found: ${forkedSessionId}`);
    }

    // 加载检查点
    const checkpoint = await this.checkpointManager.loadCheckpoint(
      forkedSessionId,
      node.forkCheckpointId!
    );
    if (!checkpoint) {
      throw new Error(`Checkpoint not found for fork: ${forkedSessionId}`);
    }

    // 设置当前会话
    this.currentSessionId = forkedSessionId;

    // 恢复状态机
    this.stateMachine = AgentStateMachine.create(
      forkedSessionId,
      context.traceId
    );
    this.stateMachine.restoreFromCheckpoint(checkpoint);

    // 继续执行
    return this.handleQuery(
      checkpoint.agentState.query,
      context.traceId,
      options
    );
  }

  /**
   * 比较多个分叉的结果
   */
  async compareForks(sessionIds: string[]): Promise<ComparisonResult> {
    return this.forkManager.compare(sessionIds);
  }

  /**
   * 合并分叉到父会话
   */
  async mergeFork(options: MergeOptions): Promise<MergeResult> {
    const result = await this.forkManager.merge(options);

    if (result.success) {
      this.emitUpdate('progress', {
        phase: 'fork_merged',
        message: `分叉已合并: ${result.childSessionId} -> ${result.parentSessionId}`,
        mergedFindingsCount: result.mergedFindingsCount,
      });
    }

    return result;
  }

  /**
   * 列出当前会话的所有分叉
   */
  listForks(): SessionNode[] {
    if (!this.currentSessionId) {
      return [];
    }
    return this.forkManager.listForks(this.currentSessionId);
  }

  /**
   * 放弃分叉
   */
  abandonFork(sessionId: string): boolean {
    return this.forkManager.abandonFork(sessionId);
  }

  /**
   * 标记分叉完成
   */
  markForkCompleted(sessionId: string, summary: SessionNodeSummary): void {
    this.forkManager.markCompleted(sessionId, summary);
  }

  /**
   * 获取会话树可视化
   */
  getSessionTreeVisualization(): string {
    if (!this.currentSessionId) {
      return '(no active session)';
    }
    return this.forkManager.getTreeVisualization(this.currentSessionId);
  }
}

/**
 * Factory function for creating MasterOrchestrator
 */
export function createMasterOrchestrator(
  config: Partial<MasterOrchestratorConfig> = {}
): MasterOrchestrator {
  return new MasterOrchestrator(config);
}

export default MasterOrchestrator;
