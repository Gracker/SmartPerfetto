/**
 * Agent Metrics Collector
 *
 * Collects tool execution timing and SDK usage metrics per analysis session.
 * Designed as a lightweight, non-intrusive layer:
 * - Tool timing: collected via wrapToolHandler() at the tool() factory level
 * - SDK usage: recorded from sdkQuery result messages (if available)
 *
 * Data flow:
 *   tool handler → wrapToolHandler → timing recorded → original result returned
 *   sdkQuery result → recordSdkTurnInfo → turn count recorded
 *
 * Output:
 *   summarize() → SessionMetrics object → written to logs/metrics/ by ClaudeRuntime
 *
 * Design decisions (from Codex review):
 * - Tool payload measured in chars, NOT estimated tokens (avoid tokenizer mismatch)
 * - SDK model usage NOT estimated (only recorded if SDK explicitly provides it)
 * - Decorator wraps the handler function, not injected inside each tool definition
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export interface ToolExecution {
  toolName: string;
  startTime: number;
  durationMs: number;
  inputChars: number;
  outputChars: number;
  success: boolean;
  error?: string;
}

export interface TurnInfo {
  turnNumber: number;
  timestamp: number;
}

export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  turns: number;
  toolExecutions: ToolExecution[];
  toolSummary: {
    totalCalls: number;
    totalDurationMs: number;
    successCount: number;
    failureCount: number;
    byTool: Record<string, { calls: number; totalMs: number; avgMs: number; failures: number }>;
  };
}

// =============================================================================
// AgentMetricsCollector
// =============================================================================

export class AgentMetricsCollector {
  private sessionId: string;
  private startTime: number;
  private toolExecutions: ToolExecution[] = [];
  private turnCount = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startTime = Date.now();
  }

  /**
   * Wrap a tool handler function with timing instrumentation.
   * Returns a new function with the same signature that records execution metrics.
   */
  wrapToolHandler<TInput, TOutput>(
    toolName: string,
    handler: (input: TInput) => Promise<TOutput>,
  ): (input: TInput) => Promise<TOutput> {
    return async (input: TInput): Promise<TOutput> => {
      const start = Date.now();
      const inputChars = safeStringifyLength(input);
      try {
        const result = await handler(input);
        this.toolExecutions.push({
          toolName,
          startTime: start,
          durationMs: Date.now() - start,
          inputChars,
          outputChars: safeStringifyLength(result),
          success: true,
        });
        return result;
      } catch (err) {
        this.toolExecutions.push({
          toolName,
          startTime: start,
          durationMs: Date.now() - start,
          inputChars,
          outputChars: 0,
          success: false,
          error: (err as Error).message?.substring(0, 200),
        });
        throw err;
      }
    };
  }

  /**
   * Record a tool execution observed from the SDK stream.
   * Timing = time between tool_use (assistant message) and tool_use_result (user message).
   * Less precise than in-handler timing but requires no modification to tool definitions.
   */
  recordToolFromStream(toolName: string, durationMs: number, success: boolean): void {
    this.toolExecutions.push({
      toolName,
      startTime: Date.now() - durationMs,
      durationMs,
      inputChars: 0,  // Not available from stream observation
      outputChars: 0, // Not available from stream observation
      success,
    });
  }

  /** Record a turn completion from SDK stream processing. */
  recordTurn(): void {
    this.turnCount++;
  }

  /** Generate session metrics summary. */
  summarize(): SessionMetrics {
    const endTime = Date.now();
    const byTool: Record<string, { calls: number; totalMs: number; avgMs: number; failures: number }> = {};

    for (const exec of this.toolExecutions) {
      if (!byTool[exec.toolName]) {
        byTool[exec.toolName] = { calls: 0, totalMs: 0, avgMs: 0, failures: 0 };
      }
      const entry = byTool[exec.toolName];
      entry.calls++;
      entry.totalMs += exec.durationMs;
      if (!exec.success) entry.failures++;
    }

    for (const entry of Object.values(byTool)) {
      entry.avgMs = entry.calls > 0 ? Math.round(entry.totalMs / entry.calls) : 0;
    }

    const successCount = this.toolExecutions.filter(e => e.success).length;
    const totalToolMs = this.toolExecutions.reduce((sum, e) => sum + e.durationMs, 0);

    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      endTime,
      totalDurationMs: endTime - this.startTime,
      turns: this.turnCount,
      toolExecutions: this.toolExecutions,
      toolSummary: {
        totalCalls: this.toolExecutions.length,
        totalDurationMs: totalToolMs,
        successCount,
        failureCount: this.toolExecutions.length - successCount,
        byTool,
      },
    };
  }
}

// =============================================================================
// Metrics Persistence
// =============================================================================

const METRICS_DIR = path.resolve(__dirname, '../../logs/metrics');
const METRICS_RETENTION_DAYS = 7;

/** Write session metrics to disk. */
export function persistSessionMetrics(metrics: SessionMetrics): void {
  try {
    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }
    const fileName = `session_${metrics.sessionId}_metrics.json`;
    const filePath = path.join(METRICS_DIR, fileName);
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(metrics, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn('[AgentMetrics] Failed to persist metrics:', (err as Error).message);
  }
}

/** Clean up old metrics files (called at backend startup). */
export function cleanupOldMetrics(): void {
  try {
    if (!fs.existsSync(METRICS_DIR)) return;
    const cutoff = Date.now() - METRICS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(METRICS_DIR);
    for (const file of files) {
      if (!file.endsWith('_metrics.json')) continue;
      const filePath = path.join(METRICS_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    console.warn('[AgentMetrics] Failed to cleanup old metrics:', (err as Error).message);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function safeStringifyLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
