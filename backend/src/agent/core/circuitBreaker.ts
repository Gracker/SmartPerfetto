/**
 * SmartPerfetto Agent Circuit Breaker
 *
 * 断路器模式实现，负责：
 * 1. 监控 Agent 失败次数
 * 2. 在达到阈值时熔断
 * 3. 实现指数退避重试
 * 4. 触发用户介入机制
 */

import { EventEmitter } from 'events';
import {
  CircuitState,
  CircuitBreakerConfig,
  CircuitDecision,
  CircuitDiagnostics,
  CircuitBreakerState,
} from '../types';
import { circuitBreakerConfig as cbConfig } from '../../config';

// 默认配置 (从统一配置文件获取)
const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxRetriesPerAgent: cbConfig.maxRetriesPerAgent,
  maxIterationsPerStage: cbConfig.maxIterationsPerStage,
  cooldownMs: cbConfig.cooldownMs,
  halfOpenAttempts: cbConfig.halfOpenAttempts,
  failureThreshold: cbConfig.failureThreshold,
  successThreshold: cbConfig.successThreshold,
};

/**
 * 断路器实现
 *
 * 状态转换：
 * - closed: 正常状态，允许请求通过
 * - open: 熔断状态，拒绝请求，等待冷却
 * - half-open: 半开状态，允许有限请求测试恢复
 */
export class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: CircuitBreakerState;

  // 【P1 Fix】用户响应超时机制
  private userResponseTimeout: NodeJS.Timeout | null = null;
  private readonly USER_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

  // 【P1 Fix】forceClose 冷却期跟踪
  private lastForceCloseTime: number = 0;
  private readonly FORCE_CLOSE_COOLDOWN_MS = 30 * 1000; // 30 秒冷却期

  // 【P2 Fix】forceClose 次数限制 - 防止用户无限循环选择 'continue'
  private forceCloseCount: number = 0;
  private readonly MAX_FORCE_CLOSE_COUNT = 5; // 单个会话最多允许 5 次 forceClose

  // 【P1 Fix】半开状态成功计数（用于渐进式恢复）
  private halfOpenSuccessCount: number = 0;
  private readonly HALF_OPEN_SUCCESS_THRESHOLD = 3; // 需要 3 次成功才完全关闭

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  private createInitialState(): CircuitBreakerState {
    return {
      state: CircuitState.CLOSED,
      retryCounters: new Map(),
      iterationCounters: new Map(),
      failureHistory: new Map(),
      lastStateChange: Date.now(),
      tripReason: undefined,
    };
  }

  // ==========================================================================
  // 状态查询
  // ==========================================================================

  get circuitState(): CircuitState {
    return this.state.state;
  }

  get isTripped(): boolean {
    return this.state.state === CircuitState.OPEN;
  }

  get isHalfOpen(): boolean {
    return this.state.state === CircuitState.HALF_OPEN;
  }

  get isClosed(): boolean {
    return this.state.state === CircuitState.CLOSED;
  }

  get tripReason(): string | undefined {
    return this.state.tripReason;
  }

  /**
   * 【P2 Fix】获取当前 forceClose 调用次数
   */
  get forceCloseCallCount(): number {
    return this.forceCloseCount;
  }

  /**
   * 【P2 Fix】检查是否已达到 forceClose 次数上限
   */
  get isForceCloseLimitReached(): boolean {
    return this.forceCloseCount >= this.MAX_FORCE_CLOSE_COUNT;
  }

  // ==========================================================================
  // 失败记录
  // ==========================================================================

  /**
   * 记录 Agent 失败
   */
  recordFailure(agentId: string, error?: string): CircuitDecision {
    const count = (this.state.retryCounters.get(agentId) || 0) + 1;
    this.state.retryCounters.set(agentId, count);

    // 记录失败历史
    this.addToFailureHistory(agentId, error || 'Unknown error');

    // 触发事件
    this.emit('failure', { agentId, count, error });

    // 检查是否需要熔断
    if (count >= this.config.maxRetriesPerAgent) {
      return this.trip(`Agent ${agentId} 失败次数达到上限 (${count}/${this.config.maxRetriesPerAgent})`);
    }

    // 返回重试决策
    return {
      action: 'retry',
      delay: this.calculateBackoff(count),
      reason: `重试第 ${count} 次`,
    };
  }

  /**
   * 记录阶段迭代
   */
  recordIteration(stageId: string): CircuitDecision {
    const count = (this.state.iterationCounters.get(stageId) || 0) + 1;
    this.state.iterationCounters.set(stageId, count);

    // 触发事件
    this.emit('iteration', { stageId, count });

    // 检查是否超过最大迭代次数
    if (count >= this.config.maxIterationsPerStage) {
      return {
        action: 'ask_user',
        reason: `阶段 ${stageId} 已迭代 ${count} 次，需要用户决策`,
        context: this.getDiagnostics(stageId),
      };
    }

    return { action: 'continue' };
  }

  /**
   * 记录成功
   */
  recordSuccess(agentId: string): void {
    // 重置该 Agent 的失败计数
    this.state.retryCounters.set(agentId, 0);

    // 如果处于半开状态，检查是否可以关闭断路器
    if (this.state.state === CircuitState.HALF_OPEN) {
      this.checkHalfOpenRecovery();
    }

    this.emit('success', { agentId });
  }

  // ==========================================================================
  // 断路器状态管理
  // ==========================================================================

  /**
   * 触发熔断
   */
  private trip(reason: string): CircuitDecision {
    this.state.state = CircuitState.OPEN;
    this.state.tripReason = reason;
    this.state.lastStateChange = Date.now();

    this.emit('tripped', { reason, diagnostics: this.getAllDiagnostics() });

    // 启动冷却计时器
    this.scheduleCooldown();

    // 【P1 Fix】启动用户响应超时计时器
    this.startUserResponseTimeout();

    return {
      action: 'ask_user',
      reason,
      context: this.getAllDiagnostics(),
    };
  }

  /**
   * 【P1 Fix】启动用户响应超时计时器
   * 如果用户在超时时间内未响应，自动执行 abort
   */
  private startUserResponseTimeout(): void {
    // 清理之前的超时计时器
    this.clearUserResponseTimeout();

    this.userResponseTimeout = setTimeout(() => {
      console.warn(`[CircuitBreaker] User response timeout after ${this.USER_RESPONSE_TIMEOUT_MS}ms, auto-aborting`);
      this.emit('userResponseTimeout', {
        timeoutMs: this.USER_RESPONSE_TIMEOUT_MS,
        reason: '用户响应超时，自动中止分析',
      });
      // 不自动调用 handleUserResponse，而是发出事件让上层处理
    }, this.USER_RESPONSE_TIMEOUT_MS);
  }

  /**
   * 【P1 Fix】清理用户响应超时计时器
   */
  private clearUserResponseTimeout(): void {
    if (this.userResponseTimeout) {
      clearTimeout(this.userResponseTimeout);
      this.userResponseTimeout = null;
    }
  }

  /**
   * 进入半开状态
   */
  private halfOpen(): void {
    this.state.state = CircuitState.HALF_OPEN;
    this.state.lastStateChange = Date.now();
    this.emit('halfOpen');
  }

  /**
   * 关闭断路器（恢复正常）
   */
  private close(): void {
    this.state.state = CircuitState.CLOSED;
    this.state.tripReason = undefined;
    this.state.lastStateChange = Date.now();
    this.emit('closed');
  }

  /**
   * 检查半开状态是否可以恢复
   * 【P1 Fix】实现渐进式恢复：需要多次成功才完全关闭
   */
  private checkHalfOpenRecovery(): void {
    this.halfOpenSuccessCount++;

    if (this.halfOpenSuccessCount >= this.HALF_OPEN_SUCCESS_THRESHOLD) {
      console.log(`[CircuitBreaker] Half-open recovery complete after ${this.halfOpenSuccessCount} successes`);
      this.halfOpenSuccessCount = 0;
      this.close();
    } else {
      console.log(`[CircuitBreaker] Half-open progress: ${this.halfOpenSuccessCount}/${this.HALF_OPEN_SUCCESS_THRESHOLD} successes`);
    }
  }

  /**
   * 安排冷却后的状态转换
   */
  private scheduleCooldown(): void {
    setTimeout(() => {
      if (this.state.state === CircuitState.OPEN) {
        this.halfOpen();
      }
    }, this.config.cooldownMs);
  }

  // ==========================================================================
  // 退避算法
  // ==========================================================================

  /**
   * 计算指数退避延迟
   */
  private calculateBackoff(attemptNumber: number): number {
    // 指数退避：使用配置的基础延迟和最大延迟
    const baseDelay = cbConfig.backoffBaseDelayMs;
    const maxDelay = cbConfig.backoffMaxDelayMs;
    const delay = Math.min(baseDelay * Math.pow(2, attemptNumber - 1), maxDelay);

    // 添加抖动 (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  // ==========================================================================
  // 诊断信息
  // ==========================================================================

  /**
   * 获取单个 Agent 的诊断信息
   */
  getDiagnostics(agentId: string): CircuitDiagnostics {
    const history = this.state.failureHistory.get(agentId) || [];
    const recentErrors = history.slice(-5); // 最近 5 条错误

    return {
      agentId,
      failureCount: this.state.retryCounters.get(agentId) || 0,
      iterationCount: this.state.iterationCounters.get(agentId) || 0,
      lastError: recentErrors.length > 0 ? recentErrors[recentErrors.length - 1].error : undefined,
      lastAttemptTime: recentErrors.length > 0 ? recentErrors[recentErrors.length - 1].time : 0,
      state: this.state.state,
      recentErrors,
    };
  }

  /**
   * 获取所有诊断信息
   */
  getAllDiagnostics(): CircuitDiagnostics {
    const allErrors: Array<{ time: number; error: string }> = [];
    let totalFailures = 0;
    let totalIterations = 0;

    for (const [, count] of this.state.retryCounters) {
      totalFailures += count;
    }

    for (const [, count] of this.state.iterationCounters) {
      totalIterations += count;
    }

    for (const [, history] of this.state.failureHistory) {
      allErrors.push(...history);
    }

    // 按时间排序
    allErrors.sort((a, b) => b.time - a.time);

    return {
      agentId: '*',
      failureCount: totalFailures,
      iterationCount: totalIterations,
      lastError: allErrors.length > 0 ? allErrors[0].error : undefined,
      lastAttemptTime: allErrors.length > 0 ? allErrors[0].time : 0,
      state: this.state.state,
      recentErrors: allErrors.slice(0, 10),
    };
  }

  /**
   * 添加失败历史记录
   */
  private addToFailureHistory(agentId: string, error: string): void {
    const history = this.state.failureHistory.get(agentId) || [];
    history.push({ time: Date.now(), error });

    // 保留最近 20 条
    if (history.length > 20) {
      history.shift();
    }

    this.state.failureHistory.set(agentId, history);
  }

  // ==========================================================================
  // 请求检查
  // ==========================================================================

  /**
   * 检查是否允许执行
   */
  canExecute(): CircuitDecision {
    switch (this.state.state) {
      case CircuitState.CLOSED:
        return { action: 'continue' };

      case CircuitState.OPEN:
        // 检查是否已过冷却期
        const elapsed = Date.now() - this.state.lastStateChange;
        if (elapsed >= this.config.cooldownMs) {
          this.halfOpen();
          return { action: 'continue', reason: '断路器进入半开状态' };
        }
        return {
          action: 'ask_user',
          reason: this.state.tripReason || '断路器已熔断',
          context: this.getAllDiagnostics(),
        };

      case CircuitState.HALF_OPEN:
        return { action: 'continue', reason: '断路器半开状态，测试中' };

      default:
        return { action: 'continue' };
    }
  }

  // ==========================================================================
  // 重置和清理
  // ==========================================================================

  /**
   * 重置单个 Agent 的计数器
   */
  resetAgent(agentId: string): void {
    this.state.retryCounters.set(agentId, 0);
    this.state.iterationCounters.set(agentId, 0);
    this.state.failureHistory.delete(agentId);
    this.emit('agentReset', { agentId });
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    // 【P1 Fix】清理所有计时器和状态
    this.clearUserResponseTimeout();
    this.lastForceCloseTime = 0;
    this.halfOpenSuccessCount = 0;
    // 【P2 Fix】重置 forceClose 计数
    this.forceCloseCount = 0;
    this.state = this.createInitialState();
    this.emit('reset');
  }

  /**
   * 手动关闭断路器（用户干预后）
   * 【P1 Fix】添加冷却期检查，防止用户快速连续选择 'continue'
   * 【P2 Fix】添加次数限制，防止用户无限循环选择 'continue'
   */
  forceClose(): boolean {
    // 【P2 Fix】检查是否超过最大 forceClose 次数
    if (this.forceCloseCount >= this.MAX_FORCE_CLOSE_COUNT) {
      console.warn(`[CircuitBreaker] forceClose limit reached (${this.forceCloseCount}/${this.MAX_FORCE_CLOSE_COUNT})`);
      this.emit('forceCloseLimitReached', {
        count: this.forceCloseCount,
        maxCount: this.MAX_FORCE_CLOSE_COUNT,
        reason: `已达到最大继续次数 (${this.MAX_FORCE_CLOSE_COUNT} 次)，请检查分析配置或手动中止`,
      });
      return false;
    }

    // 检查是否在冷却期内
    const timeSinceLastForceClose = Date.now() - this.lastForceCloseTime;
    if (this.lastForceCloseTime > 0 && timeSinceLastForceClose < this.FORCE_CLOSE_COOLDOWN_MS) {
      const remainingCooldown = this.FORCE_CLOSE_COOLDOWN_MS - timeSinceLastForceClose;
      console.warn(`[CircuitBreaker] forceClose in cooldown, ${remainingCooldown}ms remaining`);
      this.emit('forceCloseCooldown', {
        remainingMs: remainingCooldown,
        reason: '冷却期内，请稍后再试',
      });
      return false;
    }

    // 清理用户响应超时计时器
    this.clearUserResponseTimeout();

    // 更新计数和时间
    this.forceCloseCount++;
    this.lastForceCloseTime = Date.now();
    this.halfOpenSuccessCount = 0; // 重置半开成功计数

    console.log(`[CircuitBreaker] forceClose executed (${this.forceCloseCount}/${this.MAX_FORCE_CLOSE_COUNT})`);
    this.close();
    this.emit('forceClosed', { count: this.forceCloseCount, maxCount: this.MAX_FORCE_CLOSE_COUNT });
    return true;
  }

  /**
   * 手动触发熔断（用于测试）
   */
  forceTrip(reason: string): CircuitDecision {
    return this.trip(reason);
  }

  // ==========================================================================
  // 用户响应处理
  // ==========================================================================

  /**
   * 处理用户响应
   * 【P1 Fix】清理超时计时器，处理冷却期
   * 【P2 Fix】处理 forceClose 次数限制
   */
  handleUserResponse(decision: 'continue' | 'abort' | 'skip'): CircuitDecision {
    // 清理用户响应超时计时器
    this.clearUserResponseTimeout();

    switch (decision) {
      case 'continue':
        // 【P2 Fix】先检查是否达到次数限制
        if (this.isForceCloseLimitReached) {
          return {
            action: 'abort',
            reason: `已达到最大继续次数 (${this.MAX_FORCE_CLOSE_COUNT} 次)，分析自动中止。请检查分析配置或 Trace 文件。`,
          };
        }

        const forceCloseSuccess = this.forceClose();
        if (!forceCloseSuccess) {
          // 在冷却期内，返回特殊响应
          return {
            action: 'ask_user',
            reason: '操作过于频繁，请稍后再试继续',
          };
        }
        return { action: 'continue', reason: '用户选择继续' };

      case 'abort':
        return { action: 'abort', reason: '用户选择中止' };

      case 'skip':
        return { action: 'skip', reason: '用户选择跳过当前阶段' };

      default:
        return { action: 'abort', reason: '未知用户决策' };
    }
  }

  // ==========================================================================
  // 配置更新
  // ==========================================================================

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configUpdated', this.config);
  }

  /**
   * 获取当前配置
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  // ==========================================================================
  // 序列化
  // ==========================================================================

  /**
   * 导出状态（用于持久化）
   */
  exportState(): CircuitBreakerState {
    return {
      ...this.state,
      retryCounters: new Map(this.state.retryCounters),
      iterationCounters: new Map(this.state.iterationCounters),
      failureHistory: new Map(this.state.failureHistory),
    };
  }

  /**
   * 导入状态（用于恢复）
   */
  importState(state: CircuitBreakerState): void {
    this.state = {
      ...state,
      retryCounters: new Map(state.retryCounters),
      iterationCounters: new Map(state.iterationCounters),
      failureHistory: new Map(state.failureHistory),
    };
    this.emit('stateImported');
  }
}

export default CircuitBreaker;
