/**
 * Orchestrator Bridge
 *
 * 桥接 MasterOrchestrator 和前端 SSE 接口
 * 将 MasterOrchestrator 的增强功能集成到现有分析路径
 */

import { MasterOrchestrator } from '../agent/core/masterOrchestrator';
import { MasterOrchestratorResult, StreamingUpdate, Finding } from '../agent/types';
import { AnalysisSessionService } from './analysisSessionService';
import { TraceProcessorService } from './traceProcessorService';
import { AnalysisState } from '../types/analysis';

// =============================================================================
// Types
// =============================================================================

export interface BridgeOptions {
  /** 启用 Hooks 系统 */
  enableHooks?: boolean;
  /** 启用 Context 隔离 */
  enableContextIsolation?: boolean;
  /** 启用 Context 压缩 */
  enableContextCompaction?: boolean;
  /** 启用 Session Fork */
  enableSessionFork?: boolean;
  /** 最大迭代次数 */
  maxTotalIterations?: number;
}

export interface BridgeConfig {
  hooks: { enabled: boolean };
  contextIsolation: { enabled: boolean };
  contextCompaction: { enabled: boolean };
  sessionFork: { enabled: boolean };
  maxTotalIterations: number;
}

// =============================================================================
// OrchestratorBridge
// =============================================================================

/**
 * 桥接 MasterOrchestrator 和前端 SSE 接口
 *
 * 职责：
 * 1. 将 MasterOrchestrator 的事件转换为前端期望的 SSE 格式
 * 2. 管理 MasterOrchestrator 实例生命周期
 * 3. 提供与 PerfettoAnalysisOrchestrator 兼容的接口
 */
export class OrchestratorBridge {
  private sessionService: AnalysisSessionService;
  private traceProcessor: TraceProcessorService;
  private config: BridgeConfig;
  private activeOrchestrators: Map<string, MasterOrchestrator> = new Map();

  constructor(
    sessionService: AnalysisSessionService,
    traceProcessor: TraceProcessorService,
    options: BridgeOptions = {}
  ) {
    this.sessionService = sessionService;
    this.traceProcessor = traceProcessor;

    // 合并配置
    this.config = {
      hooks: { enabled: options.enableHooks ?? true },
      contextIsolation: { enabled: options.enableContextIsolation ?? true },
      contextCompaction: { enabled: options.enableContextCompaction ?? true },
      sessionFork: { enabled: options.enableSessionFork ?? false },
      maxTotalIterations: options.maxTotalIterations ?? 3,
    };
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * 启动分析（与 PerfettoAnalysisOrchestrator.startAnalysis 兼容）
   */
  async startAnalysis(sessionId: string): Promise<void> {
    const session = this.sessionService.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const startTime = Date.now();

    try {
      // 更新状态
      this.sessionService.updateState(sessionId, AnalysisState.GENERATING_SQL);
      this.emitProgress(sessionId, 'starting', '🚀 正在启动 Agent 分析...');

      // 创建 MasterOrchestrator 实例
      const orchestrator = this.createOrchestrator(sessionId);
      this.activeOrchestrators.set(sessionId, orchestrator);

      // 设置事件桥接
      this.setupEventBridge(sessionId, orchestrator);

      // 验证 trace 存在
      const trace = this.traceProcessor.getTrace(session.traceId);
      if (!trace) {
        throw new Error(`Trace not found: ${session.traceId}`);
      }

      // 执行分析（不传 traceProcessor，MasterOrchestrator 会通过 traceProcessorService 访问）
      const result = await orchestrator.handleQuery(
        session.question,
        session.traceId,
        {
          traceProcessorService: this.traceProcessor,
        }
      );

      // 发送完成事件
      this.emitCompletedEvent(sessionId, result, startTime);

      // 更新会话状态
      this.sessionService.completeSession(
        sessionId,
        result.synthesizedAnswer || this.generateAnswerFromResult(result)
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[OrchestratorBridge] Analysis failed for session ${sessionId}:`, error);

      this.emitErrorEvent(sessionId, errorMessage, false);
      this.sessionService.failSession(sessionId, errorMessage);
    } finally {
      // 清理
      this.activeOrchestrators.delete(sessionId);
    }
  }

  /**
   * 检查是否有活跃的分析
   */
  hasActiveAnalysis(sessionId: string): boolean {
    return this.activeOrchestrators.has(sessionId);
  }

  /**
   * 获取配置
   */
  getConfig(): BridgeConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // Private Methods - Orchestrator Management
  // ===========================================================================

  /**
   * 创建 MasterOrchestrator 实例
   */
  private createOrchestrator(sessionId: string): MasterOrchestrator {
    return new MasterOrchestrator({
      stateMachineConfig: {
        sessionId,
        traceId: '', // Will be set by handleQuery
      },
      maxTotalIterations: this.config.maxTotalIterations,
      enableTraceRecording: true,
      // Note: modelRouterConfig will use defaults from MasterOrchestrator
    });
  }

  /**
   * 设置事件桥接
   */
  private setupEventBridge(sessionId: string, orchestrator: MasterOrchestrator): void {
    orchestrator.on('update', (update: StreamingUpdate) => {
      this.handleOrchestratorUpdate(sessionId, update);
    });
  }

  /**
   * 处理 MasterOrchestrator 的更新事件
   * StreamingUpdate.content 是 any 类型，包含不同类型的数据
   */
  private handleOrchestratorUpdate(sessionId: string, update: StreamingUpdate): void {
    const content = update.content as any;

    switch (update.type) {
      case 'progress':
        this.emitProgress(sessionId, content?.phase || 'processing', content?.message || '处理中...');
        break;

      case 'finding':
        if (content?.finding) {
          this.handleFindingUpdate(sessionId, content.finding);
        }
        break;

      case 'skill_data':
        // 直接透传 skill 数据到前端
        this.emitSkillLayeredResult(sessionId, content);
        break;

      case 'conclusion':
        // 最终答案会在 startAnalysis 的 try 块中处理
        break;

      case 'error':
        this.emitErrorEvent(sessionId, content?.message || 'Unknown error', content?.recoverable ?? false);
        break;

      case 'worker_thought':
        // Worker 思考过程，转换为前端可理解的 progress 格式
        this.emitWorkerThought(sessionId, content);
        break;

      case 'thought':
        // Agent 思考过程（来自 PlannerAgent/EvaluatorAgent）
        this.emitAgentThought(sessionId, content);
        break;

      default:
        // 处理其他未知类型
        console.log(`[OrchestratorBridge] Received unhandled update type: ${update.type}`);
    }
  }

  /**
   * 处理 Finding 更新
   */
  private handleFindingUpdate(sessionId: string, finding: Finding): void {
    // 转换 Finding 到前端期望的 diagnostic 格式
    // Finding 接口: { id, category, severity, title, description, evidence, relatedTimestamps?, timestampsNs? }
    const diagnostic = {
      id: finding.id,
      severity: finding.severity,
      message: finding.title,
      details: finding.description,
      // Finding 没有 recommendations/suggestions 字段，留空
      suggestions: [] as string[],
    };

    this.sessionService.emitSSE(sessionId, {
      type: 'skill_diagnostics',
      timestamp: Date.now(),
      data: { diagnostics: [diagnostic] },
    });
  }

  // ===========================================================================
  // Private Methods - Event Emission
  // ===========================================================================

  /**
   * 发送进度事件
   */
  private emitProgress(sessionId: string, step: string, message: string): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'progress',
      timestamp: Date.now(),
      data: { step, message },
    });
  }

  /**
   * 发送 skill 分层结果
   */
  private emitSkillLayeredResult(sessionId: string, data: any): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'skill_layered_result',
      timestamp: Date.now(),
      data,
    });
  }

  /**
   * 发送完成事件
   */
  private emitCompletedEvent(
    sessionId: string,
    result: MasterOrchestratorResult,
    startTime: number
  ): void {
    const session = this.sessionService.getSession(sessionId);
    const reportUrl = `/api/reports/view/${sessionId}`;

    this.sessionService.emitSSE(sessionId, {
      type: 'analysis_completed',
      timestamp: Date.now(),
      data: {
        sessionId,
        answer: result.synthesizedAnswer || this.generateAnswerFromResult(result),
        metrics: {
          totalDuration: Date.now() - startTime,
          iterationsCount: result.iterationCount || 0,
          sqlQueriesCount: result.stageResults?.length || 0,
        },
        reportUrl,
      },
    });
  }

  /**
   * 发送错误事件
   */
  private emitErrorEvent(sessionId: string, error: string, recoverable: boolean): void {
    this.sessionService.emitSSE(sessionId, {
      type: 'error',
      timestamp: Date.now(),
      data: { error, recoverable },
    });
  }

  /**
   * 发送 Worker 思考事件
   * worker_thought 包含: { agent, skillId, step, data? }
   */
  private emitWorkerThought(sessionId: string, content: any): void {
    const stepMessages: Record<string, string> = {
      'skill_selection': '🎯 正在选择分析技能...',
      'skill_start': `🔧 正在执行 ${content?.skillId || '技能'}...`,
      'skill_complete': `✅ ${content?.skillId || '技能'} 执行完成`,
      'analyzing': '📊 正在分析数据...',
    };

    const message = stepMessages[content?.step] ||
      `💭 ${content?.agent || 'Worker'}: ${content?.step || '处理中...'}`;

    this.sessionService.emitSSE(sessionId, {
      type: 'progress',
      timestamp: Date.now(),
      data: {
        step: content?.step || 'worker_thought',
        message,
        agent: content?.agent,
        skillId: content?.skillId,
      },
    });
  }

  /**
   * 发送 Agent 思考事件
   * thought 包含: { agent, ...data }
   */
  private emitAgentThought(sessionId: string, content: any): void {
    const agentLabels: Record<string, string> = {
      'planner': '📋 规划器',
      'evaluator': '🔍 评估器',
    };

    const agentLabel = agentLabels[content?.agent] || `🤖 ${content?.agent || 'Agent'}`;

    this.sessionService.emitSSE(sessionId, {
      type: 'progress',
      timestamp: Date.now(),
      data: {
        step: 'agent_thought',
        message: `${agentLabel}: ${content?.message || '思考中...'}`,
        agent: content?.agent,
      },
    });
  }

  // ===========================================================================
  // Private Methods - Result Processing
  // ===========================================================================

  /**
   * 从结果生成答案（当没有 synthesizedAnswer 时的后备方案）
   */
  private generateAnswerFromResult(result: MasterOrchestratorResult): string {
    if (!result.stageResults || result.stageResults.length === 0) {
      return '分析完成，但未发现明显问题。';
    }

    // 收集所有 findings
    const findings: Finding[] = [];
    for (const stageResult of result.stageResults) {
      if (stageResult.findings) {
        findings.push(...stageResult.findings);
      }
    }

    if (findings.length === 0) {
      return '分析完成，未发现性能问题。';
    }

    // 按严重程度分组
    const critical = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const infos = findings.filter(f => f.severity === 'info');

    let answer = '## 分析结果\n\n';

    if (critical.length > 0) {
      answer += `### 🔴 严重问题 (${critical.length})\n`;
      for (const f of critical) {
        answer += `- **${f.title}**: ${f.description || ''}\n`;
      }
      answer += '\n';
    }

    if (warnings.length > 0) {
      answer += `### 🟡 需要关注 (${warnings.length})\n`;
      for (const f of warnings) {
        answer += `- **${f.title}**: ${f.description || ''}\n`;
      }
      answer += '\n';
    }

    if (infos.length > 0) {
      answer += `### ℹ️ 信息 (${infos.length})\n`;
      for (const f of infos) {
        answer += `- ${f.title}\n`;
      }
      answer += '\n';
    }

    return answer;
  }
}

// =============================================================================
// Factory and Singleton
// =============================================================================

let _globalBridge: OrchestratorBridge | null = null;

/**
 * 获取全局 OrchestratorBridge 实例
 */
export function getOrchestratorBridge(
  sessionService: AnalysisSessionService,
  traceProcessor: TraceProcessorService,
  options?: BridgeOptions
): OrchestratorBridge {
  if (!_globalBridge) {
    _globalBridge = new OrchestratorBridge(sessionService, traceProcessor, options);
  }
  return _globalBridge;
}

/**
 * 重置全局 OrchestratorBridge 实例
 */
export function resetOrchestratorBridge(): void {
  _globalBridge = null;
}

/**
 * 创建新的 OrchestratorBridge 实例
 */
export function createOrchestratorBridge(
  sessionService: AnalysisSessionService,
  traceProcessor: TraceProcessorService,
  options?: BridgeOptions
): OrchestratorBridge {
  return new OrchestratorBridge(sessionService, traceProcessor, options);
}

export default OrchestratorBridge;
