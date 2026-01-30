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
 * Main API response for /api/agent/teaching/pipeline
 */
export interface TeachingPipelineResponse {
  success: boolean;
  detection: PipelineDetectionResult;
  teachingContent: TeachingContentResponse | null;
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
  primaryConfidence: number;
  candidates: PipelineCandidate[];
  features: DetectedFeature[];
  traceRequirementsMissing: string[];
}

/**
 * Pipeline candidate from detection
 */
export interface PipelineCandidate {
  id: string;
  confidence: number;
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
  detection_sql: string;
  fallback_sql?: string;
}

/**
 * Raw teaching content from YAML
 */
export interface RawTeachingContent {
  title: string;
  summary: string;
  mermaid?: string;
  thread_roles: RawThreadRole[];
  key_slices: RawKeySlice[];
}

/**
 * Raw thread role from YAML
 */
export interface RawThreadRole {
  thread: string;
  role: string;
  description?: string;
  trace_tags?: string;
}

/**
 * Raw key slice from YAML
 */
export interface RawKeySlice {
  name: string;
  thread: string;
  description?: string;
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

/**
 * Transform raw teaching content (snake_case) to API response (camelCase)
 *
 * @param raw - Raw teaching content from YAML
 * @param docPath - Documentation file path
 * @returns Transformed teaching content for frontend
 */
export function transformTeachingContent(
  raw: RawTeachingContent,
  docPath: string
): TeachingContentResponse {
  return {
    title: raw.title,
    summary: raw.summary,
    mermaidBlocks: raw.mermaid ? [raw.mermaid] : [],
    threadRoles: raw.thread_roles.map((role) => ({
      thread: role.thread,
      responsibility: role.role + (role.description ? `: ${role.description}` : ''),
      traceTag: role.trace_tags,
    })),
    keySlices: raw.key_slices.map((slice) => slice.name),
    docPath,
  };
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

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if value is a valid PinInstructionResponse
 */
export function isPinInstructionResponse(value: unknown): value is PinInstructionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.pattern === 'string' &&
    typeof obj.matchBy === 'string' &&
    typeof obj.priority === 'number' &&
    typeof obj.reason === 'string'
  );
}

/**
 * Type guard to check if value is a valid ActiveProcess
 */
export function isActiveProcess(value: unknown): value is ActiveProcess {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.upid === 'number' &&
    typeof obj.processName === 'string' &&
    typeof obj.frameCount === 'number' &&
    typeof obj.renderThreadTid === 'number'
  );
}
