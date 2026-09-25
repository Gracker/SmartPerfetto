// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SkillDefinition} from '../services/skillEngine/types';
import type {StrategyDefinition} from './strategyLoader';

/**
 * Strategy → Skill call contract: the `invoke_skill("name", {...})` examples a
 * strategy may contain. `validate:strategies` and the Self-Evolution
 * in-process validator both check strategy text through `checkStrategySkillCalls`.
 */

export interface StrategySkillCall {
  skillId: string;
  /** Top-level keys of a flat `{...}` argument literal; empty when the call has none. */
  argKeys: string[];
  line: number;
}

export type StrategySkillInputs = Pick<SkillDefinition, 'inputs'>;

export type StrategySkillCallFinding =
  | {kind: 'skill_missing'; call: StrategySkillCall}
  | {
      kind: 'param_undeclared';
      call: StrategySkillCall;
      undeclared: string[];
      declared: string[];
    };

// Argument grammar matches the Perfetto-Skills exporter (`SKILL_CALL` /
// `object_keys` in tools/export_from_smartperfetto.py). Names stay broader than
// its `\w+` so a malformed name is reported missing instead of skipped.
const STRATEGY_SKILL_CALL = /\binvoke_skill\(\s*(["'])([^"'\n]+)\1(?:\s*,\s*(\{[^{}]*\}))?/g;

function objectKeys(literal: string): string[] {
  const unquoted = literal.replace(/"[^"]*"|'[^']*'/g, '""');
  return [...new Set([...unquoted.matchAll(/[{,]\s*(\w+)\s*(?=[:,}])/g)].map(key => key[1]))];
}

export function extractStrategySkillCalls(content: string): StrategySkillCall[] {
  const calls: StrategySkillCall[] = [];
  let line = 1;
  let scanned = 0;
  for (const match of content.matchAll(STRATEGY_SKILL_CALL)) {
    for (; scanned < match.index; scanned++) if (content[scanned] === '\n') line++;
    calls.push({skillId: match[2], argKeys: match[3] ? objectKeys(match[3]) : [], line});
  }
  return calls;
}

/** Every text of a loaded strategy that may carry `invoke_skill` examples, keyed by path. */
export function strategySkillCallTexts(
  definition: Pick<StrategyDefinition, 'content' | 'detailSections' | 'phaseHints'>,
): Array<[path: string, content: string]> {
  return [
    ['content', definition.content],
    ...definition.detailSections.map((section): [string, string] =>
      [`detailSections.${section.id}`, section.content]),
    ...definition.phaseHints.map((hint): [string, string] =>
      [`phaseHints.${hint.id}.constraints`, hint.constraints]),
  ];
}

/**
 * Every call that names an unknown Skill or passes a key the Skill does not
 * declare as an input.
 *
 * Deliberately stricter than `invoke_skill`, which also admits process-identity
 * aliases through the identity gate: that rewrite only binds after a verified
 * resolution, and the exported portable runner binds declared inputs only, so
 * an example written with an alias runs unscoped there.
 */
export function checkStrategySkillCalls(
  calls: readonly StrategySkillCall[],
  skills: ReadonlyMap<string, StrategySkillInputs>,
): StrategySkillCallFinding[] {
  return calls.flatMap((call): StrategySkillCallFinding[] => {
    const skill = skills.get(call.skillId);
    if (!skill) return [{kind: 'skill_missing', call}];
    const declared = (skill.inputs ?? []).map(input => input.name);
    const undeclared = call.argKeys.filter(key => !declared.includes(key)).sort();
    return undeclared.length === 0 ? [] : [{kind: 'param_undeclared', call, undeclared, declared}];
  });
}

export function formatUndeclaredStrategySkillParams(
  finding: Extract<StrategySkillCallFinding, {kind: 'param_undeclared'}>,
): string {
  return `line ${finding.call.line}: invoke_skill("${finding.call.skillId}") passes ${finding.undeclared.join(', ')}, `
    + `not declared in its inputs [${finding.declared.join(', ')}]`;
}
