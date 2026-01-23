/**
 * CircuitBreaker Unit Tests
 *
 * 测试断路器的核心功能和边界条件：
 * 1. 基本状态转换 (closed → open → half-open → closed)
 * 2. 失败计数和熔断触发
 * 3. 迭代计数和用户介入
 * 4. 指数退避算法
 * 5. forceClose 冷却期
 * 6. forceClose 次数限制 (P2 Fix)
 * 7. 用户响应超时
 * 8. 边界条件和异常情况
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CircuitBreaker } from '../circuitBreaker';

// =============================================================================
// Test Setup
// =============================================================================

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    // 使用较短的超时和冷却期以加快测试速度
    circuitBreaker = new CircuitBreaker({
      maxRetriesPerAgent: 3,
      maxIterationsPerStage: 5,
      cooldownMs: 100, // 100ms 冷却期
      halfOpenAttempts: 1,
      failureThreshold: 3,
      successThreshold: 2,
    });
  });

  afterEach(() => {
    circuitBreaker.reset();
  });

  // ===========================================================================
  // 基本状态测试
  // ===========================================================================

  describe('初始状态', () => {
    it('应该以 closed 状态开始', () => {
      expect(circuitBreaker.circuitState).toBe('closed');
      expect(circuitBreaker.isClosed).toBe(true);
      expect(circuitBreaker.isTripped).toBe(false);
      expect(circuitBreaker.isHalfOpen).toBe(false);
    });

    it('forceClose 计数应该从 0 开始', () => {
      expect(circuitBreaker.forceCloseCallCount).toBe(0);
      expect(circuitBreaker.isForceCloseLimitReached).toBe(false);
    });

    it('canExecute 应该返回 continue', () => {
      const decision = circuitBreaker.canExecute();
      expect(decision.action).toBe('continue');
    });
  });

  // ===========================================================================
  // 失败计数和熔断测试
  // ===========================================================================

  describe('失败计数和熔断', () => {
    it('记录失败应该增加计数', () => {
      const decision1 = circuitBreaker.recordFailure('agent1', 'Error 1');
      expect(decision1.action).toBe('retry');

      const decision2 = circuitBreaker.recordFailure('agent1', 'Error 2');
      expect(decision2.action).toBe('retry');
    });

    it('达到最大重试次数应该触发熔断', () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      const decision = circuitBreaker.recordFailure('agent1', 'Error 3');

      expect(decision.action).toBe('ask_user');
      expect(circuitBreaker.isTripped).toBe(true);
      expect(circuitBreaker.circuitState).toBe('open');
    });

    it('不同 Agent 的失败应该独立计数', () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');

      // agent2 应该从 0 开始计数
      const decision = circuitBreaker.recordFailure('agent2', 'Error 1');
      expect(decision.action).toBe('retry');
      expect(circuitBreaker.isClosed).toBe(true);
    });

    it('记录成功应该重置失败计数', () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordSuccess('agent1');

      // 重置后应该从 0 开始
      const decision = circuitBreaker.recordFailure('agent1', 'Error 1');
      expect(decision.action).toBe('retry');
    });
  });

  // ===========================================================================
  // 迭代计数测试
  // ===========================================================================

  describe('迭代计数', () => {
    it('记录迭代应该增加计数', () => {
      const decision1 = circuitBreaker.recordIteration('stage1');
      expect(decision1.action).toBe('continue');

      const decision2 = circuitBreaker.recordIteration('stage1');
      expect(decision2.action).toBe('continue');
    });

    it('达到最大迭代次数应该触发用户介入', () => {
      for (let i = 0; i < 4; i++) {
        circuitBreaker.recordIteration('stage1');
      }

      const decision = circuitBreaker.recordIteration('stage1');
      expect(decision.action).toBe('ask_user');
      expect(decision.context).toBeDefined();
    });
  });

  // ===========================================================================
  // forceClose 测试
  // ===========================================================================

  describe('forceClose', () => {
    it('forceClose 应该关闭断路器', () => {
      // 先触发熔断
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');
      expect(circuitBreaker.isTripped).toBe(true);

      // forceClose 应该关闭断路器
      const result = circuitBreaker.forceClose();
      expect(result).toBe(true);
      expect(circuitBreaker.isClosed).toBe(true);
      expect(circuitBreaker.forceCloseCallCount).toBe(1);
    });

    it('forceClose 应该受冷却期限制', async () => {
      // 创建一个使用短冷却期的断路器用于此测试
      const shortCooldownBreaker = new CircuitBreaker({
        maxRetriesPerAgent: 3,
        cooldownMs: 100,
      });

      // 触发熔断并 forceClose
      shortCooldownBreaker.recordFailure('agent1', 'Error 1');
      shortCooldownBreaker.recordFailure('agent1', 'Error 2');
      shortCooldownBreaker.recordFailure('agent1', 'Error 3');
      shortCooldownBreaker.forceClose();

      // 立即再次 forceClose 应该失败（因为冷却期）
      const result = shortCooldownBreaker.forceClose();
      expect(result).toBe(false);

      // 等待冷却期后应该成功
      // 注意：CircuitBreaker 内部有 FORCE_CLOSE_COOLDOWN_MS = 30s，我们需要绕过
      // 通过直接设置 lastForceCloseTime 来模拟冷却期结束
      (shortCooldownBreaker as any).lastForceCloseTime = Date.now() - 31000;
      const result2 = shortCooldownBreaker.forceClose();
      expect(result2).toBe(true);

      shortCooldownBreaker.reset();
    });

    it('forceClose 次数应该有上限 (P2 Fix)', () => {
      const eventHandler = jest.fn();
      circuitBreaker.on('forceCloseLimitReached', eventHandler);

      // 连续 forceClose 直到达到上限
      for (let i = 0; i < 5; i++) {
        // 模拟每次 forceClose 后等待冷却期
        // 注意：这里我们直接重置 lastForceCloseTime 来绕过冷却期限制
        (circuitBreaker as any).lastForceCloseTime = 0;
        const result = circuitBreaker.forceClose();
        expect(result).toBe(true);
      }

      expect(circuitBreaker.forceCloseCallCount).toBe(5);
      expect(circuitBreaker.isForceCloseLimitReached).toBe(true);

      // 第 6 次应该失败
      (circuitBreaker as any).lastForceCloseTime = 0;
      const result = circuitBreaker.forceClose();
      expect(result).toBe(false);
      expect(eventHandler).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // handleUserResponse 测试
  // ===========================================================================

  describe('handleUserResponse', () => {
    beforeEach(() => {
      // 触发熔断
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');
    });

    it('continue 应该继续执行', () => {
      const decision = circuitBreaker.handleUserResponse('continue');
      expect(decision.action).toBe('continue');
      expect(circuitBreaker.isClosed).toBe(true);
    });

    it('abort 应该中止执行', () => {
      const decision = circuitBreaker.handleUserResponse('abort');
      expect(decision.action).toBe('abort');
    });

    it('skip 应该跳过当前阶段', () => {
      const decision = circuitBreaker.handleUserResponse('skip');
      expect(decision.action).toBe('skip');
    });

    it('达到 forceClose 上限后 continue 应该自动中止 (P2 Fix)', () => {
      // 先消耗完所有 forceClose 次数
      for (let i = 0; i < 5; i++) {
        (circuitBreaker as any).lastForceCloseTime = 0;
        circuitBreaker.forceClose();
      }

      // 再次触发熔断
      circuitBreaker.recordFailure('agent2', 'Error 1');
      circuitBreaker.recordFailure('agent2', 'Error 2');
      circuitBreaker.recordFailure('agent2', 'Error 3');

      // continue 应该自动变成 abort
      const decision = circuitBreaker.handleUserResponse('continue');
      expect(decision.action).toBe('abort');
      expect(decision.reason).toContain('最大继续次数');
    });
  });

  // ===========================================================================
  // 半开状态和恢复测试
  // ===========================================================================

  describe('半开状态和恢复', () => {
    it('冷却期后应该进入半开状态', async () => {
      // 触发熔断
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');
      expect(circuitBreaker.isTripped).toBe(true);

      // 等待冷却期
      await new Promise((resolve) => setTimeout(resolve, 150));

      // canExecute 应该触发进入半开状态
      const decision = circuitBreaker.canExecute();
      expect(decision.action).toBe('continue');
      expect(circuitBreaker.isHalfOpen).toBe(true);
    });

    it('半开状态下成功应该逐步恢复', async () => {
      // 触发熔断
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');

      // 等待冷却期进入半开
      await new Promise((resolve) => setTimeout(resolve, 150));
      circuitBreaker.canExecute();
      expect(circuitBreaker.isHalfOpen).toBe(true);

      // 需要 3 次成功才能完全关闭
      circuitBreaker.recordSuccess('agent1');
      expect(circuitBreaker.isHalfOpen).toBe(true);

      circuitBreaker.recordSuccess('agent1');
      expect(circuitBreaker.isHalfOpen).toBe(true);

      circuitBreaker.recordSuccess('agent1');
      expect(circuitBreaker.isClosed).toBe(true);
    });
  });

  // ===========================================================================
  // 重置测试
  // ===========================================================================

  describe('reset', () => {
    it('reset 应该重置所有状态', () => {
      // 触发熔断并 forceClose 几次
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');
      circuitBreaker.forceClose();
      (circuitBreaker as any).lastForceCloseTime = 0;
      circuitBreaker.recordFailure('agent1', 'Error 4');
      circuitBreaker.recordFailure('agent1', 'Error 5');
      circuitBreaker.recordFailure('agent1', 'Error 6');
      circuitBreaker.forceClose();

      expect(circuitBreaker.forceCloseCallCount).toBe(2);

      // reset 后应该全部重置
      circuitBreaker.reset();

      expect(circuitBreaker.isClosed).toBe(true);
      expect(circuitBreaker.forceCloseCallCount).toBe(0);
      expect(circuitBreaker.isForceCloseLimitReached).toBe(false);
    });
  });

  // ===========================================================================
  // 诊断信息测试
  // ===========================================================================

  describe('诊断信息', () => {
    it('getDiagnostics 应该返回 Agent 诊断信息', () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');

      const diagnostics = circuitBreaker.getDiagnostics('agent1');
      expect(diagnostics.agentId).toBe('agent1');
      expect(diagnostics.failureCount).toBe(2);
      expect(diagnostics.recentErrors).toHaveLength(2);
    });

    it('getAllDiagnostics 应该聚合所有诊断', () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent2', 'Error 2');
      circuitBreaker.recordIteration('stage1');

      const diagnostics = circuitBreaker.getAllDiagnostics();
      expect(diagnostics.failureCount).toBe(2);
      expect(diagnostics.iterationCount).toBe(1);
    });
  });

  // ===========================================================================
  // 事件发射测试
  // ===========================================================================

  describe('事件发射', () => {
    it('熔断应该发射 tripped 事件', () => {
      const handler = jest.fn();
      circuitBreaker.on('tripped', handler);

      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        reason: expect.any(String),
        diagnostics: expect.any(Object),
      }));
    });

    it('forceClose 应该发射 forceClosed 事件', () => {
      const handler = jest.fn();
      circuitBreaker.on('forceClosed', handler);

      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');
      circuitBreaker.forceClose();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        count: 1,
        maxCount: 5,
      }));
    });

    it('reset 应该发射 reset 事件', () => {
      const handler = jest.fn();
      circuitBreaker.on('reset', handler);

      circuitBreaker.reset();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // 边界条件测试
  // ===========================================================================

  describe('边界条件', () => {
    it('空 agentId 应该正常处理', () => {
      const decision = circuitBreaker.recordFailure('', 'Error');
      expect(decision.action).toBe('retry');
    });

    it('空错误信息应该正常处理', () => {
      const decision = circuitBreaker.recordFailure('agent1');
      expect(decision.action).toBe('retry');
    });

    it('负数配置值应该使用默认值', () => {
      const cb = new CircuitBreaker({
        maxRetriesPerAgent: -1, // 无效值
      });
      // 应该使用默认值而不是崩溃
      expect(cb.isClosed).toBe(true);
    });

    it('并发 forceClose 调用应该安全处理', async () => {
      circuitBreaker.recordFailure('agent1', 'Error 1');
      circuitBreaker.recordFailure('agent1', 'Error 2');
      circuitBreaker.recordFailure('agent1', 'Error 3');

      // 并发调用
      const results = await Promise.all([
        Promise.resolve(circuitBreaker.forceClose()),
        Promise.resolve(circuitBreaker.forceClose()),
        Promise.resolve(circuitBreaker.forceClose()),
      ]);

      // 只有第一个应该成功
      expect(results.filter(r => r === true).length).toBe(1);
    });
  });
});
