/**
 * Follow-Up Handler
 *
 * Resolves follow-up queries by matching entities to previous findings,
 * extracting parameters, and building FocusIntervals for drill-down analysis.
 *
 * Key improvements:
 * - Robust entity ID matching (string/number normalization)
 * - Support for both snake_case and camelCase field names
 * - Fallback interval construction when timestamps are missing
 * - Uses ReferencedEntity.value when available
 */

import { Intent, ReferencedEntity, Finding } from '../types';
import { EnhancedSessionContext } from '../context/enhancedSessionContext';
import { FocusInterval } from '../strategies/types';

export interface FollowUpResolution {
  isFollowUp: boolean;
  resolvedParams: Record<string, any>;
  focusIntervals?: FocusInterval[];
  suggestedStrategy?: string;
  confidence: number;
  resolutionDetails?: string;
}

interface ResolvedEntityResult {
  params: Record<string, any>;
  finding: Finding | null;
}

const ENTITY_PARAM_KEYS: Record<string, string> = {
  frame: 'frame_id',
  session: 'session_id',
  process: 'process_name',
  binder_call: 'binder_txn_id',
  time_range: 'time_range',
};

const ENTITY_LABELS: Record<string, string> = {
  frame: '帧',
  session: '滑动会话',
  process: '进程',
};

// =============================================================================
// ID Normalization Utilities
// =============================================================================

/**
 * Normalize an ID for comparison (handles string/number mismatch).
 * Returns string representation for consistent comparison.
 */
function normalizeId(id: any): string {
  if (id === null || id === undefined) return '';
  return String(id);
}

/**
 * Compare two IDs with type normalization.
 */
function idsMatch(a: any, b: any): boolean {
  return normalizeId(a) === normalizeId(b);
}

/**
 * Get a field value from an object, trying multiple key variations.
 * Supports snake_case and camelCase.
 */
function getField(obj: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
    // Try camelCase conversion
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (obj[camelKey] !== undefined) return obj[camelKey];
    // Try snake_case conversion
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (obj[snakeKey] !== undefined) return obj[snakeKey];
  }
  return undefined;
}

// =============================================================================
// Main Resolution Function
// =============================================================================

/**
 * Resolve a follow-up query using session context.
 */
export function resolveFollowUp(
  intent: Intent,
  sessionContext: EnhancedSessionContext | null
): FollowUpResolution {
  if (!intent.followUpType || intent.followUpType === 'initial' || !sessionContext) {
    return {
      isFollowUp: false,
      resolvedParams: intent.extractedParams || {},
      confidence: 1.0,
    };
  }

  // FIX: Safe spread - handle undefined extractedParams
  const params: Record<string, any> = { ...(intent.extractedParams || {}) };
  const focusIntervals: FocusInterval[] = [];
  const details: string[] = [];

  for (const entity of intent.referencedEntities || []) {
    const resolved = resolveEntityFromFindings(entity, sessionContext);
    if (resolved) {
      Object.assign(params, resolved.params);
      details.push(`${entity.type}:${entity.id} → ${Object.keys(resolved.params).join(', ')}`);

      if (intent.followUpType === 'drill_down') {
        // Try to build interval from finding
        if (resolved.finding) {
          const interval = buildFocusInterval(entity, resolved.finding, focusIntervals.length);
          if (interval) {
            focusIntervals.push(interval);
            continue;
          }
        }
        // Fallback: build interval from resolved params if we have timestamps
        const fallbackInterval = buildFallbackInterval(entity, resolved.params, focusIntervals.length);
        if (fallbackInterval) {
          focusIntervals.push(fallbackInterval);
        }
      }
    }
  }

  // If still no intervals but we have drill-down with entity params, try to construct from params alone
  if (intent.followUpType === 'drill_down' && focusIntervals.length === 0) {
    const minimalInterval = buildMinimalIntervalFromParams(params, intent.referencedEntities || []);
    if (minimalInterval) {
      focusIntervals.push(minimalInterval);
      details.push('Constructed minimal interval from params');
    }
  }

  return {
    isFollowUp: true,
    resolvedParams: params,
    focusIntervals: focusIntervals.length > 0 ? focusIntervals : undefined,
    suggestedStrategy: getSuggestedStrategy(intent.followUpType, params),
    confidence: calculateConfidence(intent, params, focusIntervals),
    resolutionDetails: details.length > 0 ? details.join('; ') : undefined,
  };
}

// =============================================================================
// Entity Resolution
// =============================================================================

function resolveEntityFromFindings(
  entity: ReferencedEntity,
  sessionContext: EnhancedSessionContext
): ResolvedEntityResult | null {
  // Get the entity ID - prefer value if available, fall back to id
  const entityId = entity.value !== undefined ? entity.value : entity.id;
  if (entityId === undefined) return null;

  for (const finding of sessionContext.getAllFindings()) {
    const d = finding.details;
    if (!d) continue;

    // Frame entity matching
    if (entity.type === 'frame') {
      const findingFrameId = getField(d, 'frame_id', 'frameId');
      if (findingFrameId !== undefined && idsMatch(findingFrameId, entityId)) {
        return {
          params: buildFrameParams(entityId, d),
          finding,
        };
      }
    }

    // Session entity matching
    if (entity.type === 'session') {
      const findingSessionId = getField(d, 'session_id', 'sessionId');
      if (findingSessionId !== undefined && idsMatch(findingSessionId, entityId)) {
        return {
          params: buildSessionParams(entityId, d),
          finding,
        };
      }
    }

    // Process entity matching
    if (entity.type === 'process') {
      const processName = getField(d, 'process_name', 'processName', 'package');
      if (processName !== undefined && idsMatch(processName, entityId)) {
        return {
          params: buildProcessParams(entityId, d),
          finding,
        };
      }
    }
  }

  // No finding match - return just the entity id as param
  const paramKey = ENTITY_PARAM_KEYS[entity.type] || `${entity.type}_id`;
  return { params: { [paramKey]: entityId }, finding: null };
}

// =============================================================================
// Parameter Building
// =============================================================================

function buildFrameParams(entityId: any, d: Record<string, any>): Record<string, any> {
  return {
    frame_id: entityId,
    start_ts: getField(d, 'start_ts', 'startTs'),
    end_ts: getField(d, 'end_ts', 'endTs'),
    process_name: getField(d, 'process_name', 'processName', 'package'),
    session_id: getField(d, 'session_id', 'sessionId'),
    ...(getField(d, 'dur', 'duration') && { duration: getField(d, 'dur', 'duration') }),
    ...(getField(d, 'vsync_id', 'vsyncId') && { vsync_id: getField(d, 'vsync_id', 'vsyncId') }),
    ...(getField(d, 'jank_type', 'jankType') && { jank_type: getField(d, 'jank_type', 'jankType') }),
    ...(getField(d, 'dur_ms', 'durMs') && { dur_ms: getField(d, 'dur_ms', 'durMs') }),
    ...(getField(d, 'main_start_ts', 'mainStartTs') && { main_start_ts: getField(d, 'main_start_ts', 'mainStartTs') }),
    ...(getField(d, 'main_end_ts', 'mainEndTs') && { main_end_ts: getField(d, 'main_end_ts', 'mainEndTs') }),
    ...(getField(d, 'render_start_ts', 'renderStartTs') && { render_start_ts: getField(d, 'render_start_ts', 'renderStartTs') }),
    ...(getField(d, 'render_end_ts', 'renderEndTs') && { render_end_ts: getField(d, 'render_end_ts', 'renderEndTs') }),
    ...(getField(d, 'pid') && { pid: getField(d, 'pid') }),
    ...(getField(d, 'layer_name', 'layerName') && { layer_name: getField(d, 'layer_name', 'layerName') }),
  };
}

function buildSessionParams(entityId: any, d: Record<string, any>): Record<string, any> {
  return {
    session_id: entityId,
    start_ts: getField(d, 'start_ts', 'startTs'),
    end_ts: getField(d, 'end_ts', 'endTs'),
    process_name: getField(d, 'process_name', 'processName', 'package'),
    ...(getField(d, 'frame_count', 'frameCount') && { frame_count: getField(d, 'frame_count', 'frameCount') }),
    ...(getField(d, 'jank_count', 'jankCount') && { jank_count: getField(d, 'jank_count', 'jankCount') }),
  };
}

function buildProcessParams(entityId: any, d: Record<string, any>): Record<string, any> {
  const startTs = getField(d, 'start_ts', 'startTs');
  const endTs = getField(d, 'end_ts', 'endTs');
  return {
    process_name: entityId,
    ...(startTs && { start_ts: startTs }),
    ...(endTs && { end_ts: endTs }),
  };
}

// =============================================================================
// Interval Building
// =============================================================================

function buildFocusInterval(
  entity: ReferencedEntity,
  finding: Finding,
  index: number
): FocusInterval | null {
  const d = finding.details;
  if (!d) return null;

  const startTs = getField(d, 'start_ts', 'startTs');
  const endTs = getField(d, 'end_ts', 'endTs');
  if (!startTs || !endTs) return null;

  const entityId = entity.value !== undefined ? entity.value : entity.id;
  const label = ENTITY_LABELS[entity.type]
    ? `${ENTITY_LABELS[entity.type]} ${entityId}`
    : `${entity.type} ${entityId}`;

  return {
    id: typeof entityId === 'number' ? entityId : index,
    processName: getField(d, 'process_name', 'processName', 'package') || '',
    startTs: String(startTs),
    endTs: String(endTs),
    priority: 1,
    label,
    metadata: {
      sourceEntityType: entity.type,
      sourceEntityId: entityId,
      // Normalize all metadata to snake_case for consistency
      frameId: getField(d, 'frame_id', 'frameId'),
      sessionId: getField(d, 'session_id', 'sessionId'),
      jankType: getField(d, 'jank_type', 'jankType'),
      durMs: getField(d, 'dur_ms', 'durMs'),
      mainStartTs: getField(d, 'main_start_ts', 'mainStartTs'),
      mainEndTs: getField(d, 'main_end_ts', 'mainEndTs'),
      renderStartTs: getField(d, 'render_start_ts', 'renderStartTs'),
      renderEndTs: getField(d, 'render_end_ts', 'renderEndTs'),
      pid: getField(d, 'pid'),
      layerName: getField(d, 'layer_name', 'layerName'),
      vsyncMissed: getField(d, 'vsync_missed', 'vsyncMissed'),
    },
  };
}

/**
 * Build a fallback interval from resolved params when no finding is available.
 * This handles cases where entity is recognized but not in findings.
 */
function buildFallbackInterval(
  entity: ReferencedEntity,
  params: Record<string, any>,
  index: number
): FocusInterval | null {
  const startTs = getField(params, 'start_ts', 'startTs');
  const endTs = getField(params, 'end_ts', 'endTs');

  // Can't build interval without timestamps
  if (!startTs || !endTs) return null;

  const entityId = entity.value !== undefined ? entity.value : entity.id;
  const label = ENTITY_LABELS[entity.type]
    ? `${ENTITY_LABELS[entity.type]} ${entityId}`
    : `${entity.type} ${entityId}`;

  return {
    id: typeof entityId === 'number' ? entityId : index,
    processName: getField(params, 'process_name', 'processName', 'package') || '',
    startTs: String(startTs),
    endTs: String(endTs),
    priority: 1,
    label,
    metadata: {
      sourceEntityType: entity.type,
      sourceEntityId: entityId,
      fallback: true, // Mark as fallback-constructed
      ...params,
    },
  };
}

/**
 * Build a minimal interval from params alone when no finding match.
 * This is the last resort for drill-down scenarios.
 */
function buildMinimalIntervalFromParams(
  params: Record<string, any>,
  entities: ReferencedEntity[]
): FocusInterval | null {
  // Need at least an entity ID to be meaningful
  const frameId = getField(params, 'frame_id', 'frameId');
  const sessionId = getField(params, 'session_id', 'sessionId');
  const entityId = frameId || sessionId;
  if (!entityId) return null;

  const startTs = getField(params, 'start_ts', 'startTs');
  const endTs = getField(params, 'end_ts', 'endTs');

  // If we have timestamps, use them
  if (startTs && endTs) {
    const entityType = frameId ? 'frame' : 'session';
    const label = ENTITY_LABELS[entityType]
      ? `${ENTITY_LABELS[entityType]} ${entityId}`
      : `${entityType} ${entityId}`;

    return {
      id: typeof entityId === 'number' ? entityId : 0,
      processName: getField(params, 'process_name', 'processName', 'package') || '',
      startTs: String(startTs),
      endTs: String(endTs),
      priority: 1,
      label,
      metadata: {
        sourceEntityType: frameId ? 'frame' : 'session',
        sourceEntityId: entityId,
        minimal: true, // Mark as minimal construction
        ...params,
      },
    };
  }

  // No timestamps - still create interval but mark it as needing enrichment
  // The DirectDrillDownExecutor will need to handle this case
  const entityType = frameId ? 'frame' : 'session';
  const entity = entities.find(e => e.type === entityType);
  const label = ENTITY_LABELS[entityType]
    ? `${ENTITY_LABELS[entityType]} ${entityId}`
    : `${entityType} ${entityId}`;

  return {
    id: typeof entityId === 'number' ? entityId : 0,
    processName: getField(params, 'process_name', 'processName', 'package') || '',
    startTs: '0', // Placeholder - executor will need to query for real timestamps
    endTs: '0',
    priority: 1,
    label,
    metadata: {
      sourceEntityType: entityType,
      sourceEntityId: entityId,
      needsEnrichment: true, // Signal that timestamps need to be fetched
      ...params,
    },
  };
}

// =============================================================================
// Strategy Suggestion
// =============================================================================

function getSuggestedStrategy(
  followUpType: string,
  params: Record<string, any>
): string | undefined {
  if (followUpType === 'drill_down') {
    if (getField(params, 'frame_id', 'frameId')) return 'frame_drill_down';
    if (getField(params, 'session_id', 'sessionId')) return 'session_drill_down';
  }
  if (followUpType === 'compare') return 'comparison';
  return undefined;
}

// =============================================================================
// Confidence Calculation
// =============================================================================

function calculateConfidence(
  intent: Intent,
  params: Record<string, any>,
  focusIntervals: FocusInterval[]
): number {
  let confidence = 0.5;

  const hasTimestamps = Object.keys(params).some(k =>
    k.includes('_ts') || k.includes('Ts')
  );
  if ((intent.referencedEntities?.length || 0) > 0 && hasTimestamps) {
    confidence += 0.3;
  }
  if (focusIntervals.length > 0) {
    // Higher confidence if intervals don't need enrichment
    const needsEnrichment = focusIntervals.some(i => i.metadata?.needsEnrichment);
    confidence += needsEnrichment ? 0.1 : 0.2;
  }

  return Math.min(confidence, 1.0);
}

// =============================================================================
// Public Utilities
// =============================================================================

/**
 * Find entity data in findings by type and id.
 * Uses normalized ID comparison.
 */
export function findEntityInFindings(
  type: 'frame' | 'session',
  id: number | string,
  sessionContext: EnhancedSessionContext
): Record<string, any> | null {
  const keys = type === 'frame'
    ? ['frame_id', 'frameId']
    : ['session_id', 'sessionId'];

  for (const finding of sessionContext.getAllFindings()) {
    const d = finding.details;
    if (!d) continue;

    for (const key of keys) {
      if (d[key] !== undefined && idsMatch(d[key], id)) {
        return d;
      }
    }
  }
  return null;
}

// Convenience aliases
export const findFrameDataInFindings = (frameId: number | string, ctx: EnhancedSessionContext) =>
  findEntityInFindings('frame', frameId, ctx);

export const findSessionDataInFindings = (sessionId: number | string, ctx: EnhancedSessionContext) =>
  findEntityInFindings('session', sessionId, ctx);
