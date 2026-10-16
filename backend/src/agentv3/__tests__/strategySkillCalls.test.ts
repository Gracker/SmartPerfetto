// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  checkStrategySkillCalls,
  extractStrategySkillCalls,
  formatUndeclaredStrategySkillParams,
  type StrategySkillInputs,
} from '../strategySkillCalls';

const text = [
  'Run `invoke_skill("jank_frame_detail", { start_ts, end_ts, process_name: "<包名, 或 a:b>" })` first.',
  "invoke_skill('pipeline_key_slices_overlay', {",
  '  slice_names: "\'DrawFrame\',\'syncFrameState\'",',
  '  package: <package hint>',
  '})',
  'invoke_skill("cpu_analysis") then invoke_skill("bad-name")',
].join('\n');

const inputs = (...names: string[]) =>
  ({inputs: names.map(name => ({name, type: 'string' as const, required: false}))});

describe('strategy invoke_skill examples', () => {
  it('parses names, flat argument keys and lines like the portable exporter', () => {
    expect(extractStrategySkillCalls(text)).toEqual([
      {skillId: 'jank_frame_detail', argKeys: ['start_ts', 'end_ts', 'process_name'], line: 1},
      {skillId: 'pipeline_key_slices_overlay', argKeys: ['slice_names', 'package'], line: 2},
      {skillId: 'cpu_analysis', argKeys: [], line: 6},
      {skillId: 'bad-name', argKeys: [], line: 6},
    ]);
  });

  it('rejects identity aliases the Skill accepts only through the identity gate', () => {
    const calls = extractStrategySkillCalls(text);
    const findings = (inputs: StrategySkillInputs) =>
      checkStrategySkillCalls([calls[0]], new Map([['jank_frame_detail', inputs]]));
    expect(findings(inputs('start_ts', 'end_ts', 'package'))).toEqual([
      expect.objectContaining({kind: 'param_undeclared', undeclared: ['process_name']}),
    ]);
    expect(findings({})).toEqual([expect.objectContaining({
      kind: 'param_undeclared',
      undeclared: ['end_ts', 'process_name', 'start_ts'],
      declared: [],
    })]);
    expect(checkStrategySkillCalls([calls[2]], new Map([['cpu_analysis', {}]]))).toEqual([]);
  });

  it('reports missing Skills and undeclared keys as one finding list', () => {
    const findings = checkStrategySkillCalls(extractStrategySkillCalls(text), new Map<string, StrategySkillInputs>([
      ['jank_frame_detail', inputs('start_ts', 'end_ts', 'package')],
      ['pipeline_key_slices_overlay', inputs('slice_names', 'package')],
      ['cpu_analysis', {}],
    ]));
    expect(findings).toEqual([
      {
        kind: 'param_undeclared',
        call: expect.objectContaining({skillId: 'jank_frame_detail', line: 1}),
        undeclared: ['process_name'],
        declared: ['start_ts', 'end_ts', 'package'],
      },
      {kind: 'skill_missing', call: expect.objectContaining({skillId: 'bad-name', line: 6})},
    ]);
    expect(findings[0].kind === 'param_undeclared' && formatUndeclaredStrategySkillParams(findings[0])).toBe(
      'line 1: invoke_skill("jank_frame_detail") passes process_name, not declared in its inputs [start_ts, end_ts, package]',
    );
  });
});
