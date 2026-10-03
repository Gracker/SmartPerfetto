// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillType } from './types';

/** What the executor runs of each Skill type besides an atomic Skill's root SQL; a new type must say. */
const RUNS: Record<SkillType, 'steps' | 'none'> = {
  atomic: 'steps', composite: 'steps', deep: 'steps', iterator: 'steps', diagnostic: 'steps',
  ai_decision: 'steps', ai_summary: 'steps', pipeline: 'steps',
  conditional: 'none', pipeline_definition: 'none', comparison: 'none',
};

/**
 * What SkillExecutor runs of a Skill: an atomic Skill with root SQL runs that
 * SQL and never its steps; the step types run their steps; anything else
 * (comparison, pipeline_definition) runs nothing.
 */
export function skillExecution(skill: any): 'root' | 'steps' | 'none' {
  if (skill?.type === 'atomic' && skill.sql) return 'root';
  const type = skill?.type;
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(RUNS, type) ? RUNS[type as SkillType] : 'none';
}

/**
 * A step node, where it sits (`at`: its position, `steps[2].conditions[0].then`,
 * unique in its Skill) and how a finding names it (`name`: its id, or its
 * position when it has none). Two nodes can share a name (an id written like
 * a position), so anything that relates nodes keys by `node`, never by name.
 */
export interface StepNode {
  node: any;
  at: string;
  name: string;
  /** Whether the step may not run when the Skill runs: it, or a step around it, has a `condition` or is a conditional branch. */
  guarded: boolean;
}

/**
 * Every step under a Skill (or a step), in order, with or without an id: its
 * nested `steps` and inline conditional branches, at any depth. It reads
 * parsed YAML as well as typed definitions, so a malformed list is skipped.
 */
export function stepNodesOf(node: any, prefix = '', guarded = false): StepNode[] {
  if (!node || typeof node !== 'object') return [];
  const children: Array<[unknown, string, boolean]> = [
    ...(Array.isArray(node.steps) ? node.steps : []).map((step: unknown, index: number) => [step, `${prefix}steps[${index}]`, guarded]),
    ...(Array.isArray(node.conditions) ? node.conditions : [])
      .map((condition: any, index: number) => [condition?.then, `${prefix}conditions[${index}].then`, true]),
    [node.else, `${prefix}else`, true],
  ] as Array<[unknown, string, boolean]>;
  return children.filter(([child]) => child && typeof child === 'object').flatMap(([child, at, branch]) => {
    const step = child as any;
    const stepGuarded = branch || step.condition !== undefined;
    return [
      {node: step, at, name: typeof step.id === 'string' && step.id ? step.id : at, guarded: stepGuarded},
      ...stepNodesOf(step, `${at}.`, stepGuarded),
    ];
  });
}
