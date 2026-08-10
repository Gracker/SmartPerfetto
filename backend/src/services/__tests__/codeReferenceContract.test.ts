// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisPlanV3} from '../../agentv3/types';
import {
  completeFinalReportCodeReferences,
  hasConcreteCodeReference,
} from '../codebase/codeReferenceContract';
import {
  extractSourceLookupCodeReferences,
  rememberSourceLookupCodeReferences,
  sourceLookupResultHasCodeReferences,
} from '../codebase/sourceLookupTools';

describe('codeReferenceContract', () => {
  it.each([
    'app/src/main/java/demo/StartupHooks.kt:L10-L20',
    'StartupHooks.kt:L10-L20',
    'filePath: app/src/main/java/demo/StartupHooks.kt, lineRange: 10-20',
    'filePath: StartupHooks.kt, lineRange: 10-20',
    '{"filePath":"app/src/main/java/demo/StartupHooks.kt","lineRange":{"start":10,"end":20}}',
    'filePath: app/src/main/java/demo/StartupHooks.kt, chunkId: chunk-1, 行号不可用',
    'filePath = app/src/main/java/demo/StartupHooks.kt; chunkId = chunk-1; line number unavailable',
  ])('accepts a locatable source reference: %s', reference => {
    expect(hasConcreteCodeReference(reference)).toBe(true);
  });

  it.each([
    'StartupHooks.kt',
    'chunkId: chunk-1',
    'evidence_ref_id: evidence-1',
    'source_ref: source-1',
    'lookup_app_source(StartupHooks)',
    'filePath: app/src/main/java/demo/StartupHooks.kt',
    'filePath: app/src/main/java/demo/StartupHooks.kt, chunkId: chunk-1',
    'filePath and lineRange are required',
  ])('rejects a non-locatable source mention: %s', reference => {
    expect(hasConcreteCodeReference(reference)).toBe(false);
  });

  it('extracts only safe, locatable references from nested source lookup results', () => {
    const references = extractSourceLookupCodeReferences('lookup_app_source', {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result: {
            hits: [
              {
                chunkId: 'chunk-1',
                codebaseId: 'codebase-a',
                metadata: {
                  filePath: './StartupHooks.kt',
                  lineRange: {start: 10, end: 20},
                },
              },
              {
                chunkId: 'chunk-absolute',
                metadata: {filePath: '/Users/demo/Secret.kt', lineRange: {start: 1, end: 2}},
              },
              {
                chunkId: 'chunk-traversal',
                filePath: '../outside/Secret.kt',
                lineRange: {start: 1, end: 2},
              },
            ],
          },
        }),
      }],
    });

    expect(references).toEqual([{
      chunkId: 'chunk-1',
      codebaseId: 'codebase-a',
      filePath: 'StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    }]);
    expect(extractSourceLookupCodeReferences('execute_sql', {
      chunkId: 'chunk-1',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
    })).toEqual([]);
  });

  it('extracts bounded on-demand source references without requiring indexed chunks', () => {
    expect(extractSourceLookupCodeReferences('search_codebase', {
      success: true,
      matches: [{
        referenceId: 'source-a1b2c3',
        codebaseId: 'codebase-a',
        filePath: './app/src/main/java/demo/StartupHooks.kt',
        lineRange: {start: 12, end: 12},
        text: 'private source text',
      }],
    })).toEqual([{
      referenceId: 'source-a1b2c3',
      codebaseId: 'codebase-a',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 12, end: 12},
    }]);

    expect(extractSourceLookupCodeReferences('read_codebase_file', {
      success: true,
      reference: {
        referenceId: 'source-d4e5f6',
        filePath: '../outside/Secret.kt',
        lineRange: {start: 1, end: 2},
      },
    })).toEqual([]);
  });

  it('does not treat graph references as final source CodeRef evidence', () => {
    const graphResult = {
      success: true,
      references: [
        {
          referenceId: 'graph-ref-a',
          codebaseId: 'codebase-a',
          filePath: 'src/Main.kt',
          lineRange: {start: 1, end: 2},
          symbol: 'Main',
          kind: 'class',
        },
        {
          referenceId: 'graph-ref-a',
          codebaseId: 'codebase-b',
          filePath: 'src/Main.kt',
          lineRange: {start: 1, end: 2},
          symbol: 'Main',
          kind: 'class',
        },
      ],
    };

    expect(extractSourceLookupCodeReferences('query_code_graph', graphResult)).toEqual([]);
    expect(sourceLookupResultHasCodeReferences('inspect_code_symbol', graphResult)).toBe(false);
  });

  it('deterministically completes a missing final CodeRef from ephemeral source metadata', () => {
    const plan: AnalysisPlanV3 = {
      phases: [],
      successCriteria: 'Explain startup latency',
      submittedAt: 1,
      toolCallLog: [{
        toolName: 'lookup_app_source',
        timestamp: 2,
        success: true,
        returnedCodeReferences: true,
      }],
    };
    rememberSourceLookupCodeReferences(plan, [{
      chunkId: 'chunk-1',
      codebaseId: 'codebase-a',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    }, {
      chunkId: 'chunk-1',
      codebaseId: 'codebase-b',
      filePath: 'app/src/main/java/demo/StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    }]);

    const completed = completeFinalReportCodeReferences({
      plan,
      conclusion: '## 最终结论\n启动路径存在候选机制。',
      outputLanguage: 'zh-CN',
    });

    expect(completed).toContain('app/src/main/java/demo/StartupHooks.kt:L10-L20');
    expect(completed).toContain('codebaseId: codebase-a');
    expect(completed).toContain('codebaseId: codebase-b');
    expect(completed).toContain('是否发生仍以 Trace 证据为准');
    expect(completed).not.toContain('chunk-1');
    expect(completeFinalReportCodeReferences({
      plan,
      conclusion: completed,
      outputLanguage: 'zh-CN',
    })).toBe(completed);
  });
});
