// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {jest} from '@jest/globals';
import {createSkillExecutor} from '../../src/services/skillEngine/skillExecutor';
import type {DiagnosticResult, SkillDefinition} from '../../src/services/skillEngine/types';

export type Rows = Record<string, unknown>[];
export type Table = {columns: string[]; rows: unknown[][]};

/** Rows as the trace processor returns them: one column list, positional values. */
export function rowsTable(rows: Rows): Table {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {columns, rows: rows.map(row => columns.map(column => row[column]))};
}

/** A fresh plain copy per run: the executor must never see state from a previous one. */
export const fresh = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Every step of a Skill, including nested steps and inline conditional branches. */
export function allStepsOf(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const branches = [...(node.conditions ?? []).map((c: any) => c?.then), node.else]
    .filter(branch => branch && typeof branch === 'object');
  return [...(node.id ? [node] : []),
    ...[...(node.steps ?? []), ...branches].flatMap(allStepsOf)];
}

/** The step `id` of a parsed Skill, at any depth, or a thrown error naming it. */
export function stepOf(skill: any, id: string): any {
  const step = allStepsOf(skill).find(candidate => candidate.id === id);
  if (!step) throw new Error(`step ${id} not found`);
  return step;
}

let documents: Array<{file: string; skill: any}> | undefined;
/**
 * Every parsed Skill under backend/skills, by path relative to it. Authoring
 * templates hold placeholders, not runnable Skills, and a comment-only file
 * (pipelines/_base) parses to no Skill.
 */
export function skillDocuments(): Array<{file: string; skill: any}> {
  if (documents) return documents;
  const root = path.resolve(__dirname, '../../skills');
  const found: Array<{file: string; skill: any}> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '_template') walk(full); }
      else if (entry.name.endsWith('.skill.yaml')) {
        const [skill] = yaml.loadAll(fs.readFileSync(full, 'utf8')) as any[];
        if (skill && typeof skill === 'object') found.push({file: path.relative(root, full), skill});
      }
    }
  };
  walk(root);
  documents = found;
  return found;
}

/**
 * Runs one diagnostic step through the Skill executor, each input bound under
 * its `save_as` name to the given rows by a stub step.
 */
export async function diagnoseRuleStep(
  ruleStep: unknown,
  inputs: Record<string, Rows>,
  params: Record<string, unknown> = {},
): Promise<DiagnosticResult[]> {
  const names = Object.keys(inputs);
  const query = jest.fn(async (_traceId: string, sql: string) => {
    const name = /SELECT '(\w+)' AS stub_input/.exec(sql)?.[1];
    return rowsTable(name ? inputs[name] : []);
  });
  const executor = createSkillExecutor(
    {query, touchTrace: jest.fn(), getTraceWithPort: jest.fn(async () => ({port: 1}))} as any);
  executor.registerSkill({
    name: 'rule_under_test', type: 'composite', version: '1',
    meta: {display_name: 'under test', description: 'under test'},
    steps: [
      ...names.map(name => ({id: `stub_${name}`, type: 'atomic', sql: `SELECT '${name}' AS stub_input`, save_as: name})),
      fresh(ruleStep),
    ],
  } as SkillDefinition);
  return (await executor.execute('rule_under_test', 'trace-1', params)).diagnostics;
}
