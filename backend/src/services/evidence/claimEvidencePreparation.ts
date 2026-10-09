// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {ConclusionBindingEligibility, ConclusionContract, ConclusionContractClaimReference} from '../../agent/core/conclusionContract';
import type {EvidenceRelationCandidateV1} from '../../types/evidenceContract';
import type {DataEnvelope} from '../../types/dataContract';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {evidenceCaptureHash, freezeEvidenceValue} from './evidenceCapture';
import {isIssuedEvidenceReadResolution, type EvidenceReadRequest, type EvidenceReadResolution, type EvidenceReadView} from './evidenceReadView';
import {capturedIdentityReadRequests, collectCapturedIdentities, type CapturedIdentityTracePin} from '../processIdentity/capturedIdentity';

export interface PreparedClaimEvidence {readonly kind: 'prepared_claim_evidence'; readonly fingerprint: string}
export interface PrepareClaimEvidenceInput {
  conclusionContract?: ConclusionContract | null;
  relationCandidates?: readonly EvidenceRelationCandidateV1[];
  bindingEligibility?: ConclusionBindingEligibility;
  evidenceReadView?: EvidenceReadView;
  /** Display metadata contributes locators only; claim eligibility is separate. */
  identityDataEnvelopes?: readonly DataEnvelope[];
  identityTracePin?: CapturedIdentityTracePin;
  signal?: AbortSignal;
}
export interface PreparedClaimEvidenceSnapshot {
  readonly schemaVersion: 'prepared_claim_evidence@1';
  readonly fingerprint: string;
  readonly bindingEligibility: ConclusionBindingEligibility;
  readonly reads: readonly unknown[];
}
interface PreparedState {
  inputFingerprint: string;
  resolutions: ReadonlyMap<string, EvidenceReadResolution>;
  identityRequests: readonly EvidenceReadRequest[];
  identityResolutions: readonly EvidenceReadResolution[];
  identityTracePin: CapturedIdentityTracePin;
  snapshot: PreparedClaimEvidenceSnapshot;
}
const preparedStates = new WeakMap<PreparedClaimEvidence, PreparedState>();
export const evidenceReferenceKey = (reference: ConclusionContractClaimReference): string => evidenceCaptureHash(reference);

function inputFingerprint(contract: ConclusionContract | null | undefined, relations: readonly EvidenceRelationCandidateV1[] | undefined): string {
  return evidenceCaptureHash({contract: contract || null, relations: relations || contract?.relationProposals || []});
}

export async function prepareClaimEvidence(input: PrepareClaimEvidenceInput): Promise<PreparedClaimEvidence> {
  const fingerprintInput = inputFingerprint(input.conclusionContract, input.relationCandidates);
  const eligibility = input.bindingEligibility === 'ineligible' || input.conclusionContract?.bindingEligibility === 'ineligible'
    ? 'ineligible' : input.bindingEligibility || input.conclusionContract?.bindingEligibility || 'legacy_unchecked';
  const refs = new Map<string, {reference: ConclusionContractClaimReference; columns: Set<string>}>();
  const add = (reference: ConclusionContractClaimReference | undefined, columns: string[] = []) => {
    if (!reference) return;
    const key = evidenceReferenceKey(reference);
    const existing = refs.get(key) || {reference: structuredClone(reference), columns: new Set<string>()};
    [...columns, ...(reference.column ? [reference.column] : []), ...Object.keys(reference.rowSelector || {})]
      .forEach(column => existing.columns.add(column));
    refs.set(key, existing);
  };
  for (const claim of input.conclusionContract?.claims || []) {
    // An invalid claim is never anchored or verified (plan A.5), so its
    // references claim none of the shared read budget.
    if (claim.valid === false) continue;
    claim.references?.forEach(ref => add(ref));
    claim.artifactRefs?.forEach(ref => add(ref as ConclusionContractClaimReference));
    claim.semantics?.scope.subjectRefs?.forEach(ref => add(ref));
    claim.semantics?.scope.objectRefs?.forEach(ref => add(ref));
  }
  for (const candidate of input.relationCandidates || input.conclusionContract?.relationProposals || []) {
    add(candidate.subject); add(candidate.object); add(candidate.proof);
    for (const [side, ref] of [['subject', candidate.subject], ['object', candidate.object]] as const) {
      if (!ref) continue;
      const column = candidate.proofBindings?.[side].endpointColumn || candidate.metricColumn;
      if (column) add({...ref, column});
    }
    if (candidate.proof && candidate.proofBindings) {
      const {column: _column, value: _value, ...rowReference} = candidate.proof;
      add(rowReference, [candidate.proofBindings.subject.proofColumn, candidate.proofBindings.object.proofColumn]);
    }
  }
  const requests: EvidenceReadRequest[] = [...refs].map(([key, value]) => freezeEvidenceValue({key,
    reference: value.reference, requiredColumns: [...value.columns].sort()}));
  const identityRequests = capturedIdentityReadRequests(input.identityDataEnvelopes ?? []);
  const identityTracePin = freezeEvidenceValue({...input.identityTracePin});
  // Claims consume the shared read budget first. Identity-only reads cannot
  // supply the claim map, including when the declaration is ineligible.
  const activeRequests = [...(eligibility === 'eligible' ? requests : []), ...identityRequests];
  let received: readonly EvidenceReadResolution[] = [];
  let readFailure: string | undefined;
  if (activeRequests.length && input.evidenceReadView) {
    try {received = await input.evidenceReadView.resolveReferences(Object.freeze(activeRequests), input.signal);}
    catch {readFailure = input.signal?.aborted ? 'read_cancelled' : 'execution_read_failed';}
  }
  const map = new Map<string, EvidenceReadResolution>();
  for (const request of requests) {
    const matches = eligibility === 'eligible' && Array.isArray(received) ? received.filter(result => result?.key === request.key) : [];
    const result = matches.length === 1 && isIssuedEvidenceReadResolution(matches[0]) ? matches[0] : undefined;
    map.set(request.key, result || Object.freeze({key: request.key, status: 'missing', reason:
      eligibility !== 'eligible' ? 'binding_ineligible' : readFailure || (input.signal?.aborted ? 'read_cancelled' : 'execution_read_unavailable')}));
  }
  const activeKeys = new Set(activeRequests.map(request => request.key));
  const batchComplete = !input.signal?.aborted && Array.isArray(received) && received.length === activeRequests.length &&
    new Set(received.map(result => result?.key)).size === activeRequests.length &&
    received.every(result => result && activeKeys.has(result.key));
  const identityResolutions: EvidenceReadResolution[] = identityRequests.map(request => {
    const resolution = batchComplete ? received.find(result => result.key === request.key) : undefined;
    return resolution && isIssuedEvidenceReadResolution(resolution) ? resolution : Object.freeze({key: request.key,
      status: 'incomplete', reason: readFailure || 'identity_read_incomplete'});
  });
  const reads = freezeEvidenceValue(JSON.parse(JSON.stringify([...map.values(), ...identityResolutions])) as unknown[]);
  const fingerprint = evidenceCaptureHash({input: fingerprintInput, eligibility, identityTracePin, reads});
  const prepared: PreparedClaimEvidence = Object.freeze({kind: 'prepared_claim_evidence', fingerprint});
  preparedStates.set(prepared, {inputFingerprint: fingerprintInput, resolutions: map,
    identityRequests, identityResolutions: Object.freeze(identityResolutions), identityTracePin,
    snapshot: freezeEvidenceValue({schemaVersion: 'prepared_claim_evidence@1', fingerprint, bindingEligibility: eligibility, reads})});
  return prepared;
}

export function preparedClaimEvidenceSnapshot(prepared: PreparedClaimEvidence): PreparedClaimEvidenceSnapshot {
  const state = preparedStates.get(prepared);
  if (!state) throw new Error('Unissued prepared evidence');
  return state.snapshot;
}
export function preparedEvidenceMatchesInput(prepared: PreparedClaimEvidence, contract: ConclusionContract | null | undefined,
  relations: readonly EvidenceRelationCandidateV1[] | undefined): boolean {
  return preparedStates.get(prepared)?.inputFingerprint === inputFingerprint(contract, relations);
}
export function preparedReferenceResolution(prepared: PreparedClaimEvidence, ref: ConclusionContractClaimReference): EvidenceReadResolution | undefined {
  return preparedStates.get(prepared)?.resolutions.get(evidenceReferenceKey(ref));
}
export function preparedEvidenceBindingEligibility(prepared: PreparedClaimEvidence): ConclusionBindingEligibility {
  return preparedStates.get(prepared)?.snapshot.bindingEligibility || 'ineligible';
}

/** Serialized handles/snapshots cannot recreate the issued identity read set. */
export function preparedIdentityResolutions(prepared: PreparedClaimEvidence): IdentityResolutionV1[] {
  const state = preparedStates.get(prepared);
  return state ? collectCapturedIdentities(state.identityRequests, state.identityResolutions, state.identityTracePin).identities : [];
}
