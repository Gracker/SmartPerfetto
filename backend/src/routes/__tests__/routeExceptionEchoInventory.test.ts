// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Every place the HTTP layer (index.ts, middleware, routes, controllers) reads
 * an exception's text outside a log call.
 * Route catch blocks answer arbitrary downstream exceptions with fixed text
 * (`sendRouteFailure`); what remains is a typed error SmartPerfetto wrote for
 * the caller, a reason token, or the analysis-run failure surface. A new entry
 * must be one of those too: adjust this inventory only after checking that the
 * echoed error cannot carry a downstream message.
 *
 * The scan is per line and skips whole (multi-line) console/logger calls, so a
 * log-only use does not hide a new echo elsewhere in the same file. The
 * behaviour itself is covered by the canary suites (routeFailureLeak,
 * routeFailureVariants).
 */

import * as fs from 'fs';
import * as path from 'path';

const EXCEPTION_TEXT = /\b(?:e|err|error|\w+Error)\??\.message\b|\berrorMessage\(|\bString\((?:e|err|error)\)/;
const LOG_CALL = /\b(?:console|logger)\.(?:log|info|warn|error|debug)\(/;

/** 1-based lines reading exception text outside a console/logger call. */
function exceptionTextLines(source: string): number[] {
  const found: number[] = [];
  let logDepth = 0;
  let quote: string | undefined;
  source.split('\n').forEach((line, index) => {
    let outside = '';
    let rest = line;
    while (rest) {
      if (logDepth === 0) {
        const start = rest.search(LOG_CALL);
        if (start < 0) {
          outside += rest;
          break;
        }
        outside += rest.slice(0, start);
        rest = rest.slice(rest.indexOf('(', start) + 1);
        logDepth = 1;
      }
      let consumed = 0;
      for (const ch of rest) {
        if (logDepth === 0) break;
        consumed += 1;
        if (quote) {
          if (ch === quote) quote = undefined;
        } else if (ch === '\'' || ch === '"' || ch === '`') {
          quote = ch;
        } else if (ch === '(') {
          logDepth += 1;
        } else if (ch === ')') {
          logDepth -= 1;
        }
      }
      rest = rest.slice(consumed);
    }
    // Only a template literal spans lines.
    if (quote !== '`') quote = undefined;
    if (EXCEPTION_TEXT.test(outside)) found.push(index + 1);
  });
  return found;
}

const ALLOWED: Record<string, {count: number; why: string}> = {
  'controllers/skillAdminController.ts': {count: 1, why: 'YAML parse error of the caller\'s own skill content'},
  'middleware/routeFailure.ts': {count: 2, why: 'loggableError (log payload); sendPublicRequestError (typed text)'},
  'routes/agentConversationRoutes.ts': {count: 1, why: 'ProviderRequestError not-found text'},
  'routes/agentLogsRoutes.ts': {count: 1, why: 'setLogLevel validation'},
  'routes/agentRoutes.ts': {
    count: 5,
    why: 'analysis-run failure surface x2 (owner-projected for private knowledge); AnalyzeOptionsError; '
      + 'log-only errorMessage helper x2',
  },
  'routes/analysisResultRoutes.ts': {count: 2, why: 'route-local limit/boolean parsers'},
  'routes/enterpriseTenantRoutes.ts': {count: 1, why: 'typed purge window/tombstone job error'},
  'routes/ragAdminRoutes.ts': {count: 1, why: 'index failure legacy `error`: CodebaseRequestError text'},
  'routes/simpleTraceRoutes.ts': {
    count: 3,
    why: 'PublicHttpUrlRejectedError; trace list cursor/limit errors; TraceProcessorAdmissionError',
  },
  'routes/traceProcessorProxyRoutes.ts': {count: 4, why: 'TraceProcessorProxyError x3; lease not acquirable'},
};

describe('route exception echo inventory', () => {
  test('only typed, reason-token or analysis-run errors read exception text in HTTP handlers', () => {
    const srcDir = path.resolve(__dirname, '../..');
    const found: Record<string, number> = {};
    const files = [path.join(srcDir, 'index.ts')];
    for (const dir of ['routes', 'controllers', 'middleware']) {
      for (const entry of fs.readdirSync(path.join(srcDir, dir), {recursive: true, withFileTypes: true})) {
        const file = path.join(entry.parentPath, entry.name);
        if (entry.isFile() && entry.name.endsWith('.ts') && !file.includes(`${path.sep}__tests__${path.sep}`)) {
          files.push(file);
        }
      }
    }
    for (const file of files) {
      const count = exceptionTextLines(fs.readFileSync(file, 'utf8')).length;
      if (count > 0) found[path.relative(srcDir, file).split(path.sep).join('/')] = count;
    }
    expect(found).toEqual(Object.fromEntries(
      Object.entries(ALLOWED).map(([file, {count}]) => [file, count]),
    ));
  });

  test('the scan sees an echo outside a log call and skips a multi-line log call', () => {
    expect(exceptionTextLines([
      'console.error(\'failed\', {',
      '  error: error.message,',
      '});',
      'res.status(500).json({error: error.message});',
      'logger.warn(\'x\', \'(\', err.message); res.json({detail: String(err)});',
      'session.logger.info(\'y\', {error: e.message});',
    ].join('\n'))).toEqual([4, 5]);
  });
});
