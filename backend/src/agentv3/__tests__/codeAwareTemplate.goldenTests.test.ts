// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {buildAgentDefinitions} from '../../agentRuntime/engines/claude/claudeAgentDefinitions';
import {buildQuickSystemPrompt, buildSystemPrompt} from '../claudeSystemPrompt';
import {getRegisteredScenes, loadPromptTemplate, renderTemplate} from '../strategyLoader';

describe('code-aware.template golden rules', () => {
  const rendered = renderTemplate(loadPromptTemplate('code-aware') ?? '', {
    codeAwareMode: 'metadata_only',
    codebaseIds: 'cb_app, cb_kernel',
  });

  it('locks the source lookup order and domain split', () => {
    expect(rendered).toContain('search_codebase');
    expect(rendered).toContain('不要求预先建立索引');
    expect(rendered).toContain('read_codebase_file');
    expect(rendered).toContain('query_code_graph');
    expect(rendered).toContain('inspect_code_symbol');
    expect(rendered).toContain('可选加速器');
    expect(rendered).toContain('freshness="stale"');
    expect(rendered).toContain('resolve_symbol');
    expect(rendered).toContain('lookup_app_source');
    expect(rendered).toContain('lookup_aosp_source');
    expect(rendered).toContain('lookup_kernel_source');
    expect(rendered).toContain('inspect_code_symbol` 的 `referenceId` 不授予 patch 能力');
    expect(rendered).toContain('包名/进程');
    expect(rendered).toContain('线程/slice');
    expect(rendered).toContain('symbol/class/method');
    expect(rendered).toContain('路径/文件');
    expect(rendered).toContain('App');
    expect(rendered).toContain('AOSP/framework');
    expect(rendered).toContain('kernel/vendor');
    expect(rendered).toContain('多个 codebase');
    expect(rendered).toContain('先 Trace');
  });

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

  it.each(getRegisteredScenes().map(definition => [definition.scene]))(
    'injects source contracts for discovered Full scene %s and excludes them in trace-only mode',
    scene => {
      const active = buildSystemPrompt({
        query: 'analyze',
        sceneType: scene,
        codeAwareMode: 'metadata_only',
        codebaseIds: ['cb_app', 'cb_kernel'],
        outputLanguage: 'en',
      });
      const traceOnly = buildSystemPrompt({
        query: 'analyze',
        sceneType: scene,
        codeAwareMode: 'off',
        codebaseIds: ['cb_app', 'cb_kernel'],
        outputLanguage: 'en',
      });

      expect(active).toContain('Source Use Decision Contract');
      expect(active).toContain('record_source_use_decision');
      expect(active).toContain('Trace evidence proves occurrence');
      expect(traceOnly).not.toContain('Source Use Decision Contract');
      expect(traceOnly).not.toContain('record_source_use_decision');
      expect(traceOnly).not.toContain('Trace evidence proves occurrence');
    },
  );

  it('makes Quick/Conversation source-aware only for an active selected codebase', () => {
    const active = buildQuickSystemPrompt({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb_quick'],
      outputLanguage: 'en',
    } as any);
    const off = buildQuickSystemPrompt({
      codeAwareMode: 'off',
      codebaseIds: ['cb_quick'],
      outputLanguage: 'en',
    } as any);
    const emptySelection = buildQuickSystemPrompt({
      codeAwareMode: 'provider_send',
      codebaseIds: [],
      outputLanguage: 'en',
    } as any);

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

  it('locks degraded and metadata-only output discipline', () => {
    expect(rendered).toContain('metadata_only');
    expect(rendered).toContain('provider_send_disabled_for_session');
    expect(rendered).toContain('GitNexus 结果只能作为导航提示');
    expect(rendered).toContain('不能单独当作 trace 真相');
    expect(rendered).toContain('symbol_only_low_confidence');
    expect(rendered).toContain('不能生成 patch');
  });

  it('requires successful source lookups to remain locatable in the final report', () => {
    const contract = loadPromptTemplate('prompt-code-reference-contract-zh') ?? '';
    expect(contract).toContain('成功返回源码 CodeRef');
    expect(contract).toContain('search_codebase');
    expect(contract).toContain('read_codebase_file');
    expect(contract).toContain('referenceId');
    expect(contract).toContain('relative/path/File.kt:L10-L20');
    expect(contract).toContain('不能只写文件名');
    expect(contract).toContain('不得编造行号');
  });

  it('locks patchStatus output discipline', () => {
    expect(rendered).toContain('patchStatus="verified"');
    expect(rendered).toContain('patchStatus="sketch"');
    expect(rendered).toContain('patchStatus="unverified"');
    expect(rendered).toContain('不能输出 unified diff');
    expect(rendered).toContain('multi_codebase_not_supported_phase1');
  });

  it('keeps legacy Plan 44/54/55 recall out of code evidence', () => {
    expect(rendered).toContain('recall_project_memory');
    expect(rendered).toContain('recall_similar_case');
    expect(rendered).toContain('legacy `lookup_blog_knowledge`');
    expect(rendered).toContain('不等同于用户代码证据');
  });
});
