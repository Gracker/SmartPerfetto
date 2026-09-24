// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { getPerfettoStdlibSymbolIndex } from './perfettoStdlibScanner';
import { moduleCoveredByPerfettoSqlLineage } from './perfettoSqlDocs';

/**
 * How SQL uses a stdlib symbol. `introspection` is a schema lookup by exact
 * string literal (`pragma_table_info('x')`, sqlite_master `name = 'x'`); it is
 * reported only when a caller asks for it.
 */
export type SqlStdlibUsageKind = 'table' | 'function' | 'macro' | 'introspection';

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
  /**
   * Also resolve names the SQL introspects by exact string literal. Raw SQL
   * auto-INCLUDE enables this so the model's own existence check sees the view;
   * Skill validation does not, because a Skill's sqlite_master gate is a
   * deliberate presence test over modules it already declares.
   */
  includeIntrospectedNames?: boolean;
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

function maskCommentsAndStrings(sql: string, keepStrings = false): string {
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
      const start = i;
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
      out += keepStrings ? sql.slice(start, i) : sql.slice(start, i).replace(/[^\n]/g, ' ');
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

/** Skip an optional `[AS] alias` after a FROM/JOIN item; return the next index and the alias. */
function readOptionalAlias(tokens: string[], index: number): {next: number; alias?: string} {
  let i = index;
  if (i < tokens.length && tokens[i].toUpperCase() === 'AS') {
    i++;
    if (i < tokens.length && isIdentifierToken(tokens[i])) {
      return {next: i + 1, alias: unquoteIdentifier(tokens[i]).toLowerCase()};
    }
    return {next: i};
  }
  if (
    i < tokens.length
    && isIdentifierToken(tokens[i])
    && !FROM_CLAUSE_TERMINATORS.has(tokens[i].toUpperCase())
  ) {
    return {next: i + 1, alias: unquoteIdentifier(tokens[i]).toLowerCase()};
  }
  return {next: i};
}

/** A table read in FROM/JOIN position and the alias it is read under. */
export interface SqlTableBinding {
  table: string;
  alias?: string;
}

function extractFromJoinBindings(maskedSql: string): SqlTableBinding[] {
  const tokens = maskedSql.match(TOKEN_REGEX) || [];
  const bindings: SqlTableBinding[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const upper = tokens[i].toUpperCase();
    if (upper !== 'FROM' && upper !== 'JOIN') {
      continue;
    }
    let j = i + 1;
    while (j < tokens.length) {
      const ident = tokens[j];
      if (ident === '(') {
        j = readOptionalAlias(tokens, skipBalancedParentheses(tokens, j)).next;
      } else if (isIdentifierToken(ident)) {
        const isTableValuedFunction = tokens[j + 1] === '(';
        if (isTableValuedFunction) {
          j = readOptionalAlias(tokens, skipBalancedParentheses(tokens, j + 1)).next;
        } else {
          const {next, alias} = readOptionalAlias(tokens, j + 1);
          bindings.push({table: unquoteIdentifier(ident).toLowerCase(), ...(alias ? {alias} : {})});
          j = next;
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
  return bindings;
}

function extractFromJoinTables(maskedSql: string): string[] {
  return extractFromJoinBindings(maskedSql).map(binding => binding.table);
}

/**
 * Lower-cased names read in FROM/JOIN position that the query does not define
 * itself (CTEs, CREATE statements); subqueries and table functions are skipped.
 */
export function extractExternalTableReferences(sql: string): string[] {
  return [...new Set(extractExternalTableBindings(sql).map(binding => binding.table))];
}

/**
 * {@link extractExternalTableReferences} with the alias each table is read
 * under, in query order. A table read twice appears once per alias.
 */
export function extractExternalTableBindings(sql: string): SqlTableBinding[] {
  const masked = maskCommentsAndStrings(sql);
  const local = localSqlSymbolsFromMasked(masked);
  const seen = new Set<string>();
  return extractFromJoinBindings(masked).filter(binding => {
    const key = `${binding.table}\n${binding.alias ?? ''}`;
    if (local.has(binding.table) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractLocalSqlSymbols(sql: string): string[] {
  return [...localSqlSymbolsFromMasked(maskCommentsAndStrings(sql))].sort();
}

function localSqlSymbolsFromMasked(maskedSql: string): Set<string> {
  const local = new Set(extractPersistentLocalSqlSymbolsFromMasked(maskedSql));
  for (const regex of [WITH_FIRST_LOCAL_REGEX, WITH_CHAIN_LOCAL_REGEX]) {
    for (const match of maskedSql.matchAll(regex)) {
      local.add(unquoteIdentifier(match[1]).toLowerCase());
    }
  }
  return local;
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

const STRING_LITERAL = String.raw`'((?:[^']|'')*)'`;
const PRAGMA_TABLE_INFO_FUNCTION_REGEX = new RegExp(
  String.raw`\bpragma_table_x?info\s*\(\s*${STRING_LITERAL}`,
  'gi',
);
const PRAGMA_TABLE_INFO_STATEMENT_REGEX = new RegExp(
  String.raw`\bPRAGMA\s+(?:[A-Za-z_]\w*\.)?table_x?info\s*\(\s*(?:${STRING_LITERAL}|"((?:[^"]|"")+)"|([A-Za-z_]\w*))\s*\)`,
  'gi',
);
/** Cheap raw-text prefilter: every introspection form names one of these. */
const INTROSPECTION_HINT_REGEX = /pragma|sqlite_(?:temp_)?(?:master|schema)/i;
const SCHEMA_TABLE_REGEX = /\b(?:sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema)\b/i;
const SCHEMA_NAME_EQUALS_REGEX = new RegExp(
  String.raw`\b(?:[A-Za-z_]\w*\.)?(?:name|tbl_name)\s*(?:==?|\bIS\b)\s*${STRING_LITERAL}`,
  'gi',
);
const SCHEMA_NAME_IN_REGEX = /\b(?:[A-Za-z_]\w*\.)?(?:name|tbl_name)\s+IN\s*\(([^)]*)\)/gi;
const STRING_LITERAL_REGEX = new RegExp(STRING_LITERAL, 'g');

function literalValue(raw: string): string {
  return raw.replace(/''/g, "'").toLowerCase();
}

/**
 * Names a statement asks the schema about by exact string literal:
 * `pragma_table_info('x')`, `PRAGMA table_info(x)`, and `name = 'x'` /
 * `name IN ('x', ...)` against sqlite_master. A stdlib view is invisible to
 * both until its module is included, so the introspection itself returns
 * nothing and reads as "the table does not exist". Patterns (`LIKE`, `GLOB`)
 * name no single symbol and are not resolved.
 */
function extractIntrospectedNames(sql: string, maskedSql: string): string[] {
  if (!INTROSPECTION_HINT_REGEX.test(sql)) return [];
  // Comments blanked, string literals kept: the scan reads their values.
  const text = maskCommentsAndStrings(sql, true);
  const names = new Set<string>();
  for (const match of text.matchAll(PRAGMA_TABLE_INFO_FUNCTION_REGEX)) {
    names.add(literalValue(match[1]));
  }
  for (const match of text.matchAll(PRAGMA_TABLE_INFO_STATEMENT_REGEX)) {
    const value = match[1] ?? match[2]?.replace(/""/g, '"') ?? match[3];
    if (value) names.add(literalValue(value));
  }
  if (SCHEMA_TABLE_REGEX.test(maskedSql)) {
    for (const match of text.matchAll(SCHEMA_NAME_EQUALS_REGEX)) {
      names.add(literalValue(match[1]));
    }
    for (const match of text.matchAll(SCHEMA_NAME_IN_REGEX)) {
      for (const literal of match[1].matchAll(STRING_LITERAL_REGEX)) {
        names.add(literalValue(literal[1]));
      }
    }
  }
  return [...names];
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

  const references = extractReferences(maskedSql);
  if (options.includeIntrospectedNames) {
    for (const name of extractIntrospectedNames(sql, maskedSql)) {
      addReference(references, name, 'introspection');
    }
  }
  const dependencies = new Map<string, SqlStdlibDependency>();
  for (const [symbol, usages] of references) {
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
        includeIntrospectedNames: options.includeIntrospectedNames,
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
