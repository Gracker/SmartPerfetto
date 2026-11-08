// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildQuickSystemPrompt, buildSystemPromptParts, estimatePromptTokens, MAX_PROMPT_TOKENS} from '../claudeSystemPrompt';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../strategyLoader';
import type {ClaudeAnalysisContext} from '../types';

const table = [
  'evidence_ref_id=data:fixture:table',
  '| phase | duration_ms | share_pct |',
  '| --- | ---: | ---: |',
  '| phase_alpha | 42.5 | 70 |',
  '| phase_beta | 18.25 | 30 |',
].join('\n');

describe('real quick prompt context assembly', () => {
  it.each(['zh-CN', 'en'] as const)('guides typed %s answers and reports toward evidence-backed tables in quick and full modes', outputLanguage => {
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'final-table-presentation-test',
    });
    for (const deliverable of ['answer', 'report'] as const) {
      for (const recommendedComplexity of ['quick', 'full'] as const) {
        const context: ClaudeAnalysisContext = {
          query: 'Compare startup stage timings.', outputLanguage, strategyRegistry: registry,
          turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'startup',
            taskKind: 'comparison', scope: 'bounded_question', recommendedComplexity, deliverable,
            evidenceAccess: 'existing_only', registryFingerprint: registry.registryFingerprint},
          comparison: {referenceTraceId: 'trace-reference', commonCapabilities: []},
        };
        const parts = buildSystemPromptParts(context);
        const policy = parts.segments.find(segment => segment.label === 'turn_protocol')!;
        expect(policy).toMatchObject({droppable: false, truncatable: false});
        expect(policy.content).toContain('prefer a compact Markdown table');
        expect(policy.content).toContain('user-requested formats take precedence');
        expect(policy.content).toContain('presentation does not require more queries or a broader report');
        expect(policy.content).toContain('Derived differences/percentages retain their operands');
        expect(policy.content).toContain('from a zero or missing baseline');
        expect(policy.content).toContain('Mark rounded table values as approximate');
        // The answer carries no model-authored declaration to keep exact.
        expect(policy.content).not.toContain('declaration references');
        expect(parts.fullPrompt).toContain('trace-reference');
        expect(parts.fullPrompt).toContain('existing_only');
        // The prompt no longer asks for a conclusion declaration.
        expect(parts.fullPrompt).not.toContain('conclusion_contract_v1');
        expect(buildQuickSystemPrompt(context)).toBe(parts.fullPrompt);
      }
    }
  });

  it('renders supplied table rows, units and references without relying on fixed guidance wording', () => {
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'supplied-table-test',
    });
    const prompt = buildQuickSystemPrompt({
      strategyRegistry: registry,
      turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'general',
        taskKind: 'fact', scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer',
        evidenceAccess: 'existing_only', registryFingerprint: registry.registryFingerprint},
      outputLanguage: 'en', runtimeEvidenceContext: table,
      quickMemoryContext: 'HISTORY_CONTEXT_CANARY', knowledgeBaseContext: 'SCHEMA_CONTEXT_CANARY',
      packageName: 'com.fixture.prompt',
    });
    expect(prompt).toContain(JSON.stringify(table));
    expect(prompt).toContain('HISTORY_CONTEXT_CANARY');
    expect(prompt).toContain('SCHEMA_CONTEXT_CANARY');
    expect(prompt).toContain('com.fixture.prompt');
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('preserves the same table and selection through the shared typed quick/full presentation contract', () => {
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: getRegisteredScenes(), overlayGeneration: 'prompt-table-context-test',
    });
    const context: ClaudeAnalysisContext & {runtimeEvidenceContext: string} = {
      query: 'Compare the supplied rows.', strategyRegistry: registry, outputLanguage: 'en',
      runtimeEvidenceContext: table, selectionContext: {kind: 'area', startNs: 12, endNs: 42},
      turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'general',
        taskKind: 'fact', scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer',
        evidenceAccess: 'existing_only', registryFingerprint: registry.registryFingerprint},
    };
    const parts = buildSystemPromptParts(context);
    expect(JSON.parse(parts.segments.find(segment => segment.label === 'runtime_evidence')!.content).data).toBe(table);
    expect(JSON.parse(parts.segments.find(segment => segment.label === 'selection_context')!.content).data)
      .toEqual(context.selectionContext);
    expect(parts.truncatedLabels).not.toContain('runtime_evidence');
    expect(parts.droppedLabels).not.toContain('runtime_evidence');
    expect(parts.segments.some(segment => segment.label === 'report_requirements')).toBe(false);
    expect(buildQuickSystemPrompt(context)).toBe(parts.fullPrompt);
    expect(buildQuickSystemPrompt({...context, turnIntent: {...context.turnIntent!, recommendedComplexity: 'full'}}))
      .toBe(parts.fullPrompt);
    expect(parts.fullPrompt).not.toMatch(/\{\{\w+\}\}/);
    expect(estimatePromptTokens(parts.fullPrompt)).toBeLessThanOrEqual(MAX_PROMPT_TOKENS);
  });
});
