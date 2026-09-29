// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import { OrchestratorTrace } from './types';

export interface RecordedTrace {
  id: string;
  timestamp: string;
  query: string;
  traceId: string;
  orchestratorTrace: OrchestratorTrace;
  metadata: {
    totalDurationMs: number;
    totalLLMCalls: number;
    totalToolCalls: number;
    totalFindings: number;
    expertCount: number;
    confidence: number;
  };
}

export interface TraceRecorderConfig {
  outputDir: string;
  enabled: boolean;
  maxTraces?: number;
}

export class AgentTraceRecorder {
  private config: TraceRecorderConfig;
  private traces: RecordedTrace[] = [];

  constructor(config?: Partial<TraceRecorderConfig>) {
    this.config = {
      outputDir: config?.outputDir || path.join(process.cwd(), 'agent-traces'),
      enabled: config?.enabled ?? true,
      maxTraces: config?.maxTraces || 100,
    };
    
    if (this.config.enabled) {
      this.ensureOutputDir();
    }
  }

  private ensureOutputDir(): void {
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  record(
    query: string,
    traceId: string,
    orchestratorTrace: OrchestratorTrace,
    confidence: number
  ): RecordedTrace {
    const totalToolCalls = orchestratorTrace.expertTraces.reduce(
      (sum, et) => sum + et.toolCalls.length,
      0
    );

    const recorded: RecordedTrace = {
      id: `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      query,
      traceId,
      orchestratorTrace,
      metadata: {
        totalDurationMs: orchestratorTrace.totalDuration,
        totalLLMCalls: orchestratorTrace.totalLLMCalls,
        totalToolCalls,
        totalFindings: orchestratorTrace.expertTraces.reduce(
          (sum, et) => sum + et.thoughts.filter(t => t.decision === 'conclude').length,
          0
        ),
        expertCount: orchestratorTrace.expertTraces.length,
        confidence,
      },
    };

    this.traces.push(recorded);

    if (this.traces.length > this.config.maxTraces!) {
      this.traces.shift();
    }

    if (this.config.enabled) {
      this.saveTrace(recorded);
    }

    return recorded;
  }

  private saveTrace(trace: RecordedTrace): void {
    const filename = `${trace.id}.json`;
    const filepath = path.join(this.config.outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(trace, null, 2));
  }

  getTrace(id: string): RecordedTrace | undefined {
    return this.traces.find(t => t.id === id);
  }

  getRecentTraces(limit: number = 10): RecordedTrace[] {
    return this.traces.slice(-limit);
  }

  getStatistics(): {
    totalTraces: number;
    avgDurationMs: number;
    avgConfidence: number;
    avgToolCalls: number;
    avgLLMCalls: number;
  } {
    if (this.traces.length === 0) {
      return {
        totalTraces: 0,
        avgDurationMs: 0,
        avgConfidence: 0,
        avgToolCalls: 0,
        avgLLMCalls: 0,
      };
    }

    const sum = this.traces.reduce(
      (acc, t) => ({
        duration: acc.duration + t.metadata.totalDurationMs,
        confidence: acc.confidence + t.metadata.confidence,
        toolCalls: acc.toolCalls + t.metadata.totalToolCalls,
        llmCalls: acc.llmCalls + t.metadata.totalLLMCalls,
      }),
      { duration: 0, confidence: 0, toolCalls: 0, llmCalls: 0 }
    );

    const count = this.traces.length;
    return {
      totalTraces: count,
      avgDurationMs: Math.round(sum.duration / count),
      avgConfidence: Math.round((sum.confidence / count) * 100) / 100,
      avgToolCalls: Math.round((sum.toolCalls / count) * 10) / 10,
      avgLLMCalls: Math.round((sum.llmCalls / count) * 10) / 10,
    };
  }

  loadTracesFromDisk(): void {
    if (!fs.existsSync(this.config.outputDir)) return;

    const files = fs.readdirSync(this.config.outputDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files.slice(-this.config.maxTraces!)) {
      try {
        const content = fs.readFileSync(path.join(this.config.outputDir, file), 'utf-8');
        const trace = JSON.parse(content) as RecordedTrace;
        this.traces.push(trace);
      } catch {
      }
    }
  }
}

let globalRecorder: AgentTraceRecorder | null = null;

export function getAgentTraceRecorder(config?: Partial<TraceRecorderConfig>): AgentTraceRecorder {
  if (!globalRecorder) {
    globalRecorder = new AgentTraceRecorder(config);
    globalRecorder.loadTracesFromDisk();
  }
  return globalRecorder;
}
