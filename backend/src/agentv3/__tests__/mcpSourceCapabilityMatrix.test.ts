// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The MCP tool surface a run gets, by source selection: public trace tools,
 * which source tools a selection registers, what metadata-only and an
 * unindexed codebase can do, when graph, index and patch tools appear, and the
 * existing-only gate.
 */

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {createRunMcpServer} from '../../../tests/helpers/runMcpServerFixture';
import {CodebaseRegistry, type CodebaseRef} from '../../services/codebase/codebaseRegistry';
import {clearCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';
import type {CodeAwareMode} from '../../services/codebase/codeAwareFeature';
import type {SourceDepth} from '../../services/codebase/sourceDepthPolicy';

const scope = {tenantId: 'tenant-matrix', workspaceId: 'workspace-matrix', userId: 'user-matrix'};
const SOURCE_MARKER = 'MATRIX_SOURCE_BODY_MARKER';
const SESSION_ID = 'mcp-source-capability-matrix';

/** Tools every trace-attached run registers, whatever its source selection. */
const PUBLIC_TRACE_TOOLS = [
  'analyze_wait_chain', 'compare_baselines', 'detect_architecture', 'execute_sql', 'fetch_artifact',
  'flag_uncertainty', 'invoke_skill', 'list_skills', 'list_stdlib_modules', 'lookup_aosp_source',
  'lookup_baseline', 'lookup_blog_knowledge', 'lookup_knowledge', 'lookup_oem_sdk', 'lookup_sql_schema',
  'lookup_strategy_detail', 'query_perfetto_source', 'recall_patterns', 'recall_project_memory',
  'recall_similar_case', 'recall_similar_result', 'resolve_hypothesis', 'revise_plan', 'submit_hypothesis',
  'submit_plan', 'update_plan_phase', 'write_analysis_note',
];
/** On-demand source tools: a selected codebase reaches its live root through these. */
const ON_DEMAND_SOURCE_TOOLS = [
  'find_codebase_files', 'list_codebases', 'locate_trace_anchor', 'read_codebase_file', 'search_codebase',
];
const GRAPH_TOOLS = ['inspect_code_symbol', 'query_code_graph'];
const INDEX_TOOLS = ['lookup_app_source', 'lookup_kernel_source', 'resolve_symbol'];

let tmpDir: string;
let registry: CodebaseRegistry;
let codebaseId: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-capability-matrix-')));
  const root = path.join(tmpDir, 'app');
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'Startup.kt'), `object Startup { val marker = "${SOURCE_MARKER}" }\n`);
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  codebaseId = registry.register({
    kind: 'app_source', displayName: 'Matrix App', rootPath: root, rootAuthorization: 'native_picker',
    pathFilters: ['src'], sendToProvider: true, ...scope,
  }).codebaseId;
});

afterEach(() => {
  clearCodeAwareOutputGuards(SESSION_ID);
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

/** The same registry, with an active retrieval index reported for every codebase it holds. */
function withActiveIndex(base: CodebaseRegistry): CodebaseRegistry {
  const indexed = (ref: CodebaseRef | undefined): CodebaseRef | undefined => ref && {
    ...ref, activeIndexState: 'active', activeGeneration: 'generation-matrix',
    contentFingerprint: 'fingerprint-matrix', chunkCount: 1,
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'get') return (id: string, at?: typeof scope) => indexed(target.get(id, at));
      if (property === 'listRefs') return (at?: typeof scope) => target.listRefs(at).map(ref => indexed(ref)!);
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createRunServer(input: {
  codeAwareMode?: CodeAwareMode;
  codebaseIds?: string[];
  codebaseRegistry?: CodebaseRegistry;
  sourceDepth?: SourceDepth;
  allowNewEvidence?: boolean;
}) {
  return createRunMcpServer({
    sessionId: SESSION_ID, traceId: 'trace-matrix', knowledgeScope: scope,
    codeAwareMode: input.codeAwareMode, codebaseIds: input.codebaseIds,
    codebaseRegistry: input.codebaseRegistry ?? registry, allowNewEvidence: input.allowNewEvidence,
    ...(input.sourceDepth ? {sourceDepthDecision: {requested: input.sourceDepth, effective: input.sourceDepth,
      origin: 'requested' as const}} : {}),
  });
}

const sorted = (...groups: string[][]) => groups.flat().sort();

describe('production MCP source capability matrix', () => {
  it('registers only the public trace tools without an effective source selection', () => {
    expect(createRunServer({}).names).toEqual(sorted(PUBLIC_TRACE_TOOLS));
    // Codebase ids under an explicit off authorize nothing and read no registration.
    let reads = 0;
    const counting = new Proxy(registry, {get(target, property, receiver) {
      if (property === 'get' || property === 'listRefs') reads++;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const off = createRunServer({codeAwareMode: 'off', codebaseIds: [codebaseId], codebaseRegistry: counting});
    expect(off.names).toEqual(sorted(PUBLIC_TRACE_TOOLS));
    expect(off.sourceAuthorization.codebases).toEqual([]);
    expect(reads).toBe(0);
  });

  it('registers on-demand source tools for a selected unindexed codebase; metadata-only reads no body', async () => {
    const metadata = createRunServer({codeAwareMode: 'metadata_only', codebaseIds: [codebaseId]});
    expect(metadata.names).toEqual(sorted(PUBLIC_TRACE_TOOLS, ON_DEMAND_SOURCE_TOOLS));
    expect(metadata.sourceAuthorization.codebases).toEqual([expect.objectContaining({id: codebaseId,
      capabilities: {search: true, read_body: false, index: false, graph: false}})]);
    const located = await metadata.invoke('search_codebase', {query: SOURCE_MARKER});
    expect(located).toMatchObject({success: true});
    // A metadata-only read issues a location reference and never the body.
    const window = await metadata.invoke('read_codebase_file', {file_path: 'src/Startup.kt', start_line: 1, max_lines: 1});
    expect(JSON.stringify(window)).not.toContain(SOURCE_MARKER);
    expect(window.sourceReferences.map((reference: {lookupKind: string}) => reference.lookupKind))
      .toEqual(['metadata']);

    const provider = createRunServer({codeAwareMode: 'provider_send', codebaseIds: [codebaseId]});
    expect(provider.names).toEqual(sorted(PUBLIC_TRACE_TOOLS, ON_DEMAND_SOURCE_TOOLS));
    expect(provider.sourceAuthorization.codebases).toEqual([expect.objectContaining({id: codebaseId,
      capabilities: {search: true, read_body: true, index: false, graph: false}})]);
    const read = await provider.invoke('read_codebase_file', {file_path: 'src/Startup.kt', start_line: 1, max_lines: 1});
    expect(read).toMatchObject({success: true});
    expect(JSON.stringify(read)).toContain(SOURCE_MARKER);
  });

  it('adds graph tools only for a selected codebase with a graph', () => {
    fs.mkdirSync(path.join(tmpDir, 'app', '.gitnexus'));
    expect(createRunServer({codeAwareMode: 'provider_send', codebaseIds: [codebaseId]}).names)
      .toEqual(sorted(PUBLIC_TRACE_TOOLS, ON_DEMAND_SOURCE_TOOLS, GRAPH_TOOLS));
    expect(createRunServer({codeAwareMode: 'off', codebaseIds: [codebaseId]}).names)
      .toEqual(sorted(PUBLIC_TRACE_TOOLS));
  });

  it('adds index tools for an active index, and propose_patch only at mechanism depth', () => {
    const indexed = withActiveIndex(registry);
    expect(createRunServer({codeAwareMode: 'provider_send', codebaseIds: [codebaseId], codebaseRegistry: indexed,
      sourceDepth: 'locate'}).names).toEqual(sorted(PUBLIC_TRACE_TOOLS, ON_DEMAND_SOURCE_TOOLS, INDEX_TOOLS));
    expect(createRunServer({codeAwareMode: 'provider_send', codebaseIds: [codebaseId], codebaseRegistry: indexed,
      sourceDepth: 'mechanism'}).names)
      .toEqual(sorted(PUBLIC_TRACE_TOOLS, ON_DEMAND_SOURCE_TOOLS, INDEX_TOOLS, ['propose_patch']));
  });

  it('offers no source acquisition under existing_only', () => {
    const existingOnly = createRunServer({codeAwareMode: 'provider_send', codebaseIds: [codebaseId],
      allowNewEvidence: false});
    // Acquisition tools are withheld at the registry boundary; metadata and retained reads remain.
    expect(existingOnly.names).toEqual([
      'compare_baselines', 'fetch_artifact', 'flag_uncertainty', 'list_codebases', 'list_skills',
      'list_stdlib_modules', 'lookup_baseline', 'lookup_knowledge', 'lookup_sql_schema', 'lookup_strategy_detail',
      'recall_patterns', 'recall_project_memory', 'resolve_hypothesis', 'revise_plan', 'submit_hypothesis',
      'submit_plan', 'update_plan_phase', 'write_analysis_note',
    ]);
  });
});
