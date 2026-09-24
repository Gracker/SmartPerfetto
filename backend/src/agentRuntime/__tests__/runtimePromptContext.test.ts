// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import * as focusAppDetector from '../../agentv3/focusAppDetector';
import * as architectureDetector from '../../agent/detectors/architectureDetector';
import type {TracePairContext} from '../../agentv3/types';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import {
  buildQuickKnowledgeBaseContext,
  buildRuntimeTracePairComparisonContext,
  buildRuntimeTracePairIdentityContext,
  formatTraceContext,
} from '../runtimePromptContext';

describe('formatTraceContext', () => {
  it('labels explicit compatibility datasets without implying automatic UI pre-query', () => {
    const rendered = formatTraceContext([{
      label: 'Explicit dataset',
      columns: ['value'],
      rows: [[1]],
      evidenceRefId: 'data:frontend_prequery:legacy',
    }], 'en');

    expect(rendered).toContain('Request-provided Trace Data');
    expect(rendered).not.toContain('Frontend Pre-queried');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runtime dual-trace comparison context', () => {
  it('builds immutable pair identity without any trace or architecture probe', () => {
    const focus = jest.spyOn(focusAppDetector, 'detectFocusApps');
    const architecture = jest.spyOn(architectureDetector, 'createArchitectureDetector');
    const pair: TracePairContext = {
      schemaVersion: 1, layout: 'horizontal', primarySide: 'left', referenceSide: 'right',
      activeSide: 'left', workspaceOpen: true, splitPercent: 50,
      aliases: {left: 'current', right: 'reference'},
      panes: [{side: 'left', traceSide: 'current', traceId: 'a', visualState: 'live'}],
    };
    const context = buildRuntimeTracePairIdentityContext({referenceTraceId: 'b', tracePairContext: pair})!;
    expect(context).toMatchObject({referenceTraceId: 'b', commonCapabilities: [], capabilityProbeStatus: 'not_checked'});
    pair.aliases!.left = 'reference';
    pair.panes[0].traceId = 'changed';
    expect(context.tracePairContext?.aliases?.left).toBe('current');
    expect(context.tracePairContext?.panes[0].traceId).toBe('a');
    expect(Object.isFrozen(context.tracePairContext?.panes[0])).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(architecture).not.toHaveBeenCalled();
  });

  it.each(['returned_error', 'rejected', 'empty_success'] as const)('distinguishes %s capability evidence from an unperformed probe', async outcome => {
    jest.spyOn(focusAppDetector, 'detectFocusApps').mockResolvedValue({apps: [], method: 'none'});
    const query = jest.fn(async (traceId: string) => {
      if (traceId === 'b' && outcome === 'rejected') throw new Error('probe failed');
      return {columns: ['name'], rows: [], durationMs: 1,
        ...(traceId === 'b' && outcome === 'returned_error' ? {error: 'unavailable'} : {})};
    });
    const context = await buildRuntimeTracePairComparisonContext({
      currentTraceId: 'a', referenceTraceId: 'b',
      traceProcessorService: {query} as unknown as TraceProcessorService,
      detectReferenceArchitecture: async () => undefined,
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(context).toMatchObject({commonCapabilities: [],
      capabilityProbeStatus: outcome === 'empty_success' ? 'checked' : 'unavailable'});
    expect(context?.capabilityDiff).toBeUndefined();
  });

  it('keeps the reference package only for a confident inference and carries the candidates', async () => {
    const detect = jest.spyOn(focusAppDetector, 'detectFocusApps');
    jest.spyOn(architectureDetector, 'createArchitectureDetector').mockReturnValue({
      detect: jest.fn(async () => undefined),
    } as any);
    const traceProcessorService = {query: jest.fn(async () => ({columns: ['name'], rows: [], durationMs: 1}))} as any;
    detect.mockResolvedValueOnce({method: 'oom_adj', confidence: 'ambiguous', apps: [
      {packageName: 'com.example.a', totalDurationNs: 5, switchCount: 1, score: 25},
      {packageName: 'com.example.b', totalDurationNs: 4, switchCount: 1, score: 24},
    ]});
    const ambiguous = await buildRuntimeTracePairComparisonContext({traceProcessorService,
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'});
    expect(ambiguous?.referencePackageName).toBeUndefined();
    expect(ambiguous?.referenceFocusTarget).toMatchObject({source: 'none', confidence: 'ambiguous',
      candidates: [{packageName: 'com.example.a'}, {packageName: 'com.example.b'}]});

    detect.mockResolvedValueOnce({method: 'frame_timeline', confidence: 'high', primaryApp: 'com.example.reference',
      apps: [{packageName: 'com.example.reference', totalDurationNs: 1, switchCount: 100, score: 50}]});
    const confident = await buildRuntimeTracePairComparisonContext({traceProcessorService,
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference-2'});
    expect(confident?.referencePackageName).toBe('com.example.reference');
    expect(confident?.referenceFocusTarget).toMatchObject({source: 'auto_detected', confidence: 'high'});
  });

  it('keeps package, architecture, and disjoint capability differences deterministic', async () => {
    jest.spyOn(focusAppDetector, 'detectFocusApps').mockResolvedValue({
      apps: [],
      method: 'frame_timeline',
      primaryApp: 'com.example.reference',
    });
    jest.spyOn(architectureDetector, 'createArchitectureDetector').mockReturnValue({
      detect: jest.fn(async () => ({type: 'FLUTTER', confidence: 0.9, evidence: []})),
    } as any);
    const traceProcessorService = {
      query: jest.fn(async (traceId: string) => ({
        columns: ['name'],
        rows: traceId === 'trace-current'
          ? [['sched_slice'], ['android_current_only']]
          : [['linux_reference_only'], ['android_reference_only']],
        durationMs: 1,
      })),
    } as any;

    const context = await buildRuntimeTracePairComparisonContext({
      traceProcessorService,
      currentTraceId: 'trace-current',
      referenceTraceId: 'trace-reference',
    });

    expect(context).toEqual(expect.objectContaining({
      referenceTraceId: 'trace-reference',
      referencePackageName: 'com.example.reference',
      referenceArchitecture: expect.objectContaining({type: 'FLUTTER'}),
      commonCapabilities: [],
      capabilityProbeStatus: 'checked',
      capabilityDiff: {
        currentOnly: ['android_current_only', 'sched_slice'],
        referenceOnly: ['android_reference_only', 'linux_reference_only'],
      },
    }));
  });
});

describe('buildQuickKnowledgeBaseContext', () => {
  it('returns matched Perfetto SQL definitions for a targeted question', async () => {
    // Quick mode has no schema knowledge otherwise, which is what turns a
    // single-slice lookup into a string of exploratory queries.
    const context = await buildQuickKnowledgeBaseContext('主线程哪个 slice 耗时最多');
    expect(context && context.length).toBeGreaterThan(0);
  });

  it('returns undefined for an empty query instead of a stray section', async () => {
    await expect(buildQuickKnowledgeBaseContext('   ')).resolves.toBeUndefined();
  });
});
