// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { ArtifactStore } from '../agentv3/artifactStore';
import {
  FOCUS_APP_DETECTOR_DEFINITION,
  type FocusAppDetectionResult,
} from '../agentv3/focusAppDetector';
import {
  buildColumnDefinitions,
  createDataEnvelope,
  type ColumnDefinition,
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

/** Fixed product producer of the focus-app evidence capture. */
export const FOCUS_APP_EVIDENCE_PRODUCER = 'runtime_focus_detection';

/** Display definitions of the detector's discrete output. */
const FOCUS_APP_EVIDENCE_COLUMN_DEFINITIONS: Partial<ColumnDefinition>[] = [
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
    columns: buildColumnDefinitions(columns, FOCUS_APP_EVIDENCE_COLUMN_DEFINITIONS),
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
