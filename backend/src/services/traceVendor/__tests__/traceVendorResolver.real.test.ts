// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Real-trace gate for vendor resolution: the pinned trace_processor_shell runs
// the resolver's own metadata query. The six canonical traces are all real
// OEM devices and none is HarmonyOS; the slice-name detector this replaced
// called every one of them `harmonyos`. Durations are logged as diagnostics
// only; this suite asserts correctness, not timing.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {randomUUID} from 'crypto';
import {TraceProcessorFactory, WorkingTraceProcessor} from '../../workingTraceProcessor';
import {resolveTraceCase} from '../../../utils/traceCorpus';
import {
  clearTraceVendorCacheForTests,
  resolveTraceVendor,
  TRACE_VENDOR_METADATA_SQL,
  type TraceVendorQueryService,
} from '../traceVendorResolver';
import {vendorQueryServiceDouble} from './traceVendorFixture';

jest.setTimeout(180_000);
// Processor keys opened through the factory, which retries on a busy port.
const processorKeys: string[] = [];
beforeEach(() => clearTraceVendorCacheForTests());
afterEach(() => {for (const key of processorKeys.splice(0)) TraceProcessorFactory.remove(key);});

const CANONICAL = [
  {selector: 'android-scroll-customer', vendor: 'oppo', soc: 'qualcomm', source: 'metadata_manufacturer'},
  {selector: 'android-scroll-standard', vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint'},
  {selector: 'android-startup-heavy', vendor: 'xiaomi', soc: 'qualcomm', source: 'metadata_manufacturer'},
  {selector: 'android-startup-light', vendor: 'pixel', soc: 'google_tensor', source: 'metadata_manufacturer'},
  {selector: 'flutter-scroll-surface-view', vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint'},
  {selector: 'flutter-scroll-texture-view', vendor: 'other', brand: 'nubia', soc: 'qualcomm', source: 'metadata_fingerprint'},
] as const;

// Device traces kept outside this repository (a sibling TraceDemo checkout).
// Optional: each case skips when its file is absent and is never acceptance.
const TRACE_DEMO_ROOT = process.env.SMARTPERFETTO_TRACEDEMO_DIR
  ?? path.resolve(__dirname, '../../../../../../TraceDemo');
const EXTERNAL = [
  {label: 'pixel6pro-api37', file: 'traces/device/pixel6pro-api37/device_startup_cold.perfetto-trace',
    vendor: 'pixel', soc: 'google_tensor'},
  {label: 'Honor 300 Pro (Android 16)', file: 'traces/imported/hpc-scroll-runs/Honor-300-Pro/trace/AMP-AN00-AY8CUT4B27009707-scrolling-webview-surface-minimal-20260215-180327.ptrace',
    vendor: 'honor', soc: 'qualcomm'},
  {label: 'OUKITEL WP62', file: 'traces/imported/hpc-scroll-runs/DUT-WP62-02131232314454-20260419-224755/trace/WP62-02131232314454-scrolling-aosp-softwarerender-heavy-20260419-230120.ptrace',
    vendor: 'other', brand: 'oukitel', soc: 'mtk'},
  {label: 'vivo X300 Pro', file: 'traces/imported/hpc-scroll-runs/VivoX300Pro/trace/V2502A-10AF6X0J18000LU-scrolling-webview-minimal-20260213-220202.ptrace',
    vendor: 'vivo', soc: 'mtk'},
];

async function openTrace(tracePath: string): Promise<{service: TraceVendorQueryService; traceId: string;
  sql: string[]; errors: string[]; processor: WorkingTraceProcessor}> {
  const traceId = `trace-vendor-real-${randomUUID()}`;
  // The factory, like the product, retries when another process holds the port.
  processorKeys.push(traceId);
  const processor = await TraceProcessorFactory.create(traceId, tracePath);
  const sql: string[] = [];
  const errors: string[] = [];
  const trace = {id: traceId, filePath: tracePath, size: fs.statSync(tracePath).size, traceOs: 'android' as const};
  const service = vendorQueryServiceDouble(async (_id: string, statement: string) => {
    sql.push(statement);
    const result = await processor.query(statement);
    if (result.error) errors.push(result.error.split('\n')[0]);
    return result;
  }, trace);
  return {service, traceId, sql, errors, processor};
}

async function timed<T>(work: () => Promise<T>): Promise<{value: T; ms: number}> {
  const start = process.hrtime.bigint();
  const value = await work();
  return {value, ms: Number(process.hrtime.bigint() - start) / 1e6};
}

describe('trace vendor resolution on the pinned trace processor', () => {
  it.each(CANONICAL)('$selector -> $vendor / $soc', async expected => {
    const {service, traceId, sql, errors, processor} = await openTrace(resolveTraceCase(expected.selector));
    const cold = await timed(() => resolveTraceVendor(service, traceId));
    const cached = await timed(() => resolveTraceVendor(service, traceId));
    // A warm processor answering a fresh (uncached) resolution.
    clearTraceVendorCacheForTests();
    const warm = await timed(() => resolveTraceVendor(service, traceId));
    console.log(`[trace-vendor] ${expected.selector}: cold=${cold.ms.toFixed(1)}ms ` +
      `warm=${warm.ms.toFixed(1)}ms cached=${cached.ms.toFixed(2)}ms`);

    expect(errors).toEqual([]);
    expect(processor.status).not.toBe('error');
    for (const result of [cold.value, cached.value, warm.value]) {
      expect(result).toMatchObject({schemaVersion: 'trace_vendor@1', vendor: expected.vendor, soc: expected.soc,
        os: 'android', source: expected.source, confidence: 'high'});
      expect(result.brand).toBe('brand' in expected ? expected.brand : undefined);
      expect(result.vendor).not.toBe('harmonyos');
      expect(result.evidence.scopeConflict).toBeUndefined();
    }
    // One metadata query per uncached resolution; nothing reads slice.
    expect(sql).toEqual([TRACE_VENDOR_METADATA_SQL, TRACE_VENDOR_METADATA_SQL]);
    expect(sql.every(statement => !/\bslice\b/i.test(statement))).toBe(true);
  });
});

describe('trace vendor resolution on optional external device traces', () => {
  for (const expected of EXTERNAL) {
    const tracePath = path.join(TRACE_DEMO_ROOT, expected.file);
    const test = fs.existsSync(tracePath) ? it : it.skip;
    test(`${expected.label} -> ${expected.vendor} / ${expected.soc}`, async () => {
      const {service, traceId, errors} = await openTrace(tracePath);
      const result = await resolveTraceVendor(service, traceId);
      expect(errors).toEqual([]);
      expect(result).toMatchObject({vendor: expected.vendor, soc: expected.soc, os: 'android'});
      expect(result.brand).toBe(expected.brand);
    });
  }
});
