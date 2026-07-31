// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ProviderScope} from '../providerManager';
import {getProviderService} from '../providerManager';
import {resolveProviderRuntimeSnapshot} from '../providerManager/providerSnapshot';
import type {
  ExternalIssueReviewUnavailableReason,
} from '../../types/externalIssueReporting';
import type {RunManifestV1} from '../../types/selfEvolution';

export type ExternalIssueProviderPinResolution =
  | {
      ok: true;
      providerId: string | null;
      runtime: 'openai-agents-sdk' | 'claude-agent-sdk';
      model?: string;
    }
  | {
      ok: false;
      reason: ExternalIssueReviewUnavailableReason;
    };

export function resolveExternalIssueProviderPin(
  manifest: RunManifestV1,
  providerScope: ProviderScope,
): ExternalIssueProviderPinResolution {
  if (!manifest.providerSnapshotHash) {
    return {ok: false, reason: 'legacy_provider_pin_missing'};
  }
  if (
    manifest.runtime !== 'openai-agents-sdk' &&
    manifest.runtime !== 'claude-agent-sdk'
  ) {
    return {ok: false, reason: 'runtime_not_supported'};
  }
  try {
    const current = resolveProviderRuntimeSnapshot(
      getProviderService(),
      manifest.providerId,
      manifest.runtime,
      providerScope,
    );
    if (current.snapshotHash !== manifest.providerSnapshotHash) {
      return {ok: false, reason: 'provider_snapshot_changed'};
    }
    return {
      ok: true,
      providerId: manifest.providerId,
      runtime: manifest.runtime,
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
