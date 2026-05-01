// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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
import { loadSkillNotes } from './selfImprove/skillNotesInjector';
import {
  getPerfettoStdlibModules,
  getPerfettoStdlibPath,
} from '../services/perfettoStdlibScanner';
import { injectStdlibIncludes } from './sqlIncludeInjector';
import { loadPromptTemplate, getPhaseHints } from './strategyLoader';
import { matchPhaseHintForNextPhase } from './phaseHintMatcher';
import { buildActivePhaseReminder } from './activePhaseReminder';
import { validatePlanAgainstSceneTemplate, MIN_WAIVER_REASON_CHARS } from './scenePlanTemplates';
import type { ArtifactStore } from './artifactStore';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from './outputLanguage';

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
const REASONING_NUDGE_ZH = '\n\n[REFLECT] 在执行下一步之前：这个数据的关键发现是什么？是否支持/反驳你的假设？如有重要推断，请用 submit_hypothesis 或 write_analysis_note 记录。';
const REASONING_NUDGE_EN = '\n\n[REFLECT] Before the next action: what is the key finding from this data? Does it support or refute your hypothesis? If there is an important inference, record it with submit_hypothesis or write_analysis_note.';

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
  /** Reference trace ID for comparison mode — enables dual-trace MCP tools */
  referenceTraceId?: string;
  /** Pre-computed comparison context (capabilities, metadata) for get_comparison_context tool */
  comparisonContext?: import('./types').ComparisonContext;
  /** Lightweight mode for quick queries — only registers core tools (execute_sql, invoke_skill, lookup_sql_schema).
   *  Skips planning, hypothesis, knowledge, patterns, notes, artifacts, and comparison tools.
   *  Also disables the plan gate since planning tools are not available. */
  lightweight?: boolean;
  /** Per-analysis budget for skill-notes injection on invoke_skill responses.
   *  When omitted (default) no notes are injected. The runtime constructs and
   *  passes the same instance for every tool call so the running totals are
   *  shared across the analysis. See skillNotesInjector.ts. */
  skillNotesBudget?: import('./selfImprove/skillNotesInjector').SkillNotesBudget;
  /** User-facing output language for backend-emitted progress and hints. */
  outputLanguage?: OutputLanguage;
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
  const skillNotesBudget = options.skillNotesBudget;
  const outputLanguage = options.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;

  /** Normalize skill params: ensure process_name ↔ package are both set. */
  function normalizeSkillParams(params: Record<string, any> | undefined, defaultPackage?: string): Record<string, any> {
    const p = { ...params };
    if (defaultPackage && !p.process_name) p.process_name = defaultPackage;
    if (p.process_name && !p.package) p.package = p.process_name;
    if (p.package && !p.process_name) p.process_name = p.package;
    return p;
  }

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
  /** Track submit_plan attempts for hard-gate: reject first incomplete plan, accept on retry. */
  let planSubmitAttempts = 0;
  function requirePlan(toolName: string): string | null {
    if (!analysisPlanRef) return null; // Planning feature not enabled
    if (analysisPlanRef.current) return null; // Plan already submitted
    return JSON.stringify({
      success: false,
      error: localize(
        outputLanguage,
        `必须先调用 submit_plan 提交分析计划，然后才能使用 ${toolName}。请先制定你的分析计划，包含分析阶段、目标和预期工具。`,
        `You must call submit_plan before using ${toolName}. Create an analysis plan with phases, goals, and expected tools first.`,
      ),
      action_required: 'submit_plan',
    });
  }

  // Phase 1-C: Conditional REASONING_NUDGE — only append for first N data tool calls.
  // After N calls, Claude should have internalized the reflect habit from system prompt.
  const REASONING_NUDGE_MAX_CALLS = 4;
  let dataToolCallCount = 0;
  function getReasoningNudge(): string {
    dataToolCallCount++;
    if (dataToolCallCount > REASONING_NUDGE_MAX_CALLS) return '';
    return outputLanguage === 'en' ? REASONING_NUDGE_EN : REASONING_NUDGE_ZH;
  }

  // Auto-inject `INCLUDE PERFETTO MODULE ...;` for stdlib tables/functions
  // referenced in raw SQL. Shared between execute_sql and execute_sql_on
  // so comparison-mode queries get the same treatment. See
  // sqlIncludeInjector.ts for the full rationale.
  async function runRawSqlWithIncludeInjection(targetTraceId: string, sql: string) {
    const { sql: finalSql, injected } = injectStdlibIncludes(sql);
    if (emitUpdate && injected.length > 0) {
      emitUpdate({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            outputLanguage,
            `自动加载 stdlib 模块: ${injected.join(', ')}`,
            `Auto-loaded stdlib module(s): ${injected.join(', ')}`,
          ),
        },
        timestamp: Date.now(),
      });
    }
    return traceProcessorService.query(targetTraceId, finalSql);
  }

  const executeSql = tool(
    'execute_sql',
    'Execute a raw SQL query against the Perfetto trace_processor for the currently loaded trace. ' +
    'Returns columnar results. Set summary=true for large result sets to get column statistics + sample rows.\n\n' +
    'Use when: ad-hoc queries not covered by existing skills, verifying hypotheses with specific SQL, checking raw data.\n' +
    'Don\'t use when: a matching skill exists (use invoke_skill instead — richer layered output), or you need schema info (use lookup_sql_schema first).\n\n' +
    'Examples:\n' +
    '1. Count jank frames: sql="SELECT COUNT(*) as jank_count FROM actual_frame_timeline_slice WHERE jank_type != \'None\'", summary=false\n' +
    '2. CPU frequency overview: sql="SELECT cpu, MIN(value) as min_freq, MAX(value) as max_freq, AVG(value) as avg_freq FROM counter JOIN counter_track ON counter.track_id=counter_track.id WHERE counter_track.name GLOB \'cpu*freq\' GROUP BY cpu", summary=true\n' +
    '3. Thread state in time range: sql="SELECT state, SUM(dur)/1e6 as total_ms FROM thread_state WHERE utid=123 AND ts BETWEEN 1000 AND 2000 GROUP BY state", summary=false',
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
        const result = await runRawSqlWithIncludeInjection(traceId, sql);
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const success = !result.error;

        const sqlDuration = Date.now() - sqlStart;
        if (emitUpdate && sqlDuration > 500) {
          emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(
                outputLanguage,
                `SQL 查询完成 (${result.rows.length} 行, ${sqlDuration}ms)`,
                `SQL query completed (${result.rows.length} rows, ${sqlDuration}ms)`,
              ),
            },
            timestamp: Date.now(),
          });
        }

        if (emitUpdate && success && result.columns.length > 0 && rows.length > 0) {
          emitSqlDataEnvelope(emitUpdate, result.columns, rows);
        }

        if (emitUpdate && !success && result.error) {
          emitUpdate({
            type: 'progress',
            content: {
              phase: 'analyzing',
              message: localize(
                outputLanguage,
                `SQL 查询错误: ${result.error.substring(0, 200)}`,
                `SQL query error: ${result.error.substring(0, 200)}`,
              ),
            },
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
              })) + getReasoningNudge(),
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
            })) + (success ? getReasoningNudge() : ''),
          }],
        };
      } catch (err) {
        const errMsg = (err as Error).message;
        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(outputLanguage, `SQL 查询失败: ${errMsg}`, `SQL query failed: ${errMsg}`),
          },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errMsg }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const invokeSkill = tool(
    'invoke_skill',
    'Execute a named SmartPerfetto skill pipeline against the current trace. ' +
    'Skills are pre-built analysis routines that produce layered results (overview → list → diagnosis → deep). ' +
    'Use list_skills first to find the right skill ID.\n\n' +
    'Use when: a pre-built skill covers your analysis need — always prefer this over raw SQL for supported scenarios.\n' +
    'Don\'t use when: you need a custom query not covered by any skill (use execute_sql), or exploring what skills exist (use list_skills).\n\n' +
    'Examples:\n' +
    '1. Full scrolling analysis: skillId="scrolling_analysis", params={process_name: "com.example.app"}\n' +
    '2. Single jank frame detail: skillId="jank_frame_detail", params={frame_number: 42, process_name: "com.example.app"}\n' +
    '3. Startup analysis: skillId="startup_analysis", params={process_name: "com.example.app"}',
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
        const effectiveParams = normalizeSkillParams(params, packageName);

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(outputLanguage, `运行分析技能: ${skillId}...`, `Running analysis skill: ${skillId}...`),
          },
          timestamp: Date.now(),
        });

        const skillStart = Date.now();
        const result = await skillExecutor.execute(skillId, traceId, effectiveParams);
        const skillDuration = Date.now() - skillStart;

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              outputLanguage,
              `技能 ${skillId} 完成 (${skillDuration}ms, ${result.displayResults?.length || 0} 个结果层)`,
              `Skill ${skillId} completed (${skillDuration}ms, ${result.displayResults?.length || 0} result layers)`,
            ),
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

        // Prepend skill notes when the per-analysis budget allows. Notes
        // only attach on the success path so a failed skill doesn't pollute
        // the agent's context with unrelated guidance.
        let skillNotesPrefix = '';
        if (skillNotesBudget && result.success) {
          try {
            const candidates = loadSkillNotes(result.skillId || skillId);
            if (candidates.length > 0) {
              const consumed = skillNotesBudget.tryConsume(result.skillId || skillId, candidates);
              if (consumed) skillNotesPrefix = `${consumed.text}\n\n`;
            }
          } catch (err) {
            console.warn('[invoke_skill] skill notes injection failed:', (err as Error).message);
          }
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
            const summary = artifactStore.generateCompactSummary(artId);
            return summary;
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
              text: skillNotesPrefix + consumeWatchdogWarning(JSON.stringify({
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
                hint: 'Use fetch_artifact(artifactId=<id>, detail="rows", offset=0, limit=50) to page through large datasets. All data is accessible — use offset/limit to paginate.',
              })) + (result.success ? getReasoningNudge() : ''),
            }],
          };
        }

        // Default: return full displayResults (backward compatible)
        return {
          content: [{
            type: 'text' as const,
            text: skillNotesPrefix + consumeWatchdogWarning(JSON.stringify({
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
            })) + (result.success ? getReasoningNudge() : ''),
          }],
        };
      } catch (err) {
        const errMsg = (err as Error).message;
        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(outputLanguage, `技能 ${skillId} 执行失败: ${errMsg}`, `Skill ${skillId} failed: ${errMsg}`),
          },
          timestamp: Date.now(),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: errMsg }) }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
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
    },
    { annotations: { readOnlyHint: true } },
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
    },
    { annotations: { readOnlyHint: true } },
  );

  const lookupSqlSchema = tool(
    'lookup_sql_schema',
    'Search the Perfetto SQL stdlib index for table, view, and function definitions matching a keyword. ' +
    'Use this to discover available SQL entities before writing raw SQL queries.\n\n' +
    'Use when: you need to find table/view/function names before writing SQL, or verifying column names exist.\n' +
    'Don\'t use when: you already know the exact table name, or need the full stdlib module list (use list_stdlib_modules).\n\n' +
    'Examples:\n' +
    '1. Find frame-related tables: keyword="frame_timeline"\n' +
    '2. Find binder tables: keyword="binder"\n' +
    '3. Find thread state columns: keyword="thread_state"',
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
    },
    { annotations: { readOnlyHint: true } },
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
    'Response includes totalRows and hasMore to guide pagination. ALL data is accessible; nothing is hidden.\n\n' +
    'Use when: you need detailed data from a previous invoke_skill result (artifacts are referenced by ID in skill responses).\n' +
    'Don\'t use when: you need new data (use invoke_skill or execute_sql instead).\n\n' +
    'Examples:\n' +
    '1. Get summary of skill result: artifactId="art-1", detail="summary"\n' +
    '2. Page through jank frames: artifactId="art-2", detail="rows", offset=0, limit=50\n' +
    '3. Get next page: artifactId="art-2", detail="rows", offset=50, limit=50',
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
      // Phase 3-4 of v2.1 — high-risk path recitation. `full` and `rows` detail
      // levels return large payloads that push the agent's working memory; in
      // those cases append a one-line plan reminder so the agent doesn't drift
      // away from the active phase's constraints. Summary mode skips the
      // reminder (compact responses already keep the agent on-track).
      const reminder = (effectiveDetail === 'full' || effectiveDetail === 'rows')
        ? buildActivePhaseReminder(analysisPlanRef?.current, options.sceneType)
        : '';
      const payload = JSON.stringify({ success: true, detail: effectiveDetail, ...result });
      return {
        content: [{
          type: 'text' as const,
          text: reminder ? payload + reminder : payload,
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  // list_stdlib_modules: Expose Perfetto stdlib module inventory to the agent.
  // Enables Claude to discover available stdlib modules by namespace (e.g., "android.frames", "sched").
  const listStdlibModules = tool(
    'list_stdlib_modules',
    'List available Perfetto SQL stdlib modules by namespace. Use this to discover what pre-built tables, views, and functions ' +
    'are available before writing custom SQL. Modules can be loaded via INCLUDE PERFETTO MODULE <name> in SQL queries. ' +
    'Core modules (android.frames.timeline, android.startup.startups, android.binder) are pre-loaded; ' +
    'others load on-demand via skill prerequisites or INCLUDE PERFETTO MODULE in your SQL.',
    {
      namespace: z.string().optional().describe(
        'Filter by namespace prefix (e.g., "android", "android.frames", "sched", "chrome", "wattson"). Omit to list all.'
      ),
    },
    async ({ namespace }) => {
      const allModules = getPerfettoStdlibModules();
      // Enforce dot-boundary matching to avoid "android" matching a hypothetical "androidos.*"
      const filtered = namespace
        ? allModules.filter(m => m === namespace || m.startsWith(namespace + '.'))
        : allModules;

      // Group by top-level namespace
      const grouped: Record<string, string[]> = {};
      for (const mod of filtered) {
        const ns = mod.split('.')[0];
        if (!grouped[ns]) grouped[ns] = [];
        grouped[ns].push(mod);
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalModules: filtered.length,
            namespaces: Object.keys(grouped).sort(),
            // When filtering by namespace, return full module list.
            // When unfiltered, return only counts per namespace to save context tokens (~1500 tokens).
            modules: namespace
              ? filtered.sort()
              : Object.fromEntries(Object.entries(grouped).map(([ns, mods]) => [ns, mods.length])),
            hint: namespace
              ? 'Use lookup_sql_schema to find specific tables/views/functions within a module.'
              : 'Call again with a namespace (e.g., "android.frames") to see full module list. ' +
                'Critical modules (android.frames.*, android.binder*, android.startup.*, sched.*) are pre-loaded.',
          }),
        }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // lookup_knowledge: Load background knowledge on performance analysis topics on demand.
  // The agent calls this when it needs to explain a root cause mechanism to the user.
  // Topics are auto-discovered from knowledge-*.template.md files in the strategies directory.
  const knowledgeTopics = (() => {
    const strategiesDir = path.resolve(__dirname, '../../../strategies');
    try {
      return fs.readdirSync(strategiesDir)
        .filter(f => f.startsWith('knowledge-') && f.endsWith('.template.md'))
        .map(f => f.replace('knowledge-', '').replace('.template.md', ''))
        .sort();
    } catch {
      return ['rendering-pipeline', 'binder-ipc', 'gc-dynamics', 'cpu-scheduler', 'thermal-throttling', 'lock-contention'];
    }
  })();

  const lookupKnowledge = tool(
    'lookup_knowledge',
    'Load background knowledge about a performance analysis topic. Use this when you discover a root cause ' +
    'and want to explain the underlying mechanism to the user. Returns concise explanations of how the ' +
    'system works, common trace signatures, and typical solutions. ' +
    `Available topics: ${knowledgeTopics.join(', ')}.`,
    {
      topic: z.string().describe(
        `Knowledge topic: ${knowledgeTopics.map(t => `"${t}"`).join(' | ')}`
      ),
    },
    async ({ topic }) => {
      const content = loadPromptTemplate('knowledge-' + topic);
      if (!content) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Unknown topic "${topic}". Available: ${knowledgeTopics.join(', ')}`,
            }),
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );

  // query_perfetto_source: Search the Perfetto stdlib for SQL patterns and usage examples.
  // Enables Claude to self-learn by finding how official code uses tables/functions.
  const queryPerfettoSource = tool(
    'query_perfetto_source',
    'Search the Perfetto SQL stdlib source code for usage patterns. Packaged builds fall back to the bundled SQL schema index when the source tree is unavailable. Use this when you encounter an unfamiliar table/function, get an SQL error, or need to find how the official codebase uses a specific table or column.',
    {
      keyword: z.string().describe('Search keyword (table name, function name, column name, or SQL pattern)'),
      max_results: z.number().optional().describe('Maximum number of matching files to return (default: 5)'),
    },
    async ({ keyword, max_results }) => {
      const maxFiles = max_results ?? 5;
      const stdlibDir = getPerfettoStdlibPath();

      if (!fs.existsSync(stdlibDir)) {
        const lowerKeyword = keyword.toLowerCase();
        const schema = loadSqlSchema();
        const results = schema.templates
          .filter(t => {
            const searchable = `${t.name} ${t.category} ${t.description ?? ''}`.toLowerCase();
            return searchable.includes(lowerKeyword);
          })
          .slice(0, maxFiles)
          .map(t => ({
            file: t.id,
            matches: [
              [
                `name: ${t.name}`,
                `category: ${t.category}`,
                `type: ${t.type ?? 'unknown'}`,
                `description: ${t.description ?? ''}`,
              ].join('\n'),
            ],
          }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              keyword,
              source: 'bundled_schema_index',
              matchedFiles: results.length,
              results: results.map(r => ({
                file: r.file,
                matchCount: r.matches.length,
                matches: r.matches,
              })),
              note: 'Perfetto stdlib source tree is unavailable in this runtime; returned bundled schema-index matches instead.',
            }),
          }],
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
              source: 'stdlib_source',
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
    },
    { annotations: { readOnlyHint: true } },
  );

  // P1-G11: Scene plan templates extracted to `./scenePlanTemplates` (Phase 0.2 of
  // v2.1). The previous inline `'touch-tracking'` key (hyphen) silently disabled
  // hard-gate for the touch_tracking scene because strategy frontmatter uses
  // underscore-form `scene: touch_tracking`; coverage test now guards this.

  // Planning tools: submit_plan + update_plan_phase (P0-1: Explicit planning capability)
  // analysisPlanRef is declared above (P0-G10) and shared with planning tools
  const submitPlan = analysisPlanRef ? tool(
    'submit_plan',
    'Submit your structured analysis plan BEFORE starting any analysis. ' +
    'Define phases with goals and expected tools. The system tracks plan adherence and warns on deviation. ' +
    'You MUST call this tool as your first action in every analysis.\n\n' +
    'Use when: starting any new analysis — this is mandatory before execute_sql or invoke_skill.\n' +
    'Don\'t use when: plan already submitted (use revise_plan to modify, update_plan_phase to track progress).\n\n' +
    'Examples:\n' +
    '1. Scrolling plan: phases=[{id:"p1", name:"概览采集", goal:"获取帧统计和卡顿分布", expectedTools:["invoke_skill"]}, ' +
    '{id:"p2", name:"根因分析", goal:"逐帧诊断卡顿原因", expectedTools:["invoke_skill","execute_sql"]}, ' +
    '{id:"p3", name:"深入验证", goal:"验证根因假设", expectedTools:["execute_sql","fetch_artifact"]}], ' +
    'successCriteria="识别卡顿根因并提供量化证据"',
    {
      phases: z.array(z.object({
        id: z.string().describe('Phase identifier (e.g. "p1", "p2")'),
        name: z.string().describe('Phase name (e.g. "Overview Collection")'),
        goal: z.string().describe('What this phase aims to achieve'),
        expectedTools: z.array(z.string()).describe('Tool names this phase will use (e.g. ["invoke_skill", "execute_sql"])'),
        expectedCalls: z.array(z.object({
          tool: z.string().describe('Short tool name without prefix (e.g. "invoke_skill")'),
          skillId: z.string().optional().describe('For invoke_skill, the required skillId'),
        })).optional().describe('Optional structured matchers — preferred over expectedTools when set. Use to require a specific skillId, e.g. [{tool:"invoke_skill", skillId:"startup_slow_reasons"}].'),
      })).min(1).describe('Ordered list of analysis phases (at least 1 phase required)'),
      successCriteria: z.string().describe('What constitutes a successful analysis (e.g. "Identify root cause of jank frames with evidence")'),
      waivers: z.array(z.object({
        aspectId: z.string().describe('Mandatory aspect id to opt out of (matches a `missingAspectIds` entry from a prior reject).'),
        reason: z.string().describe(`Justification for why this aspect cannot be covered. MUST be at least ${MIN_WAIVER_REASON_CHARS} characters.`),
      })).optional().describe('Optional opt-outs for scene-template aspects when the trace genuinely cannot support them.'),
    },
    async ({ phases, successCriteria, waivers }) => {
      // P1-G11: Validate against the scene template, honouring agent waivers.
      const validation = validatePlanAgainstSceneTemplate(phases, options.sceneType, waivers);
      const { warnings: planWarnings, missingAspectIds } = validation;

      // Track only waivers whose reason met the minimum threshold; the rest
      // are reported back so the agent knows they didn't count.
      const acceptedWaivers = (waivers ?? []).filter(
        w => typeof w.reason === 'string' && w.reason.trim().length >= MIN_WAIVER_REASON_CHARS,
      );
      const tooShortWaivers = (waivers ?? []).filter(
        w => !acceptedWaivers.some(a => a.aspectId === w.aspectId),
      );

      planSubmitAttempts++;

      // Phase 2.3: 真硬拦截 — keep rejecting until plan covers all aspects
      // or supplies a substantial waiver. After MAX_PLAN_ATTEMPTS the gate
      // gives up and force-accepts, but missing aspects are persisted to
      // `unresolvedAspects` so `verifyPlanAdherence` still flags the gap.
      const MAX_PLAN_ATTEMPTS = 5;
      if (planWarnings.length > 0 && planSubmitAttempts < MAX_PLAN_ATTEMPTS) {
        console.log(`[MCP] Plan rejected (attempt ${planSubmitAttempts}/${MAX_PLAN_ATTEMPTS}): missing ${missingAspectIds.length} aspects for ${options.sceneType ?? 'unknown scene'}`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(
                outputLanguage,
                `计划缺少 ${options.sceneType ?? '当前'} 场景的必要分析阶段`,
                `The plan is missing mandatory analysis phases for the ${options.sceneType ?? 'current'} scene`,
              ),
              missingAspectIds,
              missingAspectSuggestions: planWarnings,
              attempt: planSubmitAttempts,
              maxAttempts: MAX_PLAN_ATTEMPTS,
              tooShortWaivers: tooShortWaivers.length > 0 ? tooShortWaivers : undefined,
              hint: localize(
                outputLanguage,
                `修复 plan 添加缺失阶段并重新调用 submit_plan，或在 waivers 中给出 ≥${MIN_WAIVER_REASON_CHARS} 字符的理由说明为什么无法覆盖。`,
                `Add the missing phases and call submit_plan again, or provide a waiver reason of at least ${MIN_WAIVER_REASON_CHARS} characters explaining why it cannot be covered.`,
              ),
            }),
          }],
          isError: true,
        };
      }

      const forcedAccept = planWarnings.length > 0; // hit the attempt cap
      const plan: AnalysisPlanV3 = {
        phases: phases.map(p => ({
          ...p,
          status: 'pending' as const,
        })),
        successCriteria,
        submittedAt: Date.now(),
        toolCallLog: [],
        ...(acceptedWaivers.length > 0 ? { waivers: acceptedWaivers } : {}),
        ...(forcedAccept ? { unresolvedAspects: missingAspectIds } : {}),
      };
      analysisPlanRef.current = plan;

      if (forcedAccept) {
        console.warn(`[MCP] Plan force-accepted at attempt ${planSubmitAttempts} with ${missingAspectIds.length} unresolved aspects: ${missingAspectIds.join(', ')}`);
      }

      emitUpdate?.({
        type: 'plan_submitted',
        content: {
          phases: plan.phases.map(p => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })),
          successCriteria,
        },
        timestamp: Date.now(),
      });

      const response: Record<string, any> = { success: true };
      if (acceptedWaivers.length > 0) {
        response.acceptedWaivers = acceptedWaivers.map(w => w.aspectId);
      }
      if (tooShortWaivers.length > 0) {
        response.tooShortWaivers = tooShortWaivers;
        response.waiverHint = localize(
          outputLanguage,
          `已忽略 ${tooShortWaivers.length} 条理由不足 ${MIN_WAIVER_REASON_CHARS} 字符的 waiver。`,
          `Ignored ${tooShortWaivers.length} waiver(s) whose reason is shorter than ${MIN_WAIVER_REASON_CHARS} characters.`,
        );
      }
      if (forcedAccept) {
        response.unresolvedAspects = missingAspectIds;
        response.warning = localize(
          outputLanguage,
          `已强制接受 plan（达到第 ${MAX_PLAN_ATTEMPTS} 次尝试上限），但未覆盖的 aspect 会在最终 verifier 中报错。`,
          `Plan force-accepted after reaching the ${MAX_PLAN_ATTEMPTS}-attempt limit, but uncovered aspects will be reported by the final verifier.`,
        );
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
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
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, '还没有提交 plan，请先调用 submit_plan。', 'No plan submitted yet. Call submit_plan first.'),
            }),
          }],
          isError: true,
        };
      }

      const phase = plan.phases.find(p => p.id === phaseId);
      if (!phase) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, `plan 中没有找到阶段 "${phaseId}"`, `Phase "${phaseId}" not found in plan`),
            }),
          }],
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
        summaryFeedback = localize(
          outputLanguage,
          'Warning: phase summary is too brief. Include specific evidence (数据、数值、发现) for plan adherence verification.',
          'Warning: phase summary is too brief. Include specific evidence (data, numbers, findings) for plan adherence verification.',
        );
      }

      // Compact return: only include feedback when needed (normal path = minimal ACK)
      const response: Record<string, any> = { success: true };
      if (!nextPhase) response.allPhasesComplete = true;
      if (summaryFeedback) response.summaryFeedback = summaryFeedback;

      // Restatement injection: leverage tool response's high-attention position
      // to re-state next-phase constraints from strategy frontmatter phase_hints.
      // Match logic lives in `phaseHintMatcher` so it can be unit tested.
      if (nextPhase && options.sceneType) {
        const hints = getPhaseHints(options.sceneType);
        const matchedHint = matchPhaseHintForNextPhase({
          hints,
          nextPhase: { name: nextPhase.name, goal: nextPhase.goal },
          finishedPhases: plan.phases.map(p => ({
            name: p.name,
            goal: p.goal,
            summary: p.summary,
            status: p.status,
          })),
        });

        if (matchedHint) {
          response.next_phase_reminder = {
            phaseId: nextPhase.id,
            name: nextPhase.name,
            constraints: matchedHint.constraints,
            criticalTools: matchedHint.criticalTools,
          };
          console.log(`[MCP] Phase hint injected: ${matchedHint.id} for ${options.sceneType}`);
        } else if (hints.length > 0) {
          console.log(`[MCP] Phase hint not found for: "${nextPhase.name}" in ${options.sceneType}`);
        }

        // Always include basic next phase info for non-hint scenarios
        if (!response.next_phase_reminder) {
          response.next = {
            phaseId: nextPhase.id,
            name: nextPhase.name,
            expectedTools: nextPhase.expectedTools,
          };
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(response),
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
        expectedCalls: z.array(z.object({
          tool: z.string(),
          skillId: z.string().optional(),
        })).optional().describe('Optional structured matchers — see submit_plan for semantics.'),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped']).optional()
          .describe('Phase status. Omit for new/pending phases. Completed/skipped phases from original plan are preserved.'),
      })).describe('The revised phase list. Must include all completed/in-progress phases from original plan.'),
      updatedSuccessCriteria: z.string().optional().describe('Updated success criteria (only if the goal changed)'),
    },
    async ({ reason, updatedPhases, updatedSuccessCriteria }) => {
      // Reset submit attempts so a revised plan can trigger hard-gate validation again
      planSubmitAttempts = 0;
      const plan = analysisPlanRef.current;
      if (!plan) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: localize(outputLanguage, '还没有提交 plan，请先调用 submit_plan。', 'No plan submitted yet. Call submit_plan first.'),
            }),
          }],
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
              error: localize(
                outputLanguage,
                `已完成阶段必须保留: ${missingCompleted.map(p => p.id).join(', ')}。请把它们放入 updatedPhases。`,
                `Completed phases must be preserved: ${missingCompleted.map(p => p.id).join(', ')}. Include them in updatedPhases.`,
              ),
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
          expectedCalls: up.expectedCalls,
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
      // P1-G11: Run scene-template validation on the revised plan too — otherwise
      // an agent could submit a compliant plan and then revise mandatory phases
      // away to bypass the hard-gate. Phase 2.3 will upgrade these warnings to
      // a real reject when sceneType is known.
      const { warnings: revisedPlanWarnings } = validatePlanAgainstSceneTemplate(
        plan.phases,
        options.sceneType,
      );
      const reviseResponse: Record<string, unknown> = {
        success: true,
        message: localize(
          outputLanguage,
          `Plan 已修订（第 ${plan.revisionHistory.length} 次）: ${reason}`,
          `Plan revised (revision #${plan.revisionHistory.length}): ${reason}`,
        ),
        totalPhases: plan.phases.length,
        pendingPhases: pending.length,
        nextPhase: pending[0]?.id,
      };
      if (revisedPlanWarnings.length > 0) {
        reviseResponse.sceneWarnings = revisedPlanWarnings;
        console.log(`[MCP] Revised plan has ${revisedPlanWarnings.length} unmet aspects for ${options.sceneType ?? 'unknown scene'}`);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(reviseResponse),
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
          message: localize(
            outputLanguage,
            `⚠️ 不确定性标记: ${topic}\n假设: ${assumption}\n建议确认: ${question}`,
            `⚠️ Uncertainty flagged: ${topic}\nAssumption: ${assumption}\nSuggested confirmation: ${question}`,
          ),
        },
        timestamp: Date.now(),
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: localize(
              outputLanguage,
              `已标记不确定性。将基于假设继续: "${assumption}"。用户会看到该标记，并可在下一轮纠正。`,
              `Uncertainty flagged. Proceeding with assumption: "${assumption}". The user will see this flag and can correct it in the next turn.`,
            ),
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
    },
    { annotations: { readOnlyHint: true } },
  );

  // ---------------------------------------------------------------------------
  // Comparison mode tools — conditional on referenceTraceId
  // ---------------------------------------------------------------------------
  const { referenceTraceId, comparisonContext } = options;

  const executeSqlOn = referenceTraceId ? tool(
    'execute_sql_on',
    'Execute a SQL query against a specific trace in comparison mode. ' +
    'Use "current" for the primary trace, "reference" for the comparison trace.\n\n' +
    'Use when: you need to drill into a specific trace during comparison analysis, ' +
    'or verify a finding from compare_skill with more targeted SQL.\n\n' +
    'Examples:\n' +
    '1. Check reference trace jank: trace="reference", sql="SELECT COUNT(*) FROM actual_frame_timeline_slice WHERE jank_type != \'None\'"\n' +
    '2. Compare CPU freq: trace="current", sql="SELECT cpu, AVG(value) as avg_freq FROM counter JOIN counter_track ON counter.track_id=counter_track.id WHERE counter_track.name GLOB \'cpu*freq\' GROUP BY cpu"',
    {
      trace: z.enum(['current', 'reference']).describe(
        'Which trace to query: "current" = primary trace loaded in Perfetto, "reference" = comparison trace.'
      ),
      sql: z.string().describe('The SQL query to execute against the specified trace.'),
      summary: z.boolean().optional().describe(
        'When true, returns column statistics + sample rows instead of full results. Default: false.'
      ),
    },
    async ({ trace, sql, summary }) => {
      const planError = requirePlan('execute_sql_on');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
      const targetTraceId = trace === 'reference' ? referenceTraceId : traceId;
      const traceLabel = trace === 'reference'
        ? localize(outputLanguage, '[参考 Trace]', '[reference trace]')
        : localize(outputLanguage, '[当前 Trace]', '[current trace]');
      try {
        const sqlStart = Date.now();
        const result = await runRawSqlWithIncludeInjection(targetTraceId, sql);
        const truncated = result.rows.length > 200;
        const rows = truncated ? result.rows.slice(0, 200) : result.rows;
        const success = !result.error;

        if (success && summary && result.rows.length > 0) {
          const summaryResult = summarizeSqlResult(result.columns, result.rows);
          const durationMs = Date.now() - sqlStart;
          const text = JSON.stringify({
            success: true,
            trace: traceLabel,
            summary: summaryResult,
            totalRows: result.rows.length,
            durationMs,
          });
          return { content: [{ type: 'text' as const, text: consumeWatchdogWarning(text + getReasoningNudge()) }] };
        }

        const durationMs = Date.now() - sqlStart;
        const text = JSON.stringify({
          success,
          trace: traceLabel,
          columns: result.columns,
          rows,
          totalRows: result.rows.length,
          truncated,
          durationMs,
          error: result.error,
        });
        return { content: [{ type: 'text' as const, text: consumeWatchdogWarning(success ? text + getReasoningNudge() : text) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, trace: traceLabel, error: e.message }) }] };
      }
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  const compareSkill = referenceTraceId ? tool(
    'compare_skill',
    'Run the same skill on both current and reference traces in parallel, returning side-by-side results with schema alignment info.\n\n' +
    'Use when: you want to compare the same analysis dimension across both traces (e.g., scrolling_analysis, cpu_analysis).\n' +
    'Don\'t use when: you need different skills on each trace, or ad-hoc SQL queries (use execute_sql_on instead).\n\n' +
    'Examples:\n' +
    '1. Compare scrolling: skillId="scrolling_analysis", params={process_name: "com.example.app"}\n' +
    '2. Compare CPU: skillId="cpu_analysis"',
    {
      skillId: z.string().describe('Skill identifier to run on both traces'),
      params: z.record(z.string(), z.any()).optional().describe(
        'Parameters passed to both skill executions. Common: { process_name, start_ts, end_ts }'
      ),
    },
    async ({ skillId, params }) => {
      const planError = requirePlan('compare_skill');
      if (planError) {
        return { content: [{ type: 'text' as const, text: planError }] };
      }
      try {
        const effectiveParams = normalizeSkillParams(params, packageName);
        // For reference trace: use its own package name if detected, otherwise
        // omit process_name filter entirely (safer than silently using current's package)
        const refParams = comparisonContext?.referencePackageName
          ? normalizeSkillParams(params, comparisonContext.referencePackageName)
          : normalizeSkillParams(params); // No default package — skill runs unfiltered

        emitUpdate?.({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              outputLanguage,
              `对比技能 ${skillId}：在两个 Trace 上并行执行...`,
              `Comparing skill ${skillId}: running on both traces in parallel...`,
            ),
          },
          timestamp: Date.now(),
        });

        const compareStart = Date.now();
        const [currentResult, refResult] = await Promise.all([
          skillExecutor.execute(skillId, traceId, effectiveParams),
          skillExecutor.execute(skillId, referenceTraceId, refParams),
        ]);
        const compareDuration = Date.now() - compareStart;

        // Schema alignment: check which steps are comparable
        const currentStepIds = new Set((currentResult.displayResults || []).map(r => r.stepId));
        const refStepIds = new Set((refResult.displayResults || []).map(r => r.stepId));
        const comparableSteps = [...currentStepIds].filter(id => refStepIds.has(id));
        const incompatibleSteps = [
          ...[...currentStepIds]
            .filter(id => !refStepIds.has(id))
            .map(id => `${id} ${localize(outputLanguage, '(仅当前 Trace)', '(current trace only)')}`),
          ...[...refStepIds]
            .filter(id => !currentStepIds.has(id))
            .map(id => `${id} ${localize(outputLanguage, '(仅参考 Trace)', '(reference trace only)')}`),
        ];

        // Emit data envelopes for both sides (labeled)
        if (emitUpdate && currentResult.displayResults?.length) {
          emitSkillDataEnvelopes(
            currentResult.displayResults as SkillDisplayResult[],
            `${skillId}${localize(outputLanguage, '[当前]', '[current]')}`,
            emitUpdate,
          );
        }
        if (emitUpdate && refResult.displayResults?.length) {
          emitSkillDataEnvelopes(
            refResult.displayResults as SkillDisplayResult[],
            `${skillId}${localize(outputLanguage, '[参考]', '[reference]')}`,
            emitUpdate,
          );
        }

        // Build compact comparison summary for Claude
        const buildStepSummary = (results: any[]) =>
          results.map(r => ({
            stepId: r.stepId,
            title: r.title,
            rowCount: r.data?.rows?.length || 0,
            columns: r.data?.columns || [],
          }));

        const text = JSON.stringify({
          success: true,
          durationMs: compareDuration,
          current: {
            success: currentResult.success,
            stepCount: currentResult.displayResults?.length || 0,
            steps: buildStepSummary(currentResult.displayResults || []),
            diagnosticCount: currentResult.diagnostics?.length || 0,
            error: currentResult.error,
          },
          reference: {
            success: refResult.success,
            stepCount: refResult.displayResults?.length || 0,
            steps: buildStepSummary(refResult.displayResults || []),
            diagnosticCount: refResult.diagnostics?.length || 0,
            error: refResult.error,
          },
          alignment: {
            comparableSteps,
            incompatibleSteps: incompatibleSteps.length > 0 ? incompatibleSteps : undefined,
          },
          hint: localize(
            outputLanguage,
            '使用 execute_sql_on 深钻具体差异指标，或使用 fetch_artifact 获取详细数据。',
            'Use execute_sql_on to drill into specific delta metrics, or fetch_artifact for detailed data.',
          ),
        });

        return { content: [{ type: 'text' as const, text: consumeWatchdogWarning(text + getReasoningNudge()) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e.message }) }] };
      }
    },
  ) : null;

  const getComparisonContext = (referenceTraceId && comparisonContext) ? tool(
    'get_comparison_context',
    'Get metadata comparison between the current trace and the reference trace. ' +
    'Returns device info, focus app, architecture, and capability alignment for both traces.\n\n' +
    'ALWAYS call this first in comparison mode to understand what you are comparing ' +
    'and confirm the traces are comparable (same app, compatible capabilities).',
    {},
    async () => {
      const ctx = comparisonContext!;
      const text = JSON.stringify({
        success: true,
        current: {
          traceId,
          packageName: packageName || 'unknown',
          architecture: options.cachedArchitecture?.type || 'unknown',
          focusApps: options.cachedArchitecture ? undefined : 'detect with detect_architecture',
        },
        reference: {
          traceId: referenceTraceId,
          packageName: ctx.referencePackageName || 'unknown',
          architecture: ctx.referenceArchitecture?.type || 'unknown',
        },
        packageAlignment: packageName && ctx.referencePackageName
          ? (packageName === ctx.referencePackageName ? 'same' : 'different')
          : 'unknown',
        commonCapabilities: ctx.commonCapabilities,
        capabilityDiff: ctx.capabilityDiff,
      });
      return { content: [{ type: 'text' as const, text }] };
    },
    { annotations: { readOnlyHint: true } },
  ) : null;

  // P2-G1: Co-locate tool objects with their names — auto-derives allowedTools
  // so adding a new MCP tool automatically makes it available to the SDK.
  const toolEntries: Array<{ tool: any; name: string }> = [];

  if (options.lightweight) {
    // Lightweight mode: only 3 core data-access tools — no planning, hypothesis, notes, or advanced tools.
    // Plan gate is automatically disabled because analysisPlan is not passed in lightweight mode.
    toolEntries.push(
      { tool: executeSql, name: 'execute_sql' },
      { tool: invokeSkill, name: 'invoke_skill' },
      { tool: lookupSqlSchema, name: 'lookup_sql_schema' },
    );
  } else {
    // Full mode: all always-on tools + conditional tools
    toolEntries.push(
      { tool: executeSql, name: 'execute_sql' },
      { tool: invokeSkill, name: 'invoke_skill' },
      { tool: listSkills, name: 'list_skills' },
      { tool: detectArchitecture, name: 'detect_architecture' },
      { tool: lookupSqlSchema, name: 'lookup_sql_schema' },
      { tool: queryPerfettoSource, name: 'query_perfetto_source' },
      { tool: listStdlibModules, name: 'list_stdlib_modules' },
      { tool: lookupKnowledge, name: 'lookup_knowledge' },
    );
    if (writeAnalysisNote) toolEntries.push({ tool: writeAnalysisNote, name: 'write_analysis_note' });
    if (fetchArtifact) toolEntries.push({ tool: fetchArtifact, name: 'fetch_artifact' });
    if (submitPlan) toolEntries.push({ tool: submitPlan, name: 'submit_plan' });
    if (updatePlanPhase) toolEntries.push({ tool: updatePlanPhase, name: 'update_plan_phase' });
    if (revisePlan) toolEntries.push({ tool: revisePlan, name: 'revise_plan' });
    if (submitHypothesis) toolEntries.push({ tool: submitHypothesis, name: 'submit_hypothesis' });
    if (resolveHypothesis) toolEntries.push({ tool: resolveHypothesis, name: 'resolve_hypothesis' });
    if (flagUncertainty) toolEntries.push({ tool: flagUncertainty, name: 'flag_uncertainty' });
    toolEntries.push({ tool: recallPatterns, name: 'recall_patterns' });
    // Comparison mode tools — only when referenceTraceId is provided
    if (compareSkill) toolEntries.push({ tool: compareSkill, name: 'compare_skill' });
    if (executeSqlOn) toolEntries.push({ tool: executeSqlOn, name: 'execute_sql_on' });
    if (getComparisonContext) toolEntries.push({ tool: getComparisonContext, name: 'get_comparison_context' });
  }

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
