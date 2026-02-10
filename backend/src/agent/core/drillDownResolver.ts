/**
 * Drill-Down Resolver
 *
 * Resolves drill-down queries to FocusIntervals using a multi-source resolution pipeline.
 * The goal is to avoid re-running global discovery when we already have the target entity.
 *
 * Resolution Priority:
 * 1. Explicit structured input (UI click payload / ReferencedEntity.value / extractedParams)
 * 2. Session cache (EntityStore) built from prior results
 * 3. Findings details (historical, but often incomplete)
 * 4. Lightweight trace SQL enrichment (1 query per entity)
 * 5. Return null - caller should ask user or run overview first
 *
 * This module is called by the orchestrator when:
 * - intent.followUpType === 'drill_down'
 * - frame_id / session_id / startup_id is present in the query
 */

import type { Intent, ReferencedEntity } from '../types';
import type { EnhancedSessionContext } from '../context/enhancedSessionContext';
import type { FollowUpResolution } from './followUpHandler';
import type { FocusInterval } from '../strategies/types';
import type { FrameEntity, SessionEntity } from '../context/entityStore';
import {
  DrillDownEntityType,
  getDrillDownSkillConfig,
  isDrillDownEntityType,
} from '../config/drillDownRegistry';

// =============================================================================
// Types
// =============================================================================

export type ResolutionSource = 'explicit' | 'cache' | 'finding' | 'enrichment' | 'fallback';

/**
 * Trace of how an entity was resolved - for observability
 */
export interface DrillDownResolutionTrace {
  entityType: DrillDownEntityType;
  entityId: string;
  used: ResolutionSource[];
  enriched: boolean;
  reason?: string;
  enrichmentQuery?: string;
}

/**
 * Result of drill-down resolution
 */
export interface DrillDownResolved {
  intervals: FocusInterval[];
  traces: DrillDownResolutionTrace[];
}

/**
 * TraceProcessorService interface (duck-typed to avoid circular imports)
 */
interface TraceProcessorServiceLike {
  query?: (traceId: string, sql: string) => Promise<{ columns: string[]; rows: any[][] }>;
  executeQuery?: (...args: any[]) => Promise<{ columns: string[]; rows: any[][] }>;
}

function normalizeLooseNumericId(id: any): string | null {
  if (id === null || id === undefined) return null;
  if (typeof id === 'number' && Number.isFinite(id)) return String(Math.trunc(id));
  const s = String(id).trim();
  if (!s) return null;
  const compact = s.replace(/[,\s，_]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  return compact;
}

function normalizeEntityLookupId(entityType: DrillDownEntityType, id: any): string {
  const numeric = normalizeLooseNumericId(id);
  if (numeric !== null) return numeric;
  return String(id);
}

async function executeTraceQuery(
  tps: TraceProcessorServiceLike,
  traceId: string,
  sql: string
): Promise<{ columns: string[]; rows: any[][] }> {
  const queryFn = tps.query as ((...args: any[]) => Promise<{ columns: string[]; rows: any[][] }>) | undefined;
  if (typeof queryFn === 'function') {
    if (queryFn.length === 1) {
      return await queryFn.call(tps, sql);
    }
    return await queryFn.call(tps, traceId, sql);
  }

  const executeQueryFn = tps.executeQuery as ((...args: any[]) => Promise<{ columns: string[]; rows: any[][] }>) | undefined;
  if (typeof executeQueryFn === 'function') {
    if (executeQueryFn.length === 1) {
      return await executeQueryFn.call(tps, sql);
    }
    return await executeQueryFn.call(tps, traceId, sql);
  }

  throw new Error('TraceProcessorServiceLike does not expose query/executeQuery');
}

// =============================================================================
// Main Resolution Function
// =============================================================================

/**
 * Resolve drill-down targets to FocusIntervals.
 *
 * @param intent - Understood user intent with referencedEntities
 * @param followUp - FollowUpResolution from followUpHandler
 * @param sessionContext - Session context with EntityStore
 * @param traceProcessorService - For enrichment queries (optional)
 * @param traceId - Current trace ID for enrichment
 * @returns Resolved intervals and traces, or null if resolution failed
 */
export async function resolveDrillDown(
  intent: Intent,
  followUp: FollowUpResolution,
  sessionContext: EnhancedSessionContext,
  traceProcessorService?: TraceProcessorServiceLike,
  traceId?: string
): Promise<DrillDownResolved | null> {
  // If followUp already has valid intervals, use them
  if (followUp.focusIntervals && followUp.focusIntervals.length > 0) {
    const validIntervals = followUp.focusIntervals.filter(hasValidTimestamps);
    if (validIntervals.length > 0) {
      return {
        intervals: validIntervals,
        traces: validIntervals.map(interval => ({
          entityType: inferEntityType(interval),
          entityId: String(interval.metadata?.sourceEntityId || interval.id),
          used: ['explicit'] as ResolutionSource[],
          enriched: false,
          reason: 'Valid timestamps from followUpHandler',
        })),
      };
    }
  }

  // No valid intervals from followUp - try to resolve from cache/enrichment
  const entities = intent.referencedEntities || [];
  const intervals: FocusInterval[] = [];
  const traces: DrillDownResolutionTrace[] = [];

  const entityStore = sessionContext.getEntityStore();

  for (const entity of entities) {
    if (!isDrillDownEntityType(entity.type)) continue;

    const rawEntityId = entity.value !== undefined ? entity.value : entity.id;
    if (rawEntityId === undefined || rawEntityId === null) continue;
    const entityId = normalizeEntityLookupId(entity.type, rawEntityId);

    const trace: DrillDownResolutionTrace = {
      entityType: entity.type,
      entityId,
      used: [],
      enriched: false,
    };

    let resolved: FocusInterval | null = null;

    // Priority 1: Check if explicit value has timestamps
    if (entity.value && typeof entity.value === 'object') {
      const interval = buildIntervalFromValue(entity);
      if (interval && hasValidTimestamps(interval)) {
        resolved = interval;
        trace.used.push('explicit');
        trace.reason = 'Timestamps from ReferencedEntity.value';
      }
    }

    // Priority 2: Check EntityStore cache
    if (!resolved) {
      if (entity.type === 'frame') {
        const cached = entityStore.getFrame(String(entityId));
        if (cached && cached.start_ts && cached.end_ts) {
          resolved = buildIntervalFromFrame(cached);
          trace.used.push('cache');
          trace.reason = 'Cache hit from EntityStore';
        }
      } else if (entity.type === 'session') {
        const cached = entityStore.getSession(String(entityId));
        if (cached && cached.start_ts && cached.end_ts) {
          resolved = buildIntervalFromSession(cached);
          trace.used.push('cache');
          trace.reason = 'Cache hit from EntityStore';
        }
      }
    }

    // Priority 3: Check findings (already handled by followUpHandler, but double-check)
    if (!resolved && followUp.resolvedParams) {
      const params = followUp.resolvedParams;
      if (params.start_ts && params.end_ts) {
        resolved = buildIntervalFromParams(entity, params);
        trace.used.push('finding');
        trace.reason = 'Timestamps from resolved params';
      }
    }

    // Priority 4: SQL enrichment (last resort before giving up)
    if (!resolved && traceProcessorService && traceId) {
      try {
        const enriched = await enrichEntity(entity.type, entityId, traceProcessorService, traceId);
        if (enriched) {
          resolved = enriched.interval;
          trace.used.push('enrichment');
          trace.enriched = true;
          trace.enrichmentQuery = enriched.query;
          trace.reason = 'SQL enrichment query';

          // Also upsert to cache for future queries
          if (entity.type === 'frame' && enriched.entity) {
            entityStore.upsertFrame(enriched.entity as FrameEntity);
          } else if (entity.type === 'session' && enriched.entity) {
            entityStore.upsertSession(enriched.entity as SessionEntity);
          }
        }
      } catch (err: any) {
        trace.reason = `Enrichment failed: ${err.message}`;
      }
    }

    // Record trace even if resolution failed
    traces.push(trace);

    if (resolved) {
      intervals.push(resolved);
    }
  }

  // Return null if no intervals resolved
  if (intervals.length === 0) {
    return null;
  }

  return { intervals, traces };
}

// =============================================================================
// Interval Building
// =============================================================================

function buildIntervalFromValue(entity: ReferencedEntity): FocusInterval | null {
  const value = entity.value;
  if (!value || typeof value !== 'object') return null;

  const startTs = value.start_ts || value.startTs;
  const endTs = value.end_ts || value.endTs;

  if (!startTs || !endTs) return null;

  const entityId = entity.id ?? value.frame_id ?? value.session_id ?? value.startup_id ?? 0;
  const entityLabel = entity.type === 'frame'
    ? '帧'
    : entity.type === 'session'
      ? '会话'
      : entity.type === 'startup'
        ? '启动'
        : '实体';

  return {
    id: typeof entityId === 'number' ? entityId : 0,
    processName: value.process_name || value.processName || '',
    startTs: String(startTs),
    endTs: String(endTs),
    priority: 1,
    label: `${entityLabel} ${entityId}`,
    metadata: {
      sourceEntityType: entity.type,
      sourceEntityId: entityId,
      ...value,
    },
  };
}

function buildIntervalFromFrame(frame: FrameEntity): FocusInterval {
  return {
    id: parseInt(frame.frame_id, 10) || 0,
    processName: frame.process_name || '',
    startTs: frame.start_ts || '0',
    endTs: frame.end_ts || '0',
    priority: 1,
    label: `帧 ${frame.frame_id}`,
    metadata: {
      sourceEntityType: 'frame',
      sourceEntityId: frame.frame_id,
      frameId: frame.frame_id,
      frame_id: frame.frame_id,
      sessionId: frame.session_id,
      session_id: frame.session_id,
      jankType: frame.jank_type,
      jank_type: frame.jank_type,
      durMs: frame.dur_ms,
      dur_ms: frame.dur_ms,
      mainStartTs: frame.main_start_ts,
      main_start_ts: frame.main_start_ts,
      mainEndTs: frame.main_end_ts,
      main_end_ts: frame.main_end_ts,
      renderStartTs: frame.render_start_ts,
      render_start_ts: frame.render_start_ts,
      renderEndTs: frame.render_end_ts,
      render_end_ts: frame.render_end_ts,
      pid: frame.pid,
      layerName: frame.layer_name,
      layer_name: frame.layer_name,
      vsyncMissed: frame.vsync_missed,
      vsync_missed: frame.vsync_missed,
    },
  };
}

function buildIntervalFromSession(session: SessionEntity): FocusInterval {
  return {
    id: parseInt(session.session_id, 10) || 0,
    processName: session.process_name || '',
    startTs: session.start_ts || '0',
    endTs: session.end_ts || '0',
    priority: 1,
    label: `会话 ${session.session_id}`,
    metadata: {
      sourceEntityType: 'session',
      sourceEntityId: session.session_id,
      sessionId: session.session_id,
      session_id: session.session_id,
      frameCount: session.frame_count,
      frame_count: session.frame_count,
      jankCount: session.jank_count,
      jank_count: session.jank_count,
      maxVsyncMissed: session.max_vsync_missed,
      max_vsync_missed: session.max_vsync_missed,
      jankTypes: session.jank_types,
      jank_types: session.jank_types,
    },
  };
}

interface StartupResolutionEntity {
  startup_id: string;
  start_ts?: string;
  end_ts?: string;
  process_name?: string;
  startup_type?: string;
  dur_ms?: number | string;
  ttid_ms?: number | string;
  ttfd_ms?: number | string;
}

function buildIntervalFromStartup(startup: StartupResolutionEntity): FocusInterval {
  return {
    id: parseInt(startup.startup_id, 10) || 0,
    processName: startup.process_name || '',
    startTs: startup.start_ts || '0',
    endTs: startup.end_ts || '0',
    priority: 1,
    label: `启动 ${startup.startup_id}`,
    metadata: {
      sourceEntityType: 'startup',
      sourceEntityId: startup.startup_id,
      startupId: startup.startup_id,
      startup_id: startup.startup_id,
      startupType: startup.startup_type,
      startup_type: startup.startup_type,
      durMs: startup.dur_ms,
      dur_ms: startup.dur_ms,
      ttidMs: startup.ttid_ms,
      ttid_ms: startup.ttid_ms,
      ttfdMs: startup.ttfd_ms,
      ttfd_ms: startup.ttfd_ms,
    },
  };
}

function buildIntervalFromParams(entity: ReferencedEntity, params: Record<string, any>): FocusInterval {
  const entityId = entity.id ?? params.frame_id ?? params.session_id ?? params.startup_id ?? 0;
  const entityLabel = entity.type === 'frame'
    ? '帧'
    : entity.type === 'session'
      ? '会话'
      : entity.type === 'startup'
        ? '启动'
        : '实体';

  return {
    id: typeof entityId === 'number' ? entityId : parseInt(String(entityId), 10) || 0,
    processName: params.process_name || params.processName || '',
    startTs: String(params.start_ts || params.startTs || '0'),
    endTs: String(params.end_ts || params.endTs || '0'),
    priority: 1,
    label: `${entityLabel} ${entityId}`,
    metadata: {
      sourceEntityType: entity.type,
      sourceEntityId: entityId,
      ...params,
    },
  };
}

// =============================================================================
// SQL Enrichment
// =============================================================================

interface EnrichmentResult {
  interval: FocusInterval;
  entity: FrameEntity | SessionEntity | StartupResolutionEntity;
  query: string;
}

async function enrichEntity(
  type: DrillDownEntityType,
  entityId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  if (type === 'frame') {
    return enrichFrame(entityId, tps, traceId);
  }
  if (type === 'session') {
    return enrichSession(entityId, tps, traceId);
  }
  return enrichStartup(entityId, tps, traceId);
}

async function enrichFrame(
  frameId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  const normalizedFrameId = normalizeLooseNumericId(frameId);
  if (!normalizedFrameId) return null;

  const attempts: Array<{ query: string; resolveSource: string }> = [
    {
      query: buildFrameTokenEnrichmentQuery(normalizedFrameId),
      resolveSource: 'frame_token',
    },
    {
      query: buildLegacyFrameEnrichmentQuery(normalizedFrameId),
      resolveSource: 'legacy_android_frames',
    },
    {
      query: buildDoFrameAliasEnrichmentQuery(normalizedFrameId),
      resolveSource: 'doframe_alias',
    },
  ];

  for (const attempt of attempts) {
    try {
      const result = await executeTraceQuery(tps, traceId, attempt.query);
      const row = toRowObject(result);
      if (!row) continue;

      const resolvedFrameId: string =
        normalizeLooseNumericId(row.frame_id) ?? normalizedFrameId;
      const frame: FrameEntity = {
        frame_id: resolvedFrameId,
        start_ts: row.start_ts !== undefined ? String(row.start_ts) : undefined,
        end_ts: row.end_ts !== undefined ? String(row.end_ts) : undefined,
        process_name: row.process_name,
        session_id: row.session_id !== undefined ? String(row.session_id) : undefined,
        jank_type: row.jank_type,
        layer_name: row.layer_name,
        pid: row.upid ?? row.pid,
        vsync_missed: row.vsync_missed,
        dur_ms: parseDurMs(row.dur),
        source: 'enrichment',
        updated_at: Date.now(),
      };

      const interval = buildIntervalFromFrame(frame);
      interval.metadata = {
        ...interval.metadata,
        resolveSource: attempt.resolveSource,
      };

      if (attempt.resolveSource === 'doframe_alias' && resolvedFrameId !== normalizedFrameId) {
        interval.label = `帧 ${normalizedFrameId} (映射帧 ${resolvedFrameId})`;
        interval.metadata = {
          ...interval.metadata,
          originalFrameId: normalizedFrameId,
          original_frame_id: normalizedFrameId,
          resolvedFrom: 'doframe_alias',
        };
      }

      return {
        interval,
        entity: frame,
        query: attempt.query,
      };
    } catch {
      // Try next fallback query.
    }
  }

  return null;
}

async function enrichSession(
  sessionId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  const normalizedSessionId = normalizeLooseNumericId(sessionId);
  if (!normalizedSessionId) return null;

  const query = `
    SELECT
      session_id,
      MIN(ts) as start_ts,
      MAX(ts + dur) as end_ts,
      COUNT(*) as frame_count,
      COUNT(CASE WHEN jank_type IS NOT NULL AND jank_type != 'None' THEN 1 END) as jank_count,
      MAX(process_name) as process_name
    FROM (
      SELECT
        af.ts,
        af.dur,
        ej.scroll_id as session_id,
        p.name as process_name,
        ej.jank_type
      FROM android_frames af
      LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
      LEFT JOIN process p ON af.upid = p.upid
      WHERE ej.scroll_id = ${normalizedSessionId}
    )
    GROUP BY session_id
    LIMIT 1
  `;

  try {
    const result = await executeTraceQuery(tps, traceId, query);
    const data = toRowObject(result);
    if (!data) return null;

    const session: SessionEntity = {
      session_id: String(data.session_id ?? normalizedSessionId),
      start_ts: data.start_ts !== undefined ? String(data.start_ts) : undefined,
      end_ts: data.end_ts !== undefined ? String(data.end_ts) : undefined,
      process_name: data.process_name,
      frame_count: data.frame_count,
      jank_count: data.jank_count,
      source: 'enrichment',
      updated_at: Date.now(),
    };

    return {
      interval: buildIntervalFromSession(session),
      entity: session,
      query,
    };
  } catch {
    return null;
  }
}

async function enrichStartup(
  startupId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  const normalizedStartupId = normalizeLooseNumericId(startupId);
  if (!normalizedStartupId) return null;

  const queryTemplate = getDrillDownSkillConfig('startup').enrichmentQuery;
  if (!queryTemplate) return null;
  const query = queryTemplate.replace('$startup_id', normalizedStartupId);

  try {
    const result = await executeTraceQuery(tps, traceId, query);
    const data = toRowObject(result);
    if (!data) return null;

    const startup: StartupResolutionEntity = {
      startup_id: String(data.startup_id ?? normalizedStartupId),
      start_ts: data.start_ts !== undefined ? String(data.start_ts) : undefined,
      end_ts: data.end_ts !== undefined ? String(data.end_ts) : undefined,
      process_name: data.process_name ?? data.package,
      startup_type: data.startup_type !== undefined ? String(data.startup_type) : undefined,
      dur_ms: data.dur_ms,
      ttid_ms: data.ttid_ms,
      ttfd_ms: data.ttfd_ms,
    };

    return {
      interval: buildIntervalFromStartup(startup),
      entity: startup,
      query,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Utilities
// =============================================================================

function buildFrameTokenEnrichmentQuery(frameId: string): string {
  return `
    SELECT
      COALESCE(a.display_frame_token, a.surface_frame_token) as frame_id,
      a.ts as start_ts,
      a.ts + a.dur as end_ts,
      a.dur,
      p.name as process_name,
      a.jank_type,
      a.layer_name,
      NULL as vsync_missed,
      a.upid
    FROM actual_frame_timeline_slice a
    LEFT JOIN process p ON a.upid = p.upid
    WHERE COALESCE(a.display_frame_token, a.surface_frame_token) = ${frameId}
    ORDER BY a.ts
    LIMIT 1
  `;
}

function buildLegacyFrameEnrichmentQuery(frameId: string): string {
  return `
    SELECT
      af.frame_id,
      af.ts as start_ts,
      af.ts + af.dur as end_ts,
      af.dur,
      p.name as process_name,
      ej.jank_type,
      ej.layer_name,
      ej.vsync_missed,
      af.upid
    FROM android_frames af
    LEFT JOIN expected_frame_timeline_events ej ON af.frame_id = ej.frame_id
    LEFT JOIN process p ON af.upid = p.upid
    WHERE af.frame_id = ${frameId}
    LIMIT 1
  `;
}

function buildDoFrameAliasEnrichmentQuery(frameId: string): string {
  return `
    WITH target_slice AS (
      SELECT
        s.ts,
        s.dur,
        t.upid
      FROM slice s
      JOIN thread_track tt ON s.track_id = tt.id
      JOIN thread t ON tt.utid = t.utid
      WHERE s.name = 'Choreographer#doFrame ${frameId}'
         OR s.name GLOB '*Choreographer#doFrame ${frameId}*'
         OR s.name = 'doFrame ${frameId}'
         OR s.name GLOB '*doFrame ${frameId}*'
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
      NULL as vsync_missed,
      a.upid
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

function parseDurMs(dur: any): number | undefined {
  const n = Number(dur);
  if (!Number.isFinite(n)) return undefined;
  return n / 1_000_000;
}

function toRowObject(result: { columns?: string[]; rows?: any[] } | null | undefined): Record<string, any> | null {
  if (!result || !Array.isArray(result.rows) || result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row as Record<string, any>;
  }

  const columns = Array.isArray(result.columns) ? result.columns : [];
  if (!Array.isArray(row) || columns.length === 0) {
    return null;
  }

  const rowObj: Record<string, any> = {};
  columns.forEach((col: string, idx: number) => {
    rowObj[col] = row[idx];
  });
  return rowObj;
}

function hasValidTimestamps(interval: FocusInterval): boolean {
  // Check that timestamps are present and not placeholder '0'
  return (
    !!interval.startTs &&
    !!interval.endTs &&
    interval.startTs !== '0' &&
    interval.endTs !== '0' &&
    !interval.metadata?.needsEnrichment
  );
}

function inferEntityType(interval: FocusInterval): DrillDownEntityType {
  const meta = interval.metadata || {};
  if (meta.sourceEntityType === 'frame' || meta.frame_id || meta.frameId) return 'frame';
  if (meta.sourceEntityType === 'session' || meta.session_id || meta.sessionId) return 'session';
  if (meta.sourceEntityType === 'startup' || meta.startup_id || meta.startupId) return 'startup';
  return 'frame'; // default
}
