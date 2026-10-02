// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { validateSkillInputs, validateSkillConditions, validateFragmentReferences, validateNormalizedStdlibReads, validateProcessScopeDeclarations } from '../skillValidator';
import { extractRootVariables, EXPRESSION_GLOBALS, isBindableName, parseEvidenceField, readEvidenceField, rootReads, templateRootReads } from '../expressionUtils';
import type { SkillDefinition, SkillInput } from '../types';

// =============================================================================
// extractRootVariables
// =============================================================================

describe('extractRootVariables', () => {
  it('extracts simple variable names', () => {
    expect(extractRootVariables('foo > 10')).toEqual(['foo']);
  });

  it('extracts multiple variables', () => {
    const result = extractRootVariables('foo > 10 && bar < 20');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('ignores property access (dot notation)', () => {
    expect(extractRootVariables('performance_summary.data > 10')).toEqual(['performance_summary']);
  });

  it('ignores JS keywords and builtins', () => {
    const result = extractRootVariables('typeof foo !== "undefined" && true');
    expect(result).toEqual(['foo']);
  });

  it('does not report arrow parameters within their function', () => {
    expect(extractRootVariables('jank_stats.data.find(j => j.jank_type)')).toEqual(['jank_stats']);
    expect(extractRootVariables('rows.some((r, i) => r.v > limit + i)')).toEqual(['rows', 'limit']);
    expect(extractRootVariables('(window => window > 0)(1)')).toEqual([]);
    // Outside its function, the same name is a root.
    expect(extractRootVariables('a.data[0].v > 0 && b.data.some(a => a.v > 0)')).toEqual(['a', 'b']);
    expect(extractRootVariables('xs.map(x => x.v).length > 0 && x')).toEqual(['xs', 'x']);
    expect(extractRootVariables('c ? xs.some(x => x > 0) : x')).toEqual(['c', 'xs', 'x']);
    expect(extractRootVariables('xs.some(x => { return x > 0; }) || x')).toEqual(['xs', 'x']);
    expect(extractRootVariables('xs.some(x => x ?? y) && x')).toEqual(['xs', 'y', 'x']);
    // An unparenthesized body ends at the `:` of a conditional it did not open; `??` opens none.
    expect(extractRootVariables('c ? v => v ?? d : v')).toEqual(['c', 'd', 'v']);
  });

  it('lists roots in the order they are first written, placeholders included', () => {
    expect(extractRootVariables('a.data.length > 0 && ${b.data.length} > 0')).toEqual(['a', 'b']);
    expect(extractRootVariables('${b|0} > 0 && a > 0')).toEqual(['b', 'a']);
    expect(extractRootVariables("x${a}y === 'q' && z")).toEqual(['x', 'a', 'y', 'z']);
    expect(extractRootVariables('${a_long_placeholder_path.data[0].value} > 0 && ${b} > 0 && c > 0'))
      .toEqual(['a_long_placeholder_path', 'b', 'c']);
  });

  // A quote, backtick or slash inside a literal or comment must not hide the code after it.
  it.each<[string, string[]]>([
    ["'it\\'s' === label && status === 'ok'", ['label', 'status']],
    ["`'` + x + `'`", ['x']],
    ["/'/.test(label) && status === 'ok'", ['label', 'status']],
    ["x /* ' */ + y", ['x', 'y']],
    ['x // trailing comment names q', ['x']],
    // A `//` comment ends at every line terminator, not only LF.
    ...['\n', '\r', '\u2028', '\u2029'].map((eol): [string, string[]] => [`(true // comment${eol} && undeclared > 0)`, ['undeclared']]),
    ['`total of ${obj.p} items` + tail', ['obj', 'tail']],
    ['true /* \\u{110000} */ && x // \\u{FFFFFFFF}', ['x']],
  ])('reads the code around literals and comments: %s', (expr, roots) => {
    expect(extractRootVariables(expr).sort()).toEqual([...roots].sort());
  });

  it.each([
    ['a / b / c', ['a', 'b', 'c']],
    ['(a) / b /g', ['a', 'b', 'g']],
    ['x in /re/.source', ['x']],
    // After a statement head or a block, `/` starts a regex; after a call or object literal it divides.
    ["(() => { if (true) /'/; return undeclared > 0; })()", ['undeclared']],
    ["(() => { {} /'/; while (x) /\"/; return undeclared > 0; })()", ['x', 'undeclared']],
    ["(() => { try {} finally {} /`/; return f(a) / b / c; })()", ['f', 'a', 'b', 'c']],
    ['({k: 1}) / a / b + {k: 2}.k / c / d', ['a', 'b', 'c', 'd']],
    // A Unicode or escaped identifier is a name, so the `/` after it divides.
    ['settings.数值 / divisor && undeclared > 0', ['settings', 'divisor', 'undeclared']],
    ['settings.é / divisor && 速度 > \\u0061bc', ['settings', 'divisor', '速度', 'abc']],
  ])('tells division from a regex literal: %s', (expr, roots) => {
    expect(extractRootVariables(expr)).toEqual(roots);
  });

  it('reads optional chains, spread and object values but not property names or static keys', () => {
    expect(extractRootVariables('x?.y ?? z?.[w]')).toEqual(['x', 'z', 'w']);
    expect(extractRootVariables('Math.max(...vals)')).toEqual(['vals']);
    expect(extractRootVariables('({window: 1, k: a ? b : c}).window')).toEqual(['a', 'b', 'c']);
    expect(extractRootVariables('({total})[key]')).toEqual(['total', 'key']);
    expect(extractRootVariables('({[slot]: 1})')).toEqual(['slot']);
  });

  // A contextual keyword may be a name, so it is reported; it never hides a later root.
  it('reports contextual keywords as names, and never lets them hide a later root', () => {
    expect(extractRootVariables('async > 0 && of > 0 && let > 0')).toEqual(['async', 'of', 'let']);
    expect(extractRootVariables('rows.map(async r => r)')).toEqual(['rows', 'async']);
    expect(extractRootVariables('settings.async && ({async: 1}) && (await / divisor) && undeclared > 0').sort())
      .toEqual(['await', 'divisor', 'settings', 'undeclared']);
  });

  // Without parsing, `/` after `}` or a contextual keyword may be a regex or a division:
  // both readings are lexed, so neither can swallow the code after it.
  it.each([
    "(() => { try { throw 1; } catch {} /'/; return undeclared > 0; })()",
    "(() => { label: {} /'/; return undeclared > 0; })()",
    "(() => { switch (1) { case 1: {} /\"/; } return undeclared > 0; })()",
    "(() => { class C {} /`/; return undeclared > 0; })()",
    "(() => { 1\n{} /'/; return undeclared > 0; })()",
    '(() => { return\n{} /\'/; })() || undeclared > 0',
    'function(){} / divisor || undeclared > 0',
    '(() => { for (; {} / divisor || undeclared > 0;) return true; return false; })()',
    "(() => { for (item of /'/.source) return undeclared > 0; return false; })()",
    "(g => g.next().value)((function*() { yield /'/; return undeclared > 0; })())",
    "(async () => await /'/.test(x)) && undeclared > 0",
    // Lexed wrong, then caught by the engine check and answered by the coarse scan.
    ...["'", '"', '`'].flatMap(q => [
      `(() => { outer: while (true) { break outer\n/${q}/; } return undeclared > 0; })()`,
      `(() => { outer: while (true) { continue outer\n/${q}/; } return undeclared > 0; })()`,
      `(() => {\n<!-- ${q} comment\nreturn undeclared > 0;\n})()`,
      `(() => {\n--> ${q} comment\nreturn undeclared > 0;\n})()`,
    ]),
  ])('keeps the roots after an undecided slash: %s', expr => {
    expect(extractRootVariables(expr)).toContain('undeclared');
  });

  // The coarse scan pairs the quotes in `'it\'s' … 'z'` and loses `u`, so each case
  // shows that the lexer itself, not the fallback, read the slash, regex or flags right.
  it.each([
    ['(() => { if (x) /\'/.test(a); return true; })()', ['a', 'x']],
    ["(() => { label: {} /'/.test(a); return true; })()", ['a']],
    ['function(){} / n', ['n']],
    ['(counter++ / divisor / limit) > 0', ['counter', 'divisor', 'limit']],
    ['obj.return / divisor / limit > 0', ['divisor', 'limit', 'obj']],
    ['/x/gi.test(t)', ['t']],
  ])('reads %s precisely', (expr, roots) => {
    const tail = " && s === 'it\\'s' || u === 'z'";
    expect(extractRootVariables(expr + tail).sort()).toEqual([...roots, 's', 'u'].sort());
  });

  it('falls back to the coarse scan when the condition does not compile', () => {
    expect(extractRootVariables("status === 'ok' OR missing").sort()).toEqual(['OR', 'missing', 'status']);
  });

  it('reads what an arrow parameter default or computed key reads, not the parameters or destructuring keys', () => {
    expect(extractRootVariables('rows.some((row = threshold) => row > 0)')).toEqual(['rows', 'threshold']);
    expect(extractRootVariables('rows.some(({v: value = floor, w}, [a, b] = pair) => value > w + a + b)'))
      .toEqual(['rows', 'floor', 'pair']);
    expect(extractRootVariables('(({[key]: value}) => value > 0)(obj)')).toEqual(['key', 'obj']);
    expect(extractRootVariables('(({[settings.key]: value, [pick()]: other}) => value > other)(obj) && settings.enabled'))
      .toEqual(['settings', 'pick', 'obj']);
  });

  it('returns empty for pure builtins', () => {
    expect(extractRootVariables('true && false')).toEqual([]);
    expect(extractRootVariables('Math.max(1, 2)')).toEqual([]);
  });

  it('ignores identifiers inside string literals', () => {
    const result = extractRootVariables("status === 'available' && count > 0");
    expect(result).toContain('status');
    expect(result).toContain('count');
    expect(result).not.toContain('available');
  });

  it('handles double-quoted strings', () => {
    const result = extractRootVariables('type === "running"');
    expect(result).toContain('type');
    expect(result).not.toContain('running');
  });
});

describe('rootReads', () => {
  const brief = (expr: string) => rootReads(expr).reads.map(({name, access}) =>
    `${name}${access === undefined ? '' : `.${access}`}`);

  it('reports each read with the member read right after it', () => {
    expect(brief('rows.data[0] && rows?.data && rows[0] && rows?.[0] && rows && rows?.["data"]'))
      .toEqual(['rows.data', 'rows.data', 'rows.[', 'rows.[', 'rows', 'rows.[']);
    // Comments between a name and its member and escaped member names are read as code reads them.
    expect(brief('rows /* c */ [0].x && rows. /* c */ data.length && rows.\\u0064ata.length'))
      .toEqual(['rows.[', 'rows.data', 'rows.data']);
  });

  it('reads a placeholder as the evaluator does and keeps every occurrence in written order', () => {
    // A path the evaluator resolves itself is no member read; JavaScript inside
    // a placeholder, or a whole `${…}` without a default, reads as code does.
    expect(brief('${rows[0].x|0} > limit && ${other[0].y} > 0 && ${rows[0].x * 2} > limit'))
      .toEqual(['rows', 'limit', 'other', 'rows.[', 'limit']);
    expect(brief('${rows[0].x}')).toEqual(['rows.[']);
    expect(brief('${rows[0].x|0}')).toEqual(['rows']);
    expect(rootReads('a > 0 && b > a').reads.map(read => read.at)).toEqual([0, 9, 13]);
    expect(rootReads('x && ${ rows.data[0] > rows[0]}').reads.map(read => read.at)).toEqual([0, 8, 23]);
  });

  it('is exact only when the engine confirmed it and no local but an arrow parameter is declared', () => {
    const exact = (expr: string) => rootReads(expr).exact;
    expect(exact('rows.data.some(r => r.x > limit)')).toBe(true);
    expect(exact("x in /'/.source")).toBe(true);
    expect(exact('rows.data.some(r => { const limit = 1; return r.x > limit; })')).toBe(false);
    expect(exact('rows.data.some(function(r) { return r.x > 1; })')).toBe(false);
    expect(exact('({check(r) { return r.x > 1; }}).check(rows.data[0])')).toBe(false);
    expect(exact('({get ok() { return true; }}).ok')).toBe(false);
    expect(exact('rows.data.some(r => { return r.x > limit; })')).toBe(false);
    expect(exact("status === 'ok' OR missing")).toBe(false);
    expect(exact(Array.from({length: 1001}, (_, i) => `v${i}`).join(' + '))).toBe(false);
    expect(exact('${rows.data.some(function(r) { return r.x; })}')).toBe(false);
  });

  it('reads only the placeholders of a template', () => {
    expect(templateRootReads('Top ${rows.data[0].name} over ${limit|16}ms, see other').reads.map(read => read.name))
      .toEqual(['rows', 'limit']);
    expect(templateRootReads('plain text with words').reads).toEqual([]);
  });
});

// =============================================================================
// validateSkillInputs
// =============================================================================

// =============================================================================
// Diagnostic evidence fields: a read-only grammar walked over plain data
// =============================================================================

describe('readEvidenceField', () => {
  const read = (field: string, data: unknown) => {
    const path = parseEvidenceField(field);
    if (!path) throw new Error(`not an evidence field: ${field}`);
    return readEvidenceField(path, data);
  };

  it('reads own data only: no getter, inherited member, function value or replaced method', () => {
    let getterRan = false;
    const row = Object.defineProperty({x: 1}, 'y', {enumerable: true, get: () => { getterRan = true; return 2; }});
    expect(read('rows.data[0].y', [row])).toBeUndefined();
    expect(getterRan).toBe(false);
    expect(read('rows.data[0].toString', [{x: 1}])).toBeUndefined();
    expect(read('rows.data[0].fn', [{fn: () => 1}])).toBeUndefined();
    // A sparse slot never falls through to the prototype.
    const proto = Object.create(Array.prototype, {0: {value: {x: 'inherited'}}});
    const sparse: unknown[] = Object.setPrototypeOf(new Array(1), proto);
    expect(read('rows.data[0]?.x', sparse)).toBeUndefined();
    const rows: any = [{x: 1}, {x: 2}];
    rows.find = () => { throw new Error('called'); };
    rows.filter = () => { throw new Error('called'); };
    expect(read('rows.data.find(r => r.x > 1)?.x', rows)).toBe(2);
    expect(read('rows.data.filter(r => r.x >= 1).length', rows)).toBe(2);
  });

  it('compares scalars only, so no conversion runs and nothing throws', () => {
    const hostile = JSON.parse('{"toString":null,"valueOf":null}');
    expect(read('rows.data.find(r => r.x > 0)', [{x: hostile}, {x: 3}])).toEqual({x: 3});
    expect(read('rows.data.filter(r => r.x != null).length', [{x: [1]}, {x: 0}, {}])).toBe(1);
  });

  it('rejects inherited members in every position', () => {
    for (const field of ['rows.data.find(r => r.constructor !== null)', 'rows.data.filter(r => r.__proto__ != null)',
      'rows.data[0].prototype', 'rows.data.constructor']) {
      expect(parseEvidenceField(field)).toBeUndefined();
    }
  });
});

describe('validateSkillInputs', () => {
  const makeInput = (overrides: Partial<SkillInput> & { name: string }): SkillInput => ({
    type: 'string',
    required: false,
    ...overrides,
  });

  it('passes through params when no inputs declared', () => {
    const result = validateSkillInputs('test', undefined, { foo: 'bar' });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.params.foo).toBe('bar');
  });

  it('passes through params when inputs is empty array', () => {
    const result = validateSkillInputs('test', [], { foo: 'bar' });
    expect(result.errors).toHaveLength(0);
    expect(result.params.foo).toBe('bar');
  });

  it('reports error for missing required parameter', () => {
    const inputs = [makeInput({ name: 'start_ts', type: 'timestamp', required: true })];
    const result = validateSkillInputs('test', inputs, {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].paramName).toBe('start_ts');
  });

  it('fills default for missing optional parameter', () => {
    const inputs = [makeInput({ name: 'limit', type: 'number', default: 10 })];
    const result = validateSkillInputs('test', inputs, {});
    expect(result.errors).toHaveLength(0);
    expect(result.params.limit).toBe(10);
  });

  it('coerces string to number', () => {
    const inputs = [makeInput({ name: 'count', type: 'number' })];
    const result = validateSkillInputs('test', inputs, { count: '42' });
    expect(result.errors).toHaveLength(0);
    expect(result.params.count).toBe(42);
  });

  it('reports error for non-numeric number value', () => {
    const inputs = [makeInput({ name: 'count', type: 'number' })];
    const result = validateSkillInputs('test', inputs, { count: 'abc' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].paramName).toBe('count');
  });

  it('coerces to integer', () => {
    const inputs = [makeInput({ name: 'limit', type: 'integer' })];
    const result = validateSkillInputs('test', inputs, { limit: '8.5' });
    expect(result.errors).toHaveLength(0);
    expect(result.params.limit).toBe(8);
  });

  it('coerces boolean strings', () => {
    const inputs = [makeInput({ name: 'verbose', type: 'boolean' })];

    let result = validateSkillInputs('test', inputs, { verbose: 'true' });
    expect(result.params.verbose).toBe(true);

    result = validateSkillInputs('test', inputs, { verbose: '0' });
    expect(result.params.verbose).toBe(false);

    result = validateSkillInputs('test', inputs, { verbose: 'yes' });
    expect(result.errors).toHaveLength(1);
  });

  it('passes through valid timestamp', () => {
    const inputs = [makeInput({ name: 'start_ts', type: 'timestamp' })];
    const result = validateSkillInputs('test', inputs, { start_ts: 1234567890 });
    expect(result.errors).toHaveLength(0);
    expect(result.params.start_ts).toBe(1234567890);
  });

  it('coerces string-encoded timestamp', () => {
    const inputs = [makeInput({ name: 'start_ts', type: 'timestamp' })];
    const result = validateSkillInputs('test', inputs, { start_ts: '1234567890' });
    expect(result.errors).toHaveLength(0);
    expect(result.params.start_ts).toBe(1234567890);
  });

  it('soft-coerces non-string to string with no error', () => {
    const inputs = [makeInput({ name: 'label', type: 'string' })];
    const result = validateSkillInputs('test', inputs, { label: 42 });
    expect(result.errors).toHaveLength(0);
    expect(result.params.label).toBe('42');
  });

  it('validates array type', () => {
    const inputs = [makeInput({ name: 'items', type: 'array' })];

    let result = validateSkillInputs('test', inputs, { items: [1, 2, 3] });
    expect(result.errors).toHaveLength(0);

    result = validateSkillInputs('test', inputs, { items: 'not-an-array' });
    expect(result.errors).toHaveLength(1);
  });

  it('validates object type', () => {
    const inputs = [makeInput({ name: 'config', type: 'object' })];

    let result = validateSkillInputs('test', inputs, { config: { key: 'val' } });
    expect(result.errors).toHaveLength(0);

    result = validateSkillInputs('test', inputs, { config: [1, 2] });
    expect(result.errors).toHaveLength(1);
  });

  it('warns about undeclared parameters', () => {
    const inputs = [makeInput({ name: 'known', type: 'string' })];
    const result = validateSkillInputs('test', inputs, { known: 'a', extra: 'b' });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].paramName).toBe('extra');
  });
});

// =============================================================================
// validateSkillConditions
// =============================================================================

describe('validateSkillConditions', () => {
  const makeSkill = (overrides: Partial<SkillDefinition>): SkillDefinition => ({
    name: 'test_skill',
    version: '1.0',
    type: 'composite',
    meta: { display_name: 'Test', description: 'Test' },
    ...overrides,
  });

  it('returns no warnings for valid condition referencing prior step', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', save_as: 'data1' } as any,
        { id: 'step2', type: 'atomic', sql: 'SELECT 2', condition: 'data1.length > 0' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('checks ASCII roots that are not declared, global or exempt', () => {
    const conditionWarnings = (condition: string, inputs: SkillDefinition['inputs'] = []) =>
      validateSkillConditions(makeSkill({inputs, steps: [{id: 's', type: 'atomic', sql: 'SELECT 1', condition} as any]}))
        .map(w => w.message);
    expect(conditionWarnings('parseFloat(String(1.5)) > 1 && !isNaN(1)')).toEqual([]);
    expect(conditionWarnings('limit > 0', [{name: 'limit', type: 'number', required: false}])).toEqual([]);
    // Host names and contextual keywords are exempt; non-ASCII names, which may be locals, are not checked.
    expect(conditionWarnings('window > 0 && console && globalThis && async && of')).toEqual([]);
    for (const local of ['(function(阈值) { return 阈值 > 0; })(1)', '(function($window) { return $window > 0; })(1)']) {
      expect([local, conditionWarnings(local)]).toEqual([local, []]);
    }
    expect(conditionWarnings("'it\\'s' === label")).toEqual([
      "Condition references unknown variable 'label' in expression: 'it\\'s' === label",
    ]);
  });

  // evaluateCondition substitutes every `${…}` placeholder, inside quotes too, before the JS runs.
  it('reads the root of each Skill placeholder in a condition', () => {
    const roots = (condition: string) => extractRootVariables(condition).sort();
    expect(roots("'${mode|full}' !== 'overview' && ${enabled|true} == true")).toEqual(['enabled', 'mode']);
    expect(roots('${rows.data[0].v|0} > ${limit}')).toEqual(['limit', 'rows']);
    expect(roots('${a.data?.[0]?.v ?? b} > 0')).toEqual(['a', 'b']);
    // A whole-text placeholder is one expression, `}` included; a default never spans lines.
    expect(roots('${rows.some(r => { return r.x > lim })}')).toEqual(['lim', 'rows']);
    expect(roots('${a|x\ny}')).toEqual(['a', 'x', 'y']);
    // A whole placeholder without a default is JS: literals and language globals read no root.
    for (const constant of ['${true}', '${Infinity}', '${Math.PI}', '${parseFloat}', '${undefined}']) {
      expect([constant, roots(constant)]).toEqual([constant, []]);
    }
    // Embedded, a simple path is resolved through scopes, where no global is bound:
    // `${Math.PI} > 3` evaluates as ' > 3', so its root is reported.
    expect(roots('${Math.PI} > 3')).toEqual(['Math']);
    expect(roots('${step.data[0].v} > 1')).toEqual(['step']);
  });

  it('warns for unknown variable in condition', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1' } as any,
        { id: 'step2', type: 'atomic', sql: 'SELECT 2', condition: 'unknown_var > 0' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain('unknown_var');
  });

  it('recognizes declared input parameters', () => {
    const skill = makeSkill({
      inputs: [{ name: 'threshold', type: 'number', required: false }],
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', condition: 'threshold > 10' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('recognizes implicit params (package, vendor, start_ts, end_ts)', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', condition: 'package !== ""' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('recognizes context dependencies', () => {
    const skill = makeSkill({
      context: ['parent_data'],
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', condition: 'parent_data.length > 0' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('validates iterator source references', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', save_as: 'items' } as any,
        { id: 'step2', type: 'iterator', source: 'items', item_skill: 'some_skill' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('warns for undefined iterator source', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'iterator', source: 'nonexistent', item_skill: 'some_skill' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain('nonexistent');
  });

  it('recognizes step IDs from prior steps', () => {
    const skill = makeSkill({
      steps: [
        { id: 'overview', type: 'atomic', sql: 'SELECT 1' } as any,
        { id: 'detail', type: 'atomic', sql: 'SELECT 2', condition: 'overview.data.length > 0' } as any,
      ],
    });
    const warnings = validateSkillConditions(skill);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty for skill with no steps', () => {
    const skill = makeSkill({ steps: [] });
    expect(validateSkillConditions(skill)).toHaveLength(0);
  });
});

// =============================================================================
// validateNormalizedStdlibReads
// =============================================================================

describe('validateNormalizedStdlibReads', () => {
  const owner = 'fragments/android_input_events_normalized.sql';
  const fragments = new Map([
    [owner, 'android_input_events_normalized AS NOT MATERIALIZED (SELECT * FROM android_input_events)'],
    ['fragments/raw_reader.sql', 'raw_reader AS (SELECT event_action FROM android_input_events)'],
    ['fragments/good_reader.sql', 'good_reader AS (SELECT event_action FROM android_input_events_normalized)'],
  ]);

  it('rejects raw FROM/JOIN reads in root, step, branch and exact SQL', () => {
    const warnings = validateNormalizedStdlibReads({
      name: 'raw', sql: 'SELECT * FROM android_input_events',
      steps: [
        { id: 'joined', type: 'atomic', sql: 'SELECT 1 FROM frames f JOIN Android_Input_Events ie ON ie.upid = f.upid' },
        { id: 'branch', type: 'conditional', conditions: [{ when: 'true', then: {
          id: 'nested', type: 'atomic', sql: 'SELECT 1', exact_sql: { sql: 'SELECT 1 FROM android_input_events', process_scope: { role: 'target' } },
        } }] },
      ],
    } as unknown as SkillDefinition, fragments);
    expect(warnings.map(warning => warning.stepId)).toEqual(['root', 'joined', 'branch.exact_sql']);
    expect(warnings[0].message).toContain(owner);
  });

  it('accepts the normalized relation, the owner fragment, comments, strings and existence probes', () => {
    expect(validateNormalizedStdlibReads({
      name: 'ok', sql: `-- FROM android_input_events
        SELECT 'FROM android_input_events', (SELECT 1 FROM sqlite_master WHERE name = 'android_input_events')
        FROM android_input_events_normalized`,
      sql_fragments: [owner, 'fragments/good_reader.sql'],
      steps: [{ id: 'fallback', type: 'atomic', sql: 'CREATE VIEW IF NOT EXISTS android_input_events AS SELECT NULL AS event_action WHERE 0' }],
    } as unknown as SkillDefinition, fragments)).toEqual([]);
  });

  it('rejects a referenced fragment that bypasses the owner fragment', () => {
    const warnings = validateNormalizedStdlibReads({
      name: 'frag', sql: 'SELECT * FROM raw_reader', sql_fragments: ['fragments/raw_reader.sql'],
    } as SkillDefinition, fragments);
    expect(warnings).toEqual([expect.objectContaining({ stepId: 'root', message: expect.stringContaining("Fragment 'fragments/raw_reader.sql'") })]);
  });
});

// =============================================================================
// validateFragmentReferences
// =============================================================================

describe('validateFragmentReferences', () => {
  it('validates root and conditional branch fragment references', () => {
    const warnings = validateFragmentReferences({
      name: 'root', sql: 'SELECT 1', sql_fragments: ['fragments/root_missing.sql'],
      steps: [{ id: 'branch', type: 'conditional', conditions: [{ when: 'true', then: {
        id: 'nested', type: 'atomic', sql: 'SELECT 1', sql_fragments: ['fragments/nested_missing.sql'],
      } }] }],
    } as SkillDefinition, new Set());
    expect(warnings).toHaveLength(2);
  });

  it('rejects a native scope declaration whose trusted binding only appears in comments', () => {
    const warnings = validateProcessScopeDeclarations({
      name: 'bad', type: 'atomic', sql: '-- ${__process_scope.upid}\nSELECT * FROM process',
      process_scope: { role: 'target', binding: 'native_upid' },
    } as SkillDefinition, new Map());
    expect(warnings[0].message).toContain('must bind the trusted');
  });

  it('requires fragment-backed target SQL to consume the target relation', () => {
    const warnings = validateProcessScopeDeclarations({
      name: 'bad', type: 'atomic', sql: 'SELECT * FROM process',
      process_scope: { role: 'target', binding: 'effective_target_processes' },
      sql_fragments: ['fragments/effective_target_processes.sql'],
    } as SkillDefinition, new Map([['fragments/effective_target_processes.sql',
      'effective_target_processes AS (SELECT * FROM process WHERE upid = ${__process_scope.upid})']]));
    expect(warnings[0].message).toContain('does not consume effective_target_processes');
  });

  const makeSkill = (overrides: Partial<SkillDefinition>): SkillDefinition => ({
    name: 'test_skill',
    version: '1.0',
    type: 'composite',
    meta: { display_name: 'Test', description: 'Test' },
    ...overrides,
  });

  const fragments = new Set(['fragments/target_threads.sql', 'fragments/vsync_config.sql']);

  it('returns no warnings when all fragments exist', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', sql_fragments: ['fragments/target_threads.sql'] } as any,
      ],
    });
    const warnings = validateFragmentReferences(skill, fragments);
    expect(warnings).toHaveLength(0);
  });

  it('warns when fragment does not exist', () => {
    const skill = makeSkill({
      steps: [
        { id: 'step1', type: 'atomic', sql: 'SELECT 1', sql_fragments: ['fragments/nonexistent.sql'] } as any,
      ],
    });
    const warnings = validateFragmentReferences(skill, fragments);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].message).toContain('nonexistent.sql');
  });

  it('checks fragments in parallel steps', () => {
    const skill = makeSkill({
      steps: [
        {
          id: 'par', type: 'parallel', steps: [
            { id: 'inner', type: 'atomic', sql: 'SELECT 1', sql_fragments: ['fragments/missing.sql'] },
          ]
        } as any,
      ],
    });
    const warnings = validateFragmentReferences(skill, fragments);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('returns empty for skill with no steps', () => {
    const skill = makeSkill({ steps: [] });
    expect(validateFragmentReferences(skill, fragments)).toHaveLength(0);
  });
});

// =============================================================================
// Expression vocabulary
// =============================================================================

describe('expression vocabulary', () => {
  it('lists only globals the language defines', () => {
    for (const name of EXPRESSION_GLOBALS) expect(name in globalThis).toBe(true);
    // Host globals and the global object itself are not part of it.
    for (const name of ['globalThis', 'process', 'console', 'window', 'Function', 'eval', 'Promise']) {
      expect(EXPRESSION_GLOBALS.has(name)).toBe(false);
    }
  });

  it('calls a name bindable exactly when new Function accepts it as a parameter', () => {
    const accepts = (name: string) => { try { new Function(name, ''); return true; } catch { return false; } };
    for (const name of ['enum', 'default', 'this', 'typeof', 'null', 'class', 'let', 'yield', 'await',
      'async', 'static', 'of', 'package', 'implements', 'arguments', 'eval', 'window', 'undefined',
      '数值', 'é', '$x', '_', '0', '-', '😀', 'a-b']) {
      expect([name, isBindableName(name)]).toEqual([name, accepts(name)]);
    }
  });
});
