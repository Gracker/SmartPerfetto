// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

jest.mock('commander', () => ({
  Command: class {
    description() { return this; }
    argument() { return this; }
    option() { return this; }
    action() { return this; }
  },
}));

import {
  validateStrategyFrontmatter,
  type StrategyFrontmatterValidationContext,
} from '../commands/validate';
import {parseInvestigationProfiles} from '../../agentv3/strategyLoader';
import type {SkillDefinition} from '../../services/skillEngine/types';
import {admitInvestigationEntryProducer} from '../../agentv3/entrySkillPolicy';
import {readSkillFragments} from '../../services/skillEngine/skillFragments';
import {getExactProcessScopeSupport} from '../../services/skillEngine/processScopeSql';
import type {AnalysisInvestigationEntryAcquisition} from '../../types/analysisInvestigation';

describe('selected investigation entry producer admission', () => {
  const skillsDir = path.resolve(__dirname, '../../../skills');
  const original = yaml.load(fs.readFileSync(path.join(skillsDir, 'atomic/thread_system_summary_in_range.skill.yaml'), 'utf8')) as SkillDefinition;
  const fragments = readSkillFragments(skillsDir);
  const entry: AnalysisInvestigationEntryAcquisition = {schemaVersion: 1,
    metricId: original.investigation_evidence!.metrics[0].metric_id, subjectBinding: 'selected_thread_interval',
    params: {start_ts: 'selected_start', end_ts: 'selected_end', upid: 'selected_upid', utid: 'selected_utid'}};
  const registry = (skill: SkillDefinition = original) => new Map([[skill.name, skill]]);
  const admit = (skill: SkillDefinition = original, cache: ReadonlyMap<string, string> = fragments) =>
    admitInvestigationEntryProducer(entry, registry(skill), cache);
  const refused = (result: ReturnType<typeof admit>) => {
    expect(result.status).toBe('not_admitted');
    if (result.status !== 'not_admitted') throw new Error('expected refusal');
    return result;
  };

  it('admits the current producer with composed CTE fragments and equally admits a renamed producer', () => {
    expect(admit()).toMatchObject({status: 'admitted', skill: {name: original.name}, declaration: original.investigation_evidence});
    expect(admit({...original, name: 'unrelated_registered_name'})).toMatchObject({status: 'admitted', skill: {name: 'unrelated_registered_name'}});
    // UPID is an actual identity-gate selector, not a fabricated ordinary input.
    expect(original.inputs?.some(input => input.name === 'upid')).toBe(false);
  });

  it('rejects missing and ambiguous producers without picking a sorted winner', () => {
    expect(refused(admitInvestigationEntryProducer(entry, new Map(), fragments)).reason).toBe('producer_unavailable');
    const second = {...original, name: 'another_producer'};
    expect(refused(admitInvestigationEntryProducer(entry, new Map([[original.name, original], [second.name, second]]), fragments)).reason)
      .toBe('producer_ambiguous');
    expect(refused(admit({...original, investigation_evidence: undefined})).reason).toBe('producer_unavailable');
  });

  it.each(['optional', 'condition', 'substep', 'snapshot'] as const)('rejects a producer outside the narrow atomic root contract: %s', kind => {
    const skill = kind === 'substep' ? {...original, type: 'composite', sql: undefined, investigation_evidence: undefined,
      steps: [{id: 'nested', type: 'atomic', sql: original.sql, sql_fragments: original.sql_fragments, investigation_evidence: original.investigation_evidence}]}
      : kind === 'snapshot' ? {...original, source: 'analysis_result_snapshot'} : {...original, [kind]: kind === 'optional' ? true : 'true'};
    expect(refused(admit(skill as SkillDefinition)).reason).toBe('producer_unavailable');
  });

  it('rejects missing native subject metadata, implicit thread guessing and unsatisfied required params', () => {
    expect(refused(admit({...original, investigation_evidence: {...original.investigation_evidence!, identity: {upid: 'upid'}}})).reason)
      .toBe('binding_unsupported');
    expect(refused(admit({...original, inputs: original.inputs!.filter(input => input.name !== 'utid')})).reason).toBe('binding_unsupported');
    expect(refused(admit({...original, inputs: [...original.inputs!, {name: 'unbound', type: 'integer', required: true}]})).reason)
      .toBe('binding_unsupported');
    expect(admit({...original, inputs: [...original.inputs!, {name: 'defaulted', type: 'integer', required: true, default: 0}]}).status)
      .toBe('admitted');
    expect(refused(admit({...original, identity: {policy: 'none'}, process_scope: {role: 'global_context'}})).reason).toBe('binding_unsupported');
    expect(refused(admitInvestigationEntryProducer({...entry, params: {...entry.params, upid: 'selected_utid'}}, registry(), fragments)).reason)
      .toBe('binding_unsupported');
    const {upid: _upid, ...rest} = entry.params;
    expect(refused(admitInvestigationEntryProducer({...entry, params: {...rest, pid: 'selected_upid'}}, registry(), fragments)).reason)
      .toBe('binding_unsupported');
  });

  it('checks the supplied pin for missing or unsafe fragments rather than reading the built-in cache', () => {
    expect(refused(admit({...original, sql: 'DELETE FROM slice'})).errors.some(error => error.includes('may modify trace processor state'))).toBe(true);
    const key = original.sql_fragments![0];
    const missing = new Map(fragments); missing.delete(key);
    expect(refused(admit(original, missing)).errors.some(error => error.includes(`missing fragment ${key}`))).toBe(true);
    const unsafe = new Map(fragments); unsafe.set(key, 'injected AS (SELECT 1); DELETE FROM slice; WITH other AS (SELECT 1)');
    expect(refused(admit(original, unsafe)).errors.some(error => error.includes('may modify trace processor state'))).toBe(true);
    expect(admit(original, fragments).status).toBe('admitted');
  });

  it.each(['sql', 'fragment', 'missing_fragment'] as const)('checks declared exact SQL including its own fragments: %s', kind => {
    const key = 'fragments/exact_extra.sql';
    const cache = new Map(fragments);
    if (kind === 'fragment') cache.set(key, 'extra AS (SELECT 1); DELETE FROM slice; WITH next AS (SELECT 1)');
    const skill: SkillDefinition = {...original, exact_sql: {sql: kind === 'sql' ? `${original.sql}; DELETE FROM slice` : original.sql!,
      process_scope: original.process_scope!, sql_fragments: [...original.sql_fragments!, ...(kind === 'sql' ? [] : [key])]}};
    const result = refused(admit(skill, cache));
    expect(result.errors.some(error => error.includes(kind === 'missing_fragment' ? 'missing fragment' : 'may modify trace processor state'))).toBe(true);
  });

  it.each(['global_context', 'peer_context'] as const)('rejects actual exact SQL with context-only scope: %s', role => {
    const skill: SkillDefinition = {...original, exact_sql: {sql: 'SELECT 1', process_scope: {role}}};
    expect(getExactProcessScopeSupport(skill, registry(skill), fragments).supported).toBe(true);
    expect(refused(admit(skill)).reason).toBe('binding_unsupported');
  });

  it.each([false, true])('rejects an exact-unavailable target source (override: %s)', override => {
    const unavailable = {...original.process_scope!, exact_unavailable: 'This source cannot bind an exact process'};
    const skill: SkillDefinition = override ? {...original, exact_sql: {sql: original.sql!,
      sql_fragments: original.sql_fragments, process_scope: unavailable}} : {...original, process_scope: unavailable};
    expect(getExactProcessScopeSupport(skill, registry(skill), fragments)).toMatchObject({supported: true, partial: true});
    expect(refused(admit(skill)).reason).toBe('binding_unsupported');
  });

  it('admits a complete exact target override with the same pinned fragments', () => {
    const skill: SkillDefinition = {...original, exact_sql: {sql: original.sql!,
      sql_fragments: original.sql_fragments, process_scope: original.process_scope!}};
    expect(admit(skill).status).toBe('admitted');
  });

  it('wires the same admission into CLI frontmatter validation with an explicit fragment cache', () => {
    const content = frontmatter(`scene: linux\ninvestigation_contract:\n  schema_version: 1\n  requirements:\n    - id: selected_work\n      domain: thread_state\n      description: Work\n      evidence_metrics: [${entry.metricId}]\n      entry_acquisition:\n        schema_version: 1\n        metric_id: ${entry.metricId}\n        subject_binding: selected_thread_interval\n        params: {start_ts: selected_start, end_ts: selected_end, upid: selected_upid, utid: selected_utid}`);
    expect(validateStrategyFrontmatter(content, 'selected.strategy.md', {skillDefinitions: registry(), skillFragments: fragments})).toEqual([]);
    expect(validateStrategyFrontmatter(content, 'selected.strategy.md', {skillDefinitions: registry()}))
      .toContain('selected.strategy.md: entry_acquisition requires the pinned fragment cache');
    expect(validateStrategyFrontmatter(content, 'selected.strategy.md', {skillDefinitions: registry(), skillFragments: new Map()}))
      .toEqual(expect.arrayContaining([expect.stringContaining('missing fragment')]));
  });
});

function frontmatter(yamlBody: string): string {
  return `---\n${yamlBody.trim()}\n---\n\nBody`;
}

function validationContext(): StrategyFrontmatterValidationContext {
  return {
    knownScenes: new Set([
      'scrolling',
      'pipeline',
      'startup',
      'touch_tracking',
      'scroll_response',
      'interaction',
    ]),
    seenVerifierMisdiagnosisIds: new Map(),
  };
}

describe('removed strategy frontmatter fields', () => {
  it.each(['phase_hints', 'plan_template'])('rejects a strategy that declares %s', key => {
    const errors = validateStrategyFrontmatter(
      frontmatter(`scene: startup\n${key}:\n  - id: legacy`),
      'legacy.strategy.md',
    );
    expect(errors).toContain(
      `legacy.strategy.md: ${key} was removed and has no effect; use investigation_contract for evidence obligations`,
    );
  });
});

describe('semantic final report requirements', () => {
  const contract = (extra: string) => frontmatter(`scene: startup
final_report_contract:
  required_sections:
    - id: observations
      label: Observations
      ${extra}`);
  it('accepts a semantic requirement without inert legacy heading patterns', () => {
    expect(validateStrategyFrontmatter(contract('description: Explain observed actions and their uncertainty'), 'semantic.strategy.md')).toEqual([]);
  });
  it.each(['description: "   "', 'description: 42'])('rejects an empty or invalid semantic declaration: %s', extra => {
    expect(validateStrategyFrontmatter(contract(extra), 'bad.strategy.md').length).toBeGreaterThan(0);
  });
  it('still validates supplied legacy regex and description types', () => {
    expect(validateStrategyFrontmatter(contract('description: Explain observations\n      patterns: ["["]'), 'bad.strategy.md'))
      .toEqual(expect.arrayContaining([expect.stringContaining('not a valid JavaScript regex')]));
    expect(validateStrategyFrontmatter(contract('description: 42\n      patterns: ["observed"]'), 'bad.strategy.md'))
      .toEqual(expect.arrayContaining([expect.stringContaining('description must be a string')]));
  });
});

describe('validateStrategyFrontmatter investigation contracts', () => {
  it('requires explicit contracts in the builtin validation gate while reading legacy fixtures', () => {
    const content = frontmatter('scene: startup');
    expect(validateStrategyFrontmatter(content, 'legacy.strategy.md')).toEqual([]);
    expect(validateStrategyFrontmatter(content, 'builtin.strategy.md', {requireInvestigationContract: true}))
      .toEqual(['builtin.strategy.md: investigation_contract is required']);
  });

  it('validates pinned profile references and rejects unknown versions', () => {
    const investigationProfiles = parseInvestigationProfiles({schema_version: 1, profiles: {
      shared: {version: 1, requirements: [{id: 'task', domain: 'execution', description: 'Explain the selected task'}]},
    }});
    const valid = frontmatter('scene: startup\ninvestigation_contract:\n  schema_version: 1\n  profiles: [{id: shared, version: 1}]');
    expect(validateStrategyFrontmatter(valid, 'valid.strategy.md', {investigationProfiles, requireInvestigationContract: true})).toEqual([]);
    expect(validateStrategyFrontmatter(valid.replace('version: 1}', 'version: 2}'), 'bad.strategy.md', {investigationProfiles}))
      .toEqual(['bad.strategy.md: strategy_investigation_profile_unavailable']);
  });

  it('rejects malformed historical string lists instead of silently accepting partial obligations', () => {
    expect(validateStrategyFrontmatter(frontmatter('scene: startup\ninvestigation_requirements: [valid, 7]'), 'bad.strategy.md'))
      .toContain('bad.strategy.md: invalid legacy investigation_requirements');
  });
});

describe('validateStrategyFrontmatter verifier_misdiagnosis_patterns', () => {
  it('accepts valid scene-scoped and global verifier rules', () => {
    const content = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: valid_scene_rule
    type: known_misdiagnosis
    scenes: [scrolling, pipeline]
    severity: info
    patterns:
      - 'Buffer Stuffing.*critical'
    message: 'Buffer Stuffing needs pipeline attribution'
  - id: valid_global_rule
    type: known_misdiagnosis
    global: true
    patterns:
      - 'single frame'
    message: 'Single frame should not be critical by itself'
`);

    expect(validateStrategyFrontmatter(content, 'valid.strategy.md', validationContext())).toEqual([]);
  });

  it('rejects invalid regex, missing message, invalid severity, invalid type, and unknown scenes', () => {
    const content = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: broken_rule
    type: severity_mismatch
    scenes: [scrolling, typo_scene]
    severity: error
    patterns:
      - '('
`);

    const errors = validateStrategyFrontmatter(content, 'broken.strategy.md', validationContext());
    expect(errors.join('\n')).toContain('type must be known_misdiagnosis');
    expect(errors.join('\n')).toContain('message must be a non-empty string');
    expect(errors.join('\n')).toContain('severity must be one of warning, info');
    expect(errors.join('\n')).toContain('is not a valid JavaScript regex');
    expect(errors.join('\n')).toContain('references unknown or contract-only scene "typo_scene"');
  });

  it('rejects duplicate ids across files and ambiguous global-plus-scenes scope', () => {
    const context = validationContext();
    const first = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: duplicated_rule
    type: known_misdiagnosis
    scenes: [scrolling]
    patterns: ['VSync']
    message: 'First rule'
`);
    const duplicate = frontmatter(`
scene: verifier_misdiagnosis
strategy_kind: contract_only
verifier_misdiagnosis_patterns:
  - id: duplicated_rule
    type: known_misdiagnosis
    global: true
    scenes: [pipeline]
    patterns: ['VSync']
    message: 'Duplicate rule'
`);

    expect(validateStrategyFrontmatter(first, 'first.strategy.md', context)).toEqual([]);
    const errors = validateStrategyFrontmatter(duplicate, 'second.strategy.md', context);
    expect(errors.join('\n')).toContain('duplicates "duplicated_rule" already declared in first.strategy.md');
    expect(errors.join('\n')).toContain('must declare either global: true or scenes, not both');
  });
});

describe('validateStrategyFrontmatter entry_skill', () => {
  const skill = (extra: Partial<SkillDefinition> = {}): SkillDefinition => ({
    name: 'entry_probe', version: '1.0', type: 'composite', meta: {display_name: 'Entry', description: 'Entry'},
    inputs: [
      {name: 'package', type: 'string', required: false},
      {name: 'start_ts', type: 'timestamp', required: false},
      {name: 'end_ts', type: 'timestamp', required: false},
      {name: 'limit', type: 'number', required: false},
    ],
    identity: {policy: 'verify_if_present', scope: 'process', aliases: ['package', 'process_name']},
    steps: [{id: 'overview', type: 'atomic', sql: 'SELECT 1 AS value'}],
    ...extra,
  } as SkillDefinition);
  const context = (definition?: SkillDefinition): StrategyFrontmatterValidationContext => ({
    ...validationContext(), skillDefinitions: new Map(definition ? [[definition.name, definition]] : []),
  });
  const declare = (params: string) => frontmatter(`scene: scrolling\nentry_skill:\n  id: entry_probe\n  params:\n${params}`);

  it('accepts closed bindings on declared inputs of an executable Skill', () => {
    expect(validateStrategyFrontmatter(declare('    package: focus_app\n    start_ts: trace_start\n    end_ts: trace_end'),
      'entry.strategy.md', context(skill()))).toEqual([]);
  });

  it('accepts a derived-view definition but refuses a writing SQL unit', () => {
    const view = skill({steps: [{id: 'fallback', type: 'atomic',
      sql: '-- empty view when the stdlib table is absent\nCREATE VIEW IF NOT EXISTS input_events AS SELECT 1 AS id'}] as any});
    expect(validateStrategyFrontmatter(declare('    package: focus_app'), 'entry.strategy.md', context(view))).toEqual([]);
    const writer = skill({steps: [{id: 'writer', type: 'atomic', sql: 'DELETE FROM slice'}] as any});
    expect(validateStrategyFrontmatter(declare('    package: focus_app'), 'entry.strategy.md', context(writer)))
      .toEqual(['entry.strategy.md: entry_skill entry_probe SQL unit writer may modify trace processor state']);
    const viewThenWrite = skill({steps: [{id: 'smuggle', type: 'atomic',
      sql: 'CREATE VIEW v AS SELECT 1; DROP TABLE slice'}] as any});
    expect(validateStrategyFrontmatter(declare('    package: focus_app'), 'entry.strategy.md', context(viewThenWrite)))
      .toEqual(['entry.strategy.md: entry_skill entry_probe SQL unit smuggle may modify trace processor state']);
  });

  it.each([
    ['an unknown binding', '    package: com.example.app', 'strategy_invalid_entry_skill'],
    ['two process bindings', '    package: focus_app\n    process_name: user_target', 'strategy_invalid_entry_skill'],
  ])('rejects %s at the schema', (_label, params, code) => {
    expect(validateStrategyFrontmatter(declare(params), 'entry.strategy.md', context(skill())))
      .toEqual([`entry.strategy.md: ${code}`]);
  });

  it('rejects unknown keys and a missing id', () => {
    expect(validateStrategyFrontmatter(frontmatter('scene: scrolling\nentry_skill:\n  id: entry_probe\n  when: always'),
      'entry.strategy.md', context(skill()))).toEqual(['entry.strategy.md: strategy_invalid_entry_skill']);
    expect(validateStrategyFrontmatter(frontmatter('scene: scrolling\nentry_skill:\n  params: {}'),
      'entry.strategy.md', context(skill()))).toEqual(['entry.strategy.md: strategy_invalid_entry_skill']);
  });

  it('rejects an unregistered, metadata-only or comparison Skill', () => {
    expect(validateStrategyFrontmatter(declare('    package: focus_app'), 'entry.strategy.md', context()))
      .toEqual(['entry.strategy.md: entry_skill entry_probe is not a registered Skill']);
    for (const type of ['pipeline_definition', 'comparison'] as const) {
      expect(validateStrategyFrontmatter(declare('    package: focus_app'), 'entry.strategy.md', context(skill({type} as any))))
        .toContain('entry.strategy.md: entry_skill entry_probe must be an executable single-trace atomic or composite Skill');
    }
  });

  it('rejects bindings on undeclared, non-selector or non-timestamp inputs', () => {
    expect(validateStrategyFrontmatter(declare('    missing: trace_start'), 'entry.strategy.md', context(skill())))
      .toEqual(['entry.strategy.md: entry_skill entry_probe binds undeclared input missing']);
    expect(validateStrategyFrontmatter(declare('    limit: trace_start'), 'entry.strategy.md', context(skill())))
      .toEqual(['entry.strategy.md: entry_skill entry_probe binds trace_start to limit, which is not a timestamp input']);
    expect(validateStrategyFrontmatter(declare('    limit: focus_app'), 'entry.strategy.md', context(skill())))
      .toEqual(['entry.strategy.md: entry_skill entry_probe binds focus_app to limit, which is not a process identity selector']);
  });

  it('requires a process binding when the Skill cannot run without a process', () => {
    const required = skill({identity: {policy: 'required', scope: 'process', aliases: ['package']}});
    expect(validateStrategyFrontmatter(declare('    start_ts: trace_start'), 'entry.strategy.md', context(required)))
      .toEqual(['entry.strategy.md: entry_skill entry_probe requires a process binding (focus_app or user_target)']);
  });

  it('refuses entry_skill on a contract_only strategy', () => {
    expect(validateStrategyFrontmatter(frontmatter('scene: scrolling\nstrategy_kind: contract_only\nentry_skill:\n  id: entry_probe'),
      'entry.strategy.md', context(skill()))).toEqual(['entry.strategy.md: entry_skill is not allowed on a contract_only strategy']);
  });
});
