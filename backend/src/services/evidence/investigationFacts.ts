// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Structured facts of fired diagnostic rules: which stable rule fired and the
 * producer values it bound (value plus the source column's unit), with the
 * locator of the result each value came from. A fact states producer values
 * only. It never carries the rule's severity, diagnosis or suggestions: those
 * are product-written conclusions, and the model draws its own.
 *
 * `invoke_skill` and scene entry evidence surface this projection of the
 * diagnostics the run stored; a fact is never evidence authority by itself.
 */

import type {DiagnosticBinding, DiagnosticResult} from '../skillEngine/types';

/** Serialized size of one Skill result's facts. */
export const SKILL_RESULT_FACTS_MAX_BYTES = 2048;

export interface SkillResultFactBinding {
  name: string;
  /** The bound producer value; withheld when the request forbids raw rows. */
  value?: unknown;
  unit?: string;
  sourceStepId: string;
  artifactId?: string;
  evidenceRefId?: string;
  evidence?: 'unavailable';
}

export interface SkillResultRuleFact {
  ruleId: string;
  bindings?: SkillResultFactBinding[];
}

/** One Skill result's fired rules, in firing order; rules past the byte bound are counted. */
export interface SkillResultFacts {
  skillId: string;
  diagnosticsArtifactId?: string;
  rules?: SkillResultRuleFact[];
  omittedRuleCount?: number;
}

type DisplayLocator = {artifactId: string; evidenceRefId: string};

/**
 * Diagnostics whose bindings name where their source step's result is stored,
 * or `evidence: unavailable` for a step the run did not display. Unbound
 * diagnostics are returned unchanged.
 */
export function locateDiagnosticBindings(
  diagnostics: readonly DiagnosticResult[],
  locate: (stepId: string) => DisplayLocator | undefined,
): DiagnosticResult[] {
  return diagnostics.map(diagnostic => !diagnostic.bindings?.length ? diagnostic : {
    ...diagnostic,
    bindings: diagnostic.bindings.map((binding): DiagnosticBinding => {
      const locator = locate(binding.sourceStepId);
      return locator ? {...binding, artifactId: locator.artifactId, evidenceRefId: locator.evidenceRefId}
        : {...binding, evidence: 'unavailable'};
    }),
  });
}

/** `facts` carrying only `rules`; every rule it drops is added to the omitted count. */
export function withFactRules(facts: SkillResultFacts, rules: readonly SkillResultRuleFact[]): SkillResultFacts {
  const {rules: current = [], omittedRuleCount = 0, ...envelope} = facts;
  const omitted = omittedRuleCount + current.length - rules.length;
  return {...envelope, ...(rules.length ? {rules: [...rules]} : {}), ...(omitted > 0 ? {omittedRuleCount: omitted} : {})};
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function factBinding(binding: DiagnosticBinding): SkillResultFactBinding {
  const {name, value, unit, sourceStepId, artifactId, evidenceRefId} = binding;
  return {name, value: value ?? null, ...(unit ? {unit} : {}), sourceStepId,
    ...(artifactId && evidenceRefId ? {artifactId, evidenceRefId} : {evidence: 'unavailable' as const})};
}

/** The facts of a Skill result's fired rules that carry an id; undefined when none does. */
export function skillResultFacts(
  skillId: string,
  diagnostics: readonly DiagnosticResult[],
  diagnosticsArtifactId?: string,
): SkillResultFacts | undefined {
  const fired = diagnostics.flatMap((diagnostic): SkillResultRuleFact[] => diagnostic.ruleId ? [{
    ruleId: diagnostic.ruleId,
    ...(diagnostic.bindings?.length ? {bindings: diagnostic.bindings.map(factBinding)} : {}),
  }] : []);
  if (!fired.length) return undefined;
  const facts: SkillResultFacts = {skillId, ...(diagnosticsArtifactId ? {diagnosticsArtifactId} : {}), rules: fired};
  // Whole rules, in firing order, while the bound holds; the envelope reserves room for the omitted count.
  let bytes = jsonBytes(withFactRules(facts, []));
  let kept = 0;
  for (const rule of fired) {
    bytes += jsonBytes(rule) + 1;
    if (bytes > SKILL_RESULT_FACTS_MAX_BYTES) break;
    kept++;
  }
  return withFactRules(facts, fired.slice(0, kept));
}
