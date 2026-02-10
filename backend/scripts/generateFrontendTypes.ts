/**
 * Generate Frontend Types from Backend Data Contract
 *
 * This script extracts type definitions from backend/src/types/dataContract.ts
 * and generates a frontend-compatible version.
 *
 * Why this exists:
 * - Backend uses Node.js/CommonJS style
 * - Frontend (Perfetto UI) uses ES modules with different build system
 * - Some backend constructs (const arrays for validation) need to be converted to union types
 *
 * Usage: npm run generate:frontend-types
 */

import * as fs from 'fs';
import * as path from 'path';

// Paths
const projectRoot = path.resolve(__dirname, '../..');
const backendContractPath = path.join(projectRoot, 'backend/src/types/dataContract.ts');
const frontendOutputPath = path.join(
  projectRoot,
  'perfetto/ui/src/plugins/com.smartperfetto.AIAssistant/generated/data_contract.types.ts'
);

/**
 * Extract string values from a const array definition
 * Handles both multi-line arrays with comments and single-line arrays
 */
function extractConstArrayValues(content: string, constName: string): string[] {
  // Match the const array including multi-line content
  const regex = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`, 'm');
  const match = content.match(regex);
  if (!match) return [];

  const arrayContent = match[1];
  const values: string[] = [];

  // First, remove all comments from the content
  const withoutComments = arrayContent
    .split('\n')
    .map(line => line.split('//')[0])  // Remove single-line comments
    .join(' ');

  // Now extract all single-quoted strings
  const stringRegex = /'([^']+)'/g;
  let stringMatch;
  while ((stringMatch = stringRegex.exec(withoutComments)) !== null) {
    const value = stringMatch[1].trim();
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }

  return values;
}

// Read backend contract
console.log('Reading backend data contract...');
const backendContent = fs.readFileSync(backendContractPath, 'utf-8');

// Transform content for frontend
console.log('Transforming for frontend compatibility...');

// Extract values from const arrays
const columnTypes = extractConstArrayValues(backendContent, 'VALID_COLUMN_TYPES');
const columnFormats = extractConstArrayValues(backendContent, 'VALID_COLUMN_FORMATS');
const clickActions = extractConstArrayValues(backendContent, 'VALID_CLICK_ACTIONS');
const displayLayers = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LAYERS');
const displayLevels = extractConstArrayValues(backendContent, 'VALID_DISPLAY_LEVELS');
const displayFormats = extractConstArrayValues(backendContent, 'VALID_DISPLAY_FORMATS');

// Build the frontend content
const parts: string[] = [];

// Header
parts.push(`/**
 * SmartPerfetto Data Contract Types (Frontend)
 *
 * AUTO-GENERATED from backend/src/types/dataContract.ts
 * DO NOT EDIT MANUALLY - Changes will be overwritten
 *
 * To regenerate: npm run generate:frontend-types
 *
 * @module dataContract.types
 * @version 2.0.0 - DataEnvelope refactoring
 * @generated ${new Date().toISOString()}
 */
`);

// Column Types Section
parts.push(`// =============================================================================
// Column Definition System
// =============================================================================

/**
 * Column Data Types - Semantic type of column data
 */
export type ColumnType =
${columnTypes.map(t => `  | '${t}'`).join('\n')};

/**
 * Column Format - How to display the value
 */
export type ColumnFormat =
${columnFormats.map(t => `  | '${t}'`).join('\n')};

/**
 * Click Action - What happens when user clicks a column value
 */
export type ClickAction =
${clickActions.map(t => `  | '${t}'`).join('\n')};

/**
 * Display Layers - Controls WHERE data appears in the UI
 */
export type DisplayLayer =
${displayLayers.map(t => `  | '${t}'`).join('\n')};

/**
 * Display Levels - Controls HOW MUCH detail to show
 */
export type DisplayLevel =
${displayLevels.map(t => `  | '${t}'`).join('\n')};

/**
 * Display Formats - HOW to render the data
 */
export type DisplayFormat =
${displayFormats.map(t => `  | '${t}'`).join('\n')};
`);

// Interfaces
parts.push(`// =============================================================================
// Column Definition Interface
// =============================================================================

/**
 * Column Definition - Complete metadata for a single column
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

// =============================================================================
// DataEnvelope Types
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

  // === Output Structure Optimization ===

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
 * Chart Configuration
 */
export interface ChartConfig {
  type: 'line' | 'bar' | 'pie' | 'scatter' | 'heatmap';
  data: unknown;
  options?: Record<string, unknown>;
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
 * Section Data - A single section in deep analysis
 */
export interface SectionData {
  title: string;
  format: DisplayFormat;
  data: DataPayload;
}

/**
 * Expandable Row Data - L4 deep analysis embedded in L2 rows
 */
export interface ExpandableRowData {
  /** Original row data (the L2 item) */
  item: Record<string, unknown>;
  /** Deep analysis result */
  result: {
    success: boolean;
    /** Sections of deep analysis, keyed by section ID */
    sections?: Record<string, SectionData>;
    error?: string;
  };
}

/**
 * Data Payload - The actual data content
 */
export interface DataPayload {
  /** Column names (for table format) */
  columns?: string[];
  /** Row data as 2D array (for table format) */
  rows?: unknown[][];
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
 * DataEnvelope - Self-describing data container
 *
 * This is the UNIFIED format for all data flowing through the system.
 * The frontend renders based on \`display\` configuration rather than
 * hardcoding field names.
 */
export interface DataEnvelope<T = DataPayload> {
  /** Metadata about data origin */
  meta: DataEnvelopeMeta;

  /** The actual data payload */
  data: T;

  /** Display configuration */
  display: DataEnvelopeDisplay;
}

// =============================================================================
// Layered Result Types (Legacy Support)
// =============================================================================

/**
 * Metadata Configuration - Defines which fields should be extracted as metadata
 */
export interface MetadataConfig {
  /** Field names to extract as metadata */
  fields: string[];
  /** Optional labels for metadata fields */
  labels?: Record<string, string>;
}

/**
 * Display Result - A single displayable result from a skill step
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
 * Diagnostic Finding - A finding/issue discovered during analysis
 */
export interface DiagnosticFinding {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description?: string;
  evidence?: Record<string, unknown>;
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
  data: unknown;
}

/**
 * Layered Skill Result - Organized results by layer
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

// =============================================================================
// SSE Event Types
// =============================================================================

/**
 * Unified Data Event - v2.0 SSE event format
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
 * Skill Data Event - Legacy SSE payload for skill results
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
    details?: Record<string, unknown>;
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
    conclusionContract?: unknown;
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
  | DataEvent
  | SkillDataEvent
  | FindingEvent
  | ProgressEvent
  | AnalysisCompletedEvent;

// =============================================================================
// SQL Query Result (Frontend Compatibility Type)
// =============================================================================

/**
 * SQL Query Result - Frontend-specific result format for display
 * This is the format expected by SqlResultTable component
 */
export interface SqlQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  query?: string;
  sectionTitle?: string;
  columnDefinitions?: ColumnDefinition[];
  title?: string;
  stepId?: string;
  layer?: DisplayLayer;
  metadataFields?: string[];
  expandableData?: ExpandableRowData[];
  // Grouping/collapse metadata (from DataEnvelope.display)
  group?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  maxVisibleRows?: number;
  // Summary report data
  summaryReport?: {
    title: string;
    content: string;
    keyMetrics?: Array<{
      name: string;
      value: string;
      status?: 'good' | 'warning' | 'critical';
    }>;
  };
}

// =============================================================================
// Column Definition Utilities
// =============================================================================

/**
 * Default column patterns for inferring column types from names
 */
const DEFAULT_COLUMN_PATTERNS: Array<{
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
  // _us suffix: value is in microseconds, normalize display to ms
  { pattern: /_us$/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'us' } },
  // _ns suffix: value is already in nanoseconds
  { pattern: /_ns$/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ns' } },

  // Generic duration columns (no unit suffix - assume nanoseconds from Perfetto trace)
  { pattern: /^dur$|_dur$|duration$|_duration$|elapsed|latency/i,
    definition: { type: 'duration', format: 'duration_ms', unit: 'ns' } },
  // Percentage columns
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
      return { name: columnName, type: 'string', ...definition } as ColumnDefinition;
    }
  }
  // Default: string type
  return { name: columnName, type: 'string' };
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
// Type Guards and Conversion Utilities
// =============================================================================

/**
 * Check if an object is a DataEnvelope
 */
export function isDataEnvelope(obj: unknown): obj is DataEnvelope {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'meta' in obj &&
    'data' in obj &&
    'display' in obj
  );
}

/**
 * Check if SSE event is the new unified data event
 */
export function isDataEvent(event: unknown): event is DataEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    (event as Record<string, unknown>).type === 'data'
  );
}

/**
 * Check if SSE event is a legacy skill data event
 */
export function isLegacySkillEvent(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('type' in event)) {
    return false;
  }
  const type = (event as Record<string, unknown>).type;
  return type === 'skill_data' || type === 'skill_layered_result';
}

/**
 * Check if a string is a valid DisplayLayer
 */
export function isValidDisplayLayer(layer: string | undefined): layer is DisplayLayer {
  if (!layer) return false;
  return ['overview', 'list', 'session', 'deep'].includes(layer);
}

/**
 * Convert a DataEnvelope to SqlQueryResult for frontend display
 */
export function envelopeToSqlQueryResult(envelope: DataEnvelope): SqlQueryResult {
  const data = envelope.data;
  const rows = data.rows || [];

  return {
    columns: data.columns || [],
    rows: rows,
    rowCount: rows.length,
    columnDefinitions: envelope.display.columns,
    title: envelope.display.title,
    sectionTitle: envelope.display.title,
    stepId: envelope.meta.stepId,
    layer: envelope.display.layer,
    metadataFields: envelope.display.metadataFields,
    expandableData: data.expandableData,
  };
}
`);

const frontendContent = parts.join('\n');

// Ensure output directory exists
const outputDir = path.dirname(frontendOutputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write output
fs.writeFileSync(frontendOutputPath, frontendContent);
console.log(`\n✅ Generated frontend types at:\n   ${frontendOutputPath}`);

// Log the extracted types for verification
console.log('\nExtracted types:');
console.log(`  ColumnType: ${columnTypes.length} values`);
console.log(`  ColumnFormat: ${columnFormats.length} values`);
console.log(`  ClickAction: ${clickActions.length} values`);
console.log(`  DisplayLayer: ${displayLayers.length} values`);
console.log(`  DisplayLevel: ${displayLevels.length} values`);
console.log(`  DisplayFormat: ${displayFormats.length} values`);

// Update index.ts to export data_contract.types
const indexPath = path.join(outputDir, 'index.ts');
const indexContent = `// Auto-generated exports
export * from './data_contract.types';
export * from './frame_analysis.types';
export * from './jank_frame_detail.types';
`;
fs.writeFileSync(indexPath, indexContent);
console.log('\n✅ Updated index.ts with exports');

console.log('\nDone! Frontend types are now in sync with backend.');
