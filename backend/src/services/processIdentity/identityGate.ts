// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { SkillDefinition, SkillStep } from '../skillEngine/types';
import {
  DEFAULT_PROCESS_IDENTITY_ALIASES,
  type ProcessIdentityResolution,
  type ProcessIdentityTarget,
  type SkillIdentityConfig,
} from './types';

export interface IdentityGateInput {
  traceId: string;
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

function collectStepSql(step: SkillStep | any, out: string[]): void {
  if (!step || typeof step !== 'object') return;
  if (typeof step.sql === 'string') out.push(step.sql);

  if (Array.isArray(step.steps)) {
    for (const nested of step.steps) collectStepSql(nested, out);
  }

  if (Array.isArray(step.conditions)) {
    for (const branch of step.conditions) {
      if (branch?.then && typeof branch.then === 'object') {
        collectStepSql(branch.then, out);
      }
    }
  }

  if (step.else && typeof step.else === 'object') {
    collectStepSql(step.else, out);
  }
}

export function collectSkillSql(skill: SkillDefinition): string {
  const sql: string[] = [];
  if (typeof skill.sql === 'string') sql.push(skill.sql);
  if (Array.isArray(skill.steps)) {
    for (const step of skill.steps) collectStepSql(step, sql);
  }
  return sql.join('\n');
}

export function skillUsesProcessNameFilter(skill: SkillDefinition): boolean {
  return sqlUsesProcessNameFilter(collectSkillSql(skill));
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
  if (!Number.isInteger(n)) return undefined;
  return n;
}

export function extractProcessIdentityTarget(
  params: Record<string, any>,
  inherited: Record<string, any>,
  config: SkillIdentityConfig,
): ProcessIdentityTarget {
  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  const requestedName = firstValue(params, aliases) ?? firstValue(inherited, aliases);
  const threadName = firstValue(params, ['thread_name', 'threadName']) ?? firstValue(inherited, ['thread_name', 'threadName']);
  const upid = coerceInteger(firstValue(params, ['upid']) ?? firstValue(inherited, ['upid']));
  const pid = coerceInteger(firstValue(params, ['pid']) ?? firstValue(inherited, ['pid']));
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

  if (config.rewriteTo === 'upid' && resolution.upids.length > 0) {
    rewritten.upid = resolution.upids[0];
    return rewritten;
  }

  const recommended = resolution.recommendedProcessNameParam;
  if (!recommended) return rewritten;

  const aliases = config.aliases?.length ? config.aliases : DEFAULT_PROCESS_IDENTITY_ALIASES;
  let rewroteExisting = false;
  for (const alias of aliases) {
    if (rewritten[alias] !== undefined && rewritten[alias] !== null && String(rewritten[alias]).trim() !== '') {
      rewritten[alias] = recommended;
      rewroteExisting = true;
    }
  }

  if (target.requestedName) {
    // Keep legacy YAML skills safe: most process filters read either package or
    // process_name regardless of which alias the caller originally supplied.
    if (hasInputDeclarations) {
      for (const alias of aliases) {
        if (declaredInputs.has(alias) && rewritten[alias] === undefined) {
          rewritten[alias] = recommended;
        }
      }
    }
    if (rewritten.package !== undefined || declaredInputs.has('package') || !hasInputDeclarations) {
      rewritten.package = recommended;
    }
    if (rewritten.process_name !== undefined || declaredInputs.has('process_name') || !hasInputDeclarations) {
      rewritten.process_name = recommended;
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
    const skipForInternalResolver = (inherited as any).__skipIdentityGate === true &&
      input.skill.name === 'process_identity_resolver';

    if (skipForInternalResolver || config.policy === 'none' || config.policy === 'exempt') {
      return { allowed: true, params: input.params, inherited, config };
    }

    const target = extractProcessIdentityTarget(input.params, inherited, config);
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
      return { allowed: true, params: input.params, inherited, config, target };
    }

    const resolution = await input.resolve(target);
    const verified = isVerified(resolution, config);

    if (!verified) {
      const base = `Process identity could not be verified for skill "${input.skill.name}"`;
      const reason = resolution.resolverError
        ? `${base}: resolver failed (${resolution.resolverError})`
        : `${base}: status=${resolution.status}, confidence=${resolution.confidenceScore}`;

      // Keep current broad overview flows resilient when the resolver itself is unavailable.
      if (config.policy === 'verify_if_present' && resolution.status === 'unresolved' && resolution.resolverError) {
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
    };
  }
}
