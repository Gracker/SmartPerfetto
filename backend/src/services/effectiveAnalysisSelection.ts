// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeAwareMode} from './codebase/codeAwareFeature';
import type {AnalysisContextSelection} from './resolvedAnalysisContext';

/** A selection after `effectiveAnalysisSelection`: the mode is always decided. */
export interface EffectiveAnalysisSelection {
  codeAwareMode: CodeAwareMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
}

/**
 * The one meaning of a source and knowledge selection, built after any
 * session or conversation options are merged in and consumed by every
 * authorization, registry read, fingerprint, memory partition, run option and
 * persisted session:
 *
 * - an explicit `off` drops the codebase ids: hidden ids authorize nothing;
 * - codebase ids without a mode mean `metadata_only`;
 * - without codebase ids the mode means nothing and is `off`;
 * - knowledge sources are independent of the source mode.
 *
 * Ids keep their first-seen order without duplicates.
 */
export function effectiveAnalysisSelection(selection: AnalysisContextSelection): EffectiveAnalysisSelection {
  const unique = (values: readonly string[] | undefined): string[] =>
    Array.from(new Set((values ?? []).filter(Boolean)));
  const requestedCodebaseIds = selection.codeAwareMode === 'off' ? [] : unique(selection.codebaseIds);
  const knowledgeSourceIds = unique(selection.knowledgeSourceIds);
  return {
    codeAwareMode: requestedCodebaseIds.length > 0 ? selection.codeAwareMode ?? 'metadata_only' : 'off',
    ...(requestedCodebaseIds.length > 0 ? {codebaseIds: requestedCodebaseIds} : {}),
    ...(knowledgeSourceIds.length > 0 ? {knowledgeSourceIds} : {}),
  };
}

/**
 * A run's effective selection from its session or options: a source
 * authorization a session pinned at activation wins field by field over the
 * run's own codebase fields; knowledge always comes from the run.
 */
export function runAnalysisSelection(
  run: AnalysisContextSelection,
  pinnedSource?: Pick<AnalysisContextSelection, 'codeAwareMode' | 'codebaseIds'>,
): EffectiveAnalysisSelection {
  return effectiveAnalysisSelection({
    codeAwareMode: pinnedSource?.codeAwareMode ?? run.codeAwareMode,
    codebaseIds: pinnedSource?.codebaseIds ?? run.codebaseIds,
    knowledgeSourceIds: run.knowledgeSourceIds,
  });
}
