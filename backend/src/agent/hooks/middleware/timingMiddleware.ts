/**
 * Timing Middleware
 *
 * 自动追踪操作耗时的中间件
 * 在 pre 阶段记录开始时间，在 post 阶段计算耗时
 */

import {
  HookMiddleware,
  HookEvent,
  HookContext,
  HookResult,
  HOOK_CONTINUE,
  HookEventType,
} from '../hookTypes';

// =============================================================================
// Timing Middleware Configuration
// =============================================================================

export interface TimingMiddlewareConfig {
  /** 慢操作阈值 (ms) - 超过此值会警告 */
  slowThresholdMs: number;
  /** 是否记录所有计时 */
  logAllTimings: boolean;
  /** 自定义计时回调 */
  onTiming?: (eventType: HookEventType, durationMs: number, context: HookContext) => void;
}

const DEFAULT_CONFIG: TimingMiddlewareConfig = {
  slowThresholdMs: 5000,
  logAllTimings: false,
};

// =============================================================================
// Timing Storage Keys
// =============================================================================

const TIMING_PREFIX = 'timing:start:';

function getTimingKey(eventType: HookEventType, identifier?: string): string {
  return `${TIMING_PREFIX}${eventType}${identifier ? `:${identifier}` : ''}`;
}

// =============================================================================
// Timing Middleware
// =============================================================================

/**
 * 创建计时中间件
 */
export function createTimingMiddleware(
  config: Partial<TimingMiddlewareConfig> = {}
): HookMiddleware {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  const handler = async (
    event: HookEvent,
    context: HookContext
  ): Promise<HookResult> => {
    // 获取操作标识符
    const identifier = getIdentifier(event);
    const timingKey = getTimingKey(event.type, identifier);

    if (event.phase === 'pre') {
      // Pre 阶段：记录开始时间
      context.set(timingKey, Date.now());
    } else {
      // Post 阶段：计算耗时
      const startTime = context.get<number>(timingKey);

      if (startTime) {
        const durationMs = Date.now() - startTime;

        // 存储耗时到 context
        context.set(`timing:duration:${event.type}:${identifier || 'default'}`, durationMs);

        // 检查是否为慢操作
        if (durationMs > finalConfig.slowThresholdMs) {
          console.warn(
            `[Timing] Slow operation detected: ${event.type}` +
              (identifier ? ` (${identifier})` : '') +
              ` took ${durationMs}ms (threshold: ${finalConfig.slowThresholdMs}ms)`
          );
        } else if (finalConfig.logAllTimings) {
          console.log(
            `[Timing] ${event.type}` +
              (identifier ? ` (${identifier})` : '') +
              ` took ${durationMs}ms`
          );
        }

        // 调用自定义回调
        if (finalConfig.onTiming) {
          finalConfig.onTiming(event.type, durationMs, context);
        }
      }
    }

    return HOOK_CONTINUE;
  };

  return {
    name: 'timing',
    events: [
      'tool:use',
      'subagent:start',
      'subagent:complete',
      'session:start',
      'session:end',
      'iteration:start',
      'iteration:end',
    ],
    phases: ['pre', 'post'],
    priority: 0, // 高优先级，最先执行
    handler,
    enabled: true,
  };
}

/**
 * 从事件中提取标识符
 */
function getIdentifier(event: HookEvent): string | undefined {
  switch (event.type) {
    case 'tool:use':
      return (event.data as any).toolName;
    case 'subagent:start':
    case 'subagent:complete':
    case 'subagent:error':
      return (event.data as any).stageId || (event.data as any).agentId;
    case 'iteration:start':
    case 'iteration:end':
      return `iteration-${(event.data as any).iterationNumber}`;
    default:
      return undefined;
  }
}

/**
 * 默认的计时中间件实例
 */
export const timingMiddleware = createTimingMiddleware();

// =============================================================================
// Timing Metrics Aggregator
// =============================================================================

/**
 * 计时指标聚合器
 * 用于收集和分析多次操作的计时统计
 */
export class TimingMetricsAggregator {
  private metrics: Map<string, number[]> = new Map();

  /**
   * 记录一次计时
   */
  record(eventType: HookEventType, durationMs: number, identifier?: string): void {
    const key = `${eventType}${identifier ? `:${identifier}` : ''}`;

    if (!this.metrics.has(key)) {
      this.metrics.set(key, []);
    }

    this.metrics.get(key)!.push(durationMs);
  }

  /**
   * 获取统计信息
   */
  getStats(eventType: HookEventType, identifier?: string): TimingStats | null {
    const key = `${eventType}${identifier ? `:${identifier}` : ''}`;
    const timings = this.metrics.get(key);

    if (!timings || timings.length === 0) {
      return null;
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const sum = timings.reduce((a, b) => a + b, 0);

    return {
      count: timings.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / timings.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  /**
   * 获取所有统计
   */
  getAllStats(): Map<string, TimingStats> {
    const result = new Map<string, TimingStats>();

    for (const key of this.metrics.keys()) {
      const [eventType, identifier] = key.split(':') as [HookEventType, string?];
      const stats = this.getStats(eventType, identifier);
      if (stats) {
        result.set(key, stats);
      }
    }

    return result;
  }

  /**
   * 清除所有记录
   */
  clear(): void {
    this.metrics.clear();
  }
}

export interface TimingStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}
