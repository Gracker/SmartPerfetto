/**
 * Hook System Types
 *
 * 定义 Agent 系统的生命周期钩子类型
 * 借鉴 Claude Agent SDK 的 Hooks 设计理念
 */

// =============================================================================
// Hook Event Types
// =============================================================================

/**
 * 钩子事件类型
 */
export type HookEventType =
  // Tool-level hooks (BaseSubAgent.act())
  | 'tool:use'

  // SubAgent-level hooks (PipelineExecutor)
  | 'subagent:start'
  | 'subagent:complete'
  | 'subagent:error'

  // Session-level hooks (MasterOrchestrator)
  | 'session:start'
  | 'session:end'
  | 'session:checkpoint'
  | 'session:error'

  // Iteration-level hooks
  | 'iteration:start'
  | 'iteration:end';

/**
 * 钩子阶段
 */
export type HookPhase = 'pre' | 'post';

// =============================================================================
// Hook Event Data Types
// =============================================================================

/**
 * Tool 使用事件数据
 */
export interface ToolUseEventData {
  toolName: string;
  params: Record<string, unknown>;
  agentId?: string;
  result?: unknown;
  error?: string | Error;
  durationMs?: number;
}

/**
 * SubAgent 事件数据
 */
export interface SubAgentEventData {
  agentId: string;
  agentName: string;
  agentType: string;
  stageId: string;
  result?: unknown;
  error?: Error;
  durationMs?: number;
}

/**
 * Session 事件数据
 */
export interface SessionEventData {
  query?: string;
  traceId?: string;
  result?: unknown;
  error?: Error;
  checkpointId?: string;
  iterationCount?: number;
  totalDurationMs?: number;
}

/**
 * Iteration 事件数据
 */
export interface IterationEventData {
  iterationNumber: number;
  maxIterations: number;
  previousQualityScore?: number;
  currentFindings?: unknown[];
  thought?: unknown;
  decision?: 'continue' | 'conclude';
}

/**
 * 事件数据类型映射
 */
export type HookEventDataMap = {
  'tool:use': ToolUseEventData;
  'subagent:start': SubAgentEventData;
  'subagent:complete': SubAgentEventData;
  'subagent:error': SubAgentEventData;
  'session:start': SessionEventData;
  'session:end': SessionEventData;
  'session:checkpoint': SessionEventData;
  'session:error': SessionEventData;
  'iteration:start': IterationEventData;
  'iteration:end': IterationEventData;
};

// =============================================================================
// Hook Event
// =============================================================================

/**
 * 钩子事件
 */
export interface HookEvent<T extends HookEventType = HookEventType> {
  /** 事件类型 */
  type: T;
  /** 事件阶段 (pre/post) */
  phase: HookPhase;
  /** 时间戳 */
  timestamp: number;
  /** 会话 ID */
  sessionId: string;
  /** 事件数据 */
  data: HookEventDataMap[T];
}

// =============================================================================
// Hook Result
// =============================================================================

/**
 * 钩子执行结果
 */
export interface HookResult {
  /** 是否继续执行后续钩子和操作 */
  continue: boolean;
  /** 可选的修改后数据 (用于 pre hooks 修改输入) */
  modifiedData?: unknown;
  /** 可选的替代结果 (用于 pre hooks 完全替代操作) */
  substituteResult?: unknown;
  /** 错误信息 */
  error?: Error;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 默认的继续执行结果
 */
export const HOOK_CONTINUE: HookResult = { continue: true };

/**
 * 中止执行结果
 */
export const HOOK_ABORT: HookResult = { continue: false };

// =============================================================================
// Hook Handler
// =============================================================================

/**
 * 钩子处理器
 */
export interface HookHandler<T extends HookEventType = HookEventType> {
  /** 处理器名称 (用于调试和日志) */
  name: string;
  /** 优先级 (越小越先执行, 默认 100) */
  priority: number;
  /** 处理函数 */
  handler: (event: HookEvent<T>, context: HookContext) => Promise<HookResult>;
  /** 是否启用 (默认 true) */
  enabled?: boolean;
  /** 匹配条件 (可选的过滤器) */
  filter?: (event: HookEvent<T>) => boolean;
}

// =============================================================================
// Hook Context
// =============================================================================

/**
 * 钩子执行上下文
 */
export interface HookContext {
  /** 会话 ID */
  sessionId: string;
  /** Trace ID */
  traceId: string;
  /** 当前阶段 */
  phase?: string;
  /** 钩子链是否被中止 */
  aborted: boolean;
  /** 中止原因 */
  abortReason?: string;
  /** 钩子间共享的元数据 */
  metadata: Map<string, unknown>;
  /** 中止钩子链 */
  abort: (reason?: string) => void;
  /** 设置元数据 */
  set: (key: string, value: unknown) => void;
  /** 获取元数据 */
  get: <T = unknown>(key: string) => T | undefined;
}

// =============================================================================
// Hook Middleware
// =============================================================================

/**
 * 钩子中间件 (简化的批量注册接口)
 */
export interface HookMiddleware {
  /** 中间件名称 */
  name: string;
  /** 要监听的事件类型 */
  events: HookEventType[];
  /** 要监听的阶段 */
  phases: HookPhase[];
  /** 优先级 */
  priority: number;
  /** 处理函数 */
  handler: (event: HookEvent, context: HookContext) => Promise<HookResult>;
  /** 是否启用 */
  enabled?: boolean;
}

// =============================================================================
// Hook Registry Config
// =============================================================================

/**
 * Hook 注册表配置
 */
export interface HookRegistryConfig {
  /** 是否启用 hooks */
  enabled: boolean;
  /** 默认超时时间 (ms) */
  defaultTimeout?: number;
  /** 是否在错误时继续执行 */
  continueOnError?: boolean;
  /** 初始中间件列表 */
  middleware?: HookMiddleware[];
}

/**
 * 默认配置
 */
export const DEFAULT_HOOK_REGISTRY_CONFIG: HookRegistryConfig = {
  enabled: true,
  defaultTimeout: 5000,
  continueOnError: true,
  middleware: [],
};
