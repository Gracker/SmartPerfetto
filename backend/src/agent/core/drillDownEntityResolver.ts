// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  findDrillDownSkillConfig,
  getDrillDownSkillConfig,
  type DrillDownEntityType,
} from '../config/drillDownRegistry';
import {
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from '../../services/traceProcessorCancellation';

interface TraceQueryResult {
  columns?: string[];
  rows?: unknown[];
  error?: string;
}

interface TraceQueryService {
  query?: (...args: any[]) => Promise<TraceQueryResult>;
  executeQuery?: (...args: any[]) => Promise<TraceQueryResult>;
}

export interface DrillDownEntityResolution {
  entityType: DrillDownEntityType;
  requestedEntityId: string;
  resolvedEntityId: string;
  row: Record<string, unknown>;
  query: string;
  resolveSource: 'registry' | 'legacy_android_frames' | 'doframe_alias';
}

export type DrillDownEntityResolutionAudit = Pick<
  DrillDownEntityResolution,
  'entityType' | 'requestedEntityId' | 'resolvedEntityId' | 'resolveSource'
>;

export interface DrillDownSkillParamResolution {
  params: Record<string, any>;
  enriched: boolean;
  resolution?: DrillDownEntityResolution;
  audit?: DrillDownEntityResolutionAudit;
}

export class DrillDownEntityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrillDownEntityResolutionError';
  }
}

const ENTITY_SOURCE_FIELD: Record<DrillDownEntityType, string> = {
  frame: 'frameId',
  session: 'sessionId',
  startup: 'startupId',
};

const INTERVAL_SOURCE_TO_ROW_FIELD: Record<string, string> = {
  startTs: 'start_ts',
  endTs: 'end_ts',
  processName: 'process_name',
  frameId: 'frame_id',
  jankType: 'jank_type',
  durMs: 'dur_ms',
  mainStartTs: 'main_start_ts',
  mainEndTs: 'main_end_ts',
  renderStartTs: 'render_start_ts',
  renderEndTs: 'render_end_ts',
  sessionId: 'session_id',
  layerName: 'layer_name',
  tokenGap: 'token_gap',
  vsyncMissed: 'vsync_missed',
  jankResponsibility: 'jank_responsibility',
  frameIndex: 'frame_index',
  startupId: 'startup_id',
  startupType: 'startup_type',
  ttidMs: 'ttid_ms',
  ttfdMs: 'ttfd_ms',
};

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function normalizeDrillDownEntityId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  const compact = String(value).trim().replace(/[,\s，_]/g, '');
  return /^\d+$/.test(compact) ? compact : null;
}

function normalizeTimestamp(value: unknown): string | null {
  const normalized = normalizeDrillDownEntityId(value);
  return normalized;
}

function hasValidInterval(params: Record<string, any>): boolean {
  const start = normalizeTimestamp(params.start_ts ?? params.startTs);
  const end = normalizeTimestamp(params.end_ts ?? params.endTs);
  if (start === null || end === null) return false;
  try {
    return BigInt(end) > BigInt(start);
  } catch {
    return false;
  }
}

function toRowObject(result: TraceQueryResult | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  if (result.error) throw new Error(result.error);
  if (!Array.isArray(result.rows) || result.rows.length === 0) return null;
  const row = result.rows[0];
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row as Record<string, unknown>;
  }
  if (!Array.isArray(row) || !Array.isArray(result.columns) || result.columns.length === 0) {
    return null;
  }
  const objectRow: Record<string, unknown> = {};
  result.columns.forEach((column, index) => {
    objectRow[column] = row[index];
  });
  return objectRow;
}

async function executeTraceQuery(
  service: TraceQueryService,
  traceId: string,
  sql: string,
  signal?: AbortSignal,
): Promise<TraceQueryResult> {
  throwIfTraceProcessorQueryCancelled(signal);
  const query = service.query ?? service.executeQuery;
  if (typeof query !== 'function') {
    throw new Error('Trace processor service does not expose query/executeQuery');
  }
  try {
    const result = query.length === 1
      ? await query.call(service, sql, signal ? {signal} : undefined)
      : signal
        ? await query.call(service, traceId, sql, {signal})
        : await query.call(service, traceId, sql);
    throwIfTraceProcessorQueryCancelled(signal);
    if (result?.error) throw new Error(result.error);
    return result;
  } catch (error) {
    rethrowIfTraceProcessorQueryCancelled(error);
    throw error;
  }
}

async function queryFirstRow(
  service: TraceQueryService,
  traceId: string,
  sql: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  return toRowObject(await executeTraceQuery(service, traceId, sql, signal));
}

function renderRegistryQuery(
  entityType: DrillDownEntityType,
  entityId: string,
  processName?: string,
): string {
  const template = getDrillDownSkillConfig(entityType).enrichmentQuery;
  if (!template) return '';
  return template
    .split(`$${entityType}_id`).join(entityId)
    .split('$process_name').join(quoteSqlString(processName?.trim() ?? ''));
}

function processFilterSql(processName?: string, alias = 'p.name'): string {
  const normalized = processName?.trim() ?? '';
  if (!normalized) return '';
  const quoted = quoteSqlString(normalized);
  return `AND (${alias} = ${quoted} OR ${alias} GLOB ${quoted} || ':*')`;
}

function buildLegacyFrameQuery(frameId: string, processName?: string): string {
  return `
    SELECT
      af.frame_id,
      af.ts as start_ts,
      af.ts + af.dur as end_ts,
      af.dur,
      p.name as process_name,
      ej.jank_type,
      ej.layer_name,
      ej.vsync_missed
    FROM android_frames af
    LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
    LEFT JOIN process p ON af.upid = p.upid
    WHERE af.frame_id = ${frameId}
      ${processFilterSql(processName)}
    LIMIT 1
  `;
}

function buildDoFrameAliasQuery(frameId: string, processName?: string): string {
  return `
    WITH target_slice AS (
      SELECT
        s.ts,
        s.dur,
        t.upid
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      JOIN process target_process ON t.upid = target_process.upid
      WHERE (
        s.name = 'Choreographer#doFrame ${frameId}'
        OR s.name GLOB '*Choreographer#doFrame ${frameId}*'
        OR s.name = 'doFrame ${frameId}'
        OR s.name GLOB '*doFrame ${frameId}*'
      )
        ${processFilterSql(processName, 'target_process.name')}
      ORDER BY s.dur DESC
      LIMIT 1
    )
    SELECT
      COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
      a.ts as start_ts,
      a.ts + a.dur as end_ts,
      a.dur,
      p.name as process_name,
      a.jank_type,
      a.layer_name,
      NULL as vsync_missed
    FROM actual_frame_timeline_slice a
    JOIN target_slice ts
      ON a.upid = ts.upid
      AND a.ts < ts.ts + ts.dur + 5000000
      AND a.ts + a.dur > ts.ts - 5000000
    LEFT JOIN process p ON a.upid = p.upid
    ORDER BY ABS((a.ts + a.dur / 2) - (ts.ts + ts.dur / 2)) ASC, a.dur DESC
    LIMIT 1
  `;
}

function isMissingSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (?:table|view)|does not exist|unknown table/i.test(message);
}

function resolvedEntityId(
  entityType: DrillDownEntityType,
  requestedEntityId: string,
  row: Record<string, unknown>,
): string {
  return normalizeDrillDownEntityId(row[`${entityType}_id`]) ?? requestedEntityId;
}

async function queryOptionalSchemaRow(
  service: TraceQueryService,
  traceId: string,
  sql: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    return await queryFirstRow(service, traceId, sql, signal);
  } catch (error) {
    throwIfTraceProcessorQueryCancelled(signal);
    rethrowIfTraceProcessorQueryCancelled(error);
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

export async function resolveDrillDownEntity(input: {
  entityType: DrillDownEntityType;
  entityId: unknown;
  traceId: string;
  traceProcessorService: TraceQueryService;
  processName?: string;
  signal?: AbortSignal;
}): Promise<DrillDownEntityResolution | null> {
  const requestedEntityId = normalizeDrillDownEntityId(input.entityId);
  if (requestedEntityId === null) return null;

  const registrySql = renderRegistryQuery(
    input.entityType,
    requestedEntityId,
    input.processName,
  );
  if (!registrySql) return null;

  const registryRow = input.entityType === 'frame'
    ? await queryOptionalSchemaRow(
        input.traceProcessorService,
        input.traceId,
        registrySql,
        input.signal,
      )
    : await queryFirstRow(
        input.traceProcessorService,
        input.traceId,
        registrySql,
        input.signal,
      );
  if (registryRow) {
    return {
      entityType: input.entityType,
      requestedEntityId,
      resolvedEntityId: resolvedEntityId(input.entityType, requestedEntityId, registryRow),
      row: registryRow,
      query: registrySql,
      resolveSource: 'registry',
    };
  }

  if (input.entityType !== 'frame') return null;

  const legacySql = buildLegacyFrameQuery(requestedEntityId, input.processName);
  const legacyRow = await queryOptionalSchemaRow(
    input.traceProcessorService,
    input.traceId,
    legacySql,
    input.signal,
  );
  if (legacyRow) {
    return {
      entityType: input.entityType,
      requestedEntityId,
      resolvedEntityId: resolvedEntityId(input.entityType, requestedEntityId, legacyRow),
      row: legacyRow,
      query: legacySql,
      resolveSource: 'legacy_android_frames',
    };
  }

  const aliasSql = buildDoFrameAliasQuery(requestedEntityId, input.processName);
  const aliasRow = await queryFirstRow(
    input.traceProcessorService,
    input.traceId,
    aliasSql,
    input.signal,
  );
  return aliasRow ? {
    entityType: input.entityType,
    requestedEntityId,
    resolvedEntityId: resolvedEntityId(input.entityType, requestedEntityId, aliasRow),
    row: aliasRow,
    query: aliasSql,
    resolveSource: 'doframe_alias',
  } : null;
}

function canonicalizeCommonDrillDownAliases(params: Record<string, any>): Record<string, any> {
  const canonical = {...params};
  for (const [canonicalName, aliasName] of [
    ['start_ts', 'startTs'],
    ['end_ts', 'endTs'],
    ['frame_id', 'frameId'],
    ['session_id', 'sessionId'],
    ['startup_id', 'startupId'],
  ] as const) {
    const canonicalValue = canonical[canonicalName];
    const aliasValue = canonical[aliasName];
    if (canonicalValue != null && aliasValue != null) {
      const normalizedCanonical = normalizeDrillDownEntityId(canonicalValue);
      const normalizedAlias = normalizeDrillDownEntityId(aliasValue);
      if (
        normalizedCanonical === null
        || normalizedAlias === null
        || normalizedCanonical !== normalizedAlias
      ) {
        throw new DrillDownEntityResolutionError(
          `Conflicting drill-down parameter aliases: ${canonicalName} and ${aliasName}`,
        );
      }
    }
    if (canonicalValue == null && aliasValue != null) canonical[canonicalName] = aliasValue;
    delete canonical[aliasName];
  }
  return canonical;
}

function rowValueForSource(row: Record<string, unknown>, source: string): unknown {
  const rowField = INTERVAL_SOURCE_TO_ROW_FIELD[source] ?? source;
  return row[rowField] ?? row[source];
}

export async function resolveRegisteredDrillDownSkillParams(input: {
  skillId: string;
  params: Record<string, any>;
  traceId: string;
  traceProcessorService: TraceQueryService;
  signal?: AbortSignal;
}): Promise<DrillDownSkillParamResolution> {
  const registered = findDrillDownSkillConfig(input.skillId);
  if (!registered) return {params: {...input.params}, enriched: false};
  const params = canonicalizeCommonDrillDownAliases(input.params);

  const entitySource = ENTITY_SOURCE_FIELD[registered.entityType];
  const entityParam = Object.entries(registered.paramMapping)
    .find(([, source]) => source === entitySource)?.[0];
  if (!entityParam) return {params, enriched: false};
  const entityId = params[entityParam];
  const normalizedEntityId = normalizeDrillDownEntityId(entityId);
  if (normalizedEntityId !== null) params[entityParam] = normalizedEntityId;
  if (hasValidInterval(params)) {
    if (registered.dropEntityParamAfterResolution) delete params[entityParam];
    return {params, enriched: false};
  }
  if (entityId == null) return {params, enriched: false};

  const resolution = await resolveDrillDownEntity({
    entityType: registered.entityType,
    entityId,
    traceId: input.traceId,
    traceProcessorService: input.traceProcessorService,
    processName: params.process_name ?? params.package,
    signal: input.signal,
  });
  if (!resolution) {
    throw new DrillDownEntityResolutionError(
      `Unable to resolve a complete ${registered.entityType} interval for ${input.skillId} entity ${String(entityId)}`,
    );
  }

  const enriched = {...params};
  enriched[entityParam] = resolution.resolvedEntityId;
  for (const [paramName, source] of Object.entries(registered.paramMapping)) {
    const value = rowValueForSource(resolution.row, source);
    if (
      (paramName === 'start_ts' || paramName === 'end_ts')
      && enriched[paramName] != null
      && value != null
      && normalizeTimestamp(enriched[paramName]) !== normalizeTimestamp(value)
    ) {
      throw new DrillDownEntityResolutionError(
        `Explicit ${paramName} conflicts with the resolved ${registered.entityType} interval`,
      );
    }
    if (enriched[paramName] != null) continue;
    if (value != null) enriched[paramName] = value;
  }
  if (enriched.process_name == null && resolution.row.process_name != null) {
    enriched.process_name = resolution.row.process_name;
  }
  if (enriched.package == null && resolution.row.process_name != null) {
    enriched.package = resolution.row.process_name;
  }
  if (registered.dropEntityParamAfterResolution) {
    delete enriched[entityParam];
  }

  if (!hasValidInterval(enriched)) {
    throw new DrillDownEntityResolutionError(
      `Resolved ${registered.entityType} entity ${String(entityId)} did not provide a complete valid start_ts/end_ts interval`,
    );
  }
  return {
    params: enriched,
    enriched: true,
    resolution,
    audit: {
      entityType: resolution.entityType,
      requestedEntityId: resolution.requestedEntityId,
      resolvedEntityId: resolution.resolvedEntityId,
      resolveSource: resolution.resolveSource,
    },
  };
}
