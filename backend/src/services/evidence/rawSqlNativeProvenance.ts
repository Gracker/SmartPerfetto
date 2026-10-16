// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {resolveCapabilityTraceProcessorIdentity,
  type ResolveCapabilityTraceProcessorIdentityInput} from '../capabilityManifestRuntimeIdentity';
import {loadPerfettoSqlDocsAsset, type PerfettoSqlDocsAsset} from '../perfettoSqlDocs';
import type {CapabilityManifestTraceProcessorIdentityV1} from '../../types/capabilityManifest';
import type {CapturedFieldSemantics} from './evidenceCapture';
import {analyzeRawSqlDirectProjection, resolveRawSqlDirectProjection,
  type RawSqlDirectProjectionAnalysis} from './rawSqlDirectProjection';
import {resolveRawSqlExpressionUnits, RAW_SQL_EXPRESSION_UNIT_POLICY} from './rawSqlExpressionUnits';

export interface RawSqlNativeProvenance {readonly kind: 'raw_sql_native_provenance'}
export interface RawSqlBootstrapCapability {readonly kind: 'raw_sql_bootstrap_capability'}
export interface RawSqlNativeQuery {readonly kind: 'raw_sql_native_query'}
export interface RawSqlNativeProvenanceSnapshot {
  readonly status: 'unknown' | 'trusted' | 'tainted';
  readonly nativeSchemaEligible: boolean;
}
interface NativeColumn {name: string; type: string}
export interface RawSqlNativeRowSchema {
  readonly relation: string;
  readonly idColumn: string;
  readonly schemaFingerprint: string;
}
export interface RawSqlNativeRow extends RawSqlNativeRowSchema {
  readonly traceId: string;
  readonly outputColumn: string;
  readonly id: number;
}
export interface RawSqlCaptureMetadata {
  readonly sourceTraceId?: string;
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
  readonly nativeRows: readonly (RawSqlNativeRow | undefined)[];
}
interface NativeState {
  status: 'unknown' | 'trusted' | 'tainted';
  epoch: number;
  initializationStarted: boolean;
  nativeSchemaEligible: boolean;
  processorId: string;
  traceId?: string;
  bootstrapSql: ReadonlySet<string>;
  schema?: ReadonlyMap<string, readonly NativeColumn[]>;
  rowSchemas?: ReadonlyMap<string, RawSqlNativeRowSchema>;
  definitionFingerprint?: string;
  identityFingerprint?: string;
}
interface NativeQueryState {
  provenance: RawSqlNativeProvenance;
  epoch: number;
  sql: string;
  analysis: RawSqlDirectProjectionAnalysis;
}
interface NativeResult {columns: readonly string[]; rows: readonly unknown[]; error?: string}
const states = new WeakMap<RawSqlNativeProvenance, NativeState>();
const bootstrapCapabilities = new WeakMap<RawSqlBootstrapCapability, RawSqlNativeProvenance>();
const queries = new WeakMap<RawSqlNativeQuery, NativeQueryState>();
const captures = new WeakMap<object, {fingerprint: string; metadata: RawSqlCaptureMetadata}>();
const canonical = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
const fingerprint = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item) ?? '')
  .digest('hex');

/**
 * Pure schema identity for independently verified bundled pins; this issues no row evidence.
 * The identity resolver verifies each platform's binary SHA before returning bundled.
 * Schema identity is intentionally shared across those binaries at the same formal revision.
 */
export function resolveRawSqlNativeRowSchema(
  identity: CapabilityManifestTraceProcessorIdentityV1,
  docs: PerfettoSqlDocsAsset | null | undefined,
  relation: string,
): RawSqlNativeRowSchema | undefined {
  if (identity.source !== 'bundled' || !identity.gitRevision ||
      docs?.generatedFrom !== identity.gitRevision || identity.stdlibRevision !== identity.gitRevision) return undefined;
  const entries = docs.entries.filter(entry => entry.package === 'prelude' &&
    (entry.type === 'table' || entry.type === 'view') && canonical(entry.name) === canonical(relation));
  if (entries.length !== 1) return undefined;
  const entry = entries[0];
  const columns = entry.columns?.map(column => ({name: canonical(column.name), type: column.type ?? ''}));
  if (!columns?.length || columns.some(column => !column.name) || new Set(columns.map(column => column.name)).size !== columns.length) return undefined;
  const ids = columns.filter(column => column.type === 'ID');
  if (ids.length !== 1) return undefined;
  const name = canonical(entry.name);
  return Object.freeze({relation: name, idColumn: ids[0].name,
    schemaFingerprint: fingerprint({version: 1, source: identity.source, gitRevision: identity.gitRevision,
      stdlibRevision: identity.stdlibRevision, relation: name, type: entry.type, columns})});
}

/** The capability never travels with ordinary SQL options or model tool input. */
export function createRawSqlNativeProvenance(processorId: string, bootstrapSql: readonly string[], traceId?: string) {
  const provenance: RawSqlNativeProvenance = Object.freeze({kind: 'raw_sql_native_provenance'});
  const bootstrapCapability: RawSqlBootstrapCapability = Object.freeze({kind: 'raw_sql_bootstrap_capability'});
  states.set(provenance, {status: 'unknown', epoch: 0, initializationStarted: false, nativeSchemaEligible: false,
    processorId, traceId, bootstrapSql: new Set(bootstrapSql)});
  bootstrapCapabilities.set(bootstrapCapability, provenance);
  return {provenance, bootstrapCapability};
}

/** Planning information only; this snapshot cannot issue evidence or revive a processor. */
export function readRawSqlNativeProvenanceSnapshot(provenance: RawSqlNativeProvenance): RawSqlNativeProvenanceSnapshot {
  const state = states.get(provenance);
  return {status: state?.status ?? 'unknown', nativeSchemaEligible: state?.nativeSchemaEligible ?? false};
}

export function invalidateRawSqlNativeProvenance(provenance: RawSqlNativeProvenance): void {
  const state = states.get(provenance);
  if (!state) return;
  state.status = 'tainted';
  state.epoch += 1;
}

/** A late initialization callback cannot revive an exposed or mutated processor. */
export async function initializeRawSqlNativeProvenance(
  provenance: RawSqlNativeProvenance,
  binary: ResolveCapabilityTraceProcessorIdentityInput,
): Promise<void> {
  const state = states.get(provenance);
  if (!state || state.initializationStarted) return;
  state.initializationStarted = true;
  const epoch = state.epoch;
  try {
    const identity = await resolveCapabilityTraceProcessorIdentity(binary);
    if (identity.source !== 'bundled') return;
    const docs = loadPerfettoSqlDocsAsset();
    if (!docs || docs.generatedFrom !== identity.gitRevision || identity.stdlibRevision !== identity.gitRevision) return;
    const schema = new Map<string, readonly NativeColumn[]>();
    const ambiguous = new Set<string>();
    for (const entry of docs.entries) {
      if (entry.package !== 'prelude' || (entry.type !== 'table' && entry.type !== 'view') ||
          !entry.name || !Array.isArray(entry.columns) || entry.columns.length === 0) continue;
      const name = canonical(entry.name);
      if (ambiguous.has(name)) continue;
      if (schema.has(name)) {schema.delete(name); ambiguous.add(name); continue;}
      const columns = entry.columns.map(column => ({name: column.name, type: column.type ?? ''}));
      if (columns.some(column => !column.name) || new Set(columns.map(column => canonical(column.name))).size !== columns.length) continue;
      schema.set(name, Object.freeze(columns.map(column => Object.freeze(column))));
    }
    if (!schema.size) return;
    // A tainted, pinned instance can justify a fresh isolated analysis instance,
    // but this fact grants no authority to the original instance.
    state.nativeSchemaEligible = true;
    state.identityFingerprint = fingerprint(identity);
    if (state.status === 'tainted' || state.epoch !== epoch) return;
    state.schema = schema;
    state.rowSchemas = new Map([...schema.keys()].flatMap(name => {
      const rowSchema = resolveRawSqlNativeRowSchema(identity, docs, name);
      return rowSchema ? [[name, rowSchema] as const] : [];
    }));
    state.definitionFingerprint = fingerprint({identity, schema: [...schema]});
    state.status = 'trusted';
  } catch {
    // Missing identity/schema disables only provenance, never SQL execution.
  }
}

/** Check the launch snapshot again; this operation can only remove authority. */
export async function revalidateRawSqlNativeProvenance(
  provenance: RawSqlNativeProvenance,
  binary: ResolveCapabilityTraceProcessorIdentityInput,
): Promise<void> {
  const state = states.get(provenance);
  if (!state || !state.nativeSchemaEligible) return;
  try {
    const identity = await resolveCapabilityTraceProcessorIdentity(binary);
    if (fingerprint(identity) !== state.identityFingerprint) {
      state.nativeSchemaEligible = false;
      invalidateRawSqlNativeProvenance(provenance);
    }
  } catch {
    state.nativeSchemaEligible = false;
    invalidateRawSqlNativeProvenance(provenance);
  }
}

/** Called at dequeue, before SQL reaches the native process. */
export function beginRawSqlNativeQuery(
  provenance: RawSqlNativeProvenance,
  sql: string,
  bootstrapCapability?: RawSqlBootstrapCapability,
): RawSqlNativeQuery | undefined {
  const state = states.get(provenance);
  if (!state) return undefined;
  if (bootstrapCapability && bootstrapCapabilities.get(bootstrapCapability) === provenance && state.bootstrapSql.has(sql)) {
    return undefined;
  }
  const analysis = analyzeRawSqlDirectProjection(sql);
  if (!analysis.pureRead) {
    invalidateRawSqlNativeProvenance(provenance);
    return undefined;
  }
  if (state.status !== 'trusted') return undefined;
  const query: RawSqlNativeQuery = Object.freeze({kind: 'raw_sql_native_query'});
  queries.set(query, {provenance, epoch: state.epoch, sql, analysis});
  return query;
}

/** Called after decoding the complete response, before the queue advances. */
export function sealRawSqlNativeQuery(query: RawSqlNativeQuery | undefined, result: NativeResult): void {
  if (!query) return;
  const issued = queries.get(query);
  queries.delete(query);
  if (!issued || result.error) return;
  const state = states.get(issued.provenance);
  if (!state || state.status !== 'trusted' || state.epoch !== issued.epoch || !state.schema) return;
  const relation = issued.analysis.relation;
  const schema = relation ? state.schema.get(canonical(relation.name)) : undefined;
  if (!schema) return;
  const mapping = resolveRawSqlDirectProjection(issued.analysis, result.columns, schema.map(column => column.name));
  const expressionUnits = resolveRawSqlExpressionUnits(issued.analysis, result.columns, schema);
  if (!mapping && !Object.keys(expressionUnits).length) return;
  const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
  const selectedSqlHash = createHash('sha256').update(issued.sql).digest('hex').slice(0, 12);
  const definitionFingerprint = fingerprint({native: state.definitionFingerprint, processorId: state.processorId,
    epoch: issued.epoch, sql: issued.sql, relation, schema, mapping, expressionUnits,
    expressionUnitPolicy: RAW_SQL_EXPRESSION_UNIT_POLICY});
  for (const column of mapping ?? []) {
    if (schema.find(source => source.name === column.sourceColumn)?.type !== 'DURATION') continue;
    fields[column.outputColumn] = Object.freeze({origin: Object.freeze({kind: 'native_producer', selectedSqlHash, definitionFingerprint}), unit: 'ns'});
  }
  for (const [column, unit] of Object.entries(expressionUnits)) fields[column] = Object.freeze({
    origin: Object.freeze({kind: 'native_producer', selectedSqlHash, definitionFingerprint}), unit});
  const rowSchema = relation ? state.rowSchemas?.get(canonical(relation.name)) : undefined;
  const idOutputs = rowSchema ? (mapping ?? []).filter(column => canonical(column.sourceColumn) === rowSchema.idColumn) : [];
  const nativeRows = rowSchema && state.traceId && idOutputs.length ? result.rows.map(row => {
    const values = idOutputs.map(column => Array.isArray(row) ? row[result.columns.indexOf(column.outputColumn)] :
      row && typeof row === 'object' ? (row as Record<string, unknown>)[column.outputColumn] : undefined);
    const id = values[0];
    return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && values.every(value => value === id)
      ? Object.freeze({...rowSchema, traceId: state.traceId!, outputColumn: idOutputs[0].outputColumn, id}) : undefined;
  }) : [];
  if (!Object.keys(fields).length && !nativeRows.some(Boolean)) return;
  captures.set(result, {fingerprint: fingerprint({columns: result.columns, rows: result.rows, error: result.error}),
    metadata: Object.freeze({sourceTraceId: state.traceId, fields: Object.freeze(fields), nativeRows: Object.freeze(nativeRows)})});
}

/** A JSON copy, spread, forged fields object or changed result has no authority. */
export function readRawSqlCaptureMetadata(result: unknown): RawSqlCaptureMetadata | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const capture = captures.get(result);
  if (!capture) return undefined;
  try {
    const value = result as NativeResult;
    if (capture.fingerprint !== fingerprint({columns: value.columns, rows: value.rows, error: value.error})) return undefined;
    return structuredClone(capture.metadata);
  } catch {return undefined;}
}

export function readRawSqlCaptureFields(result: unknown): Readonly<Record<string, CapturedFieldSemantics>> | undefined {
  return readRawSqlCaptureMetadata(result)?.fields;
}
