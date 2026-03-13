import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { skillRegistry } from '../services/skillEngine/skillLoader';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import { displayResultToEnvelope } from '../types/dataContract';
import type { DisplayResult as SkillDisplayResult } from '../services/skillEngine/types';
import type { StreamingUpdate } from '../agent/types';
import type { SqlSchemaIndex, AnalysisNote, AnalysisPlanV3, PlanRevision, Hypothesis, UncertaintyFlag } from './types';
import type { SceneType } from './sceneClassifier';
import { summarizeSqlResult } from './sqlSummarizer';
import { matchPatterns, matchNegativePatterns, extractTraceFeatures } from './analysisPatternMemory';
import type { ArtifactStore } from './artifactStore';

/** MCP tool name prefix — derived from the server name 'smartperfetto'.
 * Shared constant to avoid duplication across runtime, MCP server, and agent definitions. */
export const MCP_NAME_PREFIX = 'mcp__smartperfetto__';

let sqlSchemaCache: SqlSchemaIndex | null = null;

/**
 * SQL structural keywords to exclude when computing Jaccard similarity
 * for error-fix pair matching. Without this filter, any two Perfetto SQL
 * queries match at >30% simply by sharing common keywords like SELECT/FROM/WHERE.
 */
const SQL_STOP_WORDS = new Set([
  // SQL structural keywords
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'cross', 'full',
  'group', 'by', 'order', 'limit', 'having', 'offset',
  'with', 'case', 'when', 'then', 'else', 'end',
  'null', 'like', 'glob', 'between',
  'cast', 'count', 'sum', 'avg', 'max', 'min', 'round', 'coalesce',
  'lag', 'lead', 'over', 'partition', 'row_number', 'rank',
  'distinct', 'union', 'all', 'exists', 'into',
  'asc', 'desc', 'true', 'false', 'integer', 'text', 'real',
  'printf', 'substr', 'instr', 'replace', 'length', 'trim', 'upper', 'lower',
  // Perfetto domain-structural tokens — appear in virtually all trace queries
  // and inflate Jaccard similarity between unrelated queries
  'upid', 'utid', 'track_id', 'layer_name', 'jank_type', 'dur', 'name',
  'surface_frame_token', 'display_frame_token', 'frame_number',
  'process', 'thread', 'slice', 'counter', 'counter_track',
  'actual_frame_timeline_slice', 'expected_frame_timeline_slice',
]);

/** Extract meaningful content tokens from SQL, filtering out structural keywords. */
function sqlContentTokens(sql: string): Set<string> {
  return new Set(
    sql.toLowerCase()
      .split(/[\s,()=<>!+\-*/|;'"]+/)
      .filter(t => t.length > 2 && !SQL_STOP_WORDS.has(t))
  );
}

const SQL_ERROR_LOG_DIR = path.resolve(__dirname, '../../logs/sql_learning');

interface SqlErrorFixPair {
  errorSql: string;
  errorMessage: string;
  fixedSql?: string;
  timestamp: number;
}

/**
 * Load previously learned SQL error-fix pairs from disk.
 * Returns only pairs that have a fixedSql (i.e., successfully corrected).
 * Used to seed new sessions with cross-session learning.
 */
/** TTL for error-fix pairs: 30 days. Older pairs may reference outdated schemas. */
const ERROR_FIX_PAIR_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * P0-G2: ReAct reasoning nudge — appended to successful data tool results.
 * Prompts Claude to explicitly reason about observations before next action.
 * Cost: ~20 tokens per data tool call, ~200-300 total per analysis.
 */
const REASONING_NUDGE = '\n\n[REFLECT] 在执行下一步之前：这个数据的关键发现是什么？是否支持/反驳你的假设？如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';

export function loadLearnedSqlFixPairs(maxPairs = 10): SqlErrorFixPair[] {
  try {
    const logFile = path.join(SQL_ERROR_LOG_DIR, 'error_fix_pairs.json');
    if (!fs.existsSync(logFile)) return [];
    const data = fs.readFileSync(logFile, 'utf-8');
    const pairs: SqlErrorFixPair[] = JSON.parse(data);
    const cutoff = Date.now() - ERROR_FIX_PAIR_TTL_MS;
    // Only return pairs that have successful fixes and are within TTL
    return pairs
      .filter(p => p.fixedSql && p.timestamp >= cutoff)
      .slice(-maxPairs);
  } catch {
    return [];
  }
}

async function logSqlErrorFixPair(pair: SqlErrorFixPair): Promise<void> {
  try {
    const logFile = path.join(SQL_ERROR_LOG_DIR, 'error_fix_pairs.json');
    let pairs: SqlErrorFixPair[] = [];
    try {
      const data = await fs.promises.readFile(logFile, 'utf-8');
      pairs = JSON.parse(data);
    } catch { /* fresh start */ }
    // Deduplicate: if an equivalent error+fix pair already exists, update timestamp instead of appending
    const existingIdx = pairs.findIndex(p =>
      p.errorMessage === pair.errorMessage && p.fixedSql === pair.fixedSql
    );
    if (existingIdx >= 0) {
      pairs[existingIdx].timestamp = pair.timestamp;
    } else {
      pairs.push(pair);
    }
    // Keep last 200 pairs
    if (pairs.length > 200) pairs = pairs.slice(-200);
    await fs.promises.mkdir(SQL_ERROR_LOG_DIR, { recursive: true });
    // Atomic write: write to tmp file, then rename
    const tmpFile = logFile + '.tmp';
    await fs.promises.writeFile(tmpFile, JSON.stringify(pairs));
    await fs.promises.rename(tmpFile, logFile);
  } catch (err) {
    console.warn('[ClaudeMCP] Failed to log SQL error-fix pair:', (err as Error).message);
  }
}

function loadSqlSchema(): SqlSchemaIndex {
  if (sqlSchemaCache) return sqlSchemaCache;

  const indexPath = path.resolve(__dirname, '../../data/perfettoSqlIndex.light.json');
  try {
    const raw = fs.readFileSync(indexPath, 'utf-8');
    sqlSchemaCache = JSON.parse(raw) as SqlSchemaIndex;
  } catch (err) {
    console.warn('[ClaudeMCP] Failed to load SQL schema index:', (err as Error).message);
    sqlSchemaCache = { version: '0.0.0', generatedAt: '', templates: [] };
  }
  return sqlSchemaCache;
}

/**
 * Normalize synthesizeData entry's `data` field into { columns, rows } format.
 * synthesizeData entries can be:
 *   - Array of objects: [{ col1: val1, col2: val2 }, ...]
 *   - Already columnar: { columns: [...], rows: [[...], ...] }
 *   - Iterator results: [{ itemIndex, item, result: { ... } }]
 *   - Single object: { key: value, ... }
 * All are normalized to { columns: string[], rows: any[][] } for ArtifactStore.
 */
function normalizeSynthesizeDataForStorage(data: any): { columns: string[]; rows: any[][] } {
  if (!data) return { columns: [], rows: [] };

  // Already columnar format
  if (data.columns && Array.isArray(data.rows)) {
    return { columns: data.columns, rows: data.rows };
  }

  // Array of objects
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    // Iterator format: flatten item + result
    if (first && typeof first === 'object' && 'itemIndex' in first && 'result' in first) {
      const allKeys = new Set<string>();
      const flatRows = data.map((entry: any) => {
        const flat: Record<string, any> = { itemIndex: entry.itemIndex };
        // Merge item fields
        if (entry.item && typeof entry.item === 'object') {
          for (const [k, v] of Object.entries(entry.item)) {
            flat[k] = v;
            allKeys.add(k);
          }
        }
        // Merge result fields (top-level scalars only, skip nested objects)
        if (entry.result && typeof entry.result === 'object') {
          for (const [k, v] of Object.entries(entry.result)) {
            if (typeof v !== 'object' || v === null) {
              flat[`result_${k}`] = v;
              allKeys.add(`result_${k}`);
            }
          }
        }
        allKeys.add('itemIndex');
        return flat;
      });
      const columns = ['itemIndex', ...Array.from(allKeys).filter(k => k !== 'itemIndex')];
      const rows = flatRows.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Plain array of objects
    if (typeof first === 'object' && first !== null) {
      const columns = Object.keys(first);
      const rows = data.map((row: Record<string, any>) => columns.map(c => row[c] ?? null));
      return { columns, rows };
    }

    // Array of primitives — single column
    return { columns: ['value'], rows: data.map((v: any) => [v]) };
  }

  // Single object → single row
  if (typeof data === 'object' && data !== null) {
    const columns = Object.keys(data);
    const rows = [columns.map(c => data[c] ?? null)];
    return { columns, rows };
  }

  // Scalar
  return { columns: ['value'], rows: [[data]] };
}

export interface ClaudeMcpServerOptions {
  traceId: string;
  traceProcessorService: TraceProcessorService;
  skillExecutor: SkillExecutor;
  packageName?: string;
  /** Callback to emit StreamingUpdate events (e.g. DataEnvelopes from skill results) */
  emitUpdate?: (update: StreamingUpdate) => void;
  /** Callback when invoke_skill returns a successful result (used for entity capture) */
  onSkillResult?: (result: { skillId: string; displayResults: Array<{ stepId?: string; data?: any }> }) => void;
  /** Mutable notes array for the write_analysis_note tool — passed by reference from analyze() scope */
  analysisNotes?: AnalysisNote[];
  /** Optional artifact store for token-efficient skill result references */
  artifactStore?: ArtifactStore;
  /** Cached architecture detection result — avoids redundant re-detection */
  cachedArchitecture?: import('../agent/detectors/types').ArchitectureInfo;
  /** Per-session SQL error-fix pairs for in-context learning */
  recentSqlErrors?: SqlErrorFixPair[];
  /** Mutable analysis plan — passed by reference from analyze() scope */
  analysisPlan?: { current: AnalysisPlanV3 | null };
  /** Mutable watchdog warning — set by runtime when repetitive failures detected, consumed by next tool call */
  watchdogWarning?: { current: string | null };
  /** Mutable hypotheses array for hypothesis-verify cycle (P0-G4) */
  hypotheses?: Hypothesis[];
  /** Scene type for plan template validation (P1-G11) */
  sceneType?: SceneType;
  /** Mutable uncertainty flags array (P1-G1) */
  uncertaintyFlags?: UncertaintyFlag[];
  /** Cached vendor detection result (e.g. "xiaomi", "pixel", "aosp") — avoids redundant re-detection */
  cachedVendor?: string | null;
}

/**
 * Creates an in-process MCP server scoped to a specific trace session.
 * Exposes domain tools: execute_sql, invoke_skill, list_skills,
 * detect_architecture, lookup_sql_schema, and optionally write_analysis_note.
 */
export function createClaudeMcpServer(options: ClaudeMcpServerOptions) {
  const { traceId, traceProcessorService, skillExecutor, packageName, emitUpdate, onSkillResult, analysisNotes, artifactStore } = options;
  const recentSqlErrors: SqlErrorFixPair[] = options.recentSqlErrors || [];
  const skillAdapter = getSkillAnalysisAdapter(traceProcessorService);
  const watchdogRef = options.watchdogWarning;

  /**
   * Consume and prepend any watchdog warning to a tool result.
   * This is the feedback channel from runtime watchdog → Claude's execution context.
   * When the watchdog detects repetitive tool failures, the warning appears
   * in the NEXT tool result, which Claude reads and can act upon.
   */
  function consumeWatchdogWarning(resultText: string): string {
    if (watchdogRef?.current) {
      const warning = watchdogRef.current;
      watchdogRef.current = null; // consume once
      return `⚠️ SYSTEM WARNING: ${warning}\n\n${resultText}`;
    }
    return resultText;
  }

  /**
   * P0-G10: Enforce planning before analysis.
   * Returns error JSON if plan is required but not yet submitted, null if OK.
   * Only action tools (execute_sql, invoke_skill) are gated — informational
   * and planning tools are exempt to allow plan formation.
   */
  const analysisPlanRef = options.analysisPlan;
  function requirePlan(toolName: string): string | null {
    if (!analysisPlanRef) return null; // Planning feature not enabled
    if (analysisPlanRef.current) return null; // Plan already submitted
    return JSON.stringify({
      success: false,
      error: `必须先调用 submit_plan 提交分析计划，然后才能使用 ${toolName}。请先制定你的分析计划，包含分析阶段、目标和预期工具。`,
      action_required: 'submit_plan',
    });
  }

  const executeSql = tool(
    'execute_sql',
    'Execute a raw SQL query against the Perfetto trace_processor for the currently loaded trace. ' +
    'Returns columnar results. Use this for ad-hoc queries not covered by existing skills. ' +
    'Prefer invoke_skill when a matching skill exists — it produces richer, layered output. ' +
    'Set summary=true for large result sets to get column statistics + top sample rows instead of raw data.',
    {
      sql: z.string().describe(
        'The SQL query to execute. Use Perfetto stdlib tables/functions (e.g. android_jank_cuj, slice, thread, process).'
      ),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics (min/max/avg/percentiles) + 10 most interesting sample rows instead of full results. Use for large result sets where you need aggregate understanding, not row-level data. Default: false.'
      ),
    },
    async ({ sql, summary }) => {
      // P0-G10: Block analysis tools until plan is submitted
      const planError = requirePlan('execute_sql');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
      try {
        const sqlStart = Date.now();
        const result = await traceProcessorService.query(traceId, sql);
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const success = !result.error;

        const sqlDuration = Date.now() - sqlStart;
        if (emitUpdate && sqlDuration > 500) {
          emitUpdate({
            type: 'progress',
            content: { phase: 'analyzing', message: `SQL 查询完成 (${result.rows.length} 行, ${sqlDuration}ms)` },
            timestamp: Date.now(),
          });
        }

        if (emitUpdate && success && result.columns.length > 0 && rows.length > 0) {
          emitSqlDataEnvelope(emitUpdate, result.columns, rows);
        }

        if (emitUpdate && !success && result.error) {
          emitUpdate({
            type: 'progress',
            content: { phase: 'analyzing', message: `SQL 查询错误: ${result.error.substring(0, 200)}` },
            timestamp: Date.now(),
          });
        }

        // SQL error-fix pair learning: capture errors and match subsequent fixes
        if (!success && result.error) {
          recentSqlErrors.push({ errorSql: sql, errorMessage: result.error, timestamp: Date.now() });
          // Keep only last 10 errors in memory
          if (recentSqlErrors.length > 10) recentSqlErrors.shift();
        } else if (success && recentSqlErrors.length > 0) {
          // Match error-fix pairs by timestamp proximity (same turn, within 60s)
          // and structural similarity (>30% token overlap via Jaccard similarity).
          // SQL structural keywords + Perfetto domain tokens are excluded to avoid
          // false matches between unrelated queries that share common vocabulary.
          const matchingError = recentSqlErrors.find(e => {
            // Must be within 60 seconds (covers multi-turn reasoning gaps)
            if (Date.now() - e.timestamp > 60_000) return false;
            // Require reasonable structural similarity (not a totally different query)
            const errorTokens = sqlContentTokens(e.errorSql);
            const fixTokens = sqlContentTokens(sql);
            if (errorTokens.size === 0) return false;
            let intersection = 0;
            for (const t of errorTokens) {
              if (fixTokens.has(t)) intersection++;
            }
            const union = new Set([...errorTokens, ...fixTokens]).size;
            const jaccard = union > 0 ? intersection / union : 0;
            return jaccard > 0.3; // At least 30% token overlap
          });
          if (matchingError) {
            await logSqlErrorFixPair({ ...matchingError, fixedSql: sql });
            const idx = recentSqlErrors.indexOf(matchingError);
            if (idx >= 0) recentSqlErrors.splice(idx, 1);
          }
        }

        // Summary mode: return column statistics + sample rows instead of raw data
        if (summary && success && rows.length > 0) {
          const summaryResult = summarizeSqlResult(result.columns, result.rows);
          return {
            content: [{
              type: 'text' as const,
              text: consumeWatchdogWarning(JSON.stringify({
                success: true,
                mode: 'summary',
                totalRows: summaryResult.totalRows,
                columns: summaryResult.columns,
                columnStats: summaryResult.columnStats,
                sampleRows: summaryResult.sampleRows,
                durationMs: result.durationMs,
              })) + REASONING_NUDGE,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: consumeWatchdogWarning(JSON.stringify({
              success,
              columns: result.columns,
              rows,
              totalRows: result.rows.length,
              truncated,
              durationMs: result.durationMs,
              ...(result.error ? { error: result.error } : {}),
            })) + (success ? REASONING_NUDGE : ''),
          }],
        };
      } catch (err) {
        const errMsg = (err as Error).message;
        emitUpdate?.({
          type: 'progress',
          content: { phase: 'analyzing', message: `SQL 查询失败: ${errMsg}` },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errMsg }) }],
          isError: true,
        };
      }
    }
  );

  const invokeSkill = tool(
    'invoke_skill',
    'Execute a named SmartPerfetto skill pipeline against the current trace. ' +
    'Skills are pre-built analysis routines that produce layered results (overview → list → diagnosis → deep). ' +
    'Use list_skills first to find the right skill ID. ' +
    'Common params: process_name, start_ts, end_ts, max_frames_per_session.',
    {
      skillId: z.string().describe('Skill identifier (e.g. "scrolling_analysis", "jank_frame_detail", "cpu_analysis")'),
      params: z.record(z.string(), z.any()).optional().describe(
        'Optional parameters to pass to the skill. Common: { process_name, start_ts, end_ts, max_frames_per_session }'
      ),
    },
    async ({ skillId, params }) => {
      // P0-G10: Block analysis tools until plan is submitted
      const skillPlanError = requirePlan('invoke_skill');
      if (skillPlanError) {
        return { content: [{ type: 'text' as const, text: skillPlanError }] };
      }

      // Guard: pipeline_definition skills are not executable analysis skills
      const skillDef = skillRegistry.getSkill(skillId);
      if (skillDef?.type === 'pipeline_definition') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Skill "${skillId}" is a rendering pipeline definition used by \`detect_architecture\`. ` +
                'It cannot be used for analysis. Use `detect_architecture` to detect the rendering pipeline, ' +
                'or call a composite analysis skill like `scrolling_analysis`, `gpu_analysis`, etc.',
            }),
          }],
        };
      }

      try {
        const effectiveParams = { ...params };
        if (packageName && !effectiveParams.process_name) {
          effectiveParams.process_name = packageName;
        }
        // YAML skills may use ${package} or ${process_name} — provide both.
        // Keeping both ensures skills using either variable name work correctly.
        if (effectiveParams.process_name && !effectiveParams.package) {
          effectiveParams.package = effectiveParams.process_name;
        }
        if (effectiveParams.package && !effectiveParams.process_name) {
          effectiveParams.process_name = effectiveParams.package;
        }

        emitUpdate?.({
          type: 'progress',
          content: { phase: 'analyzing', message: `运行分析技能: ${skillId}...` },
          timestamp: Date.now(),
        });

        const skillStart = Date.now();
        const result = await skillExecutor.execute(skillId, traceId, effectiveParams);
        const skillDuration = Date.now() - skillStart;

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: `技能 ${skillId} 完成 (${skillDuration}ms, ${result.displayResults?.length || 0} 个结果层)`,
          },
          timestamp: Date.now(),
        });

        // Capture skill SQL errors in the learning system — skill SQL is the most complex
        // and most likely to break across Perfetto versions.
        // P1-3: Also persist to disk for cross-session learning (same as execute_sql errors).
        if (!result.success && result.error && result.error.includes('SQL')) {
          const errorPair: SqlErrorFixPair = {
            errorSql: `[skill:${skillId}] ${JSON.stringify(effectiveParams)}`,
            errorMessage: result.error,
            timestamp: Date.now(),
          };
          recentSqlErrors.push(errorPair);
          if (recentSqlErrors.length > 10) recentSqlErrors.shift();
          // Persist to disk (fire-and-forget) for cross-session learning
          logSqlErrorFixPair(errorPair).catch(() => {});
        }

        if (emitUpdate && result.displayResults?.length) {
          emitSkillDataEnvelopes(result.displayResults as SkillDisplayResult[], result.skillId || skillId, emitUpdate);
        }

        if (onSkillResult && result.success && result.displayResults?.length) {
          onSkillResult({ skillId: result.skillId || skillId, displayResults: result.displayResults });
        }

        // Vendor override hint: if a vendor is detected and overrides exist for this skill,
        // include a hint in the result so Claude can consider vendor-specific analysis steps.
        let vendorOverrideHint: { vendor: string; displayName?: string; additionalStepIds: string[] } | undefined;
        const detectedVendor = options.cachedVendor;
        if (detectedVendor && detectedVendor !== 'aosp' && result.success) {
          const vendorOverride = skillRegistry.getVendorOverride(skillId, detectedVendor);
          if (vendorOverride && vendorOverride.additionalSteps.length > 0) {
            vendorOverrideHint = {
              vendor: vendorOverride.vendor,
              displayName: vendorOverride.displayName,
              additionalStepIds: vendorOverride.additionalSteps
                .map((s: any) => s.id || s.name)
                .filter(Boolean),
            };
          }
        }

        // Artifact mode: store displayResults AND synthesizeData as artifacts, return compact references
        if (artifactStore && result.displayResults?.length) {
          const artifacts = result.displayResults.map(dr => {
            const artId = artifactStore.store({
              skillId: result.skillId || skillId,
              stepId: dr.stepId,
              layer: dr.layer,
              title: dr.title,
              data: dr.data,
              diagnostics: undefined,
            });
            const summary = artifactStore.generateSummary(artId);
            return { artifactId: artId, ...summary };
          });

          // Store diagnostics as a separate artifact if present
          let diagnosticsArtifactId: string | undefined;
          if (result.diagnostics && Array.isArray(result.diagnostics) && result.diagnostics.length > 0) {
            diagnosticsArtifactId = artifactStore.store({
              skillId: result.skillId || skillId,
              stepId: '_diagnostics',
              layer: 'diagnosis',
              title: `${skillId} diagnostics`,
              data: { columns: ['diagnostic'], rows: result.diagnostics.map((d: any) => [d]) },
              diagnostics: result.diagnostics,
            });
          }

          // Store synthesizeData entries as artifacts too — these contain the raw step data
          // (e.g. batch_frame_root_cause with 487 rows) that would otherwise overflow token limits.
          // Claude can fetch them on demand via fetch_artifact with pagination.
          let synthesizeArtifacts: Array<{ artifactId: string; stepId: string; rowCount: number; columns: string[] }> | undefined;
          if (result.synthesizeData && Array.isArray(result.synthesizeData) && result.synthesizeData.length > 0) {
            synthesizeArtifacts = result.synthesizeData
              .filter((sd: any) => sd.data && sd.success !== false)
              .map((sd: any) => {
                // synthesizeData entries have data as array-of-objects or { columns, rows }
                const normalizedData = normalizeSynthesizeDataForStorage(sd.data);
                const artId = artifactStore.store({
                  skillId: result.skillId || skillId,
                  stepId: sd.stepId,
                  layer: sd.layer || 'synthesize',
                  title: sd.stepName || sd.stepId,
                  data: normalizedData,
                });
                return {
                  artifactId: artId,
                  stepId: sd.stepId,
                  rowCount: normalizedData.rows?.length ?? 0,
                  columns: normalizedData.columns ?? [],
                };
              });
          }

          return {
            content: [{
              type: 'text' as const,
              text: consumeWatchdogWarning(JSON.stringify({
                success: result.success,
                skillId: result.skillId,
                skillName: result.skillName,
                ...(result.error ? { error: result.error } : {}),
                artifacts,
                ...(diagnosticsArtifactId ? { diagnosticsArtifactId } : {}),
                ...(synthesizeArtifacts && synthesizeArtifacts.length > 0
                  ? { synthesizeArtifacts }
                  : {}),
                ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
                hint: 'Use fetch_artifact(artifactId, detail="rows", offset=0, limit=50) to page through large datasets. All data is accessible — use offset/limit to paginate.',
              })) + (result.success ? REASONING_NUDGE : ''),
            }],
          };
        }

        // Default: return full displayResults (backward compatible)
        return {
          content: [{
            type: 'text' as const,
            text: consumeWatchdogWarning(JSON.stringify({
              success: result.success,
              skillId: result.skillId,
              skillName: result.skillName,
              ...(result.error ? { error: result.error } : {}),
              ...(vendorOverrideHint ? { vendorOverride: vendorOverrideHint } : {}),
              displayResults: result.displayResults?.map(dr => ({
                stepId: dr.stepId,
                title: dr.title,
                layer: dr.layer,
                data: dr.data,
              })),
              diagnostics: result.diagnostics,
              synthesizeData: result.synthesizeData,
            })) + (result.success ? REASONING_NUDGE : ''),
          }],
        };
      } catch (err) {
        const errMsg = (err as Error).message;
        emitUpdate?.({
          type: 'progress',
          content: { phase: 'analyzing', message: `技能 ${skillId} 执行失败: ${errMsg}` },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errMsg }) }],
          isError: true,
        };
      }
    }
  );

  const listSkills = tool(
    'list_skills',
    'List all available SmartPerfetto analysis skills. ' +
    'Use this to discover which skills exist before invoking one. ' +
    'Filter by category to narrow results (e.g. "scrolling", "startup", "cpu", "memory").',
    {
      category: z.string().optional().describe(
        'Optional filter: only return skills whose keywords or tags match this category'
      ),
    },
    async ({ category }) => {
      try {
        const allSkills = await skillAdapter.listSkills();
        const filtered = category
          ? allSkills.filter(s =>
              s.keywords.some(k => k.toLowerCase().includes(category.toLowerCase())) ||
              s.tags?.some(t => t.toLowerCase().includes(category.toLowerCase())) ||
              s.id.toLowerCase().includes(category.toLowerCase())
            )
          : allSkills;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              filtered.map(s => ({
                id: s.id,
                displayName: s.displayName,
                description: s.description,
                type: s.type,
                keywords: s.keywords.slice(0, 5),
              }))
            ),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  const detectArchitecture = tool(
    'detect_architecture',
    'Detect the rendering architecture of the app in the current trace. ' +
    'Returns architecture type (STANDARD/FLUTTER/COMPOSE/WEBVIEW/etc.), confidence, and evidence. ' +
    'Call this early to understand which analysis approach to use.',
    {},
    async () => {
      try {
        // Return cached result if available (already detected in analyze())
        if (options.cachedArchitecture) {
          const info = options.cachedArchitecture;
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                type: info.type,
                confidence: info.confidence,
                evidence: info.evidence.map(e => ({ source: e.source, type: e.type, weight: e.weight })),
                flutter: info.flutter,
                compose: info.compose,
                webview: info.webview,
                cached: true,
              }),
            }],
          };
        }
        const detector = createArchitectureDetector();
        const info = await detector.detect({ traceId, traceProcessorService, packageName });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              type: info.type,
              confidence: info.confidence,
              evidence: info.evidence.map(e => ({ source: e.source, type: e.type, weight: e.weight })),
              flutter: info.flutter,
              compose: info.compose,
              webview: info.webview,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  const lookupSqlSchema = tool(
    'lookup_sql_schema',
    'Search the Perfetto SQL stdlib index for table, view, and function definitions matching a keyword. ' +
    'Use this to discover available SQL entities before writing raw SQL queries.',
    {
      keyword: z.string().describe(
        'Search keyword (e.g. "jank", "slice", "thread_state", "android_frames")'
      ),
    },
    async ({ keyword }) => {
      const schema = loadSqlSchema();
      const lower = keyword.toLowerCase();

      // P2-G8: Token-based fuzzy matching — split keyword into tokens and match independently
      const tokens = lower.split(/[\s_]+/).filter(t => t.length >= 2);

      // Scoring function: exact substring match scores highest, token prefix matches next
      function scoreEntry(t: { name: string; category: string; description: string }): number {
        const name = t.name.toLowerCase();
        const cat = t.category.toLowerCase();
        const desc = t.description.toLowerCase();
        const searchable = `${name} ${cat} ${desc}`;

        // Exact substring match (original behavior)
        if (name.includes(lower) || cat.includes(lower) || desc.includes(lower)) return 10;

        // Token-based matching: count how many query tokens match
        if (tokens.length <= 1) return 0;
        let matchedTokens = 0;
        for (const tok of tokens) {
          if (searchable.includes(tok)) matchedTokens++;
          // Prefix match on name segments (e.g., "frame_time" matches "frame_timeline")
          else if (name.split('_').some(seg => seg.startsWith(tok))) matchedTokens += 0.5;
        }
        return matchedTokens >= tokens.length * 0.5 ? matchedTokens : 0;
      }

      const scored = schema.templates
        .map(t => ({ entry: t, score: scoreEntry(t) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalMatches: scored.length,
            entries: scored.map(s => {
              const m = s.entry;
              const entry: Record<string, unknown> = { name: m.name, type: m.type, category: m.category, description: m.description };
              if (m.columns?.length) entry.columns = m.columns;
              if (m.params?.length) entry.params = m.params;
              return entry;
            }),
          }),
        }],
      };
    }
  );

  // Conditional tool: write_analysis_note (only available when analysisNotes array is provided)
  const MAX_NOTES = 20;
  const writeAnalysisNote = analysisNotes ? tool(
    'write_analysis_note',
    'Persist a structured analysis note that survives context compression. ' +
    'Use this for important cross-domain observations, hypotheses, or findings that you want to reference later. ' +
    'Do NOT overuse — only record observations that would be lost if context is compressed.',
    {
      section: z.enum(['hypothesis', 'finding', 'observation', 'next_step']).describe(
        'Note category: hypothesis (untested theory), finding (confirmed result), observation (data point), next_step (planned action)'
      ),
      content: z.string().describe('The note content — be specific, include data references'),
      priority: z.enum(['high', 'medium', 'low']).optional().describe('Priority for retention when notes exceed limit. Default: medium'),
    },
    async ({ section, content, priority }) => {
      const note = { section, content, priority: priority || 'medium' as const, timestamp: Date.now() };
      analysisNotes.push(note);

      // Evict notes when over limit.
      // Priority order: next_step (ephemeral) → low (oldest first) → medium (oldest first) → oldest high
      if (analysisNotes.length > MAX_NOTES) {
        const priorityRank = { low: 0, medium: 1, high: 2 };
        // Find the best candidate to evict: lowest priority, then oldest timestamp
        let evictIdx = -1;
        let evictRank = Infinity;
        let evictTs = Infinity;

        for (let i = 0; i < analysisNotes.length; i++) {
          const n = analysisNotes[i];
          // Always prefer evicting next_step (ephemeral planning notes)
          if (n.section === 'next_step') { evictIdx = i; break; }
          const rank = priorityRank[n.priority as keyof typeof priorityRank] ?? 1;
          if (rank < evictRank || (rank === evictRank && n.timestamp < evictTs)) {
            evictRank = rank;
            evictTs = n.timestamp;
            evictIdx = i;
          }
        }
        if (evictIdx >= 0) analysisNotes.splice(evictIdx, 1);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, totalNotes: analysisNotes.length, section, priority: priority || 'medium' }),
        }],
      };
    }
  ) : null;

  // Conditional tool: fetch_artifact (only available when artifactStore is provided)
  const fetchArtifact = artifactStore ? tool(
    'fetch_artifact',
    'Retrieve detailed data for a previously stored artifact from invoke_skill results. ' +
    'Supports pagination for large datasets — use offset/limit to page through rows without token overflow. ' +
    'Response includes totalRows and hasMore to guide pagination. ALL data is accessible; nothing is hidden.',
    {
      artifactId: z.string().describe('Artifact ID (e.g. "art-1") from a previous invoke_skill response'),
      detail: z.enum(['summary', 'rows', 'full']).optional().describe(
        'Detail level: summary (default, compact stats), rows (paginated data rows), full (complete original structure — use with caution on large artifacts)'
      ),
      offset: z.number().optional().describe(
        'Row offset for pagination (detail="rows" only). Default: 0. Use with limit to page through large datasets.'
      ),
      limit: z.number().optional().describe(
        'Maximum rows to return (detail="rows" only). Default: 50. Increase up to 200 if you need more rows per page.'
      ),
    },
    async ({ artifactId, detail, offset, limit }) => {
      const effectiveDetail = detail || 'summary';
      const result = artifactStore.fetch(artifactId, effectiveDetail, offset, limit);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: false,
            error: `Artifact ${artifactId} not found — it may have been evicted (LRU cap: 50) or lost after a backend restart. Use invoke_skill to re-execute the skill if you need this data again.`,
          }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, detail: effectiveDetail, ...result }),
        }],
      };
    }
  ) : null;

  // query_perfetto_source: Search the Perfetto stdlib for SQL patterns and usage examples.
  // Enables Claude to self-learn by finding how official code uses tables/functions.
  const queryPerfettoSource = tool(
    'query_perfetto_source',
    'Search the Perfetto SQL stdlib source code for usage patterns. Use this when you encounter an unfamiliar table/function, get an SQL error, or need to find how the official codebase uses a specific table or column. Returns matching lines with file context.',
    {
      keyword: z.string().describe('Search keyword (table name, function name, column name, or SQL pattern)'),
      max_results: z.number().optional().describe('Maximum number of matching files to return (default: 5)'),
    },
    async ({ keyword, max_results }) => {
      const maxFiles = max_results ?? 5;
      const stdlibDir = path.resolve(__dirname, '../../../perfetto/src/trace_processor/perfetto_sql/stdlib');

      if (!fs.existsSync(stdlibDir)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Perfetto stdlib directory not found' }) }],
          isError: true,
        };
      }

      try {
        const results: Array<{ file: string; matches: string[] }> = [];
        const lowerKeyword = keyword.toLowerCase();

        // Recursively search .sql files (async to avoid blocking event loop)
        const searchDir = async (dir: string): Promise<void> => {
          if (results.length >= maxFiles) return;
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxFiles) return;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await searchDir(fullPath);
            } else if (entry.name.endsWith('.sql')) {
              const content = await fs.promises.readFile(fullPath, 'utf-8');
              if (content.toLowerCase().includes(lowerKeyword)) {
                const relPath = path.relative(stdlibDir, fullPath);
                const lines = content.split('\n');
                const matchLines: string[] = [];
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(lowerKeyword)) {
                    // Include 1 line of context before and after
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length - 1, i + 1);
                    const context = lines.slice(start, end + 1)
                      .map((l, j) => `${start + j + 1}: ${l}`)
                      .join('\n');
                    matchLines.push(context);
                    if (matchLines.length >= 8) break; // Cap matches per file
                  }
                }
                results.push({ file: relPath, matches: matchLines });
              }
            }
          }
        };

        await searchDir(stdlibDir);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              keyword,
              matchedFiles: results.length,
              results: results.map(r => ({
                file: r.file,
                matchCount: r.matches.length,
                matches: r.matches,
              })),
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  // P1-G11: Scene plan templates — mandatory aspects per scene type
  const SCENE_PLAN_TEMPLATES: Partial<Record<string, { mandatoryAspects: Array<{ matchKeywords: string[]; suggestion: string }> }>> = {
    scrolling: {
      mandatoryAspects: [
        { matchKeywords: ['frame', 'jank', 'scroll', '帧', '卡顿', '滑动', 'scrolling_analysis', 'consumer_jank'],
          suggestion: '滑动场景建议包含帧渲染/卡顿分析阶段 (scrolling_analysis, consumer_jank_detection)' },
        { matchKeywords: ['root', 'cause', 'diagnos', '根因', '诊断', '深入', 'deep', 'jank_frame_detail'],
          suggestion: '滑动场景建议包含卡顿帧根因分析阶段 (jank_frame_detail)' },
      ],
    },
    startup: {
      mandatoryAspects: [
        { matchKeywords: ['startup', 'ttid', 'ttfd', 'launch', '启动', 'startup_analysis'],
          suggestion: '启动场景建议包含启动耗时测量阶段 (startup_analysis)' },
        { matchKeywords: ['phase', 'breakdown', 'block', '阶段', '分解', '阻塞', 'startup_detail'],
          suggestion: '启动场景建议包含启动阶段分解和阻塞因素分析' },
        { matchKeywords: ['type', 'cold', 'warm', 'hot', 'bindApplication', '类型', '冷启动', '温启动', '热启动', '判定'],
          suggestion: '启动场景建议验证启动类型 (cold/warm/hot)：bindApplication 存在→冷启动，仅 performCreate→温启动' },
      ],
    },
    anr: {
      mandatoryAspects: [
        { matchKeywords: ['anr', 'deadlock', 'block', '死锁', '阻塞', 'not_responding', 'anr_analysis'],
          suggestion: 'ANR 场景建议包含 ANR 原因定位阶段 (anr_analysis)' },
      ],
    },
    teaching: {
      mandatoryAspects: [
        { matchKeywords: ['detect_architecture', 'architecture', '架构', 'pipeline', '管线', '教学'],
          suggestion: '教学场景建议包含架构检测阶段 (detect_architecture)' },
        { matchKeywords: ['teach', 'explain', '说明', '解释', 'thread', '线程', 'slice', 'mermaid', 'invoke_skill'],
          suggestion: '教学场景建议包含管线教学内容获取阶段 (invoke_skill with pipeline skill)' },
      ],
    },
    scroll_response: {
      mandatoryAspects: [
        { matchKeywords: ['input', 'gesture', 'motion', 'action_move', '输入', '手势', '触摸', 'input_events'],
          suggestion: '滑动响应场景建议包含输入事件定位阶段 (input event detection)' },
        { matchKeywords: ['latency', 'response', 'delay', '延迟', '响应', '分解', 'breakdown', '首帧'],
          suggestion: '滑动响应场景建议包含端到端延迟分解阶段 (latency breakdown)' },
      ],
    },
    pipeline: {
      mandatoryAspects: [
        { matchKeywords: ['detect_architecture', 'architecture', '架构', '检测', 'detection'],
          suggestion: '管线识别场景建议包含架构自动检测阶段 (detect_architecture)' },
        { matchKeywords: ['pipeline', '管线', 'mermaid', 'thread', '线程', 'teaching', '教学', 'invoke_skill'],
          suggestion: '管线识别场景建议包含管线教学内容展示阶段 (pipeline skill invocation)' },
      ],
    },
  };

  // Planning tools: submit_plan + update_plan_phase (P0-1: Explicit planning capability)
  // analysisPlanRef is declared above (P0-G10) and shared with planning tools
  const submitPlan = analysisPlanRef ? tool(
    'submit_plan',
    'Submit your structured analysis plan BEFORE starting any analysis. ' +
    'Define phases with goals and expected tools. The system tracks plan adherence and warns on deviation. ' +
    'You MUST call this tool as your first action in every analysis.',
    {
      phases: z.array(z.object({
        id: z.string().describe('Phase identifier (e.g. "p1", "p2")'),
        name: z.string().describe('Phase name (e.g. "Overview Collection")'),
        goal: z.string().describe('What this phase aims to achieve'),
        expectedTools: z.array(z.string()).describe('Tool names this phase will use (e.g. ["invoke_skill", "execute_sql"])'),
      })).describe('Ordered list of analysis phases'),
      successCriteria: z.string().describe('What constitutes a successful analysis (e.g. "Identify root cause of jank frames with evidence")'),
    },
    async ({ phases, successCriteria }) => {
      const plan: AnalysisPlanV3 = {
        phases: phases.map(p => ({
          ...p,
          status: 'pending' as const,
        })),
        successCriteria,
        submittedAt: Date.now(),
        toolCallLog: [],
      };
      analysisPlanRef.current = plan;

      // P1-G11: Validate plan against scene template
      const planWarnings: string[] = [];
      if (options.sceneType && SCENE_PLAN_TEMPLATES[options.sceneType]) {
        const template = SCENE_PLAN_TEMPLATES[options.sceneType]!;
        const planText = phases.map(p => `${p.name} ${p.goal} ${p.expectedTools.join(' ')}`).join(' ').toLowerCase();
        for (const aspect of template.mandatoryAspects) {
          const covered = aspect.matchKeywords.some(kw => planText.includes(kw.toLowerCase()));
          if (!covered) {
            planWarnings.push(aspect.suggestion);
          }
        }
      }

      emitUpdate?.({
        type: 'plan_submitted',
        content: {
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          successCriteria,
        },
        timestamp: Date.now(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Plan accepted: ${phases.length} phases. Now proceed with phase "${phases[0]?.id}".`,
            phases: phases.map(p => p.id),
            ...(planWarnings.length > 0 ? {
              sceneWarnings: planWarnings,
              hint: `检测到 ${options.sceneType} 场景，建议补充以下分析阶段。可使用 revise_plan 调整计划。`,
            } : {}),
          }),
        }],
      };
    }
  ) : null;

  const updatePlanPhase = analysisPlanRef ? tool(
    'update_plan_phase',
    'Update the status of a plan phase. Call this when transitioning between phases or when skipping a phase. ' +
    'This helps track analysis progress and enables plan adherence verification. ' +
    'When completing a phase, you MUST provide a summary with key evidence collected (e.g. "发现 5 帧卡顿，主因是 RenderThread 阻塞，最长耗时 45ms"). ' +
    'When skipping, explain why (e.g. "trace 中无启动数据，跳过启动分析").',
    {
      phaseId: z.string().describe('Phase ID to update (e.g. "p1")'),
      status: z.enum(['in_progress', 'completed', 'skipped']).describe('New phase status'),
      summary: z.string().optional().describe('REQUIRED for completed/skipped: key evidence or reason. Must include specific data (numbers, names, findings).'),
    },
    async ({ phaseId, status, summary }) => {
      const plan = analysisPlanRef.current;
      if (!plan) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No plan submitted yet. Call submit_plan first.' }) }],
          isError: true,
        };
      }

      const phase = plan.phases.find(p => p.id === phaseId);
      if (!phase) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Phase "${phaseId}" not found in plan` }) }],
          isError: true,
        };
      }

      phase.status = status;
      if (status === 'completed' || status === 'skipped') {
        phase.completedAt = Date.now();
        phase.summary = summary;
      }

      emitUpdate?.({
        type: 'plan_phase_updated',
        content: { phaseId, status, summary: summary || '', phaseName: phase.name },
        timestamp: Date.now(),
      });

      // Report overall plan progress
      const completed = plan.phases.filter(p => p.status === 'completed' || p.status === 'skipped').length;
      const nextPhase = plan.phases.find(p => p.status === 'pending');

      // P2-1: Feedback on summary quality for completed/skipped phases
      let summaryFeedback: string | undefined;
      if ((status === 'completed' || status === 'skipped') && (!summary || summary.length < 15)) {
        summaryFeedback = 'Warning: phase summary is too brief. Include specific evidence (数据、数值、发现) for plan adherence verification.';
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            progress: `${completed}/${plan.phases.length} phases done`,
            ...(nextPhase ? { nextPhase: nextPhase.id, nextGoal: nextPhase.name } : { allPhasesComplete: true }),
            ...(summaryFeedback ? { summaryFeedback } : {}),
          }),
        }],
      };
    }
  ) : null;

  // P1-3: Dynamic replan — allows Claude to revise the plan mid-analysis when new information emerges
  const revisePlan = analysisPlanRef ? tool(
    'revise_plan',
    'Revise your analysis plan mid-execution when new information changes priorities. ' +
    'Use this when initial data reveals unexpected conditions (e.g., discovered Flutter architecture but planned for Standard, ' +
    'or found ANR signals in a scrolling query). Preserves completed phases and audit trail.',
    {
      reason: z.string().describe('Why the plan needs revision (what new information triggered this)'),
      updatedPhases: z.array(z.object({
        id: z.string().describe('Phase identifier (keep existing IDs for unchanged phases, use new IDs for added phases)'),
        name: z.string().describe('Phase name'),
        goal: z.string().describe('What this phase aims to achieve'),
        expectedTools: z.array(z.string()).describe('Tool names this phase will use'),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).optional()
          .describe('Phase status. Omit for new/pending phases. Completed/skipped phases from original plan are preserved.'),
      })).describe('The revised phase list. Must include all completed/in-progress phases from original plan.'),
      updatedSuccessCriteria: z.string().optional().describe('Updated success criteria (only if the goal changed)'),
    },
    async ({ reason, updatedPhases, updatedSuccessCriteria }) => {
      const plan = analysisPlanRef.current;
      if (!plan) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No plan submitted yet. Call submit_plan first.' }) }],
          isError: true,
        };
      }

      // Validate: completed phases from original plan must be preserved
      const originalCompleted = plan.phases.filter(p => p.status === 'completed' || p.status === 'skipped');
      const preservedIds = new Set(updatedPhases.map(p => p.id));
      const missingCompleted = originalCompleted.filter(p => !preservedIds.has(p.id));
      if (missingCompleted.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Completed phases must be preserved: ${missingCompleted.map(p => p.id).join(', ')}. Include them in updatedPhases.`,
            }),
          }],
          isError: true,
        };
      }

      // Save revision history for audit trail
      const revision: PlanRevision = {
        revisedAt: Date.now(),
        reason,
        previousPhases: plan.phases.map(p => ({ ...p })),
      };
      if (!plan.revisionHistory) plan.revisionHistory = [];
      plan.revisionHistory.push(revision);

      // Apply revision: merge completed phase data (summary, completedAt) with updated structure
      plan.phases = updatedPhases.map(up => {
        const original = plan.phases.find(p => p.id === up.id);
        if (original && (original.status === 'completed' || original.status === 'skipped')) {
          // Preserve completed phase data
          return { ...original };
        }
        return {
          id: up.id,
          name: up.name,
          goal: up.goal,
          expectedTools: up.expectedTools,
          status: (up.status || 'pending') as any,
        };
      });

      if (updatedSuccessCriteria) {
        plan.successCriteria = updatedSuccessCriteria;
      }

      emitUpdate?.({
        type: 'plan_revised',
        content: {
          reason,
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          revisionCount: plan.revisionHistory.length,
        },
        timestamp: Date.now(),
      });

      const pending = plan.phases.filter(p => p.status === 'pending');
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Plan revised (revision #${plan.revisionHistory.length}): ${reason}`,
            totalPhases: plan.phases.length,
            pendingPhases: pending.length,
            nextPhase: pending[0]?.id,
          }),
        }],
      };
    }
  ) : null;

  // P0-G4: Hypothesis-verify cycle tools
  const hypothesesRef = options.hypotheses;
  let hypothesisCounter = 0;

  const submitHypothesis = hypothesesRef ? tool(
    'submit_hypothesis',
    'Record a formal hypothesis that needs verification through data. ' +
    'Use this when you form a testable theory about the root cause of a performance issue. ' +
    'Every hypothesis MUST be resolved (confirmed/rejected with evidence) before concluding.',
    {
      statement: z.string().describe(
        'The hypothesis statement (e.g., "RenderThread is blocked by Binder transactions causing jank frames")'
      ),
      basis: z.string().optional().describe(
        'What observation prompted this hypothesis (e.g., "Observed 3 frames with RenderThread in sleeping state")'
      ),
    },
    async ({ statement, basis }) => {
      hypothesisCounter++;
      const hypothesis: Hypothesis = {
        id: `h${hypothesisCounter}`,
        statement,
        status: 'formed',
        basis,
        formedAt: Date.now(),
      };
      hypothesesRef.push(hypothesis);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            hypothesisId: hypothesis.id,
            message: `Hypothesis ${hypothesis.id} recorded. Now collect evidence to confirm or reject it.`,
            totalHypotheses: hypothesesRef.length,
            unresolvedCount: hypothesesRef.filter(h => h.status === 'formed').length,
          }),
        }],
      };
    }
  ) : null;

  const resolveHypothesis = hypothesesRef ? tool(
    'resolve_hypothesis',
    'Resolve a previously submitted hypothesis as confirmed or rejected. ' +
    'Provide the evidence that supports your conclusion. ' +
    'All hypotheses MUST be resolved before writing your final conclusion.',
    {
      hypothesisId: z.string().describe('Hypothesis ID to resolve (e.g., "h1")'),
      status: z.enum(['confirmed', 'rejected']).describe(
        'Resolution: confirmed (evidence supports) or rejected (evidence contradicts)'
      ),
      evidence: z.string().describe(
        'The evidence supporting this resolution (specific data, timestamps, tool results)'
      ),
    },
    async ({ hypothesisId, status, evidence }) => {
      const hypothesis = hypothesesRef.find(h => h.id === hypothesisId);
      if (!hypothesis) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Hypothesis "${hypothesisId}" not found` }) }],
          isError: true,
        };
      }
      if (hypothesis.status !== 'formed') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Hypothesis "${hypothesisId}" already resolved as ${hypothesis.status}` }) }],
          isError: true,
        };
      }

      hypothesis.status = status;
      hypothesis.evidence = evidence;
      hypothesis.resolvedAt = Date.now();

      const unresolvedCount = hypothesesRef.filter(h => h.status === 'formed').length;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            hypothesisId,
            status,
            message: unresolvedCount === 0
              ? `Hypothesis ${hypothesisId} ${status}. All hypotheses resolved — ready to conclude.`
              : `Hypothesis ${hypothesisId} ${status}. ${unresolvedCount} hypothesis(es) still unresolved.`,
            unresolvedCount,
          }),
        }],
      };
    }
  ) : null;

  // ── P1-G1: flag_uncertainty — non-blocking human interaction ──
  const uncertaintyFlagsRef = options.uncertaintyFlags;
  const flagUncertainty = uncertaintyFlagsRef ? tool(
    'flag_uncertainty',
    'Signal that you are uncertain about an aspect and making an assumption to proceed. ' +
    'Use this when you encounter ambiguity (e.g., unclear which process is the focus app, ' +
    'multiple possible root causes, unclear user intent). Analysis continues without blocking — ' +
    'the user sees your flag and can provide clarification in the next turn.',
    {
      topic: z.string().describe('What aspect you are uncertain about'),
      assumption: z.string().describe('What assumption you are making to proceed'),
      question: z.string().describe('What you would ask the user if you could'),
    },
    async ({ topic, assumption, question }) => {
      const flag: UncertaintyFlag = { topic, assumption, question, timestamp: Date.now() };
      uncertaintyFlagsRef.push(flag);

      // Emit as SSE event so the user sees it in real-time
      emitUpdate?.({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: `⚠️ 不确定性标记: ${topic}\n假设: ${assumption}\n建议确认: ${question}`,
        },
        timestamp: Date.now(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: `Uncertainty flagged. Proceeding with assumption: "${assumption}". User will see this flag and can correct in next turn.`,
            flagCount: uncertaintyFlagsRef.length,
          }),
        }],
      };
    }
  ) : null;

  // ── P1-G19: recall_patterns — agent-queryable long-term memory ──
  const recallPatterns = tool(
    'recall_patterns',
    'Query long-term analysis pattern memory for insights from past sessions with similar traces. ' +
    'Use this when you want to check if similar traces have been analyzed before and what was discovered. ' +
    'Provide trace characteristics like architecture type, scene type, and domain keywords.',
    {
      architectureType: z.string().optional().describe('Architecture type (e.g., "standard", "flutter_surfaceview", "compose")'),
      sceneType: z.string().optional().describe('Scene type (e.g., "scrolling", "startup", "anr")'),
      keywords: z.array(z.string()).optional().describe('Domain keywords (e.g., ["jank", "binder", "gpu"])'),
    },
    async ({ architectureType, sceneType: querySceneType, keywords }) => {
      const features = extractTraceFeatures({
        architectureType,
        sceneType: querySceneType,
        packageName,
      });
      // Add extra keyword features if provided
      if (keywords) {
        for (const kw of keywords) {
          features.push(`domain:${kw.toLowerCase()}`);
        }
      }

      const positiveMatches = matchPatterns(features);
      const negativeMatches = matchNegativePatterns(features);

      if (positiveMatches.length === 0 && negativeMatches.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: true,
            message: 'No matching patterns found in memory. This may be a novel trace configuration.',
            positivePatterns: [],
            negativePatterns: [],
          }) }],
        };
      }

      const positive = positiveMatches.map(m => ({
        sceneType: m.sceneType,
        architectureType: m.architectureType,
        score: Math.round(m.score * 100),
        insights: m.keyInsights.slice(0, 3),
        matchCount: m.matchCount,
      }));

      const negative = negativeMatches.flatMap(m =>
        m.failedApproaches.slice(0, 3).map(a => ({
          type: a.type,
          approach: a.approach,
          reason: a.reason,
          workaround: a.workaround,
        }))
      );

      // P1-10: Also include verifier's learned misdiagnosis patterns
      let learnedMisdiagnosis: Array<{ keywords: string[]; message: string; occurrences: number }> = [];
      try {
        const learnedPatternsFile = path.resolve(__dirname, '../../logs/learned_misdiagnosis_patterns.json');
        if (fs.existsSync(learnedPatternsFile)) {
          const raw = JSON.parse(fs.readFileSync(learnedPatternsFile, 'utf-8'));
          const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60-day TTL
          learnedMisdiagnosis = (raw as any[])
            .filter((p: any) => p.createdAt >= cutoff && p.occurrences >= 2)
            .slice(0, 10)
            .map((p: any) => ({
              keywords: p.keywords,
              message: p.message,
              occurrences: p.occurrences,
            }));
        }
      } catch { /* non-fatal */ }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          success: true,
          positivePatterns: positive,
          negativePatterns: negative,
          learnedMisdiagnosis: learnedMisdiagnosis.length > 0 ? learnedMisdiagnosis : undefined,
          message: `Found ${positive.length} positive and ${negative.length} negative patterns from past sessions.` +
            (learnedMisdiagnosis.length > 0 ? ` Also ${learnedMisdiagnosis.length} learned misdiagnosis avoidance patterns.` : ''),
        }) }],
      };
    }
  );

  // P2-G1: Co-locate tool objects with their names — auto-derives allowedTools
  // so adding a new MCP tool automatically makes it available to the SDK.
  const toolEntries: Array<{ tool: any; name: string }> = [
    { tool: executeSql, name: 'execute_sql' },
    { tool: invokeSkill, name: 'invoke_skill' },
    { tool: listSkills, name: 'list_skills' },
    { tool: detectArchitecture, name: 'detect_architecture' },
    { tool: lookupSqlSchema, name: 'lookup_sql_schema' },
    { tool: queryPerfettoSource, name: 'query_perfetto_source' },
  ];
  if (writeAnalysisNote) toolEntries.push({ tool: writeAnalysisNote, name: 'write_analysis_note' });
  if (fetchArtifact) toolEntries.push({ tool: fetchArtifact, name: 'fetch_artifact' });
  if (submitPlan) toolEntries.push({ tool: submitPlan, name: 'submit_plan' });
  if (updatePlanPhase) toolEntries.push({ tool: updatePlanPhase, name: 'update_plan_phase' });
  if (revisePlan) toolEntries.push({ tool: revisePlan, name: 'revise_plan' });
  if (submitHypothesis) toolEntries.push({ tool: submitHypothesis, name: 'submit_hypothesis' });
  if (resolveHypothesis) toolEntries.push({ tool: resolveHypothesis, name: 'resolve_hypothesis' });
  if (flagUncertainty) toolEntries.push({ tool: flagUncertainty, name: 'flag_uncertainty' });
  toolEntries.push({ tool: recallPatterns, name: 'recall_patterns' });

  const server = createSdkMcpServer({
    name: 'smartperfetto',
    version: '1.0.0',
    tools: toolEntries.map(e => e.tool),
  });

  return {
    server,
    allowedTools: toolEntries.map(e => `${MCP_NAME_PREFIX}${e.name}`),
  };
}

/** Emit a DataEnvelope for SQL query results. */
function emitSqlDataEnvelope(
  emit: (update: StreamingUpdate) => void,
  columns: string[],
  rows: any[],
): void {
  emit({
    type: 'data',
    content: [{
      meta: { type: 'sql_result', version: '2.0', source: 'execute_sql' },
      data: { columns, rows },
      display: {
        layer: 'list',
        format: 'table',
        title: `SQL Query (${rows.length} rows)`,
        columns: columns.map((col: string) => ({
          name: col,
          type: inferSqlColumnType(col),
        })),
      },
    }],
    timestamp: Date.now(),
  });
}

function inferSqlColumnType(col: string): string {
  if (col.includes('ts') || col.includes('timestamp')) return 'timestamp';
  if (col.includes('dur')) return 'duration';
  if (col.includes('pct') || col.includes('percent')) return 'percentage';
  return 'string';
}

/**
 * Convert skill DisplayResults to DataEnvelopes and emit as SSE 'data' events.
 * This enables interactive tables (clickable timestamps, expandable rows) in the frontend.
 */
function emitSkillDataEnvelopes(
  displayResults: SkillDisplayResult[],
  skillId: string,
  emit: (update: StreamingUpdate) => void,
): void {
  const envelopes = displayResults
    .filter(dr => dr.data?.rows?.length)
    .map(dr => {
      const explicitColumns = (dr as any).columnDefinitions;
      return displayResultToEnvelope(dr as any, skillId, explicitColumns);
    });

  if (envelopes.length > 0) {
    emit({ type: 'data', content: envelopes, timestamp: Date.now() });
  }
}
