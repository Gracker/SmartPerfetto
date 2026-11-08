// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Hypothesis as ProtocolHypothesis } from '../agent/types/agentProtocol';
import type { Hypothesis } from '../agentv3/types';

// Protocol provenance labels are shorter than runtime kind ids by design:
// Claude/OpenAI use "claude"/"openai", while Pi matches its public runtime
// kind string.
export type RuntimeHypothesisSource = 'claude' | 'openai' | 'pi-agent-core';

export function toProtocolHypothesis(
  h: Hypothesis,
  source: RuntimeHypothesisSource,
): ProtocolHypothesis {
  const statusMap: Record<string, ProtocolHypothesis['status']> = {
    formed: 'proposed',
    confirmed: 'confirmed',
    rejected: 'rejected',
  };
  const confidenceMap: Record<string, number> = { formed: 0.5, confirmed: 0.85, rejected: 0.1 };
  return {
    id: h.id,
    description: h.statement,
    status: statusMap[h.status] || 'proposed',
    confidence: confidenceMap[h.status] ?? 0.5,
    supportingEvidence: h.evidence && h.status === 'confirmed'
      ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source, strength: 0.8 }]
      : [],
    contradictingEvidence: h.evidence && h.status === 'rejected'
      ? [{ id: `${h.id}-ev`, type: 'observation' as const, description: h.evidence, source, strength: 0.8 }]
      : [],
    proposedBy: source,
    relevantAgents: [source],
    createdAt: h.formedAt,
    updatedAt: h.resolvedAt || h.formedAt,
  };
}
