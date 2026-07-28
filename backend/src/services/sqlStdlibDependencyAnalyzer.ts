// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getPerfettoStdlibSymbolIndex } from './perfettoStdlibScanner';
import { moduleCoveredByPerfettoSqlLineage } from './perfettoSqlDocs';

export type SqlStdlibUsageKind = 'table' | 'function' | 'macro';

export interface SqlStdlibDependency {
  symbol: string;
  module: string;
  usage: SqlStdlibUsageKind;
}

export interface AnalyzeSqlStdlibDependenciesOptions {
  /**
   * Symbols defined outside this SQL fragment but still local to the skill or
   * execution context. Skill validation uses this for multi-step SQL where an
   * earlier step creates a helper view/table consumed by a later step.
   */
  extraLocalSymbols?: Iterable<string>;
}

interface AnalyzeSingleSqlFragmentOptions extends AnalyzeSqlStdlibDependenciesOptions {
  extraIncludedModules?: Iterable<string>;
}

export interface SqlStdlibDependencyAnalysis {
  includes: string[];
  localSymbols: string[];
  dependencies: SqlStdlibDependency[];
  requiredModules: string[];
  source: 'asset' | 'source' | 'empty';
}

const FUNCTION_CALL_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const MACRO_INVOCATION_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\s*!\s*\(/g;
const ALREADY_INCLUDED_REGEX = /\bINCLUDE\s+PERFETTO\s+MODULE\s+([\w.]+)/gi;
const TOKEN_REGEX = /"(?:""|[^"\n])+"|`[^`\n]+`|\[[^\]\n]+\]|[A-Za-z_][A-Za-z0-9_]*|[(),;]/g;
const IDENTIFIER_CAPTURE_PATTERN =
  '(?:"(?:""|[^"\\n])+"|`[^`\\n]+`|\\[[^\\]\\n]+\\]|[A-Za-z_][\\w.]*)';

const CREATE_LOCAL_REGEX = new RegExp(
  '\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?(?:PERFETTO\\s+)?' +
    '(?:TABLE|VIEW|FUNCTION|MACRO)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' +
    `(${IDENTIFIER_CAPTURE_PATTERN})`,
  'gi',
);
const WITH_FIRST_LOCAL_REGEX = new RegExp(
  `\\bWITH\\s+(?:RECURSIVE\\s+)?(${IDENTIFIER_CAPTURE_PATTERN})(?:\\s*\\([^)]*\\))?\\s+AS\\b`,
  'gi',
);
const WITH_CHAIN_LOCAL_REGEX = new RegExp(
  `,\\s*(${IDENTIFIER_CAPTURE_PATTERN})(?:\\s*\\([^)]*\\))?\\s+AS\\s+(?:(?:NOT\\s+)?MATERIALIZED\\s+)?\\(`,
  'gi',
);

const FROM_CLAUSE_TERMINATORS = new Set([
  'WHERE', 'ON', 'USING', 'GROUP', 'ORDER', 'LIMIT', 'HAVING',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'FULL', 'NATURAL',
  'UNION', 'EXCEPT', 'INTERSECT',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'BETWEEN', 'LIKE', 'GLOB',
  'OFFSET', 'FETCH', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'ASC', 'DESC', 'NULL', 'TRUE', 'FALSE',
  'SELECT', 'FROM',
]);

function maskCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < len && sql[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < len) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      out += ' ';
      i++;
      while (i < len) {
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

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i < len) i += 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < len) {
        if (sql[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '[') {
      i++;
      while (i < len) {
        if (sql[i] === ']') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ';') {
      const statement = sql.slice(start, i + 1).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
    i++;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function maskQuotedIdentifierRegions(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const c = sql[i];
    if (c === '"') {
      out += ' ';
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
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
    if (c === '`') {
      out += ' ';
      i++;
      while (i < len) {
        out += sql[i] === '\n' ? '\n' : ' ';
        if (sql[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '[') {
      out += ' ';
      i++;
      while (i < len) {
        out += sql[i] === '\n' ? '\n' : ' ';
        if (sql[i] === ']') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function unquoteIdentifier(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return token.slice(1, -1).replace(/""/g, '"');
  }
  if (token.startsWith('`') && token.endsWith('`')) {
    return token.slice(1, -1);
  }
  if (token.startsWith('[') && token.endsWith(']')) {
    return token.slice(1, -1);
  }
  return token;
}

function isIdentifierToken(tok: string): boolean {
  return /^[A-Za-z_]/.test(tok) || tok.startsWith('"') || tok.startsWith('`') || tok.startsWith('[');
}

function skipBalancedParentheses(tokens: string[], openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < tokens.length) {
    if (tokens[i] === '(') {
      depth++;
    } else if (tokens[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

function skipOptionalAlias(tokens: string[], index: number): number {
  let i = index;
  if (i < tokens.length && tokens[i].toUpperCase() === 'AS') {
    i++;
    if (i < tokens.length && isIdentifierToken(tokens[i])) i++;
    return i;
  }
  if (
    i < tokens.length
    && isIdentifierToken(tokens[i])
    && !FROM_CLAUSE_TERMINATORS.has(tokens[i].toUpperCase())
  ) {
    i++;
  }
  return i;
}

function extractFromJoinTables(maskedSql: string): string[] {
  const tokens = maskedSql.match(TOKEN_REGEX) || [];
  const tables: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const upper = tokens[i].toUpperCase();
    if (upper !== 'FROM' && upper !== 'JOIN') {
      continue;
    }
    let j = i + 1;
    while (j < tokens.length) {
      const ident = tokens[j];
      if (ident === '(') {
        j = skipBalancedParentheses(tokens, j);
        j = skipOptionalAlias(tokens, j);
      } else if (isIdentifierToken(ident)) {
        const isTableValuedFunction = tokens[j + 1] === '(';
        if (isTableValuedFunction) {
          j = skipBalancedParentheses(tokens, j + 1);
          j = skipOptionalAlias(tokens, j);
        } else {
          tables.push(unquoteIdentifier(ident).toLowerCase());
          j++;
          j = skipOptionalAlias(tokens, j);
        }
      } else {
        break;
      }
      if (j < tokens.length && tokens[j] === ',') {
        j++;
        continue;
      }
      break;
    }
  }
  return tables;
}

export function extractLocalSqlSymbols(sql: string): string[] {
  const maskedSql = maskCommentsAndStrings(sql);
  const local = new Set<string>();

  for (const symbol of extractPersistentLocalSqlSymbolsFromMasked(maskedSql)) {
    local.add(symbol);
  }
  for (const match of maskedSql.matchAll(WITH_FIRST_LOCAL_REGEX)) {
    local.add(unquoteIdentifier(match[1]).toLowerCase());
  }
  for (const match of maskedSql.matchAll(WITH_CHAIN_LOCAL_REGEX)) {
    local.add(unquoteIdentifier(match[1]).toLowerCase());
  }

  return [...local].sort();
}

function extractPersistentLocalSqlSymbols(sql: string): string[] {
  return extractPersistentLocalSqlSymbolsFromMasked(maskCommentsAndStrings(sql));
}

function extractPersistentLocalSqlSymbolsFromMasked(maskedSql: string): string[] {
  const local = new Set<string>();
  for (const match of maskedSql.matchAll(CREATE_LOCAL_REGEX)) {
    local.add(unquoteIdentifier(match[1]).toLowerCase());
  }
  return [...local].sort();
}

function extractIncludes(maskedSql: string): string[] {
  const includes = new Set<string>();
  for (const match of maskedSql.matchAll(ALREADY_INCLUDED_REGEX)) {
    includes.add(match[1].toLowerCase());
  }
  return [...includes].sort();
}

function addReference(
  refs: Map<string, Set<SqlStdlibUsageKind>>,
  symbol: string,
  usage: SqlStdlibUsageKind,
): void {
  const normalized = symbol.toLowerCase();
  const usages = refs.get(normalized);
  if (usages) usages.add(usage);
  else refs.set(normalized, new Set([usage]));
}

function extractReferences(maskedSql: string): Map<string, Set<SqlStdlibUsageKind>> {
  const refs = new Map<string, Set<SqlStdlibUsageKind>>();
  for (const table of extractFromJoinTables(maskedSql)) {
    addReference(refs, table, 'table');
  }
  const functionSql = maskQuotedIdentifierRegions(maskedSql);
  for (const match of functionSql.matchAll(FUNCTION_CALL_REGEX)) {
    addReference(refs, match[1], 'function');
  }
  for (const match of functionSql.matchAll(MACRO_INVOCATION_REGEX)) {
    addReference(refs, match[1], 'macro');
  }
  return refs;
}

export function moduleCoveredByStdlibDeclaration(
  module: string,
  declarations: Iterable<string>,
): boolean {
  const normalized = module.toLowerCase();
  for (const declaration of declarations) {
    const declared = declaration.trim().toLowerCase();
    if (!declared) continue;
    if (moduleCoveredByPerfettoSqlLineage(normalized, declared)) {
      return true;
    }
  }
  return false;
}

function emptyAnalysis(source: SqlStdlibDependencyAnalysis['source']): SqlStdlibDependencyAnalysis {
  return {
    includes: [],
    localSymbols: [],
    dependencies: [],
    requiredModules: [],
    source,
  };
}

function analyzeSingleSqlFragment(
  sql: string,
  index: ReturnType<typeof getPerfettoStdlibSymbolIndex>,
  options: AnalyzeSingleSqlFragmentOptions = {},
): SqlStdlibDependencyAnalysis {
  if (!sql || typeof sql !== 'string') {
    return emptyAnalysis('empty');
  }

  const maskedSql = maskCommentsAndStrings(sql);
  const includeSet = new Set(extractIncludes(maskedSql));
  for (const module of options.extraIncludedModules ?? []) {
    includeSet.add(module.toLowerCase());
  }
  const includes = [...includeSet].sort();
  const localSymbols = new Set(extractLocalSqlSymbols(sql));
  for (const symbol of options.extraLocalSymbols ?? []) {
    localSymbols.add(symbol.toLowerCase());
  }

  const dependencies = new Map<string, SqlStdlibDependency>();
  for (const [symbol, usages] of extractReferences(maskedSql)) {
    if (localSymbols.has(symbol) || index.builtins.has(symbol)) continue;
    const module = index.tableToModule.get(symbol);
    if (!module) continue;
    for (const usage of usages) {
      dependencies.set(`${symbol}\n${usage}`, { symbol, module, usage });
    }
  }

  const requiredModules = new Set<string>();
  for (const dependency of dependencies.values()) {
    if (!moduleCoveredByStdlibDeclaration(dependency.module, includes)) {
      requiredModules.add(dependency.module);
    }
  }

  return {
    includes,
    localSymbols: [...localSymbols].sort(),
    dependencies: [...dependencies.values()].sort((a, b) =>
      a.module.localeCompare(b.module)
      || a.symbol.localeCompare(b.symbol)
      || a.usage.localeCompare(b.usage),
    ),
    requiredModules: [...requiredModules].sort(),
    source: index.source,
  };
}

export function analyzeSqlStdlibDependencySequence(
  sqlFragments: string[],
  options: AnalyzeSqlStdlibDependenciesOptions = {},
): SqlStdlibDependencyAnalysis[] {
  const index = getPerfettoStdlibSymbolIndex();
  const previousLocalSymbols = new Set<string>();
  const previousIncludedModules = new Set<string>();
  for (const symbol of options.extraLocalSymbols ?? []) {
    previousLocalSymbols.add(symbol.toLowerCase());
  }

  const analyses: SqlStdlibDependencyAnalysis[] = [];
  for (const fragment of sqlFragments) {
    const fragmentIncludes = new Set<string>();
    const fragmentLocalSymbols = new Set<string>();
    const fragmentDependencies = new Map<string, SqlStdlibDependency>();
    const fragmentRequiredModules = new Set<string>();
    const statements = splitSqlStatements(fragment);

    for (const statement of statements) {
      const currentLocalSymbols = extractLocalSqlSymbols(statement);
      const persistentLocalSymbols = extractPersistentLocalSqlSymbols(statement);
      const localSymbolsForStatement = new Set(previousLocalSymbols);
      for (const symbol of currentLocalSymbols) {
        localSymbolsForStatement.add(symbol);
      }

      const analysis = analyzeSingleSqlFragment(statement, index, {
        extraLocalSymbols: localSymbolsForStatement,
        extraIncludedModules: previousIncludedModules,
      });

      for (const include of analysis.includes) {
        fragmentIncludes.add(include);
        previousIncludedModules.add(include);
      }
      for (const symbol of analysis.localSymbols) {
        fragmentLocalSymbols.add(symbol);
      }
      for (const dependency of analysis.dependencies) {
        fragmentDependencies.set(`${dependency.symbol}\n${dependency.usage}`, dependency);
      }
      for (const module of analysis.requiredModules) {
        fragmentRequiredModules.add(module);
      }
      for (const symbol of persistentLocalSymbols) {
        previousLocalSymbols.add(symbol);
      }
    }

    analyses.push({
      includes: [...fragmentIncludes].sort(),
      localSymbols: [...fragmentLocalSymbols].sort(),
      dependencies: [...fragmentDependencies.values()].sort((a, b) =>
        a.module.localeCompare(b.module)
        || a.symbol.localeCompare(b.symbol)
        || a.usage.localeCompare(b.usage),
      ),
      requiredModules: [...fragmentRequiredModules].sort(),
      source: statements.length === 0 ? 'empty' : index.source,
    });
  }

  return analyses;
}

export function analyzeSqlStdlibDependencies(
  sql: string,
  options: AnalyzeSqlStdlibDependenciesOptions = {},
): SqlStdlibDependencyAnalysis {
  if (!sql || typeof sql !== 'string') {
    return emptyAnalysis('empty');
  }

  const analyses = analyzeSqlStdlibDependencySequence([sql], options);
  return analyses[0] ?? emptyAnalysis('empty');
}
