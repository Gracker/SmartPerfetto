// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Parsing limits are also limits on how much SQL can preserve native provenance. */
export const RAW_SQL_DIRECT_PROJECTION_LIMITS = Object.freeze({bytes: 65_536, tokens: 8_192, depth: 32});

export interface RawSqlProjectionRelation {
  readonly schema?: 'main';
  readonly name: string;
  readonly alias?: string;
}
export type RawSqlDirectProjection =
  | {readonly kind: 'column'; readonly column: string; readonly qualifier?: string; readonly alias?: string}
  | {readonly kind: 'star'; readonly qualifier?: string}
  | {readonly kind: 'scalar'; readonly alias?: string};
export type RawSqlUnitExpression =
  | {readonly kind: 'column'; readonly column: string; readonly qualifier?: string}
  | {readonly kind: 'literal'; readonly value: string}
  | {readonly kind: 'star'; readonly qualifier?: string}
  | {readonly kind: 'unknown'}
  | {readonly kind: 'binary'; readonly operator: string; readonly left: RawSqlUnitExpression; readonly right: RawSqlUnitExpression}
  | {readonly kind: 'function'; readonly name: string; readonly args: readonly RawSqlUnitExpression[]};
export interface RawSqlUnitProjection {
  readonly expression: RawSqlUnitExpression;
  readonly alias?: string;
}
export interface RawSqlDirectProjectionAnalysis {
  readonly pureRead: boolean;
  readonly reason?: string;
  readonly relation?: RawSqlProjectionRelation;
  /** Complete SELECT slots when row lineage is eligible; scalar slots have no source mapping. */
  readonly projections?: readonly RawSqlDirectProjection[];
  /** Quantity expressions on one relation; these never establish native row identity. */
  readonly unitExpressions?: readonly RawSqlUnitProjection[];
}
export interface RawSqlProjectionColumn {
  readonly outputColumn: string;
  readonly sourceColumn: string;
}

type Token = {kind: 'identifier' | 'string' | 'number' | 'parameter' | 'symbol'; value: string; quoted?: boolean};
type Expression = {direct?: Exclude<RawSqlDirectProjection, {kind: 'scalar'}>; unit?: RawSqlUnitExpression};
const unknownUnit = (): RawSqlUnitExpression => ({kind: 'unknown'});
class UnsupportedSql extends Error {}
const fail = (reason = 'sql_unrecognized'): never => {throw new UnsupportedSql(reason);};
const canonical = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
const keyword = (token: Token | undefined, value: string): boolean =>
  token?.kind === 'identifier' && !token.quoted && canonical(token.value) === value;

function tokenize(sql: string): Token[] {
  if (Buffer.byteLength(sql, 'utf8') > RAW_SQL_DIRECT_PROJECTION_LIMITS.bytes) fail('sql_byte_budget');
  if (sql.includes('\0')) fail();
  const tokens: Token[] = [];
  let index = 0;
  let depth = 0;
  const push = (token: Token) => {
    if (tokens.length >= RAW_SQL_DIRECT_PROJECTION_LIMITS.tokens) fail('sql_token_budget');
    tokens.push(token);
  };
  while (index < sql.length) {
    const char = sql[index];
    if (/[ \t\n\r\v\f]/.test(char)) {index++; continue;}
    if (sql.startsWith('--', index)) {
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) fail();
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const endQuote = char === '[' ? ']' : char;
      let value = '';
      let closed = false;
      index++;
      while (index < sql.length) {
        const next = sql[index++];
        if (next === endQuote) {
          if (char !== '[' && sql[index] === endQuote) {value += endQuote; index++; continue;}
          closed = true;
          break;
        }
        value += next;
      }
      if (!closed) fail();
      push({kind: char === "'" ? 'string' : 'identifier', value, quoted: true});
      continue;
    }
    const numeric = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(index));
    if (numeric) {push({kind: 'number', value: numeric[0]}); index += numeric[0].length; continue;}
    const identifier = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (identifier) {push({kind: 'identifier', value: identifier[0]}); index += identifier[0].length; continue;}
    const parameter = /^(?:\?\d*|[:@$][A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(index));
    if (parameter) {push({kind: 'parameter', value: parameter[0]}); index += parameter[0].length; continue;}
    const pair = sql.slice(index, index + 2);
    if (['||', '<<', '>>', '<=', '>=', '<>', '!=', '=='].includes(pair)) {
      push({kind: 'symbol', value: pair}); index += 2; continue;
    }
    if ('(),.;+-*/%&|~=<>'.includes(char)) {
      if (char === '(' && ++depth > RAW_SQL_DIRECT_PROJECTION_LIMITS.depth) fail('sql_depth_budget');
      if (char === ')' && --depth < 0) fail();
      push({kind: 'symbol', value: char}); index++; continue;
    }
    fail();
  }
  if (depth !== 0) fail();
  return tokens;
}

// These SQLite builtins cannot mutate schema on an otherwise trusted processor.
// Unknown and Perfetto extension functions (including run_metric) are not admitted.
const PURE_FUNCTIONS = new Set([
  'abs', 'avg', 'coalesce', 'count', 'hex', 'ifnull', 'instr', 'length', 'lower',
  'ltrim', 'max', 'min', 'nullif', 'quote', 'replace', 'round', 'rtrim', 'substr',
  'substring', 'sum', 'total', 'trim', 'typeof', 'unicode', 'upper',
]);
// Even multi-argument min/max are conservatively excluded from row lineage.
const AGGREGATE_FUNCTIONS = new Set(['avg', 'count', 'max', 'min', 'sum', 'total']);
const CAST_TYPES = new Set(['blob', 'double', 'float', 'int', 'integer', 'numeric', 'real', 'text']);
const RESERVED = new Set([
  'all', 'and', 'as', 'asc', 'between', 'by', 'case', 'cast', 'collate', 'cross', 'desc', 'distinct',
  'else', 'end', 'escape', 'except', 'filter', 'first', 'from', 'full', 'glob', 'group', 'having', 'in',
  'indexed', 'inner', 'intersect', 'is', 'join', 'last', 'left', 'like', 'limit', 'natural', 'not', 'null',
  'nulls', 'offset', 'on', 'or', 'order', 'outer', 'over', 'returning', 'right', 'select', 'then', 'union',
  'using', 'when', 'where', 'window', 'with',
]);
const SYMBOL_PRECEDENCE: Readonly<Record<string, number>> = {
  '=': 3, '==': 3, '!=': 3, '<>': 3, '<': 3, '>': 3, '<=': 3, '>=': 3,
  '|': 4, '&': 4, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '||': 7,
};

class ReadParser {
  private index = 0;
  private hasAggregate = false;
  private hasSubquery = false;
  constructor(private readonly tokens: readonly Token[], private readonly nestingDepth = 0) {}
  private peek(): Token | undefined {return this.tokens[this.index];}
  private take(): Token {return this.tokens[this.index++] ?? fail();}
  private word(value: string): boolean {
    if (!keyword(this.peek(), value)) return false;
    this.index++; return true;
  }
  private symbol(value: string): boolean {
    if (this.peek()?.kind !== 'symbol' || this.peek()?.value !== value) return false;
    this.index++; return true;
  }
  private requireWord(value: string): void {if (!this.word(value)) fail();}
  private requireSymbol(value: string): void {if (!this.symbol(value)) fail();}
  private identifier(): string {
    const token = this.take();
    if (token.kind !== 'identifier' || (!token.quoted && RESERVED.has(canonical(token.value))) || !token.value) fail();
    return token.value;
  }
  private alias(): string | undefined {
    if (this.word('as')) return this.identifier();
    const token = this.peek();
    return token?.kind === 'identifier' && (token.quoted || !RESERVED.has(canonical(token.value)))
      ? this.identifier() : undefined;
  }
  private relation(): RawSqlProjectionRelation {
    const first = this.identifier();
    let name = first;
    let schema: 'main' | undefined;
    if (this.symbol('.')) {
      if (canonical(first) !== 'main') fail();
      schema = 'main'; name = this.identifier();
    }
    // A relation function, subquery, index hint or additional qualification is
    // deliberately outside this grammar, not a reason to assume it is a read.
    const alias = this.alias();
    return {name: canonical(name), ...(schema ? {schema} : {}), ...(alias ? {alias: canonical(alias)} : {})};
  }
  /** Opening parenthesis is consumed; validate the entire nested SELECT with the same grammar. */
  private subquery(depth: number): boolean {
    if (!keyword(this.peek(), 'select')) return false;
    const nestingDepth = this.nestingDepth + depth + 1;
    if (nestingDepth > RAW_SQL_DIRECT_PROJECTION_LIMITS.depth) fail('sql_depth_budget');
    let parentheses = 0;
    let end = this.index;
    for (; end < this.tokens.length; end++) {
      const token = this.tokens[end];
      if (token.kind !== 'symbol') continue;
      if (token.value === ';') fail();
      if (token.value === '(') parentheses++;
      if (token.value === ')') {
        if (parentheses === 0) break;
        parentheses--;
      }
    }
    if (end === this.tokens.length) fail();
    new ReadParser(this.tokens.slice(this.index, end), nestingDepth).parse();
    this.index = end + 1;
    this.hasSubquery = true;
    return true;
  }
  private primary(depth: number, allowStar = false): Expression {
    if (this.nestingDepth + depth > RAW_SQL_DIRECT_PROJECTION_LIMITS.depth) fail('sql_depth_budget');
    if (this.symbol('+') || this.symbol('-') || this.symbol('~') || this.word('not')) {
      this.expression(8, depth + 1); return {};
    }
    if (this.symbol('(')) {
      if (this.subquery(depth)) return {};
      const expression = this.expression(0, depth + 1); this.requireSymbol(')'); return {unit: expression.unit};
    }
    if (allowStar && this.symbol('*')) return {direct: {kind: 'star'}, unit: {kind: 'star'}};
    const token = this.peek();
    if (token?.kind === 'number') {this.take(); return {unit: {kind: 'literal', value: token.value}};}
    if (token?.kind === 'string' || token?.kind === 'parameter' ||
      ['null', 'true', 'false'].some(value => keyword(token, value))) {this.take(); return {};}
    if (this.word('cast')) {
      this.requireSymbol('('); this.expression(0, depth + 1); this.requireWord('as');
      if (!CAST_TYPES.has(canonical(this.identifier()))) fail();
      this.requireSymbol(')'); return {};
    }
    const name = this.identifier();
    if (this.symbol('(')) {
      if (!PURE_FUNCTIONS.has(canonical(name))) fail();
      if (AGGREGATE_FUNCTIONS.has(canonical(name))) this.hasAggregate = true;
      const args: RawSqlUnitExpression[] = [];
      if (!this.symbol(')')) {
        this.word('distinct');
        if (this.symbol('*')) {
          if (canonical(name) !== 'count') fail();
          args.push({kind: 'star'});
        } else {
          args.push(this.expression(0, depth + 1).unit ?? unknownUnit());
          while (this.symbol(',')) args.push(this.expression(0, depth + 1).unit ?? unknownUnit());
        }
        this.requireSymbol(')');
      }
      return {unit: {kind: 'function', name: canonical(name), args}};
    }
    if (this.symbol('.')) {
      if (allowStar && this.symbol('*')) {
        const direct = {kind: 'star' as const, qualifier: canonical(name)};
        return {direct, unit: direct};
      }
      const column = this.identifier();
      const direct = {kind: 'column' as const, qualifier: canonical(name), column};
      return {direct, unit: direct};
    }
    const direct = {kind: 'column' as const, column: name};
    return {direct, unit: direct};
  }
  private expression(minPrecedence = 0, depth = 0, allowStar = false): Expression {
    let result = this.primary(depth, allowStar);
    while (this.peek()) {
      if (keyword(this.peek(), 'collate')) {
        if (8 < minPrecedence) break;
        this.take();
        if (!['binary', 'nocase', 'rtrim'].includes(canonical(this.identifier()))) fail();
        result = {}; continue;
      }
      const token = this.peek()!;
      const word = token.kind === 'identifier' && !token.quoted ? canonical(token.value) : '';
      const negated = word === 'not' && ['in', 'between', 'like', 'glob'].some(value => keyword(this.tokens[this.index + 1], value));
      const operator = negated ? canonical(this.tokens[this.index + 1].value) : word;
      const precedence = token.kind === 'symbol' ? SYMBOL_PRECEDENCE[token.value]
        : operator === 'or' ? 1 : operator === 'and' ? 2
          : ['is', 'in', 'between', 'like', 'glob'].includes(operator) ? 3 : undefined;
      if (precedence === undefined || precedence < minPrecedence) break;
      this.take(); if (negated) this.take();
      if (operator === 'is') this.word('not');
      if (operator === 'in') {
        this.requireSymbol('(');
        if (!this.subquery(depth)) {
          this.expression(0, depth + 1);
          while (this.symbol(',')) this.expression(0, depth + 1);
          this.requireSymbol(')');
        }
      } else if (operator === 'between') {
        this.expression(4, depth + 1); this.requireWord('and'); this.expression(4, depth + 1);
      } else {
        const right = this.expression(precedence + 1, depth + 1);
        if (operator === 'like' && this.word('escape')) this.expression(4, depth + 1);
        result = {unit: {kind: 'binary', operator: token.value.toLowerCase(),
          left: result.unit ?? unknownUnit(), right: right.unit ?? unknownUnit()}};
        continue;
      }
      result = {};
    }
    return result;
  }
  parse(): RawSqlDirectProjectionAnalysis {
    this.requireWord('select');
    if (!this.word('distinct')) this.word('all');
    const projections: RawSqlDirectProjection[] = [];
    const unitExpressions: RawSqlUnitProjection[] = [];
    let preservesRows = true;
    let singleRelation = true;
    do {
      const expression = this.expression(0, 0, true);
      const alias = this.alias();
      if (expression.direct?.kind === 'star' && alias) fail();
      projections.push({...(expression.direct ?? {kind: 'scalar' as const}), ...(alias ? {alias} : {})});
      unitExpressions.push({expression: expression.unit ?? unknownUnit(), ...(alias ? {alias} : {})});
    } while (this.symbol(','));
    let relation: RawSqlProjectionRelation | undefined;
    if (this.word('from')) {
      relation = this.relation();
      while (this.peek()) {
        if (this.symbol(',')) {this.relation(); preservesRows = false; singleRelation = false; continue;}
        const joined = this.word('join');
        if (!joined) {
          const modifier = ['inner', 'left', 'right', 'full', 'cross'].find(value => this.word(value));
          if (!modifier) break;
          if (['left', 'right', 'full'].includes(modifier)) this.word('outer');
          this.requireWord('join');
        }
        this.relation(); preservesRows = false; singleRelation = false;
        if (this.word('on')) this.expression();
        else if (this.word('using')) {
          this.requireSymbol('('); this.identifier();
          while (this.symbol(',')) this.identifier();
          this.requireSymbol(')');
        }
      }
    }
    if (this.word('where')) this.expression();
    if (this.word('group')) {
      this.requireWord('by'); this.expression();
      while (this.symbol(',')) this.expression();
      preservesRows = false;
    }
    if (this.word('having')) {this.expression(); preservesRows = false;}
    if (this.word('order')) {
      this.requireWord('by');
      do {
        this.expression();
        if (!this.word('asc')) this.word('desc');
        if (this.word('nulls') && !this.word('first') && !this.word('last')) fail();
      } while (this.symbol(','));
    }
    if (this.word('limit')) {
      this.expression();
      if (this.word('offset') || this.symbol(',')) this.expression();
    }
    if (this.nestingDepth === 0) this.symbol(';');
    if (this.index !== this.tokens.length) fail();
    return {pureRead: true, ...(relation ? {relation} : {}),
      ...(singleRelation && !this.hasSubquery && relation && projections.some(slot => slot.kind === 'scalar')
        ? {unitExpressions} : {}),
      ...(preservesRows && !this.hasAggregate && !this.hasSubquery && relation ? {projections} : {reason: 'projection_not_direct'})};
  }
}

/** Recognizes a bounded positive read grammar. It does not execute or rewrite SQL. */
export function analyzeRawSqlDirectProjection(sql: string): RawSqlDirectProjectionAnalysis {
  try {return new ReadParser(tokenize(sql)).parse();}
  catch (error) {
    if (error instanceof UnsupportedSql) return {pureRead: false, reason: error.message};
    throw error;
  }
}

/** Resolve direct expressions against actual output and a caller-supplied formal schema. No unit or identity authority is granted here. */
export function resolveRawSqlDirectProjection(
  analysis: RawSqlDirectProjectionAnalysis,
  outputColumns: readonly string[],
  schemaColumns: readonly string[],
): RawSqlProjectionColumn[] | undefined {
  if (!analysis.pureRead || !analysis.relation || !analysis.projections?.length ||
    !outputColumns.length || !schemaColumns.length ||
    outputColumns.length > RAW_SQL_DIRECT_PROJECTION_LIMITS.tokens || schemaColumns.length > RAW_SQL_DIRECT_PROJECTION_LIMITS.tokens) return undefined;
  const unique = (columns: readonly string[]) => columns.every(column => typeof column === 'string' && column.length > 0) &&
    new Set(columns.map(canonical)).size === columns.length;
  if (!unique(outputColumns) || !unique(schemaColumns)) return undefined;
  const schema = new Map(schemaColumns.map(column => [canonical(column), column]));
  const result: RawSqlProjectionColumn[] = [];
  let outputIndex = 0;
  const appendDirect = (outputColumn: string, sourceColumn: string): boolean => {
    if (outputColumn !== outputColumns[outputIndex]) return false;
    result.push({outputColumn, sourceColumn});
    outputIndex++;
    return true;
  };
  for (const projection of analysis.projections) {
    if (projection.kind === 'scalar') {
      // A scalar consumes exactly one actual output slot. Its name never gives
      // it a source column, unit, or row identity, even when aliased as id/dur.
      if (outputIndex >= outputColumns.length ||
        (projection.alias !== undefined && projection.alias !== outputColumns[outputIndex])) return undefined;
      outputIndex++;
      continue;
    }
    if (projection.qualifier !== undefined && canonical(projection.qualifier) !==
      (analysis.relation.alias ?? analysis.relation.name)) return undefined;
    if (projection.kind === 'star') {
      for (const column of schemaColumns) if (!appendDirect(column, column)) return undefined;
    } else {
      const sourceColumn = schema.get(canonical(projection.column));
      if (!sourceColumn) return undefined;
      if (!appendDirect(projection.alias ?? sourceColumn, sourceColumn)) return undefined;
    }
  }
  return outputIndex === outputColumns.length && result.length > 0 ? result : undefined;
}
