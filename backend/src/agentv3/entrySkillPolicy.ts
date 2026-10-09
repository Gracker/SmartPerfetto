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
import {executableSqlUnits} from '../services/skillEngine/processScopeSql';
import {skillExecution} from '../services/skillEngine/skillSteps';
import {sqlIsReadOnly} from '../services/skillEngine/sqlStructure';
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
  return errors;
}
