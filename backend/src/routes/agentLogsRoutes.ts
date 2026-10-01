// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import express from 'express';
import { featureFlagsConfig } from '../config';
import { requireRequestContext } from '../middleware/auth';
import { sendRouteFailure } from '../middleware/routeFailure';
import { isPrivilegedRequestContext, sendResourceNotFound } from '../services/resourceOwnership';
import { getSessionLoggerManager } from '../services/sessionLogger';
import { getLogLevel, setLogLevel, type LogLevel } from '../utils/logger';
import { metricsDir, type SessionMetrics } from '../agentv3/agentMetrics';

export function registerAgentLogsRoutes(router: express.Router): void {
  router.use('/logs', (_req, res, next) => {
    if (!featureFlagsConfig.enableAgentLogsApi) {
      return res.status(503).json({
        success: false,
        error: 'Agent logs API is disabled by FEATURE_AGENT_LOGS_API',
        code: 'FEATURE_DISABLED',
      });
    }
    next();
  });

  router.use('/logs', (req, res, next) => {
    if (!isPrivilegedRequestContext(requireRequestContext(req))) {
      return sendResourceNotFound(res);
    }
    next();
  });

  router.get('/logs', (_req, res) => {
    try {
      const manager = getSessionLoggerManager();
      const sessions = manager.listSessions();

      res.json({
        success: true,
        logDir: manager.getLogDir(),
        sessions,
        count: sessions.length,
      });
    } catch (error: unknown) {
      sendRouteFailure(res, {
        code: 'agent_logs_list_failed',
        error: 'Failed to list agent logs',
        logLabel: '[AgentLogs] List logs error',
      }, error);
    }
  });

  router.get('/logs/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const { level, component, search, limit } = req.query;

    try {
      const manager = getSessionLoggerManager();
      const logs = manager.readSessionLogs(sessionId, {
        level: level as any,
        component: component as string,
        search: search as string,
        limit: limit ? parseInt(limit as string, 10) : undefined,
      });

      res.json({
        success: true,
        sessionId,
        logs,
        count: logs.length,
      });
    } catch (error: unknown) {
      sendRouteFailure(res, {
        code: 'agent_logs_read_failed',
        error: 'Failed to read agent logs',
        logLabel: '[AgentLogs] Read logs error',
      }, error);
    }
  });

  router.get('/logs/:sessionId/errors', (req, res) => {
    const { sessionId } = req.params;

    try {
      const manager = getSessionLoggerManager();
      const logs = manager.readSessionLogs(sessionId, {
        level: ['error', 'warn'],
      });

      res.json({
        success: true,
        sessionId,
        logs,
        errorCount: logs.filter((l) => l.level === 'error').length,
        warnCount: logs.filter((l) => l.level === 'warn').length,
      });
    } catch (error: unknown) {
      sendRouteFailure(res, {
        code: 'agent_logs_read_failed',
        error: 'Failed to read agent logs',
        logLabel: '[AgentLogs] Read error logs error',
      }, error);
    }
  });

  // ─── Runtime log level management ───────────────────────────────────
  router.get('/admin/log-level', (_req, res) => {
    res.json({
      success: true,
      level: getLogLevel(),
      envDefault: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    });
  });

  router.put('/admin/log-level', (req, res) => {
    const { level } = req.body;
    try {
      setLogLevel(level === null ? null : (level as LogLevel));
      res.json({
        success: true,
        level: getLogLevel(),
        message: level === null
          ? 'Reverted to env var default'
          : `Log level set to '${level}'`,
      });
    } catch (error: unknown) {
      // setLogLevel's own validation text names the valid levels.
      res.status(400).json({
        success: false,
        code: 'invalid_log_level',
        error: error instanceof Error ? error.message : 'Invalid log level',
      });
    }
  });

  // ─── Cross-session metrics aggregation ──────────────────────────────
  router.get('/logs/metrics/summary', (req, res) => {
    const { days = '7' } = req.query;
    const maxAgeDays = parseInt(days as string, 10) || 7;

    try {
      const dir = metricsDir();
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('_metrics.json'));
      } catch {
        return res.json({ success: true, sessions: 0, summary: null });
      }

      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const allMetrics: SessionMetrics[] = [];
      for (const file of files) {
        try {
          const filePath = `${dir}/${file}`;
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionMetrics;
          allMetrics.push(data);
        } catch {
          // Skip malformed files
        }
      }

      if (allMetrics.length === 0) {
        return res.json({ success: true, sessions: 0, summary: null });
      }

      // Single-pass aggregation
      const durations: number[] = [];
      const byTool: Record<string, { calls: number; totalMs: number; failures: number; avgMsValues: number[] }> = {};
      let totalToolCalls = 0;
      let totalToolFailures = 0;
      let totalTurns = 0;

      for (const m of allMetrics) {
        durations.push(m.totalDurationMs);
        totalTurns += m.turns;
        totalToolCalls += m.toolSummary.totalCalls;
        totalToolFailures += m.toolSummary.failureCount;
        for (const [toolName, stats] of Object.entries(m.toolSummary.byTool)) {
          if (!byTool[toolName]) {
            byTool[toolName] = { calls: 0, totalMs: 0, failures: 0, avgMsValues: [] };
          }
          const entry = byTool[toolName];
          entry.calls += stats.calls;
          entry.totalMs += stats.totalMs;
          entry.failures += stats.failures;
          // Collect per-session avgMs for percentile (one point per session, not expanded)
          entry.avgMsValues.push(stats.avgMs);
        }
      }

      durations.sort((a, b) => a - b);

      // Build final per-tool summary
      const byToolSummary: Record<string, { calls: number; avgMs: number; p50Ms: number; p95Ms: number; failures: number }> = {};
      for (const [toolName, entry] of Object.entries(byTool)) {
        entry.avgMsValues.sort((a, b) => a - b);
        byToolSummary[toolName] = {
          calls: entry.calls,
          avgMs: entry.calls > 0 ? Math.round(entry.totalMs / entry.calls) : 0,
          p50Ms: percentile(entry.avgMsValues, 0.5),
          p95Ms: percentile(entry.avgMsValues, 0.95),
          failures: entry.failures,
        };
      }

      res.json({
        success: true,
        sessions: allMetrics.length,
        timeRange: {
          days: maxAgeDays,
          from: new Date(cutoff).toISOString(),
          to: new Date().toISOString(),
        },
        summary: {
          totalDuration: {
            avgMs: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            minMs: durations[0],
            maxMs: durations[durations.length - 1],
          },
          totalTurns,
          avgTurnsPerSession: Math.round(totalTurns / allMetrics.length * 10) / 10,
          toolCalls: {
            total: totalToolCalls,
            failures: totalToolFailures,
            failureRate: totalToolCalls > 0 ? Math.round(totalToolFailures / totalToolCalls * 10000) / 100 : 0,
          },
          byTool: byToolSummary,
        },
      });
    } catch (error: unknown) {
      sendRouteFailure(res, {
        code: 'agent_metrics_summary_failed',
        error: 'Failed to summarize agent metrics',
        logLabel: '[AgentLogs] Metrics summary error',
      }, error);
    }
  });

  router.post('/logs/cleanup', (req, res) => {
    const { maxAgeDays = 7 } = req.body;

    try {
      const manager = getSessionLoggerManager();
      const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
      const deletedCount = manager.cleanup(maxAgeMs);

      res.json({
        success: true,
        deletedCount,
        message: `Deleted ${deletedCount} log files older than ${maxAgeDays} days`,
      });
    } catch (error: unknown) {
      sendRouteFailure(res, {
        code: 'agent_logs_cleanup_failed',
        error: 'Failed to clean up agent logs',
        logLabel: '[AgentLogs] Cleanup error',
      }, error);
    }
  });
}

/** Nearest-rank percentile from a sorted array (p in 0-1 range). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
