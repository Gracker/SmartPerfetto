// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {AsyncLocalStorage} from 'async_hooks';

import type {
  EvalPinnedEnvironmentV1,
  RunInjectionAttribution,
  RunInjectionCategory,
  RunInjectionReference,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';

export type EvaluationRole = 'baseline' | 'candidate';
export type EvaluationExposureGuarantee =
  | 'provider_request_observed'
  | 'sdk_handoff_observed'
  | 'unavailable';

export interface EvaluationInjectionRefV1 extends RunInjectionReference {
  category: RunInjectionCategory;
}

export interface EvaluationExpectedExposureV1 {
  ref: EvaluationInjectionRefV1;
  minimumGuarantee: Exclude<EvaluationExposureGuarantee, 'unavailable'>;
}

export interface EvaluationRoleInjectionContractV1 {
  schemaVersion: 1;
  role: EvaluationRole;
  mode: EvalPinnedEnvironmentV1['injections'];
  selected: RunInjectionAttribution;
  reservedTreatmentNamespace: EvaluationInjectionRefV1[];
  expectedMaterializedRefs: EvaluationInjectionRefV1[];
  expectedObservedRefs: EvaluationExpectedExposureV1[];
  forbiddenObservedRefs: EvaluationInjectionRefV1[];
  contractHash: string;
}

export interface EvaluationObservedInjectionRefV1
  extends EvaluationInjectionRefV1 {
  guarantee: EvaluationExposureGuarantee;
  placement: string;
}

export interface EvaluationExposureReceiptV1 {
  schemaVersion: 1;
  role: EvaluationRole;
  observed: EvaluationObservedInjectionRefV1[];
  observedHash: string;
  pendingDiscarded: number;
  sealed: true;
  contentHash: string;
}

interface PendingExposure {
  sequence: number;
  ref: EvaluationInjectionRefV1;
  placement: string;
  state: 'pending' | 'committed' | 'discarded';
  guarantee?: EvaluationExposureGuarantee;
}

interface EvaluationInjectionState {
  contract: EvaluationRoleInjectionContractV1;
  nextSequence: number;
  entries: PendingExposure[];
  sealed: boolean;
}

const context = new AsyncLocalStorage<EvaluationInjectionState>();
const CATEGORIES: RunInjectionCategory[] = [
  'patterns',
  'skillNotes',
  'cases',
  'phaseHints',
  'knowledgeDocs',
];

function refKey(ref: EvaluationInjectionRefV1): string {
  return `${ref.category}\0${ref.id}\0${ref.contentHash}`;
}

function logicalKey(ref: Pick<EvaluationInjectionRefV1, 'category' | 'id'>):
string {
  return `${ref.category}\0${ref.id}`;
}

function normalizeRef(
  value: EvaluationInjectionRefV1,
): EvaluationInjectionRefV1 {
  if (
    !CATEGORIES.includes(value.category)
    || typeof value.id !== 'string'
    || !value.id.trim()
    || !/^[0-9a-f]{64}$/.test(value.contentHash)
  ) {
    throw new Error('evaluation_injection_ref_invalid');
  }
  return {
    category: value.category,
    id: value.id,
    contentHash: value.contentHash,
  };
}

function normalizeRefs(
  values: readonly EvaluationInjectionRefV1[],
): EvaluationInjectionRefV1[] {
  const refs = values.map(normalizeRef).sort((left, right) =>
    refKey(left).localeCompare(refKey(right)));
  if (new Set(refs.map(refKey)).size !== refs.length) {
    throw new Error('evaluation_injection_ref_duplicate');
  }
  return refs;
}

function selectedRefKeys(selected: RunInjectionAttribution): Set<string> {
  return new Set(CATEGORIES.flatMap(category =>
    selected[category].map(ref => refKey({...ref, category}))));
}

export function createEvaluationRoleInjectionContract(input: Omit<
  EvaluationRoleInjectionContractV1,
  'schemaVersion' | 'contractHash'
>): EvaluationRoleInjectionContractV1 {
  const reservedTreatmentNamespace = normalizeRefs(
    input.reservedTreatmentNamespace,
  );
  const expectedMaterializedRefs = normalizeRefs(
    input.expectedMaterializedRefs,
  );
  const forbiddenObservedRefs = normalizeRefs(input.forbiddenObservedRefs);
  const expectedObservedRefs = input.expectedObservedRefs.map(entry => ({
    ref: normalizeRef(entry.ref),
    minimumGuarantee: entry.minimumGuarantee,
  })).sort((left, right) => refKey(left.ref).localeCompare(refKey(right.ref)));
  if (
    new Set(expectedObservedRefs.map(entry => refKey(entry.ref))).size
    !== expectedObservedRefs.length
  ) {
    throw new Error('evaluation_expected_observation_duplicate');
  }
  const forbiddenKeys = new Set(forbiddenObservedRefs.map(refKey));
  if (expectedObservedRefs.some(entry => forbiddenKeys.has(refKey(entry.ref)))) {
    throw new Error('evaluation_observation_contract_conflict');
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    role: input.role,
    mode: input.mode,
    selected: immutableCanonicalSnapshot(input.selected),
    reservedTreatmentNamespace,
    expectedMaterializedRefs,
    expectedObservedRefs,
    forbiddenObservedRefs,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contractHash: canonicalContentHash(withoutHash),
  });
}

function requireState(): EvaluationInjectionState {
  const state = context.getStore();
  if (!state) throw new Error('evaluation_injection_context_missing');
  if (state.sealed) throw new Error('evaluation_injection_context_sealed');
  return state;
}

function namespaceContains(
  refs: readonly EvaluationInjectionRefV1[],
  ref: EvaluationInjectionRefV1,
): boolean {
  const key = logicalKey(ref);
  return refs.some(candidate => logicalKey(candidate) === key);
}

export interface EvaluationInjectionDecision {
  allowed: boolean;
  pendingSequence?: number;
  classification?: 'ambient' | 'treatment';
}

function evaluationInjectionDecision(input: {
  category: RunInjectionCategory;
  id: string;
  contentHash: string;
}): EvaluationInjectionDecision {
  const state = context.getStore();
  if (!state) return {allowed: true};
  if (state.sealed) throw new Error('evaluation_injection_context_sealed');
  const ref = normalizeRef(input);
  const contract = state.contract;
  const treatment = namespaceContains(
    contract.reservedTreatmentNamespace,
    ref,
  );
  const exactTreatment = contract.expectedMaterializedRefs.some(
    expected => refKey(expected) === refKey(ref),
  );
  const forbidden = contract.forbiddenObservedRefs.some(
    expected => refKey(expected) === refKey(ref),
  );
  let allowed = contract.mode === 'on';
  if (contract.mode === 'selective') {
    allowed = selectedRefKeys(contract.selected).has(refKey(ref));
  }
  if (treatment && !exactTreatment) allowed = false;
  if (forbidden) allowed = false;
  if (!allowed) return {allowed: false};
  return {
    allowed: true,
    classification: treatment ? 'treatment' : 'ambient',
  };
}

export function isEvaluationInjectionAllowed(input: {
  category: RunInjectionCategory;
  id: string;
  contentHash: string;
}): boolean {
  return evaluationInjectionDecision(input).allowed;
}

export function registerEvaluationInjection(input: {
  category: RunInjectionCategory;
  id: string;
  contentHash: string;
  placement: string;
}): EvaluationInjectionDecision {
  const decision = evaluationInjectionDecision(input);
  if (!decision.allowed) return decision;
  const state = context.getStore();
  if (!state) return decision;
  const ref = normalizeRef(input);
  const sequence = state.nextSequence++;
  state.entries.push({
    sequence,
    ref,
    placement: input.placement,
    state: 'pending',
  });
  return {
    allowed: true,
    pendingSequence: sequence,
    classification: decision.classification,
  };
}

export function evaluationExposureCursor(): number {
  const state = context.getStore();
  return state?.nextSequence ?? 0;
}

export function commitEvaluationExposureSince(
  cursor: number,
  guarantee: Exclude<EvaluationExposureGuarantee, 'unavailable'>,
): void {
  const state = requireState();
  for (const entry of state.entries) {
    if (entry.sequence < cursor || entry.state !== 'pending') continue;
    entry.state = 'committed';
    entry.guarantee = guarantee;
  }
}

export function commitEvaluationProviderRequest(input: {
  payload: unknown;
  cursor?: number;
}): void {
  const state = requireState();
  const payload = typeof input.payload === 'string'
    ? input.payload
    : canonicalJsonString(input.payload);
  for (const entry of state.entries) {
    if (
      entry.sequence < (input.cursor ?? 0)
      || entry.state === 'discarded'
    ) {
      continue;
    }
    if (
      !payload.includes(entry.ref.contentHash)
      && !payload.includes(entry.ref.id)
    ) {
      continue;
    }
    entry.state = 'committed';
    entry.guarantee = 'provider_request_observed';
  }
}

export function discardPendingEvaluationExposures(cursor = 0): void {
  const state = context.getStore();
  if (!state || state.sealed) return;
  for (const entry of state.entries) {
    if (entry.sequence >= cursor && entry.state === 'pending') {
      entry.state = 'discarded';
    }
  }
}

function guaranteeRank(value: EvaluationExposureGuarantee): number {
  if (value === 'provider_request_observed') return 2;
  if (value === 'sdk_handoff_observed') return 1;
  return 0;
}

export function sealEvaluationExposureReceipt():
EvaluationExposureReceiptV1 {
  const state = requireState();
  discardPendingEvaluationExposures();
  state.sealed = true;
  const observed = state.entries
    .filter((entry): entry is PendingExposure & {
      guarantee: EvaluationExposureGuarantee;
    } => entry.state === 'committed' && entry.guarantee !== undefined)
    .map(entry => ({
      ...entry.ref,
      guarantee: entry.guarantee,
      placement: entry.placement,
    }))
    .sort((left, right) =>
      refKey(left).localeCompare(refKey(right))
      || left.placement.localeCompare(right.placement)
      || guaranteeRank(right.guarantee) - guaranteeRank(left.guarantee));
  const deduplicated = [...new Map(observed.map(entry => [
    `${refKey(entry)}\0${entry.placement}`,
    entry,
  ])).values()];
  const observedHash = canonicalContentHash(deduplicated);
  const withoutHash = {
    schemaVersion: 1 as const,
    role: state.contract.role,
    observed: deduplicated,
    observedHash,
    pendingDiscarded: state.entries.filter(
      entry => entry.state === 'discarded',
    ).length,
    sealed: true as const,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

export function assertEvaluationExposureMatchesContract(input: {
  contract: EvaluationRoleInjectionContractV1;
  receipt: EvaluationExposureReceiptV1;
}): void {
  const {contractHash, ...contractWithoutHash} = input.contract;
  const {contentHash, ...receiptWithoutHash} = input.receipt;
  if (
    canonicalContentHash(contractWithoutHash) !== contractHash
    || canonicalContentHash(receiptWithoutHash) !== contentHash
    || input.receipt.observedHash
      !== canonicalContentHash(input.receipt.observed)
  ) {
    throw new Error('evaluation_exposure_receipt_hash_mismatch');
  }
  if (input.contract.role !== input.receipt.role) {
    throw new Error('evaluation_exposure_role_mismatch');
  }
  const observed = new Map<string, EvaluationObservedInjectionRefV1>();
  for (const entry of input.receipt.observed) {
    const key = refKey(entry);
    const existing = observed.get(key);
    if (
      !existing
      || guaranteeRank(entry.guarantee) > guaranteeRank(existing.guarantee)
    ) {
      observed.set(key, entry);
    }
  }
  const expectedKeys = new Set(
    input.contract.expectedObservedRefs.map(entry => refKey(entry.ref)),
  );
  for (const expected of input.contract.expectedObservedRefs) {
    const actual = observed.get(refKey(expected.ref));
    if (
      !actual
      || guaranteeRank(actual.guarantee)
        < guaranteeRank(expected.minimumGuarantee)
    ) {
      throw new Error('evaluation_expected_exposure_missing');
    }
  }
  if (input.contract.forbiddenObservedRefs.some(ref =>
    observed.has(refKey(ref)))) {
    throw new Error('evaluation_forbidden_exposure_observed');
  }
  const treatmentLogicalKeys = new Set(
    input.contract.reservedTreatmentNamespace.map(logicalKey),
  );
  if ([...observed.values()].some(entry =>
    treatmentLogicalKeys.has(logicalKey(entry))
    && !expectedKeys.has(refKey(entry)))) {
    throw new Error('evaluation_undeclared_treatment_exposure');
  }
}

export async function withEvaluationInjectionContext<T>(input: {
  contract: EvaluationRoleInjectionContractV1;
}, callback: () => Promise<T>): Promise<T> {
  const state: EvaluationInjectionState = {
    contract: input.contract,
    nextSequence: 0,
    entries: [],
    sealed: false,
  };
  return context.run(state, callback);
}

export function currentEvaluationInjectionContract():
EvaluationRoleInjectionContractV1 | undefined {
  return context.getStore()?.contract;
}

export const __testing = {
  logicalKey,
  refKey,
};
