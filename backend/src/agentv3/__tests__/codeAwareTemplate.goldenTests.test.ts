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
  it.each(['zh', 'en'] as const)('loads the %s source-use guidance from assets', language => {
    const guidance = loadPromptTemplate(`prompt-source-use-${language}`) ?? '';
    expect(guidance).toContain(language === 'en' ? 'untrusted' : '不可信');
    expect(guidance).toContain('metadata_only');
    expect(guidance).toContain('provider_send');
    expect(guidance).toContain('source_authorization');
    expect(guidance).toContain('read_body');
    expect(guidance).toContain('traversal');
    // Source use is recorded from actual calls; no tool asks the model to declare it.
    expect(guidance).not.toContain('record_source_use_decision');
    expect(guidance).not.toContain('tool-description:start');
  });
  it.each(['zh', 'en'] as const)('explains provider-visible source binding IDs in the %s contract', language => {
    const contract = loadPromptTemplate(`prompt-code-reference-contract-${language}`) ?? '';
    for (const field of ['sourceReferences', 'result.sourceReferences', 'sourceClaimBindings', 'sourceReferenceIds',
      'traceEvidenceRefIds', 'claimId', 'search_hit', 'read_codebase_file']) expect(contract).toContain(field);
    // The product computes each source claim's standing; the model declares none.
    expect(contract).not.toContain('mechanismStatus');
    expect(contract).not.toContain('source.location');
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

      expect(active).toContain('## Source Use');
      expect(active).not.toContain('record_source_use_decision');
      expect(active).toContain('Trace evidence proves occurrence');
      expect(traceOnly).not.toContain('## Source Use');
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

    expect(active).toContain('## Source Use');
    expect(active).toContain('cb_quick');
    expect(active).toContain('CodeRef Location Contract');
    expect(active).toContain('Trace evidence proves occurrence');
    expect(active).toContain('untrusted');
    expect(off).not.toContain('## Source Use');
    expect(emptySelection).not.toContain('## Source Use');
  });

  it('gives Claude sub-agents source tools only with the source guidance and the same selection facts', () => {
    const allowedTools = [
      'mcp__smartperfetto__execute_sql',
      'mcp__smartperfetto__search_codebase',
      'mcp__smartperfetto__read_codebase_file',
    ];
    const toolDefinitions = [
      {name: 'execute_sql', exposure: 'public'},
      {name: 'search_codebase', exposure: 'requires_codebase_permission'},
      {name: 'read_codebase_file', exposure: 'requires_codebase_permission'},
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
      expect(agent.prompt).not.toContain('## Source Use');
    }
    for (const agent of Object.values(active)) {
      expect(agent.tools).toContain('mcp__smartperfetto__execute_sql');
      expect(agent.tools).toContain('mcp__smartperfetto__search_codebase');
      expect(agent.tools).toContain('mcp__smartperfetto__read_codebase_file');
      expect(agent.prompt).toContain('## Source Use');
      expect(agent.prompt).toContain('"context":"source_authorization"');
      expect(agent.prompt).toContain('cb_agent');
    }
  });

  describe('selected knowledge bases', () => {
    const collection = {id: 'eks_' + 'a'.repeat(24), displayName: 'Team render docs',
      description: 'Internal render framework notes', kind: 'document_collection' as const, activeIndex: true};
    const wiki = {id: 'eks_' + 'b'.repeat(24), displayName: 'Android Internals Wiki',
      kind: 'android_internals_wiki' as const, activeIndex: true};
    const knowledgeOnly = {codebases: [], knowledgeAuthorization: {knowledgeBases: [collection, wiki]}};
    const segment = (prompt: string, label: string) => {
      const start = prompt.indexOf(`{"context":"${label}"`);
      return start < 0 ? undefined : JSON.parse(prompt.slice(start, prompt.indexOf('\n', start) < 0
        ? undefined : prompt.indexOf('\n', start))).data;
    };

    it.each(['zh', 'en'] as const)('loads the %s knowledge-use guidance with its boundary', language => {
      const guidance = loadPromptTemplate(`prompt-knowledge-use-${language}`) ?? '';
      for (const term of ['knowledge_authorization', 'search_knowledge', 'read_knowledge_section', 'kref-',
        'traceEvidenceRefIds', 'existing_only', 'lookup_blog_knowledge']) expect(guidance).toContain(term);
    });

    it('adds a separate knowledge segment with source off and under existing_only, and none without a selection', () => {
      const context = typedContext({codeAwareMode: 'off', outputLanguage: 'en', sourceAuthorization: knowledgeOnly});
      context.turnIntent = {...context.turnIntent!, evidenceAccess: 'existing_only'};
      const prompt = buildSystemPrompt(context);
      expect(prompt).toContain('## Internal Knowledge Use');
      expect(segment(prompt, 'knowledge_authorization')).toEqual({knowledgeBases: [collection, wiki]});
      expect(segment(prompt, 'source_authorization')).toEqual({mode: 'off', evidenceAccess: 'existing_only', codebases: []});
      expect(prompt).not.toContain('## Source Use');
      const none = buildSystemPrompt(typedContext({codeAwareMode: 'off', outputLanguage: 'en'}));
      expect(none).not.toContain('## Internal Knowledge Use');
      expect(none).not.toContain('"context":"knowledge_authorization"');
    });

    it('gives Claude sub-agents the knowledge guidance and selection even with source off', () => {
      const agents = buildAgentDefinitions('general', {
        allowedTools: ['mcp__smartperfetto__execute_sql', 'mcp__smartperfetto__search_knowledge',
          'mcp__smartperfetto__read_knowledge_section'],
        toolDefinitions: [{name: 'execute_sql', exposure: 'public'}, {name: 'search_knowledge', exposure: 'public'},
          {name: 'read_knowledge_section', exposure: 'public'}],
        codeAwareMode: 'off',
        sourceAuthorization: knowledgeOnly,
        outputLanguage: 'en',
      } as any);
      for (const agent of Object.values(agents)) {
        expect(agent.tools).toContain('mcp__smartperfetto__search_knowledge');
        expect(agent.prompt).toContain('## Internal Knowledge Use');
        expect(agent.prompt).toContain('"context":"knowledge_authorization"');
        expect(agent.prompt).toContain(collection.id);
        expect(agent.prompt).toContain(wiki.id);
        expect(agent.prompt).not.toContain('## Source Use');
      }
      for (const agent of Object.values(buildAgentDefinitions('general', {allowedTools: [], toolDefinitions: []} as any))) {
        expect(agent.prompt).not.toContain('## Internal Knowledge Use');
      }
    });
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
