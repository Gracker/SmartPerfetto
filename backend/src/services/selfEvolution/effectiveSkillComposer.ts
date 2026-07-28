// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  RunManifestScope,
  SetMetadataOperation,
  SkillOverlayDeltaV1,
  SkillOverlayOperation,
} from '../../types/selfEvolution';
import {
  formatDisplayContractIssue,
  validateSkillDisplayContract,
} from '../skillEngine/displayContractValidator';
import type {
  DisplayConfig,
  SkillDefinition,
  SkillStep,
} from '../skillEngine/types';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import {fingerprintSkillDefinition} from './skillFingerprint';
import {
  validateDisplayConfigRuntime,
  validateSkillStepListRuntime,
} from './skillStepRuntimeValidator';

const OVERLAY_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export type SkillOverlayValidationReason =
  | 'invalid_overlay'
  | 'scope_mismatch'
  | 'base_skill_missing'
  | 'base_fingerprint_mismatch'
  | 'operation_not_supported'
  | 'overlay_conflict'
  | 'effective_skill_invalid';

export interface SkillOverlayValidationIssue {
  reason: SkillOverlayValidationReason;
  path: string;
  message: string;
  overlayId?: string;
  baseSkillId?: string;
}

export type EffectiveSkillCompositionResult =
  | {
      validationState: 'passed';
      skills: readonly SkillDefinition[];
      appliedOverlayIds: Readonly<Record<string, readonly string[]>>;
      compositionFingerprint: string;
    }
  | {
      validationState: 'failed';
      reason: SkillOverlayValidationReason;
      issues: readonly SkillOverlayValidationIssue[];
    };

export interface ComposeEffectiveSkillsInput {
  scope: RunManifestScope;
  baseSkills: readonly SkillDefinition[];
  fragments?: ReadonlyMap<string, string>;
  overlays: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(entry => typeof entry === 'string');
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Number.isFinite(Date.parse(value));
}

function validateScope(
  value: unknown,
  path: string,
  issues: SkillOverlayValidationIssue[],
): value is RunManifestScope {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['tenantId', 'workspaceId'])
    || !isNonEmptyString(value.tenantId)
    || !isNonEmptyString(value.workspaceId)
  ) {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'scope must contain only non-empty tenantId and workspaceId',
    });
    return false;
  }
  return true;
}

function validateDisplayOperation(
  value: Record<string, unknown>,
  path: string,
  issues: SkillOverlayValidationIssue[],
): boolean {
  if (
    !hasOnlyKeys(value, ['op', 'operationId', 'display'])
    || !isNonEmptyString(value.operationId)
    || !isRecord(value.display)
  ) {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'set_display requires operationId and an object display field',
    });
    return false;
  }
  const displayIssues = validateDisplayConfigRuntime(
    value.display,
    `${path}.display`,
  );
  if (displayIssues.length > 0) {
    issues.push(...displayIssues.map(issue => ({
      reason: 'invalid_overlay' as const,
      path: issue.path,
      message: `${issue.code}: ${issue.message}`,
    })));
    return false;
  }
  return true;
}

function validateAppendStepsOperation(
  value: Record<string, unknown>,
  path: string,
  issues: SkillOverlayValidationIssue[],
): boolean {
  if (
    !hasOnlyKeys(value, ['op', 'operationId', 'steps'])
    || !isNonEmptyString(value.operationId)
    || !Array.isArray(value.steps)
    || value.steps.length === 0
  ) {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'append_steps requires operationId and a non-empty steps array',
    });
    return false;
  }
  const stepIssues = validateSkillStepListRuntime(
    value.steps,
    `${path}.steps`,
  );
  if (stepIssues.length > 0) {
    issues.push(...stepIssues.map(issue => ({
      reason: 'invalid_overlay' as const,
      path: issue.path,
      message: `${issue.code}: ${issue.message}`,
    })));
    return false;
  }
  return true;
}

function validateOptionalStringArrayField(
  record: Record<string, unknown>,
  field: string,
  path: string,
  issues: SkillOverlayValidationIssue[],
): boolean {
  if (record[field] === undefined) return true;
  if (!isStringArray(record[field])) {
    issues.push({
      reason: 'invalid_overlay',
      path: `${path}.${field}`,
      message: `${field} must be a string array when present`,
    });
    return false;
  }
  return true;
}

function validateMetadataOperation(
  value: Record<string, unknown>,
  path: string,
  issues: SkillOverlayValidationIssue[],
): boolean {
  if (
    !hasOnlyKeys(value, ['op', 'operationId', 'meta', 'triggers'])
    || !isNonEmptyString(value.operationId)
  ) {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'set_metadata contains unsupported fields or a missing operationId',
    });
    return false;
  }

  let leafCount = 0;
  if (value.meta !== undefined) {
    if (!isRecord(value.meta) || !hasOnlyKeys(value.meta, ['description', 'tags'])) {
      issues.push({
        reason: 'invalid_overlay',
        path: `${path}.meta`,
        message: 'meta may contain only description and tags',
      });
      return false;
    }
    if (
      value.meta.description !== undefined
      && typeof value.meta.description !== 'string'
    ) {
      issues.push({
        reason: 'invalid_overlay',
        path: `${path}.meta.description`,
        message: 'description must be a string when present',
      });
      return false;
    }
    if (!validateOptionalStringArrayField(value.meta, 'tags', `${path}.meta`, issues)) {
      return false;
    }
    leafCount += Number(value.meta.description !== undefined);
    leafCount += Number(value.meta.tags !== undefined);
  }

  if (value.triggers !== undefined) {
    if (
      !isRecord(value.triggers)
      || !hasOnlyKeys(value.triggers, ['keywords', 'patterns'])
    ) {
      issues.push({
        reason: 'invalid_overlay',
        path: `${path}.triggers`,
        message: 'triggers may contain only keywords and patterns',
      });
      return false;
    }
    if (value.triggers.keywords !== undefined) {
      if (
        !isRecord(value.triggers.keywords)
        || !hasOnlyKeys(value.triggers.keywords, ['zh', 'en'])
        || !validateOptionalStringArrayField(
          value.triggers.keywords,
          'zh',
          `${path}.triggers.keywords`,
          issues,
        )
        || !validateOptionalStringArrayField(
          value.triggers.keywords,
          'en',
          `${path}.triggers.keywords`,
          issues,
        )
        || (
          value.triggers.keywords.zh === undefined
          && value.triggers.keywords.en === undefined
        )
      ) {
        issues.push({
          reason: 'invalid_overlay',
          path: `${path}.triggers.keywords`,
          message: 'keywords must contain at least one of zh or en string arrays',
        });
        return false;
      }
      leafCount++;
    }
    if (!validateOptionalStringArrayField(
      value.triggers,
      'patterns',
      `${path}.triggers`,
      issues,
    )) {
      return false;
    }
    leafCount += Number(value.triggers.patterns !== undefined);
  }

  if (leafCount === 0) {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'set_metadata must replace at least one allowlisted leaf field',
    });
    return false;
  }
  return true;
}

function validateOperation(
  value: unknown,
  path: string,
  issues: SkillOverlayValidationIssue[],
): value is SkillOverlayOperation {
  if (!isRecord(value) || typeof value.op !== 'string') {
    issues.push({
      reason: 'invalid_overlay',
      path,
      message: 'operation must be an object with a supported op discriminator',
    });
    return false;
  }
  switch (value.op) {
    case 'append_steps':
      return validateAppendStepsOperation(value, path, issues);
    case 'set_display':
      return validateDisplayOperation(value, path, issues);
    case 'set_metadata':
      return validateMetadataOperation(value, path, issues);
    default:
      issues.push({
        reason: 'invalid_overlay',
        path: `${path}.op`,
        message: `unsupported overlay operation: ${value.op}`,
      });
      return false;
  }
}

export function parseSkillOverlayDeltaV1(
  value: unknown,
): {ok: true; value: SkillOverlayDeltaV1} | {
  ok: false;
  issues: SkillOverlayValidationIssue[];
} {
  const issues: SkillOverlayValidationIssue[] = [];
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'schemaVersion',
      'overlayId',
      'baseSkillId',
      'baseFingerprint',
      'proposalId',
      'createdAt',
      'scope',
      'operations',
    ])
  ) {
    return {
      ok: false,
      issues: [{
        reason: 'invalid_overlay',
        path: '$',
        message: 'overlay must be an object containing only SkillOverlayDeltaV1 fields',
      }],
    };
  }
  if (value.schemaVersion !== 1) {
    issues.push({
      reason: 'invalid_overlay',
      path: '$.schemaVersion',
      message: 'schemaVersion must equal 1',
    });
  }
  if (
    !isNonEmptyString(value.overlayId)
    || !OVERLAY_ID_RE.test(value.overlayId)
  ) {
    issues.push({
      reason: 'invalid_overlay',
      path: '$.overlayId',
      message: 'overlayId must match ^[a-z0-9][a-z0-9_-]{2,63}$',
    });
  }
  for (const field of ['baseSkillId', 'baseFingerprint', 'proposalId'] as const) {
    if (!isNonEmptyString(value[field])) {
      issues.push({
        reason: 'invalid_overlay',
        path: `$.${field}`,
        message: `${field} must be a non-empty string`,
      });
    }
  }
  if (!validIsoDate(value.createdAt)) {
    issues.push({
      reason: 'invalid_overlay',
      path: '$.createdAt',
      message: 'createdAt must be a valid ISO8601 timestamp',
    });
  }
  validateScope(value.scope, '$.scope', issues);
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    issues.push({
      reason: 'invalid_overlay',
      path: '$.operations',
      message: 'operations must be a non-empty array',
    });
  } else {
    const operationIds = new Set<string>();
    value.operations.forEach((operation, index) => {
      if (!validateOperation(operation, `$.operations[${index}]`, issues)) return;
      if (operationIds.has(operation.operationId)) {
        issues.push({
          reason: 'invalid_overlay',
          path: `$.operations[${index}].operationId`,
          message: `duplicate operationId: ${operation.operationId}`,
        });
      }
      operationIds.add(operation.operationId);
    });
  }
  if (issues.length > 0) return {ok: false, issues};
  return {
    ok: true,
    value: immutableCanonicalSnapshot(value as unknown as SkillOverlayDeltaV1),
  };
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function operationLeafPaths(operation: SkillOverlayOperation): string[] {
  if (operation.op === 'append_steps') return [];
  if (operation.op === 'set_display') return ['output.display'];
  const paths: string[] = [];
  if (operation.meta?.description !== undefined) paths.push('meta.description');
  if (operation.meta?.tags !== undefined) paths.push('meta.tags');
  if (operation.triggers?.keywords !== undefined) paths.push('triggers.keywords');
  if (operation.triggers?.patterns !== undefined) paths.push('triggers.patterns');
  return paths;
}

function applyMetadata(
  skill: SkillDefinition,
  operation: SetMetadataOperation,
): void {
  if (operation.meta?.description !== undefined) {
    skill.meta.description = operation.meta.description;
  }
  if (operation.meta?.tags !== undefined) {
    skill.meta.tags = [...operation.meta.tags];
  }
  if (operation.triggers?.keywords !== undefined) {
    skill.triggers = {
      ...(skill.triggers ?? {}),
      keywords: {
        ...(operation.triggers.keywords.zh !== undefined
          ? {zh: [...operation.triggers.keywords.zh]}
          : {}),
        ...(operation.triggers.keywords.en !== undefined
          ? {en: [...operation.triggers.keywords.en]}
          : {}),
      },
    };
  }
  if (operation.triggers?.patterns !== undefined) {
    skill.triggers = {
      ...(skill.triggers ?? {}),
      patterns: [...operation.triggers.patterns],
    };
  }
}

function applyDisplay(skill: SkillDefinition, display: DisplayConfig): void {
  skill.output = {
    ...(skill.output ?? {}),
    display: immutableCanonicalSnapshot(display),
  };
}

function fail(
  reason: SkillOverlayValidationReason,
  issues: SkillOverlayValidationIssue[],
): EffectiveSkillCompositionResult {
  return {
    validationState: 'failed',
    reason,
    issues: immutableCanonicalSnapshot(issues),
  };
}

export function composeEffectiveSkills(
  input: ComposeEffectiveSkillsInput,
): EffectiveSkillCompositionResult {
  const parsedOverlays: SkillOverlayDeltaV1[] = [];
  const parseIssues: SkillOverlayValidationIssue[] = [];
  for (const rawOverlay of input.overlays) {
    const parsed = parseSkillOverlayDeltaV1(rawOverlay);
    if (parsed.ok) {
      parsedOverlays.push(parsed.value);
    } else {
      parseIssues.push(...parsed.issues);
    }
  }
  if (parseIssues.length > 0) return fail('invalid_overlay', parseIssues);

  const baseById = new Map(input.baseSkills.map(skill => [skill.name, skill]));
  const globalStepIds = new Set<string>();
  for (const skill of input.baseSkills) {
    for (const step of skill.steps ?? []) {
      globalStepIds.add(step.id);
    }
  }

  const overlaysByBase = new Map<string, SkillOverlayDeltaV1[]>();
  for (const overlay of parsedOverlays) {
    if (!sameScope(overlay.scope, input.scope)) {
      return fail('scope_mismatch', [{
        reason: 'scope_mismatch',
        path: `${overlay.overlayId}.scope`,
        message: 'overlay scope does not match the requested registry scope',
        overlayId: overlay.overlayId,
        baseSkillId: overlay.baseSkillId,
      }]);
    }
    const baseSkill = baseById.get(overlay.baseSkillId);
    if (!baseSkill) {
      return fail('base_skill_missing', [{
        reason: 'base_skill_missing',
        path: `${overlay.overlayId}.baseSkillId`,
        message: `base skill not found: ${overlay.baseSkillId}`,
        overlayId: overlay.overlayId,
        baseSkillId: overlay.baseSkillId,
      }]);
    }
    const actualBaseFingerprint = fingerprintSkillDefinition(
      baseSkill,
      input.fragments,
    );
    if (overlay.baseFingerprint !== actualBaseFingerprint) {
      return fail('base_fingerprint_mismatch', [{
        reason: 'base_fingerprint_mismatch',
        path: `${overlay.overlayId}.baseFingerprint`,
        message: `overlay base fingerprint does not match ${overlay.baseSkillId}`,
        overlayId: overlay.overlayId,
        baseSkillId: overlay.baseSkillId,
      }]);
    }
    const group = overlaysByBase.get(overlay.baseSkillId) ?? [];
    group.push(overlay);
    overlaysByBase.set(overlay.baseSkillId, group);
  }

  const effectiveById = new Map<string, SkillDefinition>(
    input.baseSkills.map(skill => [
      skill.name,
      immutableCanonicalSnapshot(skill),
    ]),
  );
  const appliedOverlayIds: Record<string, readonly string[]> = {};

  for (const [baseSkillId, group] of overlaysByBase) {
    const baseSkill = baseById.get(baseSkillId)!;
    const effectiveSkill = JSON.parse(JSON.stringify(baseSkill)) as SkillDefinition;
    const sortedGroup = [...group].sort((left, right) => {
      const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return byTime !== 0
        ? byTime
        : left.overlayId.localeCompare(right.overlayId);
    });
    const assignedLeafPaths = new Map<string, string>();

    for (const overlay of sortedGroup) {
      const stepIdPattern = new RegExp(
        `^ovl_${escapeRegExp(overlay.overlayId)}_[a-z0-9_]+$`,
      );
      for (const operation of overlay.operations) {
        for (const leafPath of operationLeafPaths(operation)) {
          const owner = assignedLeafPaths.get(leafPath);
          if (owner) {
            return fail('overlay_conflict', [{
              reason: 'overlay_conflict',
              path: `${baseSkillId}.${leafPath}`,
              message: `allowlisted field is set by both ${owner} and ${overlay.overlayId}`,
              overlayId: overlay.overlayId,
              baseSkillId,
            }]);
          }
          assignedLeafPaths.set(leafPath, overlay.overlayId);
        }

        if (operation.op === 'append_steps') {
          if (
            (baseSkill.type !== 'composite' && baseSkill.type !== 'pipeline')
            || !Array.isArray(baseSkill.steps)
          ) {
            return fail('operation_not_supported', [{
              reason: 'operation_not_supported',
              path: `${overlay.overlayId}.${operation.operationId}`,
              message: 'append_steps is limited to composite or pipeline skills with steps',
              overlayId: overlay.overlayId,
              baseSkillId,
            }]);
          }
          for (const step of operation.steps) {
            if (!stepIdPattern.test(step.id)) {
              return fail('invalid_overlay', [{
                reason: 'invalid_overlay',
                path: `${overlay.overlayId}.${operation.operationId}.${step.id}`,
                message: `step id must match ^ovl_${overlay.overlayId}_[a-z0-9_]+$`,
                overlayId: overlay.overlayId,
                baseSkillId,
              }]);
            }
            if (globalStepIds.has(step.id)) {
              return fail('overlay_conflict', [{
                reason: 'overlay_conflict',
                path: `${overlay.overlayId}.${operation.operationId}.${step.id}`,
                message: `global step id collision: ${step.id}`,
                overlayId: overlay.overlayId,
                baseSkillId,
              }]);
            }
            globalStepIds.add(step.id);
          }
          effectiveSkill.steps = [
            ...(effectiveSkill.steps ?? []),
            ...operation.steps.map(step =>
              immutableCanonicalSnapshot(step) as SkillStep),
          ];
        } else if (operation.op === 'set_display') {
          applyDisplay(effectiveSkill, operation.display);
        } else {
          applyMetadata(effectiveSkill, operation);
        }
      }
    }

    const displayIssues = validateSkillDisplayContract(effectiveSkill);
    if (displayIssues.length > 0) {
      return fail('effective_skill_invalid', displayIssues.map(issue => ({
        reason: 'effective_skill_invalid',
        path: issue.path,
        message: formatDisplayContractIssue(issue),
        baseSkillId,
      })));
    }
    effectiveById.set(
      baseSkillId,
      immutableCanonicalSnapshot(effectiveSkill),
    );
    appliedOverlayIds[baseSkillId] = immutableCanonicalSnapshot(
      sortedGroup.map(overlay => overlay.overlayId),
    );
  }

  const skills = immutableCanonicalSnapshot(
    input.baseSkills.map(skill => effectiveById.get(skill.name)!),
  );
  const frozenOverlayIds = immutableCanonicalSnapshot(appliedOverlayIds);
  const sortedOverlays = [...parsedOverlays].sort((left, right) => {
    const bySkill = left.baseSkillId.localeCompare(right.baseSkillId);
    if (bySkill !== 0) return bySkill;
    const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byTime !== 0
      ? byTime
      : left.overlayId.localeCompare(right.overlayId);
  });
  return {
    validationState: 'passed',
    skills,
    appliedOverlayIds: frozenOverlayIds,
    compositionFingerprint: canonicalContentHash({
      scope: input.scope,
      baseSkills: input.baseSkills.map(skill => ({
        skillId: skill.name,
        fingerprint: fingerprintSkillDefinition(skill, input.fragments),
      })),
      overlays: sortedOverlays,
    }),
  };
}
