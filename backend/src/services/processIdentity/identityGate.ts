// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillDefinition } from '../skillEngine/types';
import { builtInFragmentText, injectFragmentCtes } from '../skillEngine/skillFragments';
import { executableSqlUnits } from '../skillEngine/processScopeSql';
import type { SqlToken } from '../skillEngine/sqlTemplate';
import {
  closingParen,
  cteDefinitionAt,
  isNameToken,
  nameQualifier,
  operandEndingAt,
  operandStartingAt,
  QUERY_START,
  structuralSqlTokens,
  tokenMatchers,
  unqualifiedName,
} from '../skillEngine/sqlStructure';
import { perfettoRelationColumns } from '../perfettoSqlDocs';
import type { IdentityTraceSide } from '../../types/identityContract';
import { assertEffectiveProcessScope, createEffectiveProcessScope, verifiedIdentityForScope, type EffectiveProcessScope } from './effectiveProcessScope';
import {
  DEFAULT_PROCESS_IDENTITY_ALIASES,
  PROCESS_IDENTITY_SELECTORS,
  type ProcessIdentityResolution,
  type ProcessIdentityTarget,
  type SkillIdentityConfig,
} from './types';

export interface IdentityGateInput {
  traceId: string;
  traceSide?: IdentityTraceSide;
  processScope?: EffectiveProcessScope;
  skill: SkillDefinition;
  params: Record<string, any>;
  inherited?: Record<string, any>;
  resolve: (target: ProcessIdentityTarget) => Promise<ProcessIdentityResolution>;
}

export interface IdentityGateResult {
  allowed: boolean;
  params: Record<string, any>;
  inherited: Record<string, any>;
  config: SkillIdentityConfig;
  target?: ProcessIdentityTarget;
  resolution?: ProcessIdentityResolution;
  processScope?: EffectiveProcessScope;
  error?: string;
}

// Whether a statement scopes its rows to a named process: it compares a
// process-name column to something. Read from the statement's structure
// (sqlStructure.ts) rather than its text around a column, so `p.name='com.foo'`
// with no spaces, `LOWER(TRIM(p.name)) = ...`, `CAST(p.name AS TEXT) GLOB ...`,
// `'com.foo' = p.name`, `CASE p.name WHEN ...`, `glob('com.*', p.name)` and a
// column that carries a process name out of a CTE or derived table (`AS`
// aliases, CTE column lists, implicit columns, `*`, a subquery's output) all
// count, and so does a join `USING` a process-name column or a `NATURAL` join
// that may match one; a thread or slice `name`, a process table a CTE named
// `process` replaces, and a comparison with NULL do not. Names resolve by
// query block, as SQL does: a qualifier through the block's FROM list and then
// the enclosing ones, a bare column through the first block (its own, then the
// enclosing ones) whose relations have it, a CTE where it is visible. A table's
// columns come from the pinned runtime's SQL docs; an undocumented table may
// have any column.
/** Columns that hold a process name wherever they appear. */
const PROCESS_NAME_COLUMNS = new Set(['process_name', 'client_process', 'server_process', 'package_name']);
/** Words after a relation that are not its alias. */
const NOT_AN_ALIAS = new Set([
  'WHERE', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'GROUP',
  'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'SELECT', 'VALUES', 'SET', 'INDEXED', 'NOT',
]);
/** Words that end a FROM clause's relation list (a JOIN's ON or USING predicate does not: `JOIN s ON ..., process p`). */
const FROM_LIST_END = new Set(['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'SELECT']);
/** Operators that join the SELECT branches of one compound query. */
const COMPOUND = new Set(['UNION', 'EXCEPT', 'INTERSECT']);
const COMPARISON_PUNCT = new Set(['=', '==', '!=', '<>']);
const COMPARISON_WORDS = new Set(['IS', 'IN', 'GLOB', 'LIKE', 'REGEXP', 'MATCH']);
/**
 * Functions whose value is never the text of their arguments (a count, a
 * length, a sum, a type, a truth value), so a name they read does not carry
 * out of them. A comparison inside their arguments is still read on its own.
 */
const NON_NAME_VALUE_FUNCTIONS = new Set(['COUNT', 'LENGTH', 'OCTET_LENGTH', 'SUM', 'TOTAL', 'AVG', 'UNICODE', 'TYPEOF', 'EXISTS']);
/** A word before `(` that leaves the parenthesis an expression, not a call. */
const EXPRESSION_WORDS = new Set(['WHERE', 'AND', 'OR', 'NOT', 'ON', 'WHEN', 'THEN', 'ELSE', 'SELECT', 'HAVING', 'CASE', 'BY', 'IN', 'EXISTS']);

/** What a relation in a FROM list is: the process table, a CTE or derived table by key, or another table. */
type Relation = {kind: 'process'} | {kind: 'source'; key: string} | {kind: 'other'; name: string};
type TableRelation = Exclude<Relation, {kind: 'source'}>;
/** A relation of a block's FROM list, at token `at`. */
interface RelationEntry { name?: string; alias?: string; relation: Relation; at: number }
/** A CTE as its defining query block sees it. */
interface ScopedCte { key: string; bodyBlock: number; columns?: string[] }
/** One output column of a CTE or derived table, and whether it carries a process name. */
interface OutputColumn { name?: string; holds: boolean }
/**
 * A query's output columns in order. Not `exact` when a `*` expands a table
 * or a join that merges columns: positions after it are unknown. Not
 * `complete` when a `*` expands a table whose columns are not documented: it
 * may have columns not listed here.
 */
interface Outputs { columns: OutputColumn[]; exact: boolean; complete: boolean }

function processNameFilter(tokens: readonly SqlToken[]): boolean {
  const {word, punct} = tokenMatchers(tokens);

  // Query blocks. A parenthesis that opens SELECT, WITH or VALUES starts a
  // block inside the enclosing one; UNION, EXCEPT and INTERSECT start a
  // sibling branch. FROM aliases resolve through `relationParentOf` (the
  // enclosing block, never a sibling branch); CTE names through
  // `cteParentOf` (a branch sees the WITH of its compound's first branch).
  const blockOf: number[] = [];
  const relationParentOf: number[] = [-1];
  const cteParentOf: number[] = [-1];
  const headOf: number[] = [0];
  const branchesOf = new Map<number, number[]>([[0, [0]]]);
  {
    const newBlock = (relationParent: number, cteParent: number, head?: number) => {
      const block = relationParentOf.length;
      relationParentOf.push(relationParent);
      cteParentOf.push(cteParent);
      headOf.push(head ?? block);
      if (head === undefined) branchesOf.set(block, [block]);
      else branchesOf.get(head)!.push(block);
      return block;
    };
    const stack = [0];
    tokens.forEach((token, index) => {
      const top = stack[stack.length - 1];
      if (punct(index, '(')) {
        const next = tokens[index + 1];
        stack.push(next?.kind === 'word' && QUERY_START.has(next.text) ? newBlock(top, top) : top);
      } else if (token.kind === 'word' && COMPOUND.has(token.text)) {
        const head = headOf[top];
        stack[stack.length - 1] = newBlock(relationParentOf[head], head, head);
      }
      blockOf[index] = stack[stack.length - 1];
      if (punct(index, ')') && stack.length > 1) stack.pop();
    });
  }
  const chain = function* (block: number, parents: readonly number[]) {
    for (let at = block; at >= 0; at = parents[at]) yield at;
  };

  // CTEs, by the block that defines them; each is visible in that block and
  // the blocks inside it (its own body and later CTE bodies included).
  const ctesByBlock = new Map<number, Map<string, ScopedCte>>();
  tokens.forEach((token, index) => {
    if (!isNameToken(token) || token.text.includes('.')) return;
    const cte = cteDefinitionAt(tokens, index);
    if (!cte) return;
    const defined = ctesByBlock.get(blockOf[index]) ?? new Map<string, ScopedCte>();
    defined.set(unqualifiedName(token), {key: `cte:${index}`, bodyBlock: blockOf[cte.bodyStart], columns: cte.columns});
    ctesByBlock.set(blockOf[index], defined);
  });
  const resolveCte = (name: string, block: number): ScopedCte | undefined => {
    for (const at of chain(block, cteParentOf)) {
      const cte = ctesByBlock.get(at)?.get(name);
      if (cte) return cte;
    }
    return undefined;
  };

  // The relations each block reads, with their aliases: the process table
  // (unless a visible CTE replaces it), CTEs, and derived tables.
  const relationsOf = new Map<number, RelationEntry[]>();
  /** The alias written at `at` (after an optional AS), if the word there is one. */
  const aliasAt = (at: number): string | undefined => {
    if (word(at, 'AS')) at++;
    const aliasToken = tokens[at];
    return isNameToken(aliasToken) && !(aliasToken.kind === 'word' && NOT_AN_ALIAS.has(aliasToken.text))
      ? unqualifiedName(aliasToken) : undefined;
  };
  const addRelation = (block: number, name: string | undefined, relation: Relation, at: number, aliasFrom: number): void => {
    const entries = relationsOf.get(block) ?? [];
    entries.push({name, alias: aliasAt(aliasFrom), relation, at});
    relationsOf.set(block, entries);
  };
  const inFrom: boolean[] = [false];
  /** A `(` in a FROM list that groups relations rather than opening a query, by its `)`: `FROM (process p)`. */
  const relationGroups = new Map<number, number>();
  /** Blocks whose FROM list merges join columns (USING, NATURAL): an unqualified `*` there lists them once. */
  const mergesJoinColumns = new Set<number>();
  tokens.forEach((token, index) => {
    const relationPosition = word(index - 1, 'FROM') || word(index - 1, 'JOIN')
      || (punct(index - 1, ',') && inFrom[inFrom.length - 1])
      || relationGroups.has(index - 1);
    if (token.kind === 'punct') {
      if (token.text === '(') {
        const opensQuery = tokens[index + 1]?.kind === 'word' && QUERY_START.has(tokens[index + 1].text);
        if (relationPosition && opensQuery) {
          addRelation(blockOf[index - 1] ?? 0, undefined, {kind: 'source', key: `block:${blockOf[index]}`}, index, closingParen(tokens, index) + 1);
        } else if (relationPosition) {
          relationGroups.set(index, closingParen(tokens, index));
        }
        inFrom.push(relationGroups.has(index));
      } else if (token.text === ')' && inFrom.length > 1) {
        inFrom.pop();
        // `FROM (process) p`: the alias after a group of one relation names that relation,
        // replacing one inside it (SQLite reads `(process AS q) p` as p only).
        const open = [...relationGroups].find(([, close]) => close === index)?.[0];
        const inside = open === undefined ? [] : (relationsOf.get(blockOf[index]) ?? []).filter(entry => entry.at > open && entry.at < index);
        const alias = inside.length === 1 ? aliasAt(index + 1) : undefined;
        if (alias !== undefined) inside[0].alias = alias;
      }
      return;
    }
    if (token.kind === 'word' && (token.text === 'FROM' || token.text === 'JOIN')) { inFrom[inFrom.length - 1] = true; return; }
    if (token.kind === 'word' && (token.text === 'USING' || token.text === 'NATURAL')) { mergesJoinColumns.add(blockOf[index]); return; }
    if (token.kind === 'word' && FROM_LIST_END.has(token.text)) { inFrom[inFrom.length - 1] = false; return; }
    if (!isNameToken(token) || !relationPosition || punct(index + 1, '(')) return;
    const name = unqualifiedName(token);
    // A CTE replaces only an unqualified name: `main.process` stays the table.
    const cte = token.text.includes('.') ? undefined : resolveCte(name, blockOf[index]);
    const relation: Relation = cte ? {kind: 'source', key: cte.key} : name === 'process' ? {kind: 'process'} : {kind: 'other', name};
    addRelation(blockOf[index], name, relation, index, index + 1);
  });
  /** The relation `qualifier` names from `block`: its own FROM list first, then the enclosing ones. */
  const resolveQualifier = (qualifier: string, block: number): Relation | undefined => {
    for (const at of chain(block, relationParentOf)) {
      const entry = relationsOf.get(at)?.find(item => item.alias === qualifier || (!item.alias && item.name === qualifier));
      if (entry) return entry.relation;
    }
    return undefined;
  };

  // Columns that hold a process name: the fixed names; `name` of the process
  // table; and the output columns of a CTE or derived table that carry one,
  // read through the relation that names it, to a fixed point.
  const outputsOf = new Map<string, Outputs>();
  /** Each branch's own select aliases, and whether each carries a process name. */
  const ownAliases = new Map<number, Map<string, boolean>>();
  const exposes = (key: string, column: string) =>
    Boolean(outputsOf.get(key)?.columns.some(output => output.holds && output.name === column));
  const holdsThrough = (relation: Relation | undefined, column: string) => relation !== undefined
    && (relation.kind === 'process' ? column === 'name' : relation.kind === 'source' && exposes(relation.key, column));
  /**
   * Whether `relation` has a column named `column`. A table answers from its
   * documented schema; a CTE or derived table whose outputs are all listed
   * answers exactly, one with an undocumented `*` may have more. An
   * undocumented table may have any column.
   */
  const tableSchema = (relation: TableRelation) => perfettoRelationColumns(relation.kind === 'process' ? 'process' : relation.name);
  const hasColumn = (relation: Relation, column: string): 'yes' | 'no' | 'maybe' => {
    if (relation.kind !== 'source') {
      const schema = tableSchema(relation);
      return schema === undefined ? 'maybe' : schema.has(column) ? 'yes' : 'no';
    }
    const outputs = outputsOf.get(relation.key);
    if (outputs?.columns.some(output => output.name === column)) return 'yes';
    return outputs?.complete ? 'no' : 'maybe';
  };
  /**
   * A table's columns known here, and whether each carries a process name:
   * the documented ones, or for an undocumented table none (the process table
   * still has its name), which leaves its column set incomplete.
   */
  const tableColumns = (relation: TableRelation): {columns: OutputColumn[]; documented: boolean} => {
    const process = relation.kind === 'process';
    const schema = tableSchema(relation);
    if (!schema) return {columns: process ? [{name: 'name', holds: true}] : [], documented: false};
    return {columns: [...schema].map(name => ({name, holds: PROCESS_NAME_COLUMNS.has(name) || (process && name === 'name')})), documented: true};
  };
  /**
   * The columns of `relation` that carry or may carry a process name. An
   * undocumented table, or any table when the SQL docs are missing, may have
   * every fixed process-name column, so a join on it fails closed.
   */
  const carriedColumns = (relation: Relation): string[] => {
    const outputs = relation.kind === 'source' ? outputsOf.get(relation.key) : undefined;
    const table = relation.kind === 'source' ? undefined : tableColumns(relation);
    const columns = outputs?.columns ?? table?.columns ?? [];
    const carried = columns.flatMap(output => output.holds && output.name ? [output.name] : []);
    // A column set not known in full (an undocumented table, or a `*` over one) may hold any of them.
    return (table ? table.documented : outputs?.complete) ? carried : [...new Set([...carried, ...PROCESS_NAME_COLUMNS])];
  };
  /**
   * A bare column binds as SQLite binds it: to a relation of its own block
   * that has it, else to the block's own select alias, else to an enclosing
   * block (a correlated reference). Where a table's columns are not known the
   * column may bind there or further out, and both are counted.
   */
  const bareHolds = (column: string, block: number): boolean => {
    for (const at of chain(block, relationParentOf)) {
      const relations = (relationsOf.get(at) ?? []).map(entry => entry.relation);
      const alias = ownAliases.get(at)?.get(column);
      const has = relations.map(relation => hasColumn(relation, column));
      const holdsHere = relations.some(relation => holdsThrough(relation, column));
      if (has.includes('yes')) return holdsHere;
      if (has.includes('maybe')) {
        if (holdsHere || alias) return true;
        continue; // it may bind further out: keep looking
      }
      if (alias !== undefined) return alias;
    }
    return false;
  };
  const holdsProcessName = (index: number): boolean => {
    const token = tokens[index];
    if (!isNameToken(token)) return false;
    const column = unqualifiedName(token);
    if (PROCESS_NAME_COLUMNS.has(column)) return true;
    const qualifier = nameQualifier(token);
    const block = blockOf[index];
    return qualifier ? holdsThrough(resolveQualifier(qualifier, block), column) : bareHolds(column, block);
  };
  /**
   * Whether an expression's value can be a process name. A subquery in it
   * carries what its output columns carry, not every name it reads, and a
   * count or length of a name is not a name.
   */
  const spanHolds = (span: [number, number] | undefined) => {
    if (span === undefined) return false;
    for (let at = span[0]; at <= span[1]; at++) {
      if (tokens[at].kind === 'word' && NON_NAME_VALUE_FUNCTIONS.has(tokens[at].text) && punct(at + 1, '(')) {
        at = closingParen(tokens, at + 1);
      } else if (punct(at, '(') && tokens[at + 1]?.kind === 'word' && QUERY_START.has(tokens[at + 1].text)) {
        if (outputsOf.get(`block:${blockOf[at + 1]}`)?.columns.some(column => column.holds)) return true;
        at = closingParen(tokens, at);
      } else if (holdsProcessName(at)) {
        return true;
      }
    }
    return false;
  };
  /**
   * Whether the join of the relation before `index` (a `USING` or the
   * relation after `NATURAL ... JOIN`) compares a process name: `USING`
   * compares the listed columns, `NATURAL` every column both sides have, so it
   * counts when one side carries a process name the other side has or may have.
   */
  const joinHolds = (index: number): boolean => {
    // A join inside `( ... )` joins only the relations of that group.
    let groupOpen = -1;
    for (const [open, close] of relationGroups) if (open < index && close > index && open > groupOpen) groupOpen = open;
    const entries = (relationsOf.get(blockOf[index]) ?? []).filter(entry => entry.at > groupOpen);
    if (word(index, 'USING')) {
      const before = entries.filter(entry => entry.at < index).map(entry => entry.relation);
      const open = index + 1;
      if (!punct(open, '(')) return false;
      const listed: string[] = [];
      for (let at = open + 1; at < closingParen(tokens, open); at++) if (isNameToken(tokens[at])) listed.push(unqualifiedName(tokens[at]));
      return listed.some(column => PROCESS_NAME_COLUMNS.has(column) || before.some(relation => holdsThrough(relation, column)));
    }
    const rightAt = entries.findIndex(entry => entry.at > index);
    if (rightAt <= 0) return false;
    const right = entries[rightAt].relation;
    const left = entries.slice(0, rightAt).map(entry => entry.relation);
    const shared = (from: Relation, to: Relation) => carriedColumns(from).some(column => hasColumn(to, column) !== 'no');
    return left.some(relation => shared(relation, right) || shared(right, relation));
  };

  // The first SELECT or VALUES of each block, found once: select lists do not change across rounds.
  const firstSelect = new Map<number, number>();
  const firstValues = new Map<number, number>();
  tokens.forEach((token, index) => {
    if (token.kind !== 'word' || firstSelect.has(blockOf[index]) || firstValues.has(blockOf[index])) return;
    if (token.text === 'SELECT') firstSelect.set(blockOf[index], index);
    else if (token.text === 'VALUES') firstValues.set(blockOf[index], index);
  });
  /** The rows of a VALUES branch, each as the token spans of its expressions. */
  const valuesRows = (block: number): Array<Array<[number, number]>> => {
    const rows: Array<Array<[number, number]>> = [];
    for (let open = firstValues.get(block)! + 1; punct(open, '('); open = closingParen(tokens, open) + 2) {
      const close = closingParen(tokens, open);
      const row: Array<[number, number]> = [];
      let start = open + 1;
      for (let at = start, depth = 0; at <= close; at++) {
        if (punct(at, '(')) depth++;
        else if (punct(at, ')') && at < close) depth--;
        if ((depth === 0 && punct(at, ',')) || at === close) { row.push([start, at - 1]); start = at + 1; }
      }
      rows.push(row);
      if (!punct(close + 1, ',')) break;
    }
    return rows;
  };
  const itemsByBlock = new Map<number, Array<[number, number]>>();
  /** The items of `block`'s select list, as token spans. */
  const selectItems = (block: number): Array<[number, number]> => {
    const cached = itemsByBlock.get(block);
    if (cached) return cached;
    const items = scanSelectItems(block);
    itemsByBlock.set(block, items);
    return items;
  };
  const scanSelectItems = (block: number): Array<[number, number]> => {
    let at = firstSelect.get(block) ?? -1;
    if (at < 0) return [];
    at++;
    if (word(at, 'DISTINCT') || word(at, 'ALL')) at++;
    const items: Array<[number, number]> = [];
    let itemStart = at;
    for (let depth = 0; at < tokens.length; at++) {
      if (punct(at, '(')) depth++;
      else if (punct(at, ')') && depth-- === 0) break;
      if (depth > 0) continue;
      if (punct(at, ',')) { items.push([itemStart, at - 1]); itemStart = at + 1; } else if (FROM_LIST_END.has(tokens[at]?.text ?? '') || word(at, 'FROM')) break;
    }
    if (itemStart < at) items.push([itemStart, at - 1]);
    return items;
  };
  /** A branch's output columns: each item's output name, and whether its expression (not its alias) carries a process name. */
  const branchOutputs = (block: number): Outputs => {
    if (!firstSelect.has(block) && firstValues.has(block)) {
      // VALUES names its columns column1, column2, ...; each carries what any row puts there.
      const rows = valuesRows(block);
      return {
        columns: (rows[0] ?? []).map((_, position) => ({
          name: `column${position + 1}`,
          holds: rows.some(row => spanHolds(row[position])),
        })),
        exact: true,
        complete: true,
      };
    }
    const columns: OutputColumn[] = [];
    let exact = true;
    let complete = true;
    for (const [start, end] of selectItems(block)) {
      if (punct(end, '*') && (end === start || (end === start + 1 && tokens[start].text.endsWith('.')))) {
        const qualifier = end > start ? tokens[start].text.toLowerCase().replace(/\.$/, '') : undefined;
        const relations = qualifier === undefined
          ? (relationsOf.get(block) ?? []).map(entry => entry.relation)
          : [resolveQualifier(qualifier, block)];
        // USING and NATURAL list a joined column once: positions after it are not the concatenation.
        if (qualifier === undefined && mergesJoinColumns.has(block)) exact = false;
        for (const relation of relations) {
          if (relation?.kind === 'source' && outputsOf.get(relation.key)?.exact !== false) {
            // An exact source; one not yet read this round has unknown columns.
            columns.push(...(outputsOf.get(relation.key)?.columns ?? []));
            complete &&= outputsOf.get(relation.key)?.complete ?? false;
          } else {
            // A table or an inexact source: its columns' positions are not known here,
            // but a table's documented columns are, and which of them carry a name.
            exact = false;
            if (relation?.kind === 'source') {
              columns.push(...outputsOf.get(relation.key)!.columns);
              complete &&= outputsOf.get(relation.key)!.complete;
            } else if (relation) {
              const table = tableColumns(relation);
              columns.push(...table.columns);
              complete &&= table.documented;
            } else {
              complete = false; // an unresolved qualifier
            }
          }
        }
        continue;
      }
      // `expression COLLATE x` keeps the expression's name.
      const valueEnd = end - start >= 2 && word(end - 1, 'COLLATE') ? end - 2 : end;
      const last = tokens[valueEnd];
      let name: string | undefined;
      let expression: [number, number] = [start, end];
      if (valueEnd - start >= 2 && word(valueEnd - 1, 'AS') && isNameToken(last)) {
        name = unqualifiedName(last);
        expression = [start, valueEnd - 2];
      } else if (valueEnd > start && isNameToken(last) && !last.text.includes('.') && !word(valueEnd - 1, 'COLLATE')
        && (isNameToken(tokens[valueEnd - 1]) || tokens[valueEnd - 1].kind === 'string' || punct(valueEnd - 1, ')'))) {
        name = unqualifiedName(last); // `expression alias`
        expression = [start, valueEnd - 1];
      } else {
        // A bare column keeps its name, and parentheses (`(name)`, `((name))`) leave it as it was.
        let inner = start;
        let innerEnd = valueEnd;
        while (punct(inner, '(') && closingParen(tokens, inner) === innerEnd) { inner++; innerEnd--; }
        if (inner === innerEnd && isNameToken(tokens[inner])) name = unqualifiedName(tokens[inner]);
      }
      columns.push({name, holds: spanHolds(expression)});
    }
    return {columns, exact, complete};
  };
  /** A query's outputs: its branches merged by position, renamed by a CTE column list. */
  const queryOutputs = (head: number, renamed?: string[]): Outputs => {
    const branches = (branchesOf.get(head) ?? [head]).map(branch => roundOutputs.get(branch) ?? branchOutputs(branch));
    const exact = branches.every(branch => branch.exact) && branches.every(branch => branch.columns.length === branches[0].columns.length);
    const anyHold = branches.some(branch => branch.columns.some(column => column.holds));
    // SQLite renames a repeated output name: the second `name` is `name:1`.
    const seen = new Map<string, number>();
    const columns = branches[0].columns.map((column, position) => {
      let name = column.name;
      if (name !== undefined) {
        const count = seen.get(name) ?? 0;
        seen.set(name, count + 1);
        if (count > 0) name = `${name}:${count}`;
      }
      // One branch names its own columns; merged branches line up only by exact position.
      const holds = branches.length === 1 ? column.holds : exact ? branches.some(branch => branch.columns[position]?.holds) : anyHold;
      return {name, holds};
    });
    // The first branch names the columns.
    if (!renamed) return {columns, exact, complete: branches[0].complete};
    // A column list renames by position and names every column; past an unknown position every listed column may carry it.
    return {columns: renamed.map((name, position) => ({name, holds: exact ? Boolean(columns[position]?.holds) : anyHold})), exact, complete: true};
  };
  /** Each branch's outputs in the current round, computed once per round. */
  const roundOutputs = new Map<number, Outputs>();
  const heads = [...branchesOf.keys()];
  const ctes = [...ctesByBlock.values()].flatMap(defined => [...defined.values()]);
  const snapshot = () => JSON.stringify([...outputsOf, ...[...ownAliases].map(([block, set]) => [block, [...set]])]);
  // Every round adds at least one carrying column or stops; past that bound the
  // reading is not trusted and the statement counts as a filter (fail closed).
  const roundLimit = 2 + tokens.length;
  let settled = false;
  for (let round = 0, before = ''; round < roundLimit; round++) {
    roundOutputs.clear();
    for (const head of heads) {
      for (const branch of branchesOf.get(head)!) {
        const outputs = branchOutputs(branch);
        roundOutputs.set(branch, outputs);
        ownAliases.set(branch, new Map(outputs.columns.filter(column => column.name).map(column => [column.name!, column.holds])));
      }
      outputsOf.set(`block:${head}`, queryOutputs(head));
    }
    for (const cte of ctes) outputsOf.set(cte.key, queryOutputs(headOf[cte.bodyBlock], cte.columns));
    const after = snapshot();
    if (after === before) { settled = true; break; }
    before = after;
  }
  if (!settled) return true;

  return tokens.some((token, index) => {
    if (token.kind === 'word' && (token.text === 'USING' || token.text === 'NATURAL')) return joinHolds(index);
    // Simple CASE: `CASE <process name> WHEN ...`.
    if (token.kind === 'word' && token.text === 'CASE') return spanHolds(operandStartingAt(tokens, index + 1));
    // glob('com.*', p.name), like(...), regexp(...) in their function form.
    if (token.kind === 'word' && (token.text === 'GLOB' || token.text === 'LIKE' || token.text === 'REGEXP')
      && punct(index + 1, '(') && (index === 0 || tokens[index - 1].kind === 'punct'
        || (tokens[index - 1].kind === 'word' && EXPRESSION_WORDS.has(tokens[index - 1].text)))) {
      return spanHolds([index + 1, closingParen(tokens, index + 1)]);
    }
    const isOperator = (token.kind === 'punct' && COMPARISON_PUNCT.has(token.text))
      || (token.kind === 'word' && COMPARISON_WORDS.has(token.text));
    if (!isOperator) return false;
    const left = operandEndingAt(tokens, word(index - 1, 'NOT') ? index - 2 : index - 1);
    let rightAt = index + 1;
    if (word(rightAt, 'NOT')) rightAt++;
    // A comparison with NULL selects no named process.
    if (word(rightAt, 'NULL') || (word(index - 1, 'NULL') && !word(index - 2, 'IS'))) return false;
    return spanHolds(left) || spanHolds(operandStartingAt(tokens, rightAt));
  });
}

const verdictBySql = new Map<string, boolean>();
const VERDICT_CACHE_LIMIT = 2048;

/**
 * Whether the statement `sql` scopes its rows to a named process by comparing
 * a process-name column. Skill statements (step SQL with its fragments) are a
 * fixed set and are judged several times per invocation, so the verdict is
 * kept by text; the tokens are not, since fragment text repeats across them.
 */
export function sqlUsesProcessNameFilter(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  let verdict = verdictBySql.get(sql);
  if (verdict === undefined) {
    if (verdictBySql.size >= VERDICT_CACHE_LIMIT) verdictBySql.clear();
    verdict = processNameFilter(structuralSqlTokens(sql, {cache: false}));
    verdictBySql.set(sql, verdict);
  }
  return verdict;
}

/**
 * Resolves a declared `fragments/<file>.sql` to its text. Self-Evolution copies
 * base fragments unchanged, so the built-in file is what every registry holds;
 * an unknown fragment contributes nothing.
 */
type SkillFragmentResolver = (fragmentPath: string) => string | undefined;

/**
 * A fragment declared label-only classifies processes for display. Its own
 * name comparisons are not a filter, and neither is filtering by what it
 * outputs: its columns are labels by contract, so it must never output a
 * process name under another name.
 */
const LABEL_ONLY_FRAGMENT = /^\s*--\s*process-identity:\s*label-only\b/m;

/**
 * One executable statement: a SQL text with its fragments injected into its
 * WITH clause, as the executor runs it, so the fragments' CTEs are in scope
 * for every branch of the statement.
 */
function sqlUnit(source: any, resolveFragment: SkillFragmentResolver): string | undefined {
  if (!source || typeof source !== 'object' || typeof source.sql !== 'string') return undefined;
  const fragments: string[] = [];
  for (const fragmentPath of Array.isArray(source.sql_fragments) ? source.sql_fragments : []) {
    const text = typeof fragmentPath === 'string' ? resolveFragment(fragmentPath) : undefined;
    // A fragment that only labels processes (declared in its header) does not
    // select target evidence, so its name comparisons are not a process filter.
    if (text && !LABEL_ONLY_FRAGMENT.test(text)) fragments.push(text);
  }
  return injectFragmentCtes(source.sql, fragments);
}

/**
 * Every statement a Skill can execute, each with the fragments injected into
 * it. Detection runs per statement: a process table read in one step and a
 * bare `name =` in another are not a process-name filter.
 */
export function collectSkillSqlUnits(
  skill: SkillDefinition,
  resolveFragment: SkillFragmentResolver = builtInFragmentText,
): string[] {
  return executableSqlUnits(skill).flatMap(unit => sqlUnit(unit.source, resolveFragment) ?? []);
}

export function skillUsesProcessNameFilter(
  skill: SkillDefinition,
  resolveFragment: SkillFragmentResolver = builtInFragmentText,
): boolean {
  return collectSkillSqlUnits(skill, resolveFragment).some(sqlUsesProcessNameFilter);
}

export function getEffectiveIdentityConfig(skill: SkillDefinition): SkillIdentityConfig {
  if (skill.name === 'process_identity_resolver') {
    return { policy: 'exempt', scope: 'process' };
  }

  const explicit = skill.identity;
  if (explicit?.policy) {
    return {
      scope: 'process',
      aliases: DEFAULT_PROCESS_IDENTITY_ALIASES,
      rewriteTo: 'recommended_process_name_param',
      minConfidence: 50,
      ...explicit,
    };
  }

  if (skillUsesProcessNameFilter(skill)) {
    return {
      policy: 'verify_if_present',
      scope: 'process',
      aliases: DEFAULT_PROCESS_IDENTITY_ALIASES,
      rewriteTo: 'recommended_process_name_param',
      minConfidence: 50,
    };
  }

  return { policy: 'none' };
}

/** Selectors require either a declared input or an actual process-gate consumer. */
export function getConsumableProcessIdentitySelectors(skill: SkillDefinition): Set<string> {
  const declared = new Set(skill.inputs?.map(input => input.name) || []);
  const allowed = new Set(PROCESS_IDENTITY_SELECTORS.filter(key => declared.has(key)));
  const config = getEffectiveIdentityConfig(skill);
  const targetBinding = skill.process_scope?.role === 'target' && Boolean(skill.process_scope.binding);
  const hasProcessGate = config.scope === 'process' &&
    (config.policy === 'required' || config.policy === 'verify_if_present') &&
    (!skill.process_scope || skill.process_scope.role === 'target');
  if (hasProcessGate) {
    for (const key of processSelectorKeys(config)) allowed.add(key);
  } else if (targetBinding) {
    allowed.add('upid');
    allowed.add('pid');
  }
  // Resolving a thread's process does not make the Skill's SQL thread-scoped.
  for (const key of ['thread_name', 'threadName']) if (!declared.has(key)) allowed.delete(key);
  return allowed;
}

/** The parameters that select a Skill's process: every name alias it reads, upid and pid. */
export function processSelectorKeys(config: SkillIdentityConfig): string[] {
  return [...new Set([...DEFAULT_PROCESS_IDENTITY_ALIASES, ...(config.aliases || []), 'upid', 'pid'])];
}

function firstValue(source: Record<string, any>, keys: string[]): any {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function coerceInteger(value: any): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

export function extractProcessIdentityTarget(
  params: Record<string, any>,
  inherited: Record<string, any>,
  config: SkillIdentityConfig,
): ProcessIdentityTarget {
  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  const hasExplicitSelector = firstValue(params, processSelectorKeys(config)) !== undefined;
  const requestedName = firstValue(params, [...aliases, ...DEFAULT_PROCESS_IDENTITY_ALIASES]) ??
    (hasExplicitSelector ? undefined : firstValue(inherited, aliases));
  const threadName = firstValue(params, ['thread_name', 'threadName']) ?? firstValue(inherited, ['thread_name', 'threadName']);
  const upid = coerceInteger(firstValue(params, ['upid']) ?? (hasExplicitSelector ? undefined : firstValue(inherited, ['upid'])));
  const pid = coerceInteger(firstValue(params, ['pid']) ?? (hasExplicitSelector ? undefined : firstValue(inherited, ['pid'])));
  const startTs = firstValue(params, ['start_ts', 'startTs']) ?? firstValue(inherited, ['start_ts', 'startTs']);
  const endTs = firstValue(params, ['end_ts', 'endTs']) ?? firstValue(inherited, ['end_ts', 'endTs']);

  return {
    ...(requestedName !== undefined ? { requestedName: String(requestedName).trim() } : {}),
    ...(threadName !== undefined ? { threadName: String(threadName).trim() } : {}),
    ...(upid !== undefined ? { upid } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(startTs !== undefined ? { startTs } : {}),
    ...(endTs !== undefined ? { endTs } : {}),
  };
}

function hasTarget(target: ProcessIdentityTarget): boolean {
  return Boolean(target.requestedName || target.threadName || target.upid !== undefined || target.pid !== undefined);
}

function isVerified(resolution: ProcessIdentityResolution, config: SkillIdentityConfig): boolean {
  if (resolution.status !== 'verified') return false;
  const minConfidence = config.minConfidence ?? 50;
  return resolution.confidenceScore >= minConfidence;
}

function rewriteParams(
  params: Record<string, any>,
  skill: SkillDefinition,
  target: ProcessIdentityTarget,
  resolution: ProcessIdentityResolution,
  config: SkillIdentityConfig,
): Record<string, any> {
  const rewritten = { ...params };
  if (!isVerified(resolution, config)) return rewritten;

  const declaredInputs = new Set((skill.inputs || []).map(input => input.name));
  const hasInputDeclarations = Array.isArray(skill.inputs) && skill.inputs.length > 0;

  if (config.rewriteTo === 'upid' && resolution.upids.length === 1 && target.upid === undefined) {
    rewritten.upid = resolution.upids[0];
    return rewritten;
  }

  const recommended = resolution.recommendedProcessNameParam;
  if (!recommended && target.upid === undefined) return rewritten;

  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  for (const alias of aliases) {
    if (rewritten[alias] !== undefined && rewritten[alias] !== null && String(rewritten[alias]).trim() !== '') {
      rewritten[alias] = recommended;
    }
  }

  if (target.requestedName || target.upid !== undefined) {
    // Keep legacy YAML skills safe: most process filters read either package or
    // process_name regardless of which alias the caller originally supplied.
    if (hasInputDeclarations) {
      for (const alias of aliases) {
        if (declaredInputs.has(alias) && rewritten[alias] === undefined) {
          rewritten[alias] = recommended || '';
        }
      }
    }
    if (rewritten.package !== undefined || declaredInputs.has('package') || !hasInputDeclarations) {
      rewritten.package = recommended || '';
    }
    if (rewritten.process_name !== undefined || declaredInputs.has('process_name') || !hasInputDeclarations) {
      rewritten.process_name = recommended || '';
    }
    if (hasInputDeclarations) {
      for (const alias of aliases) {
        if (!declaredInputs.has(alias)) {
          delete rewritten[alias];
        }
      }
    }
  }

  // UPID/PID may select a unique process for the identity gate without being
  // part of the target Skill's public input contract. Consume those selectors
  // before validating or substituting Skill parameters.
  if (!declaredInputs.has('upid')) delete rewritten.upid;
  if (!declaredInputs.has('pid')) delete rewritten.pid;

  return rewritten;
}

export class IdentityGate {
  async apply(input: IdentityGateInput): Promise<IdentityGateResult> {
    const inherited = input.inherited || {};
    const config = getEffectiveIdentityConfig(input.skill);
    const traceSide = input.traceSide || 'current';
    const parentScope = input.processScope;
    const blocked = (error: string): IdentityGateResult => ({
      allowed: false, params: input.params, inherited, config, error,
    });
    const consumableSelectors = getConsumableProcessIdentitySelectors(input.skill);
    const unusedThreadSelectors = ['thread_name', 'threadName'].filter(key =>
      firstValue(input.params, [key]) !== undefined && !consumableSelectors.has(key));
    if (unusedThreadSelectors.length && input.skill.name !== 'process_identity_resolver') {
      return blocked(`Skill does not declare a thread filter input: ${unusedThreadSelectors.join(', ')}`);
    }
    if (parentScope) {
      try { assertEffectiveProcessScope(parentScope, input.traceId, traceSide); }
      catch (error) { return blocked((error as Error).message); }
    }
    for (const key of ['upid', 'pid']) {
      const value = firstValue(input.params, [key]);
      // Zero is the legacy SQL fallback for an omitted selector. An explicitly
      // supplied zero must not enter that fallback and widen the target.
      if (value !== undefined && coerceInteger(value) === undefined) {
        return blocked(`Invalid explicit ${key}: expected a positive safe integer`);
      }
    }

    // Resolver queries inspect identity metadata; they do not select target evidence.
    if (input.skill.name === 'process_identity_resolver') {
      return { allowed: true, params: input.params, inherited, config,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide) };
    }

    let target = extractProcessIdentityTarget(input.params, inherited, config);
    if (parentScope?.mode === 'exact_upid') {
      if (target.upid !== undefined && target.upid !== parentScope.upid) {
        return blocked('Child Skill cannot change the inherited exact UPID');
      }
      target.upid = parentScope.upid;
    }
    if (target.upid === undefined && target.pid === undefined && (config.policy === 'none' || config.policy === 'exempt')) {
      return { allowed: true, params: input.params, inherited, config,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide, target) };
    }
    if (!hasTarget(target)) {
      if (config.policy === 'required') {
        return {
          allowed: false,
          params: input.params,
          inherited,
          config,
          target,
          error: `Process identity is required before running skill "${input.skill.name}", but no package/process/upid target was provided.`,
        };
      }
      return { allowed: true, params: input.params, inherited, config, target,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide) };
    }

    const storedIdentity = parentScope ? verifiedIdentityForScope(parentScope) : undefined;
    const prepared = storedIdentity?.resolution.status === 'verified' && !storedIdentity.resolution.resolverError
      ? storedIdentity : undefined;
    const newThreadTarget = target.threadName && target.threadName !== prepared?.target.threadName;
    const sameNamedTarget = parentScope?.mode === 'named' && prepared && target.upid === undefined &&
      target.pid === undefined &&
      (!target.requestedName || [prepared.target.requestedName, prepared.resolution.canonicalPackageName,
        prepared.resolution.recommendedProcessNameParam].includes(target.requestedName));
    // Identity belongs to this trace instance, independently of the requested
    // analysis interval. Recheck selectors below; do not re-query on enrichment.
    let resolution = (parentScope?.mode === 'exact_upid' || sameNamedTarget) && prepared && !newThreadTarget
      ? prepared.resolution : await input.resolve(target);
    const explicitSelectors = [...new Set([...DEFAULT_PROCESS_IDENTITY_ALIASES, ...(config.aliases || [])])]
      .map(key => ({ key, value: firstValue(input.params, [key]) })).filter(item => item.value !== undefined);
    const explicitNames = explicitSelectors.map(item => String(item.value).trim());
    const conflict = (error: string): IdentityGateResult => ({
      ...blocked(error), target,
      resolution: { ...resolution, status: 'ambiguous', upids: [], warnings: [...resolution.warnings, error] },
    });
    if (target.pid !== undefined && target.upid === undefined) {
      const selected = resolution.candidates.filter(candidate => candidate.pid === target.pid &&
        candidate.upid !== undefined && resolution.upids.includes(candidate.upid));
      if (resolution.status !== 'verified' || resolution.upids.length !== 1 ||
          !selected.some(candidate => candidate.upid === resolution.upids[0])) {
        return conflict('Explicit PID must resolve to one verified UPID; select the intended UPID when the PID was reused');
      }
      target = {...target, upid: resolution.upids[0]};
    }
    if (target.upid !== undefined) {
      const selected = resolution.candidates.filter(candidate => candidate.upid === target.upid);
      if (resolution.status !== 'verified' || resolution.upids.length !== 1 || resolution.upids[0] !== target.upid) {
        return conflict('Explicit UPID could not be verified; no other process may replace it');
      }
      const names = new Set([
        ...selected.flatMap(candidate => [candidate.processName, candidate.metadataProcessName,
          candidate.packageName, candidate.canonicalPackageName, candidate.cmdline, candidate.recommendedProcessNameParam]),
        resolution.canonicalPackageName, resolution.recommendedProcessNameParam,
      ].filter(Boolean));
      const processNames = new Set(selected.flatMap(candidate => [candidate.processName,
        candidate.metadataProcessName, candidate.cmdline, candidate.recommendedProcessNameParam]));
      if (selected.length === 0) processNames.add(resolution.recommendedProcessNameParam);
      if (explicitSelectors.some(({ key, value }) =>
          !(key === 'process_name' || key === 'processName' ? processNames : names).has(String(value).trim())) ||
          (target.pid !== undefined && !selected.some(candidate => candidate.pid === target.pid))) {
        return conflict('Explicit process name/PID conflicts with the selected UPID');
      }
      resolution = { ...resolution, upids: [target.upid], candidates: selected };
      if (parentScope?.mode === 'named' && parentScope.requestedName) {
        const boundary = parentScope.requestedName;
        const belongs = selected.some(candidate => [candidate.processName, candidate.metadataProcessName,
          candidate.packageName, candidate.canonicalPackageName, candidate.cmdline]
          .some(name => name === boundary || name?.startsWith(`${boundary}:`)));
        if (!belongs) return conflict('Resolved UPID is outside the inherited named process scope');
      }
    } else if (new Set(explicitNames).size > 1) {
      const knownNames = new Set([resolution.canonicalPackageName, resolution.recommendedProcessNameParam,
        ...resolution.candidates.filter(candidate => candidate.upid !== undefined && resolution.upids.includes(candidate.upid))
          .flatMap(candidate => [candidate.processName, candidate.packageName,
          candidate.metadataProcessName, candidate.canonicalPackageName, candidate.cmdline])]);
      if (explicitNames.some(name => !knownNames.has(name))) {
        return conflict('Explicit process selector aliases conflict');
      }
    }
    const verified = isVerified(resolution, config);

    if (!verified) {
      const base = `Process identity could not be verified for skill "${input.skill.name}"`;
      const reason = resolution.resolverError
        ? `${base}: resolver failed (${resolution.resolverError})`
        : `${base}: status=${resolution.status}, confidence=${resolution.confidenceScore}`;

      // Keep current broad overview flows resilient when the resolver itself is unavailable.
      if (target.upid === undefined && config.policy === 'verify_if_present' && resolution.status === 'unresolved' && resolution.resolverError) {
        return {
          allowed: true,
          params: input.params,
          inherited: {
            ...inherited,
            identity_resolution: resolution,
            identity_gate_warning: reason,
          },
          config,
          target,
          resolution,
          processScope: createEffectiveProcessScope(input.traceId, traceSide, target, resolution),
        };
      }

      return {
        allowed: false,
        params: input.params,
        inherited,
        config,
        target,
        resolution,
        error: reason,
      };
    }

    const params = rewriteParams(input.params, input.skill, target, resolution, config);
    if (target.upid !== undefined && input.skill.inputs?.some(item => item.name === 'upid')) params.upid = target.upid;
    if (target.pid !== undefined && input.skill.inputs?.some(item => item.name === 'pid')) params.pid = target.pid;
    return {
      allowed: true,
      params,
      inherited: {
        ...inherited,
        identity_resolution: resolution,
      },
      config,
      target,
      resolution,
      processScope: parentScope?.mode === 'exact_upid' || sameNamedTarget ? parentScope :
        createEffectiveProcessScope(input.traceId, traceSide, target, resolution),
    };
  }
}
