// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';

/**
 * Simple Logger Utility
 *
 * Controls log verbosity via LOG_LEVEL environment variable:
 * - error: Only errors
 * - warn: Errors + warnings
 * - info: Errors + warnings + info (default)
 * - debug: All logs including verbose SQL queries
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let runtimeLevel: LogLevel | null = null;
const envLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

function parseLevel(raw?: string | null): LogLevel {
  const level = (raw || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, level) ? level as LogLevel : 'info';
}

/** Get the current effective log level. */
export function getLogLevel(): LogLevel {
  return runtimeLevel ?? envLevel;
}

function getCurrentLevel(): number {
  return LOG_LEVELS[getLogLevel()];
}

/** Set log level at runtime. Pass null to revert to env var default. */
export function setLogLevel(level: LogLevel | null): void {
  if (level !== null && !Object.prototype.hasOwnProperty.call(LOG_LEVELS, level)) {
    throw new Error(`Invalid log level: ${level}. Valid: ${Object.keys(LOG_LEVELS).join(', ')}`);
  }
  runtimeLevel = level;
}

export function sqlLogIdentity(sql: string): string {
  const hash = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  return `sha256=${hash} bytes=${Buffer.byteLength(sql, 'utf8')}`;
}

export interface DiagnosticLogContext {
  /** Stable subsystem name supplied by the caller; never derived from private text. */
  domain?: string;
  /** Stable failure code supplied by the caller. */
  code?: string;
  /** Opt in only for trace-processor/SQL diagnostics. */
  classifier?: 'sql';
}

function stableDiagnosticToken(value: string | undefined, fallback: string): string {
  const token = value?.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return token || fallback;
}

export function diagnosticLogIdentity(
  message: string,
  context: DiagnosticLogContext = {},
): string {
  const hash = createHash('sha256').update(message).digest('hex').slice(0, 16);
  let code = stableDiagnosticToken(context.code, 'error');
  if (context.classifier === 'sql' && context.code === undefined) {
    const normalized = message.toLowerCase();
    code = normalized.includes('timeout')
      ? 'timeout'
      : normalized.includes('no such table')
        ? 'missing_table'
        : normalized.includes('no such column')
          ? 'missing_column'
          : normalized.includes('no such function')
            ? 'missing_function'
          : normalized.includes('syntax') || normalized.includes('parse')
            ? 'syntax'
            : 'query_error';
  }
  const domain = stableDiagnosticToken(context.domain, context.classifier === 'sql' ? 'sql' : 'generic');
  // Only an anchored schema diagnosis with a bare SQL identifier is safe to
  // retain. SQL excerpts, quoted literals, paths and arbitrary native errors
  // stay behind the hash; the first line often contains the query itself.
  const diagnosisLines = message.trim().split(/\r?\n/);
  const diagnosis = diagnosisLines[diagnosisLines.length - 1] ?? '';
  const schemaError = context.classifier === 'sql' && diagnosis.length <= 256
    ? /^(?:error:\s*)?no such (column|table|function):\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?: \(line \d+, col \d+\))?$/i
      .exec(diagnosis)
    : null;
  if (schemaError && context.code === undefined) code = `missing_${schemaError[1].toLowerCase()}`;
  const detail = schemaError ? ` message=no such ${schemaError[1].toLowerCase()}: ${schemaError[2]}` : '';
  return `domain=${domain} code=${code}${detail} sha256=${hash} bytes=${Buffer.byteLength(message, 'utf8')}`;
}

export const logger = {
  error: (tag: string, message: string, ...args: any[]) => {
    console.error(`[${tag}] ${message}`, ...args);
  },

  warn: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.warn) {
      console.warn(`[${tag}] ${message}`, ...args);
    }
  },

  info: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.info) {
      console.log(`[${tag}] ${message}`, ...args);
    }
  },

  debug: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.debug) {
      console.log(`[${tag}] ${message}`, ...args);
    }
  },

  /** Log SQL queries only in debug mode */
  sql: (tag: string, sql: string, durationMs?: number) => {
    if (getCurrentLevel() >= LOG_LEVELS.debug) {
      const identity = sqlLogIdentity(sql);
      if (durationMs !== undefined) {
        console.log(`[${tag}] SQL (${durationMs}ms): ${identity}`);
      } else {
        console.log(`[${tag}] SQL: ${identity}`);
      }
    }
  },
};

export default logger;
