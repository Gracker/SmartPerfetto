// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveTurnIntentComplexity, type AnalysisTurnIntent} from './analysisTurnIntent';
import type {SourceNeed} from '../types/sourceNeed';
import type {SourceNeedMissingReason} from '../services/codebase/sourceDepthPolicy';

export interface RuntimeTurnPolicy {
  readonly budgetMode: 'quick' | 'full';
  readonly onDemandContext: boolean;
  /** Additional restriction only; all existing authorization checks still apply. */
  readonly allowNewEvidence: boolean;
  /**
   * How much context a run may gather before the model's first turn. A narrow
   * question is a reason to skip scene-wide memory lookups, not a reason to
   * withhold what the trace is: which app is in focus, its architecture and
   * vendor, and which data the capture actually contains. Those four facts cost
   * a bounded number of queries and are what a first-turn question like
   * "why is this page slow" has to be answered against.
   *
   * | preflight     | when                                  | trace facts | memory prefetch |
   * | ------------- | ------------------------------------- | ----------- | --------------- |
   * | `full`        | resolved + `scene_wide` + `read_new`   | yes         | yes             |
   * | `trace_facts` | bounded question, or unavailable intent| yes         | no              |
   * | `none`        | `existing_only`                        | no          | no              |
   *
   * `budgetMode` is an orthogonal dimension: a quick budget compacts result and
   * catalog projections but never changes which of the above may be gathered,
   * and a full budget never turns `trace_facts` into `full`.
   */
  readonly preflight: 'full' | 'trace_facts' | 'none';
  /** Memory-type prefetch only: knowledge base, patterns, cases, SQL fix pairs. */
  readonly allowAutomaticPrefetch: boolean;
  readonly requiresReport: boolean;
  /** What the resolved intent says the answer needs from selected source; absent when it did not say. */
  readonly sourceNeed?: SourceNeed;
  /** Why there is no source need. */
  readonly sourceNeedMissing?: SourceNeedMissingReason;
}

/**
 * Whether the MCP catalog and result projections are compacted for this turn.
 *
 * Five runtimes ask this question and their answers must not drift, so the
 * truth table lives here: a quick budget compacts, unless the turn is a full
 * scene investigation, where the catalog is the map of what can be measured.
 * It is a projection width, never a permission — `existing_only` is enforced
 * at the handler boundary, not by shortening a list.
 */
export function usesLightweightToolCatalog(policy: RuntimeTurnPolicy): boolean {
  return policy.budgetMode === 'quick' && policy.preflight !== 'full';
}

/** No prose, phase name or tool selection is an input to execution policy. */
export function resolveRuntimeTurnPolicy(
  intent: AnalysisTurnIntent,
  requestedMode: 'auto' | 'fast' | 'full' = 'auto',
): RuntimeTurnPolicy {
  const onDemandContext = intent.status === 'unavailable' || intent.scope === 'bounded_question';
  const allowNewEvidence = intent.evidenceAccess === 'read_new';
  const preflight = !allowNewEvidence ? 'none'
    : intent.status === 'resolved' && intent.scope === 'scene_wide' ? 'full'
      : 'trace_facts';
  return Object.freeze({
    budgetMode: resolveTurnIntentComplexity(intent, requestedMode),
    onDemandContext,
    allowNewEvidence,
    preflight,
    allowAutomaticPrefetch: preflight === 'full',
    requiresReport: intent.deliverable === 'report',
    ...(intent.status === 'resolved' && intent.sourceNeed ? {sourceNeed: intent.sourceNeed}
      : {sourceNeedMissing: intent.status !== 'resolved' ? 'intent_unavailable' as const
        : intent.source === 'product' ? 'product_run' as const : 'source_need_missing' as const}),
  });
}
