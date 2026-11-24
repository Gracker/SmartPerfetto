// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {ChatTool} from './piSession';
import {runStandardSkill, type RunnerMode} from './runner';
import {describeSkillCatalog, isTraceTimestamp, readSkillResource, type Bundle, type SkillRuntime} from './skillBundle';
import type {TraceBounds} from './trace';

export interface TraceReference {
  referenceId: string;
  toolCallId: string;
  traceId: string;
  label: string;
  startNs: string;
  endNs: string;
}

export interface ProbeResult { bounds: TraceBounds }
interface Evidence {
  queryId?: string;
  status?: string;
  rows?: Record<string, unknown>[];
}

function content(result: unknown) {
  const text = JSON.stringify(result);
  return {
    content: [{type: 'text' as const, text: text.length <= 20_000 ? text :
      JSON.stringify({truncated: true, excerpt: text.slice(0, 18_000)})}],
    details: {},
  };
}

interface ToolOptions {
  bundle?: Bundle;
  getTrace?(): Promise<{id: string; file: string; runtime: SkillRuntime; probe: ProbeResult}>;
  signal: AbortSignal;
  authorize(): Promise<void>;
  onTool(name: string): void;
  onReference(reference: TraceReference): void;
}

export function makeChatTools({bundle, getTrace, signal, authorize, onTool, onReference}: ToolOptions): ChatTool[] {
  if (!bundle) return [];
  type Params = Record<string, unknown>;
  let toolCalls = 0;
  let references = 0;
  function tool(name: string, description: string, properties: object, required: string[],
    run: (params: Params, id: string) => Promise<unknown>,
  ): ChatTool {
    return {
      name, label: name, description,
      parameters: {type: 'object', properties, required, additionalProperties: false} as ChatTool['parameters'],
      async execute(id, params: Params) {
        try {
          await authorize();
          signal.throwIfAborted();
          if (++toolCalls > 24) throw new Error('TOOL_BUDGET_EXCEEDED');
          onTool(name);
          const result = await run(params, id);
          await authorize();
          signal.throwIfAborted();
          return content(result);
        } catch (error) {
          signal.throwIfAborted();
          const code = error instanceof Error ? error.message : '';
          return content({
            error: /^([A-Z]+_)+[A-Z]+$/.test(code) ? code : 'TOOL_UNAVAILABLE',
            ...(['UNKNOWN_SKILL_OR_QUERY', 'INVALID_SKILL_PARAMETER'].includes(code) ? {
              hint: 'Use read_perfetto_resource with path catalog, an optional prefix, and then skillId to list exact query IDs and declared parameters.',
            } : {}),
          });
        }
      },
    };
  }
  const tools = [tool('read_perfetto_resource',
    'Read bundle resources by relative path. Use path catalog with a prefix to list Skill IDs, or a skillId to list exact queries and inputs. Use nextOffset to continue.',
    {path: {type: 'string'}, offset: {type: 'integer', minimum: 0},
      skillId: {type: 'string'}, prefix: {type: 'string'}}, ['path'],
    async ({path, offset = 0, skillId, prefix = ''}) => {
      if (typeof path !== 'string' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
          (skillId !== undefined && (typeof skillId !== 'string' || skillId.length > 100)) ||
          typeof prefix !== 'string' || prefix.length > 100) {
        throw new Error('INVALID_RESOURCE_REQUEST');
      }
      if (path === 'catalog') return describeSkillCatalog(bundle, skillId, prefix, offset);
      return readSkillResource(bundle, path, offset);
    },
  )];
  const attachedTrace = getTrace;
  if (!attachedTrace) return tools;
  tools.push(tool('probe_trace', 'Read trace bounds and recorded Perfetto capabilities.', {}, [],
    async () => (await attachedTrace()).probe));
  // Pi may request several tools in one assistant message. Keep native work
  // serial for this turn even when its tool executor starts calls concurrently.
  let nativeQueue = Promise.resolve();
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = nativeQueue.then(() => {
      signal.throwIfAborted();
      return run();
    });
    nativeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  const addExecutionTool = (mode: Exclude<RunnerMode, 'probe'>, name: string, description: string) => {
    tools.push(tool(name, description,
      {id: {type: 'string'}, parameters: {
        type: 'object',
        additionalProperties: {anyOf: [
          {type: 'string'}, {type: 'number'}, {type: 'boolean'},
          ...(mode === 'query' ? [{type: 'null'}] : []),
          {type: 'array', items: {anyOf: [{type: 'string'}, {type: 'number'}, {type: 'boolean'}]}},
        ]},
      }}, ['id'], async ({id, parameters = {}}, toolCallId) => enqueue(async () => {
        if (typeof id !== 'string' || id.length > 160 || !parameters ||
            typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length > 30) {
          throw new Error('INVALID_SKILL_PARAMETER');
        }
        await authorize();
        const trace = await attachedTrace();
        const result = await runStandardSkill(trace.runtime, trace.file, mode, id,
          parameters as Record<string, unknown>, signal);
        await authorize();
        signal.throwIfAborted();
        const evidence = mode === 'query' ? [result as Evidence] :
          (result as {evidence?: Evidence[]}).evidence ?? [];
        for (const item of evidence) {
          if (!item.queryId || !item.rows || item.status !== 'observed') continue;
          for (const row of item.rows.slice(0, 3)) {
            if (typeof row.ts !== 'string' || !isTraceTimestamp(row.ts) ||
                typeof row.dur !== 'string' || !isTraceTimestamp(row.dur)) continue;
            const start = BigInt(row.ts);
            const end = start + BigInt(row.dur);
            if (end <= start || start < BigInt(trace.probe.bounds.start_ns) ||
                end > BigInt(trace.probe.bounds.end_ns)) continue;
            if (references >= 24) break;
            references++;
            onReference({referenceId: randomUUID(), toolCallId, traceId: trace.id,
              label: item.queryId, startNs: row.ts, endNs: end.toString()});
          }
        }
        return result;
      }),
    ));
  };
  addExecutionTool('query', 'query_trace',
    'Run one standard Perfetto manifest query by SKILL/STEP. Bind its declared parameters explicitly. Use null only for a catalog-listed nullable parameter you intend to leave unset. Pass absolute ns timestamps as decimal strings.');
  addExecutionTool('skill', 'run_perfetto_skill',
    'Run a complete exported standard Perfetto Skill by Skill ID. Use declared inputs. Pass absolute ns timestamps as decimal strings.');
  return tools;
}
