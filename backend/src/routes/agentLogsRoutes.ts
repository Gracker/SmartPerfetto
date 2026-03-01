import express from 'express';
import { featureFlagsConfig } from '../config';
import { getSessionLoggerManager } from '../services/sessionLogger';

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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });
}
