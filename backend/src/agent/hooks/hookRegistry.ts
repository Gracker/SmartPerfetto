/**
 * Hook Registry
 *
 * 中央钩子注册表，管理所有生命周期钩子的注册和执行
 */

import {
  HookEventType,
  HookPhase,
  HookEvent,
  HookHandler,
  HookResult,
  HookContext,
  HookMiddleware,
  HookRegistryConfig,
  DEFAULT_HOOK_REGISTRY_CONFIG,
  HOOK_CONTINUE,
} from './hookTypes';
import { createHookContext } from './hookContext';

// =============================================================================
// Hook Registry
// =============================================================================

export class HookRegistry {
  private config: HookRegistryConfig;
  private handlers: Map<string, HookHandler[]> = new Map();

  constructor(config: Partial<HookRegistryConfig> = {}) {
    this.config = { ...DEFAULT_HOOK_REGISTRY_CONFIG, ...config };

    // 注册初始中间件
    if (this.config.middleware) {
      for (const middleware of this.config.middleware) {
        this.use(middleware);
      }
    }
  }

  // ===========================================================================
  // Registration Methods
  // ===========================================================================

  /**
   * 注册单个钩子处理器
   */
  register<T extends HookEventType>(
    eventType: T,
    phase: HookPhase,
    handler: HookHandler<T>
  ): () => void {
    const key = this.getKey(eventType, phase);

    if (!this.handlers.has(key)) {
      this.handlers.set(key, []);
    }

    const handlers = this.handlers.get(key)!;
    handlers.push(handler as HookHandler);

    // 按优先级排序 (优先级小的先执行)
    handlers.sort((a, b) => a.priority - b.priority);

    // 返回取消注册函数
    return () => this.unregister(eventType, phase, handler.name);
  }

  /**
   * 取消注册钩子处理器
   */
  unregister(eventType: HookEventType, phase: HookPhase, handlerName: string): boolean {
    const key = this.getKey(eventType, phase);
    const handlers = this.handlers.get(key);

    if (!handlers) return false;

    const index = handlers.findIndex((h) => h.name === handlerName);
    if (index === -1) return false;

    handlers.splice(index, 1);
    return true;
  }

  /**
   * 注册中间件 (批量注册到多个事件/阶段)
   */
  use(middleware: HookMiddleware): () => void {
    const unregisterFns: (() => void)[] = [];

    for (const eventType of middleware.events) {
      for (const phase of middleware.phases) {
        const handler: HookHandler = {
          name: `${middleware.name}:${eventType}:${phase}`,
          priority: middleware.priority,
          handler: middleware.handler,
          enabled: middleware.enabled,
        };

        const unregister = this.register(eventType, phase, handler);
        unregisterFns.push(unregister);
      }
    }

    // 返回批量取消注册函数
    return () => {
      for (const fn of unregisterFns) {
        fn();
      }
    };
  }

  // ===========================================================================
  // Execution Methods
  // ===========================================================================

  /**
   * 执行钩子链
   */
  async execute<T extends HookEventType>(
    event: HookEvent<T>,
    context?: HookContext
  ): Promise<HookResult> {
    // 如果 hooks 被禁用，直接返回继续
    if (!this.config.enabled) {
      return HOOK_CONTINUE;
    }

    const key = this.getKey(event.type, event.phase);
    const handlers = this.handlers.get(key);

    if (!handlers || handlers.length === 0) {
      return HOOK_CONTINUE;
    }

    // 创建或使用提供的上下文
    const hookContext = context ?? createHookContext(
      event.sessionId,
      event.data && 'traceId' in event.data ? (event.data as any).traceId : '',
    );

    let lastResult: HookResult = HOOK_CONTINUE;
    let modifiedData = event.data;

    for (const handler of handlers) {
      // 跳过禁用的处理器
      if (handler.enabled === false) {
        continue;
      }

      // 检查过滤条件
      if (handler.filter && !handler.filter(event as HookEvent)) {
        continue;
      }

      // 检查上下文是否已中止
      if (hookContext.aborted) {
        return {
          continue: false,
          error: new Error(hookContext.abortReason || 'Hook chain aborted'),
        };
      }

      try {
        // 使用可能被修改的数据创建事件副本
        const eventWithModifiedData: HookEvent<T> = {
          ...event,
          data: modifiedData as any,
        };

        // 执行处理器 (带超时)
        const result = await this.executeWithTimeout(
          handler.handler(eventWithModifiedData, hookContext),
          this.config.defaultTimeout || 5000
        );

        lastResult = result;

        // 如果返回了修改后的数据，更新它
        if (result.modifiedData !== undefined) {
          modifiedData = result.modifiedData as any;
        }

        // 如果不继续，中断链
        if (!result.continue) {
          return {
            ...result,
            modifiedData,
          };
        }
      } catch (error) {
        console.error(`[HookRegistry] Handler "${handler.name}" failed:`, error);

        if (!this.config.continueOnError) {
          return {
            continue: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
        // 继续执行下一个处理器
      }
    }

    return {
      ...lastResult,
      modifiedData,
    };
  }

  /**
   * 便捷方法：执行 pre 阶段钩子
   */
  async executePre<T extends HookEventType>(
    eventType: T,
    sessionId: string,
    data: HookEvent<T>['data'],
    context?: HookContext
  ): Promise<HookResult> {
    const event: HookEvent<T> = {
      type: eventType,
      phase: 'pre',
      timestamp: Date.now(),
      sessionId,
      data,
    };
    return this.execute(event, context);
  }

  /**
   * 便捷方法：执行 post 阶段钩子
   */
  async executePost<T extends HookEventType>(
    eventType: T,
    sessionId: string,
    data: HookEvent<T>['data'],
    context?: HookContext
  ): Promise<HookResult> {
    const event: HookEvent<T> = {
      type: eventType,
      phase: 'post',
      timestamp: Date.now(),
      sessionId,
      data,
    };
    return this.execute(event, context);
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * 获取已注册的处理器数量
   */
  getHandlerCount(eventType?: HookEventType, phase?: HookPhase): number {
    if (eventType && phase) {
      const key = this.getKey(eventType, phase);
      return this.handlers.get(key)?.length ?? 0;
    }

    let count = 0;
    for (const handlers of this.handlers.values()) {
      count += handlers.length;
    }
    return count;
  }

  /**
   * 获取所有注册的事件类型
   */
  getRegisteredEvents(): Array<{ type: HookEventType; phase: HookPhase }> {
    const events: Array<{ type: HookEventType; phase: HookPhase }> = [];

    for (const key of this.handlers.keys()) {
      const [type, phase] = key.split(':') as [HookEventType, HookPhase];
      events.push({ type, phase });
    }

    return events;
  }

  /**
   * 清除所有处理器
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * 启用/禁用 hooks
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * 检查是否启用
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private getKey(eventType: HookEventType, phase: HookPhase): string {
    return `${eventType}:${phase}`;
  }

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Hook handler timeout')), timeoutMs)
      ),
    ]);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let _globalRegistry: HookRegistry | null = null;

/**
 * 获取全局 Hook 注册表
 */
export function getHookRegistry(): HookRegistry {
  if (!_globalRegistry) {
    _globalRegistry = new HookRegistry();
  }
  return _globalRegistry;
}

/**
 * 设置全局 Hook 注册表 (用于测试或自定义配置)
 */
export function setHookRegistry(registry: HookRegistry): void {
  _globalRegistry = registry;
}

/**
 * 重置全局 Hook 注册表
 */
export function resetHookRegistry(): void {
  _globalRegistry = null;
}
