/**
 * SmartPerfetto Data Contract
 *
 * This file defines the SINGLE SOURCE OF TRUTH for data structures
 * shared between:
 * - Backend (SkillExecutor, AgentDrivenOrchestrator, SSE streaming)
 * - Frontend (AIPanel, SqlResultTable)
 * - HTML Report Generator
 *
 * IMPORTANT: Any changes here must be synchronized with frontend types.
 * Run `npm run generate:frontend-types` to sync types to frontend.
 *
 * @module dataContract
 * @version 2.0.0 - DataEnvelope refactoring
 */

// =============================================================================
// Column Definition System (Phase 0 - DataEnvelope Refactoring)
// =============================================================================

/**
 * Column Data Types - Semantic type of column data
 *
 * The type determines:
 * - How values are parsed and validated
 * - Default formatting
 * - Available click actions
 */
export const VALID_COLUMN_TYPES = [
  'string',      // Text value
  'number',      // Numeric value (int or float)
  'timestamp',   // Time value (in ns by default)
  'duration',    // Duration value (in ns by default)
  'percentage',  // Percentage (0-100 or 0-1)
  'bytes',       // Byte size
  'boolean',     // True/false
  'enum',        // Categorical value
  'json',        // JSON object/array
  'link',        // URL or internal link
] as const;
export type ColumnType = typeof VALID_COLUMN_TYPES[number];

/**
 * Column Format - How to display the value
 */
export const VALID_COLUMN_FORMATS = [
  'default',     // Use type's default formatting
  'compact',     // Abbreviated format (e.g., "1.2M" for 1200000)
  'full',        // Full precision
  'relative',    // Relative to some base (e.g., "+10ms")
  'percentage',  // Show as X%
  'duration_ms', // Show duration in ms
  'duration_us', // Show duration in μs
  'timestamp_relative', // Show as time offset from trace start
  'timestamp_absolute', // Show as absolute timestamp
  'bytes_human', // Show as KB/MB/GB
  'code',        // Monospace/code formatting
  'truncate',    // Truncate long values with ellipsis
] as const;
export type ColumnFormat = typeof VALID_COLUMN_FORMATS[number];

/**
 * Click Action - What happens when user clicks a column value
 */
export const VALID_CLICK_ACTIONS = [
  'none',              // No action
  'navigate_timeline', // Jump to timestamp on Perfetto timeline
  'navigate_range',    // Highlight time range on timeline
  'copy',              // Copy value to clipboard
  'expand',            // Expand to show more details
  'filter',            // Add filter for this value
  'link',              // Open external/internal link
] as const;
export type ClickAction = typeof VALID_CLICK_ACTIONS[number];

/**
 * Column Definition - Complete metadata for a single column
 *
 * This enables self-describing data where the frontend renders
 * based on schema rather than hardcoded column name patterns.
 */
export interface ColumnDefinition {
  /** Column name (must match data column name) */
  name: string;

  /** Human-readable label (defaults to name if not specified) */
  label?: string;

  /** Semantic data type */
  type: ColumnType;

  /** Display format */
  format?: ColumnFormat;

  /** Click action */
  clickAction?: ClickAction;

  /** For timestamp click actions, the associated duration column for range selection */
  durationColumn?: string;

  /** Time unit for timestamp/duration columns (default: 'ns') */
  unit?: 'ns' | 'us' | 'ms' | 's';

  /** Whether this column should be hidden by default */
  hidden?: boolean;

  /** Whether this column is sortable */
  sortable?: boolean;

  /** Default sort direction if this is the default sort column */
  defaultSort?: 'asc' | 'desc';

  /** Column width hint ('narrow', 'medium', 'wide', 'auto' or pixel value) */
  width?: 'narrow' | 'medium' | 'wide' | 'auto' | number;

  /** Tooltip text for column header */
  tooltip?: string;

  /** For enum type, the list of possible values */
  enumValues?: string[];

  /** CSS class to apply to this column */
  cssClass?: string;
}

/**
 * Default column definitions based on common column name patterns
 * Used when skills don't explicitly define columns
 *
 * IMPORTANT: Order matters! More specific patterns should come before generic ones.
 * The first matching pattern wins.
 */
export const DEFAULT_COLUMN_PATTERNS: Array<{
  pattern: RegExp;
  definition: Partial<ColumnDefinition>;
}> = [
  // Timestamp columns (special-case start/end + *_ts_str variants)
  // - end timestamps should jump to a point (navigate_timeline)
  // - start timestamps should prefer range selection when dur_str exists
  { pattern: /^end_ts$|^end_ts_str$|^ts_end$|^end_time$/i,
    definition: { type: 'timestamp', format: 'timestamp_relative', clickAction: 'navigate_timeline', unit: 'ns' } },
  { pattern: /^ts$|^ts_str$|^start_ts$|^start_ts_str$|^start_time$/i,
    definition: { type: 'timestamp', format: 'timestamp_relative', clickAction: 'navigate_range', unit: 'ns', durationColumn: 'dur_str' } },
  { pattern: /_ts$|timestamp$|_timestamp$|start_time|end_time/i,
    definition: { type: 'timestamp', format: 'timestamp_relative', clickAction: 'navigate_timeline', unit: 'ns' } },

  // Duration columns stored as digit strings (e.g., ts_str + dur_str for precise navigation)
  { pattern: /^dur_str$|_dur_str$|^duration_str$|_duration_str$/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ns' } },

  // Duration columns with explicit unit suffixes (MUST be before generic duration pattern)
  // These patterns indicate the value is ALREADY in the specified unit, not nanoseconds
  // _ms suffix: value is already in milliseconds (e.g., vsync_period_ms = 8.33)
  { pattern: /_ms$/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ms' } },
  // _us suffix: value is already in microseconds
  { pattern: /_us$/i,
    definition: { type: 'duration', format: 'duration_us', unit: 'us' } },
  // _ns suffix: value is already in nanoseconds
  { pattern: /_ns$/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ns' } },

  // Generic duration columns (no unit suffix - assume nanoseconds from Perfetto trace)
  { pattern: /^dur$|_dur$|duration$|_duration$|elapsed|latency/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ns' } },

  // Percentage columns - match rate/ratio/percent/pct but EXCLUDE refresh_rate, frame_rate, sample_rate
  // These Hz-based rates are numbers, not percentages
  { pattern: /(?<!refresh_|frame_|sample_)rate$|ratio$|percent|pct$/i,
    definition: { type: 'percentage', format: 'percentage' } },

  // Byte size columns
  { pattern: /size$|bytes$|memory$|_kb$|_mb$|_gb$/i,
    definition: { type: 'bytes', format: 'bytes_human' } },
  // Token ID columns - large integers that should be preserved as strings (no formatting)
  // frame_id is a display_frame_token which can exceed JavaScript's safe integer range
  { pattern: /^frame_id$|^display_frame_token$|^surface_frame_token$/i,
    definition: { type: 'string' } },
  // Count/ID columns (numeric IDs that can be safely formatted)
  { pattern: /^id$|_id$|^count$|_count$|^num_|_num$|^pid$|^tid$|^upid$|^utid$|^session_id$|^track_id$|^slice_id$|^arg_set_id$|_index$|^frame_index$/i,
    definition: { type: 'number', format: 'compact' } },
  // Boolean columns
  { pattern: /^is_|^has_|^can_|_flag$/i,
    definition: { type: 'boolean' } },
];

/**
 * Infer column definition from column name using patterns
 */
export function inferColumnDefinition(columnName: string): ColumnDefinition {
  for (const { pattern, definition } of DEFAULT_COLUMN_PATTERNS) {
    if (pattern.test(columnName)) {
      return { name: columnName, type: 'string', ...definition };
    }
  }
  // Default: string type
  return { name: columnName, type: 'string' };
}

// =============================================================================
// DataEnvelope - The Core Data Container (Phase 0)
// =============================================================================

/**
 * DataEnvelope Meta - Metadata about the data origin and version
 */
export interface DataEnvelopeMeta {
  /** Data type identifier */
  type: 'skill_result' | 'sql_result' | 'ai_response' | 'diagnostic' | 'chart';

  /** Schema version for forward compatibility */
  version: string;

  /** Source identifier (skill ID, query hash, etc.) */
  source: string;

  /** Creation timestamp */
  timestamp: number;

  /** Optional skill ID if from skill execution */
  skillId?: string;

  /** Optional step ID within a skill */
  stepId?: string;
}

/**
 * DataEnvelope Display Config - How to render this data
 */
export interface DataEnvelopeDisplay {
  /** Display layer (overview, list, session, deep) */
  layer: DisplayLayer;

  /** Display format (table, chart, text, etc.) */
  format: DisplayFormat;

  /** Title to display */
  title: string;

  /** Column definitions for table format */
  columns?: ColumnDefinition[];

  /** Fields to extract as metadata (displayed in header, not columns) */
  metadataFields?: string[];

  /** Highlight rules for conditional styling */
  highlights?: HighlightRule[];

  /** Whether this result should be expanded by default */
  defaultExpanded?: boolean;

  /** Level of detail (key, summary, detail, debug) */
  level?: DisplayLevel;

  // === Phase 3: Output Structure Optimization ===

  /** Rendering priority (0 = highest). Used by frontend to order envelopes within a group. */
  priority?: number;

  /** Group identifier for grouping related envelopes (e.g. "interval_1"). */
  group?: string;

  /** Data severity level. Frontend uses this to sort (critical first) and style. */
  severity?: 'critical' | 'warning' | 'info' | 'normal';

  /** Whether this envelope's table is collapsible in the UI. */
  collapsible?: boolean;

  /** Whether this envelope should be collapsed by default (requires collapsible=true). */
  defaultCollapsed?: boolean;

  /** Maximum number of visible rows before "show more" truncation. */
  maxVisibleRows?: number;
}

/**
 * DataEnvelope - Self-describing data container
 *
 * This is the UNIFIED format for all data flowing through the system.
 * The frontend renders based on `display` configuration rather than
 * hardcoding field names.
 *
 * @template T The type of the data payload
 */
export interface DataEnvelope<T = DataPayload> {
  /** Metadata about data origin */
  meta: DataEnvelopeMeta;

  /** The actual data payload */
  data: T;

  /** Display configuration */
  display: DataEnvelopeDisplay;
}

/**
 * Create a DataEnvelope from raw data
 */
export function createDataEnvelope<T = DataPayload>(
  data: T,
  options: {
    type: DataEnvelopeMeta['type'];
    source: string;
    skillId?: string;
    stepId?: string;
    title: string;
    layer?: DisplayLayer;
    format?: DisplayFormat;
    columns?: ColumnDefinition[];
    metadataFields?: string[];
    highlights?: HighlightRule[];
    level?: DisplayLevel;
  }
): DataEnvelope<T> {
  return {
    meta: {
      type: options.type,
      version: '2.0.0',
      source: options.source,
      timestamp: Date.now(),
      skillId: options.skillId,
      stepId: options.stepId,
    },
    data,
    display: {
      layer: options.layer || 'list',
      format: options.format || 'table',
      title: options.title,
      columns: options.columns,
      metadataFields: options.metadataFields,
      highlights: options.highlights,
      level: options.level || 'detail',
    },
  };
}

/**
 * Build column definitions from raw column names
 * Uses explicit definitions if provided, falls back to inference
 */
export function buildColumnDefinitions(
  columnNames: string[],
  explicitDefinitions?: Partial<ColumnDefinition>[]
): ColumnDefinition[] {
  const explicitMap = new Map<string, Partial<ColumnDefinition>>();
  if (explicitDefinitions) {
    for (const def of explicitDefinitions) {
      if (def.name) {
        explicitMap.set(def.name, def);
      }
    }
  }

  return columnNames.map(name => {
    const explicit = explicitMap.get(name);
    const inferred = inferColumnDefinition(name);
    return {
      ...inferred,
      ...explicit,
      name, // Ensure name is always correct
    };
  });
}

// =============================================================================
// Display Layer System
// =============================================================================

/**
 * Display Layers - Controls WHERE data appears in the UI
 *
 * - overview: L1 - Top-level aggregated metrics (summary cards)
 * - list: L2 - Main data tables with rows
 * - session: Session-level grouping (e.g., scroll sessions)
 * - deep: L4 - Detailed analysis (expandable rows in L2)
 *
 * This is an EXHAUSTIVE list. To add a new layer:
 * 1. Add to this array
 * 2. Update frontend layer handling
 * 3. Update HTML report generation
 */
export const VALID_DISPLAY_LAYERS = ['overview', 'list', 'session', 'deep'] as const;
export type DisplayLayer = typeof VALID_DISPLAY_LAYERS[number];

/**
 * Validate if a string is a valid DisplayLayer
 */
export function isValidDisplayLayer(layer: string | undefined): layer is DisplayLayer {
  if (!layer) return false;
  return VALID_DISPLAY_LAYERS.includes(layer as DisplayLayer);
}

/**
 * Display Levels - Controls HOW MUCH detail to show
 *
 * - none: Do not display
 * - debug: Only show in debug mode
 * - detail: Show full details
 * - summary: Show summarized version
 * - key: Key metric, always prominent
 */
export const VALID_DISPLAY_LEVELS = ['none', 'debug', 'detail', 'summary', 'key'] as const;
export type DisplayLevel = typeof VALID_DISPLAY_LEVELS[number];

/**
 * Display Formats - HOW to render the data
 */
export const VALID_DISPLAY_FORMATS = ['table', 'chart', 'text', 'timeline', 'summary', 'metric'] as const;
export type DisplayFormat = typeof VALID_DISPLAY_FORMATS[number];

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * SSE Event Types for streaming updates
 *
 * NEW (v2.0):
 * - data: Unified event carrying DataEnvelope or DataEnvelope[]
 *
 * LEGACY (still supported for backward compatibility):
 * - skill_data: Contains LayeredSkillResult from skill execution
 * - skill_layered_result: Alias for skill_data
 *
 * COMMON:
 * - finding: Individual finding/diagnostic
 * - progress: Phase/step progress update
 * - error: Error message
 * - analysis_completed: Final result with report URL
 */
export const SSE_EVENT_TYPES = [
  // v2.0 unified event
  'data',
  // Legacy events (backward compatibility)
  'skill_data',
  'skill_layered_result',
  // Common events
  'finding',
  'progress',
  'error',
  'analysis_completed',
  'thought',
  'tool_call',
  'conclusion',
  'scene_detected',
  'track_data',
  'worker_thought',
  'architecture_detected',
] as const;
export type SSEEventType = typeof SSE_EVENT_TYPES[number];

/**
 * Unified Data Event - v2.0 SSE event format
 *
 * Carries one or more DataEnvelopes with their complete display metadata.
 * Frontend can render directly based on envelope's display configuration.
 */
export interface DataEvent {
  type: 'data';
  /** Unique event ID for deduplication */
  id: string;
  /** Single envelope or array of envelopes */
  envelope: DataEnvelope | DataEnvelope[];
  timestamp: number;
}

/**
 * Check if SSE event type is the new unified data event
 */
export function isDataEvent(eventType: string): eventType is 'data' {
  return eventType === 'data';
}

/**
 * Check if SSE event type is a legacy skill data event
 */
export function isLegacySkillEvent(eventType: string): boolean {
  return eventType === 'skill_data' || eventType === 'skill_layered_result';
}

// =============================================================================
// Layered Result Structure (The Core Data Contract)
// =============================================================================

/**
 * Metadata Configuration - Defines which fields should be extracted as metadata
 *
 * Metadata fields are extracted from the first row and displayed in the header
 * instead of as columns. This is configurable per skill.
 */
export interface MetadataConfig {
  /** Field names to extract as metadata (displayed in header, not as columns) */
  fields: string[];
  /** Optional labels for metadata fields */
  labels?: Record<string, string>;
}

/**
 * Default metadata fields - extracted from data if present
 * These are commonly used fields that make sense as metadata
 */
export const DEFAULT_METADATA_FIELDS = [
  'layer_name',
  'process_name',
  'package_name',
  'architecture',
  'device_model',
  'android_version',
] as const;

/**
 * Highlight Rule - For conditional styling of rows
 */
export interface HighlightRule {
  /** Condition expression (e.g., "jank_type != 'None'") */
  condition: string;
  /** CSS color or preset name */
  color?: string;
  /** Icon identifier */
  icon?: string;
  /** Severity level for default styling */
  severity?: 'info' | 'warning' | 'critical';
}

/**
 * Data Payload - The actual data content
 */
export interface DataPayload {
  /** Column names (for table format) */
  columns?: string[];
  /** Row data as 2D array (for table format) */
  rows?: any[][];
  /** Text content (for text format) */
  text?: string;
  /** Chart configuration (for chart format) */
  chart?: ChartConfig;
  /** Summary content (for summary format) */
  summary?: SummaryContent;
  /** Expandable row data (for L2 with L4 details) */
  expandableData?: ExpandableRowData[];
}

/**
 * Chart Configuration
 */
export interface ChartConfig {
  type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap';
  data: any;
  options?: Record<string, any>;
}

/**
 * Summary Content
 */
export interface SummaryContent {
  title: string;
  content: string;
  metrics?: Array<{
    label: string;
    value: string | number;
    unit?: string;
    severity?: 'info' | 'warning' | 'critical';
  }>;
}

/**
 * Expandable Row Data - L4 deep analysis embedded in L2 rows
 */
export interface ExpandableRowData {
  /** Original row data (the L2 item) */
  item: Record<string, any>;
  /** Deep analysis result */
  result: {
    success: boolean;
    /** Sections of deep analysis, keyed by section ID */
    sections?: Record<string, SectionData>;
    error?: string;
  };
}

/**
 * Section Data - A single section in deep analysis
 */
export interface SectionData {
  title: string;
  format: DisplayFormat;
  data: DataPayload;
}

/**
 * Display Result - A single displayable result from a skill step
 *
 * This is the CORE structure that flows from backend to frontend.
 */
export interface DisplayResult {
  /** Step ID from skill definition */
  stepId: string;
  /** Display title */
  title: string;
  /** Display level (verbosity) */
  level: DisplayLevel;
  /** Display layer (UI placement) */
  layer?: DisplayLayer;
  /** Display format (rendering type) */
  format: DisplayFormat;
  /** The actual data */
  data: DataPayload;
  /** Highlight rules for conditional styling */
  highlight?: HighlightRule[];
  /** Original SQL query (for reproducibility) */
  sql?: string;
  /** Metadata configuration for this result */
  metadataConfig?: MetadataConfig;
}

/**
 * Layered Skill Result - Organized results by layer
 *
 * This is what flows through SSE to frontend.
 */
export interface LayeredSkillResult {
  /** Skill identifier */
  skillId: string;
  /** Human-readable skill name */
  skillName: string;
  /** Results organized by layer */
  layers: {
    overview?: Record<string, DisplayResult>;
    list?: Record<string, DisplayResult>;
    session?: Record<string, DisplayResult>;
    deep?: Record<string, DisplayResult>;
  };
  /** Diagnostic findings */
  diagnostics?: DiagnosticFinding[];
  /** Metadata about the execution */
  metadata: {
    executedAt: string;
    executionTimeMs: number;
    version?: string;
  };
  /** Data marked for synthesis/summary generation */
  synthesizeData?: SynthesizeDataItem[];
}

/**
 * Diagnostic Finding - A finding/issue discovered during analysis
 */
export interface DiagnosticFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description?: string;
  evidence?: Record<string, any>;
  suggestions?: string[];
  confidence: number;
  sourceModule?: string;
}

/**
 * Synthesize Data Item - Data marked for AI summary generation
 */
export interface SynthesizeDataItem {
  stepId: string;
  title: string;
  data: any;
}

// =============================================================================
// SSE Event Payloads
// =============================================================================

/**
 * Skill Data Event - SSE payload for skill results
 */
export interface SkillDataEvent {
  type: 'skill_data';
  data: LayeredSkillResult;
  timestamp: number;
}

/**
 * Finding Event - SSE payload for individual findings
 */
export interface FindingEvent {
  type: 'finding';
  data: DiagnosticFinding;
  timestamp: number;
}

/**
 * Progress Event - SSE payload for progress updates
 */
export interface ProgressEvent {
  type: 'progress';
  data: {
    phase: string;
    message: string;
    step?: number;
    totalSteps?: number;
    details?: Record<string, any>;
  };
  timestamp: number;
}

/**
 * Analysis Completed Event - SSE payload for final result
 */
export interface AnalysisCompletedEvent {
  type: 'analysis_completed';
  data: {
    summary: string;
    conclusionContract?: import('../agent/core/conclusionContract').ConclusionContract;
    reportUrl?: string;
    findings: DiagnosticFinding[];
    suggestions: string[];
  };
  timestamp: number;
}

/**
 * Union type for all SSE events
 */
export type SSEEvent =
  | SkillDataEvent
  | FindingEvent
  | ProgressEvent
  | AnalysisCompletedEvent;

// =============================================================================
// HTML Report Data Structures
// =============================================================================

/**
 * Report Section - A section in the HTML report
 */
export interface ReportSection {
  id: string;
  title: string;
  type: 'summary' | 'table' | 'findings' | 'chart' | 'text';
  layer?: DisplayLayer;
  content: DisplayResult | DiagnosticFinding[] | string;
}

/**
 * HTML Report Data - Input for HTML report generation
 */
export interface HTMLReportData {
  traceId: string;
  query: string;
  timestamp: number;
  executionTimeMs: number;
  /** Results organized by layer */
  layeredResults: LayeredSkillResult[];
  /** All findings across all skills */
  findings: DiagnosticFinding[];
  /** Generated summary/answer */
  summary: string;
  /** Organized sections for report */
  sections?: ReportSection[];
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  value?: any;
}

/**
 * Validate a DisplayResult structure
 */
export function validateDisplayResult(result: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!result) {
    errors.push({ path: '', message: 'DisplayResult is null or undefined' });
    return errors;
  }

  if (!result.stepId) {
    errors.push({ path: 'stepId', message: 'stepId is required' });
  }

  if (!result.title) {
    errors.push({ path: 'title', message: 'title is required' });
  }

  if (result.layer && !isValidDisplayLayer(result.layer)) {
    errors.push({
      path: 'layer',
      message: `Invalid layer: ${result.layer}. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
      value: result.layer
    });
  }

  if (result.level && !VALID_DISPLAY_LEVELS.includes(result.level)) {
    errors.push({
      path: 'level',
      message: `Invalid level: ${result.level}. Valid values: ${VALID_DISPLAY_LEVELS.join(', ')}`,
      value: result.level
    });
  }

  if (result.format && !VALID_DISPLAY_FORMATS.includes(result.format)) {
    errors.push({
      path: 'format',
      message: `Invalid format: ${result.format}. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
      value: result.format
    });
  }

  return errors;
}

/**
 * Validate a LayeredSkillResult structure
 */
export function validateLayeredSkillResult(result: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!result) {
    errors.push({ path: '', message: 'LayeredSkillResult is null or undefined' });
    return errors;
  }

  if (!result.skillId) {
    errors.push({ path: 'skillId', message: 'skillId is required' });
  }

  if (!result.layers) {
    errors.push({ path: 'layers', message: 'layers object is required' });
    return errors;
  }

  // Validate each layer's results
  for (const layerName of VALID_DISPLAY_LAYERS) {
    const layer = result.layers[layerName];
    if (layer) {
      for (const [stepId, displayResult] of Object.entries(layer)) {
        const displayErrors = validateDisplayResult(displayResult);
        for (const err of displayErrors) {
          errors.push({
            path: `layers.${layerName}.${stepId}.${err.path}`,
            message: err.message,
            value: err.value
          });
        }
      }
    }
  }

  return errors;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract metadata from a data row based on configured fields
 */
export function extractMetadata(
  row: Record<string, any> | any[],
  columns: string[],
  metadataFields: string[] = [...DEFAULT_METADATA_FIELDS]
): Record<string, any> {
  const metadata: Record<string, any> = {};

  if (Array.isArray(row)) {
    // Row is an array, use columns to map
    for (const field of metadataFields) {
      const idx = columns.indexOf(field);
      if (idx >= 0 && row[idx] !== undefined && row[idx] !== null) {
        metadata[field] = row[idx];
      }
    }
  } else if (typeof row === 'object') {
    // Row is an object
    for (const field of metadataFields) {
      if (row[field] !== undefined && row[field] !== null) {
        metadata[field] = row[field];
      }
    }
  }

  return metadata;
}

/**
 * Remove metadata columns from column list
 */
export function filterMetadataColumns(
  columns: string[],
  metadataFields: string[] = [...DEFAULT_METADATA_FIELDS]
): string[] {
  return columns.filter(col => !metadataFields.includes(col));
}

/**
 * Organize DisplayResults into LayeredSkillResult
 */
export function organizeIntoLayers(
  skillId: string,
  skillName: string,
  displayResults: DisplayResult[],
  diagnostics: DiagnosticFinding[] = [],
  executionTimeMs: number = 0
): LayeredSkillResult {
  const layers: LayeredSkillResult['layers'] = {
    overview: {},
    list: {},
    session: {},
    deep: {},
  };

  for (const result of displayResults) {
    const layer = result.layer || 'list'; // Default to list
    if (isValidDisplayLayer(layer)) {
      layers[layer]![result.stepId] = result;
    }
  }

  return {
    skillId,
    skillName,
    layers,
    diagnostics,
    metadata: {
      executedAt: new Date().toISOString(),
      executionTimeMs,
    },
  };
}

// =============================================================================
// DataEnvelope Conversion Utilities
// =============================================================================

/**
 * Convert a DisplayResult to a DataEnvelope
 *
 * This bridges the legacy DisplayResult format to the new DataEnvelope format,
 * enabling gradual migration.
 */
export function displayResultToEnvelope(
  result: DisplayResult,
  skillId: string,
  explicitColumns?: Partial<ColumnDefinition>[]
): DataEnvelope {
  // Build column definitions from data columns
  const columns = result.data.columns
    ? buildColumnDefinitions(result.data.columns, explicitColumns)
    : undefined;

  return createDataEnvelope(result.data, {
    type: 'skill_result',
    source: `${skillId}:${result.stepId}`,
    skillId,
    stepId: result.stepId,
    title: result.title,
    layer: result.layer,
    format: result.format,
    columns,
    metadataFields: result.metadataConfig?.fields,
    highlights: result.highlight,
    level: result.level,
  });
}

/**
 * Convert a LayeredSkillResult to an array of DataEnvelopes
 *
 * Each DisplayResult in each layer becomes a separate DataEnvelope.
 */
export function layeredResultToEnvelopes(
  result: LayeredSkillResult,
  columnDefinitions?: Record<string, Partial<ColumnDefinition>[]>
): DataEnvelope[] {
  const envelopes: DataEnvelope[] = [];

  for (const layerName of VALID_DISPLAY_LAYERS) {
    const layer = result.layers[layerName];
    if (!layer) continue;

    for (const [stepId, displayResult] of Object.entries(layer)) {
      // Prefer external columnDefinitions, fallback to embedded columnDefinitions in DisplayResult
      const explicitColumns = columnDefinitions?.[stepId] ?? (displayResult as any).columnDefinitions;
      const envelope = displayResultToEnvelope(displayResult, result.skillId, explicitColumns);
      envelopes.push(envelope);
    }
  }

  return envelopes;
}

/**
 * Convert a DataEnvelope back to DisplayResult (for backward compatibility)
 */
export function envelopeToDisplayResult(envelope: DataEnvelope): DisplayResult {
  return {
    stepId: envelope.meta.stepId || envelope.meta.source,
    title: envelope.display.title,
    level: envelope.display.level || 'detail',
    layer: envelope.display.layer,
    format: envelope.display.format,
    data: envelope.data as DataPayload,
    highlight: envelope.display.highlights,
    metadataConfig: envelope.display.metadataFields
      ? { fields: envelope.display.metadataFields }
      : undefined,
  };
}

/**
 * Convert an array of DataEnvelopes to LayeredSkillResult
 */
export function envelopesToLayeredResult(
  envelopes: DataEnvelope[],
  skillId: string,
  skillName: string,
  diagnostics: DiagnosticFinding[] = [],
  executionTimeMs: number = 0
): LayeredSkillResult {
  const displayResults = envelopes.map(envelopeToDisplayResult);
  return organizeIntoLayers(skillId, skillName, displayResults, diagnostics, executionTimeMs);
}

// =============================================================================
// Enhanced Validation
// =============================================================================

/**
 * Validate a ColumnDefinition
 */
export function validateColumnDefinition(column: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!column) {
    errors.push({ path: '', message: 'ColumnDefinition is null or undefined' });
    return errors;
  }

  if (!column.name || typeof column.name !== 'string') {
    errors.push({ path: 'name', message: 'name is required and must be a string' });
  }

  if (!column.type || !VALID_COLUMN_TYPES.includes(column.type)) {
    errors.push({
      path: 'type',
      message: `Invalid column type: ${column.type}. Valid values: ${VALID_COLUMN_TYPES.join(', ')}`,
      value: column.type,
    });
  }

  if (column.format && !VALID_COLUMN_FORMATS.includes(column.format)) {
    errors.push({
      path: 'format',
      message: `Invalid column format: ${column.format}. Valid values: ${VALID_COLUMN_FORMATS.join(', ')}`,
      value: column.format,
    });
  }

  if (column.clickAction && !VALID_CLICK_ACTIONS.includes(column.clickAction)) {
    errors.push({
      path: 'clickAction',
      message: `Invalid click action: ${column.clickAction}. Valid values: ${VALID_CLICK_ACTIONS.join(', ')}`,
      value: column.clickAction,
    });
  }

  return errors;
}

/**
 * Validate a DataEnvelope
 */
export function validateDataEnvelope(envelope: any): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!envelope) {
    errors.push({ path: '', message: 'DataEnvelope is null or undefined' });
    return errors;
  }

  // Validate meta
  if (!envelope.meta) {
    errors.push({ path: 'meta', message: 'meta is required' });
  } else {
    if (!envelope.meta.type) {
      errors.push({ path: 'meta.type', message: 'meta.type is required' });
    }
    if (!envelope.meta.source) {
      errors.push({ path: 'meta.source', message: 'meta.source is required' });
    }
    if (!envelope.meta.version) {
      errors.push({ path: 'meta.version', message: 'meta.version is required' });
    }
  }

  // Validate display
  if (!envelope.display) {
    errors.push({ path: 'display', message: 'display is required' });
  } else {
    if (!envelope.display.layer || !isValidDisplayLayer(envelope.display.layer)) {
      errors.push({
        path: 'display.layer',
        message: `Invalid display layer: ${envelope.display.layer}. Valid values: ${VALID_DISPLAY_LAYERS.join(', ')}`,
        value: envelope.display.layer,
      });
    }
    if (!envelope.display.format || !VALID_DISPLAY_FORMATS.includes(envelope.display.format)) {
      errors.push({
        path: 'display.format',
        message: `Invalid display format: ${envelope.display.format}. Valid values: ${VALID_DISPLAY_FORMATS.join(', ')}`,
        value: envelope.display.format,
      });
    }
    if (!envelope.display.title) {
      errors.push({ path: 'display.title', message: 'display.title is required' });
    }

    // Validate columns if present
    if (envelope.display.columns && Array.isArray(envelope.display.columns)) {
      for (let i = 0; i < envelope.display.columns.length; i++) {
        const columnErrors = validateColumnDefinition(envelope.display.columns[i]);
        for (const err of columnErrors) {
          errors.push({
            path: `display.columns[${i}].${err.path}`,
            message: err.message,
            value: err.value,
          });
        }
      }
    }
  }

  // Validate data exists
  if (envelope.data === undefined) {
    errors.push({ path: 'data', message: 'data is required' });
  }

  return errors;
}

/**
 * Generate a unique event ID for deduplication
 */
export function generateEventId(skillId: string, stepId?: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return stepId ? `${skillId}:${stepId}:${timestamp}:${random}` : `${skillId}:${timestamp}:${random}`;
}
