// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ProviderScope} from '../providerManager';
import {getProviderService} from '../providerManager';
import {resolveProviderRuntimeSnapshot} from '../providerManager/providerSnapshot';
import {reconcileRecordedProviderPin} from '../providerManager/providerPinContinuity';
import {isRecordedRuntimeKind} from '../../agentRuntime/runtimeKinds';
import type {
  ExternalIssueReviewUnavailableReason,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';

export type ExternalIssueProviderPinResolution =
  | {
      ok: true;
      providerId: string | null;
      runtime:
        | 'openai-agents-sdk'
        | 'claude-agent-sdk'
        | 'pi-agent-core'
        | 'opencode';
      model?: string;
    }
  | {
      ok: false;
      reason: ExternalIssueReviewUnavailableReason;
    };

/**
 * The provider pin a triage review of `manifest`'s run uses: the run's own
 * provider snapshot when it is unchanged, or, for a run recorded under a
 * retired runtime, the current Pi pin when it still calls the same endpoint
 * and model (the manifest keeps its original label as provenance).
 */
export function resolveExternalIssueProviderPin(
  manifest: RunManifestV1,
  providerScope: ProviderScope,
): ExternalIssueProviderPinResolution {
  if (!manifest.providerSnapshotHash) {
    return {ok: false, reason: 'legacy_provider_pin_missing'};
  }
  if (!isRecordedRuntimeKind(manifest.runtime) || manifest.runtime === 'qoder-agent-sdk') {
    return {ok: false, reason: 'runtime_not_supported'};
  }
  try {
    const providerService = getProviderService();
    const current = resolveProviderRuntimeSnapshot(
      providerService,
      manifest.providerId,
      providerScope,
    );
    const continuity = reconcileRecordedProviderPin(providerService, {
      providerId: manifest.providerId,
      runtimeKind: manifest.runtime,
      snapshotHash: manifest.providerSnapshotHash,
    }, current, {providerScope});
    if (continuity.status === 'changed') {
      return {ok: false, reason: 'provider_snapshot_changed'};
    }
    const runtime = current.snapshot.runtimeKind;
    if (runtime !== 'openai-agents-sdk' && runtime !== 'claude-agent-sdk'
      && runtime !== 'pi-agent-core' && runtime !== 'opencode') {
      return {ok: false, reason: 'runtime_not_supported'};
    }
    return {
      ok: true,
      providerId: manifest.providerId,
      runtime,
      ...(current.snapshot.resolvedModels.light
        ? {model: current.snapshot.resolvedModels.light}
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      reason: isProviderNotFound(error)
        ? 'provider_not_found'
        : 'source_artifacts_unavailable',
    };
  }
}

function isProviderNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Provider not found:');
}
