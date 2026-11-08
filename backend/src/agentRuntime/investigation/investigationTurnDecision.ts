// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {InvestigationViewV1} from './investigationView';

/**
 * What the product would change about the next provider request. Each field
 * is a closed union so later decisions extend it without moving the adapter
 * or the receipt; today every field keeps the request as the loop built it.
 */
export interface InvestigationTurnDecisionV1 {
  schemaVersion: 'investigation_turn_decision@1';
  tools: {kind: 'unchanged'};
  progressMessages: readonly never[];
  foldPlan: {kind: 'none'};
  executionPurpose: {kind: 'unchanged'};
}

const NO_CHANGE: InvestigationTurnDecisionV1 = Object.freeze({
  schemaVersion: 'investigation_turn_decision@1',
  tools: Object.freeze({kind: 'unchanged'}),
  progressMessages: Object.freeze([]),
  foldPlan: Object.freeze({kind: 'none'}),
  executionPurpose: Object.freeze({kind: 'unchanged'}),
} as const);

/** Pure. Observation only: the view informs no decision yet. */
export function decideInvestigationTurn(_view: InvestigationViewV1): InvestigationTurnDecisionV1 {
  return NO_CHANGE;
}
