// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Trace vendor resolution from the device identity the trace itself records.
 *
 * The OEM, SoC and OS of a trace are read from `metadata` only
 * (`android_device_manufacturer`, `android_build_fingerprint`,
 * `android_soc_model`, `android_sdk_version`) through closed lookup tables.
 * Slice names are never consulted: app and framework strings such as
 * `com.google.*` or `AIDL::…Iface::` say nothing about the device, and matching
 * them once labelled every canonical trace `harmonyos`.
 *
 * HarmonyOS is an OS, not a vendor. It is reported only when the trace format
 * detector said so and no scope of the trace carries Android identity.
 */

import type {QueryResult, TraceInfo, TraceProcessorService} from '../traceProcessorService';
import {
  isTraceProcessorQueryCancelledError,
  raceWithTraceProcessorCancellation,
} from '../traceProcessorCancellation';
import {getLruCacheEntry, setLruCacheEntry} from '../../agentRuntime/runtimeCache';
import {
  assertQuerySucceeded,
  rowsToObjects,
  toNullableNumber,
  toOptionalString,
} from '../../utils/traceProcessorRowUtils';

export const TRACE_VENDOR_SCHEMA_VERSION = 'trace_vendor@1' as const;

/** Longest a single caller waits for a vendor hint before answering without one. */
export const VENDOR_HINT_WAIT_MS = 1500;

/** Lifetime of the shared metadata query, independent of any caller's wait. */
export const VENDOR_RESOLVE_TIMEOUT_MS = 10_000;

const TRACE_VENDOR_CACHE_ENTRIES = 32;
const EVIDENCE_STRING_LIMIT = 128;

export const TRACE_VENDOR_METADATA_NAMES = [
  'android_device_manufacturer',
  'android_build_fingerprint',
  'android_soc_model',
  'android_sdk_version',
] as const;

/**
 * `SELECT *` rather than a column list: processors that predate the
 * `trace_id`/`machine_id` columns still answer, and their rows read as one
 * scopeless scope. It also stays inside the pure-read grammar, so it never
 * taints native provenance on a shared processor.
 */
export const TRACE_VENDOR_METADATA_SQL =
  `SELECT * FROM metadata WHERE name IN (${TRACE_VENDOR_METADATA_NAMES.map(name => `'${name}'`).join(', ')})`;

export type OemVendorId =
  | 'pixel' | 'xiaomi' | 'oppo' | 'vivo' | 'honor' | 'huawei' | 'samsung'
  | 'aosp' | 'other' | 'unknown';
export type SocVendorId = 'qualcomm' | 'mtk' | 'google_tensor' | 'samsung_exynos' | 'unknown';
export type TraceVendorOs = 'android' | 'harmonyos' | 'unknown';
export type TraceVendorConfidence = 'high' | 'medium' | 'low';
export type TraceVendorSource =
  | 'metadata_manufacturer' | 'metadata_fingerprint' | 'soc_model' | 'trace_os' | 'none' | 'query_failed';
export type TraceVendorFailure = 'query_error' | 'timeout' | 'cancelled';

export interface TraceVendorScopeIdentity {
  traceId: number | null;
  machineId: number | null;
  vendor: OemVendorId;
  brand?: string;
  soc: SocVendorId;
}

export interface TraceVendorEvidence {
  manufacturer?: string;
  fingerprintBrand?: string;
  socModel?: string;
  sdk?: number;
  /** The manufacturer and the fingerprint brand name different vendors; the manufacturer won. */
  manufacturerBrandMismatch?: true;
  /** Number of identity scopes when the trace carries more than one. */
  scopeCount?: number;
  /** Two scopes resolve to different devices; no override is suggested. */
  scopeConflict?: true;
  /** The identity each scope resolved to, listed when `scopeConflict` is set. */
  scopeIdentities?: TraceVendorScopeIdentity[];
  /** The format detector said HarmonyOS but a scope carries Android identity. */
  osConflict?: true;
  failure?: TraceVendorFailure;
}

export interface TraceVendorResolution {
  schemaVersion: typeof TRACE_VENDOR_SCHEMA_VERSION;
  vendor: OemVendorId;
  /** Normalized raw brand, present only when `vendor === 'other'`. */
  brand?: string;
  soc: SocVendorId;
  os: TraceVendorOs;
  confidence: TraceVendorConfidence;
  source: TraceVendorSource;
  evidence: TraceVendorEvidence;
}

export interface TraceVendorMetadataRow {
  name: string;
  strValue?: string | null;
  intValue?: number | null;
  traceId?: number | null;
  machineId?: number | null;
}

type TraceOs = TraceInfo['traceOs'];

// =============================================================================
// Closed mapping tables
// =============================================================================

const BRAND_VENDOR: ReadonlyMap<string, OemVendorId> = new Map([
  ['google', 'pixel'],
  ['xiaomi', 'xiaomi'],
  ['redmi', 'xiaomi'],
  ['poco', 'xiaomi'],
  ['oppo', 'oppo'],
  ['vivo', 'vivo'],
  ['iqoo', 'vivo'],
  ['honor', 'honor'],
  // Huawei and Honor are separate companies; neither implies the other.
  ['huawei', 'huawei'],
  ['samsung', 'samsung'],
  ['android', 'aosp'],
  ['generic', 'aosp'],
  ['aosp', 'aosp'],
]);

const AOSP_PRODUCT = /^(aosp|sdk)_/i;

const SOC_PATTERNS: ReadonlyArray<readonly [RegExp, SocVendorId]> = [
  [/^(SM|SDM|QCM|QCS)\d/i, 'qualcomm'],
  [/^MT\d/i, 'mtk'],
  [/^Tensor/i, 'google_tensor'],
  [/^(s5e|Exynos)/i, 'samsung_exynos'],
];

/** Whether the vendor names an OEM: `aosp`, `other` and `unknown` do not. */
export function isOemVendor(vendor: string): boolean {
  return vendor !== 'aosp' && vendor !== 'other' && vendor !== 'unknown';
}

interface BrandIdentity {
  vendor: OemVendorId;
  brand?: string;
}

function brandIdentity(raw: string | undefined): BrandIdentity | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  const vendor = BRAND_VENDOR.get(normalized);
  return vendor ? {vendor} : {vendor: 'other', brand: normalized};
}

function sameBrandIdentity(a: BrandIdentity, b: BrandIdentity): boolean {
  return a.vendor === b.vendor && a.brand === b.brand;
}

/** `brand/product/device:release/id/incremental:type/tags`. */
function parseFingerprint(fingerprint: string | undefined): {brand?: string; product?: string} {
  if (!fingerprint) return {};
  const parts = fingerprint.trim().split('/');
  if (parts.length < 2) return {};
  return {brand: parts[0] || undefined, product: parts[1] || undefined};
}

export function socFromModel(model: string | undefined): SocVendorId {
  const value = model?.trim();
  if (!value) return 'unknown';
  for (const [pattern, soc] of SOC_PATTERNS) if (pattern.test(value)) return soc;
  return 'unknown';
}

// =============================================================================
// Pure resolution
// =============================================================================

interface ScopeFields {
  traceId: number | null;
  machineId: number | null;
  manufacturer?: string;
  fingerprint?: string;
  socModel?: string;
  sdk?: number;
}

interface ScopeResolution extends BrandIdentity {
  soc: SocVendorId;
  source: TraceVendorSource;
  /** `medium` exactly when the manufacturer and the fingerprint brand disagree. */
  confidence: TraceVendorConfidence;
  fingerprintBrand?: string;
}

function resolveScope(fields: ScopeFields): ScopeResolution {
  const soc = socFromModel(fields.socModel);
  const fingerprint = parseFingerprint(fields.fingerprint);
  const fromManufacturer = brandIdentity(fields.manufacturer);
  const fromFingerprint: BrandIdentity | undefined = fingerprint.product && AOSP_PRODUCT.test(fingerprint.product)
    ? {vendor: 'aosp'}
    : brandIdentity(fingerprint.brand);
  const base = {soc, fingerprintBrand: fingerprint.brand};
  if (fromManufacturer) {
    const mismatch = Boolean(fromFingerprint && !sameBrandIdentity(fromManufacturer, fromFingerprint));
    return {...base, ...fromManufacturer, source: 'metadata_manufacturer',
      confidence: mismatch ? 'medium' : 'high'};
  }
  if (fromFingerprint) {
    return {...base, ...fromFingerprint, source: 'metadata_fingerprint', confidence: 'high'};
  }
  return {...base, vendor: 'unknown', source: soc === 'unknown' ? 'none' : 'soc_model',
    confidence: 'low'};
}

function boundedEvidence(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.slice(0, EVIDENCE_STRING_LIMIT);
}

/** Perfetto's own `metadata_for_primary_scope` ordering: non-NULL before NULL, lowest id first. */
function compareScopes(a: ScopeFields, b: ScopeFields): number {
  const nullOrder = (value: number | null) => (value === null ? 1 : 0);
  return nullOrder(a.traceId) - nullOrder(b.traceId)
    || (a.traceId ?? 0) - (b.traceId ?? 0)
    || nullOrder(a.machineId) - nullOrder(b.machineId)
    || (a.machineId ?? 0) - (b.machineId ?? 0);
}

function groupScopes(rows: readonly TraceVendorMetadataRow[]): ScopeFields[] {
  const scopes = new Map<string, ScopeFields>();
  for (const row of rows) {
    const traceId = toNullableNumber(row.traceId);
    const machineId = toNullableNumber(row.machineId);
    const key = `${traceId ?? 'null'}|${machineId ?? 'null'}`;
    const scope = scopes.get(key) ?? {traceId, machineId};
    scopes.set(key, scope);
    // First value per name within a scope, in row order.
    switch (row.name) {
      case 'android_device_manufacturer': scope.manufacturer ??= toOptionalString(row.strValue) ?? undefined; break;
      case 'android_build_fingerprint': scope.fingerprint ??= toOptionalString(row.strValue) ?? undefined; break;
      case 'android_soc_model': scope.socModel ??= toOptionalString(row.strValue) ?? undefined; break;
      case 'android_sdk_version': scope.sdk ??= toNullableNumber(row.intValue) ?? undefined; break;
      default: break;
    }
  }
  return [...scopes.values()].sort(compareScopes);
}

function findScopeConflict(resolved: readonly ScopeResolution[]): boolean {
  const vendors = new Set<string>();
  const socs = new Set<SocVendorId>();
  resolved.forEach(scope => {
    if (scope.vendor !== 'unknown') vendors.add(`${scope.vendor}|${scope.brand ?? ''}`);
    if (scope.soc !== 'unknown') socs.add(scope.soc);
  });
  return resolved.length > 1 && (vendors.size > 1 || socs.size > 1);
}

/**
 * Resolve the vendor from `metadata` rows. Identity is read from the primary
 * scope only and never assembled from fields of different scopes; any other
 * scope that resolves to a different device makes the result a conflict.
 */
export function resolveVendorFromMetadata(
  rows: readonly TraceVendorMetadataRow[],
  options: {traceOs?: TraceOs} = {},
): TraceVendorResolution {
  const scopes = groupScopes(rows);
  const resolvedScopes = scopes.map(resolveScope);
  const primaryFields: ScopeFields = scopes[0] ?? {traceId: null, machineId: null};
  const primary = resolvedScopes[0] ?? resolveScope(primaryFields);
  const conflict = findScopeConflict(resolvedScopes);
  const androidIdentity = scopes.some(scope => scope.manufacturer !== undefined || scope.fingerprint !== undefined);

  const evidence: TraceVendorEvidence = {};
  const manufacturer = boundedEvidence(primaryFields.manufacturer);
  const fingerprintBrand = boundedEvidence(primary.fingerprintBrand);
  const socModel = boundedEvidence(primaryFields.socModel);
  if (manufacturer) evidence.manufacturer = manufacturer;
  if (fingerprintBrand) evidence.fingerprintBrand = fingerprintBrand;
  if (socModel) evidence.socModel = socModel;
  if (primaryFields.sdk !== undefined) evidence.sdk = primaryFields.sdk;
  if (primary.confidence === 'medium') evidence.manufacturerBrandMismatch = true;
  if (scopes.length > 1) evidence.scopeCount = scopes.length;
  if (conflict) {
    evidence.scopeConflict = true;
    evidence.scopeIdentities = scopes.map((scope, index) => ({
      traceId: scope.traceId,
      machineId: scope.machineId,
      vendor: resolvedScopes[index].vendor,
      ...(resolvedScopes[index].brand ? {brand: resolvedScopes[index].brand} : {}),
      soc: resolvedScopes[index].soc,
    }));
  }

  let os: TraceVendorOs;
  if (options.traceOs === 'harmonyos') {
    os = androidIdentity ? 'android' : 'harmonyos';
    if (androidIdentity) evidence.osConflict = true;
  } else {
    os = androidIdentity || options.traceOs === 'android' ? 'android' : 'unknown';
  }

  const harmony = os === 'harmonyos';
  return {
    schemaVersion: TRACE_VENDOR_SCHEMA_VERSION,
    vendor: primary.vendor,
    ...(primary.vendor === 'other' && primary.brand ? {brand: primary.brand} : {}),
    soc: primary.soc,
    os,
    confidence: conflict || harmony ? 'low' : primary.confidence,
    source: harmony && primary.vendor === 'unknown' ? 'trace_os' : primary.source,
    evidence,
  };
}

/** Read `metadata` rows by column name; `undefined` when the result lacks `name` or `str_value`. */
export function metadataRowsFromQueryResult(result: QueryResult): TraceVendorMetadataRow[] | undefined {
  if (!Array.isArray(result.rows) || !['name', 'str_value'].every(column => result.columns?.includes(column))) {
    return undefined;
  }
  return rowsToObjects(result).flatMap(row => typeof row.name !== 'string' ? [] : [{
    name: row.name,
    strValue: typeof row.str_value === 'string' ? row.str_value : null,
    intValue: toNullableNumber(row.int_value),
    traceId: toNullableNumber(row.trace_id),
    machineId: toNullableNumber(row.machine_id),
  }]);
}

export function failedTraceVendorResolution(failure: TraceVendorFailure): TraceVendorResolution {
  return {
    schemaVersion: TRACE_VENDOR_SCHEMA_VERSION,
    vendor: 'unknown',
    soc: 'unknown',
    os: 'unknown',
    confidence: 'low',
    source: 'query_failed',
    evidence: {failure},
  };
}

// =============================================================================
// Shared cached resolution
// =============================================================================

/** The service surface the resolver uses. */
export type TraceVendorQueryService = Pick<TraceProcessorService, 'query' | 'getTrace' | 'leaseCacheIdentity'>;

interface TraceVendorCacheState {
  /** Successful resolutions by trace identity: a trace fact shared by every valid caller. */
  settled: Map<string, TraceVendorResolution>;
  /** In-flight queries by (trace identity, exact lease holder). */
  inFlight: Map<string, Promise<TraceVendorResolution>>;
}

let traceVendorCaches = new WeakMap<object, TraceVendorCacheState>();
// A serializable per-registration counter for the string cache key. The
// service's own native registration token is an opaque object, which cannot
// be part of that key.
const registrationTokens = new WeakMap<object, number>();
let nextRegistrationToken = 1;

function cacheFor(service: TraceVendorQueryService): TraceVendorCacheState {
  let state = traceVendorCaches.get(service);
  if (!state) {
    state = {settled: new Map(), inFlight: new Map()};
    traceVendorCaches.set(service, state);
  }
  return state;
}

/**
 * A re-registered trace id is a new `TraceInfo` object, so the registration
 * token changes with it; path, size and the detected OS complete the key.
 */
function traceIdentity(
  service: TraceVendorQueryService,
  traceId: string,
  traceOsOverride: TraceOs | undefined,
): {key: string; traceOs: TraceOs | undefined} {
  const info = service.getTrace(traceId);
  let token: number | 'unregistered' = 'unregistered';
  if (info) {
    token = registrationTokens.get(info) ?? nextRegistrationToken++;
    registrationTokens.set(info, token);
  }
  const traceOs = traceOsOverride ?? info?.traceOs;
  return {
    key: JSON.stringify([traceId, token, info?.filePath ?? null, info?.size ?? null, traceOs ?? null]),
    traceOs,
  };
}

async function runSharedResolution(
  service: TraceVendorQueryService,
  traceId: string,
  identity: {key: string; traceOs: TraceOs | undefined},
  state: TraceVendorCacheState,
): Promise<TraceVendorResolution> {
  // Owned by the resolver, not by any caller: a caller's abort or wait bound
  // never cancels this query, only its own lifetime does.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, VENDOR_RESOLVE_TIMEOUT_MS);
  (timer as {unref?: () => void}).unref?.();
  try {
    // `query` is called before the first await, so it runs under the starting
    // caller's lease context.
    const result = await raceWithTraceProcessorCancellation(
      service.query(traceId, TRACE_VENDOR_METADATA_SQL, {signal: controller.signal}), controller.signal);
    const rows = metadataRowsFromQueryResult(assertQuerySucceeded(result));
    if (!rows) return failedTraceVendorResolution('query_error');
    const resolution = resolveVendorFromMetadata(rows, {traceOs: identity.traceOs});
    setLruCacheEntry(state.settled, identity.key, resolution, TRACE_VENDOR_CACHE_ENTRIES);
    return resolution;
  } catch (error) {
    if (timedOut) return failedTraceVendorResolution('timeout');
    return failedTraceVendorResolution(isTraceProcessorQueryCancelledError(error) ? 'cancelled' : 'query_error');
  } finally {
    clearTimeout(timer);
  }
}

type AcquiredResolution =
  | {settled: TraceVendorResolution}
  | {pending: Promise<TraceVendorResolution>};

/**
 * Start or join the shared resolution for this caller. Throws the query
 * layer's cancellation error when the caller's lease is not active; that
 * check runs before any cached value is returned or joined.
 */
function acquireResolution(
  service: TraceVendorQueryService,
  traceId: string,
  options: {traceOs?: TraceOs},
): AcquiredResolution {
  const lease = service.leaseCacheIdentity(traceId);
  const identity = traceIdentity(service, traceId, options.traceOs);
  const state = cacheFor(service);
  // A scoped context without a holder is accepted for any valid holder of its
  // lease, so it cannot prove it may see another caller's answer. It runs its
  // own query under its own context; a success still fills the settled cache.
  if (lease === null) {
    return {pending: runSharedResolution(service, traceId, identity, state)};
  }
  const hit = getLruCacheEntry(state.settled, identity.key);
  if (hit) return {settled: hit};
  const flightKey = JSON.stringify([identity.key, lease]);
  const existing = state.inFlight.get(flightKey);
  if (existing) return {pending: existing};
  const pending = runSharedResolution(service, traceId, identity, state);
  state.inFlight.set(flightKey, pending);
  void pending.then(() => {
    if (state.inFlight.get(flightKey) === pending) state.inFlight.delete(flightKey);
  });
  return {pending};
}

/**
 * Resolve the vendor of a trace, waiting for the shared query (itself bounded
 * by `VENDOR_RESOLVE_TIMEOUT_MS`). A failed query returns a `query_failed`
 * resolution that is never cached. Throws the query layer's cancellation
 * error when the caller's lease is not active.
 */
export async function resolveTraceVendor(
  service: TraceVendorQueryService,
  traceId: string,
  options: {traceOs?: TraceOs} = {},
): Promise<TraceVendorResolution> {
  const acquired = acquireResolution(service, traceId, options);
  return 'settled' in acquired ? acquired.settled : acquired.pending;
}

function waitBounded<T>(promise: Promise<T>, waitMs: number, signal: AbortSignal | undefined): Promise<T | undefined> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: T | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), waitMs);
    signal?.addEventListener('abort', onAbort, {once: true});
    promise.then(finish, () => finish(undefined));
  });
}

/**
 * Best-effort resolution for an optional hint. Never rejects: an inactive
 * lease, a failed or timed-out query, the caller's abort, or a wait longer
 * than `waitMs` all answer `undefined`. With `waitMs <= 0` only an already
 * settled resolution is returned; otherwise the query is started (or joined)
 * so a later call can use it.
 */
export async function awaitTraceVendorHint(
  service: TraceVendorQueryService,
  traceId: string,
  options: {traceOs?: TraceOs; waitMs?: number; signal?: AbortSignal} = {},
): Promise<TraceVendorResolution | undefined> {
  if (options.signal?.aborted) return undefined;
  let acquired: AcquiredResolution;
  try {
    acquired = acquireResolution(service, traceId, options);
  } catch {
    return undefined;
  }
  if ('settled' in acquired) return acquired.settled;
  const waitMs = options.waitMs ?? VENDOR_HINT_WAIT_MS;
  if (waitMs <= 0) return undefined;
  const resolution = await waitBounded(acquired.pending, waitMs, options.signal);
  return resolution && resolution.source !== 'query_failed' ? resolution : undefined;
}

/** Numeric confidence kept for the REST contract: unknown vendors and failures report 0. */
export function numericVendorConfidence(resolution: TraceVendorResolution): number {
  if (resolution.vendor === 'unknown' || resolution.source === 'query_failed') return 0;
  return resolution.confidence === 'high' ? 0.9 : resolution.confidence === 'medium' ? 0.7 : 0.4;
}

/** @internal Test isolation only; production invalidates by trace identity, service disposal or LRU. */
export function clearTraceVendorCacheForTests(): void {
  traceVendorCaches = new WeakMap();
}
