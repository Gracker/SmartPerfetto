// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type SqlGuardrailRuleId =
  | 'prefer-glob-for-like'
  | 'safe-duration-boundary'
  | 'overlap-range-filter'
  | 'span-join-safety'
  | 'span-join-non-overlap'
  | 'idempotent-create'
  | 'safe-arg-extraction'
  | 'percentile-percent-scale';

export interface SqlGuardrailRule {
  id: SqlGuardrailRuleId;
  title: string;
  defaultForValidate: boolean;
}

export interface SqlGuardrailIssue {
  ruleId: SqlGuardrailRuleId;
  message: string;
  line: number;
  snippet: string;
}

export interface AnalyzeSqlGuardrailOptions {
  includeRules?: readonly SqlGuardrailRuleId[];
}

export interface SummarizeSqlGuardrailOptions {
  includeRules?: readonly SqlGuardrailRuleId[];
  maxLocationsPerRule?: number;
}

export const SQL_GUARDRAIL_RULES: readonly SqlGuardrailRule[] = [
  {
    id: 'prefer-glob-for-like',
    title: 'Prefer GLOB or exact equality over LIKE for Perfetto text filters',
    defaultForValidate: false,
  },
  {
    id: 'safe-duration-boundary',
    title: 'Handle open-ended dur = -1 intervals before aggregating durations',
    defaultForValidate: false,
  },
  {
    id: 'overlap-range-filter',
    title: 'Use overlap predicates for interval queries',
    defaultForValidate: false,
  },
  {
    id: 'span-join-safety',
    title: 'Use partitioned and idempotent SPAN_JOIN setup',
    defaultForValidate: true,
  },
  {
    id: 'span-join-non-overlap',
    title: 'Require reviewed non-overlapping inputs for SPAN_JOIN',
    defaultForValidate: true,
  },
  {
    id: 'idempotent-create',
    title: 'Prefer idempotent CREATE statements in reusable SQL',
    defaultForValidate: true,
  },
  {
    id: 'safe-arg-extraction',
    title: 'Prefer EXTRACT_ARG over direct args table parsing',
    defaultForValidate: true,
  },
  {
    id: 'percentile-percent-scale',
    title: 'Use Perfetto PERCENTILE arguments on the 0 to 100 scale',
    defaultForValidate: true,
  },
] as const;

export const DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES: readonly SqlGuardrailRuleId[] =
  SQL_GUARDRAIL_RULES.filter(rule => rule.defaultForValidate).map(rule => rule.id);

const IGNORE_TOKEN = 'smartperfetto-guardrail-ignore';
const SPAN_JOIN_PROOF_TOKEN = 'perfetto-span-join-non-overlap-proof';
const RULE_IDS = new Set<SqlGuardrailRuleId>(SQL_GUARDRAIL_RULES.map(rule => rule.id));

function findRatioScalePercentileArguments(maskedSql: string): number[] {
  const findings: number[] = [];
  const callPattern = /\bPERCENTILE\s*\(/gi;

  for (const match of maskedSql.matchAll(callPattern)) {
    let depth = 1;
    let commaIndex = -1;
    let cursor = (match.index ?? 0) + match[0].length;

    for (; cursor < maskedSql.length && depth > 0; cursor += 1) {
      const char = maskedSql[cursor];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0 && commaIndex >= 0) {
          const argumentStart = commaIndex + 1;
          const argument = maskedSql.slice(argumentStart, cursor).trim();
          if (/^(?:0?\.\d+)$/.test(argument)) {
            const value = Number(argument);
            if (value > 0 && value < 1) {
              findings.push(argumentStart + maskedSql.slice(argumentStart, cursor).search(/\S/));
            }
          }
        }
      } else if (char === ',' && depth === 1 && commaIndex < 0) {
        commaIndex = cursor;
      }
    }
  }

  return findings;
}

/**
 * Strip comments and SQL string literals while preserving newlines and offsets.
 * Double-quoted identifiers are intentionally retained because Perfetto SQL
 * treats them as identifiers and guardrails should still see them.
 */
function maskCommentsAndSingleQuotedStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === '-' && c2 === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < sql.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (c === "'") {
      out += ' ';
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += '  ';
            i += 2;
            continue;
          }
          out += ' ';
          i++;
          break;
        }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

function findLineStart(sql: string, index: number): number {
  const prev = sql.lastIndexOf('\n', Math.max(0, index - 1));
  return prev === -1 ? 0 : prev + 1;
}

function lineNumberAt(sql: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < sql.length; i++) {
    if (sql[i] === '\n') line++;
  }
  return line;
}

function lineSnippetAt(sql: string, index: number): string {
  const start = findLineStart(sql, index);
  const end = sql.indexOf('\n', start);
  const raw = sql.slice(start, end === -1 ? sql.length : end).trim();
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

function hasAdjacentSpanJoinNonOverlapProof(sql: string, createIndex: number): boolean {
  const createLineStart = findLineStart(sql, createIndex);
  if (createLineStart === 0) return false;

  const previousLineEnd = createLineStart - 1;
  const previousLineStart = findLineStart(sql, previousLineEnd);
  const previousLine = sql.slice(previousLineStart, previousLineEnd).trim();
  const proof = new RegExp(
    `^--\\s*${escapeRegex(SPAN_JOIN_PROOF_TOKEN)}\\s*:\\s*(\\S(?:.*\\S)?)\\s*$`,
    'i',
  ).exec(previousLine);
  return proof !== null;
}

function makeIssue(
  sql: string,
  index: number,
  ruleId: SqlGuardrailRuleId,
  message: string,
): SqlGuardrailIssue {
  return {
    ruleId,
    message,
    line: lineNumberAt(sql, index),
    snippet: lineSnippetAt(sql, index),
  };
}

function parseIgnoreDirective(commentText: string): Set<SqlGuardrailRuleId | 'all'> | null {
  const tokenIndex = commentText.indexOf(IGNORE_TOKEN);
  if (tokenIndex === -1) return null;

  const afterToken = commentText.slice(tokenIndex + IGNORE_TOKEN.length).trim();
  const ids = new Set<SqlGuardrailRuleId | 'all'>();
  if (!afterToken) {
    ids.add('all');
    return ids;
  }

  for (const part of afterToken.split(/[,\s]+/)) {
    const normalized = part.trim();
    if (!normalized) continue;
    if (/^all$/i.test(normalized)) {
      ids.add('all');
      continue;
    }
    const id = normalized as SqlGuardrailRuleId;
    if (RULE_IDS.has(id)) {
      ids.add(id);
    }
  }
  return ids.size > 0 ? ids : null;
}

function mergeIgnoreDirective(
  ignores: Map<number, Set<SqlGuardrailRuleId | 'all'>>,
  line: number,
  ids: Set<SqlGuardrailRuleId | 'all'> | null,
): void {
  if (!ids) return;
  const existing = ignores.get(line);
  if (existing) {
    for (const id of ids) existing.add(id);
    return;
  }
  ignores.set(line, new Set(ids));
}

function parseIgnoreLines(sql: string): Map<number, Set<SqlGuardrailRuleId | 'all'>> {
  const ignores = new Map<number, Set<SqlGuardrailRuleId | 'all'>>();
  let i = 0;
  let line = 1;

  while (i < sql.length) {
    const c = sql[i];
    const c2 = sql[i + 1];

    if (c === '\n') {
      line++;
      i++;
      continue;
    }

    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === '\n') line++;
        i++;
      }
      continue;
    }

    if (c === '-' && c2 === '-') {
      const start = i + 2;
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      mergeIgnoreDirective(ignores, line, parseIgnoreDirective(sql.slice(start, i)));
      continue;
    }

    if (c === '/' && c2 === '*') {
      const startLine = line;
      const start = i + 2;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') line++;
        i++;
      }
      const comment = sql.slice(start, i);
      mergeIgnoreDirective(ignores, startLine, parseIgnoreDirective(comment));
      if (i < sql.length) i += 2;
      continue;
    }

    i++;
  }

  return ignores;
}

function isIgnored(
  issue: SqlGuardrailIssue,
  ignores: Map<number, Set<SqlGuardrailRuleId | 'all'>>,
): boolean {
  for (const line of [issue.line, issue.line - 1]) {
    const ids = ignores.get(line);
    if (!ids) continue;
    if (ids.has('all') || ids.has(issue.ruleId)) return true;
  }
  return false;
}

function matchesRule(ruleId: SqlGuardrailRuleId, includeRules?: readonly SqlGuardrailRuleId[]): boolean {
  return !includeRules || includeRules.includes(ruleId);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPrecedingDropIfExists(maskedSql: string, createIndex: number, objectKind: string, objectName: string): boolean {
  const beforeCreate = maskedSql.slice(0, createIndex);
  const kind = escapeRegex(objectKind);
  const name = escapeRegex(objectName);
  return new RegExp(`\\bDROP\\s+(?:PERFETTO\\s+)?${kind}\\s+IF\\s+EXISTS\\s+${name}\\b`, 'i').test(beforeCreate);
}

function addRegexIssues(
  issues: SqlGuardrailIssue[],
  sql: string,
  maskedSql: string,
  regex: RegExp,
  ruleId: SqlGuardrailRuleId,
  message: string,
): void {
  for (const match of maskedSql.matchAll(regex)) {
    issues.push(makeIssue(sql, match.index ?? 0, ruleId, message));
  }
}

function findFunctionCallEnd(sql: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < sql.length; i++) {
    if (sql[i] === '(') {
      depth++;
    } else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function hasRawDurationReference(sql: string): boolean {
  return /\b(?:\w+\.)?dur\b/i.test(sql);
}

function hasVisibleOpenDurationHandling(sql: string): boolean {
  return /\b(?:\w+\.)?dur\s*=\s*-1\b|\b-1\s*=\s*(?:\w+\.)?dur\b|\beffective_dur\b/i.test(sql);
}

function addRawDurationAggregateIssues(
  issues: SqlGuardrailIssue[],
  sql: string,
  maskedSql: string,
): void {
  const aggregateRegex = /\b(?:SUM|AVG|MIN|MAX)\s*\(/gi;
  for (const match of maskedSql.matchAll(aggregateRegex)) {
    const openParenIndex = maskedSql.indexOf('(', match.index ?? 0);
    if (openParenIndex === -1) continue;
    const closeParenIndex = findFunctionCallEnd(maskedSql, openParenIndex);
    if (closeParenIndex === -1) continue;

    const body = maskedSql.slice(openParenIndex + 1, closeParenIndex);
    if (!hasRawDurationReference(body) || hasVisibleOpenDurationHandling(body)) {
      continue;
    }

    issues.push(makeIssue(
      sql,
      match.index ?? 0,
      'safe-duration-boundary',
      'Raw dur is aggregated or used as ts + dur without visible dur = -1 handling; use an effective duration when the source may contain open intervals.',
    ));
  }
}

export function analyzeSqlGuardrails(
  sql: string,
  options: AnalyzeSqlGuardrailOptions = {},
): SqlGuardrailIssue[] {
  const issues: SqlGuardrailIssue[] = [];
  const maskedSql = maskCommentsAndSingleQuotedStrings(sql);
  const includeRules = options.includeRules;

  if (matchesRule('prefer-glob-for-like', includeRules)) {
    addRegexIssues(
      issues,
      sql,
      maskedSql,
      /\b(?:NOT\s+)?LIKE\b/gi,
      'prefer-glob-for-like',
      'Prefer GLOB for wildcard text filters or = for exact text matches; review LIKE usage for Perfetto-specific matching semantics.',
    );
  }

  if (matchesRule('safe-duration-boundary', includeRules)) {
    addRawDurationAggregateIssues(issues, sql, maskedSql);
    addRegexIssues(
      issues,
      sql,
      maskedSql,
      /\b(?:\w+\.)?ts\s*\+\s*(?:\w+\.)?dur\b/gi,
      'safe-duration-boundary',
      'Raw dur is aggregated or used as ts + dur without visible dur = -1 handling; use an effective duration when the source may contain open intervals.',
    );
  }

  if (matchesRule('overlap-range-filter', includeRules)) {
    addRegexIssues(
      issues,
      sql,
      maskedSql,
      /\b(?:\w+\.)?ts\s*(?:>=|>)\s*(?:\$\{start_ts[^}]*\}|(?:\w+\.)?start_ts\b)/gi,
      'overlap-range-filter',
      'Interval queries should use overlap predicates such as ts < end_ts AND ts + effective_dur > start_ts instead of start-only filtering.',
    );
    addRegexIssues(
      issues,
      sql,
      maskedSql,
      /\b(?:\w+\.)?ts\s+BETWEEN\s+(?:\$\{start_ts[^}]*\}|(?:\w+\.)?start_ts\b)\s+AND\s+(?:\$\{end_ts[^}]*\}|(?:\w+\.)?end_ts\b)/gi,
      'overlap-range-filter',
      'Interval queries should use overlap predicates such as ts < end_ts AND ts + effective_dur > start_ts instead of BETWEEN/start-only filtering.',
    );
  }

  const hasSpanJoin = /\bSPAN(?:_LEFT)?_JOIN\b/i.test(maskedSql);
  if (
    hasSpanJoin
    && (
      matchesRule('span-join-safety', includeRules)
      || matchesRule('span-join-non-overlap', includeRules)
    )
  ) {
    const createSpanJoinRegex = /\bCREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w.]*)\s+USING\s+SPAN(?:_LEFT)?_JOIN\b[\s\S]*?(?:;|$)/gi;
    const createMatches = [...maskedSql.matchAll(createSpanJoinRegex)];
    if (createMatches.length > 0) {
      for (const match of createMatches) {
        const statement = match[0];
        const createIndex = match.index ?? 0;
        const tableName = match[1];
        const joinIndexInStatement = statement.search(/\bSPAN(?:_LEFT)?_JOIN\b/i);
        const issueIndex = joinIndexInStatement === -1 ? createIndex : createIndex + joinIndexInStatement;

        if (
          matchesRule('span-join-safety', includeRules)
          && !/\bPARTITIONED\b/i.test(statement)
        ) {
          issues.push(makeIssue(
            sql,
            issueIndex,
            'span-join-safety',
            'SPAN_JOIN/SPAN_LEFT_JOIN should normally be PARTITIONED by a stable id such as utid, upid, track_id, or cpu to avoid cross-entity interval joins.',
          ));
        }

        const partitionKeys = [
          ...statement.matchAll(/\bPARTITIONED\s+([A-Za-z_][A-Za-z0-9_]*)/gi),
        ].map(partition => partition[1].toLowerCase());
        if (
          matchesRule('span-join-safety', includeRules)
          && partitionKeys.length > 1
          && new Set(partitionKeys).size > 1
        ) {
          issues.push(makeIssue(
            sql,
            issueIndex,
            'span-join-safety',
            'When both SPAN_JOIN/SPAN_LEFT_JOIN inputs are PARTITIONED, they must use the same partition key; use a single shared identity column or leave a truly global interval input unpartitioned.',
          ));
        }

        if (
          matchesRule('span-join-safety', includeRules)
          && !hasPrecedingDropIfExists(maskedSql, createIndex, 'TABLE', tableName)
        ) {
          issues.push(makeIssue(
            sql,
            createIndex,
            'span-join-safety',
            'CREATE VIRTUAL TABLE ... USING SPAN_JOIN/SPAN_LEFT_JOIN should be preceded by DROP TABLE IF EXISTS when the SQL may run repeatedly in one trace session.',
          ));
        }

        if (
          matchesRule('span-join-non-overlap', includeRules)
          && !hasAdjacentSpanJoinNonOverlapProof(sql, createIndex)
        ) {
          issues.push(makeIssue(
            sql,
            issueIndex,
            'span-join-non-overlap',
            'PARTITIONED scopes entity matching but does not make overlapping intervals within an input partition safe. Prove both inputs are non-overlapping with a fixture/assertion or witness query, then add an adjacent "perfetto-span-join-non-overlap-proof: <reference>" comment; otherwise merge intervals or use a suitable stdlib interval operator.',
          ));
        }
      }
    } else {
      const firstSpanJoin = maskedSql.search(/\bSPAN(?:_LEFT)?_JOIN\b/i);
      if (matchesRule('span-join-safety', includeRules)) {
        issues.push(makeIssue(
          sql,
          firstSpanJoin,
          'span-join-safety',
          'Review SPAN_JOIN/SPAN_LEFT_JOIN usage for PARTITIONED keys and idempotent setup.',
        ));
      }
      if (matchesRule('span-join-non-overlap', includeRules)) {
        issues.push(makeIssue(
          sql,
          firstSpanJoin,
          'span-join-non-overlap',
          'Review SPAN_JOIN/SPAN_LEFT_JOIN inputs for overlapping intervals within each effective partition; PARTITIONED alone does not prove the required invariant.',
        ));
      }
    }
  }

  if (matchesRule('idempotent-create', includeRules)) {
    const createRegex = /\bCREATE\s+(?!OR\s+REPLACE\b)(?!TEMP(?:ORARY)?\b)(?!VIRTUAL\b)(?:PERFETTO\s+)?(FUNCTION|MACRO|TABLE|VIEW)\s+(?!IF\s+NOT\s+EXISTS\b)([A-Za-z_][\w.]*)/gi;
    for (const match of maskedSql.matchAll(createRegex)) {
      const objectKind = match[1].toUpperCase();
      const objectName = match[2];
      if (hasPrecedingDropIfExists(maskedSql, match.index ?? 0, objectKind, objectName)) {
        continue;
      }
      issues.push(makeIssue(
        sql,
        match.index ?? 0,
        'idempotent-create',
        'Reusable SQL should prefer CREATE OR REPLACE, IF NOT EXISTS, or a preceding DROP ... IF EXISTS to stay idempotent across repeated executions.',
      ));
    }
  }

  if (matchesRule('safe-arg-extraction', includeRules)) {
    const argsTableRegex = /\b(?:FROM|JOIN)\s+args\b/gi;
    for (const match of maskedSql.matchAll(argsTableRegex)) {
      issues.push(makeIssue(
        sql,
        match.index ?? 0,
        'safe-arg-extraction',
        'Prefer EXTRACT_ARG/STR_SPLIT helpers over direct args table parsing so key/value typing and repeated keys stay consistent.',
      ));
    }
  }

  if (matchesRule('percentile-percent-scale', includeRules)) {
    for (const argumentIndex of findRatioScalePercentileArguments(maskedSql)) {
      issues.push(makeIssue(
        sql,
        argumentIndex,
        'percentile-percent-scale',
        'Perfetto PERCENTILE uses a 0 to 100 percentile argument; ratio-scale literals between 0 and 1 produce sub-first-percentile results (use 50, 90, 95, or 99 as intended).',
      ));
    }
  }

  const ignores = parseIgnoreLines(sql);
  return issues.filter(issue => !isIgnored(issue, ignores));
}

export function summarizeSqlGuardrailIssues(
  issues: readonly SqlGuardrailIssue[],
  options: SummarizeSqlGuardrailOptions = {},
): string[] {
  const includeRules = options.includeRules;
  const maxLocations = options.maxLocationsPerRule ?? 3;
  const grouped = new Map<string, SqlGuardrailIssue[]>();

  for (const issue of issues) {
    if (!matchesRule(issue.ruleId, includeRules)) continue;
    const key = `${issue.ruleId}\n${issue.message}`;
    const group = grouped.get(key);
    if (group) group.push(issue);
    else grouped.set(key, [issue]);
  }

  return [...grouped.values()].map(group => {
    const first = group[0];
    const locations = group
      .slice(0, maxLocations)
      .map(issue => `line ${issue.line}: ${issue.snippet || '<empty line>'}`)
      .join('; ');
    const more = group.length > maxLocations ? `; +${group.length - maxLocations} more` : '';
    return `sql-guardrail ${first.ruleId}: ${first.message} (${group.length} occurrence${group.length === 1 ? '' : 's'}; ${locations}${more})`;
  });
}
