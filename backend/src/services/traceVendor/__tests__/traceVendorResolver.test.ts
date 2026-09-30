// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {analyzeRawSqlDirectProjection} from '../../evidence/rawSqlDirectProjection';
import {applyEnterpriseMinimalSchema} from '../../enterpriseSchema';
import type {EnterpriseRepositoryScope} from '../../enterpriseRepository';
import {setTraceProcessorLeaseStoreForTests, TraceProcessorLeaseStore} from '../../traceProcessorLeaseStore';
import {TraceProcessorFactory} from '../../workingTraceProcessor';
import {TraceProcessorService, type QueryResult, type TraceProcessor} from '../../traceProcessorService';
import {createTraceProcessorQueryCancelledError} from '../../traceProcessorCancellation';
import {
  awaitTraceVendorHint,
  clearTraceVendorCacheForTests,
  metadataRowsFromQueryResult,
  numericVendorConfidence,
  resolveTraceVendor,
  resolveVendorFromMetadata,
  socFromModel,
  TRACE_VENDOR_METADATA_SQL,
  VENDOR_HINT_WAIT_MS,
  VENDOR_RESOLVE_TIMEOUT_MS,
  type TraceVendorMetadataRow,
} from '../traceVendorResolver';
import {selectVendorOverride, vendorOverrideLookupOrder} from '../../skillEngine/vendorOverrideSelection';
import type {VendorOverride} from '../../skillEngine/skillLoader';
import {
  metadataQueryResult as metadataResult,
  metadataRows as rowsFor,
  vendorQueryServiceDouble,
  XIAOMI_FIELDS as XIAOMI,
  type VendorMetadataFields as Fields,
} from './traceVendorFixture';

/** The resolution plus the override lookup order the Skill engine derives from it. */
function resolveWithLookup(rows: readonly TraceVendorMetadataRow[], options?: Parameters<typeof resolveVendorFromMetadata>[1]) {
  const result = resolveVendorFromMetadata(rows, options);
  return {...result, lookupOrder: vendorOverrideLookupOrder(result)};
}

// Ground truth read from `metadata` with the pinned trace processor
// (plan E2): the six canonical traces plus the external device corpus.
const REAL_TUPLES: Array<{
  label: string; fields: Fields;
  vendor: string; brand?: string; soc: string; source: string; lookupOrder: string[];
}> = [
  {label: 'android-scroll-customer (OPPO)', fields: {manufacturer: 'OPPO',
    fingerprint: 'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.2a01376-7328d8-769621:user/release-keys', soc: 'SM8750', sdk: 36},
  vendor: 'oppo', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['oppo', 'qualcomm']},
  {label: 'android-scroll-standard (nubia, NULL manufacturer)', fields: {
    fingerprint: 'nubia/pacific/pacific:15/1.4.1.0/101:user/release-keys', soc: 'SM8750', sdk: 35},
  vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint', lookupOrder: ['qualcomm']},
  {label: 'android-startup-heavy (Xiaomi)', fields: XIAOMI,
    vendor: 'xiaomi', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['xiaomi', 'qualcomm']},
  {label: 'android-startup-light (Google)', fields: {manufacturer: 'Google',
    fingerprint: 'google/raven_beta/raven:16/BP31.250523.010/13667654:user/release-keys', soc: 'Tensor', sdk: 36},
  vendor: 'pixel', soc: 'google_tensor', source: 'metadata_manufacturer', lookupOrder: ['pixel', 'google_tensor']},
  {label: 'flutter-scroll-surface-view (nubia)', fields: {
    fingerprint: 'nubia/pacific/pacific:15/1.4.1.0/101:user/release-keys', soc: 'SM8750', sdk: 35},
  vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint', lookupOrder: ['qualcomm']},
  {label: 'flutter-scroll-texture-view (nubia)', fields: {
    fingerprint: 'nubia/pacific/pacific:15/1.4.1.0/101:user/release-keys', soc: 'SM8750', sdk: 35},
  vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint', lookupOrder: ['qualcomm']},
  {label: 'pixel6pro-api37 device_startup_cold', fields: {manufacturer: 'Google',
    fingerprint: 'google/raven_beta/raven:CinnamonBun/CP31.260508.005.A1/15421647:user/release-keys', soc: 'Tensor'},
  vendor: 'pixel', soc: 'google_tensor', source: 'metadata_manufacturer', lookupOrder: ['pixel', 'google_tensor']},
  {label: 'nubia-p0110-api36 rooted_startup_cold', fields: {manufacturer: 'nubia',
    fingerprint: 'nubia/pacific/pacific:16/2.6.2.0/20260910.125229:user/test-keys', soc: 'SM8750'},
  vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['qualcomm']},
  {label: 'hpc Honor-300-Pro (Android 16, not Harmony)', fields: {manufacturer: 'HONOR',
    fingerprint: 'HONOR/AMP-AN00/HNAMP:16/HONORAMP-AN00/10DLDLD111C00E110:user/release-keys', soc: 'SM8650'},
  vendor: 'honor', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['honor', 'qualcomm']},
  {label: 'hpc OppoFindN5', fields: {manufacturer: 'OPPO',
    fingerprint: 'OPPO/PKH110/OP5DC1L1:16/AP3A.240617.008/V.5a4fdef-38f2ae7-391dd8e:user/release-keys', soc: 'SM8750'},
  vendor: 'oppo', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['oppo', 'qualcomm']},
  {label: 'hpc VivoX300Pro', fields: {manufacturer: 'vivo',
    fingerprint: 'vivo/PD2502/PD2502:16/BP2A.250605.031.A3_V000L1/compiler251016035215:user/release-keys', soc: 'MT6993(ENG)'},
  vendor: 'vivo', soc: 'mtk', source: 'metadata_manufacturer', lookupOrder: ['vivo', 'mtk']},
  {label: 'hpc Xiaomi-17-Pro', fields: {manufacturer: 'Xiaomi',
    fingerprint: 'Xiaomi/pandora/pandora:16/BP2A.250605.031.A3/OS3.0.41.0.WBLCNXM:user/release-keys', soc: 'SM8850'},
  vendor: 'xiaomi', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['xiaomi', 'qualcomm']},
  {label: 'hpc Pixel-6-Pro', fields: {manufacturer: 'Google',
    fingerprint: 'google/raven_beta/raven:16/CP11.251209.007/14691661:user/release-keys', soc: 'Tensor'},
  vendor: 'pixel', soc: 'google_tensor', source: 'metadata_manufacturer', lookupOrder: ['pixel', 'google_tensor']},
  {label: 'hpc doubao (P0110)', fields: {manufacturer: 'nubia',
    fingerprint: 'nubia/pacific/pacific:16/BQ2A.250705.001-BP2A.250605.031.A3/20260204.125753:user/release-keys', soc: 'SM8750'},
  vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_manufacturer', lookupOrder: ['qualcomm']},
  {label: 'hpc DUT-WP62 (OUKITEL, NULL manufacturer)', fields: {
    fingerprint: 'OUKITEL/WP62_A15_EEA/WP62:15/AP3A.240905.015.A2/2025491:user/release-keys', soc: 'MT6855'},
  vendor: 'other', brand: 'oukitel', soc: 'mtk', source: 'metadata_fingerprint', lookupOrder: ['mtk']},
  {label: 'hpc REF-Xever-7-Pro (RugOne, NULL manufacturer)', fields: {
    fingerprint: 'RugOne/GR1000BF1/GR1000BF1:15/AP3A.240905.015.A2/1773216964:user/release-keys', soc: 'MT6855'},
  vendor: 'other', brand: 'rugone', soc: 'mtk', source: 'metadata_fingerprint', lookupOrder: ['mtk']},
];

describe('resolveVendorFromMetadata: real device tuples', () => {
  it.each(REAL_TUPLES)('$label -> $vendor / $soc', tuple => {
    const result = resolveWithLookup(rowsFor(tuple.fields), {traceOs: 'android'});
    expect(result).toMatchObject({
      schemaVersion: 'trace_vendor@1', vendor: tuple.vendor, soc: tuple.soc, os: 'android',
      source: tuple.source, confidence: 'high', lookupOrder: tuple.lookupOrder,
    });
    expect(result.brand).toBe(tuple.brand);
    expect(result.vendor).not.toBe('harmonyos');
    expect(result.evidence.socModel).toBe(tuple.fields.soc);
    if (tuple.fields.manufacturer) expect(result.evidence.manufacturer).toBe(tuple.fields.manufacturer);
    else expect(result.evidence.manufacturer).toBeUndefined();
  });
});

describe('resolveVendorFromMetadata: closed tables and precedence', () => {
  it.each([
    ['Redmi', 'xiaomi'], ['POCO', 'xiaomi'], ['iQOO', 'vivo'], ['HUAWEI', 'huawei'], ['HONOR', 'honor'],
    ['samsung', 'samsung'], ['Google', 'pixel'], ['generic', 'aosp'], ['Android', 'aosp'],
    ['OnePlus', 'other'], ['realme', 'other'],
  ])('manufacturer %s -> %s by exact match', (manufacturer, vendor) => {
    expect(resolveWithLookup(rowsFor({manufacturer})).vendor).toBe(vendor);
  });

  it('keeps Huawei and Honor apart', () => {
    expect(resolveWithLookup(rowsFor({manufacturer: 'HUAWEI'})).lookupOrder).toEqual(['huawei']);
    expect(resolveWithLookup(rowsFor({manufacturer: 'Huawei Honor'})).vendor).toBe('other');
  });

  it('never matches a brand by substring', () => {
    for (const manufacturer of ['Googlephone', 'my-vivo-clone', 'xiaomiish']) {
      expect(resolveWithLookup(rowsFor({manufacturer})).vendor).toBe('other');
    }
  });

  it('uses the manufacturer at medium confidence when the fingerprint brand disagrees', () => {
    const result = resolveWithLookup(rowsFor({manufacturer: 'OPPO',
      fingerprint: 'OnePlus/CPH2581/OP5929L1:15/AP3A/1:user/release-keys', soc: 'SM8650'}));
    expect(result).toMatchObject({vendor: 'oppo', source: 'metadata_manufacturer', confidence: 'medium',
      evidence: {manufacturer: 'OPPO', fingerprintBrand: 'OnePlus', manufacturerBrandMismatch: true}});
  });

  it('treats Redmi fingerprints on Xiaomi manufacturer as agreement', () => {
    const result = resolveWithLookup(rowsFor({manufacturer: 'Xiaomi', fingerprint: 'Redmi/x/y:15/a/b:user/release-keys'}));
    expect(result).toMatchObject({vendor: 'xiaomi', confidence: 'high'});
    expect(result.evidence.manufacturerBrandMismatch).toBeUndefined();
  });

  it('resolves AOSP build fingerprints to aosp', () => {
    expect(resolveWithLookup(rowsFor({fingerprint: 'Android/aosp_raven/raven:16/BP2A/1:userdebug/test-keys'})))
      .toMatchObject({vendor: 'aosp', source: 'metadata_fingerprint', lookupOrder: []});
    expect(resolveWithLookup(rowsFor({fingerprint: 'google/sdk_gphone64_arm64/emu64a:15/AE3A/1:user/release-keys'})))
      .toMatchObject({vendor: 'aosp'});
  });

  it('reports unknown, not aosp, when nothing identifies the device', () => {
    expect(resolveWithLookup([])).toMatchObject({vendor: 'unknown', soc: 'unknown', os: 'unknown',
      source: 'none', confidence: 'low', lookupOrder: []});
    expect(resolveWithLookup(rowsFor({manufacturer: '  ', fingerprint: ''}))).toMatchObject({vendor: 'unknown'});
    expect(resolveWithLookup(rowsFor({soc: 'SM8750'}))).toMatchObject({vendor: 'unknown', soc: 'qualcomm',
      source: 'soc_model', lookupOrder: ['qualcomm']});
  });

  it.each([
    ['SM8750', 'qualcomm'], ['SDM845', 'qualcomm'], ['QCM6490', 'qualcomm'], ['QCS8550', 'qualcomm'],
    ['MT6993(ENG)', 'mtk'], ['MT6855', 'mtk'], ['Tensor', 'google_tensor'], ['Tensor G4', 'google_tensor'],
    ['s5e9945', 'samsung_exynos'], ['Exynos 2400', 'samsung_exynos'],
    ['Kirin 9000', 'unknown'], ['XSM8750', 'unknown'], ['', 'unknown'], [undefined, 'unknown'],
  ])('SoC %s -> %s by anchored pattern', (model, soc) => {
    expect(socFromModel(model)).toBe(soc);
  });
});

describe('resolveVendorFromMetadata: HarmonyOS only from traceOs', () => {
  it('reports harmonyos when the format detector said so and no scope carries Android identity', () => {
    expect(resolveWithLookup([], {traceOs: 'harmonyos'})).toMatchObject({vendor: 'unknown', os: 'harmonyos',
      source: 'trace_os', confidence: 'low', lookupOrder: []});
  });

  it('reports android with an os conflict when a harmonyos trace carries a fingerprint or manufacturer', () => {
    for (const fields of [{fingerprint: XIAOMI.fingerprint}, {manufacturer: 'HONOR'}]) {
      const result = resolveWithLookup(rowsFor(fields), {traceOs: 'harmonyos'});
      expect(result.os).toBe('android');
      expect(result.evidence.osConflict).toBe(true);
    }
  });

  it('lets any scope veto harmonyos, not only the primary one', () => {
    const rows = [
      ...rowsFor({soc: 'SM8750'}, {traceId: null, machineId: 0}),
      ...rowsFor({fingerprint: 'nubia/pacific/pacific:15/1/1:user/release-keys'}, {traceId: null, machineId: 1}),
    ];
    const result = resolveWithLookup(rows, {traceOs: 'harmonyos'});
    expect(result).toMatchObject({os: 'android', evidence: {osConflict: true}});
    // The primary scope has no identity of its own: nothing is borrowed.
    expect(result.vendor).toBe('unknown');
  });

  it('reports unknown os without traceOs or Android identity, android when traceOs says so', () => {
    expect(resolveWithLookup([]).os).toBe('unknown');
    expect(resolveWithLookup([], {traceOs: 'android'}).os).toBe('android');
    expect(resolveWithLookup(rowsFor(XIAOMI)).os).toBe('android');
  });
});

describe('resolveVendorFromMetadata: one identity scope', () => {
  const xiaomiFp = XIAOMI.fingerprint!;
  const googleFp = 'google/raven_beta/raven:16/BP31/1:user/release-keys';

  it('marks two machines with different manufacturers as a low-confidence conflict with no hint', () => {
    const result = resolveWithLookup([
      ...rowsFor({manufacturer: 'Xiaomi', soc: 'SM8850'}, {machineId: 0}),
      ...rowsFor({manufacturer: 'Google', soc: 'Tensor'}, {machineId: 1}),
    ]);
    expect(result).toMatchObject({vendor: 'xiaomi', confidence: 'low', lookupOrder: [],
      evidence: {scopeConflict: true, scopeCount: 2}});
    expect(result.evidence.scopeIdentities).toHaveLength(2);
  });

  it('marks merged traces with different fingerprints as a conflict', () => {
    const result = resolveWithLookup([
      ...rowsFor({fingerprint: xiaomiFp}, {traceId: 0, machineId: 0}),
      ...rowsFor({fingerprint: googleFp}, {traceId: 1, machineId: 0}),
    ]);
    expect(result).toMatchObject({vendor: 'xiaomi', confidence: 'low', lookupOrder: [], evidence: {scopeConflict: true}});
  });

  it('treats identical identity across scopes as one device', () => {
    const result = resolveWithLookup([
      ...rowsFor(XIAOMI, {machineId: 0}),
      ...rowsFor(XIAOMI, {machineId: 1}),
    ]);
    expect(result).toMatchObject({vendor: 'xiaomi', confidence: 'high', lookupOrder: ['xiaomi', 'qualcomm'],
      evidence: {scopeCount: 2}});
    expect(result.evidence.scopeConflict).toBeUndefined();
  });

  it('accepts scopeless rows as the single primary scope', () => {
    expect(resolveWithLookup(rowsFor(XIAOMI, {traceId: null, machineId: null})))
      .toMatchObject({vendor: 'xiaomi', confidence: 'high', lookupOrder: ['xiaomi', 'qualcomm']});
  });

  it('never borrows a manufacturer from another scope', () => {
    const agreeing = resolveWithLookup([
      ...rowsFor({fingerprint: 'nubia/pacific/pacific:15/1/1:user/release-keys', soc: 'SM8750'}, {machineId: 0}),
      ...rowsFor({manufacturer: 'nubia'}, {machineId: 1}),
    ]);
    expect(agreeing).toMatchObject({vendor: 'other', brand: 'nubia', source: 'metadata_fingerprint'});
    expect(agreeing.evidence.manufacturer).toBeUndefined();
    expect(agreeing.evidence.scopeConflict).toBeUndefined();
  });

  it('flags a google-fingerprint primary against a Xiaomi manufacturer in another scope', () => {
    const result = resolveWithLookup([
      ...rowsFor({fingerprint: googleFp}, {machineId: 0}),
      ...rowsFor({manufacturer: 'Xiaomi'}, {machineId: 1}),
    ]);
    expect(result).toMatchObject({vendor: 'pixel', source: 'metadata_fingerprint', confidence: 'low',
      lookupOrder: [], evidence: {scopeConflict: true}});
    expect(result.evidence.manufacturer).toBeUndefined();
  });

  it('flags two other-brand scopes with different brands', () => {
    const result = resolveWithLookup([
      ...rowsFor({fingerprint: 'nubia/pacific/pacific:15/1/1:user/release-keys', soc: 'MT6855'}, {machineId: 0}),
      ...rowsFor({fingerprint: 'OUKITEL/WP62/WP62:15/1/1:user/release-keys', soc: 'MT6855'}, {machineId: 1}),
    ]);
    expect(result).toMatchObject({vendor: 'other', brand: 'nubia', confidence: 'low', lookupOrder: [],
      evidence: {scopeConflict: true}});
  });

  it('flags different known SoCs but not a scope whose identity is unknown', () => {
    expect(resolveWithLookup([
      ...rowsFor({manufacturer: 'Xiaomi', soc: 'SM8850'}, {machineId: 0}),
      ...rowsFor({manufacturer: 'Xiaomi', soc: 'MT6855'}, {machineId: 1}),
    ]).evidence.scopeConflict).toBe(true);
    const tolerant = resolveWithLookup([
      ...rowsFor(XIAOMI, {machineId: 0}),
      ...rowsFor({sdk: 36}, {machineId: 1}),
    ]);
    expect(tolerant.evidence.scopeConflict).toBeUndefined();
    expect(tolerant.lookupOrder).toEqual(['xiaomi', 'qualcomm']);
  });

  it('orders scopes exactly like metadata_for_primary_scope', () => {
    // Non-NULL trace_id wins over NULL.
    expect(resolveWithLookup([
      ...rowsFor({manufacturer: 'Google'}, {traceId: null, machineId: 0}),
      ...rowsFor({manufacturer: 'Xiaomi'}, {traceId: 3, machineId: 0}),
    ]).vendor).toBe('xiaomi');
    // Lowest trace_id first.
    expect(resolveWithLookup([
      ...rowsFor({manufacturer: 'Google'}, {traceId: 2, machineId: 0}),
      ...rowsFor({manufacturer: 'Xiaomi'}, {traceId: 1, machineId: 0}),
    ]).vendor).toBe('xiaomi');
    // Within a trace, non-NULL machine_id wins over NULL.
    expect(resolveWithLookup([
      ...rowsFor({manufacturer: 'Google'}, {traceId: 0, machineId: null}),
      ...rowsFor({manufacturer: 'Xiaomi'}, {traceId: 0, machineId: 4}),
    ]).vendor).toBe('xiaomi');
  });
});

describe('selectVendorOverride', () => {
  const overrides: Record<string, Partial<VendorOverride>> = {
    xiaomi: {vendor: 'xiaomi', additionalSteps: []},
    qualcomm: {vendor: 'qualcomm', displayName: 'Qualcomm', additionalSteps: [{id: 'qcom_step'}, {name: 'named_step'}, {}]},
  };
  const registry = {getVendorOverride: (_skillId: string, vendor: string) => overrides[vendor] as VendorOverride | undefined};

  it('takes the first override in OEM-then-SoC order that adds steps', () => {
    expect(selectVendorOverride(registry, 'startup_analysis', resolveVendorFromMetadata(rowsFor(XIAOMI))))
      .toEqual({vendor: 'qualcomm', displayName: 'Qualcomm', additionalStepIds: ['qcom_step', 'named_step']});
  });

  it('suggests nothing without a resolution or for conflicting scopes', () => {
    expect(selectVendorOverride(registry, 'startup_analysis', undefined)).toBeUndefined();
    const conflict = resolveVendorFromMetadata([
      ...rowsFor({manufacturer: 'Xiaomi', soc: 'SM8850'}, {machineId: 0}),
      ...rowsFor({manufacturer: 'Google', soc: 'Tensor'}, {machineId: 1}),
    ]);
    expect(selectVendorOverride(registry, 'startup_analysis', conflict)).toBeUndefined();
  });
});

describe('metadata query contract', () => {
  it('reads metadata only, never slice, inside the pure-read grammar', () => {
    expect(TRACE_VENDOR_METADATA_SQL).not.toMatch(/\bslice\b/i);
    expect(TRACE_VENDOR_METADATA_SQL).toMatch(/\bFROM metadata\b/);
    const analysis = analyzeRawSqlDirectProjection(TRACE_VENDOR_METADATA_SQL);
    expect(analysis).toMatchObject({pureRead: true, relation: {name: 'metadata'}});
  });

  it('reads rows by column name and tolerates processors without scope columns', () => {
    expect(metadataRowsFromQueryResult({columns: ['name', 'str_value', 'int_value'],
      rows: [['android_device_manufacturer', 'Xiaomi', null], ['android_sdk_version', null, 36]], durationMs: 0}))
      .toEqual([
        {name: 'android_device_manufacturer', strValue: 'Xiaomi', intValue: null, traceId: null, machineId: null},
        {name: 'android_sdk_version', strValue: null, intValue: 36, traceId: null, machineId: null},
      ]);
    expect(metadataRowsFromQueryResult({columns: ['foo'], rows: [], durationMs: 0})).toBeUndefined();
  });

  it('keeps a numeric confidence for REST clients', () => {
    const xiaomi = resolveVendorFromMetadata(rowsFor(XIAOMI));
    expect(numericVendorConfidence(xiaomi)).toBe(0.9);
    expect(numericVendorConfidence({...xiaomi, confidence: 'medium'})).toBe(0.7);
    expect(numericVendorConfidence({...xiaomi, confidence: 'low'})).toBe(0.4);
    expect(numericVendorConfidence(resolveVendorFromMetadata([]))).toBe(0);
  });
});

// =============================================================================
// Shared cache, waits and failures (stub services, fake timers where timing matters)
// =============================================================================

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {resolve = res; reject = rej;});
  return {promise, resolve, reject};
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function stubService(query: (sql: string, options?: {signal?: AbortSignal}) => Promise<QueryResult>) {
  const spy = jest.fn(async (_traceId: string, sql: string, options?: {signal?: AbortSignal}) => query(sql, options));
  return {service: vendorQueryServiceDouble(spy), query: spy};
}

describe('resolveTraceVendor cache', () => {
  beforeEach(() => clearTraceVendorCacheForTests());
  afterEach(() => { jest.useRealTimers(); });

  it('caches every successful resolution per trace identity, including unknown', async () => {
    const {service, query} = stubService(async () => metadataResult([]));
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'unknown', source: 'none'});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'unknown'});
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toBe(TRACE_VENDOR_METADATA_SQL);
  });

  it('keeps the cache across runtime resets: it belongs to the trace, not to a caller', async () => {
    // Runtimes hold no vendor state, so a runtime reset leaves only fresh
    // callers: here the adapter path, then an invoke_skill hint that never waits.
    const {service, query} = stubService(async () => metadataResult(rowsFor(XIAOMI)));
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    await expect(awaitTraceVendorHint(service, 't', {waitMs: 0})).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed query, whether it reports an error or throws', async () => {
    let calls = 0;
    const {service, query} = stubService(async () => {
      calls += 1;
      if (calls === 1) return {columns: [], rows: [], durationMs: 0, error: 'no such table: metadata'};
      if (calls === 2) throw new Error('processor crashed');
      return metadataResult(rowsFor(XIAOMI));
    });
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'unknown', source: 'query_failed',
      evidence: {failure: 'query_error'}});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({source: 'query_failed'});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('keeps a separate cache per processor service', async () => {
    const first = stubService(async () => metadataResult(rowsFor(XIAOMI)));
    const second = stubService(async () => metadataResult(rowsFor({manufacturer: 'Google'})));
    await expect(resolveTraceVendor(first.service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    await expect(resolveTraceVendor(second.service, 't')).resolves.toMatchObject({vendor: 'pixel'});
  });

  it('misses when the trace is registered again or its detected OS changes', async () => {
    const trace: Record<string, unknown> = {id: 't', filePath: '/tmp/a.pftrace', size: 1, traceOs: 'android'};
    let rows = rowsFor(XIAOMI);
    const getTrace = jest.fn(() => trace);
    const query = jest.fn(async () => metadataResult(rows));
    const service = vendorQueryServiceDouble(query, getTrace);
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    rows = rowsFor({manufacturer: 'Google'});
    getTrace.mockReturnValue({...trace});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'pixel'});
    rows = [];
    getTrace.mockReturnValue({...trace, traceOs: 'harmonyos'});
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({os: 'harmonyos'});
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight query between callers of the same lease context', async () => {
    const release = deferred<QueryResult>();
    const {service, query} = stubService(() => release.promise);
    const first = resolveTraceVendor(service, 't');
    const second = resolveTraceVendor(service, 't');
    release.resolve(metadataResult(rowsFor(XIAOMI)));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({vendor: 'xiaomi'}), expect.objectContaining({vendor: 'xiaomi'})]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns at the wait bound without a hint, evicts at the resolver timeout, then retries', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const {service, query} = stubService((_sql, options) => {
      signal = options?.signal;
      return new Promise<QueryResult>(() => undefined);
    });
    const hint = awaitTraceVendorHint(service, 't');
    await flush();
    jest.advanceTimersByTime(VENDOR_HINT_WAIT_MS);
    await expect(hint).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(false);
    // A second caller joins the same shared query rather than starting one.
    const joined = resolveTraceVendor(service, 't');
    expect(query).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(VENDOR_RESOLVE_TIMEOUT_MS);
    await expect(joined).resolves.toMatchObject({source: 'query_failed', evidence: {failure: 'timeout'}});
    expect(signal?.aborted).toBe(true);
    query.mockImplementation(async () => metadataResult(rowsFor(XIAOMI)));
    await expect(resolveTraceVendor(service, 't')).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('ends only the aborting caller\'s wait; another caller still gets the shared result', async () => {
    const release = deferred<QueryResult>();
    let signal: AbortSignal | undefined;
    const {service, query} = stubService((_sql, options) => {signal = options?.signal; return release.promise;});
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const a = awaitTraceVendorHint(service, 't', {signal: controller.signal});
      const b = awaitTraceVendorHint(service, 't');
      controller.abort();
      await expect(a).resolves.toBeUndefined();
      expect(signal?.aborted).toBe(false);
      release.resolve(metadataResult(rowsFor(XIAOMI)));
      await expect(b).resolves.toMatchObject({vendor: 'xiaomi'});
      expect(query).toHaveBeenCalledTimes(1);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('with a zero bound never waits and serves the hint once the query settled', async () => {
    const release = deferred<QueryResult>();
    const {service, query} = stubService(() => release.promise);
    await expect(awaitTraceVendorHint(service, 't', {waitMs: 0})).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    release.resolve(metadataResult(rowsFor(XIAOMI)));
    await flush();
    await expect(awaitTraceVendorHint(service, 't', {waitMs: 0})).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers no hint for a failed query and an already aborted caller', async () => {
    const {service} = stubService(async () => ({columns: [], rows: [], durationMs: 0, error: 'boom'}));
    await expect(awaitTraceVendorHint(service, 't')).resolves.toBeUndefined();
    const aborted = new AbortController();
    aborted.abort();
    const other = stubService(async () => metadataResult(rowsFor(XIAOMI)));
    await expect(awaitTraceVendorHint(other.service, 't', {signal: aborted.signal})).resolves.toBeUndefined();
    expect(other.query).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Lease ownership against the real TraceProcessorService and lease store
// =============================================================================

const scope: EnterpriseRepositoryScope = {tenantId: 'tenant-v', workspaceId: 'workspace-v', userId: 'user-v'};

function seedEnterpriseGraph(db: Database.Database, traceId: string): void {
  const now = 1_700_000_000_000;
  db.prepare(`INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES ('tenant-v', 'Tenant V', 'active', 'enterprise', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES ('workspace-v', 'tenant-v', 'Workspace V', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO trace_assets (id, tenant_id, workspace_id, local_path, status, created_at)
    VALUES (?, 'tenant-v', 'workspace-v', ?, 'ready', ?)`).run(traceId, `/tmp/${traceId}.pftrace`, now);
}

function fakeProcessor(traceId: string, answer: () => Promise<QueryResult>): TraceProcessor & {query: jest.Mock} {
  return {
    id: `fake-${traceId}`, traceId, status: 'ready', activeQueries: 0,
    query: jest.fn(answer),
    queryRaw: jest.fn(async () => Buffer.from('')),
    destroy: jest.fn(),
  } as unknown as TraceProcessor & {query: jest.Mock};
}

describe('resolver lease ownership (real service)', () => {
  let db: Database.Database | null = null;
  let tmpDir = '';

  async function fixture() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-vendor-lease-'));
    const traceId = 'vendor-lease-trace';
    const tracePath = path.join(tmpDir, `${traceId}.trace`);
    await fs.writeFile(tracePath, 'trace bytes');
    db = new Database(':memory:');
    applyEnterpriseMinimalSchema(db);
    seedEnterpriseGraph(db, traceId);
    const store = new TraceProcessorLeaseStore(db);
    setTraceProcessorLeaseStoreForTests(store);
    const lease = store.acquireHolder(scope, traceId, {holderType: 'agent_run', holderRef: 'run-a'}, {mode: 'shared'});
    store.acquireHolder(scope, traceId, {holderType: 'agent_run', holderRef: 'run-b'}, {mode: 'shared'});
    store.acquireHolder(scope, traceId, {holderType: 'agent_run', holderRef: 'run-c'}, {mode: 'shared'});
    store.markStarting(scope, lease.id); store.markReady(scope, lease.id);
    const service = new TraceProcessorService(tmpDir);
    service.registerStoredTrace({id: traceId, filename: 'fixture.trace', size: 11, filePath: tracePath});
    const context = (holderRef?: string) => ({traceId, leaseId: lease.id, mode: 'shared' as const, leaseScope: scope,
      ...(holderRef ? {holder: {holderType: 'agent_run' as const, holderRef}} : {})});
    return {traceId, tracePath, service, store, lease, context};
  }

  beforeEach(() => clearTraceVendorCacheForTests());
  afterEach(async () => {
    jest.restoreAllMocks();
    TraceProcessorFactory.cleanup();
    setTraceProcessorLeaseStoreForTests(null);
    db?.close();
    db = null;
    if (tmpDir) await fs.rm(tmpDir, {recursive: true, force: true});
    tmpDir = '';
  });

  it('reports the lease cache identity exactly as the query layer resolves the context', async () => {
    const {traceId, service, store, lease, context} = await fixture();
    const identity = (leaseContext?: Parameters<typeof service.runWithLease>[0]) => leaseContext
      ? service.runWithLease(leaseContext, async () => service.leaseCacheIdentity(traceId))
      : Promise.resolve(service.leaseCacheIdentity(traceId));
    await expect(identity()).resolves.toBe('unleased');
    const holderA = await identity(context('run-a'));
    const holderB = await identity(context('run-b'));
    expect(typeof holderA).toBe('string');
    expect(holderA).not.toBe(holderB);
    // A holderless scoped context cannot vouch for one owner: bypass the cache.
    await expect(identity(context())).resolves.toBeNull();
    const offline = await identity({traceId, leaseId: 'offline', mode: 'isolated'});
    expect(offline).not.toBe('unleased');
    expect(offline).not.toBeNull();
    // The same lease check query() runs: a released holder is refused.
    store.releaseHolder(scope, lease.id, 'agent_run', 'run-a');
    await expect(identity(context('run-a'))).rejects.toMatchObject({code: 'TRACE_PROCESSOR_QUERY_CANCELLED'});
  });

  it('evicts a released holder\'s in-flight query while another holder resolves under its own lease', async () => {
    const {traceId, service, store, lease, context} = await fixture();
    const runAQuery = deferred<QueryResult>();
    let calls = 0;
    const processor = fakeProcessor(traceId, () => {
      calls += 1;
      return calls === 1 ? runAQuery.promise : Promise.resolve(metadataResult(rowsFor(XIAOMI)));
    });
    jest.spyOn(TraceProcessorFactory, 'create').mockResolvedValue(processor as any);
    await service.ensureProcessorForLease(traceId, lease.id, lease.mode, scope);

    const a = service.runWithLease(context('run-a'), () => resolveTraceVendor(service, traceId));
    await flush();
    // run-b is a different holder of the same lease: it never joins run-a's query.
    const b = service.runWithLease(context('run-b'), () => resolveTraceVendor(service, traceId));
    store.releaseHolder(scope, lease.id, 'agent_run', 'run-a');
    runAQuery.resolve(metadataResult(rowsFor({manufacturer: 'Google'})));
    await expect(a).resolves.toMatchObject({source: 'query_failed', evidence: {failure: 'cancelled'}});
    await expect(b).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(processor.query).toHaveBeenCalledTimes(2);

    // run-c hits the settled trace fact with no new query.
    await expect(service.runWithLease(context('run-c'), () => resolveTraceVendor(service, traceId)))
      .resolves.toMatchObject({vendor: 'xiaomi'});
    expect(processor.query).toHaveBeenCalledTimes(2);
    // The released holder is refused even though a settled value exists.
    await expect(service.runWithLease(context('run-a'), () => resolveTraceVendor(service, traceId)))
      .rejects.toMatchObject({code: 'TRACE_PROCESSOR_QUERY_CANCELLED'});
    await expect(service.runWithLease(context('run-a'), () => awaitTraceVendorHint(service, traceId)))
      .resolves.toBeUndefined();
    expect(processor.query).toHaveBeenCalledTimes(2);
  });

  it('lets a holderless scoped context bypass the settled cache with its own query', async () => {
    const {traceId, service, store, lease, context} = await fixture();
    const processor = fakeProcessor(traceId, async () => metadataResult(rowsFor(XIAOMI)));
    jest.spyOn(TraceProcessorFactory, 'create').mockResolvedValue(processor as any);
    await service.ensureProcessorForLease(traceId, lease.id, lease.mode, scope);
    await service.runWithLease(context('run-a'), () => resolveTraceVendor(service, traceId));
    expect(processor.query).toHaveBeenCalledTimes(1);

    const querySpy = jest.spyOn(service, 'query');
    await expect(service.runWithLease(context(), () => resolveTraceVendor(service, traceId)))
      .resolves.toMatchObject({vendor: 'xiaomi'});
    expect(querySpy).toHaveBeenCalledTimes(1);

    // With no valid holder left, its own query is refused and it gets no vendor.
    for (const holder of ['run-a', 'run-b', 'run-c']) store.releaseHolder(scope, lease.id, 'agent_run', holder);
    await expect(service.runWithLease(context(), () => awaitTraceVendorHint(service, traceId))).resolves.toBeUndefined();
    await expect(service.runWithLease(context(), () => resolveTraceVendor(service, traceId)))
      .rejects.toMatchObject({code: 'TRACE_PROCESSOR_QUERY_CANCELLED'});
  });

  it('misses the cache when a trace id is registered again from a different file', async () => {
    const {traceId, tracePath, service, lease} = await fixture();
    let rows = rowsFor(XIAOMI);
    const processor = fakeProcessor(traceId, async () => metadataResult(rows));
    jest.spyOn(TraceProcessorFactory, 'create').mockResolvedValue(processor as any);
    // A shared lease publishes the processor under the trace id, which is
    // where an unleased query looks for it.
    await service.ensureProcessorForLease(traceId, lease.id, lease.mode, scope);
    await expect(resolveTraceVendor(service, traceId)).resolves.toMatchObject({vendor: 'xiaomi'});
    await expect(resolveTraceVendor(service, traceId)).resolves.toMatchObject({vendor: 'xiaomi'});
    expect(processor.query).toHaveBeenCalledTimes(1);

    // Drop the shared processor so the trace id can be unregistered.
    TraceProcessorFactory.cleanup();
    (service as any).processors.clear();
    expect(service.unregisterStoredTrace(traceId, tracePath)).toBe(true);
    const otherPath = path.join(tmpDir, 'other.trace');
    await fs.writeFile(otherPath, 'other trace bytes');
    service.registerStoredTrace({id: traceId, filename: 'other.trace', size: 17, filePath: otherPath});
    rows = rowsFor({manufacturer: 'Google'});
    await service.ensureProcessorForLease(traceId, lease.id, lease.mode, scope);
    await expect(resolveTraceVendor(service, traceId)).resolves.toMatchObject({vendor: 'pixel'});
  });

  it('treats a cancellation error from the query layer as no vendor, never cached', async () => {
    const {service: plain} = stubService(async () => {throw createTraceProcessorQueryCancelledError('gone');});
    await expect(resolveTraceVendor(plain, 't')).resolves.toMatchObject({source: 'query_failed',
      evidence: {failure: 'cancelled'}});
  });
});
