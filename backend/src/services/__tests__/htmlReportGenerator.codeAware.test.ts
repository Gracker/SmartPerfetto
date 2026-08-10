// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {HTMLReportGenerator, type AgentDrivenReportData} from '../htmlReportGenerator';

function makeReportData(contract: unknown): AgentDrivenReportData {
  return {
    traceId: 'trace-code-aware',
    query: 'why slow',
    result: {
      sessionId: 'session-code-aware',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: 'Root cause references CodeRef only.',
      conclusionContract: contract,
      confidence: 0.8,
      rounds: 1,
      totalDurationMs: 100,
    },
    hypotheses: [],
    dialogue: [],
    timestamp: 1714600000000,
  };
}

describe('HTMLReportGenerator code-aware rendering', () => {
  it('renders CodeRef and patchStatus without raw source or sketch diff text', () => {
    const html = new HTMLReportGenerator().generateAgentDrivenHTML(makeReportData({
      codeReferences: [{
        chunkId: 'chunk-main',
        codebaseId: 'cb_app',
        filePath: 'app/src/Main.kt',
        lineRange: {start: 10, end: 12},
        symbol: 'MainActivity.onCreate',
      }],
      patchProposals: [{
        patchProposalId: 'patch-1',
        patchStatus: 'sketch',
        rationale: 'Move heavy initialization out of startup.',
        diff: 'diff --git a/app/src/Main.kt b/app/src/Main.kt\n-secret\n+secret',
      }],
    }));

    expect(html).toContain('代码引用与 Patch');
    expect(html).toContain('chunk-main');
    expect(html).toContain('app/src/Main.kt:10-12');
    expect(html).toContain('patch-status sketch');
    expect(html).toContain('Move heavy initialization');
    expect(html).not.toContain('-secret');
    expect(html).not.toContain('+secret');
  });

  it('renders Pack provenance as background instead of trace evidence', () => {
    const data = makeReportData({});
    data.backgroundKnowledgeReferences = [{
      sourceKind: 'android_internals_pack',
      packVersion: '2026.07.18.1',
      packFingerprint: 'b'.repeat(64),
      sourceRevision: 'a'.repeat(40),
      articleId: 'article-1',
      articleTitle: 'Binder 线程池',
      sectionId: 'section-1',
      sectionHeading: '线程池饱和',
      chunkId: 'chunk-1',
      chunkHash: 'c'.repeat(64),
      license: 'CC-BY-NC-SA-4.0 OR LicenseRef-AIW-Commercial',
    }];

    const html = new HTMLReportGenerator().generateAgentDrivenHTML(data);

    expect(html).toContain('Android Internals 背景引用');
    expect(html).toContain('Binder 线程池');
    expect(html).toContain('2026.07.18.1');
    expect(html).toContain('不能替代当前 Trace 的 SQL/Skill 证据');
    expect(html).not.toContain('chunk-1</code></li>');
  });

  it('renders selected and actually used source context without roots or snippets', () => {
    const data = makeReportData({});
    data.sourceContext = {
      selected: [{
        codebaseId: 'codebase-app-1234567890',
        displayName: 'Demo App',
        kind: 'app_source',
      }, {
        codebaseId: 'codebase-kernel-1234567890',
        displayName: 'Kernel Source',
        kind: 'kernel_source',
      }],
      usedCodebaseIds: ['codebase-app-1234567890'],
    };

    const html = new HTMLReportGenerator().generateAgentDrivenHTML(data);

    expect(html).toContain('源码上下文');
    expect(html).toContain('已选择');
    expect(html).toContain('实际使用/查询到');
    expect(html).toContain('Demo App');
    expect(html).toContain('Kernel Source');
    expect(html).toContain('codebase-app');
    expect(html).toContain('源码/图查询只定位候选机制');
    expect(html).not.toContain('/Users/chris');
    expect(html).not.toContain('raw source text');
  });

  it('leaves legacy reports without source context unchanged', () => {
    const html = new HTMLReportGenerator().generateAgentDrivenHTML(makeReportData({}));

    expect(html).not.toContain('源码上下文');
    expect(html).not.toContain('Source Context');
  });
});
