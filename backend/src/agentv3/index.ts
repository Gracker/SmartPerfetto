export { ClaudeRuntime } from './claudeRuntime';
export { isClaudeCodeEnabled, loadClaudeConfig } from './claudeConfig';
export type { ClaudeAgentConfig } from './claudeConfig';
export type { ClaudeSessionMapping, ClaudeAnalysisContext, McpToolResult } from './types';

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { ClaudeAgentConfig } from './claudeConfig';
import { ClaudeRuntime } from './claudeRuntime';

export function createClaudeRuntime(
  traceProcessorService: TraceProcessorService,
  config?: Partial<ClaudeAgentConfig>,
): ClaudeRuntime {
  return new ClaudeRuntime(traceProcessorService, config);
}
