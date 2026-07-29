// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildStrategyRegistrySnapshot,
  buildStrategyRegistrySnapshotFromDefinitions,
  fingerprintStrategyDefinition,
  type StrategyRegistryContribution,
} from '../../agentv3/strategyLoader';
import {
  loadSkillNotesFromSources,
  skillNoteContentHash,
  type NoteSourceOptions,
} from '../../agentv3/selfImprove/skillNotesInjector';
import type {PersistedSkillNote} from '../../agentv3/selfImprove/skillNotesWriter';
import type {
  EvolutionSkillNoteDeltaV1,
  EvolutionStrategyDeltaV1,
  RunManifestScope,
  SkillOverlayDeltaV1,
} from '../../types/selfEvolution';
import type {EnterpriseRepositoryScope} from '../enterpriseRepository';
import type {SkillOriginMetadata} from '../skillPacks/skillPackTypes';
import {
  getWorkspaceSkillRegistry,
  type WorkspaceSkillRegistryProviderOptions,
} from '../skillPacks/workspaceSkillRegistryProvider';
import type {VendorOverride} from '../skillEngine/skillLoader';
import type {SkillRegistryView} from '../skillEngine/skillAnalysisAdapter';
import type {SkillDefinition} from '../skillEngine/types';
import {canonicalContentHash} from './canonicalJson';
import {
  composeEffectiveSkills,
  type EffectiveSkillCompositionResult,
} from './effectiveSkillComposer';
import {
  currentEffectiveRuntimeRegistrySnapshot,
  type EffectiveRuntimeRegistrySnapshot,
  type ReadonlySkillNoteRegistrySnapshot,
  type ReadonlySkillRegistrySnapshot,
} from './effectiveRuntimeRegistryContext';
import {buildSkillRegistryAttribution} from './skillFingerprint';
import {currentRunManifestAttributionSink} from './runManifestLifecycle';
import {
  validateSkillDefinitionsInProcess,
  validateStrategyDefinitionsInProcess,
} from './inProcessValidator';
import type {EvaluationRoleVariantV1} from './evaluationTreatment';

export interface BuildEffectiveRuntimeRegistrySnapshotInput {
  scope: EnterpriseRepositoryScope;
  skillOverlays?: readonly SkillOverlayDeltaV1[];
  strategyContributions?: readonly StrategyRegistryContribution[];
  strategyDeltas?: readonly Exclude<
    EvolutionStrategyDeltaV1,
    {kind: 'strategy_contribution'}
  >[];
  skillNoteDeltas?: readonly EvolutionSkillNoteDeltaV1[];
  publishedGeneration?: string;
  skillNoteSourceOptions?: NoteSourceOptions;
  evaluationRoleVariant?: EvaluationRoleVariantV1;
  workspaceOptions?: WorkspaceSkillRegistryProviderOptions;
}

function scopeKey(scope: RunManifestScope): string {
  return `${scope.tenantId}\0${scope.workspaceId}`;
}

export class EffectiveRuntimeRegistryManager {
  private readonly publishedByScope =
    new Map<string, EffectiveRuntimeRegistrySnapshot>();
  private readonly initializingByScope =
    new Map<string, Promise<EffectiveRuntimeRegistrySnapshot>>();

  publish(
    snapshot: EffectiveRuntimeRegistrySnapshot,
    expectedPublishedGeneration?: string | null,
  ): EffectiveRuntimeRegistrySnapshot {
    const key = scopeKey(snapshot.scope);
    const current = this.publishedByScope.get(key);
    if (
      expectedPublishedGeneration !== undefined
      && (current?.overlayGeneration ?? null) !== expectedPublishedGeneration
    ) {
      throw new Error('effective_runtime_registry_publish_fence_lost');
    }
    if (
      current
      && current.overlayGeneration === snapshot.overlayGeneration
      && current.skillRegistry.registryFingerprint
        === snapshot.skillRegistry.registryFingerprint
      && current.strategyRegistry.registryFingerprint
        === snapshot.strategyRegistry.registryFingerprint
      && current.skillNotes.registryFingerprint
        === snapshot.skillNotes.registryFingerprint
    ) {
      return current;
    }
    this.publishedByScope.set(key, snapshot);
    return snapshot;
  }

  getPublished(
    scope: RunManifestScope,
  ): EffectiveRuntimeRegistrySnapshot | undefined {
    return this.publishedByScope.get(scopeKey(scope));
  }

  async getPublishedOrInitialize(
    input: BuildEffectiveRuntimeRegistrySnapshotInput,
  ): Promise<EffectiveRuntimeRegistrySnapshot> {
    const published = this.getPublished(input.scope);
    if (published) return published;
    const key = scopeKey(input.scope);
    const inFlight = this.initializingByScope.get(key);
    if (inFlight) return inFlight;
    const initializing = buildEffectiveRuntimeRegistrySnapshot(input)
      .then(snapshot => {
        const concurrentlyPublished = this.getPublished(input.scope);
        if (concurrentlyPublished) return concurrentlyPublished;
        return this.publish(snapshot, null);
      })
      .finally(() => {
        this.initializingByScope.delete(key);
      });
    this.initializingByScope.set(key, initializing);
    return initializing;
  }

  clearForTests(): void {
    this.publishedByScope.clear();
    this.initializingByScope.clear();
  }
}

export const effectiveRuntimeRegistryManager =
  new EffectiveRuntimeRegistryManager();

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function frozenJsonClone<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function materializeEvolutionSkillNote(input: {
  note: {noteId: string; content: string; keywords: string[]};
  existing?: PersistedSkillNote;
}): PersistedSkillNote {
  return {
    id: input.note.noteId,
    failureCategory: 'unknown',
    evidenceSummary: input.note.content,
    candidateKeywords: [...input.note.keywords],
    candidateConstraints: '',
    candidateCriticalTools: [],
    createdAt: input.existing?.createdAt ?? 0,
    cooldownUntil: input.existing?.cooldownUntil ?? 0,
    byteSize: Buffer.byteLength(input.note.content, 'utf8'),
    ...(input.existing?.sourceSessionId === undefined
      ? {}
      : {sourceSessionId: input.existing.sourceSessionId}),
    ...(input.existing?.sourceTurnIndex === undefined
      ? {}
      : {sourceTurnIndex: input.existing.sourceTurnIndex}),
  };
}

function buildSkillNoteRegistrySnapshot(input: {
  skillIds: readonly string[];
  deltas: readonly EvolutionSkillNoteDeltaV1[];
  sourceOptions?: NoteSourceOptions;
  baseSnapshot?: ReadonlySkillNoteRegistrySnapshot;
}): ReadonlySkillNoteRegistrySnapshot {
  const bySkill = new Map<string, Map<string, PersistedSkillNote>>();
  for (const skillId of [...new Set(input.skillIds)].sort()) {
    bySkill.set(skillId, new Map(
      (
        input.baseSnapshot?.getSkillNotes(skillId)
        ?? loadSkillNotesFromSources(skillId, input.sourceOptions)
      )
        .map(note => [note.id, frozenJsonClone(note)]),
    ));
  }
  const targets = new Set<string>();
  for (const delta of [...input.deltas].sort((left, right) =>
    (left.skillId ?? '').localeCompare(right.skillId ?? '')
    || left.noteId.localeCompare(right.noteId))) {
    if (delta.kind === 'retire_skill_note') {
      const matchingSkillIds = delta.skillId
        ? [delta.skillId]
        : [...bySkill.keys()].filter(skillId =>
            bySkill.get(skillId)?.has(delta.noteId));
      if (matchingSkillIds.length !== 1) {
        throw new Error('effective_skill_note_retire_target_ambiguous');
      }
      const notes = bySkill.get(matchingSkillIds[0]);
      const existing = notes?.get(delta.noteId);
      if (!existing || skillNoteContentHash(existing) !== delta.contentHash) {
        throw new Error('effective_skill_note_retire_hash_mismatch');
      }
      notes!.delete(delta.noteId);
      continue;
    }
    const targetKey = `${delta.skillId}\0${delta.noteId}`;
    if (targets.has(targetKey)) {
      throw new Error('effective_skill_note_duplicate_target');
    }
    targets.add(targetKey);
    const notes = bySkill.get(delta.skillId);
    if (!notes) throw new Error('effective_skill_note_skill_missing');
    const existing = notes.get(delta.noteId);
    if (delta.op === 'add') {
      if (existing || !delta.after) {
        throw new Error('effective_skill_note_add_conflict');
      }
      notes.set(delta.noteId, materializeEvolutionSkillNote({
        note: delta.after,
      }));
      continue;
    }
    if (
      !existing
      || !delta.beforeContentHash
      || skillNoteContentHash(existing) !== delta.beforeContentHash
    ) {
      throw new Error('effective_skill_note_before_hash_mismatch');
    }
    if (delta.op === 'modify') {
      if (!delta.after) {
        throw new Error('effective_skill_note_modify_invalid');
      }
      notes.set(delta.noteId, materializeEvolutionSkillNote({
        note: delta.after,
        existing,
      }));
    } else {
      notes.delete(delta.noteId);
    }
  }
  const snapshotValue = deepFreeze(Object.fromEntries(
    [...bySkill.entries()].map(([skillId, notes]) => [
      skillId,
      [...notes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    ]),
  ));
  const registryFingerprint = canonicalContentHash(snapshotValue);
  return Object.freeze({
    registryFingerprint,
    getSkillNotes(skillId: string): readonly PersistedSkillNote[] {
      return snapshotValue[skillId] ?? [];
    },
    getSkillIds(): readonly string[] {
      return Object.keys(snapshotValue);
    },
  });
}

function findMatchingSkill(
  skills: readonly SkillDefinition[],
  question: string,
): SkillDefinition | undefined {
  const normalizedQuestion = question.toLowerCase();
  for (const skill of skills) {
    const keywords = skill.triggers?.keywords;
    const keywordList = Array.isArray(keywords)
      ? keywords
      : [
          ...(keywords?.zh ?? []),
          ...(keywords?.en ?? []),
        ];
    if (
      keywordList.some(keyword =>
        normalizedQuestion.includes(keyword.toLowerCase()))
    ) {
      return skill;
    }
    for (const pattern of skill.triggers?.patterns ?? []) {
      try {
        if (new RegExp(pattern, 'i').test(question)) return skill;
      } catch {
        // Invalid base patterns remain the loader/validator's responsibility.
      }
    }
  }
  return undefined;
}

function requireSuccessfulComposition(
  result: EffectiveSkillCompositionResult,
): Extract<EffectiveSkillCompositionResult, {validationState: 'passed'}> {
  if (result.validationState === 'passed') return result;
  const firstIssue = result.issues[0];
  throw new Error([
    'effective_skill_composition_failed',
    result.reason,
    firstIssue?.overlayId,
    firstIssue?.baseSkillId,
    firstIssue?.path,
  ].filter(Boolean).join(':'));
}

function buildReadonlySkillRegistry(input: {
  baseRegistry: Awaited<ReturnType<typeof getWorkspaceSkillRegistry>>['registry'];
  composition: Extract<
    EffectiveSkillCompositionResult,
    {validationState: 'passed'}
  >;
  appliedOverlayIds?: Readonly<Record<string, readonly string[]>>;
  overlayGeneration: string;
}): ReadonlySkillRegistrySnapshot {
  const skills = [...input.composition.skills];
  const byId = new Map(skills.map(skill => [skill.name, skill]));
  const fragments = new Map(input.baseRegistry.getFragmentCache());
  const origins = new Map<string, SkillOriginMetadata | undefined>(
    skills.map(skill => [
      skill.name,
      input.baseRegistry.getSkillOrigin(skill.name),
    ]),
  );
  const vendorOverrides = new Map<string, readonly VendorOverride[]>(
    skills.map(skill => [
      skill.name,
      frozenJsonClone(
        input.baseRegistry.getVendorOverridesForSkill(skill.name),
      ),
    ]),
  );
  const vendorOverrideLoadIssues = frozenJsonClone(
    input.baseRegistry.getVendorOverrideLoadIssues?.() ?? [],
  );
  let registryFingerprint = '';
  const snapshot: ReadonlySkillRegistrySnapshot = Object.freeze({
    get registryFingerprint(): string {
      return registryFingerprint;
    },
    overlayGeneration: input.overlayGeneration,
    isInitialized(): true {
      return true;
    },
    getSkill(name: string): SkillDefinition | undefined {
      return byId.get(name);
    },
    getAllSkills(): SkillDefinition[] {
      return [...skills];
    },
    getFragmentCache(): Map<string, string> {
      return new Map(fragments);
    },
    getSkillOrigin(name: string): SkillOriginMetadata | undefined {
      const origin = origins.get(name);
      return origin ? frozenJsonClone(origin) : undefined;
    },
    getAppliedOverlayIds(name: string): readonly string[] {
      return input.appliedOverlayIds?.[name]
        ?? input.composition.appliedOverlayIds[name]
        ?? [];
    },
    getVendorOverride(skillId: string, vendor: string): VendorOverride | undefined {
      const override = vendorOverrides.get(skillId)
        ?.find(entry => entry.vendor.toLowerCase() === vendor.toLowerCase());
      return override ? frozenJsonClone(override) : undefined;
    },
    getVendorOverridesForSkill(skillId: string): VendorOverride[] {
      return [...(vendorOverrides.get(skillId) ?? [])]
        .map(override => frozenJsonClone(override));
    },
    getVendorOverrideLoadIssues() {
      return vendorOverrideLoadIssues.map(issue => frozenJsonClone(issue));
    },
    findMatchingSkill(question: string): SkillDefinition | undefined {
      return findMatchingSkill(skills, question);
    },
  });
  registryFingerprint = buildSkillRegistryAttribution(snapshot)
    .registryFingerprint;
  return snapshot;
}

function mergeAppliedOverlayIds(
  common: Readonly<Record<string, readonly string[]>>,
  role: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const skillIds = new Set([...Object.keys(common), ...Object.keys(role)]);
  return Object.fromEntries([...skillIds].sort().map(skillId => [
    skillId,
    [...(common[skillId] ?? []), ...(role[skillId] ?? [])],
  ]));
}

function sameScope(
  left: RunManifestScope,
  right: RunManifestScope,
): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

type PhaseHintDelta = Exclude<
  EvolutionStrategyDeltaV1,
  {kind: 'strategy_contribution'}
> | EvaluationRoleVariantV1['phaseHintDeltas'][number];

function applyPhaseHintDeltas(input: {
  snapshot: ReturnType<typeof buildStrategyRegistrySnapshot>;
  deltas: readonly PhaseHintDelta[];
  overlayGeneration: string;
}): ReturnType<typeof buildStrategyRegistrySnapshot> {
  const byScene = new Map(
    input.snapshot.getAllStrategies().map(definition => [
      definition.scene,
      definition,
    ]),
  );
  const targetKeys = new Set<string>();
  for (const delta of [...input.deltas].sort((left, right) =>
    (left.scene ?? '').localeCompare(right.scene ?? '')
    || left.hintId.localeCompare(right.hintId))) {
    if (delta.kind === 'retire_phase_hint') {
      const matchingScenes = delta.scene
        ? [delta.scene]
        : [...byScene.entries()]
            .filter(([, definition]) =>
              definition.phaseHints.some(hint => hint.id === delta.hintId))
            .map(([scene]) => scene);
      if (matchingScenes.length !== 1) {
        throw new Error('effective_strategy_retire_target_ambiguous');
      }
      const definition = byScene.get(matchingScenes[0]);
      const existing = definition?.phaseHints.find(
        hint => hint.id === delta.hintId,
      );
      if (!existing || canonicalContentHash(existing) !== delta.contentHash) {
        throw new Error('effective_strategy_retire_hash_mismatch');
      }
      byScene.set(matchingScenes[0], {
        ...definition!,
        phaseHints: definition!.phaseHints.filter(
          hint => hint.id !== delta.hintId,
        ),
      });
      continue;
    }
    const targetKey = `${delta.scene}\0${delta.hintId}`;
    if (targetKeys.has(targetKey)) {
      throw new Error('evaluation_strategy_mutation_duplicate_target');
    }
    targetKeys.add(targetKey);
    const definition = byScene.get(delta.scene);
    if (!definition) {
      throw new Error('evaluation_strategy_mutation_scene_missing');
    }
    const index = definition.phaseHints.findIndex(hint => hint.id === delta.hintId);
    if (delta.op === 'add') {
      if (index >= 0 || !delta.after || delta.after.id !== delta.hintId) {
        throw new Error('evaluation_strategy_mutation_add_conflict');
      }
      byScene.set(delta.scene, {
        ...definition,
        phaseHints: [...definition.phaseHints, delta.after],
      });
      continue;
    }
    if (index < 0 || !delta.beforeContentHash) {
      throw new Error('evaluation_strategy_mutation_target_missing');
    }
    if (
      canonicalContentHash(definition.phaseHints[index])
      !== delta.beforeContentHash
    ) {
      throw new Error('evaluation_strategy_mutation_before_hash_mismatch');
    }
    if (delta.op === 'modify') {
      if (!delta.after || delta.after.id !== delta.hintId) {
        throw new Error('evaluation_strategy_mutation_modify_invalid');
      }
      const phaseHints = [...definition.phaseHints];
      phaseHints[index] = delta.after;
      byScene.set(delta.scene, {...definition, phaseHints});
    } else {
      byScene.set(delta.scene, {
        ...definition,
        phaseHints: definition.phaseHints.filter(
          hint => hint.id !== delta.hintId,
        ),
      });
    }
  }
  return buildStrategyRegistrySnapshotFromDefinitions({
    definitions: [...byScene.values()],
    overlayGeneration: input.overlayGeneration,
  });
}

function deriveOverlayGeneration(input: {
  scope: RunManifestScope;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
  compositionFingerprint: string;
  effectiveStrategyRegistryFingerprint: string;
  effectiveSkillNoteRegistryFingerprint: string;
  hasContributions: boolean;
}): string {
  if (!input.hasContributions) {
    return `builtin:${input.baseSkillRegistryFingerprint}`;
  }
  return `overlay:${canonicalContentHash(input)}`;
}

export async function buildEffectiveRuntimeRegistrySnapshot(
  input: BuildEffectiveRuntimeRegistrySnapshotInput,
): Promise<EffectiveRuntimeRegistrySnapshot> {
  const scope: RunManifestScope = {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
  };
  const baseHandle = await getWorkspaceSkillRegistry(
    input.scope,
    input.workspaceOptions,
  );
  const skillOverlays = input.skillOverlays ?? [];
  const strategyContributions = input.strategyContributions ?? [];
  const commonComposition = requireSuccessfulComposition(composeEffectiveSkills({
    scope,
    baseSkills: baseHandle.registry.getAllSkills(),
    fragments: baseHandle.registry.getFragmentCache(),
    overlays: skillOverlays,
  }));
  const baseStrategySnapshot = buildStrategyRegistrySnapshot({
    scope,
    overlayGeneration: 'building:base',
  });
  const contributedStrategySnapshot = buildStrategyRegistrySnapshot({
    scope,
    overlayGeneration: 'building:common',
    contributions: strategyContributions,
  });
  const commonStrategySnapshot = input.strategyDeltas?.length
    ? applyPhaseHintDeltas({
        snapshot: contributedStrategySnapshot,
        deltas: input.strategyDeltas,
        overlayGeneration: 'building:common-deltas',
      })
    : contributedStrategySnapshot;
  const commonSkillNotes = buildSkillNoteRegistrySnapshot({
    skillIds: commonComposition.skills.map(skill => skill.name),
    deltas: input.skillNoteDeltas ?? [],
    sourceOptions: input.skillNoteSourceOptions,
  });
  const derivedOverlayGeneration = deriveOverlayGeneration({
    scope,
    baseSkillRegistryFingerprint: baseHandle.registryFingerprint,
    baseStrategyRegistryFingerprint: baseStrategySnapshot.registryFingerprint,
    compositionFingerprint: commonComposition.compositionFingerprint,
    effectiveStrategyRegistryFingerprint:
      commonStrategySnapshot.registryFingerprint,
    effectiveSkillNoteRegistryFingerprint:
      commonSkillNotes.registryFingerprint,
    hasContributions:
      skillOverlays.length > 0
      || strategyContributions.length > 0
      || (input.strategyDeltas?.length ?? 0) > 0
      || (input.skillNoteDeltas?.length ?? 0) > 0,
  });
  if (
    input.publishedGeneration !== undefined
    && !input.publishedGeneration.trim()
  ) {
    throw new Error('effective_runtime_registry_generation_invalid');
  }
  const commonOverlayGeneration =
    input.publishedGeneration ?? derivedOverlayGeneration;
  const commonSkillRegistry = buildReadonlySkillRegistry({
    baseRegistry: baseHandle.registry,
    composition: commonComposition,
    appliedOverlayIds: commonComposition.appliedOverlayIds,
    overlayGeneration: commonOverlayGeneration,
  });
  const variant = input.evaluationRoleVariant;
  if (
    variant
    && (
      !sameScope(variant.scope, scope)
      || variant.baseSkillRegistryFingerprint
        !== commonSkillRegistry.registryFingerprint
      || variant.baseStrategyRegistryFingerprint
        !== commonStrategySnapshot.registryFingerprint
    )
  ) {
    throw new Error('evaluation_role_variant_base_mismatch');
  }
  const composition = variant
    ? requireSuccessfulComposition(composeEffectiveSkills({
        scope,
        baseSkills: commonComposition.skills,
        fragments: baseHandle.registry.getFragmentCache(),
        overlays: variant.skillOverlays,
      }))
    : commonComposition;
  const appliedOverlayIds = variant
    ? mergeAppliedOverlayIds(
        commonComposition.appliedOverlayIds,
        composition.appliedOverlayIds,
      )
    : commonComposition.appliedOverlayIds;
  const affectedSkillIds = Object.keys(appliedOverlayIds);
  if (affectedSkillIds.length > 0) {
    const validation = validateSkillDefinitionsInProcess({
      definitions: composition.skills,
      affectedSkillIds,
      fragmentCache: baseHandle.registry.getFragmentCache(),
    });
    if (!validation.valid) {
      const firstIssue = validation.issues.find(issue =>
        issue.severity === 'error');
      throw new Error([
        'effective_skill_validation_failed',
        firstIssue?.skillId,
        firstIssue?.code,
        firstIssue?.path,
      ].filter(Boolean).join(':'));
    }
  }
  const variantContributedStrategySnapshot =
    variant?.strategyContributions.length
      ? buildStrategyRegistrySnapshot({
          scope,
          overlayGeneration: commonOverlayGeneration,
          contributions: [
            ...strategyContributions,
            ...variant.strategyContributions,
          ],
        })
      : commonStrategySnapshot;
  const variantCommonStrategySnapshot =
    variant?.strategyContributions.length && input.strategyDeltas?.length
      ? applyPhaseHintDeltas({
          snapshot: variantContributedStrategySnapshot,
          deltas: input.strategyDeltas,
          overlayGeneration: commonOverlayGeneration,
        })
      : variantContributedStrategySnapshot;
  const evaluationStrategyDeltas: PhaseHintDelta[] = variant
    ? [
        ...variant.phaseHintDeltas,
        ...variant.retiredInjections
          .filter(entry => entry.category === 'phaseHints')
          .map(entry => ({
            kind: 'retire_phase_hint' as const,
            hintId: entry.id,
            contentHash: entry.contentHash,
            ...(entry.scene ? {scene: entry.scene} : {}),
          })),
      ]
    : [];
  const effectiveStrategySnapshot = evaluationStrategyDeltas.length > 0
    ? applyPhaseHintDeltas({
        snapshot: variantCommonStrategySnapshot,
        deltas: evaluationStrategyDeltas,
        overlayGeneration: commonOverlayGeneration,
      })
    : variantCommonStrategySnapshot;
  const baseStrategies = new Map(
    baseStrategySnapshot.getAllStrategies().map(definition => [
      definition.scene,
      definition,
    ]),
  );
  const affectedScenes = effectiveStrategySnapshot.getAllStrategies()
    .filter(definition => {
      const base = baseStrategies.get(definition.scene);
      return !base
        || fingerprintStrategyDefinition(base)
          !== fingerprintStrategyDefinition(definition);
    })
    .map(definition => definition.scene);
  if (affectedScenes.length > 0) {
    const validation = validateStrategyDefinitionsInProcess({
      definitions: effectiveStrategySnapshot.getAllStrategies(),
      affectedScenes,
      knownSkillIds: new Set(
        composition.skills.map(definition => definition.name),
      ),
    });
    if (!validation.valid) {
      const firstIssue = validation.issues[0];
      throw new Error([
        'effective_strategy_validation_failed',
        firstIssue?.scene,
        firstIssue?.code,
        firstIssue?.path,
      ].filter(Boolean).join(':'));
    }
  }
  const overlayGeneration = commonOverlayGeneration;
  const strategyRegistry = effectiveStrategySnapshot;
  const skillRegistry = buildReadonlySkillRegistry({
    baseRegistry: baseHandle.registry,
    composition,
    appliedOverlayIds,
    overlayGeneration,
  });
  const evaluationSkillNoteDeltas: EvolutionSkillNoteDeltaV1[] = variant
    ? [
        ...variant.skillNoteDeltas.map(delta => ({
          kind: 'skill_note_delta' as const,
          op: delta.op,
          skillId: delta.skillId,
          noteId: delta.noteId,
          ...(delta.beforeContentHash
            ? {beforeContentHash: delta.beforeContentHash}
            : {}),
          ...(delta.after ? {after: delta.after} : {}),
        })),
        ...variant.retiredInjections
          .filter(entry => entry.category === 'skillNotes')
          .map(entry => ({
            kind: 'retire_skill_note' as const,
            noteId: entry.id,
            contentHash: entry.contentHash,
          })),
      ]
    : [];
  const skillNotes = evaluationSkillNoteDeltas.length > 0
    ? buildSkillNoteRegistrySnapshot({
        skillIds: composition.skills.map(skill => skill.name),
        deltas: evaluationSkillNoteDeltas,
        baseSnapshot: commonSkillNotes,
      })
    : commonSkillNotes;
  const evaluationTreatment = variant
    ? Object.freeze({
        artifactId: variant.artifactId,
        treatmentGeneration: `evaluation:${canonicalContentHash({
          declared: variant.treatmentGeneration,
          materializedInputHash: variant.materializedInputHash,
          effectiveSkillRegistryFingerprint: skillRegistry.registryFingerprint,
          effectiveStrategyRegistryFingerprint:
            strategyRegistry.registryFingerprint,
          effectiveSkillNoteRegistryFingerprint:
            skillNotes.registryFingerprint,
        })}`,
        materializedInputHash: variant.materializedInputHash,
        effectiveSkillRegistryFingerprint: skillRegistry.registryFingerprint,
        effectiveStrategyRegistryFingerprint: strategyRegistry.registryFingerprint,
        effectiveSkillNoteRegistryFingerprint:
          skillNotes.registryFingerprint,
      })
    : undefined;
  return Object.freeze({
    scope: deepFreeze({...scope}),
    baseSkillRegistryFingerprint: baseHandle.registryFingerprint,
    baseStrategyRegistryFingerprint: baseStrategySnapshot.registryFingerprint,
    overlayGeneration,
    ...(evaluationTreatment ? {evaluationTreatment} : {}),
    skillRegistry,
    strategyRegistry,
    skillNotes,
  });
}

export function publishEffectiveRuntimeRegistrySnapshot(
  snapshot: EffectiveRuntimeRegistrySnapshot,
): EffectiveRuntimeRegistrySnapshot {
  return effectiveRuntimeRegistryManager.publish(snapshot);
}

export async function getEffectiveRuntimeRegistrySnapshot(
  input: BuildEffectiveRuntimeRegistrySnapshotInput,
): Promise<EffectiveRuntimeRegistrySnapshot> {
  if (input.evaluationRoleVariant) {
    return buildEffectiveRuntimeRegistrySnapshot(input);
  }
  if (
    input.skillOverlays?.length
    || input.strategyContributions?.length
    || input.strategyDeltas?.length
    || input.skillNoteDeltas?.length
    || input.publishedGeneration !== undefined
  ) {
    throw new Error('effective_runtime_registry_ad_hoc_publish_forbidden');
  }
  return effectiveRuntimeRegistryManager.getPublishedOrInitialize(input);
}

export function getPublishedEffectiveRuntimeRegistrySnapshot(
  scope: RunManifestScope,
): EffectiveRuntimeRegistrySnapshot | undefined {
  return effectiveRuntimeRegistryManager.getPublished(scope);
}

export function currentEffectiveSkillRegistry():
  | ReadonlySkillRegistrySnapshot
  | undefined {
  return currentEffectiveRuntimeRegistrySnapshot()?.skillRegistry;
}

export function resolveEffectiveSkillRegistryForRuntime(
  fallback: SkillRegistryView,
): SkillRegistryView {
  const current = currentEffectiveSkillRegistry();
  if (current) return current;
  if (currentRunManifestAttributionSink()) {
    throw new Error('effective_runtime_registry_snapshot_missing_for_run');
  }
  return fallback;
}

export function clearEffectiveRuntimeRegistrySnapshotsForTests(): void {
  effectiveRuntimeRegistryManager.clearForTests();
}
