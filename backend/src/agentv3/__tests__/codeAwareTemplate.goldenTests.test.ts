// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import type {ClaudeAnalysisContext} from '../types';

import {buildAgentDefinitions} from '../../agentRuntime/engines/claude/claudeAgentDefinitions';
import {buildQuickSystemPrompt, buildSystemPrompt} from '../claudeSystemPrompt';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes, loadPromptTemplate} from '../strategyLoader';

const registry = buildStrategyRegistrySnapshotFromDefinitions({
  definitions: getRegisteredScenes(), overlayGeneration: 'source-prompt-golden-test',
});
function typedContext(overrides: Partial<ClaudeAnalysisContext> = {}): ClaudeAnalysisContext {
  return {query: 'Explain the observed work.', strategyRegistry: registry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation',
      sceneId: overrides.sceneType ?? 'general', scope: 'scene_wide', recommendedComplexity: 'full',
      deliverable: 'report', evidenceAccess: 'read_new', registryFingerprint: registry.registryFingerprint},
    ...overrides};
}

describe('typed source contract golden rules', () => {
  it.each(['zh', 'en'] as const)('loads the %s source-use decision contract from assets', language => {
    const contract = loadPromptTemplate(`prompt-source-use-decision-${language}`) ?? '';
    expect(contract.match(/<!-- tool-description:start -->/g) ?? []).toHaveLength(1);
    expect(contract.match(/<!-- tool-description:end -->/g) ?? []).toHaveLength(1);
    const compactDescription = contract
      .split('<!-- tool-description:start -->')[1]
      ?.split('<!-- tool-description:end -->')[0]
      ?.trim() ?? '';
    expect(compactDescription.length).toBeGreaterThan(0);
    expect(compactDescription.length).toBeLessThanOrEqual(240);
    expect(contract).toContain('untrusted');
    expect(contract).toContain('metadata_only');
    expect(contract).toContain('provider_send');
    expect(contract).toContain('record_source_use_decision');
    expect(contract).toContain('not_needed');
    expect(contract).toContain('disallowed');
    expect(contract).toContain('no_queryable_anchor');
    expect(contract).toContain('ambiguous_candidates');
    expect(contract).toContain('not_found_complete');
    expect(contract).toContain('search_incomplete');
    expect(contract).toContain('unverified');
    expect(contract).toContain('reason>=30');
    expect(contract).toContain('contradictory=reject');
  });

  it.each(['zh', 'en'] as const)('explains provider-visible source binding IDs in the %s contract', language => {
    const contract = loadPromptTemplate(`prompt-code-reference-contract-${language}`) ?? '';
    for (const field of ['sourceReferences', 'result.sourceReferences', 'sourceClaimBindings', 'sourceReferenceIds',
      'traceEvidenceRefIds', 'claimId', 'mechanismStatus']) expect(contract).toContain(field);
    expect(contract).toContain('compatible');
  });

  it.each(getRegisteredScenes().map(definition => [definition.scene]))(
    'injects source contracts for discovered Full scene %s and excludes them in trace-only mode',
    scene => {
      const active = buildSystemPrompt(typedContext({
        query: 'analyze',
        sceneType: scene,
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb_app', 'cb_kernel'],
        outputLanguage: 'en',
      }));
      const traceOnly = buildSystemPrompt(typedContext({
        query: 'analyze',
        sceneType: scene,
        codeAwareMode: 'off',
        codebaseIds: ['cb_app', 'cb_kernel'],
        outputLanguage: 'en',
      }));

      expect(active).toContain('Source Use Decision Contract');
      expect(active).toContain('record_source_use_decision');
      expect(active).toContain('Trace evidence proves occurrence');
      expect(traceOnly).not.toContain('Source Use Decision Contract');
      expect(traceOnly).not.toContain('record_source_use_decision');
      expect(traceOnly).not.toContain('Trace evidence proves occurrence');
    },
  );

  it('makes Quick/Conversation source-aware only for an active selected codebase', () => {
    const active = buildQuickSystemPrompt(typedContext({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb_quick'],
      outputLanguage: 'en',
    }));
    const off = buildQuickSystemPrompt(typedContext({
      codeAwareMode: 'off',
      codebaseIds: ['cb_quick'],
      outputLanguage: 'en',
    }));
    const emptySelection = buildQuickSystemPrompt(typedContext({
      codeAwareMode: 'provider_send',
      codebaseIds: [],
      outputLanguage: 'en',
    }));

    expect(active).toContain('Source Use Decision Contract');
    expect(active).toContain('cb_quick');
    expect(active).toContain('CodeRef Location Contract');
    expect(active).toContain('Trace evidence proves occurrence');
    expect(active).toContain('untrusted');
    expect(off).not.toContain('Source Use Decision Contract');
    expect(emptySelection).not.toContain('Source Use Decision Contract');
  });

  it('gives Claude sub-agents source tools only with the same loaded contract and always excludes control tools', () => {
    const allowedTools = [
      'mcp__smartperfetto__execute_sql',
      'mcp__smartperfetto__search_codebase',
      'mcp__smartperfetto__read_codebase_file',
      'mcp__smartperfetto__record_source_use_decision',
    ];
    const toolDefinitions = [
      {name: 'execute_sql', exposure: 'public', planCapability: 'evidence'},
      {name: 'search_codebase', exposure: 'requires_codebase_permission', planCapability: 'evidence'},
      {name: 'read_codebase_file', exposure: 'requires_codebase_permission', planCapability: 'evidence'},
      {name: 'record_source_use_decision', exposure: 'requires_codebase_permission', planCapability: 'control'},
    ];
    const inactive = buildAgentDefinitions('general', {allowedTools, toolDefinitions} as any);
    const active = buildAgentDefinitions('general', {
      allowedTools,
      toolDefinitions,
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb_agent'],
      outputLanguage: 'en',
    } as any);

    for (const agent of Object.values(inactive)) {
      expect(agent.tools).toContain('mcp__smartperfetto__execute_sql');
      expect(agent.tools).not.toContain('mcp__smartperfetto__search_codebase');
      expect(agent.tools).not.toContain('mcp__smartperfetto__read_codebase_file');
      expect(agent.tools).not.toContain('mcp__smartperfetto__record_source_use_decision');
      expect(agent.prompt).not.toContain('Source Use Decision Contract');
    }
    for (const agent of Object.values(active)) {
      expect(agent.tools).toContain('mcp__smartperfetto__execute_sql');
      expect(agent.tools).toContain('mcp__smartperfetto__search_codebase');
      expect(agent.tools).toContain('mcp__smartperfetto__read_codebase_file');
      expect(agent.tools).not.toContain('mcp__smartperfetto__record_source_use_decision');
      expect(agent.prompt).toContain('Source Use Decision Contract');
      expect(agent.prompt).toContain('cb_agent');
    }
  });

  it('requires successful source lookups to remain locatable in the final report', () => {
    const contract = loadPromptTemplate('prompt-code-reference-contract-zh') ?? '';
    expect(contract).toContain('成功返回源码 CodeRef');
    expect(contract).toContain('search_codebase');
    expect(contract).toContain('read_codebase_file');
    // One citable id; the internal referenceId is not shown to the model.
    expect(contract).toContain('`id`/`chunkId`');
    expect(contract).not.toContain('referenceId');
    expect(contract).toContain('relative/path/File.kt:L10-L20');
    expect(contract).toContain('不能只写文件名');
    expect(contract).toContain('不得编造行号');
  });

  it.each(['zh-CN', 'en'] as const)('preserves source navigation and version authority in %s prompts', outputLanguage => {
    const prompt = buildSystemPrompt(typedContext({outputLanguage, codeAwareMode: 'provider_send',
      codebaseIds: ['cb_app', 'cb_kernel']}));
    for (const fact of ['metadata_only', 'provider_send', 'search_codebase', 'read_codebase_file']) {
      expect(prompt).toContain(fact);
    }
    if (outputLanguage === 'en') {
      expect(prompt).toContain('Graph/index results are navigation, not evidence of this run');
      expect(prompt).toContain('never merge implementations across repositories');
      expect(prompt).toContain('build/commit');
    } else {
      expect(prompt).toContain('图谱');
      expect(prompt).toContain('build/commit');
    }
  });

  it('preserves patch authority and validation limits in the live patch tool asset', () => {
    const patch = loadPromptTemplate('prompt-propose-patch-tool-description');
    expect(patch).toContain('result.hits[].chunkId');
    expect(patch).toContain('context_chunk_ids');
    expect(patch).toContain('reference IDs and public-pack hits cannot authorize patches');
    expect(patch).toContain('verified only means git apply --check passed');
    expect(patch).toContain('not applied, compiled, tested or correct');
    expect(patch).toContain('sketch is non-copyable');
    expect(patch).toContain('unverified is rejection');
  });

});
