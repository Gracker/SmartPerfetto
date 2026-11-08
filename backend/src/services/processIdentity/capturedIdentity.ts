// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isDeepStrictEqual} from 'node:util';
import type {DataEnvelope} from '../../types/dataContract';
import {copyScopeProvenance, type IdentityResolutionV1} from '../../types/identityContract';
import {evidenceCaptureHash, freezeEvidenceValue} from '../evidence/evidenceCapture';
import {isIssuedEvidenceReadResolution, type CapturedEvidenceRecord, type EvidenceReadRequest,
  type EvidenceReadResolution} from '../evidence/evidenceReadView';

export interface CapturedIdentityTracePin {readonly currentTraceId?: string; readonly referenceTraceId?: string}
type TraceSide = 'current' | 'reference';

/** Display envelopes provide identifiers only, never identity status or scope. */
export function capturedIdentityReadRequests(envelopes: readonly DataEnvelope[]): readonly EvidenceReadRequest[] {
  const requests = new Map<string, EvidenceReadRequest>();
  for (const envelope of envelopes) {
    const reference = Object.fromEntries(['evidenceRefId', 'artifactId', 'sourceArtifactId', 'sourceToolCallId'].flatMap(field => {
      const value = envelope.meta?.[field as keyof DataEnvelope['meta']];
      return typeof value === 'string' && value.trim() ? [[field, value]] : [];
    }));
    if (!Object.keys(reference).length) continue;
    const key = `identity:${evidenceCaptureHash(reference)}`;
    requests.set(key, freezeEvidenceValue({key, reference, requiredColumns: [], metadataOnly: true as const}));
  }
  return Object.freeze([...requests.values()]);
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysWithin = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const integer = (value: unknown, minimum = 0): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value)
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
const optional = (value: Record<string, unknown>, key: string, valid: (item: unknown) => boolean) =>
  value[key] === undefined || valid(value[key]);

function identityShape(value: unknown): value is IdentityResolutionV1 {
  if (!record(value) || !keysWithin(value, ['version', 'identityRefId', 'target', 'status', 'processes', 'threads', 'warnings', 'recommendedParams']) ||
    value.version !== 'identity_contract@1' || !nonempty(value.identityRefId) ||
    typeof value.status !== 'string' || !['verified', 'ambiguous', 'weak', 'missing', 'not_required', 'error'].includes(value.status) ||
    !strings(value.warnings) || !Array.isArray(value.processes) || !Array.isArray(value.threads)) return false;
  const target = value.target;
  const role = (item: unknown) => typeof item === 'string' &&
    ['app_main', 'render_thread', 'binder_thread', 'producer', 'surfaceflinger', 'hwc', 'unknown'].includes(item);
  if (!record(target) || !keysWithin(target, ['traceId', 'traceSide', 'packageName', 'processName', 'threadName', 'role',
    'upid', 'utid', 'pid', 'tid', 'timeRange', 'source']) || !nonempty(target.traceId) ||
    (target.traceSide !== 'current' && target.traceSide !== 'reference') || typeof target.source !== 'string' ||
    !['user_param', 'skill_param', 'selection', 'visible_window', 'sql_filter', 'derived'].includes(target.source) ||
    ['packageName', 'processName', 'threadName'].some(key => !optional(target, key, item => typeof item === 'string')) ||
    ['upid', 'utid'].some(key => !optional(target, key, item => integer(item, 1))) ||
    ['pid', 'tid'].some(key => !optional(target, key, item => integer(item))) || !optional(target, 'role', role) ||
    !optional(target, 'timeRange', item => record(item) && keysWithin(item, ['startTs', 'endTs']) && timestamp(item.startTs) && timestamp(item.endTs))) return false;
  if (!value.processes.every(item => record(item) && keysWithin(item, ['upid', 'pid', 'processName', 'packageName', 'startTs', 'endTs', 'matchSources', 'confidence']) &&
    integer(item.upid, 1) && optional(item, 'pid', value => integer(value)) && strings(item.matchSources) &&
    typeof item.confidence === 'number' && Number.isFinite(item.confidence) &&
    ['processName', 'packageName'].every(key => optional(item, key, value => typeof value === 'string')) &&
    ['startTs', 'endTs'].every(key => optional(item, key, timestamp)))) return false;
  if (!value.threads.every(item => record(item) && keysWithin(item, ['utid', 'tid', 'threadName', 'role', 'owningUpid', 'processName', 'activeRange', 'matchSources', 'confidence']) &&
    integer(item.utid, 1) && optional(item, 'tid', value => integer(value)) && optional(item, 'owningUpid', value => integer(value, 1)) &&
    optional(item, 'role', role) && strings(item.matchSources) && typeof item.confidence === 'number' && Number.isFinite(item.confidence) &&
    ['threadName', 'processName'].every(key => optional(item, key, value => typeof value === 'string')) &&
    optional(item, 'activeRange', value => record(value) && keysWithin(value, ['startTs', 'endTs']) &&
      optional(value, 'startTs', timestamp) && optional(value, 'endTs', timestamp)))) return false;
  return optional(value, 'recommendedParams', item => record(item) && Object.values(item).every(value =>
    typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))));
}

function identityFromRecord(capture: CapturedEvidenceRecord, pin: CapturedIdentityTracePin): IdentityResolutionV1 | undefined {
  const {meta} = capture;
  const identity = meta.identityResolution;
  if (!identityShape(identity)) return undefined;
  const side = meta.traceSide;
  const expected = side === 'current' ? pin.currentTraceId : side === 'reference' ? pin.referenceTraceId : undefined;
  if (!expected || meta.traceId !== expected || identity.target.traceId !== expected || identity.target.traceSide !== side ||
    (meta.identityRefId !== undefined && meta.identityRefId !== identity.identityRefId) ||
    (meta.identityStatus !== undefined && meta.identityStatus !== identity.status)) return undefined;
  // copyScopeProvenance owns the primitive scope validation. These captured
  // descriptions are never reissued as EffectiveProcessScope authority.
  const provenance = copyScopeProvenance(meta.scopeProvenance);
  if (!provenance || provenance.invalid) return undefined;
  const targets = provenance.entries.filter(entry => entry.role === 'target' &&
    entry.availability !== 'unavailable' && entry.fields?.length !== 0);
  if (!targets.length || targets.some(entry => entry.scope.traceId !== expected || entry.scope.traceSide !== side ||
    entry.scope.identityRefId !== identity.identityRefId || entry.fields?.some(column => !capture.columns.includes(column)))) return undefined;
  const upids = new Set(targets.filter(entry => entry.scope.mode === 'exact_upid').map(entry => entry.scope.upid));
  if (upids.size > 1 || (identity.status === 'verified' && identity.processes.length !== 1)) return undefined;
  if (upids.size && (!identity.processes.length || identity.processes.some(process => !upids.has(process.upid)) ||
    (identity.target.upid !== undefined && !upids.has(identity.target.upid)) ||
    identity.threads.some(thread => thread.owningUpid !== undefined && !upids.has(thread.owningUpid)))) return undefined;
  if (identity.target.upid !== undefined && identity.processes.some(process => process.upid !== identity.target.upid)) return undefined;
  return identity;
}

/** A complete issued read set is required before deduplicating identity claims. */
export function collectCapturedIdentities(requests: readonly EvidenceReadRequest[], received: readonly EvidenceReadResolution[],
  pin: CapturedIdentityTracePin): {identities: IdentityResolutionV1[]; unresolvedSides: TraceSide[]} {
  const unknown = () => ({identities: [], unresolvedSides: ['current', 'reference'] as TraceSide[]});
  const keys = new Set(requests.map(request => request.key));
  if (!Array.isArray(received) || received.length !== keys.size || new Set(received.map(item => item?.key)).size !== keys.size ||
    received.some(item => !item || !keys.has(item.key) || !['resolved', 'missing', 'denied'].includes(item.status) ||
      !isIssuedEvidenceReadResolution(item))) return unknown();
  const candidates = new Map<string, IdentityResolutionV1>();
  const conflicts = new Set<string>();
  const unresolved = new Set<TraceSide>();
  for (const resolution of received) {
    if (resolution.status !== 'resolved') continue;
    const {meta} = resolution.record;
    if (!meta.identityResolution) continue;
    const side = meta.traceSide;
    const identity = identityFromRecord(resolution.record, pin);
    const id = meta.identityResolution.identityRefId;
    if (!identity) {
      if (nonempty(id)) conflicts.add(id);
      if (side === 'current' || side === 'reference') unresolved.add(side);
      continue;
    }
    const previous = candidates.get(id);
    if (previous && !isDeepStrictEqual(previous, identity)) {
      conflicts.add(id);
      unresolved.add(identity.target.traceSide as TraceSide);
      unresolved.add(previous.target.traceSide as TraceSide);
    } else candidates.set(id, identity);
  }
  const identities = [...candidates.values()].filter(identity => !conflicts.has(identity.identityRefId))
    .sort((left, right) => left.identityRefId.localeCompare(right.identityRefId));
  return {identities: identities.map(identity => structuredClone(identity)), unresolvedSides: [...unresolved].sort()};
}

/**
 * Resolve the process identities the run captured, through the run's own read
 * view, in one batch. `readsFingerprint` binds the pin and exactly what was
 * read; an incomplete, failed or cancelled batch yields no identities.
 */
export async function resolveRunCapturedIdentities(input: {
  dataEnvelopes: readonly DataEnvelope[];
  tracePin?: CapturedIdentityTracePin;
  resolveReferences?: (requests: readonly EvidenceReadRequest[]) => Promise<readonly EvidenceReadResolution[]>;
  signal?: AbortSignal;
}): Promise<{identities: IdentityResolutionV1[]; readsFingerprint: string}> {
  const requests = capturedIdentityReadRequests(input.dataEnvelopes);
  // Pinned before any asynchronous read can change the caller's value.
  const tracePin = freezeEvidenceValue({...input.tracePin});
  let reads: readonly EvidenceReadResolution[] | 'execution_read_failed' = [];
  if (requests.length && input.resolveReferences) {
    try {reads = await input.resolveReferences(requests);}
    catch {reads = 'execution_read_failed';}
  }
  const usable = typeof reads === 'string' || input.signal?.aborted ? [] : reads;
  return {identities: collectCapturedIdentities(requests, usable, tracePin).identities,
    readsFingerprint: evidenceCaptureHash({tracePin, requests, reads})};
}
