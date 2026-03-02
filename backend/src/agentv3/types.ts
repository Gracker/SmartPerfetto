import type { ArchitectureInfo } from '../agent/detectors/types';
import type { Finding } from '../agent/types';

export interface McpToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  durationMs: number;
  error?: string;
}

export interface SqlSchemaEntry {
  id: string;
  name: string;
  category: string;
  type: 'function' | 'view' | 'table';
  description: string;
}

export interface SqlSchemaIndex {
  version: string;
  generatedAt: string;
  templates: SqlSchemaEntry[];
}

/**
 * Maps a SmartPerfetto sessionId to Claude Agent SDK session state
 * for multi-turn conversation continuity via the V2 session API.
 */
export interface ClaudeSessionMapping {
  smartPerfettoSessionId: string;
  sdkSessionId?: string;
  traceId: string;
  architecture?: ArchitectureInfo;
  lastActivityAt: number;
}

/** Context assembled before calling Claude, injected into the system prompt. */
export interface ClaudeAnalysisContext {
  query: string;
  architecture?: ArchitectureInfo;
  packageName?: string;
  previousFindings?: Finding[];
  conversationSummary?: string;
  skillCatalog?: Array<{ id: string; displayName: string; description: string; type: string }>;
}
