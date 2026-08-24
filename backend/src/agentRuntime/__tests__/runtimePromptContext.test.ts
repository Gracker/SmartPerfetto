// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import * as focusAppDetector from '../../agentv3/focusAppDetector';
import * as architectureDetector from '../../agent/detectors/architectureDetector';
import {
  buildRuntimeTracePairComparisonContext,
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
      capabilityDiff: {
        currentOnly: ['android_current_only', 'sched_slice'],
        referenceOnly: ['android_reference_only', 'linux_reference_only'],
      },
    }));
  });
});
