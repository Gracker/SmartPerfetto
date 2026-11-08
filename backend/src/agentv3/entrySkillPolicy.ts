// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Whether a strategy's `entry_skill` may run unattended before the model's
 * first turn. `validate:strategies` refuses a declaration that fails here, and
 * the runtime refuses it again (`capability_missing`) against the run's pinned
 * Skill registry, so an overlay or a later Skill edit cannot slip past.
 */

import {getConsumableProcessIdentitySelectors, getEffectiveIdentityConfig} from '../services/processIdentity/identityGate';
import {executableSqlUnits, getExactProcessScopeSupport, sqlRunBy} from '../services/skillEngine/processScopeSql';
import {skillExecution} from '../services/skillEngine/skillSteps';
import {sqlIsReadOnly} from '../services/skillEngine/sqlStructure';
import {injectFragmentCtes} from '../services/skillEngine/skillFragments';
import {investigationProducerCatalog} from '../services/skillEngine/investigationProducerCatalog';
import type {InvestigationEvidenceDeclaration} from '../services/evidence/investigationEvidenceLedger';
import {INVESTIGATION_ENTRY_BINDINGS, type AnalysisInvestigationEntryAcquisition} from '../types/analysisInvestigation';
import type {SkillDefinition} from '../services/skillEngine/types';
import {
  ENTRY_SKILL_END_BINDINGS,
  ENTRY_SKILL_PROCESS_BINDINGS,
  ENTRY_SKILL_START_BINDINGS,
  type StrategyEntrySkill,
} from '../types/sceneEntryEvidence';

/** A Skill that cannot run without naming its process. */
export function skillRequiresProcessSelector(skill: SkillDefinition): boolean {
  return getEffectiveIdentityConfig(skill).policy === 'required' ||
    (skill.inputs ?? []).some(input => input.required === true &&
      (input.name === 'package' || input.name === 'process_name'));
}

/**
 * `CREATE [TEMP] [PERFETTO] VIEW|TABLE [IF NOT EXISTS] name [(cols)] AS`: the
 * header of a statement that only defines a derived object over its body.
 */
const DERIVED_OBJECT_HEADER =
  /^\s*CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?(?:PERFETTO\s+)?(?:VIEW|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w.]+\s*(?:\([^()]*\)\s*)?AS\s+/i;

/** Drop the leading comments and whitespace, so the statement head is what follows. */
function withoutLeadingComments(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
}

/**
 * Read-only, or a single statement that only defines a derived view or table
 * over a read-only query. Skills define such views for absent stdlib modules
 * (`scrolling_analysis` creates an empty `android_input_events` view); none
 * may write, drop, alter or attach anything.
 */
export function entrySkillSqlIsUnattendedSafe(sql: string): boolean {
  if (sqlIsReadOnly(sql)) return true;
  const statement = withoutLeadingComments(sql);
  const header = DERIVED_OBJECT_HEADER.exec(statement);
  return header !== null && sqlIsReadOnly(statement.slice(header[0].length));
}

/** Every reason this declaration cannot run against `skill`; empty when it can. */
export function entrySkillExecutabilityErrors(
  entry: StrategyEntrySkill,
  skill: SkillDefinition | undefined,
): string[] {
  if (!skill) return [`entry_skill ${entry.id} is not a registered Skill`];
  const errors: string[] = [];
  if ((skill.type !== 'composite' && skill.type !== 'atomic') || skillExecution(skill) === 'none' ||
      skill.source !== undefined && skill.source !== 'trace') {
    errors.push(`entry_skill ${entry.id} must be an executable single-trace atomic or composite Skill`);
  }
  for (const unit of executableSqlUnits(skill)) {
    if (typeof unit.source.sql === 'string' && unit.source.sql.trim() && !entrySkillSqlIsUnattendedSafe(unit.source.sql)) {
      errors.push(`entry_skill ${entry.id} SQL unit ${unit.path} may modify trace processor state`);
    }
  }
  const inputs = new Map((skill.inputs ?? []).map(input => [input.name, input]));
  const selectors = getConsumableProcessIdentitySelectors(skill);
  let processBound = false;
  for (const [name, binding] of Object.entries(entry.params)) {
    const input = inputs.get(name);
    if (!input) {
      errors.push(`entry_skill ${entry.id} binds undeclared input ${name}`);
      continue;
    }
    if (ENTRY_SKILL_PROCESS_BINDINGS.includes(binding)) {
      processBound = true;
      if ((name !== 'package' && name !== 'process_name') || !selectors.has(name)) {
        errors.push(`entry_skill ${entry.id} binds ${binding} to ${name}, which is not a process identity selector`);
      }
    } else if ([...ENTRY_SKILL_START_BINDINGS, ...ENTRY_SKILL_END_BINDINGS].includes(binding) && input.type !== 'timestamp') {
      errors.push(`entry_skill ${entry.id} binds ${binding} to ${name}, which is not a timestamp input`);
    }
  }
  if (skillRequiresProcessSelector(skill) && !processBound) {
    errors.push(`entry_skill ${entry.id} requires a process binding (focus_app or user_target)`);
  }
  if (entry.evidenceFirst?.whenTargetAbsent === 'omit' && skillRequiresProcessSelector(skill)) {
    errors.push(`entry_skill ${entry.id} cannot omit its target: the Skill requires a process selector`);
  }
  return errors;
}

export type InvestigationEntryProducerAdmission =
  | {status: 'admitted'; skill: SkillDefinition; declaration: InvestigationEvidenceDeclaration}
  | {status: 'not_admitted'; reason: 'producer_unavailable' | 'producer_ambiguous' | 'binding_unsupported'; errors: string[]};

/** Static admission only; the collector still verifies native scope, prerequisites and live authorization. */
export function admitInvestigationEntryProducer(entry: AnalysisInvestigationEntryAcquisition,
  definitions: ReadonlyMap<string, SkillDefinition>, fragments: ReadonlyMap<string, string>): InvestigationEntryProducerAdmission {
  const refuse = (reason: 'producer_unavailable' | 'producer_ambiguous' | 'binding_unsupported', errors: string[]):
    InvestigationEntryProducerAdmission => ({status: 'not_admitted', reason, errors});
  if (!entry?.params || typeof entry.params !== 'object' || Array.isArray(entry.params) ||
      typeof entry.metricId !== 'string' || !entry.metricId.trim()) {
    return refuse('binding_unsupported', ['entry_acquisition requires a metric and explicit selected bindings']);
  }
  const bound = Object.values(entry.params);
  if (entry.schemaVersion !== 1 || entry.subjectBinding !== 'selected_thread_interval' ||
      bound.length !== INVESTIGATION_ENTRY_BINDINGS.length ||
      INVESTIGATION_ENTRY_BINDINGS.some(binding => bound.filter(value => value === binding).length !== 1)) {
    return refuse('binding_unsupported', ['entry_acquisition requires each selected identity/window binding exactly once']);
  }
  const matches = investigationProducerCatalog([...definitions.values()], entry.metricId);
  if (matches.length !== 1) return refuse(matches.length ? 'producer_ambiguous' : 'producer_unavailable',
    [`entry_acquisition ${entry.metricId} requires exactly one registered producer`]);
  const match = matches[0];
  const skill = definitions.get(match.skillId)!;
  const root = executableSqlUnits(skill).find(unit => unit.node === skill && unit.variant === 'named');
  if (skill.type !== 'atomic' || skillExecution(skill) !== 'root' || match.sqlAt !== 'sql' || !root ||
      match.guarded || match.stepOptional || root.node.condition !== undefined ||
      skill.source !== undefined && skill.source !== 'trace' || skill.batch_analysis !== undefined) {
    return refuse('producer_unavailable', [`entry_acquisition ${entry.metricId} requires an unguarded single-trace atomic root producer`]);
  }
  const declaration = skill.investigation_evidence!;
  if (!declaration.identity?.upid || !declaration.identity.utid ||
      declaration.metrics.filter(metric => metric.metric_id === entry.metricId).length !== 1) {
    return refuse('binding_unsupported', [`entry_acquisition ${entry.metricId} requires exact window/UPID/UTID and one metric output`]);
  }
  const inputs = new Map((skill.inputs ?? []).map(input => [input.name, input]));
  const selectors = getConsumableProcessIdentitySelectors(skill);
  const errors: string[] = [];
  for (const [name, binding] of Object.entries(entry.params)) {
    const input = inputs.get(name);
    if (binding === 'selected_upid') {
      if (name !== 'upid' || !selectors.has(name) || input && !['integer', 'number'].includes(input.type)) {
        errors.push(`entry_acquisition ${skill.name} cannot consume ${name} as an exact UPID`);
      }
    } else if (binding === 'selected_utid') {
      if (name !== 'utid' || !input || !['integer', 'number'].includes(input.type)) {
        errors.push(`entry_acquisition ${skill.name} cannot consume ${name} as an exact UTID`);
      }
    } else if (!input || input.type !== 'timestamp') {
      errors.push(`entry_acquisition ${skill.name} requires timestamp input ${name}`);
    }
  }
  for (const input of skill.inputs ?? []) {
    if (input.required && input.default === undefined && !Object.prototype.hasOwnProperty.call(entry.params, input.name)) {
      errors.push(`entry_acquisition ${skill.name} cannot satisfy required input ${input.name}`);
    }
  }
  const exactRoot = sqlRunBy(skill, 'exact');
  if (skill.process_scope?.role !== 'target' || exactRoot?.process_scope?.role !== 'target' ||
      exactRoot.process_scope.exact_unavailable !== undefined ||
      !getExactProcessScopeSupport(skill, definitions, fragments).supported) {
    errors.push(`entry_acquisition ${skill.name} does not support exact target process scope`);
  }
  const bindingUnsupported = errors.length > 0;
  for (const unit of executableSqlUnits(skill)) {
    if (typeof unit.source.sql !== 'string' || !unit.source.sql.trim()) {
      errors.push(`entry_acquisition ${skill.name} has no SQL for ${unit.path}`);
      continue;
    }
    const bodies: string[] = [];
    for (const key of unit.source.sql_fragments ?? []) {
      const body = fragments.get(key);
      if (!body?.trim()) errors.push(`entry_acquisition ${skill.name} is missing fragment ${key}`);
      else bodies.push(body);
    }
    // Exactly the executor's CTE composition, on this pin's cache, including
    // declared exact overrides. Bare CTE bodies are not standalone statements.
    const completeSql = injectFragmentCtes(unit.source.sql, bodies);
    if (!entrySkillSqlIsUnattendedSafe(completeSql)) {
      errors.push(`entry_acquisition ${skill.name} SQL unit ${unit.path} may modify trace processor state`);
    }
  }
  return errors.length ? refuse(bindingUnsupported ? 'binding_unsupported' : 'producer_unavailable', errors)
    : {status: 'admitted', skill, declaration};
}
