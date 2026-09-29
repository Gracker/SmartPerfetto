// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';

import {
  ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
  type AnalysisResultSceneType,
  type AnalysisResultSnapshot,
} from '../../../types/multiTraceComparison';
import { rankSnapshotSimilarityHints } from '../similarityMatcher';
import {NO_PRIVATE_CONTEXT} from '../../security/analysisPrivateContext';

function snapshot(overrides: Partial<AnalysisResultSnapshot> = {}): AnalysisResultSnapshot {
  const id = overrides.id ?? 'snapshot-a';
  const sceneType: AnalysisResultSceneType = overrides.sceneType ?? 'scrolling';
  return {
    id,
    tenantId: 'tenant-a',
    workspaceId: 'workspace-a',
    traceId: `${id}-trace`,
    sessionId: `${id}-session`,
    runId: `${id}-run`,
    visibility: 'workspace',
    privateContext: NO_PRIVATE_CONTEXT,
    sceneType,
    title: id,
    userQuery: 'analyze',
    traceLabel: id,
    traceMetadata: {
      appPackage: 'com.example.app',
      processName: 'com.example.app',
      deviceModel: 'Pixel 9',
      androidVersion: '16',
      traceDurationMs: 10_000,
      reason_code: 'shader_compile',
    },
    summary: { headline: 'ok' },
    metrics: [{
      key: sceneType === 'scrolling' ? 'scrolling.jank_count' : 'cpu.main_thread_running_ms',
      label: 'metric',
      group: sceneType === 'scrolling' ? 'jank' : 'cpu',
      value: 10,
      confidence: 0.9,
      source: { type: 'skill', skillId: sceneType },
    }],
    evidenceRefs: [],
    status: 'ready',
    schemaVersion: ANALYSIS_RESULT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: 1,
    ...overrides,
  };
}

describe('rankSnapshotSimilarityHints', () => {
  it('ranks deterministic snapshot hints by bounded structural feature overlap', () => {
    const current = snapshot({ id: 'current' });
    const strong = snapshot({
      id: 'strong',
      traceMetadata: {
        appPackage: 'com.example.app',
        processName: 'com.example.app',
        deviceModel: 'Pixel 9',
        androidVersion: '16',
        traceDurationMs: 10_400,
        reason_code: 'shader_compile',
      },
      metrics: [{
        key: 'scrolling.jank_count',
        label: 'Jank',
        group: 'jank',
        value: 11,
        confidence: 0.9,
        source: { type: 'skill', skillId: 'scrolling' },
      }],
    });
    const background = snapshot({
      id: 'background',
      traceMetadata: {
        appPackage: 'com.other.app',
        processName: 'com.other.app',
      },
      metrics: [],
      status: 'failed',
    });
    const unrelated = snapshot({
      id: 'unrelated',
      sceneType: 'cpu',
      traceMetadata: {
        appPackage: 'com.third.app',
        processName: 'com.third.app',
      },
      metrics: [],
    });

    const hints = rankSnapshotSimilarityHints({
      currentSnapshot: current,
      candidates: [
        { snapshot: background },
        { snapshot: unrelated },
        { snapshot: strong },
      ],
      limit: 10,
      outputLanguage: 'en',
    });

    expect(hints.map(hint => hint.sourceId)).toEqual(['strong', 'background']);
    expect(hints[0]).toMatchObject({
      source: 'analysis_result_snapshot',
      sourceId: 'strong',
      band: 'strong',
      allowedUse: 'navigation_hint_only',
    });
    expect(hints[0].matchReasons.map(reason => reason.feature)).toEqual(expect.arrayContaining([
      'sceneType',
      'appPackage',
      'metric:scrolling.jank_count',
      'signal:rootCause',
    ]));
    expect(hints[1]).toMatchObject({
      sourceId: 'background',
      band: 'background',
    });
    expect(hints[1].limitations).toContain('Low feature overlap; use only for exploration.');
  });

  it('localizes snapshot limitations', () => {
    const hints = rankSnapshotSimilarityHints({
      currentSnapshot: snapshot({
        id: 'current',
        traceMetadata: {},
        metrics: [],
      }),
      candidates: [{
        snapshot: snapshot({
          id: 'candidate',
          traceMetadata: { reason_code: 'shader_compile' },
          metrics: [],
        }),
      }],
      limit: 10,
      outputLanguage: 'zh-CN',
    });

    expect(hints[0]?.limitations.join('\n')).toContain('相似性只是导航提示');
  });
});
