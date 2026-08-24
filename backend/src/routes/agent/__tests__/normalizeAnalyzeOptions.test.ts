// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  AnalyzeOptionsError,
  normalizeAnalyzeOptions,
} from '../normalizeAnalyzeOptions';

describe('normalizeAnalyzeOptions', () => {
  it.each([
    ['non-object options', 'bad', 'INVALID_ANALYZE_OPTIONS'],
    ['string codebaseIds', {codebaseIds: 'cb-1'}, 'INVALID_ANALYSIS_SOURCE_ALLOWLIST'],
    ['mixed knowledgeSourceIds', {knowledgeSourceIds: ['wiki-1', 42]}, 'INVALID_ANALYSIS_SOURCE_ALLOWLIST'],
    ['empty codebase id', {codebaseIds: ['cb-1', ' ']}, 'INVALID_ANALYSIS_SOURCE_ALLOWLIST'],
  ])('rejects %s instead of silently degrading to trace-only', (_label, value, code) => {
    expect(() => normalizeAnalyzeOptions(
      value,
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({code}));
  });

  it.each([
    ['area with string timestamp', {kind: 'area', startNs: '1', endNs: 2}],
    ['area with inverted range', {kind: 'area', startNs: 2, endNs: 1}],
    ['track event without event id', {kind: 'track_event', ts: 1}],
    ['unsupported kind', {kind: 'slice', eventId: 1, ts: 2}],
  ])('rejects invalid selection context: %s', (_label, selectionContext) => {
    expect(() => normalizeAnalyzeOptions(
      {selectionContext},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({code: 'INVALID_SELECTION_CONTEXT'}));
  });

  it('admits only bounded track identities for an area selection', () => {
    expect(normalizeAnalyzeOptions(
      {
        selectionContext: {
          kind: 'area',
          source: 'area_selection',
          startNs: 100,
          endNs: 200,
          tracks: [
            {
              uri: '/process_1/thread_2',
              utid: 2,
              upid: 1,
              cpu: 6,
              kind: 'thread_slice',
              threadName: 'untrusted-main',
              processName: 'untrusted-app',
              tid: 2002,
              pid: 1001,
            },
          ],
        },
      },
      {endpoint: '/analyze', hasReferenceTraceId: false},
    ).selectionContext).toEqual({
      kind: 'area',
      source: 'area_selection',
      startNs: 100,
      endNs: 200,
      tracks: [{
        uri: '/process_1/thread_2',
        utid: 2,
        upid: 1,
        cpu: 6,
        kind: 'thread_slice',
      }],
    });
  });

  it.each([
    ['missing uri', {utid: 1}],
    ['empty uri', {uri: ' '}],
    ['non-integer utid', {uri: '/thread', utid: '1'}],
    ['negative cpu', {uri: '/cpu', cpu: -1}],
  ])('rejects invalid area track identity: %s', (_label, track) => {
    expect(() => normalizeAnalyzeOptions(
      {
        selectionContext: {
          kind: 'area',
          startNs: 100,
          endNs: 200,
          tracks: [track],
        },
      },
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({code: 'INVALID_SELECTION_CONTEXT'}));
  });

  it('strips legacy frontend-resolved slice metadata before runtime admission', () => {
    expect(normalizeAnalyzeOptions(
      {
        selectionContext: {
          kind: 'track_event',
          source: 'track_event_selection',
          trackUri: '/process_1/thread_2',
          eventId: 42,
          ts: 1000,
          dur: 250,
          name: 'untrusted-name',
          threadName: 'untrusted-main',
          processName: 'untrusted-app',
          depth: 3,
          childCount: 4,
        },
      },
      {endpoint: '/analyze', hasReferenceTraceId: false},
    ).selectionContext).toEqual({
      kind: 'track_event',
      source: 'track_event_selection',
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
    });
  });

  it('accepts only canonical request output languages', () => {
    expect(normalizeAnalyzeOptions(
      {outputLanguage: 'en'},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toMatchObject({outputLanguage: 'en'});
    expect(normalizeAnalyzeOptions(
      {outputLanguage: 'zh-CN'},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toMatchObject({outputLanguage: 'zh-CN'});
    expect(() => normalizeAnalyzeOptions(
      {outputLanguage: 'fr'},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow('outputLanguage must be en or zh-CN');
  });

  it.each([
    ['neither', {}, 'auto', undefined, undefined, undefined],
    ['source metadata', {codeAwareMode: 'metadata_only', codebaseIds: ['app']}, 'full', 'metadata_only', ['app'], undefined],
    ['source provider send', {codeAwareMode: 'provider_send', codebaseIds: ['app']}, 'full', 'provider_send', ['app'], undefined],
    ['RAG only', {knowledgeSourceIds: ['wiki']}, 'full', undefined, undefined, ['wiki']],
    ['source plus RAG', {codeAwareMode: 'provider_send', codebaseIds: ['app'], knowledgeSourceIds: ['wiki']}, 'full', 'provider_send', ['app'], ['wiki']],
  ])('normalizes the Smart context matrix: %s', (
    _label,
    context,
    expectedMode,
    expectedCodeAwareMode,
    expectedCodebaseIds,
    expectedKnowledgeSourceIds,
  ) => {
    const normalized = normalizeAnalyzeOptions(
      {preset: 'smart', smartAction: 'analyze', ...context},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    );
    expect(normalized.analysisMode).toBe(expectedMode);
    expect(normalized.codeAwareMode).toEqual(expectedCodeAwareMode);
    expect(normalized.codebaseIds).toEqual(expectedCodebaseIds);
    expect(normalized.knowledgeSourceIds).toEqual(expectedKnowledgeSourceIds);
  });

  it('rejects unsupported analysis modes instead of changing execution strategy', () => {
    expect(() => normalizeAnalyzeOptions(
      {analysisMode: 'turbo'},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({code: 'UNSUPPORTED_ANALYSIS_MODE'}));
  });

  it.each([
    'maxRounds',
    'confidenceThreshold',
    'maxNoProgressRounds',
    'maxFailureRounds',
    'maxConcurrentTasks',
  ])('rejects the non-portable runtime control %s', field => {
    expect(() => normalizeAnalyzeOptions(
      {[field]: 1},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_RUNTIME_CONTROL',
      details: {field},
    }));
  });

  it('accepts smart preset on new analyze requests without comparison', () => {
    expect(normalizeAnalyzeOptions(
      { analysisMode: 'full', preset: 'smart' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'full',
      preset: 'smart',
      smartAction: 'preview',
    });
  });

  it('accepts smart analyze selection scopes', () => {
    expect(normalizeAnalyzeOptions(
      {
        preset: 'smart',
        smartAction: 'analyze',
        smartSelection: {
          scope: 'scene_types',
          sceneTypes: ['scroll', 'scroll', 'inertial_scroll'],
          label: '滑动',
          reportId: 'report-123',
          sceneSnapshotId: 'report-123',
        },
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'auto',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: {
        scope: 'scene_types',
        sceneTypes: ['scroll', 'inertial_scroll'],
        label: '滑动',
        reportId: 'report-123',
        sceneSnapshotId: 'report-123',
      },
    });
  });

  it('rejects conflicting Smart preview report aliases', () => {
    expect(() => normalizeAnalyzeOptions(
      {
        preset: 'smart',
        smartAction: 'analyze',
        smartSelection: {
          scope: 'all',
          reportId: 'report-current',
          sceneSnapshotId: 'report-stale',
        },
      },
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow(expect.objectContaining({code: 'INVALID_SMART_SELECTION'}));
  });

  it('preserves authorized knowledge sources for smart deep-dive requests', () => {
    expect(normalizeAnalyzeOptions(
      {
        preset: 'smart',
        smartAction: 'analyze',
        knowledgeSourceIds: ['wiki-a', 'wiki-a', 'wiki-b'],
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'full',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: { scope: 'all' },
      knowledgeSourceIds: ['wiki-a', 'wiki-b'],
    });
  });

  it('defaults smart analyze selection to all scenes', () => {
    expect(normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'analyze' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'auto',
      preset: 'smart',
      smartAction: 'analyze',
      smartSelection: { scope: 'all' },
    });
  });

  it('rejects smart preset with referenceTraceId', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart' },
      { endpoint: '/analyze', hasReferenceTraceId: true },
    )).toThrow(AnalyzeOptionsError);

    try {
      normalizeAnalyzeOptions(
        { preset: 'smart' },
        { endpoint: '/analyze', hasReferenceTraceId: true },
      );
    } catch (error: any) {
      expect(error.code).toBe('SMART_COMPARISON_UNSUPPORTED');
      expect(error.httpStatus).toBe(400);
    }
  });

  it('rejects smart preset on continuation run endpoint', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart' },
      { endpoint: '/sessions/:id/runs', hasReferenceTraceId: false },
    )).toThrow(/仅支持新会话/);
  });

  it('forces full analysis when explicit source context would be unavailable in fast mode', () => {
    expect(normalizeAnalyzeOptions(
      {
        analysisMode: 'fast',
        codeAwareMode: 'metadata_only',
        codebaseIds: ['a', 'a', 'b'],
        knowledgeSourceIds: ['wiki-a', 'wiki-a', 'wiki-b'],
      },
      { endpoint: '/sessions/:id/runs', hasReferenceTraceId: true },
    )).toEqual({
      analysisMode: 'full',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['a', 'b'],
      knowledgeSourceIds: ['wiki-a', 'wiki-b'],
    });
  });

  it('defaults an authorized codebase request to metadata-only at the HTTP boundary', () => {
    expect(normalizeAnalyzeOptions(
      {analysisMode: 'fast', codebaseIds: ['app-source']},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toEqual({
      analysisMode: 'full',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['app-source'],
    });
  });

  it('rejects invalid code-aware modes and oversized authorization allowlists', () => {
    expect(() => normalizeAnalyzeOptions(
      {codeAwareMode: 'send_everything', codebaseIds: ['app-source']},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow('Unsupported codeAwareMode');

    expect(() => normalizeAnalyzeOptions(
      {knowledgeSourceIds: Array.from({length: 33}, (_, index) => `wiki-${index}`)},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow('knowledgeSourceIds exceeds the maximum of 32');

    expect(() => normalizeAnalyzeOptions(
      {codeAwareMode: 'off', codebaseIds: ['app-source']},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    )).toThrow('codebaseIds require codeAwareMode');
  });

  it('forces auto source context and comparison requests onto full analysis', () => {
    expect(normalizeAnalyzeOptions(
      {analysisMode: 'auto', knowledgeSourceIds: ['wiki-a']},
      {endpoint: '/analyze', hasReferenceTraceId: false},
    ).analysisMode).toBe('full');
    expect(normalizeAnalyzeOptions(
      {analysisMode: 'auto'},
      {endpoint: '/analyze', hasReferenceTraceId: true, traceId: 'a', referenceTraceId: 'b'},
    ).analysisMode).toBe('full');
  });

  it('keeps fast mode when code-aware analysis is explicitly off without source ids', () => {
    expect(normalizeAnalyzeOptions(
      {
        analysisMode: 'fast',
        codeAwareMode: 'off',
      },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toEqual({
      analysisMode: 'fast',
      codeAwareMode: 'off',
    });
  });

  it('normalizes trace pair context only for comparison requests', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      activeSide: 'left',
      workspaceOpen: true,
      splitPercent: 67.8,
      maximizedTraceSide: 'other',
      minimizedTraceSides: ['reference', 'other', 'reference'],
      aliases: {
        '左侧': 'current',
        '右侧': 'reference',
        invalid: 'other',
      },
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'Current Trace',
          traceFingerprint: 'fingerprint-current',
          active: true,
          visualState: 'live',
          ignored: 'field',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'Reference Trace',
          visualState: 'context_only',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    ).tracePairContext).toBeUndefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      { endpoint: '/analyze', hasReferenceTraceId: true },
    ).tracePairContext).toEqual({
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      activeSide: 'left',
      workspaceOpen: true,
      splitPercent: 68,
      minimizedTraceSides: ['reference'],
      aliases: {
        '左侧': 'current',
        '右侧': 'reference',
      },
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'Current Trace',
          traceFingerprint: 'fingerprint-current',
          active: true,
          visualState: 'live',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'Reference Trace',
          visualState: 'context_only',
        },
      ],
    });
  });

  it('preserves same-page vertical dual-trace workspace state for comparison requests', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'vertical',
      primarySide: 'top',
      referenceSide: 'bottom',
      activeSide: 'bottom',
      workspaceOpen: true,
      splitPercent: 65.5,
      maximizedTraceSide: 'reference',
      minimizedTraceSides: ['current'],
      aliases: {
        top: 'current',
        bottom: 'reference',
        '上方': 'current',
        '下方': 'reference',
      },
      panes: [
        {
          side: 'top',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'current.trace',
          active: false,
          visualState: 'context_only',
        },
        {
          side: 'bottom',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'reference.trace',
          active: true,
          visualState: 'live',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toEqual({
      schemaVersion: 1,
      layout: 'vertical',
      primarySide: 'top',
      referenceSide: 'bottom',
      activeSide: 'bottom',
      workspaceOpen: true,
      splitPercent: 66,
      maximizedTraceSide: 'reference',
      minimizedTraceSides: ['current'],
      aliases: {
        top: 'current',
        bottom: 'reference',
        '上方': 'current',
        '下方': 'reference',
      },
      panes: [
        {
          side: 'top',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'current.trace',
          active: false,
          visualState: 'context_only',
        },
        {
          side: 'bottom',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'reference.trace',
          active: true,
          visualState: 'live',
        },
      ],
    });
  });

  it('drops trace pair context when pane identity does not match the requested traces', () => {
    const tracePairContext = {
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
        },
      ],
    };

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeDefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'stale-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeUndefined();

    expect(normalizeAnalyzeOptions(
      { tracePairContext },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'stale-reference',
      },
    ).tracePairContext).toBeUndefined();
  });

  it('drops trace pair context when pane sides do not match the declared layout', () => {
    expect(normalizeAnalyzeOptions(
      {
        tracePairContext: {
          schemaVersion: 1,
          layout: 'horizontal',
          primarySide: 'top',
          referenceSide: 'bottom',
          activeSide: 'top',
          panes: [
            {
              side: 'top',
              traceSide: 'current',
              traceId: 'trace-current',
            },
            {
              side: 'bottom',
              traceSide: 'reference',
              traceId: 'trace-reference',
            },
          ],
        },
      },
      {
        endpoint: '/analyze',
        hasReferenceTraceId: true,
        traceId: 'trace-current',
        referenceTraceId: 'trace-reference',
      },
    ).tracePairContext).toBeUndefined();
  });

  it('rejects unknown presets instead of passing them through', () => {
    expect(() => normalizeAnalyzeOptions(
      { preset: 'other' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/Unsupported analyze preset/);
  });

  it('rejects invalid smart action and selection payloads', () => {
    expect(() => normalizeAnalyzeOptions(
      { smartAction: 'preview' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/requires preset=smart/);

    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'deep' },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/Unsupported smartAction/);

    expect(() => normalizeAnalyzeOptions(
      { preset: 'smart', smartAction: 'analyze', smartSelection: { scope: 'scene_types' } },
      { endpoint: '/analyze', hasReferenceTraceId: false },
    )).toThrow(/sceneTypes is required/);
  });
});
