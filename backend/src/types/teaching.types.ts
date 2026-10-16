// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Teaching Module Types
 *
 * Centralized type definitions for the teaching pipeline feature.
 * This file serves as the single source of truth for:
 * - API response types (camelCase for frontend)
 * - Internal types (snake_case from YAML/SQL)
 * - Transformation utilities
 * - Validation helpers
 *
 * @module types/teaching
 */

// =============================================================================
// API Response Types (camelCase - Frontend Contract)
// =============================================================================

/**
 * Main API response for /api/agent/v1/teaching/pipeline
 */
export interface TeachingPipelineResponse {
  success: boolean;
  schemaVersion?: 'teaching.pipeline.v2';
  detection: TeachingDetectionResponse;
  observedFlow?: ObservedFlow;
  teaching?: TeachingContentResponse | null;
  teachingContent?: TeachingContentResponse | null;
  pinPlan?: TeachingPinPlan;
  overlayPlan?: TeachingOverlayPlan;
  warnings?: TeachingWarning[];
  pinInstructions: PinInstructionResponse[];
  activeRenderingProcesses: ActiveProcess[];
  error?: string;
}

/**
 * Pipeline detection result
 */
export interface PipelineDetectionResult {
  detected: boolean;
  primaryPipelineId: string;
  primaryRenderingTypeId: string;
  primaryConfidence: number;
  candidates: PipelineCandidate[];
  renderingTypeCandidates: PipelineCandidate[];
  relatedRenderingTypes: RelatedRenderingTypeCandidate[];
  features: DetectedFeature[];
  traceRequirementsMissing: string[];
}

/**
 * Backward-compatible API detection payload.
 *
 * The historical teaching endpoint returns snake_case fields. Keep those fields
 * stable while exposing camelCase aliases for new frontend code.
 */
export interface TeachingDetectionResponse {
  detected: boolean;
  primaryPipelineId: string;
  primaryRenderingTypeId: string;
  primaryConfidence: number;
  primary_pipeline: {
    id: string;
    confidence: number;
  };
  renderingType: {
    id: string;
    docPath: string;
  };
  candidates: PipelineCandidate[];
  renderingTypeCandidates: PipelineCandidate[];
  relatedRenderingTypes: RelatedRenderingTypeCandidate[];
  features: DetectedFeature[];
  subvariants: RenderingPipelineSubvariants;
  traceRequirementsMissing: string[];
  trace_requirements_missing: string[];
}

export interface RenderingPipelineSubvariants {
  buffer_mode: string;
  flutter_engine: string;
  webview_mode: string;
  game_engine: string;
}

/**
 * Pipeline candidate from detection
 */
export interface PipelineCandidate {
  id: string;
  confidence: number;
}

export interface RelatedRenderingTypeCandidate extends PipelineCandidate {
  docPath: string;
}

/**
 * Detected feature from pipeline analysis
 */
export interface DetectedFeature {
  name: string;
  detected: boolean;
  value?: string | number;
}

/**
 * Teaching content for frontend display
 */
export interface TeachingContentResponse {
  title: string;
  summary: string;
  mermaidBlocks: string[];
  threadRoles: ThreadRoleResponse[];
  keySlices: string[];
  docPath: string;
}

/**
 * Thread role for frontend display
 */
export interface ThreadRoleResponse {
  thread: string;
  responsibility: string;
  traceTag?: string;
}

/**
 * Pin instruction for frontend (camelCase)
 */
export interface PinInstructionResponse {
  pattern: string;
  matchBy: 'name' | 'uri' | 'thread' | 'process' | 'slice';
  priority: number;
  reason: string;
  expand?: boolean;           // Whether to expand the track after pinning
  mainThreadOnly?: boolean;   // Only pin main thread (track.chips includes 'main thread')
  smartPin?: boolean;
  skipPin?: boolean;
  activeProcessNames?: string[];
}

/**
 * Active rendering process detected in trace
 */
export interface ActiveProcess {
  upid: number;
  processName: string;
  frameCount: number;
  renderThreadTid: number;
}

export interface TeachingPipelineRequest {
  traceId: string;
  outputLanguage?: 'zh-CN' | 'en';
  packageName?: string;
  processName?: string;
  selectionContext?: Record<string, unknown>;
  visibleWindow?: Record<string, unknown>;
  startTs?: number | string;
  endTs?: number | string;
}

export type ObservedFlowLaneRole =
  | 'app'
  | 'render_thread'
  | 'producer'
  | 'buffer_queue'
  | 'surfaceflinger'
  | 'hwc_present'
  | 'critical_task'
  | 'unknown';

export interface ObservedFlowTrackHint {
  matchBy: 'thread' | 'process' | 'slice' | 'layer' | 'uri' | 'name';
  pattern: string;
  processName?: string;
  threadName?: string;
  layerName?: string;
  mainThreadOnly?: boolean;
}

export interface ObservedFlowLane {
  id: string;
  role: ObservedFlowLaneRole;
  title: string;
  processName?: string;
  threadName?: string;
  layerName?: string;
  trackHint?: ObservedFlowTrackHint;
  pipelineIds: string[];
  confidence: number;
  evidenceSource: string;
}

export interface ObservedFlowEvent {
  id: string;
  stage: string;
  name: string;
  ts: number;
  dur: number;
  durMs: number;
  processName?: string;
  threadName?: string;
  trackId?: number;
  utid?: number;
  upid?: number;
  threadStateId?: number;
  criticalTaskId?: string;
  laneId?: string;
  evidenceSource: string;
  relatedFrame?: string;
  relatedLayer?: string;
  confidence: number;
}

export interface ObservedFlowDependency {
  fromLaneId: string;
  toLaneId: string;
  relation:
    | 'produces_to'
    | 'composes_to'
    | 'presents_to'
    | 'overlaps_with'
    | 'wakes_to'
    | 'critical_path_to';
  confidence: number;
  evidenceSource: string;
  fromEventId?: string;
  toEventId?: string;
  fromTaskId?: string;
  toTaskId?: string;
  detail?: string;
}

export interface ObservedFlowWakeupRef {
  threadStateId?: number;
  utid?: number;
  processName?: string;
  threadName?: string;
  state?: string;
  irqContext?: boolean;
  kind?: 'irq' | 'swapper' | 'thread' | 'unknown';
}

export interface ObservedFlowCriticalTask {
  id: string;
  kind: 'direct_wakeup' | 'critical_path_segment';
  rootEventId: string;
  rootLaneId?: string;
  laneId?: string;
  name: string;
  ts: number;
  dur: number;
  durMs: number;
  processName?: string;
  threadName?: string;
  utid?: number;
  threadStateId?: number;
  state?: string;
  waker?: ObservedFlowWakeupRef;
  evidenceSource: string;
  confidence: number;
}

export interface ObservedFlow {
  schemaVersion: 'observed-flow.v1';
  context: {
    traceId: string;
    packageName?: string;
    processName?: string;
    timeRange?: {
      startTs: number;
      endTs: number;
      source: string;
    };
    selection?: Record<string, unknown>;
    sourcePriority: string[];
    fallbackUsed?: string;
  };
  lanes: ObservedFlowLane[];
  events: ObservedFlowEvent[];
  dependencies: ObservedFlowDependency[];
  criticalTasks?: ObservedFlowCriticalTask[];
  completeness: {
    level: 'high' | 'medium' | 'low';
    missingSignals: string[];
    warnings: string[];
  };
}

export interface TeachingWarning {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  source: 'detection' | 'observed_flow' | 'pin' | 'overlay' | 'teaching';
}

export interface TeachingPinPlan {
  status: 'planned' | 'empty' | 'partial' | 'failed';
  instructions: PinInstructionResponse[];
  expectedLaneIds: string[];
  expectedTrackHints: ObservedFlowTrackHint[];
  summary: string;
  warnings: string[];
}

export interface TeachingOverlayPlan {
  status: 'ready' | 'empty' | 'partial' | 'failed';
  skillId: 'pipeline_key_slices_overlay';
  eventIds: string[];
  keySliceNames: string[];
  timeRange?: {
    startTs: number;
    endTs: number;
    source: string;
  };
  summary: string;
  warnings: string[];
}

// =============================================================================
// Internal Types (snake_case - From YAML/SQL)
// =============================================================================

/**
 * Raw pin instruction from YAML (snake_case)
 */
export interface RawPinInstruction {
  pattern: string;
  match_by: 'name' | 'uri';
  priority: number;
  reason: string;
  expand?: boolean;           // Whether to expand the track after pinning
  main_thread_only?: boolean; // Only pin main thread (track.chips includes 'main thread')
  smart_filter?: RawSmartFilter;
}

/**
 * Raw smart filter config from YAML
 */
export interface RawSmartFilter {
  enabled: boolean;
  description?: string;
  // Optional for forward compatibility. Current smart pinning relies on a centralized
  // active-process query rather than per-instruction SQL evaluation.
  detection_sql?: string;
  fallback_sql?: string;
}

// =============================================================================
// SQL Result Types
// =============================================================================

/**
 * Generic SQL result structure from skill execution
 */
export interface SqlResult {
  columns?: string[];
  rows?: unknown[][];
  error?: string;
}

/**
 * Raw step data returned by SkillExecutor.
 *
 * Note: In rawResults, SkillExecutor returns an array of objects (one per row),
 * not the {columns, rows} table structure used by displayResults.
 */
export type SkillStepData = Array<Record<string, unknown>> | SqlResult;

/**
 * Step result from skill execution
 */
export interface SkillStepResult {
  data?: SkillStepData;
  error?: string;
}

// =============================================================================
// Transformation Functions
// =============================================================================

/**
 * Transform raw pin instruction (snake_case) to API response (camelCase)
 *
 * @param raw - Raw pin instruction from YAML
 * @param activeProcesses - Active rendering processes from SQL
 * @returns Transformed pin instruction for frontend
 */
export function transformPinInstruction(
  raw: RawPinInstruction,
  activeProcesses: ActiveProcess[]
): PinInstructionResponse {
  const base: PinInstructionResponse = {
    pattern: raw.pattern,
    matchBy: raw.match_by,
    priority: raw.priority,
    reason: raw.reason,
  };

  // Pass through expand and main_thread_only flags
  if (raw.expand !== undefined) {
    base.expand = raw.expand;
  }
  if (raw.main_thread_only !== undefined) {
    base.mainThreadOnly = raw.main_thread_only;
  }

  // Apply smart filter logic if enabled
  if (raw.smart_filter?.enabled) {
    if (activeProcesses.length > 0) {
      base.smartPin = true;
      base.activeProcessNames = activeProcesses.map((p) => p.processName);
    } else {
      // If we can't identify active rendering processes, fall back to normal pinning.
      // This avoids missing critical tracks (e.g. app main thread) on sparse traces.
      base.reason = `${raw.reason} (未检测到活跃渲染进程，使用默认 Pin)`;
    }
  }

  return base;
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate and extract active processes from SQL result
 *
 * Uses column name mapping instead of positional access to prevent
 * silent failures when column order changes.
 *
 * @param stepResult - Step result from skill execution
 * @returns Validated array of active processes
 */
export function validateActiveProcesses(stepResult: SkillStepResult | undefined): ActiveProcess[] {
  if (!stepResult?.data) {
    console.warn('[Teaching] Missing step data for active_rendering_processes');
    return [];
  }

  // New (SkillExecutor rawResults): array of objects
  if (Array.isArray(stepResult.data)) {
    const processes: ActiveProcess[] = [];

    for (const row of stepResult.data) {
      if (!row || typeof row !== 'object') continue;

      const processName =
        (typeof row.process_name === 'string' && row.process_name) ||
        (typeof row.processName === 'string' && row.processName) ||
        (typeof row.name === 'string' && row.name) ||
        '';
      if (!processName) continue;

      const upidRaw = row.upid ?? row.UPID;
      const frameCountRaw = row.frame_count ?? row.frameCount ?? row.count;
      const tidRaw = row.render_thread_tid ?? row.renderThreadTid ?? row.tid;

      processes.push({
        upid: typeof upidRaw === 'number' ? upidRaw : parseInt(String(upidRaw ?? ''), 10) || 0,
        processName,
        frameCount:
          typeof frameCountRaw === 'number' ? frameCountRaw : parseInt(String(frameCountRaw ?? ''), 10) || 0,
        renderThreadTid: typeof tidRaw === 'number' ? tidRaw : parseInt(String(tidRaw ?? ''), 10) || 0,
      });
    }

    return processes;
  }

  // Legacy table structure: { columns, rows }
  const legacy = stepResult.data as SqlResult;
  if (!legacy.rows || !Array.isArray(legacy.rows)) {
    console.warn('[Teaching] Invalid SQL result structure for active_rendering_processes');
    return [];
  }

  const { columns, rows } = legacy;

  // Check columns exist
  if (!columns || !Array.isArray(columns) || columns.length < 4) {
    console.warn('[Teaching] Insufficient columns in SQL result, expected 4, got:', columns?.length);
    return [];
  }

  // Build column index map for name-based access
  const colIndex = new Map<string, number>();
  columns.forEach((col, i) => {
    if (typeof col === 'string') {
      colIndex.set(col.toLowerCase(), i);
    }
  });

  // Required columns (support both snake_case and as-is)
  const getColIdx = (names: string[]): number => {
    for (const name of names) {
      const idx = colIndex.get(name.toLowerCase());
      if (idx !== undefined) return idx;
    }
    return -1;
  };

  const upidIdx = getColIdx(['upid']);
  const processNameIdx = getColIdx(['process_name', 'processname', 'name']);
  const frameCountIdx = getColIdx(['frame_count', 'framecount', 'count']);
  const tidIdx = getColIdx(['render_thread_tid', 'renderthreadtid', 'tid']);

  // Validate required columns found
  if (upidIdx === -1 || processNameIdx === -1) {
    console.warn('[Teaching] Missing required columns (upid, process_name). Available:', columns);
    return [];
  }

  // Transform rows with validation
  const processes: ActiveProcess[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;

    const processName = row[processNameIdx];
    if (!processName || typeof processName !== 'string') continue;

    processes.push({
      upid: typeof row[upidIdx] === 'number' ? row[upidIdx] : parseInt(String(row[upidIdx])) || 0,
      processName: processName,
      frameCount:
        frameCountIdx !== -1 && typeof row[frameCountIdx] === 'number'
          ? row[frameCountIdx]
          : parseInt(String(row[frameCountIdx])) || 0,
      renderThreadTid:
        tidIdx !== -1 && typeof row[tidIdx] === 'number'
          ? row[tidIdx]
          : parseInt(String(row[tidIdx])) || 0,
    });
  }

  return processes;
}

/**
 * Validate confidence value is in valid range [0, 1]
 *
 * @param value - Raw confidence value
 * @param defaultValue - Default if invalid
 * @returns Validated confidence between 0 and 1
 */
export function validateConfidence(value: unknown, defaultValue = 0.5): number {
  if (typeof value === 'number' && !isNaN(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return defaultValue;
}

/**
 * Safely parse candidates from detection result
 *
 * @param candidates - Raw candidates string or array
 * @param limit - Maximum number of candidates to return
 * @returns Validated array of pipeline candidates
 */
export function parseCandidates(candidates: unknown, limit = 10): PipelineCandidate[] {
  if (!candidates) return [];

  // Handle string format: "id1:0.9,id2:0.8"
  if (typeof candidates === 'string') {
    return candidates
      .split(/[;,]/)
      .slice(0, limit)
      .map((item) => {
        const [id, score] = item.split(':');
        return {
          id: id?.trim() || 'unknown',
          confidence: validateConfidence(score),
        };
      })
      .filter((c) => c.id !== 'unknown');
  }

  // Handle array format
  if (Array.isArray(candidates)) {
    return candidates.slice(0, limit).map((item) => {
      if (typeof item === 'object' && item !== null) {
        return {
          id: String((item as Record<string, unknown>).id || 'unknown'),
          confidence: validateConfidence((item as Record<string, unknown>).confidence),
        };
      }
      return { id: String(item), confidence: 0 };
    });
  }

  return [];
}

/**
 * Safely parse features from detection result
 *
 * @param features - Raw features string or array
 * @returns Validated array of detected features
 */
export function parseFeatures(features: unknown): DetectedFeature[] {
  if (!features) return [];

  // Handle string format: "feature1,feature2,feature3"
  if (typeof features === 'string') {
    return features
      .split(/[;,]/)
      .filter((f) => f.trim())
      .map((raw) => {
        const item = raw.trim();
        const [name, valueRaw] = item.split(':');
        const value = valueRaw !== undefined ? Number(valueRaw) : NaN;
        return {
          name: (name || item).trim(),
          detected: true,
          value: Number.isFinite(value) ? value : undefined,
        };
      });
  }

  // Handle array format
  if (Array.isArray(features)) {
    return features.map((item) => {
      if (typeof item === 'string') {
        return { name: item, detected: true };
      }
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        return {
          name: String(obj.name || obj.feature || 'unknown'),
          detected: obj.detected !== false,
          value: obj.value as string | number | undefined,
        };
      }
      return { name: String(item), detected: true };
    });
  }

  return [];
}
