/**
 * SmartPerfetto Agent-Driven Orchestrator
 *
 * Phase 3: Transform from "AI-assisted deterministic executor" to "AI Agents driven" system
 *
 * This orchestrator:
 * 1. Uses AI to understand user intent and generate hypotheses
 * 2. Dynamically dispatches tasks to domain agents based on hypotheses
 * 3. Collects and synthesizes feedback from agents
 * 4. Runs multi-round iterations until conclusions are reached
 * 5. Generates intelligent, evidence-backed conclusions
 *
 * Architecture:
 * User Query → Master Agent (AI decision core)
 *                    ↓
 *           Dynamic task dispatch
 *                    ↓
 *      ┌────────┬────────┬────────┬────────┐
 *      ↓        ↓        ↓        ↓        ↓
 *   Frame    CPU     Binder   Memory    ...
 *   Agent   Agent    Agent    Agent
 *      └────────┴────────┴────────┴────────┘
 *                    ↓
 *           Feedback & Reasoning
 *                    ↓
 *      Master Agent synthesizes findings,
 *      dispatches more tasks if needed
 *                    ↓
 *         AI-generated insights
 */

import { EventEmitter } from 'events';
import {
  Intent,
  Finding,
  StreamingUpdate,
  Evaluation,
} from '../types';
import {
  AgentTask,
  AgentResponse,
  Hypothesis,
  SharedAgentContext,
  createTaskId,
  createHypothesisId,
} from '../types/agentProtocol';
import { ModelRouter } from './modelRouter';
import { AgentMessageBus, createAgentMessageBus } from '../communication';
import {
  DomainAgentRegistry,
  createDomainAgentRegistry,
} from '../agents/domain';
import {
  IterationStrategyPlanner,
  createIterationStrategyPlanner,
  StrategyDecision,
} from '../agents/iterationStrategyPlanner';
import {
  EnhancedSessionContext,
  sessionContextManager,
} from '../context/enhancedSessionContext';

// =============================================================================
// Types
// =============================================================================

export interface AgentDrivenOrchestratorConfig {
  /** Maximum analysis rounds */
  maxRounds: number;
  /** Maximum concurrent agent tasks */
  maxConcurrentTasks: number;
  /** Confidence threshold to conclude */
  confidenceThreshold: number;
  /** Stop after consecutive rounds with no new evidence */
  maxNoProgressRounds: number;
  /** Stop after consecutive rounds with mostly failed tasks */
  maxFailureRounds: number;
  /** Enable logging */
  enableLogging: boolean;
  /** Streaming callback */
  streamingCallback?: (update: StreamingUpdate) => void;
}

const DEFAULT_CONFIG: AgentDrivenOrchestratorConfig = {
  maxRounds: 5,
  maxConcurrentTasks: 3,
  confidenceThreshold: 0.7,
  maxNoProgressRounds: 2,
  maxFailureRounds: 2,
  enableLogging: true,
};

interface TaskGraphNode {
  id: string;
  domain: string;
  description: string;
  evidenceNeeded: string[];
  timeRange?: { start: number; end: number };
  dependsOn?: string[];
  priority?: number;
}

interface TaskGraphPlan {
  nodes: TaskGraphNode[];
  reasoning?: string;
}

const DOMAIN_ALIASES: Record<string, string> = {
  gpu: 'frame',
  render: 'frame',
  rendering: 'frame',
  surfaceflinger: 'frame',
  sf: 'frame',
  choreographer: 'frame',
  ui: 'frame',
  input: 'interaction',
  touch: 'interaction',
  interaction: 'interaction',
  binder: 'binder',
  ipc: 'binder',
  lock: 'binder',
  memory: 'memory',
  gc: 'memory',
  art: 'memory',
  startup: 'startup',
  launch: 'startup',
  coldstart: 'startup',
  anr: 'anr',
  systemserver: 'system',
  system: 'system',
  thermal: 'system',
  io: 'system',
  power: 'system',
};

const DEFAULT_EVIDENCE: Record<string, string[]> = {
  frame: ['jank frames', 'frame durations', 'fps', 'frame timeline'],
  cpu: ['cpu load', 'runqueue latency', 'cpu frequency', 'thread hotspots'],
  binder: ['binder call latency', 'thread blocking', 'lock contention'],
  memory: ['heap usage', 'gc pauses', 'allocation spikes', 'lmk events'],
  startup: ['cold start duration', 'main thread blocking', 'io latency'],
  interaction: ['input latency', 'dispatch delay', 'response time'],
  anr: ['anr traces', 'blocked main thread', 'binder waits'],
  system: ['thermal throttling', 'io stalls', 'system_server workload'],
};

type ScrollingStage = 'overview' | 'interval_metrics' | 'frame_details';

interface ScrollingFocusSession {
  /** Session id from scrolling_analysis (per process) */
  sessionId: number;
  /** Target process/package name */
  processName: string;
  /** Range start (ns) */
  startTs: number;
  /** Range end (ns) */
  endTs: number;
  /** Count of detected jank frames in this session */
  jankFrameCount: number;
  /** Max vsync missed among detected jank frames */
  maxVsyncMissed: number;
}

const STAGED_SCROLLING_DEFAULTS = {
  maxFocusSessions: 2,
  maxFramesPerSession: 8,
} as const;

export interface AnalysisResult {
  sessionId: string;
  success: boolean;
  findings: Finding[];
  hypotheses: Hypothesis[];
  conclusion: string;
  confidence: number;
  rounds: number;
  totalDurationMs: number;
}

// =============================================================================
// Agent-Driven Orchestrator
// =============================================================================

/**
 * Agent-Driven Orchestrator
 *
 * This is the AI decision core that coordinates domain agents
 * through dynamic task dispatch and feedback synthesis.
 */
export class AgentDrivenOrchestrator extends EventEmitter {
  private config: AgentDrivenOrchestratorConfig;
  private modelRouter: ModelRouter;
  private messageBus: AgentMessageBus;
  private agentRegistry: DomainAgentRegistry;
  private strategyPlanner: IterationStrategyPlanner;
  private sessionContext: EnhancedSessionContext | null = null;
  private currentRound: number = 0;
  private noProgressRounds: number = 0;
  private failureRounds: number = 0;
  private stopReason: string | null = null;

  constructor(modelRouter: ModelRouter, config?: Partial<AgentDrivenOrchestratorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.modelRouter = modelRouter;

    // Initialize components
    this.messageBus = createAgentMessageBus({
      maxConcurrentTasks: this.config.maxConcurrentTasks,
      enableLogging: this.config.enableLogging,
    });

    this.agentRegistry = createDomainAgentRegistry(modelRouter);
    this.strategyPlanner = createIterationStrategyPlanner(modelRouter);

    // Register all agents with message bus
    for (const agent of this.agentRegistry.getAll()) {
      this.messageBus.registerAgent(agent);
    }

    // Set up event forwarding
    this.setupEventForwarding();
  }

  // ==========================================================================
  // Core Analysis Method
  // ==========================================================================

  /**
   * Run agent-driven analysis
   */
  async analyze(
    query: string,
    sessionId: string,
    traceId: string,
    options: {
      traceProcessorService?: any;
      packageName?: string;
      timeRange?: { start: number; end: number };
    } = {}
  ): Promise<AnalysisResult> {
    const startTime = Date.now();
    this.currentRound = 0;
    this.noProgressRounds = 0;
    this.failureRounds = 0;
    this.stopReason = null;
    this.strategyPlanner.resetProgressTracking();

    this.log(`Starting agent-driven analysis for: ${query}`);
    this.emitUpdate('progress', { phase: 'starting', message: '开始 AI Agent 分析' });

    try {
      // 1. Initialize session context
      this.sessionContext = sessionContextManager.getOrCreate(sessionId, traceId);
      const sharedContext = this.messageBus.createSharedContext(sessionId, traceId);

      // 2. Understand intent and generate initial hypotheses
      this.emitUpdate('progress', { phase: 'understanding', message: '理解用户意图' });
      const intent = await this.understandIntent(query);
      const initialHypotheses = await this.generateInitialHypotheses(query, intent);

      // Add hypotheses to shared context
      for (const hypothesis of initialHypotheses) {
        this.messageBus.updateHypothesis(hypothesis);
      }

      this.emitUpdate('progress', {
        phase: 'hypotheses_generated',
        message: `生成 ${initialHypotheses.length} 个假设`,
        hypotheses: initialHypotheses.map(h => h.description),
      });

      // 3. Run analysis loop
      let allFindings: Finding[] = [];
      let lastStrategy: StrategyDecision | null = null;
      let informationGaps: string[] = [];
      let stagedConfidence: number = 0.5;

      // For scrolling/jank queries, use a deterministic 3-stage pipeline:
      // 1) Overview: locate jank intervals and jank frames
      // 2) Interval metrics: CPU/GC/Binder within the problematic interval(s)
      // 3) Frame details: per-jank-frame deep dive (only for the jank points)
      const stagedScrolling = this.isScrollingOrJankQuery(query);
      if (stagedScrolling) {
        this.setScrollingStage(sharedContext, 'overview');
        sharedContext.userContext = {
          ...(sharedContext.userContext || {}),
          focusSessions: [],
        };
      }

      while (this.currentRound < this.config.maxRounds) {
        this.currentRound++;
        this.log(`=== Round ${this.currentRound}/${this.config.maxRounds} ===`);

        if (stagedScrolling) {
          const stage = this.getScrollingStage(sharedContext);
          const stageIndex = stage === 'overview' ? 1 : stage === 'interval_metrics' ? 2 : 3;
          const stageMessage =
            stage === 'overview'
              ? '阶段 1/3：先定位掉帧区间与掉帧点'
              : stage === 'interval_metrics'
                ? '阶段 2/3：在掉帧区间内查看 CPU/GC/Binder'
                : '阶段 3/3：对掉帧点做逐帧详情分析';

          this.emitUpdate('progress', {
            phase: 'round_start',
            round: stageIndex,
            maxRounds: 3,
            message: stageMessage,
          });

          const tasks = this.buildStagedScrollingTasks(stage, query, intent, sharedContext, options);
          if (tasks.length === 0) {
            this.stopReason = 'No tasks generated for staged scrolling analysis';
            break;
          }

          this.emitUpdate('progress', {
            phase: 'tasks_dispatched',
            taskCount: tasks.length,
            agents: tasks.map(t => t.targetAgentId),
            message: `派发 ${tasks.length} 个任务`,
          });

          const responses = await this.executeTaskGraph(tasks);
          this.emitDataEnvelopes(responses);

          const synthesis = await this.synthesizeFeedback(responses, sharedContext);
          this.emitUpdate('progress', {
            phase: 'synthesis_complete',
            confirmedFindings: synthesis.confirmedFindings.length,
            updatedHypotheses: synthesis.updatedHypotheses.length,
            message: `综合 ${responses.length} 个 Agent 反馈`,
          });

          informationGaps = synthesis.informationGaps;
          allFindings.push(...synthesis.newFindings);

          if (synthesis.newFindings.length > 0) {
            this.emitUpdate('finding', {
              round: this.currentRound,
              findings: synthesis.newFindings,
            });
          }

          // Update staged confidence from successful responses
          const confidences = responses.filter(r => r.success).map(r => r.confidence).filter(c => typeof c === 'number');
          if (confidences.length > 0) {
            const avg = confidences.reduce((s, c) => s + c, 0) / confidences.length;
            stagedConfidence = Math.max(stagedConfidence, avg);
          }

          // Stage transitions
          if (stage === 'overview') {
            const focusSessions = this.extractScrollingFocusSessions(responses);
            if (focusSessions.length === 0) {
              this.stopReason = '未检测到可用于深入分析的掉帧区间';
              // Conclude early: no need to run interval metrics / frame deep dive.
              lastStrategy = { strategy: 'conclude', confidence: stagedConfidence, reasoning: this.stopReason } as any;
              break;
            }

            sharedContext.userContext = {
              ...(sharedContext.userContext || {}),
              focusSessions,
            };
            // Keep a default focused range for compatibility with downstream tools.
            sharedContext.focusedTimeRange = { start: focusSessions[0].startTs, end: focusSessions[0].endTs };

            this.emitUpdate('progress', {
              phase: 'progress',
              message: `已定位 ${focusSessions.length} 个掉帧区间，进入区间指标分析`,
            });
            this.setScrollingStage(sharedContext, 'interval_metrics');
            continue;
          }

          if (stage === 'interval_metrics') {
            this.emitUpdate('progress', {
              phase: 'progress',
              message: '区间指标已完成，进入逐帧详情分析',
            });
            this.setScrollingStage(sharedContext, 'frame_details');
            continue;
          }

          // frame_details stage completes the staged pipeline
          this.stopReason = 'Staged scrolling analysis completed';
          lastStrategy = { strategy: 'conclude', confidence: stagedConfidence, reasoning: this.stopReason } as any;
          break;
        }

        this.emitUpdate('progress', {
          phase: 'round_start',
          round: this.currentRound,
          maxRounds: this.config.maxRounds,
          message: `分析轮次 ${this.currentRound}`,
        });

        // 3a. Plan task graph and dispatch tasks
        const taskGraph = await this.planTaskGraph(query, intent, sharedContext, informationGaps, options);
        const tasks = this.buildTasksFromGraph(taskGraph, query, intent, sharedContext, options);

        if (tasks.length === 0) {
          this.stopReason = 'No tasks generated from task graph';
          this.log('No tasks to dispatch, concluding');
          break;
        }

        sharedContext.userContext = {
          ...(sharedContext.userContext || {}),
          lastTaskGraph: taskGraph,
        };

        this.emitUpdate('progress', {
          phase: 'task_graph_planned',
          taskCount: tasks.length,
          taskGraph: taskGraph.nodes.map(node => ({
            id: node.id,
            domain: node.domain,
            description: node.description,
            evidenceNeeded: node.evidenceNeeded,
            dependsOn: node.dependsOn,
          })),
          message: `生成任务图 (${tasks.length} 个任务)`,
        });

        this.emitUpdate('progress', {
          phase: 'tasks_dispatched',
          taskCount: tasks.length,
          agents: tasks.map(t => t.targetAgentId),
          message: `派发 ${tasks.length} 个任务`,
        });

        // 3b. Execute tasks with dependency ordering
        const responses = await this.executeTaskGraph(tasks);

        // Emit DataEnvelope results from tools
        this.emitDataEnvelopes(responses);

        // 3c. Synthesize feedback
        const synthesis = await this.synthesizeFeedback(responses, sharedContext);

        this.emitUpdate('progress', {
          phase: 'synthesis_complete',
          confirmedFindings: synthesis.confirmedFindings.length,
          updatedHypotheses: synthesis.updatedHypotheses.length,
          message: `综合 ${responses.length} 个 Agent 反馈`,
        });

        informationGaps = synthesis.informationGaps;

        // Collect findings
        allFindings.push(...synthesis.newFindings);

        // Emit findings
        if (synthesis.newFindings.length > 0) {
          this.emitUpdate('finding', {
            round: this.currentRound,
            findings: synthesis.newFindings,
          });
        }

        // Simplified circuit breaker: stop if no progress or excessive failures
        if (this.evaluateEarlyStop(responses, synthesis.newFindings.length)) {
          this.emitUpdate('progress', {
            phase: 'early_stop',
            reason: this.stopReason,
            noProgressRounds: this.noProgressRounds,
            failureRounds: this.failureRounds,
            message: `提前终止: ${this.stopReason}`,
          });
          break;
        }

        // 3d. Decide next strategy
        const strategyContext = {
          evaluation: this.buildEvaluation(allFindings, sharedContext),
          previousResults: [],
          intent,
          iterationCount: this.currentRound,
          maxIterations: this.config.maxRounds,
          allFindings,
        };

        lastStrategy = await this.strategyPlanner.planNextIteration(strategyContext);

        this.emitUpdate('progress', {
          phase: 'strategy_decision',
          strategy: lastStrategy.strategy,
          confidence: lastStrategy.confidence,
          reasoning: lastStrategy.reasoning,
          message: `策略: ${this.translateStrategy(lastStrategy.strategy)}`,
        });

        if (lastStrategy.strategy === 'conclude') {
          this.log('Strategy: conclude - ending analysis');
          break;
        }

        // Handle deep_dive: update context and add additional skills to investigate
        if (lastStrategy.strategy === 'deep_dive' && lastStrategy.focusArea) {
          this.log(`Strategy: deep_dive - focusing on ${lastStrategy.focusArea}`);
          sharedContext.focusedTimeRange = options.timeRange;

          // Add a new hypothesis based on the focus area
          const deepDiveHypothesis: Hypothesis = {
            id: createHypothesisId(),
            description: `深入分析 ${lastStrategy.focusArea} 领域`,
            confidence: 0.6,
            status: 'investigating',
            supportingEvidence: [],
            contradictingEvidence: [],
            proposedBy: 'master_orchestrator',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.messageBus.updateHypothesis(deepDiveHypothesis);

          // Additional evidence will be picked up in the next task graph iteration
        }

        // Handle pivot: change analysis direction
        if (lastStrategy.strategy === 'pivot' && lastStrategy.newDirection) {
          this.log(`Strategy: pivot - changing direction to ${lastStrategy.newDirection}`);

          // Mark current hypotheses as paused and create new one for new direction
          for (const hypothesis of sharedContext.hypotheses.values()) {
            if (hypothesis.status === 'investigating') {
              hypothesis.status = 'proposed'; // Reset to proposed
              hypothesis.confidence = Math.max(0.3, hypothesis.confidence - 0.2);
              hypothesis.updatedAt = Date.now();
            }
          }

          // Create hypothesis for new direction
          const pivotHypothesis: Hypothesis = {
            id: createHypothesisId(),
            description: lastStrategy.newDirection,
            confidence: 0.5,
            status: 'proposed',
            supportingEvidence: [],
            contradictingEvidence: [],
            proposedBy: 'master_orchestrator',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          this.messageBus.updateHypothesis(pivotHypothesis);
        }
      }

      // 4. Generate conclusion
      this.emitUpdate('progress', { phase: 'concluding', message: '生成分析结论' });
      const conclusion = await this.generateConclusion(sharedContext, allFindings, intent, this.stopReason || undefined);

      this.emitUpdate('conclusion', {
        sessionId,
        summary: conclusion,
        confidence: lastStrategy?.confidence || 0.5,
        rounds: this.currentRound,
      });

      const result: AnalysisResult = {
        sessionId,
        success: true,
        findings: allFindings,
        hypotheses: Array.from(sharedContext.hypotheses.values()),
        conclusion,
        confidence: lastStrategy?.confidence || 0.5,
        rounds: this.currentRound,
        totalDurationMs: Date.now() - startTime,
      };

      this.log(`Analysis complete: ${allFindings.length} findings, ${this.currentRound} rounds`);
      return result;

    } catch (error: any) {
      this.log(`Analysis failed: ${error.message}`);
      this.emitUpdate('error', { message: error.message });

      return {
        sessionId,
        success: false,
        findings: [],
        hypotheses: [],
        conclusion: `分析失败: ${error.message}`,
        confidence: 0,
        rounds: this.currentRound,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  // ==========================================================================
  // Intent Understanding
  // ==========================================================================

  private async understandIntent(query: string): Promise<Intent> {
    const prompt = `分析以下用户查询，提取分析意图：

用户查询: "${query}"

请以 JSON 格式返回：
{
  "primaryGoal": "用户的主要目标",
  "aspects": ["需要分析的方面"],
  "expectedOutputType": "diagnosis | comparison | timeline | summary",
  "complexity": "simple | moderate | complex"
}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'intent_understanding');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as Intent;
      }
    } catch (error) {
      this.log(`Failed to parse intent: ${error}`);
    }

    return {
      primaryGoal: query,
      aspects: ['general'],
      expectedOutputType: 'diagnosis',
      complexity: 'moderate',
    };
  }

  // ==========================================================================
  // Hypothesis Generation
  // ==========================================================================

  private async generateInitialHypotheses(query: string, intent: Intent): Promise<Hypothesis[]> {
    const prompt = `基于以下用户查询，生成可能的性能问题假设：

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
分析方面: ${intent.aspects.join(', ')}

请以 JSON 格式返回假设列表：
{
  "hypotheses": [
    {
      "description": "假设描述",
      "confidence": 0.5,
      "relevantAgents": ["frame_agent", "cpu_agent"]
    }
  ]
}

注意：对于滑动/卡顿类问题，请务必包含以下关键假设方向：
- App 自身运行时间过长（主线程/RenderThread 耗时操作，如布局计算、绘制、业务逻辑）
- 帧率不稳定或掉帧
- CPU 调度不合理（被调度到小核、等待调度时间过长）
- 系统级问题（SurfaceFlinger、GPU、Binder IPC）

可用的 Agent:
${this.agentRegistry.getAgentDescriptionsForLLM()}`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'planning');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return (parsed.hypotheses || []).map((h: any) => ({
          id: createHypothesisId(),
          description: h.description,
          confidence: h.confidence || 0.5,
          status: 'proposed' as const,
          supportingEvidence: [],
          contradictingEvidence: [],
          proposedBy: 'master_orchestrator',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          relevantAgents: h.relevantAgents,
        }));
      }
    } catch (error) {
      this.log(`Failed to generate hypotheses: ${error}`);
    }

    // Default hypothesis based on query keywords
    return this.generateDefaultHypotheses(query, intent);
  }

  private generateDefaultHypotheses(query: string, intent: Intent): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const queryLower = query.toLowerCase();

    if (queryLower.includes('卡顿') || queryLower.includes('jank')) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '帧渲染超时导致卡顿',
        confidence: 0.6,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    if (queryLower.includes('滑动') || queryLower.includes('scroll')) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '滑动过程中存在帧率不稳定或掉帧现象',
        confidence: 0.7,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        relevantAgents: ['frame_agent'],
      });
      hypotheses.push({
        id: createHypothesisId(),
        description: 'App 自身运行时间过长（主线程或 RenderThread 耗时操作导致帧超时）',
        confidence: 0.75,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        relevantAgents: ['frame_agent', 'cpu_agent'],
      });
    }

    if (hypotheses.length === 0) {
      hypotheses.push({
        id: createHypothesisId(),
        description: '存在性能问题需要诊断',
        confidence: 0.5,
        status: 'proposed',
        supportingEvidence: [],
        contradictingEvidence: [],
        proposedBy: 'master_orchestrator',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return hypotheses;
  }

  // ==========================================================================
  // Task Graph Planning
  // ==========================================================================

  private async planTaskGraph(
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    informationGaps: string[],
    options: any
  ): Promise<TaskGraphPlan> {
    const hypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'proposed' || h.status === 'investigating');
    const allowedDomains = ['frame', 'cpu', 'binder', 'memory', 'startup', 'interaction', 'anr', 'system', 'gpu', 'surfaceflinger', 'input', 'art'];

    const prompt = `你是主编排 Agent，需要输出任务图（Task Graph）。任务图要求：
- 每个任务只包含“证据与指标产出”，不要输出最终结论。
- 每个节点必须包含 domain、time_range、evidence_needed。
- domain 必须来自允许列表。

用户查询: "${query}"
分析目标: ${intent.primaryGoal}
当前假设:
${hypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

已确认发现:
${sharedContext.confirmedFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

信息缺口:
${informationGaps.join('\n') || '无'}

可用 domain:
${allowedDomains.join(', ')}

请以 JSON 格式返回：
{
  "reasoning": "简要说明",
  "tasks": [
    {
      "id": "t1",
      "domain": "cpu",
      "description": "要收集的证据或指标",
      "evidence_needed": ["指标1", "指标2"],
      "time_range": { "start": 0, "end": 0 } | null,
      "depends_on": ["t0"],
      "priority": 1
    }
  ]
}

注意：
- time_range 无法确定时请返回 null。
- 只输出 JSON。`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'planning');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        const nodes = tasks.map((task: any, index: number): TaskGraphNode => {
          const id = String(task.id || `task_${index + 1}`);
          const domain = String(task.domain || '').toLowerCase();
          const evidenceNeeded = Array.isArray(task.evidence_needed)
            ? task.evidence_needed.map((e: any) => String(e))
            : Array.isArray(task.evidenceNeeded)
              ? task.evidenceNeeded.map((e: any) => String(e))
              : [];
          const timeRange = this.parseTimeRange(task.time_range ?? task.timeRange, options, sharedContext);
          const dependsOn = Array.isArray(task.depends_on)
            ? task.depends_on.map((d: any) => String(d))
            : Array.isArray(task.dependsOn)
              ? task.dependsOn.map((d: any) => String(d))
              : [];
          const priority = typeof task.priority === 'number' ? task.priority : 5;

          return {
            id,
            domain: domain || 'frame',
            description: String(task.description || task.task || '收集证据'),
            evidenceNeeded,
            timeRange,
            dependsOn,
            priority,
          };
        });

        this.addMandatoryDomainsIfMissing(nodes, query, intent, sharedContext, options);
        return { nodes, reasoning: parsed.reasoning };
      }
    } catch (error) {
      this.log(`Failed to plan task graph: ${error}`);
    }

    const fallbackNodes = this.buildFallbackTaskGraph(query, intent, sharedContext, options);
    this.addMandatoryDomainsIfMissing(fallbackNodes, query, intent, sharedContext, options);
    return { nodes: fallbackNodes };
  }

  private addMandatoryDomainsIfMissing(
    nodes: TaskGraphNode[],
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    options: any
  ): void {
    const queryLower = query.toLowerCase();
    const requiredDomains: string[] = [];

    const scrollOrJank =
      queryLower.includes('滑动') ||
      queryLower.includes('scroll') ||
      queryLower.includes('jank') ||
      queryLower.includes('掉帧') ||
      queryLower.includes('卡顿');

    if (scrollOrJank) {
      requiredDomains.push('frame');
    }

    if (requiredDomains.length === 0) return;

    const existingDomains = new Set(nodes.map(n => this.normalizeDomain(n.domain)));

    for (const domain of requiredDomains) {
      if (existingDomains.has(domain)) continue;
      nodes.push({
        id: `mandatory_${domain}_${Date.now()}`,
        domain,
        description: `补充 ${domain} 关键证据与指标`,
        evidenceNeeded: DEFAULT_EVIDENCE[domain] || ['关键指标', '异常点'],
        timeRange: this.parseTimeRange(null, options, sharedContext),
        dependsOn: [],
        priority: 2,
      });
    }
  }

  private buildFallbackTaskGraph(
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    options: any
  ): TaskGraphNode[] {
    const nodes: TaskGraphNode[] = [];
    const relevantAgents = this.agentRegistry.getAgentsForTopic(query);
    const fallbackAgents = relevantAgents.length > 0
      ? relevantAgents
      : this.agentRegistry.getAll().slice(0, 3);

    fallbackAgents.slice(0, 3).forEach((agent, index) => {
      const domain = agent.config.domain || 'frame';
      nodes.push({
        id: `fallback_${domain}_${index + 1}`,
        domain,
        description: `收集 ${domain} 相关证据与指标`,
        evidenceNeeded: DEFAULT_EVIDENCE[domain] || ['关键指标', '异常点'],
        timeRange: this.parseTimeRange(null, options, sharedContext),
        dependsOn: [],
        priority: 5,
      });
    });

    return nodes;
  }

  private buildTasksFromGraph(
    taskGraph: TaskGraphPlan,
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    options: any
  ): AgentTask[] {
    const tasks: AgentTask[] = [];
    const hypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'proposed' || h.status === 'investigating');

    for (const node of taskGraph.nodes) {
      const resolvedDomain = this.normalizeDomain(node.domain);
      const agentId = this.resolveAgentIdForDomain(resolvedDomain, query);
      if (!agentId) {
        this.log(`No agent for domain: ${node.domain}`);
        continue;
      }
      const evidenceNeeded = node.evidenceNeeded.length > 0
        ? node.evidenceNeeded
        : (DEFAULT_EVIDENCE[resolvedDomain] || ['关键指标', '异常点']);

      tasks.push({
        id: node.id || createTaskId(),
        description: node.description,
        targetAgentId: agentId,
        priority: node.priority || 5,
        context: {
          query,
          intent: {
            primaryGoal: intent.primaryGoal,
            aspects: intent.aspects,
          },
          hypothesis: hypotheses[0],
          domain: resolvedDomain,
          timeRange: node.timeRange,
          evidenceNeeded,
          relevantFindings: sharedContext.confirmedFindings.slice(-5),
          additionalData: {
            traceProcessorService: options.traceProcessorService,
            packageName: options.packageName,
          },
        },
        dependencies: node.dependsOn || [],
        createdAt: Date.now(),
      });
    }

    return tasks;
  }

  // ==========================================================================
  // Staged Scrolling/Jank Orchestration (3-layer)
  // ==========================================================================

  private isScrollingOrJankQuery(query: string): boolean {
    const q = query.toLowerCase();
    return (
      q.includes('滑动') ||
      q.includes('scroll') ||
      q.includes('jank') ||
      q.includes('掉帧') ||
      q.includes('丢帧') ||
      q.includes('卡顿') ||
      q.includes('stutter') ||
      q.includes('fps')
    );
  }

  private getScrollingStage(sharedContext: SharedAgentContext): ScrollingStage {
    const stage = sharedContext.userContext?.scrollingStage;
    if (stage === 'overview' || stage === 'interval_metrics' || stage === 'frame_details') return stage;
    return 'overview';
  }

  private setScrollingStage(sharedContext: SharedAgentContext, stage: ScrollingStage): void {
    sharedContext.userContext = {
      ...(sharedContext.userContext || {}),
      scrollingStage: stage,
    };
  }

  private isLikelyAppProcessName(name: string): boolean {
    const n = (name || '').trim();
    if (!n) return false;
    if (n.startsWith('/')) return false; // e.g. /system/bin/surfaceflinger
    if (n.includes('surfaceflinger')) return false;
    if (n === 'system_server') return false;
    return true;
  }

  private payloadToObjectRows(payload: any): Array<Record<string, any>> {
    if (!payload) return [];

    // Some skill internals might already provide row objects
    if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === 'object' && !Array.isArray(payload[0])) {
      return payload as Array<Record<string, any>>;
    }

    const columns: string[] | undefined = payload.columns;
    const rows: any[][] | undefined = payload.rows;
    if (!Array.isArray(columns) || !Array.isArray(rows)) return [];

    return rows.map((row) => {
      const obj: Record<string, any> = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return obj;
    });
  }

  private extractScrollingFocusSessions(
    responses: AgentResponse[]
  ): ScrollingFocusSession[] {
    // Pull tables from frame_agent scrolling_analysis results
    const frameResponses = responses.filter(r => r.agentId === 'frame_agent' && r.toolResults && r.toolResults.length > 0);

    const scrollSessions: Array<Record<string, any>> = [];
    const jankFrames: Array<Record<string, any>> = [];

    for (const resp of frameResponses) {
      for (const toolResult of resp.toolResults || []) {
        const data = toolResult.data as any;
        if (!data || typeof data !== 'object') continue;

        if (data.scroll_sessions) {
          scrollSessions.push(...this.payloadToObjectRows(data.scroll_sessions));
        }
        if (data.get_app_jank_frames) {
          jankFrames.push(...this.payloadToObjectRows(data.get_app_jank_frames));
        }
      }
    }

    if (scrollSessions.length === 0 || jankFrames.length === 0) return [];

    const toNumber = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // Index sessions by (process_name, session_id)
    const sessionByKey = new Map<string, Record<string, any>>();
    for (const s of scrollSessions) {
      const processName = String(s.process_name ?? '');
      const sessionId = String(s.session_id ?? '');
      if (!processName || !sessionId) continue;
      sessionByKey.set(`${processName}#${sessionId}`, s);
    }

    // Group jank frames by (process_name, session_id)
    const framesByKey = new Map<string, Array<Record<string, any>>>();
    for (const f of jankFrames) {
      const processName = String(f.process_name ?? '');
      const sessionId = String(f.session_id ?? '');
      if (!processName || !sessionId) continue;
      const key = `${processName}#${sessionId}`;
      const list = framesByKey.get(key) || [];
      list.push(f);
      framesByKey.set(key, list);
    }

    const focusSessions: ScrollingFocusSession[] = [];
    for (const [key, frames] of framesByKey.entries()) {
      const session = sessionByKey.get(key);
      if (!session) continue;

      const processName = String(session.process_name ?? '');
      if (!this.isLikelyAppProcessName(processName)) continue;

      const sessionId = toNumber(session.session_id);
      const startTs = toNumber(session.start_ts);
      const endTs = toNumber(session.end_ts);
      if (!startTs || !endTs || endTs <= startTs) continue;

      let maxVsyncMissed = 0;
      for (const f of frames) {
        maxVsyncMissed = Math.max(maxVsyncMissed, toNumber(f.vsync_missed));
      }

      focusSessions.push({
        sessionId,
        processName,
        startTs,
        endTs,
        jankFrameCount: frames.length,
        maxVsyncMissed,
      });
    }

    focusSessions.sort((a, b) =>
      (b.maxVsyncMissed - a.maxVsyncMissed) ||
      (b.jankFrameCount - a.jankFrameCount) ||
      ((b.endTs - b.startTs) - (a.endTs - a.startTs))
    );

    return focusSessions.slice(0, STAGED_SCROLLING_DEFAULTS.maxFocusSessions);
  }

  private formatNsRangeLabel(startTs: number, endTs: number): string {
    const startS = (startTs / 1e9).toFixed(2);
    const endS = (endTs / 1e9).toFixed(2);
    return `${startS}s–${endS}s`;
  }

  private buildStagedScrollingTasks(
    stage: ScrollingStage,
    query: string,
    intent: Intent,
    sharedContext: SharedAgentContext,
    options: any
  ): AgentTask[] {
    const hypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'proposed' || h.status === 'investigating');
    const hypothesis = hypotheses[0];
    const relevantFindings = sharedContext.confirmedFindings.slice(-5);

    const tasks: AgentTask[] = [];

    if (stage === 'overview') {
      tasks.push({
        id: createTaskId(),
        description: '阶段 1/3：先定位滑动区间与掉帧分布（输出 FPS/掉帧率/掉帧列表；不要做逐帧详情）。',
        targetAgentId: 'frame_agent',
        priority: 1,
        context: {
          query,
          intent: { primaryGoal: intent.primaryGoal, aspects: intent.aspects },
          hypothesis,
          domain: 'frame',
          evidenceNeeded: ['scroll sessions', 'fps', 'jank frames', 'jank types distribution'],
          relevantFindings,
          additionalData: {
            traceProcessorService: options.traceProcessorService,
            packageName: options.packageName,
            scopeLabel: '阶段1 · 概览',
            // Do not enable deep frame details in stage 1
            enableFrameDetails: false,
          },
        },
        dependencies: [],
        createdAt: Date.now(),
      });
      return tasks;
    }

    const focusSessions: ScrollingFocusSession[] =
      Array.isArray(sharedContext.userContext?.focusSessions)
        ? (sharedContext.userContext?.focusSessions as ScrollingFocusSession[])
        : [];

    if (focusSessions.length === 0) return tasks;

    if (stage === 'interval_metrics') {
      for (const fs of focusSessions) {
        const scopeLabel = `区间${fs.sessionId} · ${this.formatNsRangeLabel(fs.startTs, fs.endTs)}`;
        const timeRange = { start: fs.startTs, end: fs.endTs };

        tasks.push({
          id: createTaskId(),
          description: `阶段 2/3：在 ${scopeLabel} 内分析 CPU（调度/频率/热点线程）。`,
          targetAgentId: 'cpu_agent',
          priority: 2,
          context: {
            query,
            intent: { primaryGoal: intent.primaryGoal, aspects: intent.aspects },
            hypothesis,
            domain: 'cpu',
            timeRange,
            evidenceNeeded: DEFAULT_EVIDENCE.cpu,
            relevantFindings,
            additionalData: {
              traceProcessorService: options.traceProcessorService,
              packageName: fs.processName,
              scopeLabel,
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });

        tasks.push({
          id: createTaskId(),
          description: `阶段 2/3：在 ${scopeLabel} 内分析内存/GC（是否存在频繁 GC、抖动、主线程 GC 暂停）。`,
          targetAgentId: 'memory_agent',
          priority: 2,
          context: {
            query,
            intent: { primaryGoal: intent.primaryGoal, aspects: intent.aspects },
            hypothesis,
            domain: 'memory',
            timeRange,
            evidenceNeeded: DEFAULT_EVIDENCE.memory,
            relevantFindings,
            additionalData: {
              traceProcessorService: options.traceProcessorService,
              packageName: fs.processName,
              scopeLabel,
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });

        tasks.push({
          id: createTaskId(),
          description: `阶段 2/3：在 ${scopeLabel} 内分析 Binder/锁竞争（慢调用、阻塞点）。`,
          targetAgentId: 'binder_agent',
          priority: 3,
          context: {
            query,
            intent: { primaryGoal: intent.primaryGoal, aspects: intent.aspects },
            hypothesis,
            domain: 'binder',
            timeRange,
            evidenceNeeded: DEFAULT_EVIDENCE.binder,
            relevantFindings,
            additionalData: {
              traceProcessorService: options.traceProcessorService,
              packageName: fs.processName,
              scopeLabel,
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });
      }

      return tasks;
    }

    if (stage === 'frame_details') {
      for (const fs of focusSessions) {
        const scopeLabel = `区间${fs.sessionId} · ${this.formatNsRangeLabel(fs.startTs, fs.endTs)}`;
        const timeRange = { start: fs.startTs, end: fs.endTs };

        tasks.push({
          id: createTaskId(),
          description: `阶段 3/3：在 ${scopeLabel} 内对最严重的掉帧帧做逐帧详情分析（仅分析卡顿点）。`,
          targetAgentId: 'frame_agent',
          priority: 1,
          context: {
            query,
            intent: { primaryGoal: intent.primaryGoal, aspects: intent.aspects },
            hypothesis,
            domain: 'frame',
            timeRange,
            evidenceNeeded: ['jank frame details', 'main thread vs render thread', 'jank responsibility'],
            relevantFindings,
            additionalData: {
              traceProcessorService: options.traceProcessorService,
              packageName: fs.processName,
              scopeLabel,
              enableFrameDetails: true,
              maxFramesPerSession: STAGED_SCROLLING_DEFAULTS.maxFramesPerSession,
            },
          },
          dependencies: [],
          createdAt: Date.now(),
        });
      }
      return tasks;
    }

    return tasks;
  }

  private normalizeDomain(domain: string): string {
    const normalized = domain.toLowerCase();
    return DOMAIN_ALIASES[normalized] || normalized;
  }

  private resolveAgentIdForDomain(domain: string, query: string): string | null {
    const agent = this.agentRegistry.getForDomain(domain);
    if (agent) return agent.config.id;

    // Direct match for agent IDs
    if (this.agentRegistry.get(domain)) {
      return domain;
    }

    const fallbackAgents = this.agentRegistry.getAgentsForTopic(query);
    return fallbackAgents.length > 0 ? fallbackAgents[0].config.id : null;
  }

  private parseTimeRange(
    input: any,
    options: any,
    sharedContext: SharedAgentContext
  ): { start: number; end: number } | undefined {
    if (input && typeof input === 'object' && typeof input.start === 'number' && typeof input.end === 'number') {
      return { start: input.start, end: input.end };
    }
    if (Array.isArray(input) && input.length >= 2 && typeof input[0] === 'number' && typeof input[1] === 'number') {
      return { start: input[0], end: input[1] };
    }
    if (sharedContext.focusedTimeRange) {
      return sharedContext.focusedTimeRange;
    }
    if (options?.timeRange) {
      return options.timeRange;
    }
    return undefined;
  }

  private async executeTaskGraph(tasks: AgentTask[]): Promise<AgentResponse[]> {
    const pending = new Map<string, AgentTask>(tasks.map(task => [task.id, task]));
    const completed = new Set<string>();
    const responses: AgentResponse[] = [];

    while (pending.size > 0) {
      const ready = Array.from(pending.values()).filter(task =>
        (task.dependencies || []).every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        // Avoid deadlock: execute remaining tasks without dependency gating
        const remaining = Array.from(pending.values());
        this.emitUpdate('progress', {
          phase: 'task_graph_stalled',
          pending: remaining.map(t => t.id),
          message: '任务依赖无法满足，继续执行剩余任务',
        });

        const fallbackResponses = await this.messageBus.dispatchTasksParallel(remaining);
        responses.push(...fallbackResponses);
        fallbackResponses.forEach(r => completed.add(r.taskId));
        pending.clear();
        break;
      }

      const batchResponses = await this.messageBus.dispatchTasksParallel(ready);
      responses.push(...batchResponses);
      batchResponses.forEach(r => completed.add(r.taskId));
      ready.forEach(task => pending.delete(task.id));
    }

    return responses;
  }

  private emitDataEnvelopes(responses: AgentResponse[]): void {
    const toolResultCounts = responses.map(r => ({
      agentId: r.agentId,
      toolResults: r.toolResults?.length || 0,
      envelopes: r.toolResults?.reduce((sum, tr) => sum + (tr.dataEnvelopes?.length || 0), 0) || 0,
    }));
    this.log(`emitDataEnvelopes: ${responses.length} responses, tool results: ${JSON.stringify(toolResultCounts)}`);

    const envelopes = responses
      .flatMap(response => response.toolResults || [])
      .flatMap(result => result.dataEnvelopes || []);

    if (envelopes.length > 0) {
      this.log(`Emitting ${envelopes.length} DataEnvelope(s): [${envelopes.map(e => e.meta?.source || 'unknown').join(', ')}]`);
      this.emitUpdate('data', envelopes);
    } else {
      this.log('No DataEnvelopes to emit (all responses had empty toolResults or no envelopes)');
    }
  }

  private evaluateEarlyStop(responses: AgentResponse[], newFindingsCount: number): boolean {
    const failedCount = responses.filter(r => !r.success).length;
    const failureRatio = responses.length > 0 ? failedCount / responses.length : 1;

    if (newFindingsCount === 0) {
      this.noProgressRounds += 1;
    } else {
      this.noProgressRounds = 0;
    }

    if (failureRatio > 0.6) {
      this.failureRounds += 1;
    } else {
      this.failureRounds = 0;
    }

    if (this.noProgressRounds >= this.config.maxNoProgressRounds) {
      this.stopReason = '连续多轮没有新增证据';
      return true;
    }

    if (this.failureRounds >= this.config.maxFailureRounds) {
      this.stopReason = '任务执行失败过多，提前终止';
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Feedback Synthesis
  // ==========================================================================

  private async synthesizeFeedback(
    responses: AgentResponse[],
    sharedContext: SharedAgentContext
  ): Promise<{
    newFindings: Finding[];
    confirmedFindings: Finding[];
    updatedHypotheses: Hypothesis[];
    informationGaps: string[];
  }> {
    const allFindings: Finding[] = [];
    const newFindings: Finding[] = [];

    // Collect all findings
    for (const response of responses) {
      allFindings.push(...response.findings);
    }

    // Deduplicate findings
    const seenTitles = new Set<string>();
    for (const finding of allFindings) {
      if (!seenTitles.has(finding.title)) {
        seenTitles.add(finding.title);
        newFindings.push(finding);
      }
    }

    // Use AI to synthesize
    const prompt = `综合以下 Agent 反馈：

${responses.map(r => `[${r.agentId}]:
- 发现: ${r.findings.map(f => f.title).join(', ') || '无'}
- 置信度: ${r.confidence.toFixed(2)}
- 建议: ${r.suggestions?.join('; ') || '无'}`).join('\n\n')}

当前假设:
${Array.from(sharedContext.hypotheses.values()).map(h => `- ${h.description} (${h.status})`).join('\n')}

请分析：
1. 哪些发现相互印证？
2. 是否存在矛盾？
3. 哪些假设得到支持或被否定？
4. 还缺少什么信息？

请以 JSON 返回：
{
  "correlatedFindings": ["相互印证的发现"],
  "contradictions": ["矛盾"],
  "hypothesisUpdates": [{"hypothesisId": "id", "action": "support/reject", "reason": "原因"}],
  "informationGaps": ["缺失的信息"]
}`;

    let informationGaps: string[] = [];

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'evaluation');
      const jsonMatch = response.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        informationGaps = parsed.informationGaps || [];

        // Process hypothesis updates
        if (parsed.hypothesisUpdates) {
          for (const update of parsed.hypothesisUpdates) {
            const hypothesis = sharedContext.hypotheses.get(update.hypothesisId);
            if (hypothesis) {
              if (update.action === 'support') {
                hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.1);
              } else if (update.action === 'reject') {
                hypothesis.status = 'rejected';
                hypothesis.confidence = 0;
              }
              hypothesis.updatedAt = Date.now();
            }
          }
        }
      }
    } catch (error) {
      this.log(`Failed to synthesize feedback: ${error}`);
    }

    return {
      newFindings,
      confirmedFindings: sharedContext.confirmedFindings,
      updatedHypotheses: Array.from(sharedContext.hypotheses.values()),
      informationGaps,
    };
  }

  // ==========================================================================
  // Conclusion Generation
  // ==========================================================================

  private async generateConclusion(
    sharedContext: SharedAgentContext,
    allFindings: Finding[],
    intent: Intent,
    stopReason?: string
  ): Promise<string> {
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed' || h.confidence >= 0.7);

    const prompt = `基于以下分析结果生成诊断结论：

用户目标: ${intent.primaryGoal}
${stopReason ? `提前终止原因: ${stopReason}` : ''}

已确认的假设:
${confirmedHypotheses.map(h => `- ${h.description} (confidence: ${h.confidence.toFixed(2)})`).join('\n') || '无'}

发现的问题:
${allFindings.map(f => `- [${f.severity}] ${f.title}`).join('\n') || '无'}

调查路径:
${sharedContext.investigationPath.map(s => `${s.stepNumber}. [${s.agentId}] ${s.summary}`).join('\n')}

请生成:
1. 根因分析（最可能的原因）
2. 证据支撑（每个结论的依据）
3. 置信度评估

注意：不要给出优化建议，只需要指出问题所在。`;

    try {
      const response = await this.modelRouter.callWithFallback(prompt, 'synthesis');
      return response.response;
    } catch (error) {
      this.log(`Failed to generate conclusion: ${error}`);
    }

    // Fallback conclusion
    return this.generateSimpleConclusion(allFindings, stopReason);
  }

  private generateSimpleConclusion(findings: Finding[], stopReason?: string): string {
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');

    let conclusion = '## 分析结论\n\n';

    if (critical.length > 0) {
      conclusion += `### 严重问题 (${critical.length})\n`;
      for (const f of critical) {
        conclusion += `- **${f.title}**\n`;
      }
      conclusion += '\n';
    }

    if (warnings.length > 0) {
      conclusion += `### 需要关注 (${warnings.length})\n`;
      for (const f of warnings) {
        conclusion += `- ${f.title}\n`;
      }
      conclusion += '\n';
    }

    if (findings.length === 0) {
      conclusion += '未发现明显的性能问题。\n';
    }

    if (stopReason) {
      conclusion += `\n> 备注：分析提前结束（${stopReason}）。\n`;
    }

    return conclusion;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private buildEvaluation(findings: Finding[], sharedContext: SharedAgentContext): Evaluation {
    const criticalCount = findings.filter(f => f.severity === 'critical').length;
    const confirmedHypotheses = Array.from(sharedContext.hypotheses.values())
      .filter(h => h.status === 'confirmed').length;

    return {
      passed: findings.length > 0,
      qualityScore: Math.min(1, findings.length * 0.1 + confirmedHypotheses * 0.2),
      completenessScore: Math.min(1, findings.length * 0.15),
      contradictions: [],
      feedback: {
        strengths: findings.length > 0 ? ['发现了性能问题'] : [],
        weaknesses: [],
        missingAspects: [],
        improvementSuggestions: [],
        priorityActions: [],
      },
      needsImprovement: findings.length === 0,
      suggestedActions: [],
    };
  }

  private translateStrategy(strategy: string): string {
    const translations: Record<string, string> = {
      'continue': '继续分析',
      'deep_dive': '深入分析',
      'pivot': '转向新方向',
      'conclude': '生成结论',
    };
    return translations[strategy] || strategy;
  }

  private setupEventForwarding(): void {
    this.messageBus.on('task_dispatched', (data) => {
      this.emitUpdate('progress', { phase: 'task_dispatched', ...data });
    });

    this.messageBus.on('task_completed', (data) => {
      this.emitUpdate('progress', { phase: 'task_completed', ...data });
    });

    this.messageBus.on('agent_question', (question) => {
      this.emitUpdate('progress', { phase: 'agent_question', ...question });
    });

    this.messageBus.on('broadcast', (message) => {
      this.emitUpdate('progress', { phase: 'broadcast', ...message });
    });
  }

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

  private log(message: string): void {
    if (this.config.enableLogging) {
      console.log(`[AgentDrivenOrchestrator] ${message}`);
    }
  }

  /**
   * Reset orchestrator state
   */
  reset(): void {
    this.messageBus.reset();
    this.currentRound = 0;
    this.sessionContext = null;
  }
}

/**
 * Create an agent-driven orchestrator
 */
export function createAgentDrivenOrchestrator(
  modelRouter: ModelRouter,
  config?: Partial<AgentDrivenOrchestratorConfig>
): AgentDrivenOrchestrator {
  return new AgentDrivenOrchestrator(modelRouter, config);
}

export default AgentDrivenOrchestrator;
