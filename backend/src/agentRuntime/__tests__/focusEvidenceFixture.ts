// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ArtifactStore} from '../../agentv3/artifactStore';
import type {EvidenceReadResolution} from '../../services/evidence/evidenceReadView';

/** The issued focus-app locator a rendered prompt carries; throws when it carries none. */
export function focusEvidenceRefIdFromPrompt(prompt: unknown): string {
  const match = String(prompt).match(/data:focus_app:current:[a-f0-9]{12}/);
  if (!match) throw new Error('The prompt carries no focus-app evidence locator');
  return match[0];
}

/**
 * Resolves the prompt's focus-app locator on `{rowIndex: 0, column:
 * 'package_name'}` through the store's read view of the current trace, the
 * same read a claim citing it goes through.
 */
export async function resolveFocusPackageCell(store: Pick<ArtifactStore, 'createEvidenceReadView'>, prompt: unknown,
  traceId: string, currentRunId?: string): Promise<EvidenceReadResolution> {
  const view = store.createEvidenceReadView({ownerKey: 'owner', allowedTraces: [{traceId, traceSide: 'current'}],
    ...(currentRunId ? {currentRunId} : {})});
  const [resolution] = await view.resolveReferences([{key: 'focus', requiredColumns: [],
    reference: {evidenceRefId: focusEvidenceRefIdFromPrompt(prompt), rowIndex: 0, column: 'package_name'}}]);
  return resolution;
}
