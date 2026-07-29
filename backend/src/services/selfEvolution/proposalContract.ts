// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CurationProposalV1,
  ProposalDelta,
} from '../../types/selfEvolution';
import {
  PROPOSAL_KINDS,
  PROPOSAL_TIERS,
} from '../../types/selfEvolution';
import {immutableCanonicalSnapshot} from './canonicalJson';

const HASH_RE = /^[0-9a-f]{64}$/;

export function parseM6DraftProposal(value: unknown): CurationProposalV1 {
  const proposal = requireRecord(value, 'proposal');
  assertExactKeys(proposal, [
    'schemaVersion',
    'proposalId',
    'revision',
    'idempotencyKey',
    'kind',
    'tier',
    'title',
    'rationale',
    'deltas',
    'expectedRegistryFingerprint',
    'expectedOverlayGeneration',
    'evidence',
    'pairedGateVerdict',
    'expectedEffect',
    'riskLevel',
    'status',
    'scope',
    'createdAt',
  ], 'proposal');
  if (proposal.schemaVersion !== 1) fail('proposal_schema_invalid');
  requireNonEmptyString(proposal.proposalId, 'proposal_id_invalid');
  if (proposal.revision !== 1) fail('proposal_revision_invalid');
  if (
    typeof proposal.idempotencyKey !== 'string' ||
    !HASH_RE.test(proposal.idempotencyKey)
  ) {
    fail('proposal_idempotency_key_invalid');
  }
  if (!PROPOSAL_KINDS.includes(proposal.kind as never)) {
    fail('proposal_kind_invalid');
  }
  if (!PROPOSAL_TIERS.includes(proposal.tier as never)) {
    fail('proposal_tier_invalid');
  }
  requireBoundedText(proposal.title, 'proposal_title_invalid', 240);
  requireBoundedText(proposal.rationale, 'proposal_rationale_invalid', 4000);
  requireBoundedText(
    proposal.expectedEffect,
    'proposal_expected_effect_invalid',
    2000,
  );
  if (!['low', 'medium', 'high'].includes(String(proposal.riskLevel))) {
    fail('proposal_risk_level_invalid');
  }
  if (proposal.status !== 'draft') fail('proposal_status_invalid_for_m6');
  if (proposal.pairedGateVerdict !== 'not_run') {
    fail('proposal_gate_verdict_invalid_for_m6');
  }
  if (!Array.isArray(proposal.deltas) || proposal.deltas.length !== 1) {
    fail('proposal_m6_requires_one_delta');
  }
  const delta = parseDelta(proposal.deltas[0]);
  const scope = parseScope(proposal.scope);
  const evidence = parseEvidence(proposal.evidence);
  if (
    typeof proposal.expectedRegistryFingerprint !== 'string' ||
    !HASH_RE.test(proposal.expectedRegistryFingerprint)
  ) {
    fail('proposal_registry_fingerprint_invalid');
  }
  requireNonEmptyString(
    proposal.expectedOverlayGeneration,
    'proposal_overlay_generation_invalid',
  );
  if (
    typeof proposal.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(proposal.createdAt))
  ) {
    fail('proposal_created_at_invalid');
  }
  assertKindDeltaMapping(
    String(proposal.kind),
    String(proposal.tier),
    delta,
  );
  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    revision: 1,
    idempotencyKey: proposal.idempotencyKey,
    kind: proposal.kind,
    tier: proposal.tier,
    title: proposal.title,
    rationale: proposal.rationale,
    deltas: [delta],
    expectedRegistryFingerprint: proposal.expectedRegistryFingerprint,
    expectedOverlayGeneration: proposal.expectedOverlayGeneration,
    evidence,
    pairedGateVerdict: 'not_run',
    expectedEffect: proposal.expectedEffect,
    riskLevel: proposal.riskLevel,
    status: 'draft',
    scope,
    createdAt: proposal.createdAt,
  } as CurationProposalV1);
}

function parseDelta(value: unknown): ProposalDelta {
  const delta = requireRecord(value, 'proposal.delta');
  assertExactKeys(delta, [
    'op',
    'targetKind',
    'targetId',
    'operationId',
    'anchor',
    'baseContentHash',
    'before',
    'after',
  ], 'proposal.delta', ['before', 'after']);
  if (!['add', 'modify', 'remove'].includes(String(delta.op))) {
    fail('proposal_delta_op_invalid');
  }
  if (![
    'skill_overlay',
    'strategy_overlay',
    'skill_note',
    'injection',
  ].includes(String(delta.targetKind))) {
    fail('proposal_delta_target_kind_invalid');
  }
  for (const [field, code] of [
    ['targetId', 'proposal_delta_target_id_invalid'],
    ['operationId', 'proposal_delta_operation_id_invalid'],
    ['anchor', 'proposal_delta_anchor_invalid'],
  ] as const) {
    requireNonEmptyString(delta[field], code);
  }
  if (
    typeof delta.baseContentHash !== 'string' ||
    !HASH_RE.test(delta.baseContentHash)
  ) {
    fail('proposal_delta_base_hash_invalid');
  }
  if (
    delta.before !== undefined &&
    typeof delta.before !== 'string'
  ) {
    fail('proposal_delta_before_invalid');
  }
  if (
    delta.after !== undefined &&
    (typeof delta.after !== 'string' || !delta.after.trim())
  ) {
    fail('proposal_delta_after_invalid');
  }
  if (delta.op === 'remove' && delta.after !== undefined) {
    fail('proposal_delta_remove_after_forbidden');
  }
  if (delta.op !== 'remove' && delta.after === undefined) {
    fail('proposal_delta_after_required');
  }
  return {
    op: delta.op as ProposalDelta['op'],
    targetKind: delta.targetKind as ProposalDelta['targetKind'],
    targetId: delta.targetId as string,
    operationId: delta.operationId as string,
    anchor: delta.anchor as string,
    baseContentHash: delta.baseContentHash as string,
    ...(delta.before !== undefined ? {before: delta.before as string} : {}),
    ...(delta.after !== undefined ? {after: delta.after as string} : {}),
  };
}

function parseEvidence(value: unknown): CurationProposalV1['evidence'] {
  const evidence = requireRecord(value, 'proposal.evidence');
  assertExactKeys(evidence, [
    'negativeRunIds',
    'positiveRunIds',
    'labeledCount',
    'negativeCount',
    'distinctTraceCount',
    'distinctSessionCount',
    'statisticalVerdict',
  ], 'proposal.evidence');
  const negativeRunIds = parseSortedUniqueStrings(
    evidence.negativeRunIds,
    'proposal_negative_run_ids_invalid',
  );
  const positiveRunIds = parseSortedUniqueStrings(
    evidence.positiveRunIds,
    'proposal_positive_run_ids_invalid',
  );
  for (const field of [
    'labeledCount',
    'negativeCount',
    'distinctTraceCount',
    'distinctSessionCount',
  ] as const) {
    if (
      !Number.isSafeInteger(evidence[field]) ||
      Number(evidence[field]) < 0
    ) {
      fail(`proposal_${field}_invalid`);
    }
  }
  if (
    evidence.statisticalVerdict !== 'hypothesis_only' ||
    Number(evidence.labeledCount) < 8 ||
    Number(evidence.negativeCount) < 3 ||
    Number(evidence.negativeCount) > Number(evidence.labeledCount) ||
    negativeRunIds.length === 0 ||
    Number(evidence.distinctTraceCount) < 1 ||
    Number(evidence.distinctSessionCount) < 1
  ) {
    fail('proposal_evidence_threshold_invalid');
  }
  return {
    negativeRunIds,
    positiveRunIds,
    labeledCount: Number(evidence.labeledCount),
    negativeCount: Number(evidence.negativeCount),
    distinctTraceCount: Number(evidence.distinctTraceCount),
    distinctSessionCount: Number(evidence.distinctSessionCount),
    statisticalVerdict: 'hypothesis_only',
  };
}

function parseScope(value: unknown): CurationProposalV1['scope'] {
  const scope = requireRecord(value, 'proposal.scope');
  assertExactKeys(scope, ['tenantId', 'workspaceId'], 'proposal.scope');
  requireNonEmptyString(scope.tenantId, 'proposal_tenant_id_invalid');
  requireNonEmptyString(scope.workspaceId, 'proposal_workspace_id_invalid');
  return {
    tenantId: scope.tenantId as string,
    workspaceId: scope.workspaceId as string,
  };
}

function assertKindDeltaMapping(
  kind: string,
  tier: string,
  delta: ProposalDelta,
): void {
  if (
    kind === 'skill_note' &&
    (
      tier !== 'T1' ||
      delta.targetKind !== 'skill_note' ||
      parseCanonicalAnchorId(
        delta.anchor,
        /^skillNotes\[skillId=(.+)\]$/,
        'proposal_skill_note_mapping_invalid',
      ) !== delta.targetId
    )
  ) {
    fail('proposal_skill_note_mapping_invalid');
  }
  if (kind === 'retire_injection') {
    const match = /^injections\.(phaseHints|skillNotes)\[id=(.+)\]$/.exec(
      delta.anchor,
    );
    if (!match) fail('proposal_retire_mapping_invalid');
    const category = match[1] as 'phaseHints' | 'skillNotes';
    const targetId = parseCanonicalJsonString(
      match[2],
      'proposal_retire_mapping_invalid',
    );
    const expectedTier = category === 'phaseHints' ? 'T0' : 'T1';
    if (
      tier !== expectedTier ||
      delta.targetKind !== 'injection' ||
      delta.op !== 'remove' ||
      targetId !== delta.targetId
    ) {
      fail('proposal_retire_mapping_invalid');
    }
  }
}

function parseCanonicalAnchorId(
  anchor: string,
  pattern: RegExp,
  code: string,
): string {
  const match = pattern.exec(anchor);
  if (!match) fail(code);
  return parseCanonicalJsonString(match[1], code);
}

function parseCanonicalJsonString(value: string, code: string): string {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string' || JSON.stringify(parsed) !== value) {
      fail(code);
    }
    return parsed;
  } catch {
    fail(code);
  }
}

function parseSortedUniqueStrings(value: unknown, code: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(item => typeof item !== 'string' || !item.trim())
  ) {
    fail(code);
  }
  const items = value as string[];
  if (
    new Set(items).size !== items.length ||
    [...items].sort().some((item, index) => item !== items[index])
  ) {
    fail(code);
  }
  return [...items];
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  optionalKeys: readonly string[] = [],
): void {
  const allowed = new Set(allowedKeys);
  const optional = new Set(optionalKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  const missing = allowedKeys.filter(key =>
    !optional.has(key) &&
    !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail(
      `${path}_keys_invalid:unknown=${unknown.sort().join(',')}:missing=${missing.sort().join(',')}`,
    );
  }
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path}_object_required`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, code: string): void {
  if (typeof value !== 'string' || !value.trim()) fail(code);
}

function requireBoundedText(
  value: unknown,
  code: string,
  maxLength: number,
): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maxLength
  ) {
    fail(code);
  }
}

function fail(code: string): never {
  throw new Error(code);
}
