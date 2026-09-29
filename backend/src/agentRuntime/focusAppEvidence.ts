// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createHash } from 'crypto';
import type { ArtifactStore } from '../agentv3/artifactStore';
import {
  FOCUS_APP_DETECTOR_DEFINITION,
  type DetectedFocusApp,
  type FocusAppDetectionResult,
} from '../agentv3/focusAppDetector';
import {
  DEFAULT_OUTPUT_LANGUAGE,
  localize,
  type OutputLanguage,
} from '../agentv3/outputLanguage';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  type ColumnDefinition,
  type DataEnvelope,
  type DataEnvelopeTraceSide,
} from '../types/dataContract';
import {
  captureEvidenceTable,
  evidenceCaptureHash,
  nativeProducerFields,
} from '../services/evidence/evidenceCapture';
import {
  FOCUS_APP_EVIDENCE_COLUMNS,
  type FocusAppTarget,
} from './focusAppTarget';

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

/** Fixed product producer of both focus-app tables. */
export const FOCUS_APP_EVIDENCE_PRODUCER = 'runtime_focus_detection';

/** Display definitions of the detector's discrete output, shared by both tables. */
const FOCUS_APP_IDENTITY_COLUMN_DEFINITIONS: Partial<ColumnDefinition>[] = [
  {name: 'package_name', type: 'string', format: 'code'},
  {name: 'detection_method', type: 'string'},
  {name: 'detection_confidence', type: 'string'},
];

/**
 * Producer semantics of the captured row, fingerprinted by what defines it: the
 * producer, the detector definition and the columns. The row carries only the
 * detector's discrete output. Its duration is left out on purpose: depending on
 * the method it is battery-top, OOM-foreground or CPU-running time, so one
 * column could not carry one meaning.
 */
const FOCUS_APP_EVIDENCE_FIELDS = nativeProducerFields(
  {producer: FOCUS_APP_EVIDENCE_PRODUCER, detector: FOCUS_APP_DETECTOR_DEFINITION, columns: FOCUS_APP_EVIDENCE_COLUMNS},
  Object.fromEntries(FOCUS_APP_EVIDENCE_COLUMNS.map(column => [column, {}])),
);
const FOCUS_APP_EVIDENCE_DEFINITION_FINGERPRINT = FOCUS_APP_EVIDENCE_FIELDS.package_name.origin.definitionFingerprint;

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
      source: FOCUS_APP_EVIDENCE_PRODUCER,
      title: 'Runtime focus app detection',
      layer: 'list',
      format: 'table',
      columns: buildColumnDefinitions(columns, [
        ...FOCUS_APP_IDENTITY_COLUMN_DEFINITIONS,
        { name: 'rank', type: 'number' },
        { name: 'is_primary', type: 'boolean' },
        { name: 'foreground_duration_ns', type: 'duration', unit: 'ns', format: 'duration_ms' },
        { name: 'foreground_count', type: 'number' },
        { name: 'count_source', type: 'string' },
        { name: 'scope_start_ns', type: 'timestamp', unit: 'ns' },
        { name: 'scope_end_ns', type: 'timestamp', unit: 'ns' },
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

/**
 * Makes the run's focus detection citable. When the detector named a primary
 * app with `high` or `medium` confidence, registers one row — package, method,
 * confidence — as a current-run execution capture on the current trace, and
 * returns the target carrying its issued locator for the prompt. The cell
 * records the detector's primary app for the analysis window, not the user's
 * target. Anything else (no detection, `existing_only`, an ambiguous ranking,
 * a failed registration) returns the target unchanged. Call it once per run,
 * after the run's evidence store resolves and before the prompt is built; the
 * run facade stamps the capture with the current run.
 */
export function registerFocusAppEvidence(input: {
  store: Pick<ArtifactStore, 'registerStandaloneEvidenceCapture'>;
  traceId: string;
  focusResult: FocusAppDetectionResult | undefined;
  focusTarget: FocusAppTarget;
}): FocusAppTarget {
  const {focusResult, focusTarget, traceId} = input;
  const packageName = focusResult?.primaryApp?.trim();
  const confidence = focusResult?.confidence;
  if (!focusResult || !packageName || !traceId.trim() || (confidence !== 'high' && confidence !== 'medium')) {
    return focusTarget;
  }
  const row = {package_name: packageName, detection_method: focusResult.method, detection_confidence: confidence};
  const columns = [...FOCUS_APP_EVIDENCE_COLUMNS];
  // The locator is rendered into the cacheable trace context, so it is derived
  // from what the row states and the detection behind it: the same detection
  // renders the same prompt bytes. Re-registering it replaces the earlier
  // capture in the store, which keeps the identifier unambiguous.
  const id = evidenceCaptureHash({
    traceId,
    definitionFingerprint: FOCUS_APP_EVIDENCE_DEFINITION_FINGERPRINT,
    row,
    timeRange: focusResult.timeRange ?? null,
    apps: focusResult.apps.map(({packageName, totalDurationNs, switchCount, score}) =>
      ({packageName, totalDurationNs, switchCount, score: score ?? null})),
  }).slice(0, 12);
  const evidenceRefId = `data:focus_app:current:${id}`;
  const sourceToolCallId = `runtime-focus-app:${id}`;
  // Only meta/display are registered; the witness below holds the row.
  const envelope = createDataEnvelope({columns, rows: []}, {
    type: 'sql_result',
    source: FOCUS_APP_EVIDENCE_PRODUCER,
    title: 'Runtime focus app detection',
    layer: 'list',
    format: 'table',
    executionStatus: 'observed',
    columns: buildColumnDefinitions(columns, FOCUS_APP_IDENTITY_COLUMN_DEFINITIONS),
    evidenceRefId,
    traceId,
    traceSide: 'current',
    sourceToolCallId,
    intent: 'runtime_focus_app_detection',
  });
  const registered = input.store.registerStandaloneEvidenceCapture(
    captureEvidenceTable({columns, rows: [row]}, FOCUS_APP_EVIDENCE_FIELDS),
    {meta: envelope.meta, display: envelope.display},
  );
  if (!registered) return focusTarget;
  return {...focusTarget, evidence: {evidenceRefId, sourceToolCallId, rowIndex: 0, row}};
}
