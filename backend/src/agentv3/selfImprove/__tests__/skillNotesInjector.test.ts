// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SkillNotesBudget,
  loadSkillNotes,
  FULL_PATH_TOTAL_TOKENS,
  FULL_PATH_PER_SKILL_TOKENS,
  QUICK_PATH_MAX_TOTAL_TOKENS,
  __testing,
} from '../skillNotesInjector';
import type { PersistedSkillNote } from '../skillNotesWriter';
import {
  assertEvaluationExposureMatchesContract,
  commitEvaluationExposureSince,
  createEvaluationRoleInjectionContract,
  sealEvaluationExposureReceipt,
  withEvaluationInjectionContext,
} from '../../../services/selfEvolution/evaluationInjectionContext';
import {
  createEvaluationTreatmentArtifact,
  evaluationSkillNoteInjectionContentHash,
  resolveEvaluationRoleVariant,
  withEvaluationRoleVariant,
} from '../../../services/selfEvolution/evaluationTreatment';
import {canonicalContentHash} from '../../../services/selfEvolution/canonicalJson';

const sampleNote: PersistedSkillNote = {
  id: 'note-1',
  failureCategory: 'misdiagnosis_vsync_vrr',
  evidenceSummary: 'frame 12 mistakenly flagged as jank because VRR boundary',
  candidateKeywords: ['vsync', 'vrr'],
  candidateConstraints: 'invoke vsync_dynamics_analysis first',
  candidateCriticalTools: ['vsync_dynamics_analysis'],
  createdAt: 1_700_000_000_000,
  cooldownUntil: 0,
  byteSize: 200,
};

describe('estimateTokens', () => {
  it('returns ceil(length/3)', () => {
    expect(__testing.estimateTokens('')).toBe(0);
    expect(__testing.estimateTokens('abc')).toBe(1);
    expect(__testing.estimateTokens('abcd')).toBe(2);
    expect(__testing.estimateTokens('a'.repeat(900))).toBe(300);
  });
});

describe('SkillNotesBudget — full path', () => {
  it('exposes the §8 caps', () => {
    const b = new SkillNotesBudget({ mode: 'full' });
    expect(b.totalCap).toBe(FULL_PATH_TOTAL_TOKENS);
    expect(b.perSkillCap).toBe(FULL_PATH_PER_SKILL_TOKENS);
  });

  it('accepts a single skill within budget', () => {
    const b = new SkillNotesBudget({ mode: 'full' });
    const out = b.tryConsume('s1', [sampleNote]);
    expect(out).not.toBeNull();
    expect(out!.text).toContain('Skill Notes');
    expect(out!.text).toContain('misdiagnosis_vsync_vrr');
    expect(out!.tokensUsed).toBeGreaterThan(0);
  });

  it('refuses re-injection of the same skill within one analysis', () => {
    const b = new SkillNotesBudget({ mode: 'full' });
    expect(b.tryConsume('s1', [sampleNote])).not.toBeNull();
    expect(b.tryConsume('s1', [sampleNote])).toBeNull();
    expect(b.snapshot().droppedReasons[0].reason).toBe('already_injected_this_analysis');
  });

  it('skips notes whose cooldownUntil is still in the future', () => {
    const future = Date.now() + 10_000;
    const cool = { ...sampleNote, cooldownUntil: future };
    const b = new SkillNotesBudget({ mode: 'full' });
    const out = b.tryConsume('s1', [cool]);
    expect(out).toBeNull();
    expect(b.snapshot().droppedReasons[0].reason).toBe('no_eligible_notes');
  });

  it('respects per-skill cap when notes are large', () => {
    const huge = { ...sampleNote, evidenceSummary: 'x'.repeat(2000) };
    const b = new SkillNotesBudget({ mode: 'full' });
    const out = b.tryConsume('s1', [huge]);
    expect(out).toBeNull();
    expect(b.snapshot().droppedReasons[0].reason).toBe('first_note_exceeds_per_skill_cap');
  });

  it('runs out of total budget after enough skills consume their share', () => {
    const b = new SkillNotesBudget({ mode: 'full' });
    let injected = 0;
    // 50 distinct skills × ~70 tokens each is comfortably past the 1500 cap.
    for (let i = 0; i < 50; i++) {
      const result = b.tryConsume(`s${i}`, [sampleNote]);
      if (result) injected += 1;
    }
    expect(injected).toBeGreaterThan(0);
    const snap = b.snapshot();
    expect(snap.totalUsed).toBeLessThanOrEqual(FULL_PATH_TOTAL_TOKENS);
    expect(snap.droppedReasons.some(d => d.reason === 'total_budget_exhausted')).toBe(true);
  });
});

describe('SkillNotesBudget — quick path', () => {
  it('default quick path budget is 0', () => {
    const b = new SkillNotesBudget({ mode: 'quick' });
    expect(b.totalCap).toBe(0);
    expect(b.tryConsume('s1', [sampleNote])).toBeNull();
    expect(b.snapshot().droppedReasons[0].reason).toBe('budget_disabled');
  });

  it('honors env override but caps at QUICK_PATH_MAX_TOTAL_TOKENS', () => {
    const b = new SkillNotesBudget({ mode: 'quick', quickOverrideTotal: 1_000_000 });
    expect(b.totalCap).toBe(QUICK_PATH_MAX_TOTAL_TOKENS);
  });

  it('clamps negative override to 0', () => {
    const b = new SkillNotesBudget({ mode: 'quick', quickOverrideTotal: -50 });
    expect(b.totalCap).toBe(0);
  });
});

describe('SkillNotesBudget — retry path', () => {
  it('correction retry never injects notes', () => {
    const b = new SkillNotesBudget({ mode: 'retry' });
    expect(b.totalCap).toBe(0);
    expect(b.tryConsume('s1', [sampleNote])).toBeNull();
  });
});

describe('loadSkillNotes', () => {
  let runtimeDir: string;
  let curatedDir: string;

  beforeEach(() => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-runtime-'));
    curatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-curated-'));
  });

  it('returns empty when no files exist', () => {
    expect(loadSkillNotes('s1', { runtimeDir, curatedDir })).toEqual([]);
  });

  it('merges curated and runtime notes, with curated entries first', () => {
    fs.writeFileSync(path.join(curatedDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [{ ...sampleNote, id: 'curated-1' }],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    fs.writeFileSync(path.join(runtimeDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [{ ...sampleNote, id: 'runtime-1' }],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    const merged = loadSkillNotes('s1', { runtimeDir, curatedDir });
    expect(merged.map(n => n.id)).toEqual(['curated-1', 'runtime-1']);
  });

  it('dedupes by note id when curated and runtime carry the same note', () => {
    const shared = { ...sampleNote, id: 'shared-1' };
    fs.writeFileSync(path.join(curatedDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [shared],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    fs.writeFileSync(path.join(runtimeDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [shared],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    const merged = loadSkillNotes('s1', { runtimeDir, curatedDir });
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('shared-1');
  });

  it('materializes and selects the candidate note before a newer ambient note', async () => {
    const evaluationNote = {
      schemaVersion: 1 as const,
      noteId: 'candidate-note',
      content: `candidate-priority-${'c'.repeat(320)}`,
      keywords: ['startup'],
    };
    const artifact = createEvaluationTreatmentArtifact({
      artifactId: 'candidate-a',
      sourceCandidateContentHash: canonicalContentHash('candidate-a'),
      scope: {tenantId: 'local', workspaceId: 'local'},
      baseSkillRegistryFingerprint: 'a'.repeat(64),
      baseStrategyRegistryFingerprint: 'b'.repeat(64),
      entries: [{
        kind: 'skill_note',
        op: 'add',
        skillId: 's1',
        noteId: evaluationNote.noteId,
        after: evaluationNote,
      }],
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const variant = resolveEvaluationRoleVariant({
      artifact,
      scope: artifact.scope,
      baseSkillRegistryFingerprint: artifact.baseSkillRegistryFingerprint,
      baseStrategyRegistryFingerprint:
        artifact.baseStrategyRegistryFingerprint,
    });
    const evaluationRef = {
      category: 'skillNotes' as const,
      id: evaluationNote.noteId,
      contentHash: evaluationSkillNoteInjectionContentHash(evaluationNote),
    };
    fs.writeFileSync(path.join(runtimeDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [{
        ...sampleNote,
        id: 'newer-ambient-note',
        evidenceSummary: `ambient-newer-${'a'.repeat(320)}`,
        createdAt: Date.parse('2026-07-30T00:00:00.000Z'),
      }],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    const contract = createEvaluationRoleInjectionContract({
      role: 'candidate',
      mode: 'on',
      selected: {
        patterns: [],
        skillNotes: [],
        cases: [],
        phaseHints: [],
        knowledgeDocs: [],
      },
      reservedTreatmentNamespace: [evaluationRef],
      expectedMaterializedRefs: [evaluationRef],
      expectedObservedRefs: [{
        ref: evaluationRef,
        minimumGuarantee: 'sdk_handoff_observed',
      }],
      forbiddenObservedRefs: [],
    });

    const receipt = await withEvaluationRoleVariant(variant, () =>
      withEvaluationInjectionContext({contract}, async () => {
        const candidates = loadSkillNotes('s1', {runtimeDir, curatedDir});
        const output = new SkillNotesBudget({mode: 'full'})
          .tryConsume('s1', candidates);
        expect(output?.text).toContain('candidate-priority');
        expect(output?.text).not.toContain('ambient-newer');
        commitEvaluationExposureSince(0, 'sdk_handoff_observed');
        return sealEvaluationExposureReceipt();
      }));

    expect(() => assertEvaluationExposureMatchesContract({
      contract,
      receipt,
    })).not.toThrow();
  });

  it('preserves non-semantic provenance when modifying a note', async () => {
    const existing: PersistedSkillNote = {
      ...sampleNote,
      sourceSessionId: 'source-session',
      sourceTurnIndex: 7,
      failureModeHash: 'f'.repeat(64),
    };
    fs.writeFileSync(path.join(runtimeDir, 's1.notes.json'), JSON.stringify({
      schemaVersion: 1,
      skillId: 's1',
      notes: [existing],
      lastUpdated: 0,
      totalBytes: 0,
    }));
    const replacement = {
      schemaVersion: 1 as const,
      noteId: existing.id,
      content: 'Replacement evaluation note.',
      keywords: ['replacement'],
    };
    const artifact = createEvaluationTreatmentArtifact({
      artifactId: 'candidate-modify',
      sourceCandidateContentHash:
        canonicalContentHash('candidate-modify'),
      scope: {tenantId: 'local', workspaceId: 'local'},
      baseSkillRegistryFingerprint: 'a'.repeat(64),
      baseStrategyRegistryFingerprint: 'b'.repeat(64),
      entries: [{
        kind: 'skill_note',
        op: 'modify',
        skillId: 's1',
        noteId: existing.id,
        beforeContentHash: __testing.skillNoteContentHash(existing),
        after: replacement,
      }],
      createdAt: '2026-07-29T00:00:00.000Z',
    });
    const variant = resolveEvaluationRoleVariant({
      artifact,
      scope: artifact.scope,
      baseSkillRegistryFingerprint: artifact.baseSkillRegistryFingerprint,
      baseStrategyRegistryFingerprint:
        artifact.baseStrategyRegistryFingerprint,
    });

    const [materialized] = await withEvaluationRoleVariant(
      variant,
      async () => loadSkillNotes('s1', {runtimeDir, curatedDir}),
    );
    expect(materialized).toMatchObject({
      id: existing.id,
      evidenceSummary: replacement.content,
      createdAt: existing.createdAt,
      cooldownUntil: existing.cooldownUntil,
      sourceSessionId: existing.sourceSessionId,
      sourceTurnIndex: existing.sourceTurnIndex,
    });
    expect(materialized.failureModeHash).toBeUndefined();
  });
});
