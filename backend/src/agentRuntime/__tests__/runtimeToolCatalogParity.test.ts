// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Every runtime sees the production tool catalog through its own adapter, and
 * each adapter derives the tool's name, description, input schema and
 * annotations from the registry's one shared spec. A runtime that rebuilt any
 * of them from its own source would drift from the others; this suite builds a
 * run's full catalog (trace, comparison, plan and every source tool) and checks
 * each runtime view against the shared spec in registration order.
 */

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {z} from 'zod';

import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {McpToolRegistry, type McpToolDefinition} from '../../agentv3/mcpToolRegistry';
import {dispatch as dispatchStandalone} from '../../agentv3/standaloneMcpServer';
import {CodebaseRegistry, type CodebaseRef} from '../../services/codebase/codebaseRegistry';
import {clearCodeAwareOutputGuards} from '../../services/security/codeAwareOutputRegistry';
import {createClaudeSdkMcpServer} from '../engines/claude/claudeSdkTools';
import {createOpenAIToolsFromMcpDefinitions} from '../engines/openai/openAiToolAdapter';
import {createPiAgentCoreToolFromSharedSpec} from '../engines/pi/piAgentCoreRuntime';
import {createJsonSchemaFromZodRawShape} from '../runtimeToolSpec';

const SESSION_ID = 'runtime-tool-catalog-parity';
const scope = {tenantId: 'tenant-parity', workspaceId: 'workspace-parity', userId: 'user-parity'};

let tmpDir: string;
let codebaseId: string;
let codebases: CodebaseRegistry;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-tool-catalog-')));
  const root = path.join(tmpDir, 'app');
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.mkdirSync(path.join(root, '.gitnexus'));
  fs.writeFileSync(path.join(root, 'src', 'Startup.kt'), 'object Startup {}\n');
  const registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  codebaseId = registry.register({kind: 'app_source', displayName: 'Parity App', rootPath: root,
    rootAuthorization: 'native_picker', pathFilters: ['src'], sendToProvider: true, ...scope}).codebaseId;
  // An active index for every codebase, so index and patch tools register too.
  const indexed = (ref: CodebaseRef | undefined): CodebaseRef | undefined => ref && {
    ...ref, activeIndexState: 'active', activeGeneration: 'generation-parity',
    contentFingerprint: 'fingerprint-parity', chunkCount: 1,
  };
  codebases = new Proxy(registry, {get(target, property, receiver) {
    if (property === 'get') return (id: string, at?: typeof scope) => indexed(target.get(id, at));
    if (property === 'listRefs') return (at?: typeof scope) => target.listRefs(at).map(ref => indexed(ref)!);
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
});

afterEach(() => {
  clearCodeAwareOutputGuards(SESSION_ID);
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function fullCatalog(extra: Record<string, unknown> = {}): McpToolDefinition[] {
  return createClaudeMcpServer({
    traceId: 'trace-parity', userQuery: 'fixture', sessionId: SESSION_ID, runId: 'run-parity',
    traceProcessorService: {query: async () => ({columns: [], rows: [], durationMs: 0})},
    skillExecutor: {
      execute: async () => ({skillId: 'fixture', success: true, displayResults: [], diagnostics: [], executionTimeMs: 0}),
      replaceRegisteredSkills: () => undefined, registerSkills: () => undefined, registerSkill: () => undefined,
      setFragmentRegistry: () => undefined, setRunManifestAttributionSink: () => undefined,
    },
    analysisNotes: [], hypotheses: [], uncertaintyFlags: [], watchdogWarning: {current: null},
    analysisPlan: {current: null}, artifactStore: new ArtifactStore(), knowledgeScope: scope,
    referenceTraceId: 'trace-parity-reference', comparisonContext: {referenceTraceId: 'trace-parity-reference'},
    analysisHistoryReader: {read: async () => undefined},
    codeAwareMode: 'provider_send', codebaseIds: [codebaseId], codebaseRegistry: codebases,
    sourceDepthDecision: {requested: 'mechanism', effective: 'mechanism', origin: 'requested'},
    ...extra,
  } as any).toolDefinitions;
}

const jsonSchemaOf = (definition: McpToolDefinition) => createJsonSchemaFromZodRawShape(definition.shared.inputSchema);

describe('runtime tool catalog parity', () => {
  it.each([false, true])('derives every runtime view from the shared spec with lightweight=%s', async lightweight => {
    const definitions = fullCatalog({lightweight});
    const names = definitions.map(definition => definition.name);
    // Each capability group of the fixture is present, so the views cover the whole catalog.
    expect(names).toEqual(expect.arrayContaining(['execute_sql', 'compare_skill', 'execute_sql_on',
      'get_comparison_context', 'read_session_history', 'submit_plan', 'query_code_graph', 'resolve_symbol',
      'propose_patch']));
    expect(definitions.every(definition => definition.shared.name === definition.name)).toBe(true);

    // Claude: the SDK's in-process server, built from the shared specs.
    const claude = (createClaudeSdkMcpServer(definitions) as unknown as {
      name: string; instance: {tools: Array<{name: string; description: string; inputSchema: z.ZodRawShape;
        annotations?: unknown}>};
    });
    expect(claude.name).toBe('smartperfetto');
    expect(claude.instance.tools.map(tool => tool.name)).toEqual(names);
    claude.instance.tools.forEach((tool, index) => {
      const {shared} = definitions[index];
      expect(tool.description).toBe(shared.description);
      expect(tool.inputSchema).toBe(shared.inputSchema);
      expect(tool.annotations).toBe(shared.annotations);
    });

    // OpenAI: strict function tools; the SDK owns the strict-schema conversion.
    const openAi = createOpenAIToolsFromMcpDefinitions(definitions) as unknown as Array<{
      name: string; description: string; parameters: {properties: Record<string, unknown>}; strict: boolean;
    }>;
    expect(openAi.map(tool => tool.name)).toEqual(names);
    openAi.forEach((tool, index) => {
      expect(tool.description).toBe(definitions[index].shared.description);
      expect(tool.strict).toBe(true);
      expect(Object.keys(tool.parameters.properties).sort())
        .toEqual(Object.keys(definitions[index].shared.inputSchema).sort());
    });

    // Pi Agent Core.
    const allowed = new Set(names);
    definitions.forEach(definition => {
      const pi = createPiAgentCoreToolFromSharedSpec(definition.shared, {allowedToolNames: allowed});
      expect(pi).toMatchObject({name: definition.name, description: definition.shared.description,
        parameters: jsonSchemaOf(definition)});
    });

    // The standalone stdio server lists the shared schema of its public tools.
    const listed = (response: unknown) => (response as {result: {tools: Array<{name: string; description: string;
      inputSchema: unknown}>}}).result.tools;
    const expectedListing = (defs: McpToolDefinition[]) => defs.map(definition => ({name: definition.name,
      description: definition.summary || definition.shared.description, inputSchema: jsonSchemaOf(definition)}));
    const standalone = new McpToolRegistry();
    for (const definition of definitions) standalone.registerShared(definition.shared);
    const publicDefinitions = standalone.list().filter(definition => definition.exposure === 'public');
    expect(listed(await dispatchStandalone(standalone, {jsonrpc: '2.0', id: 1, method: 'tools/list'})))
      .toEqual(expectedListing(publicDefinitions));
  });
});
