// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSnapshot,
} from '../../../types/multiTraceComparison';
import { buildTraceSimilaritySignature } from '../traceSimilaritySignature';
import {NO_PRIVATE_CONTEXT} from '../../security/analysisPrivateContext';

function snapshot(overrides: Partial<AnalysisResultSnapshot> = {}): AnalysisResultSnapshot {
  return {
    id: 'snapshot-a',
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: 'trace-a',
    sessionId: 'session-a',
    runId: 'run-a',
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType: 'scrolling',
    title: 'Scrolling analysis',
    userQuery: 'why scrolling janks',
    traceLabel: 'trace-a',
    traceMetadata: {
      appPackage: 'com.example.app',
      processName: 'com.example.app:ui',
      deviceModel: 'Pixel 9',
      androidVersion: '16',
      buildFingerprint: 'google/pixel/pixel:16/BP2A/example',
      traceDurationMs: 10_000,
      traceSizeBytes: 2048,
      reason_code: 'shader_compile',
      responsibility: 'app',
    },
    summary: { headline: 'text-only wording should not be parsed as a root cause' },
    metrics: [
      {
        key: 'scrolling.jank_count',
        label: 'Jank count',
        group: 'jank',
        value: 12,
        confidence: 0.9,
        source: { type: 'skill', skillId: 'scrolling', stepId: 'frame_stats' },
      },
      {
        key: 'trace.capture_config_summary',
        label: 'Capture config',
        group: 'environment',
        value: 'sched + gfx',
        confidence: 0.7,
        source: { type: 'manual' },
      },
    ],
    evidenceRefs: [{
      id: 'evidence-1',
      type: 'skill_step',
      metadata: {
        render_slices: ['makePipeline', 'drawFrame'],
      },
    }],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1,
    ...overrides,
  };
}

describe('buildTraceSimilaritySignature', () => {
  it('extracts bounded structured metadata, metrics, and case evidence signatures', () => {
    const signature = buildTraceSimilaritySignature(snapshot());

    expect(signature).toMatchObject({
      schemaVersion: 1,
      sceneType: 'scrolling',
      appPackage: 'com.example.app',
      processName: 'com.example.app:ui',
      buildFingerprintPrefix: 'google/pixel/pixel:16/BP',
      traceDurationMs: 10_000,
      traceSizeBytes: 2048,
      metrics: {
        'scrolling.jank_count': 12,
        'trace.duration_ms': 10_000,
        'trace.size_bytes': 2048,
      },
      categoricalSignals: {
        appPackage: 'com.example.app',
        rootCause: 'shader_compile',
        'skill:scrolling': true,
        'step:frame_stats': true,
      },
      caseQuery: {
        scene: 'scrolling',
        domainPack: 'scrolling.v1',
        rootCause: 'shader_compile',
        responsibility: 'app',
        audiences: ['app'],
      },
    });
    expect(signature.metrics).not.toHaveProperty('trace.capture_config_summary');
    expect(signature.caseEvidenceSignatures).toMatchObject({
      scene: 'scrolling',
      domain_pack: 'scrolling.v1',
      reason_code: 'shader_compile',
      render_slices: ['makePipeline', 'drawFrame'],
      metric_keys: expect.arrayContaining(['scrolling.jank_count', 'trace.capture_config_summary']),
      skill_ids: ['scrolling'],
      step_ids: ['frame_stats'],
    });
  });

  it('does not infer root cause or case query from natural-language summary text', () => {
    const signature = buildTraceSimilaritySignature(snapshot({
      traceMetadata: {},
      summary: {
        headline: 'This sentence mentions shader_compile but is not a structured reason code',
      },
      evidenceRefs: [],
    }));

    expect(signature.caseQuery).toBeUndefined();
    expect(signature.caseEvidenceSignatures).not.toHaveProperty('reason_code');
  });
});
