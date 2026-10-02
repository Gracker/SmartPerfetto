// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { SkillRegistry } from '../skillLoader';

describe('custom skill loading', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-custom-skills-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeBaseSkill(
    root: string,
    name = 'startup_analysis',
  ): Promise<void> {
    const compositeDir = path.join(root, 'composite');
    await fs.mkdir(compositeDir, {recursive: true});
    await fs.writeFile(
      path.join(compositeDir, `${name}.skill.yaml`),
      [
        `name: ${name}`,
        'version: "1"',
        'type: composite',
        'meta:',
        `  display_name: ${name}`,
        '  description: Test base skill',
        'steps:',
        '  - id: rows',
        '    type: atomic',
        '    sql: SELECT 1 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  it('loads one requested skill without full registry initialization', async () => {
    const atomicDir = path.join(tmpDir, 'atomic');
    const moduleDir = path.join(tmpDir, 'modules', 'app');
    const fragmentsDir = path.join(tmpDir, 'fragments');
    await fs.mkdir(atomicDir, { recursive: true });
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(fragmentsDir, { recursive: true });
    await fs.writeFile(path.join(fragmentsDir, 'common.sql'), 'SELECT 1 AS fragment_value', 'utf-8');
    await fs.writeFile(
      path.join(atomicDir, 'process_identity_resolver.skill.yaml'),
      [
        'name: process_identity_resolver',
        'version: "1"',
        'type: atomic',
        'meta:',
        '  display_name: Process Identity Resolver',
        '  description: Resolves process identity',
        'sql: SELECT 1 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(moduleDir, 'unrelated.skill.yaml'),
      [
        'name: unrelated_module_skill',
        'version: "1"',
        'type: atomic',
        'meta:',
        '  display_name: Unrelated',
        '  description: Should not be loaded by the single-skill path',
        'sql: SELECT 2 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    const loaded = registry.loadSingleSkill(tmpDir, 'atomic/process_identity_resolver.skill.yaml');

    expect(loaded).toMatchObject({
      name: 'process_identity_resolver',
      type: 'atomic',
      meta: { display_name: 'Process Identity Resolver' },
    });
    expect(registry.getSkill('process_identity_resolver')).toBe(loaded);
    expect(registry.getSkill('unrelated_module_skill')).toBeUndefined();
    expect(registry.getFragmentCache().get('fragments/common.sql')).toBe('SELECT 1 AS fragment_value');
    expect(registry.isInitialized()).toBe(false);
  });

  it('loads skills from the custom directory after admin writes', async () => {
    const customDir = path.join(tmpDir, 'custom');
    await fs.mkdir(customDir, { recursive: true });
    await fs.writeFile(
      path.join(customDir, 'workspace_jank.skill.yaml'),
      [
        'name: workspace_jank',
        'version: "1"',
        'meta:',
        '  display_name: Workspace Jank',
        '  description: Local custom skill',
        'steps:',
        '  - id: rows',
        '    type: atomic',
        '    sql: SELECT 1 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    expect(registry.getSkill('workspace_jank')).toMatchObject({
      name: 'workspace_jank',
      version: '1',
      meta: {
        display_name: 'Workspace Jank',
      },
    });
  });

  it('loads comparison skills from the comparison directory', async () => {
    const comparisonDir = path.join(tmpDir, 'comparison');
    await fs.mkdir(comparisonDir, { recursive: true });
    await fs.writeFile(
      path.join(comparisonDir, 'multi_trace_result_comparison.skill.yaml'),
      [
        'name: multi_trace_result_comparison',
        'version: "1"',
        'type: comparison',
        'meta:',
        '  display_name: Multi Trace Result Comparison',
        '  description: Compares persisted analysis results',
        'source: analysis_result_snapshot',
        'comparison:',
        '  source: analysis_result_snapshot',
        '  operation: build_comparison_matrix',
        '  output_contract: ComparisonMatrix',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    expect(registry.getSkill('multi_trace_result_comparison')).toMatchObject({
      name: 'multi_trace_result_comparison',
      type: 'comparison',
      source: 'analysis_result_snapshot',
      comparison: {
        operation: 'build_comparison_matrix',
        output_contract: 'ComparisonMatrix',
      },
    });
  });

  it('records display contract issues from vendor override additional steps', async () => {
    await writeBaseSkill(tmpDir);
    const vendorDir = path.join(tmpDir, 'vendors', 'xiaomi');
    await fs.mkdir(vendorDir, { recursive: true });
    await fs.writeFile(
      path.join(vendorDir, 'startup.override.yaml'),
      [
        'extends: composite/startup_analysis',
        'version: "1"',
        'meta:',
        '  vendor: xiaomi',
        '  display_name: Xiaomi Startup Override',
        '  description: Vendor-specific startup checks',
        'vendor_detection:',
        '  signatures:',
        '    - pattern: Xiaomi',
        '      confidence: high',
        'additional_steps:',
        '  - id: vendor_rows',
        '    name: Vendor Rows',
        '    type: atomic',
        '    sql: SELECT 1 AS value',
        '    display:',
        '      layer: duration',
        '      level: list',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    const issues = registry.getDisplayContractIssues();
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillName: 'startup_analysis@xiaomi:startup.override',
          stepId: 'vendor_rows',
          path: 'steps[0].display.layer',
          value: 'duration',
        }),
        expect.objectContaining({
          skillName: 'startup_analysis@xiaomi:startup.override',
          stepId: 'vendor_rows',
          path: 'steps[0].display.level',
          value: 'list',
        }),
      ]),
    );
  });

  it('fail-isolates dangling and malformed vendor overrides as issues', async () => {
    const vendorDir = path.join(tmpDir, 'vendors', 'pixel');
    await fs.mkdir(vendorDir, {recursive: true});
    await fs.writeFile(
      path.join(vendorDir, 'dangling.override.yaml'),
      [
        'extends: missing_skill',
        'meta:',
        '  vendor: pixel',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      path.join(vendorDir, 'malformed.override.yaml'),
      'extends: [not-a-string]\n',
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    expect(registry.getVendorOverrideCount()).toBe(0);
    expect(registry.getVendorOverrideLoadIssues()).toEqual([
      expect.objectContaining({
        kind: 'orphan',
        sourcePath: 'vendors/pixel/dangling.override.yaml',
        extends: 'missing_skill',
        reasonCode: 'vendor_override_base_missing',
      }),
      expect.objectContaining({
        kind: 'parse_failure',
        sourcePath: 'vendors/pixel/malformed.override.yaml',
        reasonCode: 'vendor_override_parse_failure',
      }),
    ]);
  });

  it('accepts a valid built-in vendor base after all skill roots load', async () => {
    await writeBaseSkill(tmpDir);
    const vendorDir = path.join(tmpDir, 'vendors', 'pixel');
    await fs.mkdir(vendorDir, {recursive: true});
    await fs.writeFile(
      path.join(vendorDir, 'startup.override.yaml'),
      [
        'extends: composite/startup_analysis',
        'meta:',
        '  vendor: pixel',
        'vendor_detection:',
        '  signatures:',
        '    - pattern: Pixel',
        '      confidence: high',
        'additional_steps: []',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    expect(registry.getVendorOverride('startup_analysis', 'pixel'))
      .toMatchObject({extends: 'startup_analysis', vendor: 'pixel'});
    expect(registry.getVendorOverrideLoadIssues()).toEqual([]);
  });

  it('does not allow an external pack skill to become a vendor base', async () => {
    const externalRoot = path.join(tmpDir, 'external-pack');
    await writeBaseSkill(externalRoot, 'external_base');
    const vendorDir = path.join(tmpDir, 'vendors', 'pixel');
    await fs.mkdir(vendorDir, {recursive: true});
    await fs.writeFile(
      path.join(vendorDir, 'external.override.yaml'),
      'extends: external_base\n',
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkillRoots([
      {rootPath: tmpDir, origin: 'built_in'},
      {
        rootPath: externalRoot,
        origin: 'external_pack',
        packId: 'test.pack',
        packVersion: '1.0.0',
      },
    ]);

    expect(registry.getVendorOverrideCount()).toBe(0);
    expect(registry.getVendorOverrideLoadIssues()).toEqual([
      expect.objectContaining({
        kind: 'orphan',
        extends: 'external_base',
        reasonCode: 'vendor_override_base_not_built_in',
      }),
    ]);
  });

  it('validates programmatically upserted skills and deduplicates repeated issues', () => {
    const registry = new SkillRegistry();
    const generatedSkill = {
      name: 'generated_display_bad',
      version: '1',
      meta: {
        display_name: 'Generated Display Bad',
        description: 'Generated runtime skill',
      },
      steps: [
        {
          id: 'rows',
          type: 'atomic',
          sql: 'SELECT 1 AS value',
          display: {
            layer: 'bytes',
          },
        },
      ],
    } as any;

    registry.upsertSkill(generatedSkill);
    registry.upsertSkill(generatedSkill);

    const issues = registry.getDisplayContractIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      skillName: 'generated_display_bad',
      stepId: 'rows',
      path: 'steps[0].display.layer',
      value: 'bytes',
    });
  });

  it('rejects an external pack Skill with a top-level key no loader reads', async () => {
    const compositeDir = path.join(tmpDir, 'composite');
    await fs.mkdir(compositeDir, {recursive: true});
    const write = (name: string, extra: string[]) => fs.writeFile(
      path.join(compositeDir, `${name}.skill.yaml`),
      [
        `name: ${name}`, 'version: "1"', 'type: composite', ...extra,
        'steps:', '  - id: rows', '    type: atomic', '    sql: SELECT 1 AS value', '',
      ].join('\n'),
      'utf-8',
    );
    const load = () => new SkillRegistry().loadSkillRoots([{
      rootPath: tmpDir, origin: 'external_pack', packId: 'keys-pack', packVersion: '1',
    }]);

    // The legacy spellings the loader folds into meta and output still load.
    await write('legacy_keys', ['description: Legacy description', 'tags: [legacy]', 'display:', '  level: summary']);
    await expect(load()).resolves.toBeUndefined();

    await write('dead_key', ['meta:', '  display_name: Dead', '  description: Dead key', 'thresholds:', '  rate: {levels: {}}']);
    await expect(load()).rejects.toThrow('skill_validation_failed:dead_key');

    // A built-in root only logs it: validate:skills is the gate there.
    await expect(new SkillRegistry().loadSkillRoots([{rootPath: tmpDir, origin: 'built_in'}])).resolves.toBeUndefined();
  });

  it('records a vendor override with a top-level key no loader reads as a parse failure', async () => {
    await writeBaseSkill(tmpDir);
    const vendorDir = path.join(tmpDir, 'vendors', 'pixel');
    await fs.mkdir(vendorDir, {recursive: true});
    await fs.writeFile(
      path.join(vendorDir, 'startup.override.yaml'),
      [
        'extends: composite/startup_analysis', 'version: "1"', 'meta:', '  vendor: pixel',
        'additional_steps:', '  - id: vendor_rows', '    type: atomic', '    sql: SELECT 1 AS value',
        'thresholds_override:', '  cold_start_time: {levels: {}}', '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await registry.loadSkills(tmpDir);

    expect(registry.getVendorOverrideCount()).toBe(0);
    expect(registry.getVendorOverrideLoadIssues()).toEqual([expect.objectContaining({
      kind: 'parse_failure',
      sourcePath: 'vendors/pixel/startup.override.yaml',
      reasonCode: 'vendor_override_parse_failure',
    })]);
  });

  it('rejects an invalid batch analysis contract from an external pack', async () => {
    const compositeDir = path.join(tmpDir, 'composite');
    await fs.mkdir(compositeDir, { recursive: true });
    await fs.writeFile(
      path.join(compositeDir, 'invalid_batch.skill.yaml'),
      [
        'name: invalid_batch',
        'version: "1"',
        'type: composite',
        'meta:',
        '  display_name: Invalid Batch',
        '  description: Invalid external contract',
        'batch_analysis:',
        '  operation: heap_path_cluster',
        '  source_step: missing',
        '  output_contract: HeapPathClusterAnalysisV1',
        '  per_trace_row_limit: 10',
        '  total_row_limit: 20',
        '  required_columns: [path]',
        'steps:',
        '  - id: rows',
        '    type: atomic',
        '    sql: SELECT 1 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );

    const registry = new SkillRegistry();
    await expect(registry.loadSkillRoots([{
      rootPath: tmpDir,
      origin: 'external_pack',
      packId: 'invalid-pack',
      packVersion: '1',
    }])).rejects.toThrow('skill_validation_failed:invalid_batch');
  });

  it('loads an external pack whose conditions read only declared or local names', async () => {
    const atomicDir = path.join(tmpDir, 'atomic');
    await fs.mkdir(atomicDir, {recursive: true});
    const write = (name: string, condition: string, inputs: string[] = []) => fs.writeFile(
      path.join(atomicDir, `${name}.skill.yaml`),
      [
        `name: ${name}`,
        'version: "1"',
        'type: composite',
        'meta:',
        `  display_name: ${name}`,
        '  description: Condition reference contract',
        ...(inputs.length ? ['inputs:', ...inputs.flatMap(input => [`  - name: ${input}`, '    type: number'])] : []),
        'steps:',
        '  - id: rows',
        '    type: atomic',
        `    condition: ${JSON.stringify(condition)}`,
        '    sql: SELECT 1 AS value',
        '',
      ].join('\n'),
      'utf-8',
    );
    const load = () => new SkillRegistry().loadSkillRoots([{
      rootPath: tmpDir, origin: 'external_pack', packId: 'condition-pack', packVersion: '1',
    }]);

    await write('local_names', "(window => window > 0)(1) && ({console: 1}).console === 1 && parseFloat('2') > 1");
    // A whole `${…}` without a default is JavaScript, where globals and literals are bound.
    await write('whole_placeholder', '${Math.PI > 3}');
    await write('declared_window', 'window > 0', ['window']);
    await expect(load()).resolves.toBeUndefined();

    await write('free_name', "(() => { if (true) /'/; return undeclared_value > 0; })()");
    await expect(load()).rejects.toThrow('skill_validation_failed:free_name');
    await fs.rm(path.join(atomicDir, 'free_name.skill.yaml'));

    // Embedded in text, `${Math.PI}` is a path resolved through Skill scopes,
    // which bind no global: the condition evaluates as ' > 3'.
    await write('embedded_global', '${Math.PI} > 3');
    await expect(load()).rejects.toThrow('skill_validation_failed:embedded_global');
  });
});
