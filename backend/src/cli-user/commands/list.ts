// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * `smartperfetto list` — enumerate stored sessions.
 *
 * Source of truth: `~/.smartperfetto/index.json`. We deliberately do NOT
 * fall back to scanning the filesystem when the index is missing/empty —
 * the index is rebuilt on every `analyze` / `resume` / `rm`, so an empty
 * index genuinely means "no sessions", not "index is stale".
 */

import { bootstrap } from '../bootstrap';
import { readIndex } from '../io/indexJson';
import type { CliSessionIndexEntry } from '../types';

export interface ListCommandArgs {
  json: boolean;
  limit?: number;
  since?: string;
  envFile?: string;
  sessionDir?: string;
  noColor: boolean;
}

export async function runListCommand(args: ListCommandArgs): Promise<number> {
  const { paths } = bootstrap({ envFile: args.envFile, sessionDir: args.sessionDir, requireLlm: false });
  const idx = readIndex(paths);
  let entries = Object.values(idx.sessions);

  if (args.since) {
    const sinceMs = Date.parse(args.since);
    if (Number.isNaN(sinceMs)) {
      console.error(`Error: --since expects a date parseable by Date.parse, got: ${args.since}`);
      return 1;
    }
    entries = entries.filter((e) => e.lastTurnAt >= sinceMs);
  }

  // Most-recent first is the natural UX for "what did I work on last".
  entries.sort((a, b) => b.lastTurnAt - a.lastTurnAt);

  if (args.limit && args.limit > 0) entries = entries.slice(0, args.limit);

  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log('(no sessions — run `smp -f <trace> -p "question"` to create one)');
    return 0;
  }

  printTable(entries, !args.noColor && Boolean(process.stdout.isTTY));
  return 0;
}

function printTable(entries: CliSessionIndexEntry[], useColor: boolean): void {
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

  const header = ['SESSION', 'LAST TURN', 'STATUS', 'TURNS', 'TRACE', 'QUERY'];
  const rows = entries.map((e) => [
    e.sessionId,
    formatRelativeTime(e.lastTurnAt),
    e.status,
    String(e.turnCount),
    e.traceFilename,
    truncate(e.firstQuery, 50),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  console.log(bold(pad(header)));
  console.log(dim(pad(widths.map((w) => '─'.repeat(w)))));
  for (const row of rows) console.log(pad(row));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatRelativeTime(ts: number): string {
  const diffSec = (Date.now() - ts) / 1000;
  if (diffSec < 60) return `${Math.round(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  const days = Math.round(diffSec / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
