// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SelfEvolutionPersistenceCapability} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  createEvaluationTreatmentArtifact,
  EvaluationTreatmentArtifactStore,
  evaluationPhaseHintInjectionContentHash,
  evaluationRoleVariantRefs,
  evaluationSkillNoteInjectionContentHash,
  parseEvaluationTreatmentArtifact,
  resolveEvaluationRoleVariant,
} from '../evaluationTreatment';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/evaluation-treatment-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const scope = {tenantId: 'local', workspaceId: 'local'};

function artifact(content = 'Candidate note') {
  return createEvaluationTreatmentArtifact({
    artifactId: 'candidate-a',
    scope,
    baseSkillRegistryFingerprint: 'a'.repeat(64),
    baseStrategyRegistryFingerprint: 'b'.repeat(64),
    entries: [{
      kind: 'skill_note',
      op: 'add',
      skillId: 'startup_analysis',
      noteId: 'candidate-note',
      after: {
        schemaVersion: 1,
        noteId: 'candidate-note',
        content,
        keywords: ['startup'],
      },
    }],
    createdAt: '2026-07-29T00:00:00.000Z',
  });
}

describe('evaluation treatment artifacts', () => {
  it('stores content-addressed artifacts idempotently and rejects conflicts', () => {
    const store = new EvaluationTreatmentArtifactStore({
      persistence: persistenceUnavailable,
    });
    const first = artifact();
    expect(store.put(scope, first)).toEqual(first);
    expect(store.put(scope, first)).toEqual(first);
    expect(store.get(scope, first.artifactId)).toEqual(first);
    expect(() => store.put(scope, artifact('Changed note')))
      .toThrow('evaluation_treatment_artifact_conflict');
    store.close();
  });

  it('strictly rejects undeclared fields and resolves all role-specific inputs', () => {
    const value = artifact();
    expect(() => parseEvaluationTreatmentArtifact({
      ...value,
      undeclared: true,
    } as never)).toThrow('evaluation_treatment_artifact_unknown_field');
    expect(() => parseEvaluationTreatmentArtifact({
      ...value,
      entries: [{
        ...value.entries[0],
        undeclared: true,
      }],
    } as never)).toThrow('evaluation_treatment_entry_unknown_field');

    const variant = resolveEvaluationRoleVariant({
      artifact: value,
      scope,
      baseSkillRegistryFingerprint: value.baseSkillRegistryFingerprint,
      baseStrategyRegistryFingerprint:
        value.baseStrategyRegistryFingerprint,
    });
    expect(variant.skillNoteDeltas).toHaveLength(1);
    expect(variant.materializedInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.treatmentGeneration).toMatch(/^evaluation:/);
  });

  it('derives baseline-before and candidate-after refs without conflating mutation hashes', () => {
    const beforeHint = {
      id: 'startup-hint',
      keywords: ['startup'],
      constraints: 'Use the baseline startup constraint.',
      criticalTools: ['startup_analysis'],
      critical: true,
    };
    const afterHint = {
      ...beforeHint,
      constraints: 'Use the candidate startup constraint.',
    };
    const beforeNoteHash = 'c'.repeat(64);
    const afterNote = {
      schemaVersion: 1 as const,
      noteId: 'candidate-note',
      content: 'Candidate note replacement.',
      keywords: ['startup'],
    };
    const retiredInjectionHash = 'd'.repeat(64);
    const value = createEvaluationTreatmentArtifact({
      artifactId: 'candidate-before-after',
      scope,
      baseSkillRegistryFingerprint: 'a'.repeat(64),
      baseStrategyRegistryFingerprint: 'b'.repeat(64),
      entries: [
        {
          kind: 'phase_hint_delta',
          op: 'modify',
          scene: 'startup',
          hintId: beforeHint.id,
          beforeContentHash: canonicalContentHash(beforeHint),
          after: afterHint,
        },
        {
          kind: 'skill_note',
          op: 'modify',
          skillId: 'startup_analysis',
          noteId: afterNote.noteId,
          beforeContentHash: beforeNoteHash,
          after: afterNote,
        },
        {
          kind: 'retire_injection',
          category: 'patterns',
          id: 'legacy-pattern',
          contentHash: 'e'.repeat(64),
          injectionContentHash: retiredInjectionHash,
        },
      ],
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const variant = resolveEvaluationRoleVariant({
      artifact: value,
      scope,
      baseSkillRegistryFingerprint: value.baseSkillRegistryFingerprint,
      baseStrategyRegistryFingerprint:
        value.baseStrategyRegistryFingerprint,
    });
    const baseline = evaluationRoleVariantRefs({
      variant,
      role: 'baseline',
      resolveBaselinePhaseHint: () => beforeHint,
    });
    const candidate = evaluationRoleVariantRefs({
      variant,
      role: 'candidate',
      resolveBaselinePhaseHint: () => beforeHint,
    });

    expect(baseline.materializedRefs).toEqual(expect.arrayContaining([
      {
        category: 'phaseHints',
        id: beforeHint.id,
        contentHash: evaluationPhaseHintInjectionContentHash(beforeHint),
      },
      {
        category: 'skillNotes',
        id: afterNote.noteId,
        contentHash: beforeNoteHash,
      },
      {
        category: 'patterns',
        id: 'legacy-pattern',
        contentHash: retiredInjectionHash,
      },
    ]));
    expect(candidate.materializedRefs).toEqual(expect.arrayContaining([
      {
        category: 'phaseHints',
        id: afterHint.id,
        contentHash: evaluationPhaseHintInjectionContentHash(afterHint),
      },
      {
        category: 'skillNotes',
        id: afterNote.noteId,
        contentHash: evaluationSkillNoteInjectionContentHash(afterNote),
      },
    ]));
    expect(candidate.materializedRefs).not.toContainEqual({
      category: 'patterns',
      id: 'legacy-pattern',
      contentHash: retiredInjectionHash,
    });
    expect(baseline.treatmentNamespaceRefs)
      .toEqual(candidate.treatmentNamespaceRefs);
  });
});
