// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  buildQuickConversationContext,
  buildQuickMemoryContext,
  buildQuickMemoryContextPayload,
  buildTraceContextDataEnvelopes,
  buildRuntimeSessionMapKey,
  collectRecentFindings,
  decorateTraceContextDatasets,
  formatTraceContext,
  isFreshRuntimeEntry,
  knowledgeScopeFromAnalysisOptions,
  providerScopeFromAnalysisOptions,
  setLruCacheEntry,
  toProtocolHypothesis,
  type RuntimeHypothesisSource,
} from '../runtimeCommon';

describe('runtimeCommon', () => {
  it('derives provider and knowledge scopes from shared analysis options', () => {
    const options = {
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      runId: 'run-1',
    };

    expect(providerScopeFromAnalysisOptions(options)).toEqual({
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
    });
    expect(knowledgeScopeFromAnalysisOptions(options)).toEqual({
      tenantId: 'tenant-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourceRunId: 'run-1',
    });
    expect(providerScopeFromAnalysisOptions({ tenantId: 'tenant-only' })).toBeUndefined();
    expect(knowledgeScopeFromAnalysisOptions({ workspaceId: 'workspace-only' })).toBeUndefined();
  });

  it('centralizes runtime session keys and freshness checks', () => {
    const now = 1_700_000_000_000;

    expect(buildRuntimeSessionMapKey('s1')).toBe('s1');
    expect(buildRuntimeSessionMapKey('s1', 'trace-b')).toBe('s1:ref:trace-b');
    expect(isFreshRuntimeEntry({ updatedAt: now - 10 }, 100, now)).toBe(true);
    expect(isFreshRuntimeEntry({ updatedAt: now - 101 }, 100, now)).toBe(false);
    expect(isFreshRuntimeEntry(undefined, 100, now)).toBe(false);
  });

  it('formats explicit request trace datasets once for both runtimes', () => {
    const datasets = decorateTraceContextDatasets([{
      label: 'Frame stats',
      columns: ['name', 'dur_ms'],
      rows: [
        ['doFrame', 16.7],
        ['binder', null],
      ],
      traceSide: 'reference',
      paneSide: 'right',
      traceId: 'trace-b',
    }], 'trace-a');
    const markdown = formatTraceContext(datasets, 'en');
    const envelopes = buildTraceContextDataEnvelopes(datasets, 'trace-a');

    expect(markdown).toContain('## Request-provided Trace Data');
    expect(markdown).toContain('### Frame stats');
    expect(markdown).toContain('evidence_ref_id: `data:frontend_prequery:reference:');
    expect(markdown).toContain('source_tool_call_id: `frontend-prequery:');
    expect(markdown).toContain('trace_side: `reference`');
    expect(markdown).toContain('pane_side: `right`');
    expect(markdown).toContain('| doFrame | 16.7 |');
    expect(markdown).toContain('| binder | - |');
    expect(datasets?.[0].paneSide).toBe('right');
    expect(envelopes[0].meta.traceSide).toBe('reference');
    expect(envelopes[0].meta.paneSide).toBe('right');
    expect(envelopes[0].meta.traceId).toBe('trace-b');
  });

  it('keeps runtime caches bounded with shared LRU semantics', () => {
    const cache = new Map<string, number>();
    setLruCacheEntry(cache, 'a', 1, 2);
    setLruCacheEntry(cache, 'b', 2, 2);
    setLruCacheEntry(cache, 'c', 3, 2);

    expect([...cache.keys()]).toEqual(['b', 'c']);
  });

  it('builds compact quick-mode local conversation context', () => {
    const context = buildQuickConversationContext([
      {
        id: 'turn-1',
        timestamp: 1,
        query: 'first',
        intent: {} as any,
        result: { message: 'old answer' } as any,
        findings: [],
        turnIndex: 0,
        completed: false,
      },
      {
        id: 'turn-2',
        timestamp: 2,
        query: '继续看上一轮',
        intent: {} as any,
        result: { message: '上一轮回答包含关键证据' } as any,
        findings: [{ title: '主线程阻塞', severity: 'high' } as any],
        turnIndex: 1,
        completed: true,
      },
    ], 'zh-CN');

    expect(context).toContain('## 最近对话上下文');
    expect(context).toContain('继续看上一轮');
    expect(context).toContain('[high] 主线程阻塞');
    expect(context).not.toContain('old answer');
  });

  it('builds compact quick-mode reusable memory context', () => {
    const context = buildQuickMemoryContext({
      recentSqlResultsContext: '## 最近 SQL 原始结果（resume 恢复）\n\nSQL Result 1',
      sqlErrorFixPairs: [
        {
          errorSql: 'SELECT * FROM missing_table',
          errorMessage: 'no such table: missing_table',
          fixedSql: 'SELECT * FROM slice LIMIT 1',
        },
      ],
      patternContext: '## 历史分析经验（跨会话记忆）\n\n类似 trace 先看调度',
      outputLanguage: 'zh-CN',
    });

    expect(context).toContain('## 快速模式可复用上下文');
    expect(context).toContain('最近 SQL 原始结果');
    expect(context).toContain('SQL 踩坑提示');
    expect(context).toContain('missing_table');
    expect(context).toContain('历史分析经验');
  });

  it('returns structured quick-mode memory counts without treating hints as evidence', () => {
    const payload = buildQuickMemoryContextPayload({
      recentSqlResultsContext: '## 最近 SQL 原始结果（resume 恢复）\n\nSQL Result 1\nSQL Result 2',
      sqlErrorFixPairs: [
        {
          errorSql: 'SELECT * FROM missing_table',
          errorMessage: 'no such table: missing_table',
          fixedSql: 'SELECT * FROM slice LIMIT 1',
        },
        {
          errorSql: 'SELECT bad',
          errorMessage: 'syntax error',
        },
      ],
      patternContext: '## 历史分析经验（跨会话记忆）\n\n类似 trace 先看调度',
      negativePatternContext: '## 反例提示\n\n不要把 idle 当根因',
      caseBackgroundContext: '## 案例背景\n\n类似案例',
      outputLanguage: 'zh-CN',
    });

    expect(payload.text).toContain('不能作为当前问题的证据');
    expect(payload.counts).toEqual({
      recentSqlResults: 2,
      sqlPitfallPairs: 1,
      patternHints: 1,
      negativePatternHints: 1,
      caseBackgroundCases: 1,
    });
    expect(payload.dropped).toContain('sqlPitfallPairs:1');
    expect(payload.tokenEstimate).toBeGreaterThan(0);
  });

  it('collects the most recent findings consistently', () => {
    const sessionContext = {
      getAllTurns: () => [
        { findings: [{ title: 'old' }] },
        { findings: [{ title: 'recent-1' }, { title: 'recent-2' }] },
      ],
    };

    expect(collectRecentFindings(sessionContext, { maxTurns: 1, maxFindings: 1 })).toEqual([
      { title: 'recent-2' },
    ]);
  });

  it.each<RuntimeHypothesisSource>([
    'claude',
    'openai',
    'pi-agent-core',
    'opencode',
  ])('maps confirmed runtime hypotheses into protocol provenance for %s', (source) => {
    const protocol = toProtocolHypothesis({
      id: 'h1',
      statement: 'Main thread is CPU-bound',
      status: 'confirmed',
      basis: 'running slices',
      evidence: 'art-1',
      formedAt: 10,
      resolvedAt: 20,
    }, source);

    expect(protocol.proposedBy).toBe(source);
    expect(protocol.relevantAgents).toEqual([source]);
    expect(protocol.supportingEvidence).toEqual([expect.objectContaining({
      source,
      description: 'art-1',
    })]);
    expect(protocol.contradictingEvidence).toEqual([]);
  });

  it('maps rejected runtime hypotheses into contradicting evidence only', () => {
    const protocol = toProtocolHypothesis({
      id: 'h2',
      statement: 'GPU is blocked',
      status: 'rejected',
      basis: 'counterexample',
      evidence: 'art-2',
      formedAt: 30,
      resolvedAt: 40,
    }, 'opencode');

    expect(protocol.supportingEvidence).toEqual([]);
    expect(protocol.contradictingEvidence).toEqual([expect.objectContaining({
      source: 'opencode',
      description: 'art-2',
    })]);
  });

  it('keeps a rejected original cause separate from a confirmed replacement cause', () => {
    const rejected = toProtocolHypothesis({
      id: 'h1',
      statement: 'Measure/layout traversal dominates the long frame',
      status: 'rejected',
      evidence: 'animation=59.31ms, traversal=1.49ms, layout=0.55ms',
      formedAt: 10,
      resolvedAt: 20,
    }, 'openai');
    const replacement = toProtocolHypothesis({
      id: 'h2',
      statement: 'Animation callback work dominates the long frame',
      status: 'confirmed',
      evidence: 'animation=59.31ms',
      formedAt: 21,
      resolvedAt: 22,
    }, 'openai');

    expect(rejected.supportingEvidence).toEqual([]);
    expect(rejected.contradictingEvidence).toEqual([
      expect.objectContaining({description: expect.stringContaining('traversal=1.49ms')}),
    ]);
    expect(replacement.supportingEvidence).toEqual([
      expect.objectContaining({description: 'animation=59.31ms'}),
    ]);
    expect(replacement.contradictingEvidence).toEqual([]);
  });

  it('does not turn formed hypothesis evidence into protocol evidence', () => {
    const protocol = toProtocolHypothesis({
      id: 'h3',
      statement: 'Binder is noisy',
      status: 'formed',
      basis: 'initial clue',
      evidence: 'not-yet-proven',
      formedAt: 50,
    }, 'pi-agent-core');

    expect(protocol.supportingEvidence).toEqual([]);
    expect(protocol.contradictingEvidence).toEqual([]);
    expect(protocol.updatedAt).toBe(50);
  });

  it('keeps concrete runtimes from reintroducing private hypothesis converters', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const privateConverterPattern = /\bfunction\s+toProtocolHypothesis\s*\(/;

    expect(fs.readFileSync(path.join(srcRoot, 'engines', 'pi', 'piAgentCoreRuntime.ts'), 'utf8'))
      .not.toMatch(privateConverterPattern);
    expect(fs.readFileSync(path.join(srcRoot, 'engines', 'opencode', 'openCodeRuntime.ts'), 'utf8'))
      .not.toMatch(privateConverterPattern);
  });

  it('keeps runtimeCommon as a compatibility barrel only', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const source = fs.readFileSync(path.join(srcRoot, 'runtimeCommon.ts'), 'utf8');
    const activeLines = source
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('//'));

    expect(activeLines).toEqual([
      "export * from './runtimeScopes';",
      "export * from './runtimeCache';",
      "export * from './runtimePromptContext';",
      "export * from './traceContextEvidence';",
      "export * from './quickBudget';",
      "export * from './runtimeEntities';",
      "export * from './runtimeHypothesis';",
      "export * from './runtimeSkillNotes';",
      "export * from './runtimeFinalReportRecovery';",
    ]);
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*(export\s+)?(function|const|class|interface|type)\s+/m);
  });

  it('keeps split runtime helper ownership aligned with module names', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const modules: Record<string, string> = {
      runtimeScopes: fs.readFileSync(path.join(srcRoot, 'runtimeScopes.ts'), 'utf8'),
      runtimeCache: fs.readFileSync(path.join(srcRoot, 'runtimeCache.ts'), 'utf8'),
      runtimePromptContext: fs.readFileSync(path.join(srcRoot, 'runtimePromptContext.ts'), 'utf8'),
      runtimeEntities: fs.readFileSync(path.join(srcRoot, 'runtimeEntities.ts'), 'utf8'),
      runtimeHypothesis: fs.readFileSync(path.join(srcRoot, 'runtimeHypothesis.ts'), 'utf8'),
      runtimeSkillNotes: fs.readFileSync(path.join(srcRoot, 'runtimeSkillNotes.ts'), 'utf8'),
    };
    const ownership: Record<string, readonly string[]> = {
      runtimeScopes: [
        'providerScopeFromAnalysisOptions',
        'knowledgeScopeFromAnalysisOptions',
      ],
      runtimeCache: [
        'SDK_SESSION_FRESHNESS_MS',
        'DEFAULT_RUNTIME_CACHE_LIMIT',
        'buildRuntimeSessionMapKey',
        'isFreshRuntimeEntry',
        'getLruCacheEntry',
        'setLruCacheEntry',
      ],
      runtimePromptContext: [
        'formatTraceContext',
        'buildQuickConversationContext',
        'buildQuickMemoryContext',
        'collectRecentFindings',
      ],
      runtimeEntities: [
        'buildEntityContext',
        'captureSkillDisplayEntities',
      ],
      runtimeHypothesis: [
        'RuntimeHypothesisSource',
        'toProtocolHypothesis',
      ],
      runtimeSkillNotes: [
        'createRuntimeSkillNotesBudget',
      ],
    };

    for (const [owner, symbols] of Object.entries(ownership)) {
      for (const symbol of symbols) {
        const containingModules = Object.entries(modules)
          .filter(([, source]) => source.includes(symbol))
          .map(([moduleName]) => moduleName);
        expect(containingModules).toEqual([owner]);
      }
    }
  });
});
