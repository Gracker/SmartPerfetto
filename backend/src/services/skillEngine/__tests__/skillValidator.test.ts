// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { validateSkillInputs, validateSkillConditions, validateFragmentReferences, validateNormalizedStdlibReads, validateProcessScopeDeclarations } from '../skillValidator';
import { extractRootVariables, JS_BUILTINS, parseEvidenceField, readEvidenceField } from '../expressionUtils';
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

  it('handles complex chained expressions', () => {
    const result = extractRootVariables('jank_stats.data.find(j => j.jank_type)');
    expect(result).toContain('jank_stats');
    expect(result).toContain('j');
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
// JS_BUILTINS sanity
// =============================================================================

describe('JS_BUILTINS', () => {
  it('contains common keywords', () => {
    expect(JS_BUILTINS.has('true')).toBe(true);
    expect(JS_BUILTINS.has('false')).toBe(true);
    expect(JS_BUILTINS.has('typeof')).toBe(true);
    expect(JS_BUILTINS.has('Math')).toBe(true);
  });

  it('does not contain user variable names', () => {
    expect(JS_BUILTINS.has('foo')).toBe(false);
    expect(JS_BUILTINS.has('performance_summary')).toBe(false);
  });
});
