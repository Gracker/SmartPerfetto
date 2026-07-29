// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import semver from 'semver';

import {
  fingerprintStrategyDefinition,
  type StrategyDefinition,
  type StrategyRegistryContribution,
} from '../../agentv3/strategyLoader';
import type {ApplicationBuildIdentity} from '../applicationUpdate/types';
import type {SkillDefinition} from '../skillEngine/types';
import type {
  EvolutionBaseRelation,
  EvolutionOverlayArtifactV1,
  EvolutionOverlayProvenanceV1,
  EvolutionOverlayRegistryEntryV1,
  EvolutionSkillNoteDeltaV1,
  EvolutionStrategyDeltaV1,
  EvolutionValidationBoundInputsV1,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
  SkillOverlayDeltaV1,
  UpgradeReconciliationIssueV1,
  UpgradeReconciliationReportV1,
} from '../../types/selfEvolution';
import {
  loadLastReconciledBuildIdentity,
  saveLastReconciledBuildIdentity,
} from './buildIdentityStore';
import {canonicalContentHash} from './canonicalJson';
import {
  createUpgradeReconciliationReportV1,
  evolutionValidationInputFingerprint,
  EVOLUTION_OVERLAY_LOADER_SCHEMA_VERSION,
  EVOLUTION_OVERLAY_VALIDATOR_VERSION,
} from './evolutionOverlayContract';
import {EvolutionOverlayArtifactStore} from './evolutionOverlayArtifactStore';
import {EvolutionOverlayRegistry} from './evolutionOverlayRegistry';
import {
  buildEffectiveRuntimeRegistrySnapshot,
  effectiveRuntimeRegistryManager,
  type BuildEffectiveRuntimeRegistrySnapshotInput,
  type EffectiveRuntimeRegistryManager,
} from './effectiveRuntimeRegistryProvider';
import type {EffectiveRuntimeRegistrySnapshot} from './effectiveRuntimeRegistryContext';
import {fingerprintSkillDefinition} from './skillFingerprint';

export interface OverlayReconcilerOptions {
  registry: EvolutionOverlayRegistry;
  artifactStore: EvolutionOverlayArtifactStore;
  persistence: SelfEvolutionPersistenceCapability;
  buildIdentity: ApplicationBuildIdentity;
  buildIdentityFilePath?: string;
  runtimeManager?: EffectiveRuntimeRegistryManager;
  buildSnapshot?: typeof buildEffectiveRuntimeRegistrySnapshot;
  traceProcessorVersion: string;
  dependencyFingerprints?: {
    toolAllowlist?: string;
    promptTemplates?: string;
  };
  now?: () => number;
}

export interface OverlayReconciliationResult {
  snapshot: EffectiveRuntimeRegistrySnapshot;
  report: UpgradeReconciliationReportV1;
}

interface ReconciliationCandidate {
  entry: EvolutionOverlayRegistryEntryV1;
  artifact: EvolutionOverlayArtifactV1;
  baseRelation: EvolutionBaseRelation;
  currentBaseFingerprint: string;
}

export class OverlayReconciler {
  private readonly buildSnapshot: typeof buildEffectiveRuntimeRegistrySnapshot;
  private readonly runtimeManager: EffectiveRuntimeRegistryManager;
  private readonly now: () => number;

  constructor(private readonly options: OverlayReconcilerOptions) {
    this.buildSnapshot =
      options.buildSnapshot ?? buildEffectiveRuntimeRegistrySnapshot;
    this.runtimeManager =
      options.runtimeManager ?? effectiveRuntimeRegistryManager;
    this.now = options.now ?? Date.now;
  }

  async reconcile(
    scope: RunManifestScope,
    options: {deferRuntimePublish?: boolean} = {},
  ): Promise<OverlayReconciliationResult> {
    if (this.options.persistence.persistence !== 'available') {
      throw new Error('self_evolution_persistence_unavailable');
    }
    const now = this.now();
    const previousBuildIdentity = loadLastReconciledBuildIdentity({
      filePath: this.options.buildIdentityFilePath,
    })?.lastReconciledBuildIdentity ?? null;
    const base = await this.buildSnapshot({scope});
    const entries = this.options.registry.listEntries(
      scope,
      {actionState: 'committed'},
    );
    const issues: UpgradeReconciliationIssueV1[] =
      base.skillRegistry.getVendorOverrideLoadIssues().map(issue => ({
        schemaVersion: 1,
        issueId: `vendor:${canonicalContentHash(issue)}`,
        source: 'vendor_override',
        kind: issue.kind,
        sourcePath: issue.sourcePath,
        ...(issue.extends ? {baseId: issue.extends} : {}),
        reasonCode: issue.reasonCode,
        message: issue.message,
      }));
    const candidates: ReconciliationCandidate[] = [];
    const absorbedCandidates: ReconciliationCandidate[] = [];

    for (const entry of entries) {
      let artifact: EvolutionOverlayArtifactV1;
      let baseState: ReturnType<typeof resolveBaseState>;
      try {
        artifact = this.options.artifactStore.load(
          entry.artifactContentHash,
        );
        baseState = resolveBaseState({
          artifact,
          snapshot: base,
          buildIdentity: this.options.buildIdentity,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.registry.reconcileEntry({
          scope,
          entryId: entry.entryId,
          baseRelation: entry.baseRelation,
          validationState: 'error',
          userDisabled: entry.userDisabled,
          validationReason: 'overlay_artifact_invalid',
          reconciledAt: now,
        });
        issues.push({
          schemaVersion: 1,
          issueId: `overlay:${canonicalContentHash({
            entryId: entry.entryId,
            artifactContentHash: entry.artifactContentHash,
            message,
          })}`,
          source: 'overlay',
          kind: 'validation_error',
          overlayId: entry.overlayId,
          baseId: entry.provenance.derivedFrom.baseId,
          reasonCode: 'overlay_artifact_invalid',
          message,
        });
        continue;
      }
      if (
        baseState.baseRelation === 'missing'
        || baseState.baseRelation === 'incompatible'
        || entry.userDisabled
      ) {
        this.options.registry.reconcileEntry({
          scope,
          entryId: entry.entryId,
          baseRelation: baseState.baseRelation,
          validationState: 'pending',
          userDisabled: entry.userDisabled,
          reconciledAt: now,
        });
        continue;
      }
      if (baseState.baseRelation === 'absorbed') {
        this.options.registry.reconcileEntry({
          scope,
          entryId: entry.entryId,
          baseRelation: 'absorbed',
          validationState: 'pending',
          validationReason: 'validation_inputs_recomputed',
          reconciledAt: now,
        });
        absorbedCandidates.push({
          entry,
          artifact,
          baseRelation: 'absorbed',
          currentBaseFingerprint: baseState.currentBaseFingerprint,
        });
        continue;
      }
      this.options.registry.reconcileEntry({
        scope,
        entryId: entry.entryId,
        baseRelation: baseState.baseRelation,
        validationState: 'pending',
        validationReason: 'validation_inputs_recomputed',
        reconciledAt: now,
      });
      candidates.push({
        entry,
        artifact,
        baseRelation: baseState.baseRelation,
        currentBaseFingerprint: baseState.currentBaseFingerprint,
      });
    }

    const candidateGeneration = candidates.length === 0
      ? base.overlayGeneration
      : canonicalContentHash({
          schemaVersion: 1,
          scope,
          buildIdentity: this.options.buildIdentity,
          baseSkillRegistryFingerprint:
            base.baseSkillRegistryFingerprint,
          baseStrategyRegistryFingerprint:
            base.baseStrategyRegistryFingerprint,
          overlays: candidates.map(candidate => ({
            entryId: candidate.entry.entryId,
            artifactContentHash: candidate.entry.artifactContentHash,
            baseRelation: candidate.baseRelation,
            currentBaseFingerprint: candidate.currentBaseFingerprint,
          })).sort((left, right) => left.entryId.localeCompare(right.entryId)),
          dependencies: this.options.dependencyFingerprints ?? {},
          traceProcessorVersion: this.options.traceProcessorVersion,
        });
    let candidateSnapshot = base;
    let validationFailure: Error | undefined;
    if (candidates.length > 0) {
      try {
        candidateSnapshot = await this.buildSnapshot(
          buildCandidateSnapshotInput({
            scope,
            candidates,
            publishedGeneration: candidateGeneration,
          }),
        );
      } catch (error) {
        validationFailure = error instanceof Error
          ? error
          : new Error(String(error));
      }
    }

    const buildIdentityFingerprint =
      canonicalContentHash(this.options.buildIdentity);
    const fragmentsFingerprint = canonicalContentHash(
      [...base.skillRegistry.getFragmentCache().entries()]
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    for (const candidate of [...candidates, ...absorbedCandidates]) {
      const boundInputs: EvolutionValidationBoundInputsV1 = {
        overlayContentHash:
          candidate.artifact.provenance.overlayContentHash,
        validatedAgainstBaseFingerprint:
          candidate.currentBaseFingerprint,
        skillRegistryFingerprint: base.baseSkillRegistryFingerprint,
        strategyRegistryFingerprint: base.baseStrategyRegistryFingerprint,
        fragmentsFingerprint,
        ...(this.options.dependencyFingerprints?.toolAllowlist
          ? {
              toolAllowlistFingerprint:
                this.options.dependencyFingerprints.toolAllowlist,
            }
          : {}),
        ...(this.options.dependencyFingerprints?.promptTemplates
          ? {
              promptTemplatesFingerprint:
                this.options.dependencyFingerprints.promptTemplates,
            }
          : {}),
        loaderSchemaVersion: EVOLUTION_OVERLAY_LOADER_SCHEMA_VERSION,
        buildIdentityFingerprint,
        overlayGeneration: candidateGeneration,
      };
      const validationResult =
        validationFailure && candidate.baseRelation !== 'absorbed'
          ? 'failed'
          : 'passed';
      const provenance: EvolutionOverlayProvenanceV1 = {
        ...candidate.entry.provenance,
        validation: {
          result: validationResult,
          validatorVersion: EVOLUTION_OVERLAY_VALIDATOR_VERSION,
          at: now,
          validationInputFingerprint:
            evolutionValidationInputFingerprint(boundInputs),
          boundInputs,
        },
        reconciledAt: now,
      };
      this.options.registry.reconcileEntry({
        scope,
        entryId: candidate.entry.entryId,
        baseRelation: candidate.baseRelation,
        validationState: validationResult,
        ...(validationResult === 'failed'
          ? {validationReason: 'overlay_conflict'}
          : {}),
        provenance,
        reconciledAt: now,
      });
    }
    if (validationFailure) {
      issues.push({
        schemaVersion: 1,
        issueId: `overlay:${canonicalContentHash({
          generation: candidateGeneration,
          message: validationFailure.message,
        })}`,
        source: 'overlay',
        kind: 'validation_failure',
        reasonCode: 'overlay_conflict',
        message: validationFailure.message,
      });
      candidateSnapshot = base;
    }

    const publishedGeneration = candidateSnapshot.overlayGeneration;
    await this.persistGeneration({
      scope,
      snapshot: candidateSnapshot,
      generation: publishedGeneration,
      now,
    });
    if (!options.deferRuntimePublish) {
      this.publishRuntimeSnapshot(candidateSnapshot);
    }
    const finalEntries = this.options.registry.listEntries(
      scope,
      {actionState: 'committed'},
    );
    const report = createUpgradeReconciliationReportV1({
      reportId: `reconciliation:${now}:${canonicalContentHash({
        scope,
        publishedGeneration,
      }).slice(0, 16)}`,
      scope,
      previousBuildIdentity,
      currentBuildIdentity: this.options.buildIdentity,
      candidateGeneration,
      publishedGeneration,
      byBaseRelation: groupEntries(finalEntries, 'baseRelation', [
        'unchanged',
        'changed',
        'absorbed',
        'missing',
        'incompatible',
      ]),
      byValidationState: groupEntries(finalEntries, 'validationState', [
        'pending',
        'passed',
        'failed',
        'error',
      ]),
      byActivationState: groupEntries(finalEntries, 'activationState', [
        'active',
        'inactive',
        'quarantined',
        'obsolete',
        'disabled',
      ]),
      issues,
      createdAt: now,
    });
    this.options.registry.saveReport(report);
    saveLastReconciledBuildIdentity(this.options.buildIdentity, {
      filePath: this.options.buildIdentityFilePath,
      persistence: this.options.persistence,
      reconciledAt: new Date(now).toISOString(),
    });
    return {snapshot: candidateSnapshot, report};
  }

  publishRuntimeSnapshot(
    snapshot: EffectiveRuntimeRegistrySnapshot,
  ): EffectiveRuntimeRegistrySnapshot {
    const expectedRuntimeGeneration =
      this.runtimeManager.getPublished(snapshot.scope)?.overlayGeneration
      ?? null;
    return this.runtimeManager.publish(snapshot, expectedRuntimeGeneration);
  }

  private async persistGeneration(input: {
    scope: RunManifestScope;
    snapshot: EffectiveRuntimeRegistrySnapshot;
    generation: string;
    now: number;
  }): Promise<void> {
    let head = this.options.registry.generationHead(input.scope);
    if (head.state === 'prepared') {
      if (head.candidateGeneration === input.generation) {
        this.options.registry.publishGeneration({
          scope: input.scope,
          candidateGeneration: input.generation,
          fence: head.fence,
        });
      } else {
        this.options.registry.abortPreparedGeneration({
          scope: input.scope,
          candidateGeneration: head.candidateGeneration!,
          fence: head.fence,
        });
      }
      head = this.options.registry.generationHead(input.scope);
    }
    if (
      head.state !== 'published'
      || head.publishedGeneration !== input.generation
    ) {
      const prepared = this.options.registry.prepareGeneration({
        scope: input.scope,
        candidateGeneration: input.generation,
        expectedFence: head.fence,
        persistedAt: input.now,
      });
      this.options.registry.publishGeneration({
        scope: input.scope,
        candidateGeneration: input.generation,
        fence: prepared.fence,
      });
    }
  }
}

function buildCandidateSnapshotInput(input: {
  scope: RunManifestScope;
  candidates: readonly ReconciliationCandidate[];
  publishedGeneration: string;
}): BuildEffectiveRuntimeRegistrySnapshotInput {
  const skillOverlays: SkillOverlayDeltaV1[] = [];
  const strategyContributions: StrategyRegistryContribution[] = [];
  const strategyDeltas: Exclude<
    EvolutionStrategyDeltaV1,
    {kind: 'strategy_contribution'}
  >[] = [];
  const skillNoteDeltas: EvolutionSkillNoteDeltaV1[] = [];
  for (const candidate of input.candidates) {
    const payload = candidate.artifact.payload;
    if (payload.payloadKind === 'skill_delta') {
      skillOverlays.push({
        ...payload.skillOverlay,
        baseFingerprint: candidate.currentBaseFingerprint,
      });
    } else if (payload.payloadKind === 'strategy_delta') {
      if (payload.strategyDelta.kind === 'strategy_contribution') {
        strategyContributions.push({
          ...payload.strategyDelta.contribution,
          baseStrategyFingerprint: candidate.currentBaseFingerprint,
        });
      } else {
        strategyDeltas.push(payload.strategyDelta);
      }
    } else {
      skillNoteDeltas.push(payload.skillNoteDelta);
    }
  }
  return {
    scope: input.scope,
    skillOverlays,
    strategyContributions,
    strategyDeltas,
    skillNoteDeltas,
    publishedGeneration: input.publishedGeneration,
  };
}

function resolveBaseState(input: {
  artifact: EvolutionOverlayArtifactV1;
  snapshot: EffectiveRuntimeRegistrySnapshot;
  buildIdentity: ApplicationBuildIdentity;
}): {
  baseRelation: EvolutionBaseRelation;
  currentBaseFingerprint: string;
} {
  const provenance = input.artifact.provenance;
  if (
    versionLessThan(
      input.buildIdentity.version,
      provenance.compatibility.smartPerfettoMinVersion,
    )
  ) {
    return {baseRelation: 'incompatible', currentBaseFingerprint: 'missing'};
  }
  if (provenance.derivedFrom.baseKind === 'skill') {
    const skill = input.snapshot.skillRegistry.getSkill(
      provenance.derivedFrom.baseId,
    );
    if (!skill) return {baseRelation: 'missing', currentBaseFingerprint: 'missing'};
    const fingerprint = fingerprintSkillDefinition(
      skill,
      input.snapshot.skillRegistry.getFragmentCache(),
    );
    if (
      versionLessThan(skill.version, provenance.derivedFrom.baseVersion)
    ) {
      return {
        baseRelation: 'incompatible',
        currentBaseFingerprint: fingerprint,
      };
    }
    if (fingerprint === provenance.derivedFrom.baseContentFingerprint) {
      return {baseRelation: 'unchanged', currentBaseFingerprint: fingerprint};
    }
    return {
      baseRelation: skillOverlayAbsorbed(
        input.artifact,
        skill,
        input.snapshot,
      )
        ? 'absorbed'
        : 'changed',
      currentBaseFingerprint: fingerprint,
    };
  }
  const strategy = input.snapshot.strategyRegistry.getStrategy(
    provenance.derivedFrom.baseId,
  );
  if (!strategy) return {baseRelation: 'missing', currentBaseFingerprint: 'missing'};
  const fingerprint = fingerprintStrategyDefinition(strategy);
  if (fingerprint === provenance.derivedFrom.baseContentFingerprint) {
    return {baseRelation: 'unchanged', currentBaseFingerprint: fingerprint};
  }
  return {
    baseRelation: strategyOverlayAbsorbed(input.artifact, strategy)
      ? 'absorbed'
      : 'changed',
    currentBaseFingerprint: fingerprint,
  };
}

function skillOverlayAbsorbed(
  artifact: EvolutionOverlayArtifactV1,
  skill: SkillDefinition,
  snapshot: EffectiveRuntimeRegistrySnapshot,
): boolean {
  if (artifact.payload.payloadKind === 'skill_delta') {
    return artifact.payload.skillOverlay.operations.every(operation => {
      if (operation.op === 'append_steps') {
        return operation.steps.every(expected =>
          skill.steps?.some(actual =>
            actual.id === expected.id
            && canonicalContentHash(actual) === canonicalContentHash(expected)));
      }
      if (operation.op === 'set_display') {
        return canonicalContentHash(skill.output?.display ?? null)
          === canonicalContentHash(operation.display);
      }
      const metaMatches =
        operation.meta?.description === undefined
        || skill.meta.description === operation.meta.description;
      const tagsMatch = operation.meta?.tags === undefined
        || canonicalContentHash(skill.meta.tags ?? [])
          === canonicalContentHash(operation.meta.tags);
      const keywords = skill.triggers?.keywords;
      const keywordObject = Array.isArray(keywords)
        ? undefined
        : keywords;
      const keywordsMatch =
        operation.triggers?.keywords === undefined
        || canonicalContentHash(keywordObject ?? {})
          === canonicalContentHash(operation.triggers.keywords);
      const patternsMatch =
        operation.triggers?.patterns === undefined
        || canonicalContentHash(skill.triggers?.patterns ?? [])
          === canonicalContentHash(operation.triggers.patterns);
      return metaMatches && tagsMatch && keywordsMatch && patternsMatch;
    });
  }
  if (artifact.payload.payloadKind !== 'skill_note') return false;
  const delta = artifact.payload.skillNoteDelta;
  const skillId = delta.skillId ?? skill.name;
  const notes = snapshot.skillNotes.getSkillNotes(skillId);
  if (delta.kind === 'retire_skill_note' || delta.op === 'remove') {
    return !notes.some(note => note.id === delta.noteId);
  }
  return notes.some(note =>
    note.id === delta.noteId
    && note.evidenceSummary === delta.after!.content
    && canonicalContentHash(note.candidateKeywords)
      === canonicalContentHash(delta.after!.keywords));
}

function strategyOverlayAbsorbed(
  artifact: EvolutionOverlayArtifactV1,
  strategy: StrategyDefinition,
): boolean {
  if (artifact.payload.payloadKind !== 'strategy_delta') return false;
  const delta = artifact.payload.strategyDelta;
  if (delta.kind === 'phase_hint_delta') {
    const existing = strategy.phaseHints.find(hint => hint.id === delta.hintId);
    return delta.op === 'remove'
      ? existing === undefined
      : existing !== undefined
        && canonicalContentHash(existing) === canonicalContentHash(delta.after);
  }
  if (delta.kind === 'retire_phase_hint') {
    return !strategy.phaseHints.some(hint => hint.id === delta.hintId);
  }
  return delta.contribution.operations.every(operation => {
    if (operation.op === 'append_core') {
      return strategy.content.endsWith(operation.content);
    }
    if (operation.op === 'append_phase_hints') {
      return operation.hints.every(expected =>
        strategy.phaseHints.some(actual =>
          actual.id === expected.id
          && canonicalContentHash(actual) === canonicalContentHash(expected)));
    }
    return operation.sections.every(expected =>
      strategy.detailSections.some(actual =>
        actual.id === expected.id
        && canonicalContentHash(actual) === canonicalContentHash(expected)));
  });
}

function versionLessThan(current: string, required: string): boolean {
  const currentVersion = semver.coerce(current);
  const requiredVersion = semver.coerce(required);
  if (!currentVersion || !requiredVersion) return false;
  return semver.lt(currentVersion, requiredVersion);
}

function groupEntries<
  K extends 'baseRelation' | 'validationState' | 'activationState',
  V extends EvolutionOverlayRegistryEntryV1[K] & string,
>(
  entries: readonly EvolutionOverlayRegistryEntryV1[],
  key: K,
  values: readonly V[],
): Record<V, string[]> {
  return Object.fromEntries(values.map(value => [
    value,
    entries.filter(entry => entry[key] === value)
      .map(entry => entry.overlayId)
      .sort(),
  ])) as Record<V, string[]>;
}
