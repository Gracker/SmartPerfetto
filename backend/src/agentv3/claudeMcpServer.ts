import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceProcessorService } from '../services/traceProcessorService';
import type { SkillExecutor } from '../services/skillEngine/skillExecutor';
import { getSkillAnalysisAdapter } from '../services/skillEngine/skillAnalysisAdapter';
import { createArchitectureDetector } from '../agent/detectors/architectureDetector';
import type { SqlSchemaIndex } from './types';

let sqlSchemaCache: SqlSchemaIndex | null = null;

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

export interface ClaudeMcpServerOptions {
  traceId: string;
  traceProcessorService: TraceProcessorService;
  skillExecutor: SkillExecutor;
  packageName?: string;
}

/**
 * Creates an in-process MCP server scoped to a specific trace session.
 * Exposes 5 domain tools: execute_sql, invoke_skill, list_skills,
 * detect_architecture, lookup_sql_schema.
 */
export function createClaudeMcpServer(options: ClaudeMcpServerOptions) {
  const { traceId, traceProcessorService, skillExecutor, packageName } = options;
  const skillAdapter = getSkillAnalysisAdapter(traceProcessorService);

  const executeSql = tool(
    'execute_sql',
    'Execute a raw SQL query against the Perfetto trace_processor for the currently loaded trace. ' +
    'Returns columnar results. Use this for ad-hoc queries not covered by existing skills. ' +
    'Prefer invoke_skill when a matching skill exists — it produces richer, layered output.',
    {
      sql: z.string().describe(
        'The SQL query to execute. Use Perfetto stdlib tables/functions (e.g. android_jank_cuj, slice, thread, process).'
      ),
    },
    async ({ sql }) => {
      try {
        const result = await traceProcessorService.query(traceId, sql);
        const truncated = result.rows.length > 200;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: !result.error,
              columns: result.columns,
              rows: truncated ? result.rows.slice(0, 200) : result.rows,
              totalRows: result.rows.length,
              truncated,
              durationMs: result.durationMs,
              ...(result.error ? { error: result.error } : {}),
            }, null, 2),
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
      try {
        const effectiveParams = { ...params };
        if (packageName && !effectiveParams.process_name) {
          effectiveParams.process_name = packageName;
        }
        const result = await skillExecutor.execute(skillId, traceId, effectiveParams);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: result.success,
              skillId: result.skillId,
              skillName: result.skillName,
              displayResults: result.displayResults?.map(dr => ({
                stepId: dr.stepId,
                title: dr.title,
                layer: dr.layer,
                data: dr.data,
              })),
              diagnostics: result.diagnostics,
              synthesizeData: result.synthesizeData,
            }, null, 2),
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
              })),
              null,
              2
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
            }, null, 2),
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
      const matches = schema.templates
        .filter(t => t.name.toLowerCase().includes(lower) || t.category.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower))
        .slice(0, 30);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            totalMatches: matches.length,
            entries: matches.map(m => ({ name: m.name, type: m.type, category: m.category, description: m.description })),
          }, null, 2),
        }],
      };
    }
  );

  return createSdkMcpServer({
    name: 'smartperfetto',
    version: '1.0.0',
    tools: [executeSql, invokeSkill, listSkills, detectArchitecture, lookupSqlSchema],
  });
}
