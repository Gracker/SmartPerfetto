/**
 * Hook Context
 *
 * 钩子执行上下文，提供钩子间的通信和控制能力
 */

import { HookContext } from './hookTypes';

// =============================================================================
// Hook Context Factory
// =============================================================================

/**
 * 创建钩子执行上下文
 */
export function createHookContext(
  sessionId: string,
  traceId: string,
  phase?: string
): HookContext {
  const metadata = new Map<string, unknown>();
  let aborted = false;
  let abortReason: string | undefined;

  const context: HookContext = {
    sessionId,
    traceId,
    phase,
    get aborted() {
      return aborted;
    },
    get abortReason() {
      return abortReason;
    },
    metadata,

    abort(reason?: string) {
      aborted = true;
      abortReason = reason;
    },

    set(key: string, value: unknown) {
      metadata.set(key, value);
    },

    get<T = unknown>(key: string): T | undefined {
      return metadata.get(key) as T | undefined;
    },
  };

  return context;
}

// =============================================================================
// Hook Context Utilities
// =============================================================================

/**
 * 从现有上下文创建子上下文 (继承元数据)
 */
export function deriveHookContext(
  parent: HookContext,
  overrides?: Partial<Pick<HookContext, 'sessionId' | 'traceId' | 'phase'>>
): HookContext {
  const child = createHookContext(
    overrides?.sessionId ?? parent.sessionId,
    overrides?.traceId ?? parent.traceId,
    overrides?.phase ?? parent.phase
  );

  // 复制父上下文的元数据
  for (const [key, value] of parent.metadata) {
    child.metadata.set(key, value);
  }

  return child;
}

/**
 * 合并多个上下文的元数据
 */
export function mergeContextMetadata(
  target: HookContext,
  ...sources: HookContext[]
): void {
  for (const source of sources) {
    for (const [key, value] of source.metadata) {
      target.metadata.set(key, value);
    }
  }
}
