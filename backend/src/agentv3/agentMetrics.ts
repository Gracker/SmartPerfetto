// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

export interface CacheMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** Ratio of cache-read tokens to total input tokens (0-1). Higher = better prefix caching. */
  cacheHitRate: number;
}

/** Per-turn performance metrics collected from SDK stream. */
export interface TurnMetricsSummary {
  totalTurns: number;
  totalDurationMs: number;
  totalToolCalls: number;
  totalPayloadBytes: number;
  turns: Array<{
    turn: number;
    durationMs?: number;
    firstTokenMs?: number;
    tools: string[];
    payloadBytes: number;
    thinking: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }>;
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
  /** SDK token usage and prompt cache metrics (recorded from result message). */
  cache?: CacheMetrics;
  /** Per-turn performance metrics for optimization analysis. */
  turnMetrics?: TurnMetricsSummary;
  /** Analysis mode the orchestrator ran in ('fast' quick path / 'full' pipeline / 'auto' classifier-driven). */
  analysisMode?: 'fast' | 'full' | 'auto';
  /** Origin of the complexity decision — explicit user choice, deterministic rule, or AI classifier. */
  classifierSource?: 'user_explicit' | 'hard_rule' | 'ai';
}

// =============================================================================
// AgentMetricsCollector
// =============================================================================

export class AgentMetricsCollector {
  private sessionId: string;
  private startTime: number;
  private toolExecutions: ToolExecution[] = [];
  private turnCount = 0;
  private cacheMetrics: CacheMetrics | null = null;
  private turnMetricsSummary: TurnMetricsSummary | null = null;
  private analysisMode: 'fast' | 'full' | 'auto' | null = null;
  private classifierSource: 'user_explicit' | 'hard_rule' | 'ai' | null = null;

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

  /**
   * Record SDK result usage metrics for prompt cache analysis.
   * Called once per analysis when the SDK result message arrives.
   */
  recordSdkUsage(result: {
    usage?: Record<string, number | null>;
    modelUsage?: Record<string, Record<string, number>>;
    total_cost_usd?: number;
  }): void {
    const usage = result.usage;
    if (!usage) return;

    const inputTokens = (usage.input_tokens ?? 0) as number;
    const outputTokens = (usage.output_tokens ?? 0) as number;
    const cacheCreation = (usage.cache_creation_input_tokens ?? 0) as number;
    const cacheRead = (usage.cache_read_input_tokens ?? 0) as number;
    const totalInput = inputTokens + cacheCreation + cacheRead;

    this.cacheMetrics = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
      totalCostUsd: (result.total_cost_usd ?? 0) as number,
      cacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    };

    // Log cache effectiveness for monitoring
    const hitPct = (this.cacheMetrics.cacheHitRate * 100).toFixed(1);
    console.log(
      `[AgentMetrics] [${this.sessionId}] Prompt cache: ` +
      `${cacheRead} read / ${cacheCreation} created / ${inputTokens} uncached ` +
      `(hit rate: ${hitPct}%, cost: $${this.cacheMetrics.totalCostUsd.toFixed(4)})`,
    );
  }

  /** Record per-turn metrics collected from SDK stream processing. */
  recordTurnMetrics(summary: TurnMetricsSummary): void {
    this.turnMetricsSummary = summary;
  }

  /** Record the analysis mode (explicit from UI/CLI or inferred by classifier). */
  recordAnalysisMode(
    mode: 'fast' | 'full' | 'auto',
    source: 'user_explicit' | 'hard_rule' | 'ai',
  ): void {
    this.analysisMode = mode;
    this.classifierSource = source;
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
      ...(this.cacheMetrics ? { cache: this.cacheMetrics } : {}),
      ...(this.turnMetricsSummary ? { turnMetrics: this.turnMetricsSummary } : {}),
      ...(this.analysisMode ? { analysisMode: this.analysisMode } : {}),
      ...(this.classifierSource ? { classifierSource: this.classifierSource } : {}),
    };
  }
}

// =============================================================================
// Metrics Persistence
// =============================================================================

export const METRICS_DIR = path.resolve(__dirname, '../../logs/metrics');
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