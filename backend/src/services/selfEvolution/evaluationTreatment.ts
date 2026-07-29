// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {AsyncLocalStorage} from 'async_hooks';
import Database from 'better-sqlite3';

import type {
  PhaseHint,
  StrategyRegistryContribution,
} from '../../agentv3/strategyLoader';
import {userDataPath} from '../../runtimePaths';
import type {
  RunInjectionCategory,
  RunManifestScope,
  SelfEvolutionPersistenceCapability,
  SkillOverlayDeltaV1,
} from '../../types/selfEvolution';
import type {EvaluationInjectionRefV1} from './evaluationInjectionContext';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';

export interface EvaluationSkillNoteV1 {
  schemaVersion: 1;
  noteId: string;
  content: string;
  keywords: string[];
}

export type EvaluationTreatmentEntryV1 =
  | {
      kind: 'phase_hint_delta';
      op: 'add' | 'modify' | 'remove';
      scene: string;
      hintId: string;
      beforeContentHash?: string;
      after?: PhaseHint;
    }
  | {
      kind: 'skill_note';
      op: 'add' | 'modify' | 'remove';
      skillId: string;
      noteId: string;
      beforeContentHash?: string;
      after?: EvaluationSkillNoteV1;
    }
  | {
      kind: 'skill_overlay_delta';
      overlay: SkillOverlayDeltaV1;
    }
  | {
      kind: 'strategy_contribution';
      contribution: StrategyRegistryContribution;
    }
  | {
      kind: 'retire_injection';
      category: RunInjectionCategory;
      id: string;
      contentHash: string;
      injectionContentHash: string;
      scene?: string;
    };

export interface EvaluationTreatmentArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  sourceCandidateContentHash: string;
  scope: RunManifestScope;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
  entries: EvaluationTreatmentEntryV1[];
  createdAt: string;
  contentHash: string;
}

export interface EvaluationRoleVariantV1 {
  schemaVersion: 1;
  artifactId: string;
  sourceCandidateContentHash: string;
  treatmentArtifactContentHash: string;
  scope: RunManifestScope;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
  skillOverlays: SkillOverlayDeltaV1[];
  strategyContributions: StrategyRegistryContribution[];
  phaseHintDeltas: Array<Extract<
    EvaluationTreatmentEntryV1,
    {kind: 'phase_hint_delta'}
  >>;
  skillNoteDeltas: Array<Extract<
    EvaluationTreatmentEntryV1,
    {kind: 'skill_note'}
  >>;
  retiredInjections: Array<Extract<
    EvaluationTreatmentEntryV1,
    {kind: 'retire_injection'}
  >>;
  artifactCreatedAtMs: number;
  treatmentGeneration: string;
  materializedInputHash: string;
}

export interface EvaluationTreatmentStoreOptions {
  persistence: SelfEvolutionPersistenceCapability;
  databasePath?: string;
  openDatabase?: (databasePath: string) => Database.Database;
}

interface TreatmentRow {
  artifact_json: string;
}

const roleVariantContext = new AsyncLocalStorage<EvaluationRoleVariantV1>();

export function currentEvaluationRoleVariant():
EvaluationRoleVariantV1 | undefined {
  return roleVariantContext.getStore();
}

export async function withEvaluationRoleVariant<T>(
  variant: EvaluationRoleVariantV1,
  callback: () => Promise<T>,
): Promise<T> {
  return roleVariantContext.run(variant, callback);
}

export function evaluationPhaseHintInjectionContentHash(
  hint: Pick<PhaseHint, 'constraints' | 'criticalTools'>,
): string {
  return canonicalContentHash({
    constraints: hint.constraints,
    criticalTools: hint.criticalTools,
  });
}

export function evaluationSkillNoteInjectionContentHash(
  note: EvaluationSkillNoteV1,
): string {
  return canonicalContentHash({
    failureCategory: 'unknown',
    failureModeHash: null,
    evidenceSummary: note.content,
    candidateKeywords: note.keywords,
    candidateConstraints: '',
    candidateCriticalTools: [],
  });
}

export interface EvaluationRoleVariantRefsV1 {
  materializedRefs: EvaluationInjectionRefV1[];
  treatmentNamespaceRefs: EvaluationInjectionRefV1[];
}

export function evaluationFullTreatmentContractHash(
  variant: EvaluationRoleVariantV1,
): string {
  return canonicalContentHash({
    artifactId: variant.artifactId,
    sourceCandidateContentHash: variant.sourceCandidateContentHash,
    treatmentArtifactContentHash: variant.treatmentArtifactContentHash,
    scope: variant.scope,
    treatmentGeneration: variant.treatmentGeneration,
    materializedInputHash: variant.materializedInputHash,
  });
}

function normalizeInjectionRefs(
  refs: readonly EvaluationInjectionRefV1[],
): EvaluationInjectionRefV1[] {
  const unique = new Map(refs.map(ref => [
    `${ref.category}\0${ref.id}\0${ref.contentHash}`,
    ref,
  ]));
  return [...unique.values()].sort((left, right) =>
    left.category.localeCompare(right.category)
    || left.id.localeCompare(right.id)
    || left.contentHash.localeCompare(right.contentHash));
}

export function evaluationRoleVariantRefs(input: {
  variant: EvaluationRoleVariantV1;
  role: 'baseline' | 'candidate';
  resolveBaselinePhaseHint(
    scene: string,
    hintId: string,
  ): PhaseHint | undefined;
}): EvaluationRoleVariantRefsV1 {
  const materializedRefs: EvaluationInjectionRefV1[] = [];
  const treatmentNamespaceRefs: EvaluationInjectionRefV1[] = [];
  const addRef = (
    ref: EvaluationInjectionRefV1,
    materializedForRole: 'baseline' | 'candidate',
  ) => {
    treatmentNamespaceRefs.push(ref);
    if (input.role === materializedForRole) materializedRefs.push(ref);
  };
  const resolveBaselinePhaseHint = (
    scene: string,
    hintId: string,
    beforeContentHash: string,
  ): PhaseHint => {
    const hint = input.resolveBaselinePhaseHint(scene, hintId);
    if (
      !hint
      || canonicalContentHash(hint) !== beforeContentHash
    ) {
      throw new Error('evaluation_treatment_phase_hint_before_hash_mismatch');
    }
    return hint;
  };
  const {variant} = input;
  for (const delta of variant.phaseHintDeltas) {
    if (delta.op !== 'add') {
      const before = resolveBaselinePhaseHint(
        delta.scene,
        delta.hintId,
        delta.beforeContentHash!,
      );
      addRef({
        category: 'phaseHints',
        id: delta.hintId,
        contentHash: evaluationPhaseHintInjectionContentHash(before),
      }, 'baseline');
    }
    if (delta.after) {
      addRef({
        category: 'phaseHints',
        id: delta.hintId,
        contentHash: evaluationPhaseHintInjectionContentHash(delta.after),
      }, 'candidate');
    }
  }
  for (const delta of variant.skillNoteDeltas) {
    if (delta.op !== 'add') {
      addRef({
        category: 'skillNotes',
        id: delta.noteId,
        contentHash: delta.beforeContentHash!,
      }, 'baseline');
    }
    if (delta.after) {
      addRef({
        category: 'skillNotes',
        id: delta.noteId,
        contentHash: evaluationSkillNoteInjectionContentHash(delta.after),
      }, 'candidate');
    }
  }
  for (const contribution of variant.strategyContributions) {
    for (const operation of contribution.operations) {
      if (operation.op !== 'append_phase_hints') continue;
      for (const hint of operation.hints) {
        addRef({
          category: 'phaseHints',
          id: hint.id,
          contentHash: evaluationPhaseHintInjectionContentHash(hint),
        }, 'candidate');
      }
    }
  }
  for (const retired of variant.retiredInjections) {
    addRef({
      category: retired.category,
      id: retired.id,
      contentHash: retired.injectionContentHash,
    }, 'baseline');
  }
  return {
    materializedRefs: normalizeInjectionRefs(materializedRefs),
    treatmentNamespaceRefs: normalizeInjectionRefs(treatmentNamespaceRefs),
  };
}

function sameScope(left: RunManifestScope, right: RunManifestScope): boolean {
  return left.tenantId === right.tenantId
    && left.workspaceId === right.workspaceId;
}

function assertHash(value: unknown, error: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(error);
  }
  return value;
}

function nonempty(value: unknown, error: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(error);
  return value;
}

function exactKeys(
  value: object,
  allowed: readonly string[],
  error: string,
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(error);
  }
}

function normalizePhaseHint(value: unknown): PhaseHint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_treatment_phase_hint_invalid');
  }
  const hint = value as PhaseHint;
  if (
    Object.keys(hint).some(key =>
      !['id', 'keywords', 'constraints', 'criticalTools', 'critical'].includes(
        key,
      ))
    || !hint.id
    || !Array.isArray(hint.keywords)
    || !hint.keywords.every(keyword => typeof keyword === 'string')
    || typeof hint.constraints !== 'string'
    || !hint.constraints.trim()
    || !Array.isArray(hint.criticalTools)
    || !hint.criticalTools.every(tool => typeof tool === 'string')
    || typeof hint.critical !== 'boolean'
  ) {
    throw new Error('evaluation_treatment_phase_hint_invalid');
  }
  return immutableCanonicalSnapshot({
    id: hint.id,
    keywords: [...hint.keywords],
    constraints: hint.constraints,
    criticalTools: [...hint.criticalTools],
    critical: hint.critical,
  });
}

function normalizeSkillNote(value: unknown): EvaluationSkillNoteV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_treatment_skill_note_invalid');
  }
  const note = value as EvaluationSkillNoteV1;
  if (
    note.schemaVersion !== 1
    || Object.keys(note).some(
      key => !['schemaVersion', 'noteId', 'content', 'keywords'].includes(key),
    )
    || !note.noteId
    || !note.content?.trim()
    || !Array.isArray(note.keywords)
    || !note.keywords.every(keyword => typeof keyword === 'string')
  ) {
    throw new Error('evaluation_treatment_skill_note_invalid');
  }
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    noteId: note.noteId,
    content: note.content,
    keywords: [...note.keywords],
  });
}

function normalizeEntry(value: unknown): EvaluationTreatmentEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_treatment_entry_invalid');
  }
  const entry = value as EvaluationTreatmentEntryV1;
  if (entry.kind === 'phase_hint_delta') {
    exactKeys(
      entry,
      ['kind', 'op', 'scene', 'hintId', 'beforeContentHash', 'after'],
      'evaluation_treatment_entry_unknown_field',
    );
    if (!['add', 'modify', 'remove'].includes(entry.op)) {
      throw new Error('evaluation_treatment_phase_hint_op_invalid');
    }
    const scene = nonempty(
      entry.scene,
      'evaluation_treatment_phase_hint_scene_invalid',
    );
    const hintId = nonempty(
      entry.hintId,
      'evaluation_treatment_phase_hint_id_invalid',
    );
    if (entry.op === 'add') {
      if (entry.beforeContentHash !== undefined || entry.after === undefined) {
        throw new Error('evaluation_treatment_phase_hint_add_invalid');
      }
    } else if (
      entry.beforeContentHash === undefined
      || (entry.op === 'modify' && entry.after === undefined)
      || (entry.op === 'remove' && entry.after !== undefined)
    ) {
      throw new Error('evaluation_treatment_phase_hint_delta_invalid');
    }
    const after = entry.after === undefined
      ? undefined
      : normalizePhaseHint(entry.after);
    if (after && after.id !== hintId) {
      throw new Error('evaluation_treatment_phase_hint_id_mismatch');
    }
    return immutableCanonicalSnapshot({
      kind: 'phase_hint_delta',
      op: entry.op,
      scene,
      hintId,
      ...(entry.beforeContentHash === undefined
        ? {}
        : {
            beforeContentHash: assertHash(
              entry.beforeContentHash,
              'evaluation_treatment_phase_hint_before_hash_invalid',
            ),
          }),
      ...(after ? {after} : {}),
    });
  }
  if (entry.kind === 'skill_note') {
    exactKeys(
      entry,
      [
        'kind',
        'op',
        'skillId',
        'noteId',
        'beforeContentHash',
        'after',
      ],
      'evaluation_treatment_entry_unknown_field',
    );
    if (!['add', 'modify', 'remove'].includes(entry.op)) {
      throw new Error('evaluation_treatment_skill_note_op_invalid');
    }
    const noteId = nonempty(
      entry.noteId,
      'evaluation_treatment_skill_note_id_invalid',
    );
    const skillId = nonempty(
      entry.skillId,
      'evaluation_treatment_skill_id_invalid',
    );
    if (entry.op === 'add') {
      if (entry.beforeContentHash !== undefined || entry.after === undefined) {
        throw new Error('evaluation_treatment_skill_note_add_invalid');
      }
    } else if (
      entry.beforeContentHash === undefined
      || (entry.op === 'modify' && entry.after === undefined)
      || (entry.op === 'remove' && entry.after !== undefined)
    ) {
      throw new Error('evaluation_treatment_skill_note_delta_invalid');
    }
    const after = entry.after === undefined
      ? undefined
      : normalizeSkillNote(entry.after);
    if (after && after.noteId !== noteId) {
      throw new Error('evaluation_treatment_skill_note_id_mismatch');
    }
    return immutableCanonicalSnapshot({
      kind: 'skill_note',
      op: entry.op,
      skillId,
      noteId,
      ...(entry.beforeContentHash === undefined
        ? {}
        : {
            beforeContentHash: assertHash(
              entry.beforeContentHash,
              'evaluation_treatment_skill_note_before_hash_invalid',
            ),
          }),
      ...(after ? {after} : {}),
    });
  }
  if (entry.kind === 'skill_overlay_delta') {
    exactKeys(
      entry,
      ['kind', 'overlay'],
      'evaluation_treatment_entry_unknown_field',
    );
    if (!entry.overlay || entry.overlay.schemaVersion !== 1) {
      throw new Error('evaluation_treatment_skill_overlay_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'skill_overlay_delta',
      overlay: entry.overlay,
    });
  }
  if (entry.kind === 'strategy_contribution') {
    exactKeys(
      entry,
      ['kind', 'contribution'],
      'evaluation_treatment_entry_unknown_field',
    );
    if (!entry.contribution || !entry.contribution.contributionId) {
      throw new Error('evaluation_treatment_strategy_contribution_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'strategy_contribution',
      contribution: entry.contribution,
    });
  }
  if (entry.kind === 'retire_injection') {
    exactKeys(
      entry,
      [
        'kind',
        'category',
        'id',
        'contentHash',
        'injectionContentHash',
        'scene',
      ],
      'evaluation_treatment_entry_unknown_field',
    );
    if (
      ![
        'patterns',
        'skillNotes',
        'cases',
        'phaseHints',
        'knowledgeDocs',
      ].includes(entry.category)
    ) {
      throw new Error('evaluation_treatment_retire_category_invalid');
    }
    return immutableCanonicalSnapshot({
      kind: 'retire_injection',
      category: entry.category,
      id: nonempty(entry.id, 'evaluation_treatment_retire_id_invalid'),
      contentHash: assertHash(
        entry.contentHash,
        'evaluation_treatment_retire_hash_invalid',
      ),
      injectionContentHash: assertHash(
        entry.injectionContentHash,
        'evaluation_treatment_retire_injection_hash_invalid',
      ),
      ...(entry.scene
        ? {
            scene: nonempty(
              entry.scene,
              'evaluation_treatment_retire_scene_invalid',
            ),
          }
        : {}),
    });
  }
  throw new Error('evaluation_treatment_entry_kind_invalid');
}

function artifactHash(
  value: Omit<EvaluationTreatmentArtifactV1, 'contentHash'>,
): string {
  return canonicalContentHash(value);
}

export function createEvaluationTreatmentArtifact(input: Omit<
  EvaluationTreatmentArtifactV1,
  'schemaVersion' | 'contentHash'
>): EvaluationTreatmentArtifactV1 {
  if (!input.entries.length) throw new Error('evaluation_treatment_entries_empty');
  const entries = input.entries.map(normalizeEntry);
  const targetKeys = entries.flatMap(entry => {
    if (entry.kind === 'phase_hint_delta') {
      return [`phase_hint\0${entry.scene}\0${entry.hintId}`];
    }
    if (entry.kind === 'skill_note') {
      return [`skill_note\0${entry.skillId}\0${entry.noteId}`];
    }
    if (entry.kind === 'retire_injection') {
      return [`retire\0${entry.category}\0${entry.id}`];
    }
    return [];
  });
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new Error('evaluation_treatment_duplicate_target');
  }
  const createdAt = nonempty(
    input.createdAt,
    'evaluation_treatment_created_at_invalid',
  );
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('evaluation_treatment_created_at_invalid');
  }
  const withoutHash = immutableCanonicalSnapshot({
    schemaVersion: 1 as const,
    artifactId: nonempty(
      input.artifactId,
      'evaluation_treatment_artifact_id_invalid',
    ),
    sourceCandidateContentHash: assertHash(
      input.sourceCandidateContentHash,
      'evaluation_treatment_source_candidate_hash_invalid',
    ),
    scope: {
      tenantId: nonempty(
        input.scope.tenantId,
        'evaluation_treatment_tenant_invalid',
      ),
      workspaceId: nonempty(
        input.scope.workspaceId,
        'evaluation_treatment_workspace_invalid',
      ),
    },
    baseSkillRegistryFingerprint: assertHash(
      input.baseSkillRegistryFingerprint,
      'evaluation_treatment_base_skill_hash_invalid',
    ),
    baseStrategyRegistryFingerprint: assertHash(
      input.baseStrategyRegistryFingerprint,
      'evaluation_treatment_base_strategy_hash_invalid',
    ),
    entries,
    createdAt,
  });
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: artifactHash(withoutHash),
  });
}

export function parseEvaluationTreatmentArtifact(
  value: unknown,
): EvaluationTreatmentArtifactV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('evaluation_treatment_artifact_invalid');
  }
  const artifact = value as EvaluationTreatmentArtifactV1;
  exactKeys(
    artifact,
    [
      'schemaVersion',
      'artifactId',
      'sourceCandidateContentHash',
      'scope',
      'baseSkillRegistryFingerprint',
      'baseStrategyRegistryFingerprint',
      'entries',
      'createdAt',
      'contentHash',
    ],
    'evaluation_treatment_artifact_unknown_field',
  );
  const normalized = createEvaluationTreatmentArtifact({
    artifactId: artifact.artifactId,
    sourceCandidateContentHash: artifact.sourceCandidateContentHash,
    scope: artifact.scope,
    baseSkillRegistryFingerprint: artifact.baseSkillRegistryFingerprint,
    baseStrategyRegistryFingerprint: artifact.baseStrategyRegistryFingerprint,
    entries: artifact.entries,
    createdAt: artifact.createdAt,
  });
  if (artifact.schemaVersion !== 1 || artifact.contentHash !== normalized.contentHash) {
    throw new Error('evaluation_treatment_artifact_hash_mismatch');
  }
  return normalized;
}

export function resolveEvaluationRoleVariant(input: {
  artifact: EvaluationTreatmentArtifactV1;
  scope: RunManifestScope;
  baseSkillRegistryFingerprint: string;
  baseStrategyRegistryFingerprint: string;
}): EvaluationRoleVariantV1 {
  const artifact = parseEvaluationTreatmentArtifact(input.artifact);
  if (!sameScope(artifact.scope, input.scope)) {
    throw new Error('evaluation_treatment_scope_mismatch');
  }
  if (
    artifact.baseSkillRegistryFingerprint
      !== input.baseSkillRegistryFingerprint
    || artifact.baseStrategyRegistryFingerprint
      !== input.baseStrategyRegistryFingerprint
  ) {
    throw new Error('evaluation_treatment_base_fingerprint_mismatch');
  }
  const skillOverlays = artifact.entries.flatMap(entry =>
    entry.kind === 'skill_overlay_delta' ? [entry.overlay] : []);
  const strategyContributions = artifact.entries.flatMap(entry =>
    entry.kind === 'strategy_contribution' ? [entry.contribution] : []);
  const phaseHintDeltas = artifact.entries.flatMap(entry => {
    if (entry.kind === 'phase_hint_delta') return [entry];
    if (
      entry.kind === 'retire_injection'
      && entry.category === 'phaseHints'
      && entry.scene
    ) {
      return [{
        kind: 'phase_hint_delta' as const,
        op: 'remove' as const,
        scene: entry.scene,
        hintId: entry.id,
        beforeContentHash: entry.contentHash,
      }];
    }
    return [];
  });
  const skillNoteDeltas = artifact.entries.flatMap(entry =>
    entry.kind === 'skill_note' ? [entry] : []);
  const retiredInjections = artifact.entries.flatMap(entry =>
    entry.kind === 'retire_injection' ? [entry] : []);
  const artifactCreatedAtMs = Date.parse(artifact.createdAt);
  const materializedInputHash = canonicalContentHash({
    sourceCandidateContentHash: artifact.sourceCandidateContentHash,
    treatmentArtifactContentHash: artifact.contentHash,
    skillOverlays,
    strategyContributions,
    phaseHintDeltas,
    skillNoteDeltas,
    retiredInjections,
    artifactCreatedAtMs,
  });
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    sourceCandidateContentHash: artifact.sourceCandidateContentHash,
    treatmentArtifactContentHash: artifact.contentHash,
    scope: artifact.scope,
    baseSkillRegistryFingerprint: artifact.baseSkillRegistryFingerprint,
    baseStrategyRegistryFingerprint: artifact.baseStrategyRegistryFingerprint,
    skillOverlays,
    strategyContributions,
    phaseHintDeltas,
    skillNoteDeltas,
    retiredInjections,
    artifactCreatedAtMs,
    treatmentGeneration: `evaluation:${canonicalContentHash({
      artifactContentHash: artifact.contentHash,
      materializedInputHash,
    })}`,
    materializedInputHash,
  });
}

export class EvaluationTreatmentArtifactStore {
  private readonly persistence: SelfEvolutionPersistenceCapability;
  private readonly databasePath: string;
  private readonly openDatabase: NonNullable<
    EvaluationTreatmentStoreOptions['openDatabase']
  >;
  private readonly ephemeral = new Map<string, string>();
  private database: Database.Database | undefined;

  constructor(options: EvaluationTreatmentStoreOptions) {
    this.persistence = options.persistence;
    this.databasePath = options.databasePath
      ?? userDataPath('self_improve', 'eval.db');
    this.openDatabase = options.openDatabase
      ?? (databasePath => new Database(databasePath));
  }

  put(
    scope: RunManifestScope,
    value: EvaluationTreatmentArtifactV1,
  ): EvaluationTreatmentArtifactV1 {
    const artifact = parseEvaluationTreatmentArtifact(value);
    if (!sameScope(scope, artifact.scope)) {
      throw new Error('evaluation_treatment_scope_mismatch');
    }
    const payload = canonicalJsonString(artifact);
    if (this.persistence.persistence === 'available') {
      const existing = this.db().prepare(`
        SELECT artifact_json
        FROM evaluation_treatment_artifacts
        WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ?
      `).get(scope.tenantId, scope.workspaceId, artifact.artifactId) as
        | TreatmentRow
        | undefined;
      if (existing) {
        const stored = parseEvaluationTreatmentArtifact(
          JSON.parse(existing.artifact_json),
        );
        if (stored.contentHash !== artifact.contentHash) {
          throw new Error('evaluation_treatment_artifact_conflict');
        }
        return stored;
      }
      this.db().prepare(`
        INSERT INTO evaluation_treatment_artifacts (
          tenant_id,
          workspace_id,
          artifact_id,
          content_hash,
          artifact_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.workspaceId,
        artifact.artifactId,
        artifact.contentHash,
        payload,
      );
      return artifact;
    }
    const key = `${scope.tenantId}\0${scope.workspaceId}\0${artifact.artifactId}`;
    const existing = this.ephemeral.get(key);
    if (existing) {
      const stored = parseEvaluationTreatmentArtifact(JSON.parse(existing));
      if (stored.contentHash !== artifact.contentHash) {
        throw new Error('evaluation_treatment_artifact_conflict');
      }
      return stored;
    }
    this.ephemeral.set(key, payload);
    return artifact;
  }

  get(
    scope: RunManifestScope,
    artifactId: string,
  ): EvaluationTreatmentArtifactV1 | undefined {
    if (this.persistence.persistence === 'available') {
      const row = this.db().prepare(`
        SELECT artifact_json
        FROM evaluation_treatment_artifacts
        WHERE tenant_id = ? AND workspace_id = ? AND artifact_id = ?
      `).get(scope.tenantId, scope.workspaceId, artifactId) as
        | TreatmentRow
        | undefined;
      return row
        ? parseEvaluationTreatmentArtifact(JSON.parse(row.artifact_json))
        : undefined;
    }
    const payload = this.ephemeral.get(
      `${scope.tenantId}\0${scope.workspaceId}\0${artifactId}`,
    );
    return payload
      ? parseEvaluationTreatmentArtifact(JSON.parse(payload))
      : undefined;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private db(): Database.Database {
    if (this.database) return this.database;
    fs.mkdirSync(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    this.database = this.openDatabase(this.databasePath);
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('journal_mode = WAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_treatment_artifacts (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, artifact_id)
      );
    `);
    return this.database;
  }
}
