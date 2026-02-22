/**
 * Session Logger Service
 *
 * Provides session-based logging with persistence for debugging.
 * Each analysis session gets its own log file that persists across restarts.
 *
 * Features:
 * - Per-session log files (JSON Lines format)
 * - Log levels: debug, info, warn, error
 * - Automatic timestamp and context injection
 * - Log rotation and cleanup
 * - Query interface for debugging
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Types
// =============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  sessionId: string;
  component: string;
  message: string;
  data?: any;
  duration?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LogQuery {
  sessionId?: string;
  level?: LogLevel | LogLevel[];
  component?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  search?: string;
}

export interface SessionLogSummary {
  sessionId: string;
  startTime: string;
  endTime?: string;
  logCount: number;
  errorCount: number;
  warnCount: number;
  components: string[];
  traceId?: string;
  query?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_LOG_DIR = path.join(process.cwd(), 'logs', 'sessions');
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_LOGS_PER_SESSION = 10000;
const MAX_LOG_DEPTH = 5;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 512;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN = /(authorization|token|api[-_]?key|secret|password|passwd|cookie|set-cookie|credential|session)/i;

function truncateLogString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_STRING_LENGTH)}…(truncated ${value.length - MAX_STRING_LENGTH} chars)`;
}

function sanitizeLogValue(value: any, depth: number, seen: WeakSet<object>): any {
  if (value == null) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateLogString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (depth >= MAX_LOG_DEPTH) {
    return '[MaxDepthReached]';
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogValue(item, depth + 1, seen));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = REDACTED;
      continue;
    }
    sanitized[key] = sanitizeLogValue(nested, depth + 1, seen);
  }
  return sanitized;
}

export function sanitizeLogData(data: any): any {
  return sanitizeLogValue(data, 0, new WeakSet<object>());
}

// =============================================================================
// Session Logger Class
// =============================================================================

export class SessionLogger {
  private logDir: string;
  private sessionId: string;
  private logFile: string;
  private logCount: number = 0;
  private metadata: Record<string, any> = {};
  private startTime: Date;

  constructor(sessionId: string, logDir: string = DEFAULT_LOG_DIR) {
    this.sessionId = sessionId;
    this.logDir = logDir;
    this.startTime = new Date();

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Create session log file
    const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(this.logDir, `session_${sessionId}_${timestamp}.jsonl`);

    // Write session start marker
    this.writeEntry({
      timestamp: this.startTime.toISOString(),
      level: 'info',
      sessionId: this.sessionId,
      component: 'SessionLogger',
      message: 'Session started',
      data: { logFile: this.logFile },
    });
  }

  /**
   * Set session metadata (traceId, query, etc.)
   */
  setMetadata(metadata: Record<string, any>): void {
    this.metadata = { ...this.metadata, ...metadata };
    this.info('SessionLogger', 'Metadata updated', metadata);
  }

  /**
   * Log a debug message
   */
  debug(component: string, message: string, data?: any): void {
    this.log('debug', component, message, data);
  }

  /**
   * Log an info message
   */
  info(component: string, message: string, data?: any): void {
    this.log('info', component, message, data);
  }

  /**
   * Log a warning message
   */
  warn(component: string, message: string, data?: any): void {
    this.log('warn', component, message, data);
  }

  /**
   * Log an error message
   */
  error(component: string, message: string, error?: Error | any, data?: any): void {
    const errorInfo = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : error
        ? { name: 'Error', message: String(error) }
        : undefined;

    this.log('error', component, message, data, errorInfo);
  }

  /**
   * Log with timing (for performance tracking)
   */
  timed<T>(component: string, operation: string, fn: () => T): T {
    const startTime = Date.now();
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.then(
          (res) => {
            this.info(component, `${operation} completed`, { duration: Date.now() - startTime });
            return res;
          },
          (err) => {
            this.error(component, `${operation} failed`, err, { duration: Date.now() - startTime });
            throw err;
          }
        ) as T;
      }
      this.info(component, `${operation} completed`, { duration: Date.now() - startTime });
      return result;
    } catch (err) {
      this.error(component, `${operation} failed`, err, { duration: Date.now() - startTime });
      throw err;
    }
  }

  /**
   * Core log method
   */
  private log(
    level: LogLevel,
    component: string,
    message: string,
    data?: any,
    error?: { name: string; message: string; stack?: string }
  ): void {
    if (this.logCount >= MAX_LOGS_PER_SESSION) {
      return; // Prevent runaway logging
    }

    const sanitizedData = data === undefined ? undefined : sanitizeLogData(data);

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      sessionId: this.sessionId,
      component,
      message,
      data: sanitizedData,
      error,
    };

    this.writeEntry(entry);

    // Also log to console in development
    if (process.env.NODE_ENV !== 'production') {
      const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${this.sessionId.slice(0, 8)}] [${component}]`;
      const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      consoleMethod(prefix, message, sanitizedData || '');
    }
  }

  /**
   * Write entry to log file
   */
  private writeEntry(entry: LogEntry): void {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
      this.logCount++;
    } catch (err) {
      console.error('[SessionLogger] Failed to write log entry:', err);
    }
  }

  /**
   * Read all logs for this session
   */
  readLogs(): LogEntry[] {
    try {
      if (!fs.existsSync(this.logFile)) {
        return [];
      }
      const content = fs.readFileSync(this.logFile, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter((line) => line)
        .map((line) => JSON.parse(line));
    } catch (err) {
      console.error('[SessionLogger] Failed to read logs:', err);
      return [];
    }
  }

  /**
   * Get session summary
   */
  getSummary(): SessionLogSummary {
    const logs = this.readLogs();
    const components = new Set<string>();
    let errorCount = 0;
    let warnCount = 0;

    for (const log of logs) {
      components.add(log.component);
      if (log.level === 'error') errorCount++;
      if (log.level === 'warn') warnCount++;
    }

    return {
      sessionId: this.sessionId,
      startTime: this.startTime.toISOString(),
      endTime: logs.length > 0 ? logs[logs.length - 1].timestamp : undefined,
      logCount: logs.length,
      errorCount,
      warnCount,
      components: Array.from(components),
      traceId: this.metadata.traceId,
      query: this.metadata.query,
    };
  }

  /**
   * Get the log file path
   */
  getLogFilePath(): string {
    return this.logFile;
  }

  /**
   * Close the session (write end marker)
   */
  close(): void {
    this.info('SessionLogger', 'Session closed', {
      duration: Date.now() - this.startTime.getTime(),
      logCount: this.logCount,
    });
  }
}

// =============================================================================
// Session Logger Manager
// =============================================================================

class SessionLoggerManager {
  private logDir: string;
  private loggers: Map<string, SessionLogger> = new Map();

  constructor(logDir: string = DEFAULT_LOG_DIR) {
    this.logDir = logDir;

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Get or create a logger for a session
   */
  getLogger(sessionId: string): SessionLogger {
    let logger = this.loggers.get(sessionId);
    if (!logger) {
      logger = new SessionLogger(sessionId, this.logDir);
      this.loggers.set(sessionId, logger);
    }
    return logger;
  }

  /**
   * Close and remove a logger
   */
  closeLogger(sessionId: string): void {
    const logger = this.loggers.get(sessionId);
    if (logger) {
      logger.close();
      this.loggers.delete(sessionId);
    }
  }

  /**
   * List all session log files
   */
  listSessions(): SessionLogSummary[] {
    const summaries: SessionLogSummary[] = [];

    try {
      const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const match = file.match(/^session_([^_]+)_/);
        if (match) {
          const sessionId = match[1];
          const filePath = path.join(this.logDir, file);

          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n').filter((l) => l);
            const logs: LogEntry[] = lines.map((l) => JSON.parse(l));

            if (logs.length > 0) {
              const components = new Set<string>();
              let errorCount = 0;
              let warnCount = 0;
              let traceId: string | undefined;
              let query: string | undefined;

              for (const log of logs) {
                components.add(log.component);
                if (log.level === 'error') errorCount++;
                if (log.level === 'warn') warnCount++;
                if (log.data?.traceId) traceId = log.data.traceId;
                if (log.data?.query) query = log.data.query;
              }

              summaries.push({
                sessionId,
                startTime: logs[0].timestamp,
                endTime: logs[logs.length - 1].timestamp,
                logCount: logs.length,
                errorCount,
                warnCount,
                components: Array.from(components),
                traceId,
                query,
              });
            }
          } catch (err) {
            // Skip invalid files
          }
        }
      }
    } catch (err) {
      console.error('[SessionLoggerManager] Failed to list sessions:', err);
    }

    return summaries.sort((a, b) => b.startTime.localeCompare(a.startTime));
  }

  /**
   * Read logs for a specific session
   */
  readSessionLogs(sessionId: string, query?: Partial<LogQuery>): LogEntry[] {
    // First check if we have an active logger
    const activeLogger = this.loggers.get(sessionId);
    if (activeLogger) {
      return this.filterLogs(activeLogger.readLogs(), query);
    }

    // Otherwise, find the log file
    try {
      const files = fs.readdirSync(this.logDir).filter((f) => f.startsWith(`session_${sessionId}`));
      if (files.length === 0) {
        return [];
      }

      // Read the most recent file for this session
      const file = files.sort().reverse()[0];
      const filePath = path.join(this.logDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const logs = content
        .trim()
        .split('\n')
        .filter((l) => l)
        .map((l) => JSON.parse(l));

      return this.filterLogs(logs, query);
    } catch (err) {
      console.error('[SessionLoggerManager] Failed to read session logs:', err);
      return [];
    }
  }

  /**
   * Filter logs based on query
   */
  private filterLogs(logs: LogEntry[], query?: Partial<LogQuery>): LogEntry[] {
    if (!query) return logs;

    let filtered = logs;

    if (query.level) {
      const levels = Array.isArray(query.level) ? query.level : [query.level];
      filtered = filtered.filter((l) => levels.includes(l.level));
    }

    if (query.component) {
      filtered = filtered.filter((l) => l.component.includes(query.component!));
    }

    if (query.startTime) {
      filtered = filtered.filter((l) => new Date(l.timestamp) >= query.startTime!);
    }

    if (query.endTime) {
      filtered = filtered.filter((l) => new Date(l.timestamp) <= query.endTime!);
    }

    if (query.search) {
      const searchLower = query.search.toLowerCase();
      filtered = filtered.filter(
        (l) =>
          l.message.toLowerCase().includes(searchLower) ||
          JSON.stringify(l.data || {}).toLowerCase().includes(searchLower)
      );
    }

    if (query.limit) {
      filtered = filtered.slice(-query.limit);
    }

    return filtered;
  }

  /**
   * Clean up old log files
   */
  cleanup(maxAgeMs: number = MAX_LOG_AGE_MS): number {
    let deletedCount = 0;
    const now = Date.now();

    try {
      const files = fs.readdirSync(this.logDir).filter((f) => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    } catch (err) {
      console.error('[SessionLoggerManager] Cleanup error:', err);
    }

    return deletedCount;
  }

  /**
   * Get the log directory path
   */
  getLogDir(): string {
    return this.logDir;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let managerInstance: SessionLoggerManager | null = null;

export function getSessionLoggerManager(): SessionLoggerManager {
  if (!managerInstance) {
    managerInstance = new SessionLoggerManager();
  }
  return managerInstance;
}

export function createSessionLogger(sessionId: string): SessionLogger {
  return getSessionLoggerManager().getLogger(sessionId);
}

// =============================================================================
// Express Middleware
// =============================================================================

import { Request, Response, NextFunction } from 'express';

/**
 * Express middleware for request logging
 */
export function requestLoggingMiddleware(sessionIdExtractor: (req: Request) => string | undefined) {
  return (req: Request, res: Response, next: NextFunction) => {
    const sessionId = sessionIdExtractor(req);
    if (!sessionId) {
      return next();
    }

    const logger = getSessionLoggerManager().getLogger(sessionId);
    const startTime = Date.now();

    // Attach logger to request for use in route handlers
    (req as any).sessionLogger = logger;

    // Log request
    logger.info('HTTP', `${req.method} ${req.path}`, {
      query: req.query,
      params: req.params,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
      },
    });

    // Log response using appropriate public method based on status code
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const logData = {
        statusCode: res.statusCode,
        duration,
      };
      const message = `${req.method} ${req.path} ${res.statusCode}`;

      if (res.statusCode >= 500) {
        logger.error('HTTP', message, undefined, logData);
      } else if (res.statusCode >= 400) {
        logger.warn('HTTP', message, logData);
      } else {
        logger.info('HTTP', message, logData);
      }
    });

    next();
  };
}

export default {
  SessionLogger,
  SessionLoggerManager,
  getSessionLoggerManager,
  createSessionLogger,
  requestLoggingMiddleware,
};
