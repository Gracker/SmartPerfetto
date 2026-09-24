// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import type { DetectedFocusApp, FocusAppDetectionResult } from '../agentv3/focusAppDetector';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  type DataEnvelope,
  type DataEnvelopeTraceSide,
} from '../types/dataContract';

export interface FocusAppEvidencePayload {
  focusResult: FocusAppDetectionResult;
  envelope?: DataEnvelope;
  evidenceRefId?: string;
}

const FOCUS_APP_COLUMNS = [
  'rank',
  'package_name',
  'is_primary',
  'foreground_duration_ns',
  'foreground_count',
  'count_source',
  'detection_method',
];

const FOCUS_APP_SCOPE_COLUMNS = [
  'scope_start_ns',
  'scope_end_ns',
];

/** Present when the detector ranked candidates (results that carry a confidence). */
const FOCUS_APP_CONFIDENCE_COLUMNS = [
  'detection_confidence',
  'duration_source',
];

function countSourceFor(method: FocusAppDetectionResult['method']): string {
  if (method === 'frame_timeline') return 'frame_count';
  if (method === 'sched_activity') return 'none';
  return 'foreground_switch_count';
}

function durationSourceFor(method: FocusAppDetectionResult['method']): string {
  if (method === 'battery_stats') return 'battery_top';
  if (method === 'sched_activity') return 'cpu_running';
  return 'oom_foreground';
}

function stableFocusAppHash(
  traceId: string,
  focusResult: FocusAppDetectionResult,
  traceSide: DataEnvelopeTraceSide,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      traceId,
      traceSide,
      method: focusResult.method,
      confidence: focusResult.confidence,
      timeRange: focusResult.timeRange,
      apps: focusResult.apps.map(app => ({
        packageName: app.packageName,
        totalDurationNs: app.totalDurationNs,
        switchCount: app.switchCount,
      })),
    }))
    .digest('hex')
    .slice(0, 12);
}

export function buildFocusAppEvidencePayload(
  focusResult: FocusAppDetectionResult,
  traceId: string,
  traceSide: DataEnvelopeTraceSide = 'current',
  outputLanguage: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
): FocusAppEvidencePayload {
  if (!focusResult.apps.length) {
    return { focusResult };
  }

  const queryHash = stableFocusAppHash(traceId, focusResult, traceSide);
  const evidenceRefId = `data:focus_app:${traceSide}:${queryHash}`;
  const sourceToolCallId = `runtime-focus-app:${queryHash}`;
  const countSource = countSourceFor(focusResult.method);
  const scoped = !!focusResult.timeRange;
  const ranked = focusResult.confidence !== undefined;
  const columns = [
    ...FOCUS_APP_COLUMNS,
    ...(scoped ? FOCUS_APP_SCOPE_COLUMNS : []),
    ...(ranked ? FOCUS_APP_CONFIDENCE_COLUMNS : []),
  ];
  const focusAppsWithEvidence: DetectedFocusApp[] = focusResult.apps.map((app, index) => ({
    ...app,
    evidenceRefId,
    evidenceRowIndex: index,
  }));

  const envelope = createDataEnvelope(
    {
      columns,
      rows: focusAppsWithEvidence.map((app, index) => {
        const row: Array<string | number | boolean | undefined> = [
          index + 1,
          app.packageName,
          // An ambiguous ranking has no primary app, only candidates.
          index === 0 && (!ranked || focusResult.primaryApp === app.packageName),
          app.totalDurationNs,
          app.switchCount,
          countSource,
          focusResult.method,
        ];
        if (scoped) {
          row.push(focusResult.timeRange?.startNs, focusResult.timeRange?.endNs);
        }
        if (ranked) row.push(focusResult.confidence, durationSourceFor(focusResult.method));
        return row;
      }),
    },
    {
      type: 'sql_result',
      source: 'runtime_focus_detection',
      title: 'Runtime focus app detection',
      layer: 'list',
      format: 'table',
      columns: buildColumnDefinitions(columns, [
        { name: 'rank', type: 'number' },
        { name: 'package_name', type: 'string', format: 'code' },
        { name: 'is_primary', type: 'boolean' },
        { name: 'foreground_duration_ns', type: 'duration', unit: 'ns', format: 'duration_ms' },
        { name: 'foreground_count', type: 'number' },
        { name: 'count_source', type: 'string' },
        { name: 'detection_method', type: 'string' },
        { name: 'scope_start_ns', type: 'timestamp', unit: 'ns' },
        { name: 'scope_end_ns', type: 'timestamp', unit: 'ns' },
        { name: 'detection_confidence', type: 'string' },
        { name: 'duration_source', type: 'string' },
      ]),
      evidenceRefId,
      traceSide,
      traceId,
      queryHash,
      sourceToolCallId,
      paramsHash: queryHash,
      intent: 'runtime_focus_app_detection',
      planPhaseId: 'quick',
      planPhaseTitle: localize(outputLanguage, '快速回答', 'Quick answer'),
      planPhaseGoal: localize(outputLanguage, '复用运行时焦点应用检测结果回答身份类问题', 'Reuse runtime focus-app detection for identity questions'),
      planPhaseAttribution: 'active',
      toolNarration: localize(outputLanguage, '复用运行时焦点应用检测结果', 'Reuse runtime focus-app detection output'),
      producerReason: localize(
        outputLanguage,
        '快速问答启动阶段已确定当前 trace 的焦点应用。',
        'The quick-answer startup path already identified the focus app for the current trace.',
      ),
    },
  );

  return {
    focusResult: {
      ...focusResult,
      apps: focusAppsWithEvidence,
    },
    envelope,
    evidenceRefId,
  };
}
