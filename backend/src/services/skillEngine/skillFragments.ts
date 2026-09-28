// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// The one reader for SQL fragment files (`skills/fragments/*.sql`). The Skill
// loader reads every root's fragments through it, and code that composes the
// same fragments (the critical-path engine) reads the built-in ones through it,
// so a fragment has exactly one source and one load path.

import fs from 'fs';
import path from 'path';

/** The built-in skills directory shipped with the backend. */
export function builtInSkillsDir(): string {
  return path.resolve(__dirname, '../../../skills');
}

/** Registry key of a fragment file, e.g. `fragments/thread_role.sql`. */
export function skillFragmentKey(file: string): string {
  return `fragments/${file}`;
}

/** A fragment file's CTE text, trimmed as Skill step injection expects it. */
export function readSkillFragmentFile(fragmentsDir: string, file: string): string {
  return fs.readFileSync(path.join(fragmentsDir, file), 'utf-8').trim();
}

const builtInCache = new Map<string, string>();

/**
 * A built-in fragment by file name. Self-Evolution copies base fragments
 * unchanged, so the built-in file is also what every effective registry holds.
 */
export function builtInSkillFragment(file: string): string {
  const cached = builtInCache.get(file);
  if (cached !== undefined) return cached;
  const content = readSkillFragmentFile(path.join(builtInSkillsDir(), 'fragments'), file);
  builtInCache.set(file, content);
  return content;
}

/** One `${path}` or `${path|default}` placeholder found in SQL. */
export interface SqlPlaceholder {
  /** The whole token, e.g. `${max_rows|50}`. */
  match: string;
  path: string;
  /** The text after `|`, when the placeholder declares one. */
  defaultValue?: string;
  /** Whether the token sits inside a single-quoted SQL string literal. */
  insideQuotes: boolean;
}

/**
 * True when `offset` in `sql` lies inside a single-quoted literal (`''` escapes
 * a quote). Outside a literal, `--` line comments and `/* *\/` block comments
 * are skipped, so an apostrophe in comment prose ("process's") does not flip
 * the state for every later placeholder. A placeholder inside a comment reads
 * as unquoted.
 */
function insideSingleQuotes(sql: string, offset: number): boolean {
  let inSingle = false;
  for (let i = 0; i < offset; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch !== "'") continue;
      if (sql[i + 1] === "'") i++;
      else inSingle = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      const close = ch === '-' ? '\n' : '*/';
      const end = sql.indexOf(close, i + 2);
      if (end < 0 || end + close.length > offset) return false;
      i = end + close.length - 1;
    }
  }
  return inSingle;
}

/**
 * The one placeholder scanner for Skill SQL and fragments: every `${...}`
 * token is handed to `resolve`, which returns its SQL text or throws. Skill
 * steps and the critical-path engine bind values differently; they find and
 * parse placeholders the same way.
 */
export function substituteSqlPlaceholders(sql: string, resolve: (placeholder: SqlPlaceholder) => string): string {
  return sql.replace(/\$\{([^}]+)\}/g, (match: string, body: string, offset: number, full: string) => {
    const raw = String(body ?? '').trim();
    const pipe = raw.indexOf('|');
    return resolve({
      match,
      path: pipe >= 0 ? raw.slice(0, pipe).trim() : raw,
      ...(pipe >= 0 ? {defaultValue: raw.slice(pipe + 1).trim()} : {}),
      insideQuotes: insideSingleQuotes(full, offset),
    });
  });
}

/**
 * Put fragment CTE bodies (bare `name AS (...)`, no WITH) in front of `sql`:
 * after its own WITH (leading comments kept) or as a new WITH clause.
 * Separators go on their own line: a fragment may end in a `--` comment, which
 * would otherwise swallow the comma.
 */
export function injectFragmentCtes(sql: string, fragmentBodies: string[]): string {
  if (fragmentBodies.length === 0) return sql;
  const fragmentBlock = fragmentBodies.join('\n,\n');
  const trimmed = sql.trimStart();
  // Leading comment lines (e.g. a root_cause_summary step's header) precede WITH.
  const noLeadingComments = trimmed.replace(/^(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*/, '');
  const withMatch = noLeadingComments.match(/^WITH(?:\s+RECURSIVE)?\s+/i);
  if (withMatch) {
    const commentPrefix = trimmed.slice(0, trimmed.length - noLeadingComments.length);
    const afterWith = noLeadingComments.slice(withMatch[0].length);
    return `${commentPrefix}${withMatch[0].trim()}\n${fragmentBlock}\n,\n${afterWith}`;
  }
  return `WITH\n${fragmentBlock}\n${trimmed}`;
}

/**
 * Compose built-in fragments behind leading CTEs and a final select. Every
 * placeholder is bound to one of `numbers` (or a numeric `|default`); anything
 * else, including a process-scope binding, is an error rather than SQL sent to
 * the processor with a placeholder still in it.
 */
export function composeFragmentSql(input: {
  leadingCtes: string[];
  fragments: string[];
  select: string;
  numbers?: Record<string, number>;
  /** Fragment text by file name; the built-in fragments by default. */
  load?: (file: string) => string;
}): string {
  const load = input.load ?? builtInSkillFragment;
  const bound = input.fragments.map((file) =>
    substituteSqlPlaceholders(load(file), (placeholder) => {
      const value = input.numbers?.[placeholder.path];
      if (value !== undefined && Number.isFinite(value)) return String(Math.trunc(value));
      if (value === undefined && placeholder.defaultValue !== undefined && /^-?\d+$/.test(placeholder.defaultValue)) {
        return placeholder.defaultValue;
      }
      throw new Error(`fragment ${file} needs a numeric ${placeholder.match}`);
    })
  );
  return injectFragmentCtes(input.select, [...input.leadingCtes, ...bound]);
}
