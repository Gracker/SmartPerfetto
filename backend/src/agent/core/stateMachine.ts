/**
 * SmartPerfetto Agent State Machine
 *
 * @deprecated Not used in Agent-Driven architecture (v5.0). See agentDrivenOrchestrator.ts.
 *
 * 状态机核心组件，负责：
 * 1. 管理 Agent 生命周期状态转换
 * 2. 检查点持久化和恢复
 * 3. 迭代计数器管理
 * 4. 事件记录和回放
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  AgentPhase,
  StateEvent,
  StateEventType,
  Checkpoint,
  SerializedAgentState,
  StateMachineConfig,
  AgentStateMachineState,
  StageResult,
  Finding,
  Intent,
  AnalysisPlan,
  ExpertResult,
} from '../types';

// 默认持久化路径
const DEFAULT_PERSIST_PATH = path.join(process.cwd(), 'agent-state');

// 状态转换规则定义
const STATE_TRANSITIONS: Record<AgentPhase, AgentPhase[]> = {
  [AgentPhase.IDLE]: [AgentPhase.PLANNING, AgentPhase.FAILED],
  [AgentPhase.PLANNING]: [AgentPhase.EXECUTING, AgentPhase.AWAITING_USER, AgentPhase.FAILED],
  [AgentPhase.EXECUTING]: [AgentPhase.EVALUATING, AgentPhase.AWAITING_USER, AgentPhase.FAILED],
  [AgentPhase.EVALUATING]: [AgentPhase.REFINING, AgentPhase.COMPLETED, AgentPhase.AWAITING_USER, AgentPhase.FAILED],
  [AgentPhase.REFINING]: [AgentPhase.EXECUTING, AgentPhase.EVALUATING, AgentPhase.COMPLETED, AgentPhase.AWAITING_USER, AgentPhase.FAILED],  // 添加 completed，允许从 refining 直接完成
  [AgentPhase.AWAITING_USER]: [AgentPhase.PLANNING, AgentPhase.EXECUTING, AgentPhase.EVALUATING, AgentPhase.REFINING, AgentPhase.COMPLETED, AgentPhase.FAILED],
  [AgentPhase.COMPLETED]: [], // 终态
  [AgentPhase.FAILED]: [AgentPhase.IDLE], // 可以重新开始
};

/**
 * Agent 状态机实现
 *
 * 核心职责：
 * - 状态转换管理和验证
 * - 检查点创建和恢复
 * - 持久化存储
 * - 事件钩子
 *
 * @deprecated This class is no longer used in the Agent-Driven architecture (v5.0).
 * The new architecture uses AgentDrivenOrchestrator with StrategyExecutor/HypothesisExecutor
 * which manage their own lifecycle internally. Retained for potential future integration
 * with session persistence. Will be removed in v6.0.
 */
export class AgentStateMachine extends EventEmitter {
  private state: AgentStateMachineState;
  private config: StateMachineConfig;
  private autoSaveTimer?: NodeJS.Timeout;

  constructor(config: StateMachineConfig) {
    super();
    this.config = {
      ...config,
      persistPath: config.persistPath || DEFAULT_PERSIST_PATH,
      autoSave: config.autoSave ?? true,
      autoSaveIntervalMs: config.autoSaveIntervalMs || 5000,
    };

    // 初始化状态
    this.state = {
      sessionId: config.sessionId,
      traceId: config.traceId,
      phase: AgentPhase.IDLE,
      checkpoints: new Map(),
      iterationCounters: new Map(),
      currentStageIndex: 0,
      stageResults: new Map(),
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 确保持久化目录存在
    this.ensurePersistPath();

    // 启动自动保存
    if (this.config.autoSave) {
      this.startAutoSave();
    }
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  get sessionId(): string {
    return this.state.sessionId;
  }

  get traceId(): string {
    return this.state.traceId;
  }

  get phase(): AgentPhase {
    return this.state.phase;
  }

  get currentStageIndex(): number {
    return this.state.currentStageIndex;
  }

  get isCompleted(): boolean {
    return this.state.phase === AgentPhase.COMPLETED;
  }

  get isFailed(): boolean {
    return this.state.phase === AgentPhase.FAILED;
  }

  get isAwaitingUser(): boolean {
    return this.state.phase === AgentPhase.AWAITING_USER;
  }

  get canResume(): boolean {
    return (
      this.state.phase !== AgentPhase.COMPLETED &&
      this.state.phase !== AgentPhase.IDLE &&
      this.state.checkpoints.size > 0
    );
  }

  // ==========================================================================
  // 状态转换
  // ==========================================================================

  /**
   * 触发状态转换
   */
  transition(event: StateEvent): void {
    const newPhase = this.getNextPhase(event);

    if (!this.isValidTransition(newPhase)) {
      throw new Error(
        `Invalid state transition: ${this.state.phase} -> ${newPhase} (event: ${event.type})`
      );
    }

    const oldPhase = this.state.phase;

    // 记录事件
    this.state.events.push({
      ...event,
      timestamp: event.timestamp || Date.now(),
    });

    // 更新状态
    this.state.phase = newPhase;
    this.state.updatedAt = Date.now();

    // 触发钩子
    this.emit('phaseChange', { from: oldPhase, to: newPhase, event });
    this.emit(`phase:${newPhase}`, event);

    // 自动持久化
    if (this.config.autoSave) {
      this.persist().catch((err) => {
        console.error('[StateMachine] Auto-save failed:', err);
      });
    }
  }

  /**
   * 根据事件类型确定下一个状态
   */
  private getNextPhase(event: StateEvent): AgentPhase {
    switch (event.type) {
      case StateEventType.START_ANALYSIS:
        return AgentPhase.PLANNING;
      case StateEventType.INTENT_UNDERSTOOD:
      case StateEventType.PLAN_CREATED:
        return AgentPhase.EXECUTING;
      case StateEventType.STAGE_COMPLETED:
        return AgentPhase.EVALUATING;
      case StateEventType.EVALUATION_COMPLETE:
        return event.payload?.passed ? AgentPhase.COMPLETED : AgentPhase.REFINING;
      case StateEventType.NEEDS_REFINEMENT:
        // 从 refining 转回 executing 进行下一轮迭代
        return this.state.phase === AgentPhase.REFINING ? AgentPhase.EXECUTING : AgentPhase.REFINING;
      case StateEventType.CIRCUIT_TRIPPED:
        return AgentPhase.AWAITING_USER;
      case StateEventType.USER_RESPONDED:
        return event.payload?.nextPhase || AgentPhase.EXECUTING;
      case StateEventType.ANALYSIS_COMPLETE:
        return AgentPhase.COMPLETED;
      case StateEventType.ERROR_OCCURRED:
        return AgentPhase.FAILED;
      default:
        return this.state.phase;
    }
  }

  /**
   * 验证状态转换是否合法
   */
  private isValidTransition(newPhase: AgentPhase): boolean {
    if (newPhase === this.state.phase) {
      return true; // 保持当前状态
    }
    return STATE_TRANSITIONS[this.state.phase].includes(newPhase);
  }

  // ==========================================================================
  // 检查点管理
  // ==========================================================================

  /**
   * 创建检查点
   */
  checkpoint(
    stageId: string,
    stageResult: StageResult,
    findings: Finding[] = []
  ): Checkpoint {
    const checkpointId = `${this.state.sessionId}_${stageId}_${Date.now()}`;

    const checkpoint: Checkpoint = {
      id: checkpointId,
      stageId,
      timestamp: Date.now(),
      phase: this.state.phase,
      agentState: this.serializeState(),
      stageResults: Array.from(this.state.stageResults.values()),
      findings,
      canResume: true,
    };

    // 保存阶段结果
    this.state.stageResults.set(stageId, stageResult);

    // 保存检查点
    this.state.checkpoints.set(checkpointId, checkpoint);
    this.state.updatedAt = Date.now();

    // 触发事件
    this.emit('checkpoint', checkpoint);

    // 持久化
    this.persist().catch((err) => {
      console.error('[StateMachine] Checkpoint save failed:', err);
    });

    return checkpoint;
  }

  /**
   * 获取最新的检查点
   */
  getLatestCheckpoint(): Checkpoint | undefined {
    let latest: Checkpoint | undefined;
    let latestTime = 0;

    for (const checkpoint of this.state.checkpoints.values()) {
      if (checkpoint.timestamp > latestTime) {
        latestTime = checkpoint.timestamp;
        latest = checkpoint;
      }
    }

    return latest;
  }

  /**
   * 获取指定检查点
   */
  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    return this.state.checkpoints.get(checkpointId);
  }

  /**
   * 从检查点恢复
   */
  restoreFromCheckpoint(checkpoint: Checkpoint): void {
    this.state.phase = checkpoint.phase;
    this.state.currentStageIndex = this.getStageIndexFromId(checkpoint.stageId);

    // 恢复阶段结果
    this.state.stageResults.clear();
    for (const result of checkpoint.stageResults) {
      this.state.stageResults.set(result.stageId, result);
    }

    this.state.updatedAt = Date.now();

    this.emit('restored', { checkpoint });
  }

  private getStageIndexFromId(stageId: string): number {
    // 从阶段结果中推断索引
    const stages = Array.from(this.state.stageResults.keys());
    const index = stages.indexOf(stageId);
    return index >= 0 ? index : 0;
  }

  // ==========================================================================
  // 迭代计数器
  // ==========================================================================

  /**
   * 增加迭代计数
   */
  incrementIteration(key: string): number {
    const current = this.state.iterationCounters.get(key) || 0;
    const newCount = current + 1;
    this.state.iterationCounters.set(key, newCount);
    this.state.updatedAt = Date.now();
    return newCount;
  }

  /**
   * 获取迭代计数
   */
  getIterationCount(key: string): number {
    return this.state.iterationCounters.get(key) || 0;
  }

  /**
   * 重置迭代计数
   */
  resetIterationCount(key: string): void {
    this.state.iterationCounters.set(key, 0);
    this.state.updatedAt = Date.now();
  }

  // ==========================================================================
  // 序列化和持久化
  // ==========================================================================

  /**
   * 序列化当前状态
   */
  private serializeState(): SerializedAgentState {
    return {
      query: '', // 需要外部提供
      traceId: this.state.traceId,
      intent: undefined, // 需要外部提供
      plan: undefined, // 需要外部提供
      expertResults: [],
      iterationCount: this.getTotalIterations(),
      metadata: {
        currentStageIndex: this.state.currentStageIndex,
        phase: this.state.phase,
      },
    };
  }

  /**
   * 获取总迭代次数
   */
  private getTotalIterations(): number {
    let total = 0;
    for (const count of this.state.iterationCounters.values()) {
      total += count;
    }
    return total;
  }

  /**
   * 持久化状态到磁盘
   */
  async persist(): Promise<void> {
    const filePath = this.getStatePath();

    // 转换 Map 为可序列化对象
    const serializable = {
      ...this.state,
      checkpoints: Object.fromEntries(this.state.checkpoints),
      iterationCounters: Object.fromEntries(this.state.iterationCounters),
      stageResults: Object.fromEntries(this.state.stageResults),
    };

    await fs.promises.writeFile(filePath, JSON.stringify(serializable, null, 2), 'utf-8');
  }

  /**
   * 从磁盘恢复状态
   */
  async restore(): Promise<boolean> {
    const filePath = this.getStatePath();

    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      // 恢复 Map
      this.state = {
        ...data,
        checkpoints: new Map(Object.entries(data.checkpoints || {})),
        iterationCounters: new Map(Object.entries(data.iterationCounters || {})),
        stageResults: new Map(Object.entries(data.stageResults || {})),
      };

      this.emit('restored', { fromFile: filePath });
      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return false; // 文件不存在，正常情况
      }
      throw error;
    }
  }

  /**
   * 删除持久化状态
   */
  async cleanup(): Promise<void> {
    const filePath = this.getStatePath();
    try {
      await fs.promises.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * 获取状态文件路径
   */
  private getStatePath(): string {
    return path.join(this.config.persistPath!, `${this.state.sessionId}.json`);
  }

  /**
   * 确保持久化目录存在
   */
  private ensurePersistPath(): void {
    if (!fs.existsSync(this.config.persistPath!)) {
      fs.mkdirSync(this.config.persistPath!, { recursive: true });
    }
  }

  // ==========================================================================
  // 自动保存
  // ==========================================================================

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      this.persist().catch((err) => {
        console.error('[StateMachine] Auto-save failed:', err);
      });
    }, this.config.autoSaveIntervalMs);
  }

  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
  }

  // ==========================================================================
  // 事件历史
  // ==========================================================================

  /**
   * 获取事件历史
   */
  getEventHistory(): StateEvent[] {
    return [...this.state.events];
  }

  /**
   * 获取阶段结果
   */
  getStageResults(): StageResult[] {
    return Array.from(this.state.stageResults.values());
  }

  /**
   * 获取指定阶段结果
   */
  getStageResult(stageId: string): StageResult | undefined {
    return this.state.stageResults.get(stageId);
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /**
   * 重置状态机
   */
  reset(): void {
    this.stopAutoSave();

    this.state = {
      sessionId: this.config.sessionId,
      traceId: this.config.traceId,
      phase: AgentPhase.IDLE,
      checkpoints: new Map(),
      iterationCounters: new Map(),
      currentStageIndex: 0,
      stageResults: new Map(),
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (this.config.autoSave) {
      this.startAutoSave();
    }

    this.emit('reset');
  }

  /**
   * 销毁状态机
   */
  destroy(): void {
    this.stopAutoSave();
    this.removeAllListeners();
  }

  // ==========================================================================
  // 静态工厂方法
  // ==========================================================================

  /**
   * 创建新的状态机
   */
  static create(sessionId: string, traceId: string): AgentStateMachine {
    return new AgentStateMachine({
      sessionId,
      traceId,
    });
  }

  /**
   * 从持久化恢复状态机
   */
  static async load(
    sessionId: string,
    traceId: string,
    persistPath?: string
  ): Promise<AgentStateMachine | null> {
    const machine = new AgentStateMachine({
      sessionId,
      traceId,
      persistPath,
    });

    const restored = await machine.restore();
    return restored ? machine : null;
  }

  /**
   * 列出所有可恢复的会话
   */
  static async listRecoverableSessions(persistPath?: string): Promise<string[]> {
    const dir = persistPath || DEFAULT_PERSIST_PATH;

    try {
      const files = await fs.promises.readdir(dir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

export default AgentStateMachine;
