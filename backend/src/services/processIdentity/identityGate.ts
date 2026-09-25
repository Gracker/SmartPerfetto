// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillDefinition, SkillStep } from '../skillEngine/types';
import { builtInSkillFragment } from '../skillEngine/skillFragments';
import type { IdentityTraceSide } from '../../types/identityContract';
import { assertEffectiveProcessScope, createEffectiveProcessScope, verifiedIdentityForScope, type EffectiveProcessScope } from './effectiveProcessScope';
import {
  DEFAULT_PROCESS_IDENTITY_ALIASES,
  PROCESS_IDENTITY_SELECTORS,
  type ProcessIdentityResolution,
  type ProcessIdentityTarget,
  type SkillIdentityConfig,
} from './types';

export interface IdentityGateInput {
  traceId: string;
  traceSide?: IdentityTraceSide;
  processScope?: EffectiveProcessScope;
  skill: SkillDefinition;
  params: Record<string, any>;
  inherited?: Record<string, any>;
  resolve: (target: ProcessIdentityTarget) => Promise<ProcessIdentityResolution>;
}

export interface IdentityGateResult {
  allowed: boolean;
  params: Record<string, any>;
  inherited: Record<string, any>;
  config: SkillIdentityConfig;
  target?: ProcessIdentityTarget;
  resolution?: ProcessIdentityResolution;
  processScope?: EffectiveProcessScope;
  error?: string;
}

/**
 * Comparison that scopes a query to a named process.
 *
 * Word operators need whitespace to be operators at all (`nameGLOB` is not a
 * comparison), but symbol operators do not: `p.name='com.foo'` is idiomatic SQL
 * and was previously invisible here, which silently skipped both the raw-SQL
 * identity warning and Skill identity admission.
 */
const PROCESS_NAME_FILTER_OPERATORS =
  '(?:\\s+(?:NOT\\s+GLOB|NOT\\s+LIKE|GLOB|LIKE|IN|IS(?:\\s+NOT)?)\\b|\\s*(?:!=|<>|=))';
const SQL_KEYWORDS = new Set([
  'where',
  'on',
  'using',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'full',
  'group',
  'order',
  'limit',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function collectProcessTableAliases(sql: string): Set<string> {
  const aliases = new Set<string>(['process']);
  const re = /\b(?:FROM|JOIN)\s+process\b(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  for (const match of sql.matchAll(re)) {
    const alias = match[1]?.toLowerCase();
    if (alias && !SQL_KEYWORDS.has(alias)) {
      aliases.add(alias);
    }
  }
  return aliases;
}

export function sqlUsesProcessNameFilter(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;

  const stripped = stripSqlComments(sql);
  const operator = PROCESS_NAME_FILTER_OPERATORS;
  const hasProcessTable = /\b(?:FROM|JOIN)\s+process\b/i.test(stripped);

  for (const alias of collectProcessTableAliases(stripped)) {
    const qualifiedNameRe = new RegExp(`\\b${escapeRegex(alias)}\\.name${operator}`, 'i');
    if (qualifiedNameRe.test(stripped)) return true;
  }

  if (hasProcessTable) {
    const unqualifiedNameRe = new RegExp(`(?<!\\.)\\bname${operator}`, 'i');
    if (unqualifiedNameRe.test(stripped)) return true;
  }

  const identityColumnRe = new RegExp(
    `\\b(?:[A-Za-z_][A-Za-z0-9_]*\\.)?(?:process_name|client_process|server_process|package_name)${operator}`,
    'i',
  );
  return identityColumnRe.test(stripped);
}

/**
 * Resolves a declared `fragments/<file>.sql` to its text. Self-Evolution copies
 * base fragments unchanged, so the built-in file is what every registry holds;
 * an unknown fragment contributes nothing.
 */
type SkillFragmentResolver = (fragmentPath: string) => string | undefined;

const LABEL_ONLY_FRAGMENT = /^\s*--\s*process-identity:\s*label-only\b/m;

function builtInFragmentText(fragmentPath: string): string | undefined {
  try {
    return builtInSkillFragment(fragmentPath.replace(/^fragments\//, ''));
  } catch {
    return undefined;
  }
}

/** One executable statement: a SQL text plus the fragments injected into it. */
function sqlUnit(source: any, resolveFragment: SkillFragmentResolver): string | undefined {
  if (!source || typeof source !== 'object' || typeof source.sql !== 'string') return undefined;
  const parts = [source.sql];
  for (const fragmentPath of Array.isArray(source.sql_fragments) ? source.sql_fragments : []) {
    const text = typeof fragmentPath === 'string' ? resolveFragment(fragmentPath) : undefined;
    // A fragment that only labels processes (declared in its header) does not
    // select target evidence, so its name comparisons are not a process filter.
    if (text && !LABEL_ONLY_FRAGMENT.test(text)) parts.push(text);
  }
  return parts.join('\n');
}

function collectStepSql(step: SkillStep | any, out: string[], resolveFragment: SkillFragmentResolver): void {
  if (!step || typeof step !== 'object') return;
  for (const unit of [sqlUnit(step, resolveFragment), sqlUnit(step.exact_sql, resolveFragment)]) {
    if (unit !== undefined) out.push(unit);
  }

  if (Array.isArray(step.steps)) {
    for (const nested of step.steps) collectStepSql(nested, out, resolveFragment);
  }

  if (Array.isArray(step.conditions)) {
    for (const branch of step.conditions) {
      if (branch?.then && typeof branch.then === 'object') {
        collectStepSql(branch.then, out, resolveFragment);
      }
    }
  }

  if (step.else && typeof step.else === 'object') {
    collectStepSql(step.else, out, resolveFragment);
  }
}

/**
 * Every statement a Skill can execute, each with the fragments injected into
 * it. Detection runs per statement: a process table read in one step and a
 * bare `name =` in another are not a process-name filter.
 */
export function collectSkillSqlUnits(
  skill: SkillDefinition,
  resolveFragment: SkillFragmentResolver = builtInFragmentText,
): string[] {
  const units: string[] = [];
  const root = sqlUnit(skill, resolveFragment);
  if (root !== undefined) units.push(root);
  if (Array.isArray(skill.steps)) {
    for (const step of skill.steps) collectStepSql(step, units, resolveFragment);
  }
  return units;
}

export function skillUsesProcessNameFilter(
  skill: SkillDefinition,
  resolveFragment: SkillFragmentResolver = builtInFragmentText,
): boolean {
  return collectSkillSqlUnits(skill, resolveFragment).some(sqlUsesProcessNameFilter);
}

export function getEffectiveIdentityConfig(skill: SkillDefinition): SkillIdentityConfig {
  if (skill.name === 'process_identity_resolver') {
    return { policy: 'exempt', scope: 'process' };
  }

  const explicit = skill.identity;
  if (explicit?.policy) {
    return {
      scope: 'process',
      aliases: DEFAULT_PROCESS_IDENTITY_ALIASES,
      rewriteTo: 'recommended_process_name_param',
      minConfidence: 50,
      ...explicit,
    };
  }

  if (skillUsesProcessNameFilter(skill)) {
    return {
      policy: 'verify_if_present',
      scope: 'process',
      aliases: DEFAULT_PROCESS_IDENTITY_ALIASES,
      rewriteTo: 'recommended_process_name_param',
      minConfidence: 50,
    };
  }

  return { policy: 'none' };
}

/** Selectors require either a declared input or an actual process-gate consumer. */
export function getConsumableProcessIdentitySelectors(skill: SkillDefinition): Set<string> {
  const declared = new Set(skill.inputs?.map(input => input.name) || []);
  const allowed = new Set(PROCESS_IDENTITY_SELECTORS.filter(key => declared.has(key)));
  const config = getEffectiveIdentityConfig(skill);
  const targetBinding = skill.process_scope?.role === 'target' && Boolean(skill.process_scope.binding);
  const hasProcessGate = config.scope === 'process' &&
    (config.policy === 'required' || config.policy === 'verify_if_present') &&
    (!skill.process_scope || skill.process_scope.role === 'target');
  if (hasProcessGate) {
    for (const key of [...DEFAULT_PROCESS_IDENTITY_ALIASES, ...(config.aliases || []), 'upid', 'pid']) allowed.add(key);
  } else if (targetBinding) {
    allowed.add('upid');
    allowed.add('pid');
  }
  // Resolving a thread's process does not make the Skill's SQL thread-scoped.
  for (const key of ['thread_name', 'threadName']) if (!declared.has(key)) allowed.delete(key);
  return allowed;
}

function firstValue(source: Record<string, any>, keys: string[]): any {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
}

function coerceInteger(value: any): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

export function extractProcessIdentityTarget(
  params: Record<string, any>,
  inherited: Record<string, any>,
  config: SkillIdentityConfig,
): ProcessIdentityTarget {
  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  const hasExplicitSelector = firstValue(params, [...DEFAULT_PROCESS_IDENTITY_ALIASES, ...aliases, 'upid', 'pid']) !== undefined;
  const requestedName = firstValue(params, [...aliases, ...DEFAULT_PROCESS_IDENTITY_ALIASES]) ??
    (hasExplicitSelector ? undefined : firstValue(inherited, aliases));
  const threadName = firstValue(params, ['thread_name', 'threadName']) ?? firstValue(inherited, ['thread_name', 'threadName']);
  const upid = coerceInteger(firstValue(params, ['upid']) ?? (hasExplicitSelector ? undefined : firstValue(inherited, ['upid'])));
  const pid = coerceInteger(firstValue(params, ['pid']) ?? (hasExplicitSelector ? undefined : firstValue(inherited, ['pid'])));
  const startTs = firstValue(params, ['start_ts', 'startTs']) ?? firstValue(inherited, ['start_ts', 'startTs']);
  const endTs = firstValue(params, ['end_ts', 'endTs']) ?? firstValue(inherited, ['end_ts', 'endTs']);

  return {
    ...(requestedName !== undefined ? { requestedName: String(requestedName).trim() } : {}),
    ...(threadName !== undefined ? { threadName: String(threadName).trim() } : {}),
    ...(upid !== undefined ? { upid } : {}),
    ...(pid !== undefined ? { pid } : {}),
    ...(startTs !== undefined ? { startTs } : {}),
    ...(endTs !== undefined ? { endTs } : {}),
  };
}

function hasTarget(target: ProcessIdentityTarget): boolean {
  return Boolean(target.requestedName || target.threadName || target.upid !== undefined || target.pid !== undefined);
}

function isVerified(resolution: ProcessIdentityResolution, config: SkillIdentityConfig): boolean {
  if (resolution.status !== 'verified') return false;
  const minConfidence = config.minConfidence ?? 50;
  return resolution.confidenceScore >= minConfidence;
}

function rewriteParams(
  params: Record<string, any>,
  skill: SkillDefinition,
  target: ProcessIdentityTarget,
  resolution: ProcessIdentityResolution,
  config: SkillIdentityConfig,
): Record<string, any> {
  const rewritten = { ...params };
  if (!isVerified(resolution, config)) return rewritten;

  const declaredInputs = new Set((skill.inputs || []).map(input => input.name));
  const hasInputDeclarations = Array.isArray(skill.inputs) && skill.inputs.length > 0;

  if (config.rewriteTo === 'upid' && resolution.upids.length === 1 && target.upid === undefined) {
    rewritten.upid = resolution.upids[0];
    return rewritten;
  }

  const recommended = resolution.recommendedProcessNameParam;
  if (!recommended && target.upid === undefined) return rewritten;

  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  for (const alias of aliases) {
    if (rewritten[alias] !== undefined && rewritten[alias] !== null && String(rewritten[alias]).trim() !== '') {
      rewritten[alias] = recommended;
    }
  }

  if (target.requestedName || target.upid !== undefined) {
    // Keep legacy YAML skills safe: most process filters read either package or
    // process_name regardless of which alias the caller originally supplied.
    if (hasInputDeclarations) {
      for (const alias of aliases) {
        if (declaredInputs.has(alias) && rewritten[alias] === undefined) {
          rewritten[alias] = recommended || '';
        }
      }
    }
    if (rewritten.package !== undefined || declaredInputs.has('package') || !hasInputDeclarations) {
      rewritten.package = recommended || '';
    }
    if (rewritten.process_name !== undefined || declaredInputs.has('process_name') || !hasInputDeclarations) {
      rewritten.process_name = recommended || '';
    }
    if (hasInputDeclarations) {
      for (const alias of aliases) {
        if (!declaredInputs.has(alias)) {
          delete rewritten[alias];
        }
      }
    }
  }

  // UPID/PID may select a unique process for the identity gate without being
  // part of the target Skill's public input contract. Consume those selectors
  // before validating or substituting Skill parameters.
  if (!declaredInputs.has('upid')) delete rewritten.upid;
  if (!declaredInputs.has('pid')) delete rewritten.pid;

  return rewritten;
}

export class IdentityGate {
  async apply(input: IdentityGateInput): Promise<IdentityGateResult> {
    const inherited = input.inherited || {};
    const config = getEffectiveIdentityConfig(input.skill);
    const traceSide = input.traceSide || 'current';
    const parentScope = input.processScope;
    const blocked = (error: string): IdentityGateResult => ({
      allowed: false, params: input.params, inherited, config, error,
    });
    const consumableSelectors = getConsumableProcessIdentitySelectors(input.skill);
    const unusedThreadSelectors = ['thread_name', 'threadName'].filter(key =>
      firstValue(input.params, [key]) !== undefined && !consumableSelectors.has(key));
    if (unusedThreadSelectors.length && input.skill.name !== 'process_identity_resolver') {
      return blocked(`Skill does not declare a thread filter input: ${unusedThreadSelectors.join(', ')}`);
    }
    if (parentScope) {
      try { assertEffectiveProcessScope(parentScope, input.traceId, traceSide); }
      catch (error) { return blocked((error as Error).message); }
    }
    for (const key of ['upid', 'pid']) {
      const value = firstValue(input.params, [key]);
      // Zero is the legacy SQL fallback for an omitted selector. An explicitly
      // supplied zero must not enter that fallback and widen the target.
      if (value !== undefined && coerceInteger(value) === undefined) {
        return blocked(`Invalid explicit ${key}: expected a positive safe integer`);
      }
    }

    // Resolver queries inspect identity metadata; they do not select target evidence.
    if (input.skill.name === 'process_identity_resolver') {
      return { allowed: true, params: input.params, inherited, config,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide) };
    }

    let target = extractProcessIdentityTarget(input.params, inherited, config);
    if (parentScope?.mode === 'exact_upid') {
      if (target.upid !== undefined && target.upid !== parentScope.upid) {
        return blocked('Child Skill cannot change the inherited exact UPID');
      }
      target.upid = parentScope.upid;
    }
    if (target.upid === undefined && target.pid === undefined && (config.policy === 'none' || config.policy === 'exempt')) {
      return { allowed: true, params: input.params, inherited, config,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide, target) };
    }
    if (!hasTarget(target)) {
      if (config.policy === 'required') {
        return {
          allowed: false,
          params: input.params,
          inherited,
          config,
          target,
          error: `Process identity is required before running skill "${input.skill.name}", but no package/process/upid target was provided.`,
        };
      }
      return { allowed: true, params: input.params, inherited, config, target,
        processScope: parentScope ?? createEffectiveProcessScope(input.traceId, traceSide) };
    }

    const storedIdentity = parentScope ? verifiedIdentityForScope(parentScope) : undefined;
    const prepared = storedIdentity?.resolution.status === 'verified' && !storedIdentity.resolution.resolverError
      ? storedIdentity : undefined;
    const newThreadTarget = target.threadName && target.threadName !== prepared?.target.threadName;
    const sameNamedTarget = parentScope?.mode === 'named' && prepared && target.upid === undefined &&
      target.pid === undefined &&
      (!target.requestedName || [prepared.target.requestedName, prepared.resolution.canonicalPackageName,
        prepared.resolution.recommendedProcessNameParam].includes(target.requestedName));
    // Identity belongs to this trace instance, independently of the requested
    // analysis interval. Recheck selectors below; do not re-query on enrichment.
    let resolution = (parentScope?.mode === 'exact_upid' || sameNamedTarget) && prepared && !newThreadTarget
      ? prepared.resolution : await input.resolve(target);
    const explicitSelectors = [...new Set([...DEFAULT_PROCESS_IDENTITY_ALIASES, ...(config.aliases || [])])]
      .map(key => ({ key, value: firstValue(input.params, [key]) })).filter(item => item.value !== undefined);
    const explicitNames = explicitSelectors.map(item => String(item.value).trim());
    const conflict = (error: string): IdentityGateResult => ({
      ...blocked(error), target,
      resolution: { ...resolution, status: 'ambiguous', upids: [], warnings: [...resolution.warnings, error] },
    });
    if (target.pid !== undefined && target.upid === undefined) {
      const selected = resolution.candidates.filter(candidate => candidate.pid === target.pid &&
        candidate.upid !== undefined && resolution.upids.includes(candidate.upid));
      if (resolution.status !== 'verified' || resolution.upids.length !== 1 ||
          !selected.some(candidate => candidate.upid === resolution.upids[0])) {
        return conflict('Explicit PID must resolve to one verified UPID; select the intended UPID when the PID was reused');
      }
      target = {...target, upid: resolution.upids[0]};
    }
    if (target.upid !== undefined) {
      const selected = resolution.candidates.filter(candidate => candidate.upid === target.upid);
      if (resolution.status !== 'verified' || resolution.upids.length !== 1 || resolution.upids[0] !== target.upid) {
        return conflict('Explicit UPID could not be verified; no other process may replace it');
      }
      const names = new Set([
        ...selected.flatMap(candidate => [candidate.processName, candidate.metadataProcessName,
          candidate.packageName, candidate.canonicalPackageName, candidate.cmdline, candidate.recommendedProcessNameParam]),
        resolution.canonicalPackageName, resolution.recommendedProcessNameParam,
      ].filter(Boolean));
      const processNames = new Set(selected.flatMap(candidate => [candidate.processName,
        candidate.metadataProcessName, candidate.cmdline, candidate.recommendedProcessNameParam]));
      if (selected.length === 0) processNames.add(resolution.recommendedProcessNameParam);
      if (explicitSelectors.some(({ key, value }) =>
          !(key === 'process_name' || key === 'processName' ? processNames : names).has(String(value).trim())) ||
          (target.pid !== undefined && !selected.some(candidate => candidate.pid === target.pid))) {
        return conflict('Explicit process name/PID conflicts with the selected UPID');
      }
      resolution = { ...resolution, upids: [target.upid], candidates: selected };
      if (parentScope?.mode === 'named' && parentScope.requestedName) {
        const boundary = parentScope.requestedName;
        const belongs = selected.some(candidate => [candidate.processName, candidate.metadataProcessName,
          candidate.packageName, candidate.canonicalPackageName, candidate.cmdline]
          .some(name => name === boundary || name?.startsWith(`${boundary}:`)));
        if (!belongs) return conflict('Resolved UPID is outside the inherited named process scope');
      }
    } else if (new Set(explicitNames).size > 1) {
      const knownNames = new Set([resolution.canonicalPackageName, resolution.recommendedProcessNameParam,
        ...resolution.candidates.filter(candidate => candidate.upid !== undefined && resolution.upids.includes(candidate.upid))
          .flatMap(candidate => [candidate.processName, candidate.packageName,
          candidate.metadataProcessName, candidate.canonicalPackageName, candidate.cmdline])]);
      if (explicitNames.some(name => !knownNames.has(name))) {
        return conflict('Explicit process selector aliases conflict');
      }
    }
    const verified = isVerified(resolution, config);

    if (!verified) {
      const base = `Process identity could not be verified for skill "${input.skill.name}"`;
      const reason = resolution.resolverError
        ? `${base}: resolver failed (${resolution.resolverError})`
        : `${base}: status=${resolution.status}, confidence=${resolution.confidenceScore}`;

      // Keep current broad overview flows resilient when the resolver itself is unavailable.
      if (target.upid === undefined && config.policy === 'verify_if_present' && resolution.status === 'unresolved' && resolution.resolverError) {
        return {
          allowed: true,
          params: input.params,
          inherited: {
            ...inherited,
            identity_resolution: resolution,
            identity_gate_warning: reason,
          },
          config,
          target,
          resolution,
          processScope: createEffectiveProcessScope(input.traceId, traceSide, target, resolution),
        };
      }

      return {
        allowed: false,
        params: input.params,
        inherited,
        config,
        target,
        resolution,
        error: reason,
      };
    }

    const params = rewriteParams(input.params, input.skill, target, resolution, config);
    if (target.upid !== undefined && input.skill.inputs?.some(item => item.name === 'upid')) params.upid = target.upid;
    if (target.pid !== undefined && input.skill.inputs?.some(item => item.name === 'pid')) params.pid = target.pid;
    return {
      allowed: true,
      params,
      inherited: {
        ...inherited,
        identity_resolution: resolution,
      },
      config,
      target,
      resolution,
      processScope: parentScope?.mode === 'exact_upid' || sameNamedTarget ? parentScope :
        createEffectiveProcessScope(input.traceId, traceSide, target, resolution),
    };
  }
}
