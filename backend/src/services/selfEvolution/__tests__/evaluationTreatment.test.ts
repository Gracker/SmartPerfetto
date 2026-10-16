// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SelfEvolutionPersistenceCapability} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  createEvaluationTreatmentArtifact,
  EvaluationTreatmentArtifactStore,
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
    sourceCandidateContentHash: canonicalContentHash('candidate-a'),
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
  it('refuses phase-hint entries, which no analysis reads, when created or read back', () => {
    const inertEntries = [
      {
        kind: 'phase_hint_delta',
        op: 'add',
        scene: 'scrolling',
        hintId: 'legacy-hint',
        after: {
          id: 'legacy-hint',
          keywords: ['architecture'],
          constraints: 'One bounded tool call.',
          criticalTools: [],
          critical: false,
        },
      },
      {
        kind: 'retire_injection',
        category: 'phaseHints',
        id: 'legacy-hint',
        contentHash: 'e'.repeat(64),
        injectionContentHash: 'e'.repeat(64),
        scene: 'scrolling',
      },
      {
        kind: 'strategy_contribution',
        contribution: {
          contributionId: 'legacy-contribution',
          scope,
          scene: 'scrolling',
          baseStrategyFingerprint: 'f'.repeat(64),
          createdAt: '2026-09-02T00:00:00.000Z',
          operations: [{
            op: 'append_phase_hints',
            operationId: 'legacy-op',
            hints: [],
          }],
        },
      },
    ];
    for (const entry of inertEntries) {
      expect(() => createEvaluationTreatmentArtifact({
        artifactId: `inert-${entry.kind}`,
        sourceCandidateContentHash: canonicalContentHash(entry.kind),
        scope,
        baseSkillRegistryFingerprint: 'a'.repeat(64),
        baseStrategyRegistryFingerprint: 'b'.repeat(64),
        entries: [entry],
        createdAt: '2026-09-02T00:00:00.000Z',
      } as never)).toThrow('evaluation_treatment_inert_injection_target');
      expect(() => parseEvaluationTreatmentArtifact({
        ...artifact(),
        entries: [entry],
      })).toThrow('evaluation_treatment_inert_injection_target');
    }
  });

  it('keeps the materialized input hash of artifacts gated before phase hints were removed', () => {
    const value = artifact();
    const variant = resolveEvaluationRoleVariant({
      artifact: value,
      scope,
      baseSkillRegistryFingerprint: value.baseSkillRegistryFingerprint,
      baseStrategyRegistryFingerprint: value.baseStrategyRegistryFingerprint,
    });
    // A gated proposal's paired-replay proof binds this exact layout.
    expect(variant.materializedInputHash).toBe(canonicalContentHash({
      sourceCandidateContentHash: value.sourceCandidateContentHash,
      treatmentArtifactContentHash: value.contentHash,
      skillOverlays: [],
      strategyContributions: [],
      phaseHintDeltas: [],
      skillNoteDeltas: variant.skillNoteDeltas,
      retiredInjections: [],
      artifactCreatedAtMs: Date.parse(value.createdAt),
    }));
  });

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
      sourceCandidateContentHash:
        canonicalContentHash('candidate-before-after'),
      scope,
      baseSkillRegistryFingerprint: 'a'.repeat(64),
      baseStrategyRegistryFingerprint: 'b'.repeat(64),
      entries: [
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
    });
    const candidate = evaluationRoleVariantRefs({
      variant,
      role: 'candidate',
    });

    expect(baseline.materializedRefs).toEqual(expect.arrayContaining([
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
