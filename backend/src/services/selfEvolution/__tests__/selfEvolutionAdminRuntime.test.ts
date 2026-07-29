// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  EvalCaseV1,
  RunManifestV1,
} from '../../../types/selfEvolution';
import {__testing} from '../selfEvolutionAdminRuntime';

describe('selfEvolutionAdminRuntime', () => {
  it('selects a deterministic bounded validation and holdout replay set', () => {
    const cases = [
      evalCase('validation-c', 'validation'),
      evalCase('validation-a', 'validation'),
      evalCase('validation-b', 'validation'),
      evalCase('validation-d', 'validation'),
      evalCase('holdout-b', 'holdout'),
      evalCase('holdout-a', 'holdout'),
      evalCase('holdout-c', 'holdout'),
      evalCase('other-scene', 'holdout', 'scrolling'),
    ];

    expect(
      __testing.selectPairedReplayCases(
        proposal(),
        sourceManifest(),
        cases,
      ).map(evalCase => evalCase.caseId),
    ).toEqual([
      'validation-a',
      'validation-b',
      'validation-c',
      'holdout-a',
      'holdout-b',
    ]);
  });

  it('fails closed when either fixed replay split is unavailable', () => {
    expect(() => __testing.selectPairedReplayCases(
      proposal(),
      sourceManifest(),
      [evalCase('validation-a', 'validation')],
    )).toThrow('paired_replay_cases_unavailable');
  });

  it('requires every evidence run to share the pinned replay environment', () => {
    const source = sourceManifest();
    expect(__testing.selectCompatibleEvidenceManifest(
      proposal(),
      [
        source,
        sourceManifest({runId: 'run-b'}),
      ],
    )).toBe(source);

    expect(() => __testing.selectCompatibleEvidenceManifest(
      proposal(),
      [
        source,
        sourceManifest({runId: 'run-b', model: 'model-b'}),
      ],
    )).toThrow(
      'paired_replay_source_manifest_environment_mismatch',
    );
    expect(() => __testing.selectCompatibleEvidenceManifest(
      proposal(),
      [
        source,
        sourceManifest({skillRegistryFingerprint: 'd'.repeat(64)}),
      ],
    )).toThrow('paired_replay_source_manifest_mismatch');
  });
});

function evalCase(
  caseId: string,
  split: EvalCaseV1['split'],
  expectedScene = 'startup',
): EvalCaseV1 {
  return {
    caseId,
    split,
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    expectedScene,
  } as EvalCaseV1;
}

function sourceManifest(
  overrides: Partial<RunManifestV1> = {},
): RunManifestV1 {
  return {
    runId: 'run-a',
    sceneType: 'startup',
    runtime: 'openai-agents-sdk',
    providerId: 'provider-a',
    model: 'model-a',
    outputLanguage: 'zh-CN',
    toolAllowlistHash: 'a'.repeat(64),
    injections: {
      patterns: [],
      skillNotes: [],
      cases: [],
      phaseHints: [],
      knowledgeDocs: [],
    },
    skillRegistryFingerprint: 'c'.repeat(64),
    evolutionOverlayGeneration: `builtin:${'c'.repeat(64)}`,
    ...overrides,
  } as RunManifestV1;
}

function proposal(): CurationProposalV1 {
  return {
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    expectedRegistryFingerprint: 'c'.repeat(64),
    expectedOverlayGeneration: `builtin:${'c'.repeat(64)}`,
  } as CurationProposalV1;
}
