// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type IdentityContractVersion = 'identity_contract@1';
export type TraceTimestampNs = string | number;

export type IdentityTraceSide = 'current' | 'reference' | 'unknown';

/** Serializable evidence only. This record never grants execution authority. */
export interface ProcessScopeEvidenceV1 {
  mode: 'exact_upid' | 'named' | 'unscoped';
  traceId: string;
  traceSide: IdentityTraceSide;
  upid?: number;
  requestedName?: string;
  identityRefId?: string;
}

export type EvidenceScopeRole = 'target' | 'global_context' | 'peer_context' | 'identity_metadata';

export interface EvidenceScopeEntryV1 {
  role: EvidenceScopeRole;
  scope: ProcessScopeEvidenceV1;
  sourceStepId?: string;
  fields?: string[];
  availability?: 'available' | 'unavailable';
  reason?: string;
  /** A peer or global observation may be measured relative to this target. */
  relativeTo?: ProcessScopeEvidenceV1;
}

export interface EvidenceScopeProvenanceV1 {
  version: 'process_scope_evidence@1';
  entries: EvidenceScopeEntryV1[];
  /** Present malformed metadata remains explicit and cannot fall back to legacy identity. */
  invalid?: true;
}

export interface EvidenceScopeMetadata {
  scopeProvenance?: EvidenceScopeProvenanceV1;
  /** Compatibility projection, derived exclusively from scopeProvenance. */
  appliedProcessScope?: ProcessScopeEvidenceV1;
  evidenceRole?: EvidenceScopeRole | 'mixed';
}

function invalidScopeProvenance(): EvidenceScopeProvenanceV1 {
  return {version: 'process_scope_evidence@1', entries: [], invalid: true};
}

function scopeRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyScopeString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function onlyScopeKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function validProcessScope(value: unknown): value is ProcessScopeEvidenceV1 {
  if (!scopeRecord(value) || !onlyScopeKeys(value,
    ['mode', 'traceId', 'traceSide', 'upid', 'requestedName', 'identityRefId'])) return false;
  if (!nonemptyScopeString(value.traceId) ||
      typeof value.traceSide !== 'string' || !['current', 'reference', 'unknown'].includes(value.traceSide) ||
      (value.identityRefId !== undefined && !nonemptyScopeString(value.identityRefId)) ||
      (value.requestedName !== undefined && !nonemptyScopeString(value.requestedName))) return false;
  if (value.mode === 'exact_upid') return typeof value.upid === 'number' && Number.isSafeInteger(value.upid) && value.upid > 0;
  if (value.mode === 'named') return value.upid === undefined && nonemptyScopeString(value.requestedName);
  return value.mode === 'unscoped' && value.upid === undefined && value.requestedName === undefined;
}

/** Defensive copying for persistence/transport. Never registers runtime scopes. */
export function copyScopeProvenance(value: unknown): EvidenceScopeProvenanceV1 | undefined {
  if (value === undefined) return undefined;
  if (!scopeRecord(value) || !onlyScopeKeys(value, ['version', 'entries', 'invalid']) ||
      value.version !== 'process_scope_evidence@1' || !Array.isArray(value.entries) || value.invalid !== undefined) {
    return invalidScopeProvenance();
  }
  const entries: EvidenceScopeEntryV1[] = [];
  for (const entry of value.entries) {
    if (!scopeRecord(entry) || !onlyScopeKeys(entry,
      ['role', 'scope', 'sourceStepId', 'fields', 'availability', 'reason', 'relativeTo']) ||
        typeof entry.role !== 'string' || !['target', 'global_context', 'peer_context', 'identity_metadata'].includes(entry.role) ||
        !validProcessScope(entry.scope) ||
        (entry.fields !== undefined && (!Array.isArray(entry.fields) || ![...entry.fields].every(nonemptyScopeString))) ||
        (entry.sourceStepId !== undefined && !nonemptyScopeString(entry.sourceStepId)) ||
        (entry.reason !== undefined && !nonemptyScopeString(entry.reason)) ||
        (entry.availability !== undefined && entry.availability !== 'available' && entry.availability !== 'unavailable') ||
        (entry.relativeTo !== undefined && (!validProcessScope(entry.relativeTo) ||
          entry.relativeTo.traceId !== entry.scope.traceId || entry.relativeTo.traceSide !== entry.scope.traceSide))) {
      return invalidScopeProvenance();
    }
    entries.push({
      role: entry.role as EvidenceScopeRole, scope: {...entry.scope},
      ...(entry.sourceStepId !== undefined ? {sourceStepId: entry.sourceStepId as string} : {}),
      ...(entry.fields !== undefined ? {fields: [...entry.fields as string[]]} : {}),
      ...(entry.availability !== undefined ? {availability: entry.availability as EvidenceScopeEntryV1['availability']} : {}),
      ...(entry.reason !== undefined ? {reason: entry.reason as string} : {}),
      ...(entry.relativeTo !== undefined ? {relativeTo: {...entry.relativeTo as ProcessScopeEvidenceV1}} : {}),
    });
  }
  return {version: 'process_scope_evidence@1', entries};
}

export function scopeMetadata(value: unknown): EvidenceScopeMetadata {
  const scopeProvenance = copyScopeProvenance(value);
  if (!scopeProvenance) return {};
  const roles = new Set(scopeProvenance.entries.map(entry => entry.role));
  const only = scopeProvenance.entries.length === 1 ? scopeProvenance.entries[0] : undefined;
  return {
    scopeProvenance,
    // Explicit undefined clears stale compatibility fields when spread over an
    // earlier result. Only truly absent provenance retains legacy behavior.
    evidenceRole: roles.size === 0 ? undefined : roles.size === 1 ? scopeProvenance.entries[0].role : 'mixed',
    appliedProcessScope: only?.role === 'target' && only.availability !== 'unavailable' &&
      only.fields?.length !== 0 ? only.scope : undefined,
  };
}

export function mergeScopeProvenance(values: readonly unknown[]): EvidenceScopeProvenanceV1 | undefined {
  const copies = values.map(copyScopeProvenance).filter((value): value is EvidenceScopeProvenanceV1 => value !== undefined);
  if (copies.some(value => value.invalid)) return invalidScopeProvenance();
  if (copies.length === 0) return undefined;
  const distinct = new Map(copies.flatMap(value => value.entries).map(entry => [JSON.stringify(entry), entry]));
  return {version: 'process_scope_evidence@1', entries: [...distinct.values()]};
}

export function scopeProvenanceForFields(value: unknown, fields: string[]): EvidenceScopeProvenanceV1 | undefined {
  const copied = copyScopeProvenance(value);
  if (!copied || copied.invalid) return copied;
  if (!Array.isArray(fields) || ![...fields].every(nonemptyScopeString)) return invalidScopeProvenance();
  const selected = new Set(fields);
  const entries = copied.entries.flatMap(entry => {
    const matchingFields = entry.fields ? entry.fields.filter(field => selected.has(field)) : [...selected];
    return matchingFields.length ? [{...entry, fields: matchingFields}] : [];
  });
  return {...copied, entries};
}

/**
 * Whether a result positively declares a field outside the target process
 * (trace-wide, peer or identity metadata). Resolve once per result. Results
 * without scope provenance, invalid provenance and fields no entry lists keep
 * their legacy reading.
 */
export function outsideTargetScopeFields(provenance: unknown): (field: string) => boolean {
  const copied = provenance === undefined ? undefined : copyScopeProvenance(provenance);
  const entries = copied && !copied.invalid ? copied.entries.filter(entry => entry.role !== 'target') : [];
  return field => nonemptyScopeString(field) && entries.some(entry => !entry.fields || entry.fields.includes(field));
}

export function identityForScopeEvidence(provenance: unknown,
  identity: IdentityResolutionV1 | undefined): IdentityResolutionV1 | undefined {
  if (!identity || provenance === undefined) return identity;
  const copied = copyScopeProvenance(provenance);
  if (!copied || copied.invalid) return undefined;
  return copied.entries.some(entry => entry.role === 'target' && entry.availability !== 'unavailable' &&
    entry.fields?.length !== 0 && entry.scope.identityRefId === identity.identityRefId) ? identity : undefined;
}

export type IdentityRole =
  | 'app_main'
  | 'render_thread'
  | 'binder_thread'
  | 'producer'
  | 'surfaceflinger'
  | 'hwc'
  | 'unknown';

export type IdentityResolutionStatus =
  | 'verified'
  | 'ambiguous'
  | 'weak'
  | 'missing'
  | 'not_required'
  | 'error';

export interface AnalysisIdentityTargetV1 {
  traceId: string;
  traceSide?: IdentityTraceSide;
  packageName?: string;
  processName?: string;
  threadName?: string;
  role?: IdentityRole;
  upid?: number;
  utid?: number;
  pid?: number;
  tid?: number;
  timeRange?: { startTs: TraceTimestampNs; endTs: TraceTimestampNs };
  source: 'user_param' | 'skill_param' | 'selection' | 'visible_window' | 'sql_filter' | 'derived';
}

export interface ResolvedProcessIdentityV1 {
  upid: number;
  pid?: number;
  processName?: string;
  packageName?: string;
  startTs?: TraceTimestampNs;
  endTs?: TraceTimestampNs;
  matchSources: string[];
  confidence: number;
}

export interface ResolvedThreadIdentityV1 {
  utid: number;
  tid?: number;
  threadName?: string;
  role?: IdentityRole;
  owningUpid?: number;
  processName?: string;
  activeRange?: { startTs?: TraceTimestampNs; endTs?: TraceTimestampNs };
  matchSources: string[];
  confidence: number;
}

export interface IdentityResolutionV1 {
  version: IdentityContractVersion;
  identityRefId: string;
  target: AnalysisIdentityTargetV1;
  status: IdentityResolutionStatus;
  processes: ResolvedProcessIdentityV1[];
  threads: ResolvedThreadIdentityV1[];
  warnings: string[];
  recommendedParams?: Record<string, string | number | boolean>;
}
