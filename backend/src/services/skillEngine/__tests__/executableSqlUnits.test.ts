// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Every check that reads a Skill's SQL reads the same units, from one walk
 * (processScopeSql.executableSqlUnits) that follows what the executor runs
 * (skillSteps.skillExecution): an atomic Skill's root SQL, or else every
 * atomic step at any depth (nested steps, inline conditional branches, a step
 * without an id) with its exact_sql. A check that walked on its own could miss
 * SQL another check sees; SQL the executor never runs is rejected instead.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { SkillDefinition } from '../types';
import { executableSqlUnits, getExactProcessScopeSupport } from '../processScopeSql';
import { validateFragmentReferences, validateNormalizedStdlibReads, validateProcessScopeDeclarations, validateSkillConditions } from '../skillValidator';
import { stepNodesOf, stepSkillReferences } from '../skillSteps';
import { skillCatalogEntry } from '../../skillLocalizationCatalog';
import { undecidedResultPathReads } from '../resultPathReads';
import { causeWordingReaders, unsupportedCauseWording } from '../causeWordingEvidence';
import { collectSkillSqlUnits } from '../../processIdentity/identityGate';
import { validateSkillDefinitionsInProcess } from '../../selfEvolution/inProcessValidator';
import { detectStdlibModulesUsedBySkill } from '../../stdlibSkillCoverage';
import yaml from 'js-yaml';

// The validate command module builds its CLI on load; only its file check is read here.
jest.mock('commander', () => ({
  Command: class {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    action() { return this; }
  },
}));

import { validateFile } from '../../../cli/commands/validate';

const scope = { role: 'target', binding: 'native_upid' };
/**
 * A SQL source every check has something to say about, marked so each check's
 * finding names the unit it read: a missing fragment, a raw stdlib read, an
 * unbound scope, heat wording.
 */
const source = (marker: string) => ({
  sql: `SELECT 'Thermal throttling detected ${marker}' AS note FROM android_input_events`,
  sql_fragments: [`fragments/missing_${marker}.sql`],
  process_scope: scope,
});
const meta = { display_name: 'units', description: 'units' };

const steps = {
  name: 'steps', version: '1', type: 'composite', meta,
  steps: [
    { id: 'top', type: 'atomic', ...source('top'), exact_sql: source('top_exact') },
    { id: 'group', type: 'parallel', steps: [{ id: 'nested', type: 'atomic', ...source('nested') }] },
    {
      id: 'choice', type: 'conditional',
      conditions: [{ when: 'true', then: { id: 'branch', type: 'atomic', ...source('branch') } }],
      else: { id: 'fallback', type: 'atomic', ...source('fallback') },
    },
    { type: 'atomic', ...source('anonymous') },
  ],
} as unknown as SkillDefinition;
const STEP_UNITS: Array<[string, string]> = [
  ['top', 'top'], ['top.exact_sql', 'top_exact'], ['nested', 'nested'], ['branch', 'branch'],
  ['fallback', 'fallback'], ['steps[3]', 'anonymous'],
];

const root = { name: 'root', version: '1', type: 'atomic', meta, ...source('root') } as unknown as SkillDefinition;

/** What every SQL check finds in `skill`, by the unit path it reports and the marker of the SQL it read. */
function findings(skill: SkillDefinition): Record<string, Array<[string, string]>> {
  const marked = (text: string) => /(?:detected |missing_)(\w+)/.exec(text)?.[1] ?? '';
  const sqlOf = new Map(executableSqlUnits(skill).map(unit => [unit.path, marked(String(unit.source.sql))]));
  return {
    fragments: validateFragmentReferences(skill, new Set()).map(warning => [warning.stepId, marked(warning.message)]),
    stdlib: validateNormalizedStdlibReads(skill, new Map()).map(warning => [warning.stepId, sqlOf.get(warning.stepId)!]),
    scope: validateProcessScopeDeclarations(skill, new Map()).map(warning => [warning.stepId, sqlOf.get(warning.stepId)!]),
    identity: collectSkillSqlUnits(skill, () => undefined).map(sql => [executableSqlUnits(skill)
      .find(unit => unit.source.sql === sql)!.path, marked(sql)]),
    // The wording guard reads each unit in the run that executes it (the heat finding; the cap one repeats it).
    wording: unsupportedCauseWording(skill, causeWordingReaders([skill]))
      .filter(site => /sql$/.test(site.field) && site.rule.wording === 'heat')
      .map(site => [`${site.stepId ?? 'root'}${site.field.startsWith('exact_sql.') ? '.exact_sql' : ''}`, marked(site.text)]),
  };
}

const SRC = path.join(process.cwd(), 'src');
/** Every production TypeScript file under `dir`. */
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === '__tests__' ? [] : sourceFiles(path.join(dir, entry.name)))
      : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []);
}
/** The property a destructuring element reads: a name, a string, or a constant computed key. */
function boundKey(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name;
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
  return ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression) ? key.expression.text : undefined;
}
/** Whether `file` reads property `key` in code: a property access, a string-keyed read or a destructuring (not comments or strings). */
function readsProperty(file: string, key: string): boolean {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(key)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    const read = ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text
        : ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) ? boundKey(node) : undefined;
    if (read === key) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true));
  return found;
}

describe('executable SQL units', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-units-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** What the CLI's file check (validate:skills --file) reports for `skill` written as YAML. */
  const validateYaml = (skill: { name: string; [key: string]: unknown }) => {
    const file = path.join(dir, `${skill.name}.skill.yaml`);
    fs.writeFileSync(file, yaml.dump(skill));
    return validateFile(file);
  };

  it('walks every atomic step at any depth, a step without an id by its position, and each exact_sql', () => {
    expect(executableSqlUnits(steps).map(unit => unit.path)).toEqual(STEP_UNITS.map(([unitPath]) => unitPath));
    expect(executableSqlUnits(root).map(unit => unit.path)).toEqual(['root']);
  });

  it('is the set every SQL check reads, unit by unit', () => {
    for (const [skill, units] of [[steps, STEP_UNITS], [root, [['root', 'root']]]] as const) {
      for (const [check, found] of Object.entries(findings(skill))) {
        expect([check, [...found].sort()]).toEqual([check, [...units].sort()]);
      }
    }
  });

  it('runs root SQL or steps, never both, and nothing of a metadata-only Skill; the validator rejects the rest', () => {
    const both = { ...root, name: 'both', steps: [{ id: 'dead', type: 'atomic', ...source('dead') }] } as unknown as SkillDefinition;
    const composite = { ...steps, name: 'composite_root', ...source('dead_root') } as unknown as SkillDefinition;
    const comparison = { ...steps, name: 'metadata', type: 'comparison' } as unknown as SkillDefinition;
    expect(executableSqlUnits(both).map(unit => unit.path)).toEqual(['root']);
    expect(executableSqlUnits(composite).map(unit => unit.path)).toEqual(STEP_UNITS.map(([unitPath]) => unitPath));
    expect(executableSqlUnits(comparison)).toEqual([]);
    // Only a known type name dispatches: not a property inherited by every object, nor a value that converts to a name.
    for (const type of ['toString', ['composite'], undefined]) {
      expect(executableSqlUnits({ ...steps, type } as unknown as SkillDefinition)).toEqual([]);
    }
    const notExecuted = (skill: SkillDefinition) => validateSkillDefinitionsInProcess({definitions: [skill]}).issues
      .filter(issue => issue.code === 'sql_not_executed').map(issue => issue.path);
    expect(notExecuted(both)).toEqual(['steps']);
    expect(notExecuted(composite)).toEqual(['sql']);
    expect(notExecuted(comparison)).toEqual(['steps']);
    expect(notExecuted(steps)).toEqual([]);
    expect(notExecuted(root)).toEqual([]);
    // A published overlay may predate the rule: a warning there, so it takes no other overlay offline.
    const published = validateSkillDefinitionsInProcess({definitions: [composite], predatingRuleSeverity: 'warning'});
    expect(published.issues.filter(issue => issue.code === 'sql_not_executed').map(issue => issue.severity)).toEqual(['warning']);
  });

  it('holds every unit it runs, exact_sql included, to the SQL guardrails', () => {
    const percentile = 'SELECT PERCENTILE(dur, 0.95) AS value FROM slice';
    const global = { role: 'global_context' };
    // The shared validator and the CLI's own SQL checks both read the exact run.
    const guarded = (skill: { name: string; [key: string]: unknown }) => [
      ...validateSkillDefinitionsInProcess({definitions: [skill as unknown as SkillDefinition]}).issues
        .filter(issue => issue.code === 'sql_guardrail_percentile-percent-scale').map(issue => issue.path),
      ...validateYaml(skill).errors.filter(error => /PERCENTILE/i.test(error)).map(error => error.split(':')[0]),
    ];
    expect(guarded({ ...root, name: 'guard_root', sql: 'SELECT 1', process_scope: global,
      exact_sql: { sql: percentile, process_scope: global } })).toEqual(['exact_sql.sql', 'exact_sql']);
    expect(guarded({ ...steps, name: 'guard_step', steps: [{ id: 'group', type: 'parallel', steps: [{ id: 'top', type: 'atomic',
      sql: 'SELECT 1', process_scope: global, exact_sql: { sql: percentile, process_scope: global } }] }] }))
      .toEqual(['steps[0].steps[0].exact_sql.sql', 'steps[0].steps[0].exact_sql']);
  });

  it('gives the stdlib dependency lint and stdlib coverage the SQL an exact run or a branch runs', () => {
    const binder = 'SELECT COUNT(*) FROM android_binder_txns';
    const global = { role: 'global_context' };
    const exact = { ...root, name: 'stdlib_exact', tier: 'B', sql: 'SELECT 1', process_scope: global,
      exact_sql: { sql: binder, process_scope: global } };
    const branch = { ...steps, name: 'stdlib_branch', tier: 'B', steps: [{ id: 'choice', type: 'conditional',
      conditions: [{ when: 'true', then: { id: 'branch', type: 'atomic', sql: binder } }] }] };
    // A table a step defines serves the steps after it, but not when that step may not run.
    const define = 'CREATE PERFETTO TABLE android_binder_txns AS SELECT 1 AS x';
    const defined = { ...steps, name: 'stdlib_defined', tier: 'B', steps: [
      { id: 'define', type: 'atomic', sql: define }, { id: 'read', type: 'atomic', sql: binder }] };
    const exclusive = { ...steps, name: 'stdlib_exclusive', tier: 'B', steps: [{ id: 'choice', type: 'conditional',
      conditions: [{ when: 'false', then: { id: 'define', type: 'atomic', sql: define } }],
      else: { id: 'read', type: 'atomic', sql: binder } }] };
    const skipped = { ...steps, name: 'stdlib_skipped', tier: 'B', steps: [
      { id: 'define', type: 'atomic', condition: 'false', sql: define }, { id: 'read', type: 'atomic', sql: binder }] };
    const lint = (skill: { name: string }) => validateYaml(skill).errors.filter(error => /lint rule 2/.test(error));
    for (const skill of [exact, branch]) {
      expect([...detectStdlibModulesUsedBySkill(skill as unknown as SkillDefinition)]).toEqual(['android.binder']);
    }
    for (const skill of [exact, branch, exclusive, skipped]) {
      expect([skill.name, lint(skill)]).toEqual([skill.name, [expect.stringContaining("'android_binder_txns'")]]);
    }
    expect(lint(defined)).toEqual([]);
  });

  it('gives the CLI variable check every unit, with what earlier top-level steps saved', () => {
    const undefinedReads = (skill: { name: string; [key: string]: unknown }) => validateYaml(skill).warnings
      .filter(warning => /may not be defined/.test(warning)).map(warning => /'([^']+)'/.exec(warning)![1]);
    expect(undefinedReads({ ...steps, name: 'vars', steps: [
      { id: 'first', type: 'atomic', sql: 'SELECT 1 AS x', save_as: 'first_rows' },
      // A parent's result is not saved before its children run, nor a branch's for the steps after it.
      { id: 'group', type: 'parallel', save_as: 'group_rows', steps: [
        { id: 'child', type: 'atomic', sql: 'SELECT ${first_rows.data[0].x}, ${group_rows.data[0].x}' }] },
      { id: 'choice', type: 'conditional', conditions: [{ when: 'false', then: {
        id: 'branch', type: 'atomic', sql: 'SELECT 1', save_as: 'branch_rows' } }] },
      { id: 'after', type: 'atomic', sql: 'SELECT ${group_rows.data[0].x}, ${branch_rows.data[0].x}',
        process_scope: scope, exact_sql: { sql: 'SELECT ${__process_scope.upid}, ${__process_scope.pid}', process_scope: scope } },
    ] })).toEqual(['group_rows.data[0].x', 'branch_rows.data[0].x', '__process_scope.pid']);
  });

  it('names a step without an id by its position, but relates steps by the step itself', () => {
    // An id written like a position names two steps alike; the evidence one step reads allows only its own texts.
    const skill = { ...steps, steps: [
      { id: 'steps[1]', type: 'atomic', sql: 'SELECT value FROM cpu_frequency_limits' },
      { type: 'atomic', sql: 'SELECT 1', display: { title: '温控导致卡顿' } },
    ] } as unknown as SkillDefinition;
    expect(unsupportedCauseWording(skill, causeWordingReaders([skill])).map(site => `${site.stepId}:${site.field}`))
      .toEqual(['steps[1]:display.title']);
  });

  it('gives the saved-result read check the top-level units the public runtime runs', () => {
    const reading = { sql: 'SELECT ${top.data[0].x} AS x', process_scope: scope };
    const reads = undecidedResultPathReads({ type: 'composite', steps: [
      { id: 'top', type: 'atomic', sql: 'SELECT 1 AS x' },
      { id: 'group', type: 'parallel', steps: [{ id: 'nested', type: 'atomic', ...reading }] },
      { id: 'reader', type: 'atomic', ...reading, exact_sql: reading },
    ] } as never);
    expect(reads.map(read => read.path)).toEqual(['steps[2].sql', 'steps[2].exact_sql.sql']);
  });

  it('admits exact scope only when every unit it runs, with or without an id, supports it', () => {
    const skill = (step: Record<string, unknown>) => ({
      name: 'scoped', version: '1', type: 'composite', meta,
      steps: [{ id: 'choice', type: 'conditional', conditions: [{ when: 'true', then: { type: 'atomic', ...step } }] }],
    }) as unknown as SkillDefinition;
    const support = (definition: SkillDefinition) =>
      getExactProcessScopeSupport(definition, new Map([['scoped', definition]]), new Map());
    expect(support(skill({ sql: 'SELECT 1', process_scope: scope })).supported).toBe(false);
    expect(support(skill({ sql: 'SELECT 1', process_scope: scope, exact_sql: { sql: 'SELECT 2' } })).reason)
      .toBe('scoped.steps[0].conditions[0].then: Invalid exact_sql override; refusing the named SQL fallback');
  });

  it('is the only walk over exact_sql outside the closed schema check', () => {
    // processScopeSql.ts owns the walk; the closed step schema checks one record's own field.
    const allowed = new Set(['services/skillEngine/processScopeSql.ts', 'services/selfEvolution/skillStepRuntimeValidator.ts']);
    expect(sourceFiles().filter(file => readsProperty(file, 'exact_sql'))
      .map(file => path.relative(SRC, file).split(path.sep).join('/'))
      .filter(file => !allowed.has(file))).toEqual([]);
    // The guard sees every form of read.
    const probe = path.join(dir, 'probe.ts');
    for (const [code, reads] of [
      ['const a = `${node.exact_sql.sql}`;', true], ['const a = node["exact_sql"];', true],
      ['const {exact_sql} = node;', true], ['const {exact_sql: e} = node;', true],
      ['const {"exact_sql": e} = node;', true], ['const {["exact_sql"]: e} = node;', true],
      ['const {sql: exact_sql} = node;', false],
      ["const a = 'https://x'; const b = node.exact_sql;", true],
      ["const a = 'node.exact_sql'; // node.exact_sql", false], ['const a = /\\.exact_sql\\b/;', false],
    ] as const) {
      fs.writeFileSync(probe, code);
      expect([code, readsProperty(probe, 'exact_sql')]).toEqual([code, reads]);
    }
  });
});

/**
 * Every check that reads a Skill's steps takes them from one walk
 * (skillSteps.stepNodesOf); a check that needs other semantics asks for them
 * with an option. A private walk once descended only into parallel steps, so
 * a conditional branch's condition, step id and catalog label went unchecked.
 */
describe('the one step walk', () => {
  const branchy = {
    name: 'branchy', version: '1', type: 'composite', meta,
    inputs: [{ name: 'limit', type: 'number' }],
    steps: [
      { id: 'first', type: 'atomic', sql: 'SELECT 1', save_as: 'rows' },
      { id: 'group', type: 'parallel', steps: [{ id: 'inner', type: 'atomic', sql: 'SELECT 2', condition: 'rows.data.length > 0' }] },
      {
        id: 'choice', type: 'conditional',
        conditions: [
          { when: 'true', then: { id: 'branch', type: 'atomic', sql: 'SELECT 3', condition: 'unknown_name > 0',
            display: { title: 'Branch rows' } } },
          { when: 'false', then: 'no_such_skill' },
        ],
        else: { id: 'branch', type: 'atomic', sql: 'SELECT 4' },
      },
    ],
  } as unknown as SkillDefinition;

  it('walks nested steps and branches in order, and narrows by option', () => {
    expect(stepNodesOf(branchy).map(({ at, topLevelIndex }) => [at, topLevelIndex])).toEqual([
      ['steps[0]', 0], ['steps[1]', 1], ['steps[1].steps[0]', 1], ['steps[2]', 2],
      ['steps[2].conditions[0].then', 2], ['steps[2].else', 2],
    ]);
    expect(stepNodesOf(branchy, { topLevelOnly: true }).map(({ at }) => at)).toEqual(['steps[0]', 'steps[1]', 'steps[2]']);
    // A Skill that runs its root SQL, or runs nothing, has no executed steps.
    expect(stepNodesOf({ ...branchy, type: 'atomic', sql: 'SELECT 0' }, { executedOnly: true })).toEqual([]);
    expect(stepNodesOf({ ...branchy, type: 'comparison' }, { executedOnly: true })).toEqual([]);
    expect(stepNodesOf(branchy, { executedOnly: true })).toHaveLength(6);
    expect(stepSkillReferences(branchy).map(({ skillId, at }) => [skillId, at]))
      .toEqual([['no_such_skill', 'steps[2].conditions[1].then']]);
  });

  it('gives every step check the branches the executor runs', () => {
    expect(validateSkillConditions(branchy).map(({ stepId, message }) => [stepId, /'(\w+)'/.exec(message)?.[1]]))
      .toEqual([['branch', 'unknown_name']]);
    const issues = validateSkillDefinitionsInProcess({ definitions: [branchy], validateReferences: true }).issues
      .filter(issue => ['skill_reference_missing', 'step_id_duplicate'].includes(issue.code))
      .map(issue => `${issue.code} ${issue.path}`);
    expect(issues).toEqual(['step_id_duplicate steps[2].else.id', 'skill_reference_missing steps[2].conditions[1].then']);
    expect(skillCatalogEntry(branchy).steps.branch.title.en).toBe('Branch rows');
    // Exact scope follows a branch written as a Skill id into that Skill.
    const router = { ...branchy, name: 'router', steps: [{ id: 'choice', type: 'conditional',
      conditions: [{ when: 'false', then: 'no_such_skill' }] }] } as unknown as SkillDefinition;
    expect(getExactProcessScopeSupport(router, new Map([['router', router]]), new Map()).reason)
      .toBe('router.choice: Skill dependency is missing: no_such_skill');
  });

  it('is the only walk over conditional branches outside the executor and the closed schema check', () => {
    const allowed = new Set([
      'services/skillEngine/skillSteps.ts',
      'services/skillEngine/skillExecutor.ts',
      'services/selfEvolution/skillStepRuntimeValidator.ts',
    ]);
    const skillDirs = ['services/skillEngine', 'services/selfEvolution', 'services/skillPacks', 'cli'];
    const readers = sourceFiles().map(file => path.relative(SRC, file).split(path.sep).join('/'))
      .filter(file => skillDirs.some(dir => file.startsWith(`${dir}/`)) || /^services\/skillLocalization/.test(file))
      .filter(file => readsProperty(path.join(SRC, file), 'conditions'));
    expect(readers.filter(file => !allowed.has(file))).toEqual([]);
  });
});
