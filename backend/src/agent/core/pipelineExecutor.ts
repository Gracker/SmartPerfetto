/**
 * SmartPerfetto Pipeline Executor
 *
 * @deprecated Not used in Agent-Driven architecture (v5.0). See executors/strategyExecutor.ts.
 *
 * 流水线执行器，负责：
 * 1. 按阶段顺序执行分析任务
 * 2. 管理阶段依赖关系
 * 3. 支持并行执行
 * 4. 检查点和恢复
 * 5. 错误处理和重试
 * 6. 生命周期钩子支持
 */

import { EventEmitter } from 'events';
import {
  PipelineStage,
  StageResult,
  PipelineConfig,
  PipelineErrorDecision,
  PipelineResult,
  PipelineCallbacks,
  PipelineProgress,
  Finding,
  SubAgentContext,
  SubAgentResult,
} from '../types';
import {
  HookRegistry,
  getHookRegistry,
  HookContext,
  createHookContext,
  SubAgentEventData,
} from '../hooks';
import {
  ContextBuilder,
  getContextBuilder,
} from '../context';
import { pipelineConfig as pipeConfig } from '../../config';

// 默认阶段定义 (从统一配置文件获取 timeouts 和 retries)
const DEFAULT_STAGES: PipelineStage[] = [
  {
    id: 'plan',
    name: '任务规划',
    description: '理解用户意图，分解分析任务',
    agentType: 'planner',
    dependencies: [],
    canParallelize: false,
    timeout: pipeConfig.stageTimeouts.planner,
    maxRetries: pipeConfig.stageMaxRetries.planner,
  },
  {
    id: 'execute',
    name: '专家分析',
    description: '执行具体的性能分析任务',
    agentType: 'worker',
    dependencies: ['plan'],
    canParallelize: true,
    timeout: pipeConfig.stageTimeouts.analysis,
    maxRetries: pipeConfig.stageMaxRetries.analysis,
  },
  {
    id: 'evaluate',
    name: '结果评估',
    description: '评估分析结果的质量和完整性',
    agentType: 'evaluator',
    dependencies: ['execute'],
    canParallelize: false,
    timeout: pipeConfig.stageTimeouts.evaluation,
    maxRetries: pipeConfig.stageMaxRetries.evaluation,
  },
  {
    id: 'refine',
    name: '优化迭代',
    description: '根据评估反馈优化分析结果',
    agentType: 'worker',
    dependencies: ['evaluate'],
    canParallelize: false,
    timeout: pipeConfig.stageTimeouts.synthesis,
    maxRetries: pipeConfig.stageMaxRetries.synthesis,
  },
  {
    id: 'conclude',
    name: '综合结论',
    description: '综合所有发现，生成最终答案',
    agentType: 'synthesizer',
    dependencies: ['refine'],
    canParallelize: false,
    timeout: pipeConfig.stageTimeouts.decision,
    maxRetries: pipeConfig.stageMaxRetries.decision,
  },
];

// 默认配置 (从统一配置文件获取)
const DEFAULT_CONFIG: Partial<PipelineConfig> = {
  maxTotalDuration: pipeConfig.maxTotalDurationMs,
  enableParallelization: pipeConfig.enableParallelization,
};

/**
 * 阶段执行器接口
 */
export interface StageExecutor {
  execute(stage: PipelineStage, context: SubAgentContext): Promise<SubAgentResult>;
}

/**
 * 流水线执行器实现
 *
 * @deprecated This class is no longer used in the Agent-Driven architecture (v5.0).
 * The new architecture uses StrategyExecutor for deterministic stage pipelines and
 * HypothesisExecutor for adaptive multi-round analysis. Retained for reference.
 * Will be removed in v6.0.
 */
export class PipelineExecutor extends EventEmitter {
  private config: PipelineConfig;
  private stages: Map<string, PipelineStage>;
  private stageResults: Map<string, StageResult>;
  private executors: Map<string, StageExecutor>;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private isCancelled: boolean = false;
  private startTime: number = 0;
  private hookRegistry: HookRegistry;
  private hookContext: HookContext | null = null;
  private contextBuilder: ContextBuilder;

  constructor(
    config: Partial<PipelineConfig> = {},
    hookRegistry?: HookRegistry,
    contextBuilder?: ContextBuilder
  ) {
    super();

    // Honor an explicitly provided stage list (including an empty list), and fall back to defaults
    // only when stages are omitted.
    const stages = (config.stages !== undefined) ? config.stages : DEFAULT_STAGES;

    this.config = {
      stages,
      maxTotalDuration: config.maxTotalDuration || DEFAULT_CONFIG.maxTotalDuration!,
      enableParallelization: config.enableParallelization ?? true,
      onStageComplete: config.onStageComplete,
      onStageError: config.onStageError,
    };

    // 构建阶段索引
    this.stages = new Map();
    for (const stage of stages) {
      this.stages.set(stage.id, stage);
    }

    this.stageResults = new Map();
    this.executors = new Map();
    this.hookRegistry = hookRegistry || getHookRegistry();
    this.contextBuilder = contextBuilder || getContextBuilder();
  }

  // ==========================================================================
  // 执行器注册
  // ==========================================================================

  /**
   * 注册阶段执行器
   */
  registerExecutor(key: string, executor: StageExecutor): void {
    // `key` can be either:
    // - a concrete stage id (e.g. "plan", "execute") for stage-specific executors, or
    // - an agentType (e.g. "planner", "worker") for reusable executors.
    this.executors.set(key, executor);
  }

  /**
   * 注册多个阶段执行器
   */
  registerExecutors(executors: Record<string, StageExecutor>): void {
    for (const [stageId, executor] of Object.entries(executors)) {
      this.registerExecutor(stageId, executor);
    }
  }

  // ==========================================================================
  // 流水线执行
  // ==========================================================================

  /**
   * 执行完整流水线
   */
  async execute(
    context: SubAgentContext,
    callbacks?: Partial<PipelineCallbacks>,
    startFromStage?: string
  ): Promise<PipelineResult> {
    if (this.isRunning) {
      throw new Error('Pipeline is already running');
    }

    this.isRunning = true;
    this.isPaused = false;
    this.isCancelled = false;
    this.startTime = Date.now();

    // 初始化 hook context
    this.hookContext = createHookContext(
      context.sessionId,
      context.traceId || '',
      'pipeline'
    );

    const completedStages: string[] = [];
    const failedStages: string[] = [];

    try {
      // 获取执行顺序
      const executionOrder = this.getExecutionOrder(startFromStage);
      const totalStages = executionOrder.length;
      let startedStageCount = 0;

      for (let i = 0; i < executionOrder.length;) {
        const stage = executionOrder[i];

        if (this.isCancelled) {
          return this.createErrorResult(completedStages, failedStages, 'Pipeline cancelled');
        }

        // 检查是否暂停
        if (this.isPaused) {
          return this.createPausedResult(completedStages, failedStages, stage.id);
        }

        // 检查超时
        if (this.isTimedOut()) {
          throw new PipelineTimeoutError(
            `Pipeline timed out after ${this.config.maxTotalDuration}ms`
          );
        }

        // 并行执行：将连续可并行阶段聚合为一组并发执行
        if (this.config.enableParallelization && stage.canParallelize) {
          const group: PipelineStage[] = [];
          let j = i;

          while (j < executionOrder.length && executionOrder[j].canParallelize) {
            const candidate = executionOrder[j];

            // 如果候选阶段依赖于当前 group 内阶段，则不能并行，结束本组，留给下一轮执行
            if (group.some(s => candidate.dependencies.includes(s.id))) {
              break;
            }

            const dependenciesMet = await this.waitForDependencies(candidate);
            if (!dependenciesMet) {
              // 依赖不满足（缺失/失败）则跳过该阶段
              failedStages.push(candidate.id);
              j++;
              continue;
            }

            callbacks?.onStageStart?.(candidate);
            this.emit('stageStart', candidate);

            const progress = this.calculateProgress(startedStageCount, totalStages, candidate.id);
            startedStageCount++;
            callbacks?.onProgress?.(progress);
            this.emit('progress', progress);

            group.push(candidate);
            j++;
          }

          const results = await this.executeParallel(group, context, callbacks);

          for (let k = 0; k < results.length; k++) {
            const result = results[k];
            const stageForResult = group[k];

            this.stageResults.set(result.stageId, result);

            if (result.success) {
              completedStages.push(result.stageId);
              callbacks?.onStageComplete?.(stageForResult, result);
              this.config.onStageComplete?.(stageForResult, result);
              this.emit('stageComplete', { stage: stageForResult, result });
            } else {
              failedStages.push(result.stageId);

              const decision = await this.handleStageError(stageForResult, result.error!, callbacks);

              if (decision === 'abort') {
                throw new PipelineAbortError(`Pipeline aborted at stage: ${result.stageId}`);
              } else if (decision === 'ask_user') {
                return this.createPausedResult(completedStages, failedStages, result.stageId);
              }
            }
          }

          if (this.isCancelled) {
            return this.createErrorResult(completedStages, failedStages, 'Pipeline cancelled');
          }

          i = j;
          continue;
        }

        // 串行执行单个阶段
        const dependenciesMet = await this.waitForDependencies(stage);
        if (!dependenciesMet) {
          failedStages.push(stage.id);
          i++;
          continue;
        }

        callbacks?.onStageStart?.(stage);
        this.emit('stageStart', stage);

        const progress = this.calculateProgress(startedStageCount, totalStages, stage.id);
        startedStageCount++;
        callbacks?.onProgress?.(progress);
        this.emit('progress', progress);

        const result = await this.executeStage(stage, context, callbacks);
        this.stageResults.set(stage.id, result);

        if (result.success) {
          completedStages.push(stage.id);
          callbacks?.onStageComplete?.(stage, result);
          this.config.onStageComplete?.(stage, result);
          this.emit('stageComplete', { stage, result });
        } else {
          failedStages.push(stage.id);

          const decision = await this.handleStageError(stage, result.error!, callbacks);

          if (decision === 'abort') {
            throw new PipelineAbortError(`Pipeline aborted at stage: ${stage.id}`);
          } else if (decision === 'ask_user') {
            return this.createPausedResult(completedStages, failedStages, stage.id);
          }
        }

        if (this.isCancelled) {
          return this.createErrorResult(completedStages, failedStages, 'Pipeline cancelled');
        }

        i++;
      }

      return this.createSuccessResult(completedStages, failedStages);
    } catch (error: any) {
      return this.createErrorResult(completedStages, failedStages, error.message);
    } finally {
      this.isRunning = false;
      // 清理 hook context
      this.hookContext = null;
    }
  }

  /**
   * 从检查点恢复执行
   */
  async resumeFrom(
    checkpointStageId: string,
    context: SubAgentContext,
    previousResults: StageResult[],
    callbacks?: Partial<PipelineCallbacks>
  ): Promise<PipelineResult> {
    // 恢复之前的结果
    for (const result of previousResults) {
      this.stageResults.set(result.stageId, result);
    }

    // 从指定阶段继续执行
    return this.execute(context, callbacks, checkpointStageId);
  }

  /**
   * 执行单个阶段
   */
  private async executeStage(
    stage: PipelineStage,
    context: SubAgentContext,
    _callbacks?: Partial<PipelineCallbacks>
  ): Promise<StageResult> {
    const startTime = Date.now();
    let retryCount = 0;

    // === SubAgent Start Pre-Hook ===
    const subAgentEventData: SubAgentEventData = {
      agentId: stage.id,
      agentName: stage.name,
      agentType: stage.agentType,
      stageId: stage.id,
    };
    const preResult = await this.hookRegistry.executePre(
      'subagent:start',
      context.sessionId,
      subAgentEventData,
      this.hookContext || undefined
    );

    if (!preResult.continue) {
      // Hook 要求跳过此阶段
      console.log(`[PipelineExecutor] Stage ${stage.id} skipped by hook`);
      return {
        stageId: stage.id,
        success: false,
        error: 'Skipped by hook',
        findings: [],
        startTime,
        endTime: Date.now(),
        retryCount: 0,
      };
    }

    while (retryCount <= stage.maxRetries) {
      try {
        // 获取执行器
        const executor =
          this.executors.get(stage.id) ??
          this.executors.get(stage.agentType);
        if (!executor) {
          throw new Error(
            `No executor registered for stage: ${stage.id} (type: ${stage.agentType})`
          );
        }

        // 准备上下文，包含之前阶段的结果
        const enrichedContext: SubAgentContext = {
          ...context,
          previousResults: Array.from(this.stageResults.values()),
        };

        // 应用 Context 隔离
        const isolatedContext = this.contextBuilder.buildContext(enrichedContext, stage);

        // Keep execution output quiet in production/test runs; tracing should be done via events/hooks.

        // 创建超时 Promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new StageTimeoutError(`Stage ${stage.id} timed out after ${stage.timeout}ms`));
          }, stage.timeout);
        });

        // 执行阶段（使用隔离后的上下文）
        const result = await Promise.race([
          executor.execute(stage, isolatedContext as SubAgentContext),
          timeoutPromise,
        ]);

        const stageResult: StageResult = {
          stageId: stage.id,
          success: result.success,
          data: result.data,
          findings: result.findings,
          startTime,
          endTime: Date.now(),
          retryCount,
        };

        // === SubAgent Complete Post-Hook ===
        await this.hookRegistry.executePost(
          'subagent:complete',
          context.sessionId,
          {
            ...subAgentEventData,
            result: stageResult,
            durationMs: Date.now() - startTime,
          },
          this.hookContext || undefined
        );

        return stageResult;
      } catch (error: any) {
        retryCount++;

        if (retryCount > stage.maxRetries) {
          const errorResult: StageResult = {
            stageId: stage.id,
            success: false,
            error: error.message,
            findings: [],
            startTime,
            endTime: Date.now(),
            retryCount: retryCount - 1,
          };

          // === SubAgent Error Post-Hook ===
          await this.hookRegistry.executePost(
            'subagent:error',
            context.sessionId,
            {
              ...subAgentEventData,
              error: error instanceof Error ? error : new Error(String(error)),
              durationMs: Date.now() - startTime,
            },
            this.hookContext || undefined
          );

          return errorResult;
        }

        // 等待后重试
        await this.delay(1000 * retryCount);
      }
    }

    // 不应该到达这里
    return {
      stageId: stage.id,
      success: false,
      error: 'Unexpected execution path',
      findings: [],
      startTime,
      endTime: Date.now(),
      retryCount,
    };
  }

  /**
   * 处理阶段错误
   */
  private async handleStageError(
    stage: PipelineStage,
    error: string,
    callbacks?: Partial<PipelineCallbacks>
  ): Promise<PipelineErrorDecision> {
    // 使用配置的错误处理器
    if (this.config.onStageError) {
      return this.config.onStageError(stage, new Error(error));
    }

    // 使用回调的错误处理器
    if (callbacks?.onError) {
      return callbacks.onError(stage, new Error(error));
    }

    // 默认行为：重试失败则跳过
    return 'skip';
  }

  // ==========================================================================
  // 依赖管理
  // ==========================================================================

  /**
   * 获取执行顺序（拓扑排序）
   */
  private getExecutionOrder(startFromStage?: string): PipelineStage[] {
    const stages = Array.from(this.stages.values());

    // 简单实现：按依赖排序
    const sorted: PipelineStage[] = [];
    const visited = new Set<string>();

    const visit = (stage: PipelineStage) => {
      if (visited.has(stage.id)) return;
      visited.add(stage.id);

      // 先访问依赖
      for (const depId of stage.dependencies) {
        const dep = this.stages.get(depId);
        if (dep) {
          visit(dep);
        }
      }

      sorted.push(stage);
    };

    for (const stage of stages) {
      visit(stage);
    }

    // 如果指定了起始阶段，跳过之前的阶段
    if (startFromStage) {
      const startIndex = sorted.findIndex(s => s.id === startFromStage);
      if (startIndex >= 0) {
        return sorted.slice(startIndex);
      }
    }

    return sorted;
  }

  /**
   * 等待依赖阶段完成
   */
  private async waitForDependencies(stage: PipelineStage): Promise<boolean> {
    for (const depId of stage.dependencies) {
      const depResult = this.stageResults.get(depId);

      if (!depResult) {
        // 依赖还未执行
        return false;
      }

      if (!depResult.success) {
        // 依赖执行失败
        this.emit('dependencyFailed', { stage: stage.id, dependency: depId });
        return false;
      }
    }

    return true;
  }

  // ==========================================================================
  // 并行执行
  // ==========================================================================

  /**
   * 并行执行一组阶段
   */
  async executeParallel(
    stages: PipelineStage[],
    context: SubAgentContext,
    callbacks?: Partial<PipelineCallbacks>
  ): Promise<StageResult[]> {
    if (!this.config.enableParallelization) {
      // 回退到串行执行
      const results: StageResult[] = [];
      for (const stage of stages) {
        const result = await this.executeStage(stage, context, callbacks);
        results.push(result);
      }
      return results;
    }

    // 并行执行
    return Promise.all(
      stages.map(stage => this.executeStage(stage, context, callbacks))
    );
  }

  /**
   * 获取可并行执行的阶段组
   */
  getParallelGroups(): PipelineStage[][] {
    const groups: PipelineStage[][] = [];
    const remaining = new Set(this.stages.keys());
    const completed = new Set<string>();

    while (remaining.size > 0) {
      const group: PipelineStage[] = [];

      for (const stageId of remaining) {
        const stage = this.stages.get(stageId)!;
        const depsComplete = stage.dependencies.every(d => completed.has(d));

        if (depsComplete && stage.canParallelize) {
          group.push(stage);
        } else if (depsComplete && group.length === 0) {
          // 不可并行的阶段单独成组
          group.push(stage);
          break;
        }
      }

      if (group.length === 0) {
        // 防止无限循环
        break;
      }

      groups.push(group);

      for (const stage of group) {
        remaining.delete(stage.id);
        completed.add(stage.id);
      }
    }

    return groups;
  }

  // ==========================================================================
  // 流程控制
  // ==========================================================================

  /**
   * 暂停执行
   */
  pause(): void {
    this.isPaused = true;
    this.emit('paused');
  }

  /**
   * 恢复执行
   */
  resume(): void {
    this.isPaused = false;
    this.emit('resumed');
  }

  /**
   * 取消执行
   */
  cancel(): void {
    this.isCancelled = true;
    this.emit('cancelled');
  }

  /**
   * 检查是否超时
   */
  private isTimedOut(): boolean {
    return Date.now() - this.startTime > this.config.maxTotalDuration;
  }

  // ==========================================================================
  // 结果和状态
  // ==========================================================================

  /**
   * 获取阶段结果
   */
  getStageResult(stageId: string): StageResult | undefined {
    return this.stageResults.get(stageId);
  }

  /**
   * 获取所有阶段结果
   */
  getAllResults(): StageResult[] {
    return Array.from(this.stageResults.values());
  }

  /**
   * 获取所有发现
   */
  getAllFindings(): Finding[] {
    const findings: Finding[] = [];
    for (const result of this.stageResults.values()) {
      findings.push(...result.findings);
    }
    return findings;
  }

  /**
   * 计算进度
   */
  private calculateProgress(
    currentIndex: number,
    totalStages: number,
    stageId?: string
  ): PipelineProgress {
    const elapsedMs = Date.now() - this.startTime;
    const avgStageTime = currentIndex > 0 ? elapsedMs / currentIndex : 10000;
    const remainingStages = totalStages - currentIndex;
    const estimatedRemainingMs = remainingStages * avgStageTime;

    return {
      currentStage: stageId || 'unknown',
      completedStages: currentIndex,
      totalStages,
      elapsedMs,
      estimatedRemainingMs,
    };
  }

  // ==========================================================================
  // 结果构建
  // ==========================================================================

  private createSuccessResult(
    completedStages: string[],
    failedStages: string[]
  ): PipelineResult {
    return {
      success: failedStages.length === 0,
      stageResults: Array.from(this.stageResults.values()),
      totalDuration: Date.now() - this.startTime,
      completedStages,
      failedStages,
    };
  }

  private createErrorResult(
    completedStages: string[],
    failedStages: string[],
    error: string
  ): PipelineResult {
    return {
      success: false,
      stageResults: Array.from(this.stageResults.values()),
      totalDuration: Date.now() - this.startTime,
      completedStages,
      failedStages,
      error,
    };
  }

  private createPausedResult(
    completedStages: string[],
    failedStages: string[],
    pausedAt: string
  ): PipelineResult {
    return {
      success: false,
      stageResults: Array.from(this.stageResults.values()),
      totalDuration: Date.now() - this.startTime,
      completedStages,
      failedStages,
      pausedAt,
    };
  }

  // ==========================================================================
  // 工具方法
  // ==========================================================================

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取阶段列表
   */
  getStages(): PipelineStage[] {
    return Array.from(this.stages.values());
  }

  /**
   * 获取阶段
   */
  getStage(stageId: string): PipelineStage | undefined {
    return this.stages.get(stageId);
  }

  /**
   * 重置执行器状态
   */
  reset(): void {
    this.stageResults.clear();
    this.isRunning = false;
    this.isPaused = false;
    this.isCancelled = false;
    this.emit('reset');
  }
}

/**
 * 流水线超时错误
 */
class PipelineTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineTimeoutError';
  }
}

/**
 * 流水线中止错误
 */
class PipelineAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineAbortError';
  }
}

/**
 * 阶段超时错误
 */
class StageTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageTimeoutError';
  }
}

export { PipelineTimeoutError, PipelineAbortError, StageTimeoutError };
export default PipelineExecutor;
