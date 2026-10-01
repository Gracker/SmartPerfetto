#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * SmartPerfetto standalone MCP server (Plan 41 M1).
 *
 * Reads JSON-RPC 2.0 requests from stdin, dispatches them against
 * a `McpToolRegistry` filtered to public-exposure tools, writes
 * responses to stdout. The protocol is line-delimited JSON.
 *
 * Usage:
 *   smartperfetto-mcp                # serve stdio
 *
 * The set of tools exposed here is the subset that does NOT need
 * a live agent session:
 *   - lookup_blog_knowledge / lookup_aosp_source / lookup_oem_sdk
 *     (RagStore-backed — pure file IO)
 *   - lookup_baseline / compare_baselines (BaselineStore — file IO)
 *   - recall_project_memory (ProjectMemory — file IO, pure-read)
 *   - recall_similar_case (CaseLibrary — file IO)
 *
 * Tools that require a live trace_processor / skill executor (e.g.
 * execute_sql, invoke_skill) are NOT registered in stdio mode
 * because external hosts cannot drive a trace analysis through a
 * line-delimited JSON-RPC channel. Plan 41 M2 may add a separate
 * "session attach" path for that use case.
 *
 * Internal session-protocol tools (submit_plan,
 * write_analysis_note, etc.) stay hidden because writing to a
 * SmartPerfetto session from an external host would corrupt
 * agent state.
 */

import {tool} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';
import * as path from 'path';

import {McpToolRegistry} from '../src/agentv3/mcpToolRegistry';
import {
  LineDelimitedJsonSink,
  LineDelimitedJsonSource,
  runStdioLoop,
} from '../src/agentv3/standaloneMcpServer';
import {RagStore} from '../src/services/ragStore';
import {
  BaselineStore,
  deriveBaselineId,
} from '../src/services/baselineStore';
import {
  computeBaselineDiff,
  evaluateRegressionGate,
  type RegressionRule,
} from '../src/services/baselineDiffer';
import {ProjectMemory} from '../src/agentv3/projectMemory';
import {CaseLibrary} from '../src/services/caseLibrary';
import {recallCasesByTags} from '../src/services/caseEvolution/caseTagRecall';

const LOGS_DIR = path.resolve(__dirname, '../logs');
const RAG_PATH = path.join(LOGS_DIR, 'rag_store.json');
const BASELINE_PATH = path.join(LOGS_DIR, 'baselines.json');
const MEMORY_PATH = path.join(LOGS_DIR, 'analysis_project_memory.json');
const CASE_PATH = path.join(LOGS_DIR, 'case_library.json');

function buildRegistry(): McpToolRegistry {
  const ragStore = new RagStore(RAG_PATH);
  const baselineStore = new BaselineStore(BASELINE_PATH);
  const projectMemory = new ProjectMemory(MEMORY_PATH);
  const caseLibrary = new CaseLibrary(CASE_PATH);

  const registry = new McpToolRegistry();

  // ------- Knowledge retrieval (3 RAG sources) -------

  registry.registerSdk(
    tool(
      'lookup_blog_knowledge',
      'Retrieve indexed knowledge chunks from androidperformance.com.',
      {query: z.string(), top_k: z.number().int().min(1).max(20).optional()},
      async ({query, top_k}) => {
        const result = ragStore.search(query, {
          topK: top_k ?? 5,
          kinds: ['androidperformance.com'],
        });
        return {content: [{type: 'text' as const, text: JSON.stringify(result)}]};
      },
      {annotations: {readOnlyHint: true}},
    ),
    'lookup_blog_knowledge',
    'public',
    {summary: 'Retrieve indexed blog knowledge chunks (androidperformance.com).'},
  );

  registry.registerSdk(
    tool(
      'lookup_aosp_source',
      'Retrieve indexed AOSP source chunks.',
      {query: z.string(), top_k: z.number().int().min(1).max(20).optional()},
      async ({query, top_k}) => {
        const result = ragStore.search(query, {
          topK: top_k ?? 5,
          kinds: ['aosp'],
        });
        return {content: [{type: 'text' as const, text: JSON.stringify(result)}]};
      },
      {annotations: {readOnlyHint: true}},
    ),
    'lookup_aosp_source',
    'public',
    {summary: 'Retrieve indexed AOSP source chunks.'},
  );

  registry.registerSdk(
    tool(
      'lookup_oem_sdk',
      'Retrieve indexed OEM SDK / tuning documentation chunks.',
      {query: z.string(), top_k: z.number().int().min(1).max(20).optional()},
      async ({query, top_k}) => {
        const result = ragStore.search(query, {
          topK: top_k ?? 5,
          kinds: ['oem_sdk'],
        });
        return {content: [{type: 'text' as const, text: JSON.stringify(result)}]};
      },
      {annotations: {readOnlyHint: true}},
    ),
    'lookup_oem_sdk',
    'public',
    {summary: 'Retrieve indexed OEM SDK / tuning documentation chunks.'},
  );

  // ------- Baseline lookup + compare -------

  registry.registerSdk(
    tool(
      'lookup_baseline',
      'Fetch a stored baseline by canonical id or composite key.',
      {
        baseline_id: z.string().optional(),
        app_id: z.string().optional(),
        device_id: z.string().optional(),
        build_id: z.string().optional(),
        cuj: z.string().optional(),
      },
      async ({baseline_id, app_id, device_id, build_id, cuj}) => {
        let id = baseline_id;
        if (!id) {
          if (app_id && device_id && build_id && cuj) {
            id = deriveBaselineId({
              appId: app_id,
              deviceId: device_id,
              buildId: build_id,
              cuj,
            });
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: 'Provide baseline_id or all four key components.',
                  }),
                },
              ],
              isError: true,
            };
          }
        }
        const baseline = baselineStore.getBaseline(id);
        // Codex round E P1#3: standalone (public stdio) host must NOT
        // surface draft / reviewed / private baselines. Only published
        // records are considered safe for external consumers.
        if (baseline && baseline.status !== 'published') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Baseline '${id}' is not published (external hosts see published baselines only)`,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: baseline
                ? JSON.stringify({success: true, baseline})
                : JSON.stringify({
                    success: false,
                    error: `Baseline '${id}' not found`,
                  }),
            },
          ],
        };
      },
      {annotations: {readOnlyHint: true}},
    ),
    'lookup_baseline',
    'public',
    {summary: 'Fetch a stored App/Device/Build/CUJ baseline.'},
  );

  registry.registerSdk(
    tool(
      'compare_baselines',
      'Diff two stored baselines and optionally evaluate a regression gate.',
      {
        base_baseline_id: z.string(),
        candidate_baseline_id: z.string(),
        rules: z
          .array(
            z.object({
              metric_id: z.string(),
              threshold: z.number(),
              expect_increase: z.boolean().optional(),
            }),
          )
          .optional(),
        gate_id: z.string().optional(),
      },
      async ({base_baseline_id, candidate_baseline_id, rules, gate_id}) => {
        const base = baselineStore.getBaseline(base_baseline_id);
        const candidate = baselineStore.getBaseline(candidate_baseline_id);
        if (!base || !candidate) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: !base
                    ? `Base baseline '${base_baseline_id}' not found`
                    : `Candidate baseline '${candidate_baseline_id}' not found`,
                }),
              },
            ],
          };
        }
        // Codex round E P1#3: standalone path only diffs PUBLISHED
        // baselines. A draft / reviewed / private record is not
        // considered safe for external consumers.
        if (base.status !== 'published' || candidate.status !== 'published') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: 'Both baselines must be published; external hosts see published baselines only',
                }),
              },
            ],
          };
        }
        const diff = computeBaselineDiff(base, candidate);
        let gate;
        if (rules && rules.length > 0) {
          if (!gate_id) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: '`gate_id` required when `rules` is supplied.',
                  }),
                },
              ],
              isError: true,
            };
          }
          const mapped: RegressionRule[] = rules.map(r => ({
            metricId: r.metric_id,
            threshold: r.threshold,
            ...(r.expect_increase !== undefined
              ? {expectIncrease: r.expect_increase}
              : {}),
          }));
          gate = evaluateRegressionGate(base_baseline_id, diff, mapped, {
            gateId: gate_id,
          });
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({success: true, diff, ...(gate ? {gate} : {})}),
            },
          ],
        };
      },
      {annotations: {readOnlyHint: true}},
    ),
    'compare_baselines',
    'public',
    {summary: 'Diff two stored baselines and optionally evaluate a regression gate.'},
  );

  // ------- Memory + case recall -------

  registry.registerSdk(
    tool(
      'recall_project_memory',
      'Recall project- or world-scope memory entries by tag overlap.',
      {
        tags: z.array(z.string()).optional(),
        project_key: z.string().optional(),
        scope: z.enum(['project', 'world']).optional(),
        top_k: z.number().int().min(1).max(20).optional(),
      },
      async ({tags, project_key, scope, top_k}) => {
        const hits = projectMemory.recallProjectMemory({
          tags,
          projectKey: project_key,
          scope,
          topK: top_k ?? 5,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({success: true, hits, count: hits.length}),
            },
          ],
        };
      },
      {annotations: {readOnlyHint: true}},
    ),
    'recall_project_memory',
    'public',
    {summary: 'Recall project / world memory entries (read-only).'},
  );

  registry.registerSdk(
    tool(
      'recall_similar_case',
      'Recall published cases that share tags / key with the current trace.',
      {
        tags: z.array(z.string()).optional(),
        app_id: z.string().optional(),
        device_id: z.string().optional(),
        cuj: z.string().optional(),
        include_unpublished: z.boolean().optional(),
        top_k: z.number().int().min(1).max(20).optional(),
      },
      async ({tags, app_id, device_id, cuj, include_unpublished, top_k}) => {
        const hits = recallCasesByTags(caseLibrary, {
          tags,
          appId: app_id,
          deviceId: device_id,
          cuj,
          includeReviewed: include_unpublished,
          topK: top_k,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({success: true, hits, count: hits.length}),
            },
          ],
        };
      },
      {annotations: {readOnlyHint: true}},
    ),
    'recall_similar_case',
    'public',
    {summary: 'Recall similar cases from the case library (read-only).'},
  );

  return registry;
}

async function main(): Promise<void> {
  const registry = buildRegistry();
  const source = new LineDelimitedJsonSource(process.stdin);
  const sink = new LineDelimitedJsonSink(process.stdout);
  await runStdioLoop(registry, source, sink);
}

main().catch(err => {
  // Last-resort error reporting — write to stderr so the host can
  // surface the failure instead of seeing a silently dead pipe.
  process.stderr.write(
    `[smartperfetto-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
