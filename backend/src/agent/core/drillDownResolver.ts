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
 * - frame_id or session_id is present in the query
 */

import type { Intent, ReferencedEntity } from '../types';
import type { EnhancedSessionContext } from '../context/enhancedSessionContext';
import type { FollowUpResolution } from './followUpHandler';
import type { FocusInterval } from '../strategies/types';
import type { FrameEntity, SessionEntity, EntityId } from '../context/entityStore';

// =============================================================================
// Types
// =============================================================================

export type ResolutionSource = 'explicit' | 'cache' | 'finding' | 'enrichment' | 'fallback';

/**
 * Trace of how an entity was resolved - for observability
 */
export interface DrillDownResolutionTrace {
  entityType: 'frame' | 'session';
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
  executeQuery(traceId: string, sql: string): Promise<{ columns: string[]; rows: any[][] }>;
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

function normalizeEntityLookupId(entityType: 'frame' | 'session', id: any): string {
  const numeric = normalizeLooseNumericId(id);
  if (numeric !== null) return numeric;
  return String(id);
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
    if (entity.type !== 'frame' && entity.type !== 'session') continue;

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

  const entityId = entity.id ?? value.frame_id ?? value.session_id ?? 0;

  return {
    id: typeof entityId === 'number' ? entityId : 0,
    processName: value.process_name || value.processName || '',
    startTs: String(startTs),
    endTs: String(endTs),
    priority: 1,
    label: `${entity.type === 'frame' ? '帧' : '会话'} ${entityId}`,
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

function buildIntervalFromParams(entity: ReferencedEntity, params: Record<string, any>): FocusInterval {
  const entityId = entity.id ?? params.frame_id ?? params.session_id ?? 0;

  return {
    id: typeof entityId === 'number' ? entityId : parseInt(String(entityId), 10) || 0,
    processName: params.process_name || params.processName || '',
    startTs: String(params.start_ts || params.startTs || '0'),
    endTs: String(params.end_ts || params.endTs || '0'),
    priority: 1,
    label: `${entity.type === 'frame' ? '帧' : '会话'} ${entityId}`,
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
  entity: FrameEntity | SessionEntity;
  query: string;
}

async function enrichEntity(
  type: 'frame' | 'session',
  entityId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  if (type === 'frame') {
    return enrichFrame(entityId, tps, traceId);
  } else {
    return enrichSession(entityId, tps, traceId);
  }
}

async function enrichFrame(
  frameId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  // Query actual_frame_timeline_slice for frame timestamps
  // This is a lightweight query targeting a single frame
  const query = `
    SELECT
      frame_id,
      ts as start_ts,
      ts + dur as end_ts,
      dur,
      process_name,
      upid,
      jank_type,
      layer_name
    FROM actual_frame_timeline_slice
    WHERE frame_id = ${frameId}
    LIMIT 1
  `;

  try {
    const result = await tps.executeQuery(traceId, query);
    if (!result.rows || result.rows.length === 0) return null;

    const row = result.rows[0];
    const columns = result.columns;
    const data: Record<string, any> = {};
    columns.forEach((col, i) => {
      data[col] = row[i];
    });

    const frame: FrameEntity = {
      frame_id: String(frameId),
      start_ts: String(data.start_ts),
      end_ts: String(data.end_ts),
      process_name: data.process_name,
      jank_type: data.jank_type,
      layer_name: data.layer_name,
      pid: data.upid,
      dur_ms: data.dur ? Number(data.dur) / 1_000_000 : undefined,
      source: 'enrichment',
      updated_at: Date.now(),
    };

    return {
      interval: buildIntervalFromFrame(frame),
      entity: frame,
      query,
    };
  } catch {
    return null;
  }
}

async function enrichSession(
  sessionId: any,
  tps: TraceProcessorServiceLike,
  traceId: string
): Promise<EnrichmentResult | null> {
  // Query scroll_jank_intervals for session timestamps
  const query = `
    SELECT
      scroll_id as session_id,
      MIN(ts) as start_ts,
      MAX(ts + dur) as end_ts,
      COUNT(*) as frame_count,
      COUNT(CASE WHEN jank_type IS NOT NULL THEN 1 END) as jank_count
    FROM actual_frame_timeline_slice
    WHERE scroll_id = ${sessionId}
    GROUP BY scroll_id
    LIMIT 1
  `;

  try {
    const result = await tps.executeQuery(traceId, query);
    if (!result.rows || result.rows.length === 0) return null;

    const row = result.rows[0];
    const columns = result.columns;
    const data: Record<string, any> = {};
    columns.forEach((col, i) => {
      data[col] = row[i];
    });

    const session: SessionEntity = {
      session_id: String(sessionId),
      start_ts: String(data.start_ts),
      end_ts: String(data.end_ts),
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

// =============================================================================
// Utilities
// =============================================================================

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

function inferEntityType(interval: FocusInterval): 'frame' | 'session' {
  const meta = interval.metadata || {};
  if (meta.sourceEntityType === 'frame' || meta.frame_id || meta.frameId) return 'frame';
  if (meta.sourceEntityType === 'session' || meta.session_id || meta.sessionId) return 'session';
  return 'frame'; // default
}
