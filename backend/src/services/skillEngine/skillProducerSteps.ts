// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The authored step whose SQL produced a result, and what a diagnostic rule's
 * `binds` read from such a step. One resolver serves the validator (which
 * rejects a bind it cannot resolve) and the executor (which reports the bound
 * value with the unit resolved here), so a bound unit always comes from the
 * producing column's declaration and never from the rule.
 */

import {isValidColumnUnit} from '../../types/dataContract';
import {skillRootDisplay} from './displayContractValidator';
import {parseEvidenceField, type EvidenceFieldPath} from './expressionUtils';
import {skillExecution, stepNodesOf} from './skillSteps';
import type {DiagnosticRuleBind, DisplayConfig, SkillDefinition, SkillDisplayColumn} from './types';
import type {InvestigationEvidenceDeclaration} from '../evidence/investigationEvidenceLedger';

/** `<skill stem>.<condition>`, with one optional family segment between them. */
export const DIAGNOSTIC_RULE_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2}$/;
const BIND_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Column types whose values are quantities: a bind reading one needs the column's unit. */
const QUANTITY_COLUMN_TYPES: ReadonlySet<string> = new Set(['number', 'timestamp', 'duration', 'percentage', 'bytes']);
/** Scalar column types that carry no unit. */
const LABEL_COLUMN_TYPES: ReadonlySet<string> = new Set(['string', 'boolean', 'enum', 'link']);
/** Row scopes whose every row is already an aggregate over the window, so picking one by a predicate is sound. */
const AGGREGATE_ROW_SEMANTICS: ReadonlySet<string> = new Set(['window_total', 'per_entity']);

/** An authored SQL producer: an atomic step, or an atomic Skill's root (`stepId` = `root`). */
export interface SkillProducerStep {
  readonly skillId: string;
  readonly stepId: string;
  readonly display?: DisplayConfig;
  readonly investigationEvidence?: InvestigationEvidenceDeclaration;
}

type SkillLookup = (skillId: string) => SkillDefinition | undefined;

function displayOf(value: unknown): DisplayConfig | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as DisplayConfig : undefined;
}

/** The atomic producer `stepId` names in `skill`, or undefined when it names none. */
export function skillProducerStep(skill: SkillDefinition | undefined, stepId: string): SkillProducerStep | undefined {
  if (!skill) return undefined;
  if (stepId === 'root') {
    if (skillExecution(skill) !== 'root') return undefined;
    return {skillId: skill.name, stepId, display: displayOf(skillRootDisplay(skill)),
      ...(skill.investigation_evidence ? {investigationEvidence: skill.investigation_evidence} : {})};
  }
  const matches = stepNodesOf(skill, {executedOnly: true}).filter(({node}) => node?.id === stepId);
  const node = matches.length === 1 ? matches[0].node : undefined;
  if (node?.type !== 'atomic') return undefined;
  return {skillId: skill.name, stepId, display: displayOf(node.display),
    ...(node.investigation_evidence ? {investigationEvidence: node.investigation_evidence} : {})};
}

/** A producer's authored column definition by name; a string shorthand declares no type. */
export function producerColumn(producer: SkillProducerStep, column: string): SkillDisplayColumn | undefined {
  const columns = producer.display?.columns;
  if (!Array.isArray(columns)) return undefined;
  for (const entry of columns) {
    if (typeof entry === 'string' && entry === column) return {name: entry};
    if (entry && typeof entry === 'object' && entry.name === column) return entry;
  }
  return undefined;
}

export type DiagnosticBindResolution =
  | {ok: true; path: EvidenceFieldPath; sourceStepId: string; unit?: string}
  | {ok: false; code: string; message: string};

const failure = (code: string, message: string): DiagnosticBindResolution => ({ok: false, code, message});

/**
 * Where a rule's bind reads its value and in what unit. The field is the
 * read-only evidence-field dialect narrowed to one row's column:
 * `input.data[n].column` or `input.data.find(r => r.c OP literal).column`.
 * The root names a step of `skill` (its id or its `save_as`); a Skill
 * reference binds through its `save_from`, or the root of an atomic child.
 * `find()` picks a row by a predicate, so it may read only a producer whose
 * rows are aggregates (`row_semantics` window_total or per_entity): a picked
 * per-event row is one arbitrary event, not a value of the window.
 */
export function resolveDiagnosticBind(
  skill: SkillDefinition,
  bind: DiagnosticRuleBind,
  lookupSkill: SkillLookup,
): DiagnosticBindResolution {
  if (!bind || typeof bind !== 'object' || typeof bind.name !== 'string' || !BIND_NAME_PATTERN.test(bind.name)) {
    return failure('diagnostic_bind_invalid', 'A bind needs a lower_snake_case name.');
  }
  const path = typeof bind.field === 'string' ? parseEvidenceField(bind.field) : undefined;
  const [pick, read] = path?.accesses ?? [];
  if (!path || path.accesses.length !== 2 || (pick.kind !== 'index' && pick.kind !== 'find') ||
      read.kind !== 'property' || read.name === 'length') {
    return failure('diagnostic_bind_field_shape',
      'A bind field reads one row\'s column: `input.data[n].column` or `input.data.find(r => r.c OP literal).column`.');
  }
  const candidates = stepNodesOf(skill).filter(({node}) => node?.save_as === path.root || node?.id === path.root);
  const named = candidates.filter(({node}) => node?.save_as === path.root);
  const sources = named.length ? named : candidates;
  if (sources.length !== 1) {
    return failure('diagnostic_bind_source_ambiguous',
      `Bind root '${path.root}' must name exactly one step of this Skill.`);
  }
  const source = sources[0].node;
  let producer: SkillProducerStep | undefined;
  if (source.type === 'atomic') {
    producer = skillProducerStep(skill, source.id);
  } else if (typeof source.skill === 'string' && (source.type === undefined || source.type === 'skill')) {
    const child = lookupSkill(source.skill);
    if (typeof source.save_from === 'string' && source.save_as === path.root) {
      producer = skillProducerStep(child, source.save_from);
    } else if (child && skillExecution(child) === 'root') {
      producer = skillProducerStep(child, 'root');
    }
  }
  if (!producer) {
    return failure('diagnostic_bind_source_unsupported',
      `Bind root '${path.root}' must be an atomic step, or a Skill reference whose save_as binds an atomic `
      + 'child step through save_from (or an atomic child Skill\'s root SQL).');
  }
  const column = producerColumn(producer, read.name);
  const type = typeof column?.type === 'string' ? column.type : undefined;
  if (!column || !type || (!QUANTITY_COLUMN_TYPES.has(type) && !LABEL_COLUMN_TYPES.has(type))) {
    return failure('diagnostic_bind_column_undeclared',
      `Bind '${bind.name}' reads '${read.name}', which ${producer.skillId}.${producer.stepId} does not declare as a typed scalar display column.`);
  }
  const unit = QUANTITY_COLUMN_TYPES.has(type) && isValidColumnUnit(type, column.unit) ? column.unit : undefined;
  if (QUANTITY_COLUMN_TYPES.has(type) && !unit) {
    return failure('diagnostic_bind_unit_missing',
      `Bind '${bind.name}' reads the ${type} column '${read.name}', which declares no valid unit.`);
  }
  if (pick.kind === 'find' && !AGGREGATE_ROW_SEMANTICS.has(String(producer.display?.row_semantics))) {
    return failure('diagnostic_bind_row_pick',
      `Bind '${bind.name}' picks a row with find(); ${producer.skillId}.${producer.stepId} must declare `
      + 'display.row_semantics window_total or per_entity.');
  }
  return {ok: true, path, sourceStepId: source.id, ...(unit ? {unit} : {})};
}
