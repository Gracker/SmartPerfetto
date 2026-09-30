// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  QueryReviewConfidence,
  QueryReviewFilterV1,
  QueryReviewOutputShapeV1,
  QueryReviewReadV1,
} from '../../types/queryReviewContract';
import { localize, parseOutputLanguage, type OutputLanguage } from '../../agentv3/outputLanguage';

export type SqlReviewOutputColumn = string | { name: string; type?: string };

export interface SqlReviewIntrospectionInput {
  sql?: string;
  outputColumns?: SqlReviewOutputColumn[];
  outputLanguage?: OutputLanguage;
}

export interface SqlReviewIntrospection {
  reads: QueryReviewReadV1[];
  filters: QueryReviewFilterV1[];
  outputShape: QueryReviewOutputShapeV1[];
  limitations: string[];
}

const TABLE_KEYWORDS = new Set(['from', 'join', 'update', 'into']);
const SQL_STOP_KEYWORDS = new Set([
  'as',
  'on',
  'using',
  'where',
  'group',
  'order',
  'limit',
  'offset',
  'having',
  'union',
  'except',
  'intersect',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'full',
]);

function maskSqlLiteralsCommentsAndQuotedIdentifiers(sql: string): string {
  const chars = sql.split('');
  const maskRange = (start: number, end: number) => {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };

  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (char === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      maskRange(start, i);
      continue;
    }

    if (char === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(sql.length, i + 2);
      maskRange(start, i);
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      maskRange(start, i);
      continue;
    }

    if (char === '[') {
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== ']') i += 1;
      i = Math.min(sql.length, i + 1);
      maskRange(start, i);
      continue;
    }

    i += 1;
  }

  return chars.join('');
}

function readIdentifier(sql: string, startIndex: number): { value: string; end: number } | undefined {
  let i = startIndex;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  if (sql[i] === '(') return undefined;

  const start = i;
  while (i < sql.length && /[A-Za-z0-9_.$]/.test(sql[i])) i += 1;
  if (i === start) return undefined;

  const value = sql.slice(start, i).replace(/^\$?/, '').replace(/\.$/, '');
  if (!/^[A-Za-z_][\w.]*$/.test(value)) return undefined;
  const lower = value.toLowerCase();
  if (SQL_STOP_KEYWORDS.has(lower)) return undefined;
  return { value, end: i };
}

function hasComplexSqlShape(maskedSql: string): boolean {
  return /\bWITH\b/i.test(maskedSql) || /\bSELECT\b[\s\S]*\(\s*SELECT\b/i.test(maskedSql);
}

function extractReadTables(sql: string): QueryReviewReadV1[] {
  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  const confidence: QueryReviewConfidence = hasComplexSqlShape(masked) ? 'partial' : 'observed';
  const reads: QueryReviewReadV1[] = [];
  const seen = new Set<string>();
  const matcher = /\b(from|join|update|into)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(masked)) !== null) {
    const keyword = match[1].toLowerCase();
    if (!TABLE_KEYWORDS.has(keyword)) continue;
    const identifier = readIdentifier(masked, matcher.lastIndex);
    if (!identifier) continue;
    if (seen.has(identifier.value)) continue;
    seen.add(identifier.value);
    reads.push({ table: identifier.value, confidence });
    if (reads.length >= 16) break;
  }

  return reads;
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/;$/, '').trim();
}

function findClauseEnd(maskedSql: string, start: number): number {
  const endMatcher = /\b(group\s+by|order\s+by|limit|offset|having|union|except|intersect|window)\b/gi;
  endMatcher.lastIndex = start;
  const match = endMatcher.exec(maskedSql);
  return match?.index ?? maskedSql.length;
}

function extractFilters(sql: string): QueryReviewFilterV1[] {
  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  const confidence: QueryReviewConfidence = hasComplexSqlShape(masked) ? 'partial' : 'observed';
  const filters: QueryReviewFilterV1[] = [];
  const matcher = /\bwhere\b/gi;

  while (matcher.exec(masked) !== null) {
    const start = matcher.lastIndex;
    const end = findClauseEnd(masked, start);
    const clause = normalizeExpression(sql.slice(start, end));
    if (!clause) continue;
    const parts = clause.length <= 360
      ? clause.split(/\s+\bAND\b\s+/i).map(normalizeExpression)
      : [clause.slice(0, 360).trim()];
    for (const part of parts) {
      if (!part) continue;
      filters.push({ expression: part, confidence });
      if (filters.length >= 12) break;
    }
    if (filters.length >= 12) break;
  }

  return filters;
}

function outputColumnName(column: SqlReviewOutputColumn): string | undefined {
  if (typeof column === 'string') return column.trim() || undefined;
  return typeof column.name === 'string' && column.name.trim() ? column.name.trim() : undefined;
}

function outputColumnType(column: SqlReviewOutputColumn): string | undefined {
  return typeof column === 'object' && typeof column.type === 'string' && column.type.trim()
    ? column.type.trim()
    : undefined;
}

function buildOutputShape(outputColumns: SqlReviewOutputColumn[] | undefined): QueryReviewOutputShapeV1[] {
  if (!Array.isArray(outputColumns)) return [];
  const seen = new Set<string>();
  const output: QueryReviewOutputShapeV1[] = [];
  for (const column of outputColumns) {
    const name = outputColumnName(column);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push({
      name,
      type: outputColumnType(column),
      required: true,
    });
    if (output.length >= 32) break;
  }
  return output;
}

export function introspectSqlForQueryReview(input: SqlReviewIntrospectionInput): SqlReviewIntrospection {
  const outputLanguage = input.outputLanguage ?? parseOutputLanguage(process.env.SMARTPERFETTO_OUTPUT_LANGUAGE);
  const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
  const outputShape = buildOutputShape(input.outputColumns);
  if (!sql) {
    return {
      reads: [],
      filters: [],
      outputShape,
      limitations: [localize(
        outputLanguage,
        'SQL 文本不可用；review 只覆盖已观测到的输出形状。',
        'SQL text was not available; review only covers the observed output shape.',
      )],
    };
  }

  const masked = maskSqlLiteralsCommentsAndQuotedIdentifiers(sql);
  const reads = extractReadTables(sql);
  const filters = extractFilters(sql);
  const limitations: string[] = [];
  if (reads.length === 0) limitations.push(localize(
    outputLanguage,
    '无法从可执行 SQL 文本推断来源表。',
    'No source table could be inferred from the executable SQL text.',
  ));
  if (hasComplexSqlShape(masked)) limitations.push(localize(
    outputLanguage,
    'SQL 包含 CTE 或嵌套 SELECT；表和过滤条件 review 只做部分覆盖。',
    'SQL contains CTEs or nested SELECTs; table and filter review is partial.',
  ));
  if (/\bJOIN\b/i.test(masked)) limitations.push(localize(
    outputLanguage,
    'SQL 包含 JOIN；表 review 不会把输出列归因到单个来源表。',
    'SQL contains JOINs; table review does not attribute output columns to individual source tables.',
  ));
  if (/\bOVER\s*\(/i.test(masked)) limitations.push(localize(
    outputLanguage,
    'SQL 包含窗口函数；review 记录已观测输出形状，但不建模 window frame。',
    'SQL contains window functions; review records the observed output shape but does not model window frames.',
  ));
  if (/\bCREATE\s+VIRTUAL\s+TABLE\b/i.test(masked)) limitations.push(localize(
    outputLanguage,
    'SQL 创建 virtual table；review 记录语句形状，但不建模 virtual table 生命周期。',
    'SQL creates a virtual table; review records the statement shape but does not model virtual table lifecycle.',
  ));
  if (/\bSELECT\s+\*/i.test(masked)) limitations.push(localize(
    outputLanguage,
    '输出形状使用 SELECT * 或等价展开；真实来源列可能比展示列更宽。',
    'Output shape uses SELECT * or equivalent expansion; exact source columns may be broader than displayed columns.',
  ));

  return {
    reads,
    filters,
    outputShape,
    limitations,
  };
}
