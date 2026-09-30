// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Shared, non-suite fixture for vendor resolution tests: device identity
// tuples, `metadata` results shaped like the pinned processor's answer, and a
// trace processor double whose lease helpers are no-ops (an unleased caller).

import type {QueryResult, TraceInfo} from '../../traceProcessorService';
import type {TraceVendorMetadataRow, TraceVendorQueryService} from '../traceVendorResolver';

export interface VendorMetadataFields {
  manufacturer?: string;
  fingerprint?: string;
  soc?: string;
  sdk?: number;
}

export interface VendorMetadataScope {
  traceId?: number | null;
  machineId?: number | null;
}

export const XIAOMI_FIELDS: VendorMetadataFields = {
  manufacturer: 'Xiaomi',
  fingerprint: 'Xiaomi/pandora/pandora:16/BP2A.250605.031.A3/OS3.0.34.0.WBLCNXM:user/release-keys',
  soc: 'SM8850',
  sdk: 36,
};

/** `metadata` rows for one identity scope (by default machine 0 of a scopeless trace). */
export function metadataRows(
  fields: VendorMetadataFields,
  scope: VendorMetadataScope = {traceId: null, machineId: 0},
): TraceVendorMetadataRow[] {
  const traceId = scope.traceId ?? null;
  const machineId = scope.machineId === undefined ? 0 : scope.machineId;
  const rows: TraceVendorMetadataRow[] = [];
  if (fields.fingerprint !== undefined) rows.push({name: 'android_build_fingerprint', strValue: fields.fingerprint, traceId, machineId});
  if (fields.manufacturer !== undefined) rows.push({name: 'android_device_manufacturer', strValue: fields.manufacturer, traceId, machineId});
  if (fields.sdk !== undefined) rows.push({name: 'android_sdk_version', intValue: fields.sdk, traceId, machineId});
  if (fields.soc !== undefined) rows.push({name: 'android_soc_model', strValue: fields.soc, traceId, machineId});
  return rows;
}

/** A `metadata` result shaped exactly like the pinned processor's `SELECT *`. */
export function metadataQueryResult(rows: TraceVendorMetadataRow[]): QueryResult {
  return {
    columns: ['id', 'name', 'key_type', 'int_value', 'str_value', 'machine_id', 'trace_id'],
    rows: rows.map((row, index) => [index, row.name, 'single', row.intValue ?? null, row.strValue ?? null,
      row.machineId ?? null, row.traceId ?? null]),
    durationMs: 1,
  };
}

export const XIAOMI_METADATA = metadataQueryResult(metadataRows(XIAOMI_FIELDS));

const DEFAULT_TRACE = {id: 't', filePath: '/tmp/t.pftrace', size: 1, traceOs: 'android'};

type TraceRecord = Record<string, unknown> | undefined;

/**
 * A trace processor double for the resolver: the given `query`, a registered
 * trace (a record, or a getter for a registration that changes), and an
 * unleased caller. Every double the resolver sees needs all three, because
 * lease validity is not optional.
 */
export function vendorQueryServiceDouble<Query extends (...args: any[]) => unknown>(
  query: Query,
  trace: TraceRecord | (() => TraceRecord) = DEFAULT_TRACE,
): TraceVendorQueryService & {query: Query} {
  const getTrace = typeof trace === 'function' ? trace : () => trace;
  return {
    query,
    getTrace: () => getTrace() as TraceInfo | undefined,
    leaseCacheIdentity: () => 'unleased',
  } as unknown as TraceVendorQueryService & {query: Query};
}
