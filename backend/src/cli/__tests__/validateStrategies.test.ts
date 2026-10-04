// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

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
