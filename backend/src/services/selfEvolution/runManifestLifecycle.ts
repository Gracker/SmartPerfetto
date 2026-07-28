// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';

import type {AgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import type {
  RunManifestAttributionSink,
  RunManifestIdentity,
  RunManifestSceneAttribution,
  RunManifestScope,
  RunManifestV1,
  RunSkillRegistryAttribution,
} from '../../types/selfEvolution';
import {
  RunManifestBuilder,
  type CreateRunManifestBuilderInput,
} from './runManifestBuilder';
import {
  getRunManifestStore,
  type RunManifestStore,
} from './runManifestStore';
import {
  withEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
} from './effectiveRuntimeRegistryContext';

export type RunManifestLifecycleState =
  | 'collecting'
  | 'sealed_not_persisted'
  | 'persisted'
  | 'disposed';

export interface RunManifestLifecycleDiagnostic {
  code: string;
  recordedAt: number;
  details?: Record<string, unknown>;
}

export interface SealRunManifestOptions {
  scene?: RunManifestSceneAttribution;
  turnCount?: number;
  closePendingSkillInvocationsAsErrors?: boolean;
}

export interface CreateRunManifestLifecycleInput {
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
  skillRegistry: RunSkillRegistryAttribution;
  runtimeRegistrySnapshot?: EffectiveRuntimeRegistrySnapshot;
  store?: RunManifestStore;
  now?: () => number;
}

const context = new AsyncLocalStorage<RunManifestAttributionSink>();
const active = new Map<string, RunManifestLifecycle>();

function identityKey(identity: RunManifestIdentity): string {
  return [
    identity.scope.tenantId,
    identity.scope.workspaceId,
    identity.sessionId,
    identity.runId,
  ].join('\0');
}

function sameIdentity(
  left: RunManifestIdentity,
  right: RunManifestIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function booleanFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(value?.trim() ?? '');
}

export function buildRunManifestFeatureFlagSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | number | boolean> {
  return {
    selfEvolutionEnabled: booleanFlag(env.SELF_EVOLUTION_ENABLED),
    selfEvolutionApplyEnabled: booleanFlag(env.SELF_EVOLUTION_APPLY),
    caseEvolutionEnabled: booleanFlag(env.CASE_EVOLUTION_ENABLED),
    caseEvolutionPromptInjectEnabled: booleanFlag(
      env.CASE_EVOLUTION_PROMPT_INJECT_ENABLED,
    ),
  };
}

export class RunManifestLifecycle {
  readonly builder: RunManifestBuilder;
  readonly diagnostics: RunManifestLifecycleDiagnostic[] = [];
  readonly runtimeRegistrySnapshot?: EffectiveRuntimeRegistrySnapshot;

  private lifecycleState: RunManifestLifecycleState = 'collecting';
  private sealedManifest: RunManifestV1 | undefined;
  private readonly store: RunManifestStore;
  private readonly now: () => number;

  constructor(input: CreateRunManifestLifecycleInput) {
    this.store = input.store ?? getRunManifestStore();
    this.now = input.now ?? Date.now;
    this.runtimeRegistrySnapshot = input.runtimeRegistrySnapshot;
    if (this.runtimeRegistrySnapshot) {
      const snapshot = this.runtimeRegistrySnapshot;
      if (
        snapshot.scope.tenantId !== input.scope.tenantId
        || snapshot.scope.workspaceId !== input.scope.workspaceId
        || snapshot.overlayGeneration
          !== input.skillRegistry.evolutionOverlayGeneration
        || snapshot.skillRegistry.registryFingerprint
          !== input.skillRegistry.registryFingerprint
      ) {
        throw new Error('run_manifest_runtime_registry_snapshot_mismatch');
      }
    }
    const builderInput: CreateRunManifestBuilderInput = {
      ...input,
      featureFlagSnapshot: input.featureFlagSnapshot
        ?? buildRunManifestFeatureFlagSnapshot(),
      onDiagnostic: (code, details) => {
        this.diagnostics.push({
          code,
          recordedAt: this.now(),
          ...(details ? {details} : {}),
        });
      },
    };
    this.builder = new RunManifestBuilder(builderInput);
    this.builder.recordSkillRegistry(input.skillRegistry);
  }

  get identity(): RunManifestIdentity {
    return this.builder.identity;
  }

  get state(): RunManifestLifecycleState {
    return this.lifecycleState;
  }

  sealOnceAndPersist(options: SealRunManifestOptions = {}): RunManifestV1 {
    if (this.lifecycleState === 'disposed') {
      throw new Error('run_manifest_lifecycle_disposed');
    }
    if (this.lifecycleState === 'collecting') {
      if (options.scene) {
        this.builder.recordScene(options.scene);
      }
      if (options.turnCount !== undefined) {
        this.builder.recordTurnCount(options.turnCount);
      }
      if (options.closePendingSkillInvocationsAsErrors) {
        this.builder.closePendingSkillInvocationsAsErrors();
      }
      this.sealedManifest = this.builder.seal();
      this.lifecycleState = 'sealed_not_persisted';
    }
    if (!this.sealedManifest) {
      throw new Error('run_manifest_sealed_payload_missing');
    }
    if (this.lifecycleState === 'sealed_not_persisted') {
      this.store.pin(
        this.identity.scope,
        this.sealedManifest.runManifestId,
      );
      try {
        this.store.append(this.identity.scope, this.sealedManifest);
        this.lifecycleState = 'persisted';
      } catch (error) {
        this.store.unpin(
          this.identity.scope,
          this.sealedManifest.runManifestId,
        );
        throw error;
      }
    }
    return this.sealedManifest;
  }

  dispose(): void {
    if (this.lifecycleState === 'disposed') return;
    if (this.sealedManifest) {
      this.store.unpin(
        this.identity.scope,
        this.sealedManifest.runManifestId,
      );
    }
    active.delete(identityKey(this.identity));
    this.lifecycleState = 'disposed';
  }
}

export function createRunManifestLifecycle(
  input: CreateRunManifestLifecycleInput,
): RunManifestLifecycle {
  const lifecycle = new RunManifestLifecycle(input);
  const key = identityKey(lifecycle.identity);
  if (active.has(key)) {
    throw new Error(`run_manifest_lifecycle_already_active:${input.runId}`);
  }
  active.set(key, lifecycle);
  return lifecycle;
}

export function getActiveRunManifestLifecycle(
  scope: RunManifestScope,
  sessionId: string,
  runId: string,
): RunManifestLifecycle | undefined {
  return active.get(identityKey({scope, sessionId, runId}));
}

export function disposeRunManifestLifecyclesForSession(
  scope: RunManifestScope,
  sessionId: string,
): number {
  const lifecycles = [...active.values()].filter(lifecycle =>
    lifecycle.identity.sessionId === sessionId &&
    lifecycle.identity.scope.tenantId === scope.tenantId &&
    lifecycle.identity.scope.workspaceId === scope.workspaceId,
  );
  for (const lifecycle of lifecycles) {
    lifecycle.dispose();
  }
  return lifecycles.length;
}

export function currentRunManifestAttributionSink():
  | RunManifestAttributionSink
  | undefined {
  return context.getStore();
}

export function resolveRunManifestAttributionSink(
  ...candidates: Array<RunManifestAttributionSink | null | undefined>
): RunManifestAttributionSink | undefined {
  const sinks = candidates.filter(
    (candidate): candidate is RunManifestAttributionSink => Boolean(candidate),
  );
  const selected = sinks[0];
  if (!selected) return undefined;
  for (const sink of sinks.slice(1)) {
    if (!sameIdentity(selected.identity, sink.identity)) {
      throw new Error(
        `run_manifest_sink_identity_conflict:${identityKey(selected.identity)}:${identityKey(sink.identity)}`,
      );
    }
  }
  return selected;
}

export function withRunManifestLifecycle<T>(
  lifecycle: RunManifestLifecycle,
  callback: () => T,
): T {
  const inherited = currentRunManifestAttributionSink();
  resolveRunManifestAttributionSink(lifecycle.builder, inherited);
  const runWithManifest = () => context.run(lifecycle.builder, callback);
  return lifecycle.runtimeRegistrySnapshot
    ? withEffectiveRuntimeRegistrySnapshot(
        lifecycle.runtimeRegistrySnapshot,
        runWithManifest,
      )
    : runWithManifest();
}

export function clearRunManifestLifecyclesForTests(): void {
  for (const lifecycle of active.values()) {
    lifecycle.dispose();
  }
  active.clear();
}

export const __testing = {
  active,
  identityKey,
  sameIdentity,
};
