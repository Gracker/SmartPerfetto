/**
 * Logging Middleware
 *
 * 自动记录所有钩子事件的中间件
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
// Logging Middleware Configuration
// =============================================================================

export interface LoggingMiddlewareConfig {
  /** 日志级别 */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** 是否记录事件数据 */
  logData: boolean;
  /** 是否记录到控制台 */
  logToConsole: boolean;
  /** 自定义日志函数 */
  logger?: (message: string, data?: unknown) => void;
  /** 要排除的事件类型 */
  excludeEvents?: HookEventType[];
}

const DEFAULT_CONFIG: LoggingMiddlewareConfig = {
  level: 'info',
  logData: false,
  logToConsole: true,
  excludeEvents: [],
};

// =============================================================================
// Logging Middleware
// =============================================================================

/**
 * 创建日志中间件
 */
export function createLoggingMiddleware(
  config: Partial<LoggingMiddlewareConfig> = {}
): HookMiddleware {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  const handler = async (
    event: HookEvent,
    context: HookContext
  ): Promise<HookResult> => {
    // 检查是否排除此事件类型
    if (finalConfig.excludeEvents?.includes(event.type)) {
      return HOOK_CONTINUE;
    }

    const timestamp = new Date(event.timestamp).toISOString();
    const prefix = `[Hook:${event.type}:${event.phase}]`;
    const sessionInfo = `session=${context.sessionId.slice(0, 8)}`;

    let message = `${prefix} ${timestamp} ${sessionInfo}`;

    // 根据事件类型添加更多信息
    switch (event.type) {
      case 'tool:use':
        message += ` tool=${(event.data as any).toolName}`;
        break;
      case 'subagent:start':
      case 'subagent:complete':
      case 'subagent:error':
        message += ` agent=${(event.data as any).agentName} stage=${(event.data as any).stageId}`;
        break;
      case 'session:start':
      case 'session:end':
        if ((event.data as any).traceId) {
          message += ` trace=${(event.data as any).traceId.slice(0, 8)}`;
        }
        break;
    }

    // 记录日志
    const logFn = finalConfig.logger || console.log;

    if (finalConfig.logToConsole) {
      switch (finalConfig.level) {
        case 'debug':
          console.debug(message);
          break;
        case 'info':
          console.log(message);
          break;
        case 'warn':
          console.warn(message);
          break;
        case 'error':
          console.error(message);
          break;
      }
    }

    if (finalConfig.logger) {
      logFn(message, finalConfig.logData ? event.data : undefined);
    }

    // 记录到 context metadata 供后续使用
    const logKey = `log:${event.type}:${event.phase}:${event.timestamp}`;
    context.set(logKey, { message, data: event.data });

    return HOOK_CONTINUE;
  };

  return {
    name: 'logging',
    events: [
      'tool:use',
      'subagent:start',
      'subagent:complete',
      'subagent:error',
      'session:start',
      'session:end',
      'session:checkpoint',
      'session:error',
      'iteration:start',
      'iteration:end',
    ],
    phases: ['pre', 'post'],
    priority: 1000, // 低优先级，最后执行
    handler,
    enabled: true,
  };
}

/**
 * 默认的日志中间件实例
 */
export const loggingMiddleware = createLoggingMiddleware();
