// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisReceiptV2} from '../../types/dataContract';
import type {AnalysisResultSnapshot} from '../../types/multiTraceComparison';
import type {RunManifestScope, RunManifestV1} from '../../types/selfEvolution';
import {
  getLatestSerializedAgentEventByType,
  type SerializedAgentEvent,
} from '../agentEventStore';
import {
  createAnalysisResultSnapshotRepository,
  type SnapshotAccessScope,
} from '../analysisResultSnapshotStore';
import {openEnterpriseDb} from '../enterpriseDb';
import {FeedbackEventStore} from '../selfEvolution/feedbackEventStore';
import {getRunManifestStore} from '../selfEvolution/runManifestStore';

export interface ExternalIssueSourceRunRequest {
  sessionId: string;
  runId: string;
  runManifestId: string;
  resultSnapshotId?: string;
}

export interface ExternalIssueSourceRun {
  receipt: AnalysisReceiptV2;
  manifest: RunManifestV1;
  completedData: Record<string, unknown>;
  completedEvent: SerializedAgentEvent;
  snapshot?: AnalysisResultSnapshot;
  privateAnalysis: boolean;
  userReportedInaccuracy: boolean;
}

export type ExternalIssueSourceRunResolution =
  | {ok: true; source: ExternalIssueSourceRun}
  | {
      ok: false;
      code:
        | 'source_artifacts_unavailable'
        | 'source_artifacts_mismatch'
        | 'private_analysis';
      message: string;
    };

export interface ExternalIssueSourceRunResolverDeps {
  getCompletedEvent?: (
    scope: RunManifestScope,
    runId: string,
  ) => SerializedAgentEvent | null;
  getManifest?: (
    scope: RunManifestScope,
    runManifestId: string,
  ) => RunManifestV1 | undefined;
  getSnapshot?: (
    scope: SnapshotAccessScope,
    snapshotId: string,
  ) => AnalysisResultSnapshot | null;
  hasNegativeFeedback?: (
    scope: RunManifestScope,
    request: ExternalIssueSourceRunRequest,
  ) => boolean;
}

export function resolveExternalIssueSourceRun(
  request: ExternalIssueSourceRunRequest,
  scope: SnapshotAccessScope,
  deps: ExternalIssueSourceRunResolverDeps = {},
): ExternalIssueSourceRunResolution {
  const manifestScope = {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  };
  const completedEvent = (deps.getCompletedEvent ??
    ((resolvedScope, runId) =>
      getLatestSerializedAgentEventByType(
        resolvedScope,
        runId,
        'analysis_completed',
      )))(manifestScope, request.runId);
  if (!completedEvent) {
    return unavailable('Persisted analysis_completed event was not found');
  }

  const completedData = parseCompletedData(completedEvent.eventData);
  if (!completedData) {
    return unavailable('Persisted analysis_completed event is invalid');
  }
  if (completedData.privateProjectionVersion !== undefined) {
    return {
      ok: false,
      code: 'private_analysis',
      message: 'Private source or knowledge analysis cannot be exported',
    };
  }

  const receipt = readReceipt(completedData.analysisReceipt);
  if (!receipt) {
    return unavailable('AnalysisReceiptV2 is missing from the source run');
  }
  if (
    receipt.runId !== request.runId ||
    receipt.sessionId !== request.sessionId ||
    receipt.runManifestId !== request.runManifestId
  ) {
    return mismatch('Request references do not match the persisted receipt');
  }

  const persistedSnapshotId = readString(completedData.resultSnapshotId) ??
    receipt.outputs.resultSnapshotId;
  if (
    request.resultSnapshotId !== undefined &&
    request.resultSnapshotId !== persistedSnapshotId
  ) {
    return mismatch('Result snapshot reference does not match the source run');
  }

  const manifest = (deps.getManifest ??
    ((resolvedScope, runManifestId) =>
      getRunManifestStore().get(resolvedScope, runManifestId)))(
    manifestScope,
    request.runManifestId,
  );
  if (
    !manifest ||
    manifest.runId !== request.runId ||
    manifest.sessionId !== request.sessionId ||
    manifest.runManifestId !== request.runManifestId
  ) {
    return unavailable('RunManifest is missing or does not match the source run');
  }

  let snapshot: AnalysisResultSnapshot | undefined;
  if (persistedSnapshotId) {
    const resolvedSnapshot = deps.getSnapshot
      ? deps.getSnapshot(scope, persistedSnapshotId)
      : loadSnapshot(scope, persistedSnapshotId);
    const snapshotReceipt = resolvedSnapshot?.summary.analysisReceipt;
    if (
      !resolvedSnapshot ||
      resolvedSnapshot.runId !== request.runId ||
      resolvedSnapshot.sessionId !== request.sessionId ||
      (snapshotReceipt?.schemaVersion === 2 &&
        snapshotReceipt.runManifestId !== request.runManifestId)
    ) {
      return unavailable(
        'Analysis result snapshot is missing or does not match the source run',
      );
    }
    snapshot = resolvedSnapshot;
  }

  return {
    ok: true,
    source: {
      receipt,
      manifest,
      completedData,
      completedEvent,
      ...(snapshot ? {snapshot} : {}),
      privateAnalysis: false,
      userReportedInaccuracy: (deps.hasNegativeFeedback ??
        hasEffectiveNegativeFeedback)(manifestScope, request),
    },
  };
}

function hasEffectiveNegativeFeedback(
  scope: RunManifestScope,
  request: ExternalIssueSourceRunRequest,
): boolean {
  const store = new FeedbackEventStore({scope});
  try {
    return store.listEffective().some(
      feedback =>
        feedback.runId === request.runId &&
        feedback.runManifestId === request.runManifestId &&
        feedback.sessionId === request.sessionId &&
        feedback.rating === 'negative',
    );
  } finally {
    store.close();
  }
}

function loadSnapshot(
  scope: SnapshotAccessScope,
  snapshotId: string,
): AnalysisResultSnapshot | null {
  const db = openEnterpriseDb();
  try {
    return createAnalysisResultSnapshotRepository(db).getSnapshot(
      scope,
      snapshotId,
    );
  } finally {
    db.close();
  }
}

function parseCompletedData(
  serialized: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(serialized);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.data) ? parsed.data : parsed;
  } catch {
    return null;
  }
}

function readReceipt(value: unknown): AnalysisReceiptV2 | null {
  if (!isRecord(value) || value.schemaVersion !== 2) return null;
  if (
    !readString(value.runId) ||
    !readString(value.sessionId) ||
    !readString(value.runManifestId) ||
    !isRecord(value.outputs)
  ) {
    return null;
  }
  return value as unknown as AnalysisReceiptV2;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(message: string): ExternalIssueSourceRunResolution {
  return {ok: false, code: 'source_artifacts_unavailable', message};
}

function mismatch(message: string): ExternalIssueSourceRunResolution {
  return {ok: false, code: 'source_artifacts_mismatch', message};
}
