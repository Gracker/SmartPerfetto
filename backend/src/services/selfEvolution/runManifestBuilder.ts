// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'crypto';

import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import type {
  RunInjectionAttribution,
  RunInjectionCategory,
  RunManifestAttributionSink,
  RunManifestIdentity,
  RunManifestRuntimeAttribution,
  RunManifestSceneAttribution,
  RunManifestScope,
  RunManifestV1,
  RunSkillAttribution,
  RunSkillDefinitionAttribution,
  RunSkillInvocationOutcome,
  RunSkillInvocationStart,
  RunSkillRegistryAttribution,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';

export interface CreateRunManifestBuilderInput {
  runManifestId?: string;
  runId: string;
  sessionId: string;
  scope: RunManifestScope;
  userId?: string;
  startedAt?: number;
  runtime: AgentRuntimeKind;
  providerId?: string | null;
  model?: string;
  outputLanguage: string;
  analysisMode: RunManifestV1['analysisMode'];
  resolvedMode?: RunManifestV1['resolvedMode'];
  referenceTraceId?: string;
  comparisonIdentity?: string;
  resumeAncestry?: RunManifestV1['resumeAncestry'];
  featureFlagSnapshot?: Record<string, string | number | boolean>;
  now?: () => number;
  onDiagnostic?: (code: string, details?: Record<string, unknown>) => void;
}

interface SkillInvocationState {
  skillId: string;
}

function emptyInjections(): RunInjectionAttribution {
  return {
    patterns: [],
    skillNotes: [],
    cases: [],
    phaseHints: [],
    knowledgeDocs: [],
  };
}

function copySkillDefinition(
  input: RunSkillDefinitionAttribution,
): RunSkillDefinitionAttribution {
  return {
    ...input,
    appliedOverlayIds: [...(input.appliedOverlayIds ?? [])],
  };
}

export class RunManifestBuilder implements RunManifestAttributionSink {
  readonly identity: RunManifestIdentity;

  private readonly runManifestId: string;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly onDiagnostic?: CreateRunManifestBuilderInput['onDiagnostic'];
  private readonly actor?: {userId?: string};
  private readonly featureFlagSnapshot: Record<string, string | number | boolean>;
  private readonly referenceTraceId?: string;
  private readonly comparisonIdentity?: string;
  private readonly resumeAncestry?: RunManifestV1['resumeAncestry'];

  private scene: RunManifestSceneAttribution = {sceneType: 'general'};
  private runtime: RunManifestRuntimeAttribution;
  private analysisMode: RunManifestV1['analysisMode'];
  private resolvedMode: RunManifestV1['resolvedMode'];
  private capabilityFlags = new Set<string>();
  private toolAllowlistHash = canonicalContentHash([]);
  private registryFingerprint: string | undefined;
  private skillDefinitions = new Map<string, RunSkillDefinitionAttribution>();
  private skillAggregates = new Map<string, RunSkillAttribution>();
  private promptTemplates = new Map<string, string>();
  private injections = new Map<RunInjectionCategory, Map<string, string>>();
  private pendingInvocations = new Map<string, SkillInvocationState>();
  private invocationSequence = 0;
  private sqlStatementCount = 0;
  private sqlErrorCount = 0;
  private turns = 0;
  private sealedManifest: RunManifestV1 | undefined;

  constructor(input: CreateRunManifestBuilderInput) {
    this.identity = immutableCanonicalSnapshot({
      runId: input.runId,
      sessionId: input.sessionId,
      scope: input.scope,
    });
    this.runManifestId = input.runManifestId ?? randomUUID();
    this.startedAt = input.startedAt ?? Date.now();
    this.now = input.now ?? Date.now;
    this.onDiagnostic = input.onDiagnostic;
    this.actor = input.userId ? {userId: input.userId} : undefined;
    this.runtime = {
      runtime: input.runtime,
      providerId: input.providerId ?? null,
      ...(input.model ? {model: input.model} : {}),
      outputLanguage: input.outputLanguage,
    };
    this.analysisMode = input.analysisMode;
    this.resolvedMode = input.resolvedMode ?? 'full';
    this.featureFlagSnapshot = {...(input.featureFlagSnapshot ?? {})};
    this.referenceTraceId = input.referenceTraceId;
    this.comparisonIdentity = input.comparisonIdentity;
    this.resumeAncestry = input.resumeAncestry
      ? {...input.resumeAncestry}
      : undefined;
    for (const category of Object.keys(emptyInjections()) as RunInjectionCategory[]) {
      this.injections.set(category, new Map());
    }
  }

  get isSealed(): boolean {
    return this.sealedManifest !== undefined;
  }

  get pendingAttributionCount(): number {
    return this.pendingInvocations.size;
  }

  recordScene(input: RunManifestSceneAttribution): void {
    this.assertCollecting('record_scene');
    this.scene = {
      ...this.scene,
      ...input,
    };
  }

  recordRuntime(input: RunManifestRuntimeAttribution): void {
    this.assertCollecting('record_runtime');
    if (input.runtime !== this.runtime.runtime) {
      throw new Error(
        `run_manifest_runtime_mismatch:${this.runtime.runtime}:${input.runtime}`,
      );
    }
    this.runtime = {
      ...this.runtime,
      ...input,
      providerId: input.providerId,
    };
  }

  recordMode(input: {
    requested: RunManifestV1['analysisMode'];
    resolved?: RunManifestV1['resolvedMode'];
    capabilityFlags?: readonly string[];
  }): void {
    this.assertCollecting('record_mode');
    this.analysisMode = input.requested;
    if (input.resolved) this.resolvedMode = input.resolved;
    for (const flag of input.capabilityFlags ?? []) {
      if (flag) this.capabilityFlags.add(flag);
    }
  }

  recordSkillRegistry(input: RunSkillRegistryAttribution): void {
    this.assertCollecting('record_skill_registry');
    if (
      this.registryFingerprint &&
      this.registryFingerprint !== input.registryFingerprint
    ) {
      throw new Error(
        `run_manifest_registry_mismatch:${this.registryFingerprint}:${input.registryFingerprint}`,
      );
    }
    this.registryFingerprint = input.registryFingerprint;
    for (const skill of input.skills) {
      const existing = this.skillDefinitions.get(skill.skillId);
      if (
        existing &&
        canonicalContentHash(existing) !== canonicalContentHash(skill)
      ) {
        throw new Error(`run_manifest_skill_definition_mismatch:${skill.skillId}`);
      }
      this.skillDefinitions.set(skill.skillId, copySkillDefinition(skill));
    }
  }

  startSkillInvocation(input: RunSkillInvocationStart): string {
    this.assertCollecting('start_skill_invocation');
    const registered = this.skillDefinitions.get(input.skillId);
    if (
      registered &&
      (
        registered.version !== input.version ||
        registered.contentFingerprint !== input.contentFingerprint
      )
    ) {
      throw new Error(`run_manifest_invoked_skill_mismatch:${input.skillId}`);
    }
    if (!registered) {
      this.skillDefinitions.set(input.skillId, {
        skillId: input.skillId,
        version: input.version,
        contentFingerprint: input.contentFingerprint,
        origin: 'built_in',
        appliedOverlayIds: [],
      });
      this.onDiagnostic?.('skill_origin_defaulted_to_builtin', {
        skillId: input.skillId,
      });
    }
    const definition = this.skillDefinitions.get(input.skillId)!;
    if (!this.skillAggregates.has(input.skillId)) {
      this.skillAggregates.set(input.skillId, {
        ...definition,
        appliedOverlayIds: [...(definition.appliedOverlayIds ?? [])],
        invocations: 0,
        okCount: 0,
        emptyResultCount: 0,
        errorCount: 0,
      });
    }
    const invocationId = `${this.runManifestId}:${++this.invocationSequence}`;
    this.pendingInvocations.set(invocationId, {skillId: input.skillId});
    return invocationId;
  }

  finishSkillInvocation(
    invocationId: string,
    outcome: RunSkillInvocationOutcome,
  ): void {
    this.assertCollecting('finish_skill_invocation');
    const pending = this.pendingInvocations.get(invocationId);
    if (!pending) {
      throw new Error(`run_manifest_unknown_invocation:${invocationId}`);
    }
    const aggregate = this.skillAggregates.get(pending.skillId);
    if (!aggregate) {
      throw new Error(`run_manifest_missing_skill_aggregate:${pending.skillId}`);
    }
    aggregate.invocations++;
    if (!outcome.success) {
      aggregate.errorCount++;
    } else if (outcome.empty) {
      aggregate.emptyResultCount++;
    } else {
      aggregate.okCount++;
    }
    this.pendingInvocations.delete(invocationId);
  }

  recordUnknownSkillInvocation(skillId: string): void {
    this.assertCollecting('record_unknown_skill_invocation');
    this.onDiagnostic?.('unknown_skill_invocation', {skillId});
  }

  recordSqlStatement(success: boolean): void {
    this.assertCollecting('record_sql_statement');
    this.sqlStatementCount++;
    if (!success) this.sqlErrorCount++;
  }

  recordPromptTemplate(id: string, contentHash: string): void {
    this.assertCollecting('record_prompt_template');
    this.recordHash(this.promptTemplates, id, contentHash, 'prompt_template');
  }

  recordInjection(
    category: RunInjectionCategory,
    id: string,
    contentHash: string,
  ): void {
    this.assertCollecting('record_injection');
    const collection = this.injections.get(category);
    if (!collection) {
      throw new Error(`run_manifest_unknown_injection_category:${category}`);
    }
    this.recordHash(collection, id, contentHash, `injection_${category}`);
  }

  recordToolAllowlist(toolNames: readonly string[]): void {
    this.assertCollecting('record_tool_allowlist');
    const sorted = [...new Set(toolNames.filter(Boolean))].sort();
    this.toolAllowlistHash = canonicalContentHash(sorted);
  }

  recordTurn(): void {
    this.assertCollecting('record_turn');
    this.turns++;
  }

  recordTurnCount(turns: number): void {
    this.assertCollecting('record_turn_count');
    if (!Number.isSafeInteger(turns) || turns < 0) {
      throw new Error(`run_manifest_invalid_turn_count:${turns}`);
    }
    this.turns = turns;
  }

  closePendingSkillInvocationsAsErrors(): void {
    this.assertCollecting('close_pending_skill_invocations');
    const pendingInvocationIds = [...this.pendingInvocations.keys()];
    for (const invocationId of pendingInvocationIds) {
      this.finishSkillInvocation(invocationId, {
        success: false,
        empty: false,
      });
    }
    if (pendingInvocationIds.length > 0) {
      this.onDiagnostic?.('pending_skill_invocations_closed_as_errors', {
        count: pendingInvocationIds.length,
      });
    }
  }

  seal(): RunManifestV1 {
    if (this.sealedManifest) return this.sealedManifest;
    if (this.pendingInvocations.size > 0) {
      throw new Error(
        `run_manifest_pending_attributions:${this.pendingInvocations.size}`,
      );
    }
    if (!this.registryFingerprint) {
      throw new Error('run_manifest_registry_not_recorded');
    }
    const sealedAt = this.now();
    const manifest: RunManifestV1 = {
      schemaVersion: 1,
      runManifestId: this.runManifestId,
      runId: this.identity.runId,
      sessionId: this.identity.sessionId,
      sealedAt,
      scope: this.identity.scope,
      ...(this.actor ? {actor: this.actor} : {}),
      sceneType: this.scene.sceneType,
      ...(this.scene.sceneConfidence !== undefined
        ? {sceneConfidence: this.scene.sceneConfidence}
        : {}),
      ...(this.scene.architecture ? {architecture: this.scene.architecture} : {}),
      ...(this.scene.strategyId ? {strategyId: this.scene.strategyId} : {}),
      ...(this.scene.strategyContentHash
        ? {strategyContentHash: this.scene.strategyContentHash}
        : {}),
      promptTemplateHashes: this.sortedReferences(this.promptTemplates),
      skills: [...this.skillAggregates.values()]
        .map(skill => ({...skill, appliedOverlayIds: [...skill.appliedOverlayIds]}))
        .sort((a, b) => a.skillId.localeCompare(b.skillId)),
      skillRegistryFingerprint: this.registryFingerprint,
      evolutionOverlayGeneration: `builtin:${this.registryFingerprint}`,
      sqlStatementCount: this.sqlStatementCount,
      sqlErrorCount: this.sqlErrorCount,
      runtime: this.runtime.runtime,
      providerId: this.runtime.providerId,
      ...(this.runtime.model ? {model: this.runtime.model} : {}),
      outputLanguage: this.runtime.outputLanguage ?? 'zh-CN',
      toolAllowlistHash: this.toolAllowlistHash,
      featureFlagSnapshot: this.featureFlagSnapshot,
      analysisMode: this.analysisMode,
      resolvedMode: this.resolvedMode,
      capabilityFlags: [...this.capabilityFlags].sort(),
      ...(this.referenceTraceId ? {referenceTraceId: this.referenceTraceId} : {}),
      ...(this.comparisonIdentity
        ? {comparisonIdentity: this.comparisonIdentity}
        : {}),
      ...(this.resumeAncestry ? {resumeAncestry: this.resumeAncestry} : {}),
      injections: {
        patterns: this.sortedInjection('patterns'),
        skillNotes: this.sortedInjection('skillNotes'),
        cases: this.sortedInjection('cases'),
        phaseHints: this.sortedInjection('phaseHints'),
        knowledgeDocs: this.sortedInjection('knowledgeDocs'),
      },
      turns: this.turns,
      wallclockMs: Math.max(0, sealedAt - this.startedAt),
    };
    this.sealedManifest = immutableCanonicalSnapshot(manifest);
    return this.sealedManifest;
  }

  private assertCollecting(operation: string): void {
    if (!this.sealedManifest) return;
    this.onDiagnostic?.('late_attribution_rejected', {operation});
    throw new Error(`run_manifest_already_sealed:${operation}`);
  }

  private recordHash(
    target: Map<string, string>,
    id: string,
    contentHash: string,
    label: string,
  ): void {
    const normalizedId = id.trim();
    const normalizedHash = contentHash.trim();
    if (!normalizedId || !normalizedHash) {
      throw new Error(`run_manifest_invalid_${label}`);
    }
    const existing = target.get(normalizedId);
    if (existing && existing !== normalizedHash) {
      throw new Error(`run_manifest_${label}_hash_mismatch:${normalizedId}`);
    }
    target.set(normalizedId, normalizedHash);
  }

  private sortedReferences(source: Map<string, string>) {
    return [...source.entries()]
      .map(([id, contentHash]) => ({id, contentHash}))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private sortedInjection(category: RunInjectionCategory) {
    return this.sortedReferences(this.injections.get(category)!);
  }
}
