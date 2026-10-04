// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Validate Command
 *
 * Validates skill YAML files for syntax and semantic correctness.
 *
 * Tier/stdlib lint rules (documented in docs/reference/skill-system.md):
 *   1. skill-tier-must-match-declared        — tier: S/A/B 与实际指标一致
 *   2. skill-stdlib-detected-vs-declared     — SQL 用到的 stdlib 表 ⊂ prerequisites.modules
 *   3. skill-include-budget-soft-cap         — prerequisites.modules.length ≤ 8 (warning)
 *   4. skill-step-id-uniqueness              — 已有实现 (line ~188)
 *   5. skill-vendor-override-runtime-conformant — additional_steps ≥ 1 + signatures ≥ 1 (errors)
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { SkillDefinition } from '../../services/skillEngine/types';
import {
  formatDisplayContractIssue,
  validateSkillDisplayContract,
} from '../../services/skillEngine/displayContractValidator';
import { validateSkillDefinitionInProcess } from '../../services/selfEvolution/inProcessValidator';
import { registryCauseWordingReaders, type CauseWordingReaders } from '../../services/skillEngine/causeWordingEvidence';
import {
  UNKNOWN_TOP_LEVEL_KEY_MESSAGE, unknownSkillTopLevelKeys, unknownVendorOverrideKeys,
} from '../../services/skillEngine/skillTopLevelKeys';
import {
  checkStrategySkillCalls,
  extractStrategySkillCalls,
  formatUndeclaredStrategySkillParams,
  type StrategySkillInputs,
} from '../../agentv3/strategySkillCalls';
import {readSkillFragmentFile, skillFragmentKey} from '../../services/skillEngine/skillFragments';
import {
  analyzeSqlGuardrails,
  DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES,
  summarizeSqlGuardrailIssues,
} from '../../services/sqlGuardrailAnalyzer';
import { skillUsesProcessNameFilter } from '../../services/processIdentity/identityGate';
import { EXACT_UPID_TOKEN, executableSqlUnits, sqlRunBy, type ExecutableSqlUnit } from '../../services/skillEngine/processScopeSql';
import { stepNodesOf } from '../../services/skillEngine/skillSteps';
import { listSkillFiles, SKILL_FILE_PATTERN, SKILL_LAYOUT } from '../../services/skillEngine/skillLayout';
import { recordedStepNames, RUNTIME_SKILL_PARAMS } from '../../services/skillEngine/skillValidator';
import { boundSqlPlaceholders } from '../../services/skillEngine/sqlTemplate';
import {
  analyzeSqlStdlibDependencySequence,
  moduleCoveredByStdlibDeclaration,
} from '../../services/sqlStdlibDependencyAnalyzer';
import {validateCaseKnowledgeFiles} from '../../services/caseSchemaValidator';
import {parseSourceDepthPolicy} from '../../services/codebase/sourceDepthPolicy';
import {parseSourceAnchorNormalization} from '../../services/codebase/traceAnchorLocator';
import {parseInvestigationContract, parseInvestigationProfiles, type InvestigationProfiles} from '../../agentv3/strategyLoader';

// ANSI color codes (fallback for chalk ESM issues)
const colors = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface VendorOverrideDefinition {
  extends?: string;
  version?: string;
  meta?: {
    display_name?: string;
    description?: string;
    vendor?: string;
    [key: string]: any;
  };
  vendor_detection?: {
    signatures?: Array<{ pattern?: string; confidence?: string }>;
  };
  additional_steps?: any[];
}

const SKILLS_DIR = path.join(__dirname, '../../../skills');

let skillFragmentCache: ReadonlyMap<string, string> | undefined;

/** Fragment bodies keyed as Skills reference them, so SQL checks see injected text. */
function loadSkillFragmentCache(): ReadonlyMap<string, string> {
  if (!skillFragmentCache) {
    const fragmentsDir = path.join(SKILLS_DIR, SKILL_LAYOUT.fragmentsDir);
    skillFragmentCache = new Map(fs.existsSync(fragmentsDir)
      ? fs.readdirSync(fragmentsDir).filter(file => file.endsWith('.sql')).map(file => [
        skillFragmentKey(file), readSkillFragmentFile(fragmentsDir, file),
      ])
      : []);
  }
  return skillFragmentCache;
}
let skillDefinitionsById: ReadonlyMap<string, SkillDefinition> | undefined;
let diskCauseWordingReaders: CauseWordingReaders | undefined;

/** Every Skill on disk by name, so a cross-Skill contract can resolve its target. */
function loadSkillDefinitionsById(): ReadonlyMap<string, SkillDefinition> {
  if (!skillDefinitionsById) {
    const byId = new Map<string, SkillDefinition>();
    for (const {path: file} of listSkillFiles(SKILLS_DIR, {includeCustom: true})) {
      try {
        const skill = yaml.load(fs.readFileSync(file, 'utf-8')) as SkillDefinition | undefined;
        if (skill?.name) byId.set(skill.name, skill);
      } catch { /* the file's own validation reports parse errors */ }
    }
    skillDefinitionsById = byId;
  }
  return skillDefinitionsById;
}
const CASES_DIR = path.join(__dirname, '../../../knowledge/cases');
const STRATEGIES_DIR = path.join(__dirname, '../../../strategies');
const STRATEGY_FRONTMATTER_RE = /^(?:\s*<!--[\s\S]*?-->\s*)*---\n([\s\S]*?)\n---\n?/;
const VERIFIER_MISDIAGNOSIS_SEVERITIES = new Set(['warning', 'info']);

export interface StrategyFrontmatterValidationContext {
  knownScenes?: Set<string>;
  seenVerifierMisdiagnosisIds?: Map<string, string>;
  investigationProfiles?: InvestigationProfiles;
  requireInvestigationContract?: boolean;
}

/** A step's type, with the legacy defaults: SQL without a type is atomic, a Skill id without one a reference. */
function stepTypeOf(step: any): string {
  const t = step?.type;
  if (typeof t === 'string' && t.trim()) return t;
  if (typeof step?.sql === 'string') return 'atomic';
  if (typeof step?.skill === 'string') return 'skill';
  return 'unknown';
}

/**
 * Tier + stdlib lint rules (rules 1, 2, 3 from docs/reference/skill-system.md).
 * Returns errors/warnings to merge into the file's overall result.
 *
 * Rule 1 — skill-tier-must-match-declared:
 *   When `tier: S | A | B` is present, enforce structural conformance.
 *   When absent, emit a single migration warning (do not break existing 121 skills).
 *
 * Rule 2 — skill-stdlib-detected-vs-declared:
 *   Scan SQL for stdlib table refs (e.g. `android_startups`); ensure the owning
 *   module appears in `prerequisites.modules`. Built-in tables (slice/thread/
 *   process etc.) and tables defined inline (CREATE TABLE / WITH X AS) are
 *   ignored.
 *
 * Rule 3 — skill-include-budget-soft-cap:
 *   `prerequisites.modules.length > 8` emits a warning so PR review can
 *   audit whether load-time cost is justified.
 */
function validateTierAndStdlib(skill: SkillDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (skill.type === 'comparison') {
    return { errors, warnings };
  }

  const declaredTier = skill.tier;
  const prereqModules: string[] = Array.isArray(skill.prerequisites?.modules)
    ? skill.prerequisites.modules.filter((m: unknown) => typeof m === 'string')
    : [];
  const stepCount = Array.isArray(skill.steps) ? skill.steps.length : 0;
  const skillType = String(skill.type ?? 'atomic');

  // ---- Rule 1: tier-must-match-declared ----
  // The `tier:` field declares INTENT (target tier per audit doc §6), not current state.
  // M1 sweep will lift skills to compliance. Structural mismatches emit WARNINGS so the
  // lint surfaces what M1 needs to fix without blocking M0 commits.
  // Only `invalid value` stays as error (typo / wrong tier letter).
  if (declaredTier !== undefined) {
    if (!['S', 'A', 'B'].includes(declaredTier)) {
      errors.push(`tier: invalid value '${declaredTier}', must be 'S' | 'A' | 'B'`);
    } else if (declaredTier === 'S') {
      // S: type must be composite (or deep), prerequisites.modules >= 2, steps >= 5
      if (skillType !== 'composite' && skillType !== 'deep') {
        warnings.push(`tier=S target requires type='composite' or 'deep' (got '${skillType}') — M1 sweep TODO`);
      }
      if (prereqModules.length < 2) {
        warnings.push(`tier=S target requires prerequisites.modules.length >= 2 (found ${prereqModules.length}) — M1 sweep TODO`);
      }
      if (stepCount < 5) {
        warnings.push(`tier=S target requires steps.length >= 5 (found ${stepCount}) — M1 sweep TODO`);
      }
    } else if (declaredTier === 'A') {
      if (prereqModules.length < 1) {
        warnings.push(`tier=A target requires prerequisites.modules.length >= 1 (found 0) — M1 sweep TODO`);
      }
    } else if (declaredTier === 'B') {
      if (prereqModules.length < 1) {
        warnings.push(`tier=B target requires prerequisites.modules.length >= 1 (found 0) — M1 sweep TODO`);
      }
    }
  } else {
    // No tier declared — emit migration warning so M1 sweep adds it.
    warnings.push(`tier: field missing — please declare 'tier: S|A|B' (see docs/reference/skill-system.md)`);
  }

  // ---- Rule 3: include-budget-soft-cap ----
  if (prereqModules.length > 8) {
    warnings.push(`prerequisites.modules.length=${prereqModules.length} exceeds soft cap of 8 (lint rule 3)`);
  }

  // ---- Rule 2: stdlib-detected-vs-declared ----
  // Reuses the same dependency analyzer as raw execute_sql auto-INCLUDE, so
  // validation covers stdlib tables, functions, and macro invocations.
  // Each run is its own sequence: the SQL every unit runs, named or exact (executableSqlUnits);
  // what a unit that may not run defines reaches no unit after it.
  const units = executableSqlUnits(skill);
  const named = units.filter(unit => unit.variant === 'named');
  const variants = units.some(unit => unit.variant === 'exact') ? ['named', 'exact'] as const : ['named'] as const;
  const runs = variants.map(variant => named.flatMap(unit => {
    const sql = sqlRunBy(unit.source, variant)?.sql;
    return typeof sql === 'string' ? [{sql, reaches: !unit.guarded}] : [];
  }));

  if (named.length > 0) {
    const reported = new Set<string>();
    for (const analysis of runs.flatMap(run => analyzeSqlStdlibDependencySequence(
      run.map(unit => unit.sql), {reaches: run.map(unit => unit.reaches)}))) {
      if (analysis.source === 'empty') continue;

      for (const dependency of analysis.dependencies) {
        if (moduleCoveredByStdlibDeclaration(dependency.module, prereqModules)) {
          continue;
        }
        const key = `${dependency.symbol}\n${dependency.usage}\n${dependency.module}`;
        if (reported.has(key)) continue;
        errors.push(
          `SQL uses stdlib ${dependency.usage} '${dependency.symbol}' ` +
          `(owning module '${dependency.module}') but prerequisites.modules ` +
          `does not declare it (lint rule 2)`
        );
        reported.add(key);
      }
    }
  }

  return { errors, warnings };
}

function validateIdentityContract(skill: SkillDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const identity = skill.identity as any;

  if (identity !== undefined) {
    const policies = new Set(['none', 'exempt', 'verify_if_present', 'required']);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      errors.push('identity must be an object when provided');
      return { errors, warnings };
    }
    if (!policies.has(identity.policy)) {
      errors.push(`identity.policy must be one of: ${Array.from(policies).join(', ')}`);
    }
    if (identity.scope !== undefined && identity.scope !== 'process') {
      errors.push("identity.scope must be 'process' when provided");
    }
    if (identity.aliases !== undefined && (!Array.isArray(identity.aliases) || identity.aliases.length === 0 || identity.aliases.some((a: unknown) => typeof a !== 'string' || !a.trim()))) {
      errors.push('identity.aliases must be a non-empty string array when provided');
    }
    if (identity.rewriteTo !== undefined && identity.rewriteTo !== 'recommended_process_name_param' && identity.rewriteTo !== 'upid') {
      errors.push("identity.rewriteTo must be 'recommended_process_name_param' or 'upid'");
    }
    if (identity.minConfidence !== undefined && (typeof identity.minConfidence !== 'number' || identity.minConfidence < 0 || identity.minConfidence > 100)) {
      errors.push('identity.minConfidence must be a number between 0 and 100');
    }

    if (identity.policy === 'required') {
      const aliases = Array.isArray(identity.aliases) ? identity.aliases : ['package', 'process_name'];
      const declaredInputs = new Set((skill.inputs || []).map(input => input.name));
      const hasDeclaredAlias = aliases.some((alias: string) => declaredInputs.has(alias));
      const acceptsUpid = declaredInputs.has('upid');
      if (!hasDeclaredAlias && !acceptsUpid) {
        errors.push(`identity.required skill must declare at least one identity alias input (${aliases.join(', ')}) or upid`);
      }
    }
    if (identity.rewriteTo === 'upid') {
      const declaredInputs = new Set((skill.inputs || []).map(input => input.name));
      if (!declaredInputs.has('upid')) {
        errors.push("identity.rewriteTo='upid' requires an upid input");
      }
    }
  }

  if (skillUsesProcessNameFilter(skill) && identity?.policy === 'none') {
    errors.push('identity.policy cannot be none when SQL filters by process.name/process_name');
  }

  return { errors, warnings };
}

function validateSkillDefinition(skill: SkillDefinition, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!skill.name) {
    errors.push('Missing required field: name');
  }
  if (!skill.version) {
    errors.push('Missing required field: version');
  }
  // NOTE: meta/triggers are best-effort in the current repo (legacy skills exist).
  // The runtime loader normalizes missing meta, so validate treats missing meta as a warning.
  if (!skill.meta) {
    warnings.push('Missing field: meta (will be normalized at load time, but should be filled in YAML)');
  } else {
    if (!skill.meta.display_name) {
      warnings.push('Missing field: meta.display_name');
    }
    if (!skill.meta.description) {
      warnings.push('Missing field: meta.description');
    }
  }
  if (!skill.triggers) {
    warnings.push('Missing field: triggers (optional; add keywords to improve discovery)');
  } else {
    const triggersRaw: any = skill.triggers as any;
    const triggers: any = (() => {
      // Accept legacy trigger array forms to avoid noisy false warnings
      // - [{ pattern: '...', confidence: 0.9 }, ...]
      // - ['keyword', '(regex|pattern)', ...]
      if (Array.isArray(triggersRaw)) {
        const keywords: string[] = [];
        const patterns: string[] = [];
        const looksLikeRegex = (s: string): boolean => /[\\^$.*+?()[\]{}|]/.test(s);

        for (const item of triggersRaw) {
          if (typeof item === 'string') {
            const s = item.trim();
            if (!s) continue;
            if (looksLikeRegex(s)) patterns.push(s);
            else keywords.push(s);
            continue;
          }
          if (item && typeof item === 'object') {
            if (typeof (item as any).pattern === 'string' && String((item as any).pattern).trim()) {
              patterns.push(String((item as any).pattern).trim());
            }
            if (typeof (item as any).keyword === 'string' && String((item as any).keyword).trim()) {
              keywords.push(String((item as any).keyword).trim());
            }
          }
        }

        const normalized: any = {};
        if (keywords.length > 0) normalized.keywords = keywords;
        if (patterns.length > 0) normalized.patterns = patterns;
        return normalized;
      }
      return triggersRaw;
    })();
    const hasKeywords = (() => {
      const k = triggers.keywords;
      if (!k) return false;
      if (typeof k === 'string') return k.trim().length > 0;
      if (Array.isArray(k)) return k.length > 0;
      if (typeof k === 'object') {
        const zh = Array.isArray(k.zh) ? k.zh : [];
        const en = Array.isArray(k.en) ? k.en : [];
        return zh.length > 0 || en.length > 0;
      }
      return false;
    })();
    const hasPatterns = (() => {
      const p = triggers.patterns;
      if (!p) return false;
      if (typeof p === 'string') return p.trim().length > 0;
      if (Array.isArray(p)) return p.length > 0;
      return false;
    })();
    if (!hasKeywords && !hasPatterns) {
      warnings.push('No keywords/patterns defined in triggers');
    }
  }

  const identityContract = validateIdentityContract(skill);
  errors.push(...identityContract.errors);
  warnings.push(...identityContract.warnings);

  // Execution shape validation:
  // - atomic: allow either root-level `sql` OR step-based `steps`
  // - composite/iterator/diagnostic: require `steps`
  // - comparison: metadata contract executed by comparison services
  const hasSteps = Array.isArray(skill.steps) && skill.steps.length > 0;
  const hasRootSql = typeof (skill as any).sql === 'string' && String((skill as any).sql).trim().length > 0;
  if (skill.type === 'atomic') {
    if (!hasRootSql && !hasSteps) {
      errors.push('Atomic skill must define either `sql` or non-empty `steps`');
    }
  } else if (skill.type === 'comparison') {
    const source = (skill as any).source;
    const comparison = (skill as any).comparison;
    if (source !== 'analysis_result_snapshot') {
      errors.push("comparison skill must define source: 'analysis_result_snapshot'");
    }
    if (!comparison || typeof comparison !== 'object') {
      errors.push('comparison skill must define comparison contract');
    } else {
      if (comparison.source !== 'analysis_result_snapshot') {
        errors.push("comparison.source must be 'analysis_result_snapshot'");
      }
      if (comparison.operation !== 'build_comparison_matrix') {
        errors.push("comparison.operation must be 'build_comparison_matrix'");
      }
      if (comparison.output_contract && comparison.output_contract !== 'ComparisonMatrix') {
        errors.push("comparison.output_contract must be 'ComparisonMatrix' when provided");
      }
      if (comparison.required_inputs !== undefined && !Array.isArray(comparison.required_inputs)) {
        errors.push('comparison.required_inputs must be an array when provided');
      }
    }
  } else {
    if (!hasSteps) {
      errors.push('Missing required field: steps (at least one step is required)');
    }
  }

  // Validate steps, at any depth (stepNodesOf). A step reads what an input, a
  // runtime parameter or an earlier top-level step recorded (recordedStepNames).
  const steps = stepNodesOf(skill);
  const stepIds = new Set<string>();
  for (const {node: step, at} of steps) {
    // Required step fields
    if (!step.id) {
      errors.push(`${at}: Missing required field: id`);
    } else {
      if (stepIds.has(step.id)) {
        errors.push(`${at}: Duplicate step id: ${step.id}`);
      }
      stepIds.add(step.id);
    }
    // An atomic step's SQL is checked with every other SQL unit below.
    if (stepTypeOf(step) === 'atomic' && typeof step.sql !== 'string') {
      errors.push(`${at}: Missing required field: sql for atomic step`);
    }
  }

  // Every SQL the executor runs, named and exact (executableSqlUnits); the
  // trusted UPID binding belongs to the process-scope checks.
  const definedVariables = new Set<string>(RUNTIME_SKILL_PARAMS);
  for (const input of Array.isArray(skill.inputs) ? skill.inputs : []) {
    if (input && typeof (input as any).name === 'string') definedVariables.add(String((input as any).name));
  }
  const unitsOf = new Map<unknown, ExecutableSqlUnit[]>();
  for (const unit of executableSqlUnits(skill)) unitsOf.set(unit.node, [...(unitsOf.get(unit.node) ?? []), unit]);
  const checkSql = (node: unknown) => {
    for (const unit of unitsOf.get(node) ?? []) {
      if (typeof unit.source.sql !== 'string') continue;
      const label = unit.sqlAt.replace(/\.sql$/, '');
      const sqlIssues = validateSql(unit.source.sql);
      errors.push(...sqlIssues.errors.map(e => `${label}: ${e}`));
      warnings.push(...sqlIssues.warnings.map(w => `${label}: ${w}`));
      for (const ref of extractVariableReferences(unit.source.sql)) {
        const actualRef = String(ref || '').split('|')[0].trim();
        // prev.* and item.* are context references.
        if (actualRef.startsWith('prev.') || actualRef.startsWith('item.') || `\${${ref}}` === EXACT_UPID_TOKEN) continue;
        if (!definedVariables.has(actualRef.split('.')[0])) {
          warnings.push(`${label}: Variable reference '${ref}' may not be defined at this step`);
        }
      }
    }
  };
  checkSql(skill);
  for (const top of stepNodesOf(skill, {topLevelOnly: true})) {
    for (const {node: step, at} of steps.filter(node => node.topLevelIndex === top.topLevelIndex)) {
      checkSql(step);
      // At runtime, iterator `source` can reference either a previous step's
      // `save_as` or a previous step id (context.results[stepId]).
      if (stepTypeOf(step) === 'iterator' && step.source && !definedVariables.has(step.source)) {
        errors.push(`${at}: iterator source references undefined variable: ${step.source}`);
      }
    }
    for (const name of recordedStepNames(top.node)) definedVariables.add(name);
  }

  // Validate diagnostic rules (in diagnostic steps, not skill-level)
  // V2 diagnostics are defined within DiagnosticStep, not at skill level

  // Tier + stdlib lint rules (1, 2, 3) — see docs/reference/skill-system.md
  const tierStdlib = validateTierAndStdlib(skill);
  errors.push(...tierStdlib.errors);
  warnings.push(...tierStdlib.warnings);

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateVendorOverrideDefinition(override: VendorOverrideDefinition, filePath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!override.extends || typeof override.extends !== 'string') {
    errors.push('Missing required field: extends');
  }
  if (!override.version) {
    errors.push('Missing required field: version');
  }

  if (!override.meta) {
    warnings.push('Missing field: meta');
  } else {
    if (!override.meta.display_name) warnings.push('Missing field: meta.display_name');
    if (!override.meta.description) warnings.push('Missing field: meta.description');
    if (!override.meta.vendor) warnings.push('Missing field: meta.vendor');
  }

  // Lint rule 5 — skill-vendor-override-runtime-conformant
  // Per docs/reference/skill-system.md: the invoke_skill hint skips overrides
  // whose `additional_steps.length === 0`, so empty overrides are dead diff.
  // The runtime does not match `vendor_detection.signatures`: the trace vendor
  // resolver reads device metadata, and an override is selected by its
  // directory name / `meta.vendor`. The signatures remain required metadata
  // that documents the vendor's trace markers; the rule stays an error.
  const signatures = override.vendor_detection?.signatures;
  if (signatures === undefined) {
    errors.push('vendor_detection.signatures: required (lint rule 5 — documents the vendor\'s trace markers; the runtime selects overrides by directory / meta.vendor, not by these patterns)');
  } else if (!Array.isArray(signatures)) {
    errors.push('vendor_detection.signatures must be an array');
  } else if (signatures.length === 0) {
    errors.push('vendor_detection.signatures: must contain >= 1 pattern (lint rule 5)');
  } else {
    const validConfidences = new Set(['high', 'medium', 'low']);
    signatures.forEach((sig, index) => {
      if (!sig?.pattern || typeof sig.pattern !== 'string') {
        errors.push(`vendor_detection.signatures[${index}]: Missing required field: pattern`);
      }
      if (sig?.confidence && !validConfidences.has(sig.confidence)) {
        warnings.push(
          `vendor_detection.signatures[${index}]: Unknown confidence '${sig.confidence}' ` +
          `(valid: ${[...validConfidences].join(', ')})`
        );
      }
    });
  }

  for (const key of unknownVendorOverrideKeys(override)) {
    errors.push(`${key}: ${UNKNOWN_TOP_LEVEL_KEY_MESSAGE}`);
  }
  if (!Array.isArray(override.additional_steps) || override.additional_steps.length === 0) {
    errors.push('Vendor override has no runtime effect — declare additional_steps (>=1, with id/name/sql) (lint rule 5)');
  }

  if (override.additional_steps !== undefined) {
    if (!Array.isArray(override.additional_steps)) {
      errors.push('additional_steps must be an array');
    } else {
      const stepIds = new Set<string>();
      const defined = new Set<string>(RUNTIME_SKILL_PARAMS);

      override.additional_steps.forEach((step, index) => {
        const stepPath = `additional_steps[${index}]`;
        if (!step || typeof step !== 'object') {
          errors.push(`${stepPath}: must be an object`);
          return;
        }

        if (!step.id) {
          errors.push(`${stepPath}: Missing required field: id`);
        } else if (stepIds.has(step.id)) {
          errors.push(`${stepPath}: Duplicate step id: ${step.id}`);
        } else {
          stepIds.add(step.id);
          defined.add(step.id);
        }

        // Lint rule 5: each additional_step must carry id, name, AND sql
        if (!step.name) {
          errors.push(`${stepPath}: Missing required field: name (lint rule 5)`);
        }
        if (step.sql === undefined) {
          errors.push(`${stepPath}: Missing required field: sql (lint rule 5)`);
        }

        if (step.save_as) {
          defined.add(String(step.save_as));
        }

        if (step.sql !== undefined) {
          if (typeof step.sql !== 'string' || !step.sql.trim()) {
            errors.push(`${stepPath}: sql must be a non-empty string`);
          } else {
            const sqlIssues = validateSql(step.sql);
            errors.push(...sqlIssues.errors.map(e => `${stepPath}: ${e}`));
            warnings.push(...sqlIssues.warnings.map(w => `${stepPath}: ${w}`));

            for (const ref of extractVariableReferences(step.sql)) {
              const actualRef = String(ref || '').split('|')[0].trim();
              if (actualRef.startsWith('prev.') || actualRef.startsWith('item.')) continue;
              const root = actualRef.split('.')[0];
              if (!defined.has(root)) {
                warnings.push(`${stepPath}: Variable reference '${ref}' may not be defined at this step`);
              }
            }
          }
        }
      });
    }
  }

  const displayIssues = validateSkillDisplayContract({
    name: override.extends || path.basename(filePath),
    steps: override.additional_steps || [],
  } as any, { filePath });
  errors.push(...displayIssues.map(formatDisplayContractIssue));

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Basic SQL validation
 */
function validateSql(sql: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Heuristic warnings (keep validator usable; avoid false positives)
  if (sql.toUpperCase().includes('GROUP_CONCAT') && !sql.toLowerCase().includes('group by')) {
    warnings.push('GROUP_CONCAT used without GROUP BY (may be OK if query returns a single aggregated row)');
  }

  const guardrailMode = process.env.SMARTPERFETTO_SQL_GUARDRAILS;
  const expandedGuardrails = guardrailMode === 'strict' || guardrailMode === 'audit' || guardrailMode === 'fail';
  const failGuardrails = guardrailMode === 'fail';
  const guardrailRules = expandedGuardrails ? undefined : DEFAULT_VALIDATE_SQL_GUARDRAIL_RULES;
  const analyzedGuardrailIssues = analyzeSqlGuardrails(sql, { includeRules: guardrailRules });
  const percentileScaleIssues = analyzedGuardrailIssues.filter(
    issue => issue.ruleId === 'percentile-percent-scale',
  );
  const advisoryGuardrailIssues = analyzedGuardrailIssues.filter(
    issue => issue.ruleId !== 'percentile-percent-scale',
  );
  if (failGuardrails) {
    errors.push(...summarizeSqlGuardrailIssues(analyzedGuardrailIssues, {
      includeRules: guardrailRules,
    }));
  } else {
    errors.push(...summarizeSqlGuardrailIssues(percentileScaleIssues));
    warnings.push(...summarizeSqlGuardrailIssues(advisoryGuardrailIssues, {
      includeRules: guardrailRules,
    }));
  }

  // Check for unbalanced parentheses (ignore parentheses inside string literals)
  const stripSingleQuotedStrings = (s: string): string => {
    let out = '';
    let inSingle = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\'') {
        if (inSingle && s[i + 1] === '\'') {
          // Escaped quote inside string: ''
          i++;
          continue;
        }
        inSingle = !inSingle;
        continue;
      }
      if (!inSingle) out += ch;
    }
    return out;
  };
  const sqlForParens = stripSingleQuotedStrings(sql);
  const openParens = (sqlForParens.match(/\(/g) || []).length;
  const closeParens = (sqlForParens.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    errors.push(`Unbalanced parentheses: ${openParens} open, ${closeParens} close`);
  }

  // Check for unterminated strings
  const singleQuotes = (sql.match(/'/g) || []).length;
  if (singleQuotes % 2 !== 0) {
    errors.push('Unterminated string literal (odd number of single quotes)');
  }

  return { errors, warnings };
}

/**
 * Contract validation: input declarations, condition references, iterator sources
 */
export function validateContracts(skill: SkillDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Input declarations completeness
  if (Array.isArray(skill.inputs)) {
    const validTypes = new Set(['string', 'number', 'integer', 'boolean', 'timestamp', 'duration', 'array', 'object']);
    for (const input of skill.inputs) {
      if (!input.name) {
        errors.push(`inputs: Input missing name`);
        continue;
      }
      if (input.type && !validTypes.has(input.type)) {
        warnings.push(`inputs.${input.name}: Unknown type '${input.type}' (valid: ${[...validTypes].join(', ')})`);
      }
      if (input.required && !input.description) {
        warnings.push(`inputs.${input.name}: Required input missing description`);
      }
    }
  }

  // 2. Shared in-process checks. Runtime reconciliation and the source CLI
  // intentionally use the same pure validator; no npm/child-process boundary.
  const definitions = loadSkillDefinitionsById();
  for (const validationIssue of validateSkillDefinitionInProcess(skill, {
    fragmentCache: loadSkillFragmentCache(),
    definitions,
    // The registry is the same for every file: its readers are keyed once, not per file.
    causeWordingReaders: diskCauseWordingReaders ??= registryCauseWordingReaders([...definitions.values()]),
  })) {
    const formatted = `${validationIssue.path}: ${validationIssue.message}`;
    if (validationIssue.severity === 'error') {
      errors.push(formatted);
    } else {
      warnings.push(formatted);
    }
  }

  return { errors, warnings };
}

/** The placeholders SQL binds (boundSqlPlaceholders: comments excluded), as written inside `${...}`. */
function extractVariableReferences(sql: string): string[] {
  return boundSqlPlaceholders(sql).map(placeholder => placeholder.match.slice(2, -1));
}

/**
 * A pipeline definition is read by the pipeline loaders, not executed as a
 * Skill, so only its top-level keys are checked here.
 */
function validatePipelineDefinitionKeys(definition: object, filePath: string): ValidationResult {
  const errors = unknownSkillTopLevelKeys(definition).map(key => `${key}: ${UNKNOWN_TOP_LEVEL_KEY_MESSAGE}`);
  return {file: filePath, valid: errors.length === 0, errors, warnings: []};
}

/** Which loader reads a Skill YAML file; Skill contracts apply only to `skill`. */
function skillYamlKind(filePath: string, parsed: unknown): 'vendor_override' | 'pipeline' | 'skill' {
  if (/\.override\.ya?ml$/.test(filePath)) return 'vendor_override';
  return (parsed as {type?: unknown} | undefined)?.type === 'pipeline_definition' ? 'pipeline' : 'skill';
}

/**
 * Validate a single skill file.
 * @internal Exported for tests; the command is the production caller.
 */
export function validateFile(filePath: string): ValidationResult {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as SkillDefinition | VendorOverrideDefinition;

    if (!parsed) {
      return {
        file: filePath,
        valid: false,
        errors: ['Failed to parse YAML: empty or invalid content'],
        warnings: [],
      };
    }

    switch (skillYamlKind(filePath, parsed)) {
      case 'vendor_override':
        return validateVendorOverrideDefinition(parsed as VendorOverrideDefinition, filePath);
      case 'pipeline':
        return validatePipelineDefinitionKeys(parsed, filePath);
      case 'skill':
        return validateSkillDefinition(parsed as SkillDefinition, filePath);
    }
  } catch (error: any) {
    return {
      file: filePath,
      valid: false,
      errors: [`Failed to parse YAML: ${error.message}`],
      warnings: [],
    };
  }
}

/**
 * Find all skill files
 */
function findSkillFiles(dir: string, pattern: string | RegExp): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findSkillFiles(fullPath, pattern));
    } else if (entry.isFile() && entry.name.match(pattern)) {
      files.push(fullPath);
    }
  }

  return files;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRegexPattern(
  pattern: unknown,
  errors: string[],
  fieldPath: string,
): void {
  if (!isNonEmptyString(pattern)) {
    errors.push(`${fieldPath} must be a non-empty string`);
    return;
  }
  try {
    // Legacy metadata retains valid JavaScript syntax; final report coverage is semantic.
    new RegExp(pattern, 'i');
  } catch (error: any) {
    errors.push(`${fieldPath} is not a valid JavaScript regex: ${error.message}`);
  }
}

function validateFinalReportContractFrontmatter(frontmatter: Record<string, unknown>, file: string): string[] {
  const errors: string[] = [];
  const contract = frontmatter.final_report_contract;
  if (contract === undefined) return errors;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return ['final_report_contract must be an object'];
  }

  const requiredSections = (contract as Record<string, unknown>).required_sections;
  if (!Array.isArray(requiredSections)) {
    return ['final_report_contract.required_sections must be an array'];
  }

  for (let i = 0; i < requiredSections.length; i++) {
    const section = requiredSections[i];
    const prefix = `final_report_contract.required_sections[${i}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    const record = section as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      errors.push(`${prefix}.id must be a non-empty string`);
    }
    if (!isNonEmptyString(record.label)) {
      errors.push(`${prefix}.label must be a non-empty string`);
    }
    if (record.description !== undefined && typeof record.description !== 'string') {
      errors.push(`${prefix}.description must be a string when present`);
    }
    if (record.required !== undefined && typeof record.required !== 'boolean') {
      errors.push(`${prefix}.required must be a boolean when present`);
    }
    if (record.trigger_patterns !== undefined && !Array.isArray(record.trigger_patterns)) {
      errors.push(`${prefix}.trigger_patterns must be an array when present`);
    }

    const patterns = record.patterns;
    const patternGroups = record.pattern_groups;
    const hasPatterns = Array.isArray(patterns) && patterns.length > 0;
    const hasPatternGroups = Array.isArray(patternGroups) && patternGroups.length > 0;
    if (!isNonEmptyString(record.description) && !hasPatterns && !hasPatternGroups) {
      errors.push(`${prefix} must define a non-empty description, patterns or pattern_groups`);
    }

    if (patterns !== undefined) {
      if (!Array.isArray(patterns)) {
        errors.push(`${prefix}.patterns must be an array when present`);
      } else {
        patterns.forEach((pattern, patternIndex) => {
          validateRegexPattern(pattern, errors, `${prefix}.patterns[${patternIndex}]`);
        });
      }
    }

    if (Array.isArray(record.trigger_patterns)) {
      record.trigger_patterns.forEach((pattern, patternIndex) => {
        validateRegexPattern(pattern, errors, `${prefix}.trigger_patterns[${patternIndex}]`);
      });
    }

    if (patternGroups !== undefined) {
      if (!Array.isArray(patternGroups)) {
        errors.push(`${prefix}.pattern_groups must be an array when present`);
      } else {
        patternGroups.forEach((group, groupIndex) => {
          const groupPath = `${prefix}.pattern_groups[${groupIndex}]`;
          if (!Array.isArray(group) || group.length === 0) {
            errors.push(`${groupPath} must be a non-empty array`);
            return;
          }
          group.forEach((pattern, patternIndex) => {
            validateRegexPattern(pattern, errors, `${groupPath}[${patternIndex}]`);
          });
        });
      }
    }
  }

  if (errors.length > 0) {
    return errors.map(error => `${file}: ${error}`);
  }
  return errors;
}

function validateVerifierMisdiagnosisFrontmatter(
  frontmatter: Record<string, unknown>,
  file: string,
  context: StrategyFrontmatterValidationContext = {},
): string[] {
  const errors: string[] = [];
  const entries = frontmatter.verifier_misdiagnosis_patterns;
  if (entries === undefined) return errors;
  if (!Array.isArray(entries)) {
    return [`${file}: verifier_misdiagnosis_patterns must be an array`];
  }

  entries.forEach((entry, index) => {
    const prefix = `verifier_misdiagnosis_patterns[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }

    const record = entry as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      errors.push(`${prefix}.id must be a non-empty string`);
    } else if (context.seenVerifierMisdiagnosisIds) {
      const previousFile = context.seenVerifierMisdiagnosisIds.get(record.id);
      if (previousFile) {
        errors.push(`${prefix}.id duplicates "${record.id}" already declared in ${previousFile}`);
      } else {
        context.seenVerifierMisdiagnosisIds.set(record.id, file);
      }
    }

    if (record.type !== 'known_misdiagnosis') {
      errors.push(`${prefix}.type must be known_misdiagnosis`);
    }
    if (!isNonEmptyString(record.message)) {
      errors.push(`${prefix}.message must be a non-empty string`);
    }
    if (
      record.severity !== undefined
      && (
        typeof record.severity !== 'string'
        || !VERIFIER_MISDIAGNOSIS_SEVERITIES.has(record.severity)
      )
    ) {
      errors.push(`${prefix}.severity must be one of warning, info`);
    }

    if (!Array.isArray(record.patterns) || record.patterns.length === 0) {
      errors.push(`${prefix}.patterns must be a non-empty array`);
    } else {
      record.patterns.forEach((pattern, patternIndex) => {
        validateRegexPattern(pattern, errors, `${prefix}.patterns[${patternIndex}]`);
      });
    }

    if (record.global !== undefined && typeof record.global !== 'boolean') {
      errors.push(`${prefix}.global must be a boolean when present`);
    }

    const scenes = record.scenes;
    const hasGlobalScope = record.global === true;
    let validSceneCount = 0;
    const seenScenes = new Set<string>();
    if (scenes !== undefined) {
      if (!Array.isArray(scenes)) {
        errors.push(`${prefix}.scenes must be an array when present`);
      } else {
        scenes.forEach((scene, sceneIndex) => {
          const scenePath = `${prefix}.scenes[${sceneIndex}]`;
          if (!isNonEmptyString(scene)) {
            errors.push(`${scenePath} must be a non-empty string`);
            return;
          }
          validSceneCount++;
          if (seenScenes.has(scene)) {
            errors.push(`${scenePath} duplicates scene "${scene}"`);
            return;
          }
          seenScenes.add(scene);
          if (context.knownScenes && !context.knownScenes.has(scene)) {
            errors.push(`${scenePath} references unknown or contract-only scene "${scene}"`);
          }
        });
      }
    }

    if (hasGlobalScope && validSceneCount > 0) {
      errors.push(`${prefix} must declare either global: true or scenes, not both`);
    } else if (!hasGlobalScope && validSceneCount === 0) {
      errors.push(`${prefix} must declare global: true or a non-empty scenes array`);
    }
  });

  return errors.map(error => `${file}: ${error}`);
}

function parseStrategyFrontmatter(content: string, file: string): { frontmatter: Record<string, unknown> | null; errors: string[] } {
  const match = content.match(STRATEGY_FRONTMATTER_RE);
  if (!match) return { frontmatter: null, errors: [`${file}: missing or invalid YAML frontmatter`] };
  try {
    const frontmatter = yaml.load(match[1]);
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
      return { frontmatter: null, errors: [`${file}: YAML frontmatter must be an object`] };
    }
    return { frontmatter: frontmatter as Record<string, unknown>, errors: [] };
  } catch (error: any) {
    return { frontmatter: null, errors: [`${file}: failed to parse YAML frontmatter: ${error.message}`] };
  }
}

export function validateStrategyFrontmatter(
  content: string,
  file: string,
  context: StrategyFrontmatterValidationContext = {},
): string[] {
  const parsed = parseStrategyFrontmatter(content, file);
  if (parsed.errors.length > 0 || !parsed.frontmatter) return parsed.errors;
  const investigationErrors: string[] = [];
  try {
    const contract = parseInvestigationContract(parsed.frontmatter.investigation_contract, context.investigationProfiles ?? new Map());
    if (!contract && context.requireInvestigationContract) investigationErrors.push(`${file}: investigation_contract is required`);
    const legacy = parsed.frontmatter.investigation_requirements;
    if (legacy !== undefined && (!Array.isArray(legacy) || !legacy.length || !legacy.every(isNonEmptyString))) {
      investigationErrors.push(`${file}: invalid legacy investigation_requirements`);
    }
  } catch (error) {
    investigationErrors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [
    ...investigationErrors,
    ...validateFinalReportContractFrontmatter(parsed.frontmatter, file),
    ...validateVerifierMisdiagnosisFrontmatter(parsed.frontmatter, file, context),
  ];
}

/**
 * Validate strategy files: check that all invoke_skill("xxx") references
 * point to skills that exist in the skill registry, and that each example's
 * argument keys are inputs the named Skill declares.
 *
 * Returns the number of strategy validation errors (0 = all good).
 */
function validateStrategySkillReferences(): number {
  if (!fs.existsSync(STRATEGIES_DIR)) {
    console.log(colors.yellow('No strategies directory found.'));
    return 0;
  }

  // Build the skill input registry from YAML files on disk (no runtime loader needed)
  const skills = new Map<string, StrategySkillInputs>(
    [...loadSkillDefinitionsById()].map(([name, skill]) => [name, {inputs: skill.inputs}]),
  );

  console.log(colors.bold('\nStrategy → Skill Reference Validation\n'));
  console.log(`Skill registry: ${skills.size} skills loaded from YAML.\n`);

  // Parse strategy files for invoke_skill("xxx") references and cross-file frontmatter contracts.
  const strategyFiles = fs.readdirSync(STRATEGIES_DIR)
    .filter(f => f.endsWith('.strategy.md'));

  if (strategyFiles.length === 0) {
    console.log(colors.yellow('No strategy files found.'));
    return 0;
  }

  let totalMissing = 0;
  let totalUndeclaredParams = 0;
  let totalFrontmatterErrors = 0;
  const strategyContents = new Map<string, string>();
  const knownScenes = new Set<string>();
  for (const file of strategyFiles) {
    const filePath = path.join(STRATEGIES_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    strategyContents.set(file, content);
    const parsed = parseStrategyFrontmatter(content, file);
    const frontmatter = parsed.frontmatter;
    if (!frontmatter) continue;
    if (
      isNonEmptyString(frontmatter.scene)
      && frontmatter.strategy_kind !== 'contract_only'
    ) {
      knownScenes.add(frontmatter.scene);
    }
  }
  const frontmatterValidationContext: StrategyFrontmatterValidationContext = {
    knownScenes,
    seenVerifierMisdiagnosisIds: new Map(),
    investigationProfiles: parseInvestigationProfiles(yaml.load(fs.readFileSync(
      path.join(STRATEGIES_DIR, 'investigation-profiles.yaml'), 'utf8',
    ))),
    requireInvestigationContract: true,
  };

  for (const file of strategyFiles) {
    const content = strategyContents.get(file) || '';
    const frontmatterErrors = validateStrategyFrontmatter(content, file, frontmatterValidationContext);

    // Same Strategy → Skill call contract the Self-Evolution validator enforces.
    const calls = extractStrategySkillCalls(content);
    const referencedSkills = new Set(calls.map(call => call.skillId));
    const findings = checkStrategySkillCalls(calls, skills);
    const missing = [...new Set(findings
      .filter(finding => finding.kind === 'skill_missing')
      .map(finding => finding.call.skillId))];
    const undeclaredParams = findings.flatMap(finding =>
      finding.kind === 'param_undeclared' ? [formatUndeclaredStrategySkillParams(finding)] : []);
    if (missing.length > 0 || undeclaredParams.length > 0 || frontmatterErrors.length > 0) {
      console.log(`${colors.red('FAIL')} ${file}`);
      for (const name of missing) {
        console.log(`  ${colors.red('ERROR:')} invoke_skill("${name}") — skill not found in registry`);
      }
      for (const error of [...undeclaredParams, ...frontmatterErrors]) {
        console.log(`  ${colors.red('ERROR:')} ${error}`);
      }
      totalMissing += missing.length;
      totalUndeclaredParams += undeclaredParams.length;
      totalFrontmatterErrors += frontmatterErrors.length;
      continue;
    }

    if (referencedSkills.size === 0) {
      console.log(`${colors.gray('SKIP')} ${file} (no invoke_skill references)`);
      continue;
    }

    console.log(`${colors.green('PASS')} ${file} (${referencedSkills.size} skill refs OK)`);
  }

  // Runtime policy YAMLs are otherwise checked only when a run loads them.
  const policyErrors = STRATEGY_POLICY_PARSERS.flatMap(([name, parse]) => {
    try {
      parse(yaml.load(fs.readFileSync(path.join(STRATEGIES_DIR, `${name}.yaml`), 'utf8')));
      console.log(`${colors.green('PASS')} ${name}.yaml`);
      return [];
    } catch (error) {
      console.log(`${colors.red('FAIL')} ${name}.yaml`);
      console.log(`  ${colors.red('ERROR:')} ${error instanceof Error ? error.message : String(error)}`);
      return [name];
    }
  });

  console.log(colors.bold('\nStrategy Validation Summary:'));
  console.log(`  Strategy files: ${strategyFiles.length}`);
  const count = (n: number) => n > 0 ? colors.red(String(n)) : colors.green('0');
  console.log(`  Missing skills: ${count(totalMissing)}`);
  console.log(`  Undeclared skill params: ${count(totalUndeclaredParams)}`);
  console.log(`  Contract/frontmatter errors: ${count(totalFrontmatterErrors)}`);
  console.log(`  Policy file errors: ${count(policyErrors.length)}`);

  return totalMissing + totalUndeclaredParams + totalFrontmatterErrors + policyErrors.length;
}

/** Policy YAMLs under backend/strategies with the parser each run uses. */
const STRATEGY_POLICY_PARSERS: ReadonlyArray<readonly [string, (value: unknown) => unknown]> = [
  ['source-depth-policy', parseSourceDepthPolicy],
  ['source-anchor-normalization', parseSourceAnchorNormalization],
];

/**
 * Validate command
 */
export const validateCommand = new Command('validate')
  .description('Validate skill YAML files and strategy references')
  .argument('[skillId]', 'Specific skill ID to validate (optional)')
  .option('-a, --all', 'Validate all skills including vendor overrides')
  .option('-c, --contracts', 'Run contract checks (input types, condition refs, iterator sources)')
  .option('-s, --strategies', 'Validate strategy files: check invoke_skill references exist in skill registry')
  .option('--cases', 'Validate curated Markdown case knowledge files')
  .option('--cases-dir <path>', 'Case knowledge directory (defaults to backend/knowledge/cases)')
  .option('-v, --verbose', 'Show detailed validation output')
  .action((skillId: string | undefined, options: { all?: boolean; contracts?: boolean; strategies?: boolean; cases?: boolean; casesDir?: string; verbose?: boolean }) => {
    if (options.cases) {
      if (skillId || options.contracts || options.strategies || options.all) {
        console.log(colors.red('--cases must be used without skillId, --all, --contracts, or --strategies'));
        process.exit(1);
      }
      const casesDir = path.resolve(options.casesDir ?? CASES_DIR);
      console.log(colors.bold('\nSmartPerfetto Case Knowledge Validator\n'));
      console.log(`Cases: ${colors.gray(casesDir)}\n`);
      const result = validateCaseKnowledgeFiles(casesDir);
      if (result.ok) {
        console.log(`${colors.green('PASS')} ${result.cases.length} case file(s)`);
        process.exit(0);
      }
      for (const issue of result.issues) {
        console.log(`${colors.red('FAIL')} ${issue.filePath}`);
        console.log(`  ${colors.red('ERROR:')} ${issue.message}`);
      }
      console.log(colors.bold('\nCase Knowledge Validation Summary:'));
      console.log(`  Case files: ${result.cases.length}`);
      console.log(`  Errors: ${colors.red(String(result.issues.length))}`);
      process.exit(1);
    }

    // Strategy-only mode: just validate strategy → skill references
    if (options.strategies && !skillId && !options.contracts) {
      console.log(colors.bold('\nSmartPerfetto Strategy Validator\n'));
      const missing = validateStrategySkillReferences();
      process.exit(missing > 0 ? 1 : 0);
    }

    console.log(colors.bold('\nSmartPerfetto Skill Validator\n'));

    let files: string[] = [];

    // The files the loader reads (listSkillFiles), and with --all the vendor overrides.
    const skillFiles = listSkillFiles(SKILLS_DIR, {includeCustom: true});
    if (skillId) {
      // Validate specific skill
      const foundPath = skillFiles.find(file => path.basename(file.path).replace(SKILL_FILE_PATTERN, '') === skillId)?.path;
      if (foundPath) {
        files.push(foundPath);
      } else {
        console.log(colors.red(`Skill not found: ${skillId}`));
        process.exit(1);
      }
    } else if (options.all) {
      files = skillFiles.map(file => file.path);
      files.push(...findSkillFiles(path.join(SKILLS_DIR, SKILL_LAYOUT.vendorsDir), /\.override\.ya?ml$/));
    } else {
      // Without --all: the plain Skill directories.
      files = skillFiles.filter(file => file.kind === 'skill' && !file.path.includes(`${path.sep}${SKILL_LAYOUT.customDir}${path.sep}`))
        .map(file => file.path);
    }

    if (files.length === 0) {
      console.log(colors.yellow('No skill files found.'));
      process.exit(0);
    }

    console.log(`Found ${files.length} skill file(s) to validate.\n`);

    let totalErrors = 0;
    let totalWarnings = 0;
    let validCount = 0;

    for (const file of files) {
      const result = validateFile(file);

      // Run contract validation when --contracts is specified
      if (options.contracts) {
        let skill: SkillDefinition | undefined;
        try {
          skill = yaml.load(fs.readFileSync(file, 'utf-8')) as SkillDefinition;
        } catch { /* parse error already captured */ }
        // A validator that throws must fail the run, not pass as a parse error.
        if (skill && skillYamlKind(file, skill) === 'skill') {
          const contracts = validateContracts(skill);
          result.errors.push(...contracts.errors);
          result.warnings.push(...contracts.warnings);
          if (contracts.errors.length > 0) {
            result.valid = false;
          }
        }
      }

      const relativePath = path.relative(SKILLS_DIR, file);

      if (result.valid) {
        console.log(`${colors.green('PASS')} ${relativePath}`);
        validCount++;
      } else {
        console.log(`${colors.red('FAIL')} ${relativePath}`);
      }

      if (options.verbose || result.errors.length > 0) {
        for (const error of result.errors) {
          console.log(`  ${colors.red('ERROR:')} ${error}`);
        }
      }

      if (options.verbose || result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`  ${colors.yellow('WARNING:')} ${warning}`);
        }
      }

      totalErrors += result.errors.length;
      totalWarnings += result.warnings.length;

      if (result.errors.length > 0 || result.warnings.length > 0) {
        console.log('');
      }
    }

    // Run strategy validation when --strategies is specified (combined with skill validation)
    if (options.strategies) {
      totalErrors += validateStrategySkillReferences();
    }

    // Summary
    console.log(colors.bold('\nSummary:'));
    console.log(`  Files:    ${files.length}`);
    console.log(`  Passed:   ${colors.green(String(validCount))}`);
    console.log(`  Failed:   ${colors.red(String(files.length - validCount))}`);
    console.log(`  Errors:   ${totalErrors > 0 ? colors.red(String(totalErrors)) : '0'}`);
    console.log(`  Warnings: ${totalWarnings > 0 ? colors.yellow(String(totalWarnings)) : '0'}`);

    process.exit(totalErrors > 0 ? 1 : 0);
  });
