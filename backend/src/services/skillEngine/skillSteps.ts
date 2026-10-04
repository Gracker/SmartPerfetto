// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillType } from './types';

/** What the executor runs of each Skill type besides an atomic Skill's root SQL; a new type must say. */
const RUNS: Record<SkillType, 'steps' | 'none'> = {
  atomic: 'steps', composite: 'steps', deep: 'steps', iterator: 'steps', diagnostic: 'steps',
  pipeline: 'steps',
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
  /**
   * The index in the walked node's `steps` of the step this node is or sits
   * under: what the executor's top-level loop records results by. Absent for a
   * node under the walked node's own conditional branches.
   */
  topLevelIndex?: number;
}

export interface StepWalkOptions {
  /** Only the walked node's direct children: its `steps` and inline branches, not what they hold. */
  topLevelOnly?: boolean;
  /**
   * The walked node is a Skill: only the steps the executor runs
   * (skillExecution), so none for root SQL or a Skill type that runs no steps.
   */
  executedOnly?: boolean;
}

/**
 * Every step under a Skill (or a step), in order, with or without an id: its
 * nested `steps` and inline conditional branches, at any depth. It reads
 * parsed YAML as well as typed definitions, so a malformed list is skipped.
 * This is the one step walk: a check that needs other semantics says so with
 * an option, never with a private recursion.
 */
export function stepNodesOf(node: any, options: StepWalkOptions = {}): StepNode[] {
  if (options.executedOnly && skillExecution(node) !== 'steps') return [];
  return walk(node, '', false, undefined, options.topLevelOnly === true);
}

function walk(node: any, prefix: string, guarded: boolean, topLevelIndex: number | undefined, shallow: boolean): StepNode[] {
  if (!node || typeof node !== 'object') return [];
  const atRoot = prefix === '';
  const children: Array<[unknown, string, boolean, number | undefined]> = [
    ...(Array.isArray(node.steps) ? node.steps : []).map((step: unknown, index: number) =>
      [step, `${prefix}steps[${index}]`, guarded, atRoot ? index : topLevelIndex]),
    ...(Array.isArray(node.conditions) ? node.conditions : [])
      .map((condition: any, index: number) => [condition?.then, `${prefix}conditions[${index}].then`, true, topLevelIndex]),
    [node.else, `${prefix}else`, true, topLevelIndex],
  ] as Array<[unknown, string, boolean, number | undefined]>;
  return children.filter(([child]) => child && typeof child === 'object' && !Array.isArray(child)).flatMap(([child, at, branch, top]) => {
    const step = child as any;
    const stepGuarded = branch || step.condition !== undefined;
    return [
      {node: step, at, name: typeof step.id === 'string' && step.id ? step.id : at, guarded: stepGuarded,
        ...(top !== undefined ? {topLevelIndex: top} : {})},
      ...(shallow ? [] : walk(step, `${at}.`, stepGuarded, top, false)),
    ];
  });
}

/** A Skill a step runs: a Skill reference, an iterator's item Skill, or a conditional branch named by id. */
export interface StepSkillReference {
  skillId: string;
  /** The step node holding the reference (for a branch, the conditional step). */
  step: StepNode;
  /** Where the reference is written: `steps[1]`, `steps[2].conditions[0].then`. */
  at: string;
}

/**
 * Every Skill the steps under `node` run, in order (stepNodesOf with the same
 * options): `skill` and `item_skill`, and a conditional branch written as a
 * Skill id, which the executor runs as a Skill reference.
 */
export function stepSkillReferences(node: any, options: StepWalkOptions = {}): StepSkillReference[] {
  return stepNodesOf(node, options).flatMap((step): StepSkillReference[] => {
    const own = [step.node.skill, step.node.item_skill]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map(skillId => ({skillId, step, at: step.at}));
    const branches: Array<[unknown, string]> = [
      ...(Array.isArray(step.node.conditions) ? step.node.conditions : [])
        .map((condition: any, index: number): [unknown, string] => [condition?.then, `${step.at}.conditions[${index}].then`]),
      [step.node.else, `${step.at}.else`],
    ];
    return [...own, ...branches
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && entry[0] !== '')
      .map(([skillId, at]) => ({skillId, step, at}))];
  });
}

/** A JavaScript condition the executor evaluates for a step (ExpressionEvaluator.evaluateCondition). */
export interface StepConditionExpression {
  /** As written; a caller checks it is a string. */
  text: unknown;
  kind: 'condition' | 'when' | 'rule';
  step: StepNode;
  /** Where it is written: `steps[1].condition`, `steps[2].conditions[0].when`, `steps[3].rules[0].condition`. */
  at: string;
}

/**
 * Every condition the executor evaluates for the steps under `node`
 * (stepNodesOf with the same options): a step's own `condition`, a conditional
 * branch's `when` and a diagnostic rule's `condition`. Each runs as JavaScript
 * as written; only an iterator `filter` has AND/OR rewritten first.
 */
export function stepConditionExpressions(node: any, options: StepWalkOptions = {}): StepConditionExpression[] {
  return stepNodesOf(node, options).flatMap((step): StepConditionExpression[] => [
    ...(step.node.condition !== undefined ? [{text: step.node.condition, kind: 'condition' as const, step, at: `${step.at}.condition`}] : []),
    ...(Array.isArray(step.node.conditions) ? step.node.conditions : []).map((branch: any, index: number) =>
      ({text: branch?.when, kind: 'when' as const, step, at: `${step.at}.conditions[${index}].when`})),
    ...(Array.isArray(step.node.rules) ? step.node.rules : []).map((rule: any, index: number) =>
      ({text: rule?.condition, kind: 'rule' as const, step, at: `${step.at}.rules[${index}].condition`})),
  ]);
}
