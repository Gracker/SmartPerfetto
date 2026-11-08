// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import * as runtimeToolSpec from '../runtimeToolSpec';
import {projectRuntimeToolEventPayload} from '../../services/security/runtimeToolEventProjection';
import {withRuntimeToolObserver, type RuntimeToolInvocationEvent} from '../runtimeToolObserver';
import {
  RUNTIME_TOOL_DESCRIPTION_MAX_CHARS,
  compactRuntimeToolDescription,
  createJsonSchemaFromZodRawShape,
  deduplicateNullableSchemaDescriptions,
  defineRuntimeTool,
  normalizeRuntimeToolArgs,
  preserveRuntimeLiteralStrings,
  sharedToolSpecFromRuntimeToolDefinition,
  stringifyRuntimeToolResult,
  withRuntimeToolConcurrency,
  withRuntimeToolTiming,
  type RuntimeToolDefinition,
  type SharedToolSpec,
} from '../runtimeToolSpec';
import {createClaudeSdkToolFromSharedSpec} from '../engines/claude/claudeSdkTools';

describe('nullable schema annotation projection', () => {
  it('preserves opted-in literal text without changing nullable omission or ordinary selector coercion', () => {
    const literal = preserveRuntimeLiteralStrings(z.string().optional().describe('Literal body text'));
    const shape = {literal, selector: z.string().optional()};
    for (const text of ['None', 'null', 'undefined']) {
      expect(normalizeRuntimeToolArgs({literal: text, selector: text}, shape)).toEqual({literal: text});
    }
    expect(normalizeRuntimeToolArgs({literal: null, selector: null}, shape)).toEqual({});
    expect(normalizeRuntimeToolArgs({}, shape)).toEqual({});
    expect(createJsonSchemaFromZodRawShape(shape)).toEqual(createJsonSchemaFromZodRawShape({
      literal: z.string().optional().describe('Literal body text'), selector: z.string().optional(),
    }));
  });
  it('deduplicates only identical annotations in schema positions without mutating instance data', () => {
    const nullable = {description: '同一个字段', anyOf: [{type: 'string', description: '同一个字段'}, {type: 'null'}]};
    const instance = {description: 'instance', anyOf: [{description: 'instance', type: 'string'}, {type: 'null'}]};
    const schema = {type: 'object', properties: {value: nullable}, $defs: {value: nullable},
      const: instance, enum: [instance], default: instance, examples: [instance],
      unknownExtension: instance};
    const before = JSON.stringify(schema);
    const result = deduplicateNullableSchemaDescriptions(schema);
    expect(result.properties.value).toEqual({description: '同一个字段', anyOf: [{type: 'string'}, {type: 'null'}]});
    expect(result.$defs.value).toEqual(result.properties.value);
    for (const key of ['const', 'enum', 'default', 'examples', 'unknownExtension'] as const) expect(result[key]).toBe(schema[key]);
    expect(JSON.stringify(schema)).toBe(before);
    expect(deduplicateNullableSchemaDescriptions(result)).toEqual(result);
  });

  it('preserves distinct branch descriptions, validation keywords and nonnullable unions', () => {
    const schema = {type: 'object', required: ['value'], additionalProperties: false, properties: {
      value: {description: 'whole field', anyOf: [{type: 'string', description: 'string constraint', pattern: '^x'}, {type: 'null'}]},
      union: {description: 'same', anyOf: [{type: 'string', description: 'same'}, {type: 'number'}]},
    }};
    expect(deduplicateNullableSchemaDescriptions(schema)).toEqual(schema);
  });
});
import {createRuntimeToolConcurrencyCoordinator} from '../runtimeToolConcurrency';
import {createOpenAIToolsFromMcpDefinitions} from '../engines/openai/openAiToolAdapter';
import {createPiAgentCoreToolFromSharedSpec} from '../engines/pi/piAgentCoreRuntime';
import {createRuntimePerformanceRecorder, createRuntimePerformanceRun, startRuntimeModelCall} from '../runtimePerformance';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {resolveRuntimePerformanceRecorder} from '../runtimePerformanceContext';
import {McpToolRegistry} from '../../agentv3/mcpToolRegistry';
import {SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV} from '../runtimeCandidateAdmission';
import {
  RunManifestLifecycle,
  currentRuntimePerformanceRecorder,
  withRunManifestLifecycle,
} from '../../services/selfEvolution/runManifestLifecycle';
import type {RunManifestStore} from '../../services/selfEvolution/runManifestStore';
import {
  createRuntimeToolResult,
  decodeRuntimeToolResult,
  readRuntimeToolResultFacts,
} from '../runtimeToolResult';

function toolDefinition(name: string) {
  return {
    name,
    description: `${name} description`,
    inputSchema: {
      q: z.string(),
      params: z.record(z.string(), z.any()).optional().describe('Optional params'),
    },
    annotations: { readOnlyHint: true },
    handler: jest.fn(async (args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
    })),
  };
}

function createLifecycle(runId: string): RunManifestLifecycle {
  const store = {
    append: jest.fn(),
    pin: jest.fn(),
    unpin: jest.fn(),
  } as unknown as RunManifestStore;
  return new RunManifestLifecycle({
    runId,
    sessionId: `session-${runId}`,
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    runtime: 'pi-agent-core',
    providerId: null,
    outputLanguage: 'en',
    analysisMode: 'auto',
    skillRegistry: {
      registryFingerprint: 'registry-a',
      skills: [],
    },
    store,
  });
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return {promise, resolve, reject};
}

describe('SharedToolSpec', () => {
  it('projects only the final role before observers without changing private arguments or outcomes', async () => {
    const params = {documentJson: 'SQL source body private-hash canary'};
    const extra = {privateHash: 'private-extra-canary', toolCallId: 'actual-call'};
    const result = createRuntimeToolResult({body: 'private-result-canary', success: false},
      {facts: {success: true, planPhaseId: 'private-phase-canary'}});
    const failure = new Error('private-error-canary');
    const body = jest.fn(async (_args: Record<string, unknown>, _extra: unknown) => result)
      .mockResolvedValueOnce(result).mockRejectedValueOnce(failure);
    const events: RuntimeToolInvocationEvent[] = [];
    const spec = withRuntimeToolObserver({name: 'native-final', role: 'final_candidate_submission',
      exposure: 'internal', evidenceEffect: 'none', description: 'Final', inputSchema: {}, handler: body},
    event => { events.push(event); });
    await expect(spec.handler(params, extra)).resolves.toBe(result);
    await expect(spec.handler(params, extra)).rejects.toBe(failure);
    expect(body.mock.calls[0][0]).toBe(params);
    expect(body.mock.calls[0][1]).toEqual(extra);
    expect(params.documentJson).toContain('SQL source body');
    expect(events.map(event => event.phase)).toEqual(['started', 'completed', 'started', 'failed']);
    expect(events[0]).toMatchObject({toolCallId: 'actual-call', toolName: 'native-final',
      role: 'final_candidate_submission', params: {kind: 'authored_final_submission', status: 'pending'}, extra: {}});
    const completed = events[1];
    expect(completed.phase).toBe('completed');
    if (completed.phase === 'completed') {
      expect(readRuntimeToolResultFacts(completed.result)).toEqual({success: true});
      expect(completed.result.structuredContent).toEqual({kind: 'authored_final_submission', status: 'pending'});
    }
    expect(events[3]).toMatchObject({error: {kind: 'authored_final_submission', status: 'rejected',
      reason: 'submission_rejected'}});
    expect(JSON.stringify(events)).not.toMatch(/canary|SQL source body|documentJson|planPhaseId/);
    expect(result.structuredContent).toMatchObject({body: 'private-result-canary'});
    const ordinary = {params, extra, result, error: failure};
    expect(projectRuntimeToolEventPayload(undefined, ordinary)).toBe(ordinary);
    expect(readRuntimeToolResultFacts(ordinary.result)).toEqual({success: true, planPhaseId: 'private-phase-canary'});
    const pending = projectRuntimeToolEventPayload('final_candidate_submission', {
      result: createRuntimeToolResult({status: 'pending'}, {facts: {planPhaseId: 'private-phase-canary'}}),
    });
    expect(readRuntimeToolResultFacts(pending.result)).toEqual({});
    expect(JSON.stringify(pending)).not.toMatch(/canary|planPhaseId/);
    const rejected = projectRuntimeToolEventPayload('final_candidate_submission', {
      result: createRuntimeToolResult({privateDocument: 'private-result-canary'}, {facts: {success: false}}),
    });
    expect(rejected.result.structuredContent).toEqual({kind: 'authored_final_submission', status: 'rejected',
      reason: 'submission_rejected'});
    expect(readRuntimeToolResultFacts(rejected.result)).toEqual({success: false});
  });

  it('records bounded final-tool activity without using the private document as repeat-key input', async () => {
    const lifecycle = createLifecycle('final-tool-activity');
    const recorder = lifecycle.builder.runtimePerformanceRecorder;
    const activity = jest.spyOn(recorder, 'startToolActivity');
    const args = {documentJson: 'private-repeat-key-canary'};
    const body = jest.fn(async () => createRuntimeToolResult({kind: 'authored_final_submission', status: 'pending'}));
    const shared = withRuntimeToolConcurrency({name: 'native-final', role: 'final_candidate_submission',
      description: 'Final', exposure: 'internal', evidenceEffect: 'none', inputSchema: {}, handler: body},
    createRuntimeToolConcurrencyCoordinator(), {runManifestAttributionSink: lifecycle.builder});
    try {
      await shared.handler(args, {});
      await shared.handler({documentJson: 'different-private-document'}, {});
      expect(activity).toHaveBeenCalledWith('native-final', {kind: 'authored_final_submission', status: 'pending'});
      const receipt = recorder.seal();
      expect(JSON.stringify(receipt)).not.toMatch(/private-repeat-key-canary|different-private-document/);
      expect(receipt.activity).toMatchObject({observation: 'partial', attempted: 2, dispatched: 2, returned: 2});
      expect(receipt.activity).not.toHaveProperty('repeatedExactCalls');
      expect(body).toHaveBeenCalledTimes(2);
      expect(args.documentJson).toBe('private-repeat-key-canary');
    } finally { activity.mockRestore(); lifecycle.dispose(); }
  });

  it('keeps producer facts through SDK adaptation and string transport before shortening', async () => {
    const spec = sharedToolSpecFromRuntimeToolDefinition('execute_sql', {
      name: 'execute_sql', description: 'Read trace data', inputSchema: {},
      handler: async () => createRuntimeToolResult({success: false, planPhaseId: 'phase-1', error: 'x'.repeat(14000)}, {
        decorate: text => '[accuracy] {"success":true}\n' + text + '\nReview this evidence.',
      }),
    }, 'public');
    const claude = createClaudeSdkToolFromSharedSpec(spec);
    const result = await claude.handler({}, {} as any);
    expect(readRuntimeToolResultFacts(result)).toEqual({success: false, planPhaseId: 'phase-1'});
    const transport = stringifyRuntimeToolResult(result);
    expect(readRuntimeToolResultFacts(transport)).toEqual(readRuntimeToolResultFacts(result));
    const shortened = {...result, content: [{type: 'text', text: 'truncated'}]};
    expect(readRuntimeToolResultFacts(shortened)).toEqual(readRuntimeToolResultFacts(result));
  });

  it('normalizes known legacy outcomes but does not infer success from a normal return', async () => {
    const spec = withRuntimeToolTiming({
      name: 'test_tool', description: 'Test', exposure: 'public', inputSchema: {},
      handler: async () => ({content: [{type: 'text' as const, text: '{"outcome":"consent_blocked"}'}]}),
    });
    expect(readRuntimeToolResultFacts(await spec.handler({}, {}))).toEqual({success: false});
    expect(readRuntimeToolResultFacts({content: [{type: 'text', text: 'A normal result.'}]})).toEqual({});
  });

  it('decodes catalogue arrays, separate guidance blocks, and Pi details without guessing ambiguous JSON', () => {
    expect(decodeRuntimeToolResult('[{"id":"skill-a"}]').body).toEqual({items: [{id: 'skill-a'}]});
    const raw = createRuntimeToolResult({success: true, planPhaseId: 'p1', rows: []});
    expect(decodeRuntimeToolResult({content: [{type: 'text', text: 'truncated'}], details: raw}).body)
      .toEqual(raw.structuredContent);
    expect(readRuntimeToolResultFacts({content: [
      {type: 'text', text: '[note] Guidance'}, {type: 'text', text: '{"success":true}'},
    ]})).toEqual({success: true});
    expect(readRuntimeToolResultFacts({content: [
      {type: 'text', text: '{"success":false}'}, {type: 'text', text: '{"success":true}'},
    ]})).toEqual({});
  });
  it('is registered exactly once in the live backend test gate', () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../package.json'),
      'utf8',
    )) as {scripts: Record<string, string>};
    const suite = 'src/agentRuntime/__tests__/runtimeToolSpec.test.ts';

    expect(packageJson.scripts['test:gate'].match(/npm run test:runtime-registry/g) ?? [])
      .toHaveLength(1);
    expect(packageJson.scripts['test:runtime-registry'].match(new RegExp(suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? [])
      .toHaveLength(1);
  });

  it('caps every provider-facing tool description at 1000 characters', () => {
    const description = `Use when: ${'bounded runtime contract '.repeat(60)}`;
    const compacted = compactRuntimeToolDescription(description);

    expect(RUNTIME_TOOL_DESCRIPTION_MAX_CHARS).toBe(1000);
    expect(compacted.length).toBeLessThanOrEqual(1000);
    expect(compacted).toContain('Use when:');
  });

  it('keeps complete head and tail sentences while dropping an oversized important middle', () => {
    const description = [
      'Use when: The first complete sentence establishes the contract.',
      ...Array.from({length: 12}, (_, index) => (
        `Middle sentence ${index} carries deliberately repetitive detail that can be omitted safely.`
      )),
      'The final complete sentence preserves the terminal safety boundary.',
    ].join(' ');

    const compacted = compactRuntimeToolDescription(description);

    expect(compacted.length).toBeLessThanOrEqual(RUNTIME_TOOL_DESCRIPTION_MAX_CHARS);
    expect(compacted).toContain('Use when: The first complete sentence establishes the contract.');
    expect(compacted).toContain('The final complete sentence preserves the terminal safety boundary.');
    expect(compacted).not.toContain('Middle sentence 6');
  });

  it('keeps short descriptions byte-identical', () => {
    const description = 'Short description with two sentences. Nothing needs compaction.';
    expect(compactRuntimeToolDescription(description)).toBe(description);
  });

  it('does not split an identifier dot while preserving head and tail sentences', () => {
    const description = [
      'Use when: Read actual_frame_timeline_slice.upid before joining process.',
      ...Array.from({length: 14}, (_, index) => (
        `Middle identifier detail ${index} is intentionally repetitive and removable.`
      )),
      'The final sentence remains complete after compaction.',
    ].join(' ');

    const compacted = compactRuntimeToolDescription(description);

    expect(compacted).toContain('actual_frame_timeline_slice.upid');
    expect(compacted).toContain('The final sentence remains complete after compaction.');
    expect(compacted).not.toContain('actual_frame_timeline_slice. upid');
  });

  it('keeps SQL safety head and tail sentences within its 500-character category budget', () => {
    const sqlSafetyParagraph = [
      'SQL safety rules: use s.name AS slice_name and qualified aliases so every joined column keeps an explicit owner.',
      'FrameTimeline rows expose upid and require a process join before process_name can be treated as verified identity.',
      ...Array.from({length: 6}, (_, index) => (
        `Middle self-time detail ${index} is deliberately repetitive and removable under pressure.`
      )),
      'The main-thread column is is_main_thread and must remain explicit in the compact contract.',
      'Use fetch_artifact for batch_frame_root_cause rows because skill artifacts are never SQL tables.',
    ].join(' ');
    const description = [
      `Run SQL safely. ${'Introductory detail remains bounded. '.repeat(12)}`,
      sqlSafetyParagraph,
      `Additional paragraph. ${'Low priority context. '.repeat(30)}`,
    ].join('\n\n');

    const compacted = compactRuntimeToolDescription(description);
    const sqlParagraph = compacted
      .split('\n')
      .find(paragraph => paragraph.startsWith('SQL safety rules:')) ?? '';

    expect(sqlParagraph.length).toBeLessThanOrEqual(500);
    expect(sqlParagraph).toContain('s.name AS slice_name');
    expect(sqlParagraph).toContain('FrameTimeline rows expose upid');
    expect(sqlParagraph).toContain('is_main_thread');
    expect(sqlParagraph).toContain('batch_frame_root_cause');
    expect(sqlParagraph).toContain('…');
    expect(sqlParagraph).not.toContain('Middle self-time detail 3');
    expect(sqlParagraph.indexOf('FrameTimeline')).toBeLessThan(sqlParagraph.indexOf('is_main_thread'));
  });

  it('builds a shared tool body from a tool definition', async () => {
    const existing = toolDefinition('invoke_skill');
    const shared = sharedToolSpecFromRuntimeToolDefinition(
      'invoke_skill',
      existing,
      'public',
      { summary: 'Invoke a skill', requires: ['traceProcessor'] },
    );

    expect(shared).toMatchObject({
      name: 'invoke_skill',
      description: 'invoke_skill description',
      exposure: 'public',
      summary: 'Invoke a skill',
      requires: ['traceProcessor'],
      annotations: { readOnlyHint: true },
    });
    await shared.handler({ q: 'hello' }, {});
    expect(existing.handler).toHaveBeenCalledWith({ q: 'hello' }, {});
  });

  it('defines a tool body whose handler and annotations reach the shared spec unchanged', async () => {
    const handler = jest.fn(async (args: {q: string}, _extra: unknown) => ({
      content: [{type: 'text' as const, text: args.q}],
    }));
    const inputSchema = {q: z.string()};
    const definition = defineRuntimeTool('lookup', 'Look up', inputSchema, handler, {annotations: {readOnlyHint: true}});
    expect(definition).toEqual({name: 'lookup', description: 'Look up', inputSchema, handler,
      annotations: {readOnlyHint: true}});
    expect(defineRuntimeTool('bare', 'Bare', inputSchema, handler).annotations).toBeUndefined();

    const shared = sharedToolSpecFromRuntimeToolDefinition('lookup', definition, 'public');
    expect(shared).toMatchObject({name: 'lookup', description: 'Look up', exposure: 'public',
      annotations: {readOnlyHint: true}});
    expect(shared.inputSchema).toBe(inputSchema);
    await shared.handler({q: 'select 1'}, {});
    expect(handler).toHaveBeenCalledWith({q: 'select 1'}, {});
  });

  it('builds a Claude SDK-native descriptor from a shared spec', async () => {
    const existing = toolDefinition('execute_sql');
    const shared = sharedToolSpecFromRuntimeToolDefinition('execute_sql', existing, 'public');
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    expect(claude.name).toBe('execute_sql');
    expect(claude.description).toBe('execute_sql description');
    expect(claude.inputSchema).toBe(shared.inputSchema);
    expect(claude.annotations).toEqual({ readOnlyHint: true });

    const result = await claude.handler({ q: 'select 1' } as any, {});
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"q":"select 1"}',
    });
  });

  it('records shared production tool wrapper duration and outcome', async () => {
    const lifecycle = createLifecycle('run-shared-tool-success');
    const handler = jest.fn(async () => {
      return {content: [{type: 'text' as const, text: 'ok'}]};
    });
    const shared: SharedToolSpec = {
      name: 'timed_tool',
      description: 'Timed tool',
      exposure: 'public',
      inputSchema: {},
      handler,
    };
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    await withRunManifestLifecycle(lifecycle, () =>
      claude.handler({}, {toolCallId: 'raw-tool-call-id'} as any));

    const receipt = lifecycle.builder.runtimePerformanceRecorder.seal();

    expect(receipt.tools).toEqual([
      expect.objectContaining({
        mode: 'exclusive',
        schedulerWaitMs: 0,
        durationMs: expect.any(Number),
        outcome: 'ok',
        toolCallIdHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain('raw-tool-call-id');
    lifecycle.dispose();
  });

  it('records shared production tool wrapper normal isError results as errors', async () => {
    const lifecycle = createLifecycle('run-shared-tool-normal-error');
    const shared: SharedToolSpec = {
      name: 'normal_error_tool',
      description: 'Normal tool result carrying isError',
      exposure: 'public',
      inputSchema: {},
      handler: jest.fn(async () => ({
        isError: true,
        content: [{type: 'text' as const, text: 'recoverable failure'}],
      })),
    };
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    await expect(withRunManifestLifecycle(lifecycle, () =>
      claude.handler({}, {toolCallId: 'raw-normal-error-tool-id'} as any)))
      .resolves.toMatchObject({isError: true});

    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({
        mode: 'exclusive',
        schedulerWaitMs: 0,
        durationMs: expect.any(Number),
        outcome: 'error',
      }),
    ]);
    lifecycle.dispose();
  });

  it('records direct shared handler timing from the active RunManifest context without adapter extras', async () => {
    const lifecycle = createLifecycle('run-direct-shared-tool');
    const existing = toolDefinition('direct_shared_tool');
    existing.handler.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return {content: [{type: 'text' as const, text: 'ok'}]};
    });
    const shared = sharedToolSpecFromRuntimeToolDefinition('direct_shared_tool', existing, 'public');

    await withRunManifestLifecycle(lifecycle, () => shared.handler({}, {}));

    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({
        mode: 'exclusive',
        schedulerWaitMs: 0,
        durationMs: expect.any(Number),
        outcome: 'ok',
        toolCallIdHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools[0].durationMs)
      .toBeGreaterThanOrEqual(0);
    lifecycle.dispose();
  });

  it('records adapter tool timing with a recorder-generated fallback id when toolCallId is absent', async () => {
    const lifecycle = createLifecycle('run-adapter-fallback-tool');
    const existing = toolDefinition('adapter_shared_tool');
    const shared = sharedToolSpecFromRuntimeToolDefinition('adapter_shared_tool', existing, 'public');
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    await withRunManifestLifecycle(lifecycle, () => claude.handler({}, {}));

    const receipt = lifecycle.builder.runtimePerformanceRecorder.seal();
    expect(receipt.tools).toHaveLength(1);
    expect(receipt.tools[0]).toEqual(expect.objectContaining({
      mode: 'exclusive',
      schedulerWaitMs: 0,
      outcome: 'ok',
      toolCallIdHash: expect.stringMatching(/^sha256:/),
    }));
    expect(JSON.stringify(receipt)).not.toContain('adapter_shared_tool');
    lifecycle.dispose();
  });

  it('records scheduler wait and effective commutative-read mode from the concurrency coordinator', async () => {
    let now = 100;
    const coordinator = createRuntimeToolConcurrencyCoordinator({
      now: () => now,
      env: {[SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: 'task5'},
    });
    const lifecycle = createLifecycle('run-scheduled-safe-read-tool');
    const releaseWriter = createDeferred<void>();
    const writer = withRuntimeToolConcurrency({
      name: 'execute_sql',
      description: 'Writer',
      exposure: 'public',
      inputSchema: {},
      handler: jest.fn(async () => {
        await releaseWriter.promise;
        return {content: [{type: 'text' as const, text: 'writer'}]};
      }),
    }, coordinator);
    const reader = withRuntimeToolConcurrency({
      name: 'lookup_sql_schema',
      description: 'Safe reader',
      exposure: 'public',
      inputSchema: {},
      concurrency: {mode: 'commutative_read'},
      handler: jest.fn(async () => ({content: [{type: 'text' as const, text: 'reader'}]})),
    }, coordinator);

    const writerRun = writer.handler({}, {});
    await Promise.resolve();

    const readerRun = withRunManifestLifecycle(lifecycle, () =>
      reader.handler({}, {toolCallId: 'raw-safe-read-id'}));
    await Promise.resolve();
    now = 137;
    releaseWriter.resolve();

    await expect(writerRun).resolves.toBeDefined();
    await expect(readerRun).resolves.toBeDefined();

    const receipt = lifecycle.builder.runtimePerformanceRecorder.seal();
    expect(receipt.tools).toEqual([
      expect.objectContaining({
        mode: 'commutative_read',
        schedulerWaitMs: 37,
        outcome: 'ok',
        toolCallIdHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(JSON.stringify(receipt)).not.toContain('raw-safe-read-id');
    lifecycle.dispose();
  });

  it('keeps request-bound attribution while suppressing conflicting per-call observations', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator();
    const boundLifecycle = createLifecycle('run-bound-tool-sink');
    const staleLifecycle = createLifecycle('run-stale-tool-sink');
    const shared = withRuntimeToolConcurrency({
      name: 'lookup_sql_schema',
      description: 'Safe read with bound sink',
      exposure: 'public',
      inputSchema: {},
      concurrency: {mode: 'commutative_read'},
      handler: jest.fn(async (_args: Record<string, unknown>, extra: any) => ({
        content: [{
          type: 'text' as const,
          text: extra.runManifestAttributionSink?.identity.runId ?? 'missing-run',
        }],
      })),
    }, coordinator, {runManifestAttributionSink: boundLifecycle.builder});

    const result = await shared.handler({}, {
      toolCallId: 'raw-stale-tool-id',
      runManifestAttributionSink: staleLifecycle.builder,
    });

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'run-bound-tool-sink',
    });
    expect(boundLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    expect(boundLifecycle.builder.runtimePerformanceRecorder.activitySnapshot().observation).toBe('partial');
    expect(staleLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    boundLifecycle.dispose();
    staleLifecycle.dispose();
  });

  it.each([['a', 'b'], ['b', 'a']])(
    'suppresses downstream capture/model observations for bound %s under foreign ambient %s', async (owner, other) => {
      const bound = createLifecycle(`bound-${owner}`);
      const foreign = createLifecycle(`ambient-${other}`);
      const foreignRecorder = foreign.builder.runtimePerformanceRecorder;
      const foreignBefore = foreignRecorder.activitySnapshot();
      const store = new ArtifactStore();
      let nested!: SharedToolSpec;
      const downstream = () => {
        const data = {columns: ['value'], rows: [[7]]};
        const id = store.store({skillId: 'execute_sql', data, title: 'Captured'});
        expect(store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: id,
          originRunId: bound.identity.runId})).toBe(true);
        expect(currentRuntimePerformanceRecorder()).toBeUndefined();
        expect(resolveRuntimePerformanceRecorder(foreign.builder)).toBeUndefined();
        expect(resolveRuntimePerformanceRecorder(bound.builder)).toBeUndefined();
        createRuntimePerformanceRun(foreign.builder).finishClassification();
        startRuntimeModelCall(currentRuntimePerformanceRecorder(), {purpose: 'answer_turn'}).end();
        startRuntimeModelCall(undefined, {purpose: 'review'}).end();
      };
      const shared = withRuntimeToolConcurrency({name: 'lookup_sql_schema', description: 'Read', exposure: 'public',
        inputSchema: {}, handler: async (_args, extra) => {
          await Promise.resolve();
          downstream();
          // A callback created here must retain suppression after transport loses this async context.
          nested = withRuntimeToolConcurrency({name: 'nested', description: 'Nested', exposure: 'public', inputSchema: {},
            handler: async () => { downstream(); return createRuntimeToolResult({success: true}); }},
          createRuntimeToolConcurrencyCoordinator(), {runManifestAttributionSink: foreign.builder});
          return {content: [{type: 'text' as const, text: extra.runManifestAttributionSink?.identity.runId ?? 'missing'}]};
        }}, createRuntimeToolConcurrencyCoordinator(), {runManifestAttributionSink: bound.builder});
      const result = await withRunManifestLifecycle(foreign, () => shared.handler({}, {}));
      expect(result.content[0]).toEqual({type: 'text', text: bound.identity.runId});
      expect(store.size).toBe(1);
      await withRunManifestLifecycle(foreign, () => nested.handler({}, {}));
      expect(store.size).toBe(2);
      expect(bound.builder.runtimePerformanceRecorder.activitySnapshot().observation).toBe('partial');
      expect(foreignRecorder.activitySnapshot()).toEqual(foreignBefore);
      expect(foreignRecorder.hasRecordedData).toBe(false);
      // Suppression is local to the conflicting callback, not a global switch.
      withRunManifestLifecycle(foreign, () => startRuntimeModelCall(currentRuntimePerformanceRecorder(),
        {purpose: 'answer_turn'}).end());
      expect(foreignRecorder.seal().modelCalls).toHaveLength(1);
      bound.dispose(); foreign.dispose();
    });

  it('suppresses downstream ambient fallback at the direct timing boundary without a registry binding', async () => {
    const perCall = createLifecycle('direct-per-call');
    const ambient = createLifecycle('direct-ambient');
    const store = new ArtifactStore();
    const shared = withRuntimeToolTiming({name: 'direct', description: 'Direct', exposure: 'public', inputSchema: {},
      handler: async () => {
        const data = {columns: ['value'], rows: [[1]]};
        const id = store.store({skillId: 'execute_sql', data});
        expect(store.registerEvidenceCapture(id, captureEvidenceTable(data), {evidenceRefId: id})).toBe(true);
        expect(currentRuntimePerformanceRecorder()).toBeUndefined();
        startRuntimeModelCall(currentRuntimePerformanceRecorder(), {purpose: 'answer_turn'}).end();
        return createRuntimeToolResult({success: true});
      }});
    await withRunManifestLifecycle(ambient, () => shared.handler({}, {runManifestAttributionSink: perCall.builder}));
    expect(store.size).toBe(1);
    expect(perCall.builder.runtimePerformanceRecorder.hasRecordedData).toBe(false);
    expect(ambient.builder.runtimePerformanceRecorder.hasRecordedData).toBe(false);
    perCall.dispose(); ambient.dispose();
  });

  it('uses a per-call RunManifest sink only when no request-bound sink is configured', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator();
    const perCallLifecycle = createLifecycle('run-per-call-tool-sink');
    const shared = withRuntimeToolConcurrency({
      name: 'lookup_sql_schema',
      description: 'Safe read with per-call sink',
      exposure: 'public',
      inputSchema: {},
      concurrency: {mode: 'commutative_read'},
      handler: jest.fn(async (_args: Record<string, unknown>, extra: any) => ({
        content: [{
          type: 'text' as const,
          text: extra.runManifestAttributionSink?.identity.runId ?? 'missing-run',
        }],
      })),
    }, coordinator);

    const result = await shared.handler({}, {
      toolCallId: 'raw-per-call-tool-id',
      runManifestAttributionSink: perCallLifecycle.builder,
    });

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'run-per-call-tool-sink',
    });
    expect(perCallLifecycle.builder.runtimePerformanceRecorder.seal().tools).toHaveLength(1);
    perCallLifecycle.dispose();
  });

  it('suppresses unbound timing when a per-call sink conflicts with the active RunManifest context', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator();
    const perCallLifecycle = createLifecycle('run-conflict-per-call-tool-sink');
    const asyncLocalLifecycle = createLifecycle('run-conflict-async-local-tool-sink');
    const shared = withRuntimeToolConcurrency({
      name: 'lookup_sql_schema',
      description: 'Safe read with conflicting per-call sink',
      exposure: 'public',
      inputSchema: {},
      concurrency: {mode: 'commutative_read'},
      handler: jest.fn(async (_args: Record<string, unknown>, extra: any) => ({
        content: [{
          type: 'text' as const,
          text: extra.runManifestAttributionSink?.identity.runId ?? 'suppressed-sink',
        }],
      })),
    }, coordinator);

    const result = await withRunManifestLifecycle(asyncLocalLifecycle, () =>
      shared.handler({}, {
        toolCallId: 'raw-conflict-tool-id',
        runManifestAttributionSink: perCallLifecycle.builder,
      }));

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'suppressed-sink',
    });
    expect(perCallLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    expect(asyncLocalLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    perCallLifecycle.dispose();
    asyncLocalLifecycle.dispose();
  });

  it('records unbound per-call timing when the per-call sink matches the active RunManifest context', async () => {
    const coordinator = createRuntimeToolConcurrencyCoordinator({
      env: {[SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES_ENV]: 'task5'},
    });
    const lifecycle = createLifecycle('run-matching-per-call-tool-sink');
    const shared = withRuntimeToolConcurrency({
      name: 'lookup_sql_schema',
      description: 'Safe read with matching per-call sink',
      exposure: 'public',
      inputSchema: {},
      concurrency: {mode: 'commutative_read'},
      handler: jest.fn(async (_args: Record<string, unknown>, extra: any) => ({
        content: [{
          type: 'text' as const,
          text: extra.runManifestAttributionSink?.identity.runId ?? 'missing-run',
        }],
      })),
    }, coordinator);

    const result = await withRunManifestLifecycle(lifecycle, () =>
      shared.handler({}, {
        toolCallId: 'raw-matching-tool-id',
        runManifestAttributionSink: lifecycle.builder,
      }));

    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'run-matching-per-call-tool-sink',
    });
    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({
        mode: 'commutative_read',
        schedulerWaitMs: 0,
        outcome: 'ok',
        toolCallIdHash: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(JSON.stringify(lifecycle.builder.runtimePerformanceRecorder.seal()))
      .not.toContain('raw-matching-tool-id');
    lifecycle.dispose();
  });

  it('keeps successful shared tools fail-open when timing recording is sealed or over-cap', async () => {
    const sealedLifecycle = createLifecycle('run-sealed-tool');
    sealedLifecycle.builder.runtimePerformanceRecorder.seal();
    const sealedShared = sharedToolSpecFromRuntimeToolDefinition('sealed_tool', toolDefinition('sealed_tool'), 'public');

    await expect(withRunManifestLifecycle(sealedLifecycle, () =>
      sealedShared.handler({}, {}))).resolves.toBeDefined();
    sealedLifecycle.dispose();

    const overCapLifecycle = createLifecycle('run-over-cap-tool');
    const longIdShared = sharedToolSpecFromRuntimeToolDefinition('over_cap_tool', toolDefinition('over_cap_tool'), 'public');

    await expect(withRunManifestLifecycle(overCapLifecycle, () =>
      longIdShared.handler({}, {toolCallId: 'x'.repeat(300)}))).resolves.toBeDefined();
    expect(overCapLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    overCapLifecycle.dispose();
  });

  it('records cancelled shared tool outcome while preserving the thrown tool error', async () => {
    const lifecycle = createLifecycle('run-cancelled-tool');
    const abort = new AbortController();
    abort.abort(new Error('user cancelled'));
    const existing = toolDefinition('cancelled_tool');
    existing.handler.mockImplementation(async () => {
      const error = new Error('AbortError: user cancelled');
      error.name = 'AbortError';
      throw error;
    });
    const shared = sharedToolSpecFromRuntimeToolDefinition('cancelled_tool', existing, 'public');

    await expect(withRunManifestLifecycle(lifecycle, () =>
      shared.handler({}, {signal: abort.signal}))).rejects.toThrow('AbortError');

    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({outcome: 'cancelled'}),
    ]);
    lifecycle.dispose();
  });

  it('records a late successful handler return as cancelled when its signal aborted in flight', async () => {
    const lifecycle = createLifecycle('run-late-cancelled-tool');
    const abort = new AbortController();
    const handlerStarted = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    const shared = withRuntimeToolTiming({
      name: 'late_cancelled_tool',
      description: 'Late cancelled tool',
      exposure: 'public',
      inputSchema: {},
      handler: jest.fn(async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return {content: [{type: 'text' as const, text: 'late success'}]};
      }),
    });

    const pending = withRunManifestLifecycle(lifecycle, () =>
      shared.handler({}, {signal: abort.signal}));
    await handlerStarted.promise;
    abort.abort(new Error('request disconnected'));
    releaseHandler.resolve();

    await expect(pending).resolves.toMatchObject({
      content: [{type: 'text', text: 'late success'}],
    });
    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({outcome: 'cancelled'}),
    ]);
    lifecycle.dispose();
  });

  it('records shared production tool wrapper errors', async () => {
    const lifecycle = createLifecycle('run-shared-tool-error');
    const shared: SharedToolSpec = {
      name: 'failing_tool',
      description: 'Failing tool',
      exposure: 'public',
      inputSchema: {},
      handler: jest.fn(async () => {
        throw new Error('tool failed');
      }),
    };
    const claude = createClaudeSdkToolFromSharedSpec(shared);

    await expect(withRunManifestLifecycle(lifecycle, () =>
      claude.handler({}, {toolCallId: 'raw-failing-tool-id'} as any)))
      .rejects.toThrow('tool failed');

    expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
      expect.objectContaining({
        mode: 'exclusive',
        schedulerWaitMs: 0,
        durationMs: expect.any(Number),
        outcome: 'error',
      }),
    ]);
    lifecycle.dispose();
  });

  it('emits adapter-safe JSON Schema from the shared Zod raw shape', () => {
    const schema = createJsonSchemaFromZodRawShape({
      skillId: z.string(),
      params: z.record(z.string(), z.any()).optional().describe('Optional skill parameters'),
    });

    expect(schema.required).toEqual(['skillId']);
    expect((schema.properties as any).skillId).toMatchObject({ type: 'string' });
    expect((schema.properties as any).params).toMatchObject({ type: 'string' });
    expect(JSON.stringify(schema)).not.toContain('propertyNames');
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{}');
  });

  it('normalizes JSON container strings and stringifies MCP-style results', () => {
    expect(normalizeRuntimeToolArgs({
      params: '{"enable_startup_details": false}',
      list: ['{"a": 1}', 'plain'],
    })).toEqual({
      params: { enable_startup_details: false },
      list: [{ a: 1 }, 'plain'],
    });
    expect(stringifyRuntimeToolResult({
      content: [
        { type: 'text', text: 'first' },
        { type: 'json', payload: { ok: true } },
      ],
    })).toBe('first\n{"type":"json","payload":{"ok":true}}');
  });

  it('drops null and placeholder strings from optional fields only, given the tool shape', () => {
    const shape = {
      sql: z.string(),
      process_name: z.string().optional(),
      thread_name: z.string().optional(),
      utid: z.union([z.number(), z.string()]).optional(),
      limit: z.number().default(10),
      note: z.string().optional(),
    };
    expect(normalizeRuntimeToolArgs({
      sql: 'null', process_name: 'null', thread_name: '', utid: null, limit: null, note: 'kept',
    }, shape)).toEqual({sql: 'null', note: 'kept'});
    // A real value, a required field and nested values are the handler's business.
    expect(normalizeRuntimeToolArgs({sql: '', utid: '0', process_name: ' NONE '}, shape))
      .toEqual({sql: '', utid: '0'});
    // Without the shape nothing is dropped.
    expect(normalizeRuntimeToolArgs({process_name: 'null'})).toEqual({process_name: 'null'});
  });

  it('preserves schema-declared strings while retaining container and placeholder compatibility', () => {
    const args = {body: ' {"literal":true} ', declarationJson: '{"claims":[]}',
      optional: '[1,2]', defaulted: '{"a":1}', enumeration: '{"enum":true}',
      params: '{"nested":"[1,2]"}', list: '[{"id":1}]', omitted: 'null'};
    const shape = {body: z.string(), declarationJson: z.string().max(65536), optional: z.string().optional(),
      defaulted: z.string().default(''), enumeration: z.enum(['{"enum":true}']),
      params: z.record(z.string(), z.any()), list: z.array(z.object({id: z.number()})), omitted: z.string().optional()};
    const expected = {...args, params: {nested: [1, 2]}, list: [{id: 1}]};
    delete (expected as Partial<typeof expected>).omitted;
    expect(normalizeRuntimeToolArgs(args, shape)).toEqual(expected);
    expect(normalizeRuntimeToolArgs(JSON.stringify(args), shape)).toEqual(expected);
  });

  it('transports exact JSON strings through the real shared Pi and OpenAI adapters', async () => {
    const handler = jest.fn(async (args: Record<string, unknown>) => ({content: [{type: 'text' as const, text: JSON.stringify(args)}]}));
    const shared: SharedToolSpec = {name: 'string_transport_probe', description: 'Preserve string input', exposure: 'internal',
      inputSchema: {body: z.string(), declarationJson: z.string(), params: z.record(z.string(), z.any())}, handler};
    const args = {body: '{"report":"literal"}', declarationJson: '{"claims":[]}', params: '{"enabled":true}'};
    const expected = {...args, params: {enabled: true}};
    const pi = createPiAgentCoreToolFromSharedSpec(shared, {allowedToolNames: new Set([shared.name])});
    await pi.execute('string-transport-pi', args);
    const registry = new McpToolRegistry();
    registry.registerShared(shared);
    const openai = createOpenAIToolsFromMcpDefinitions(registry.list())[0] as any;
    await openai.invoke({context: {}}, JSON.stringify(args), {toolCall: {callId: 'string-transport-openai'}});
    expect(handler).toHaveBeenCalledTimes(2);
    for (const call of handler.mock.calls) expect(call[0]).toEqual(expected);
  });

  it('supports a fake third-party adapter without a production runtime value', async () => {
    const handler = jest.fn(async (args: Record<string, unknown>, _extra: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
    }));
    const shared: SharedToolSpec = {
      name: 'third_party_probe',
      description: 'Probe shared tool body',
      exposure: 'public',
      inputSchema: { payload: z.string() },
      handler,
    };
    const fakeThirdPartyAdapter = {
      name: `third-party-test:${shared.name}`,
      schema: createJsonSchemaFromZodRawShape(shared.inputSchema),
      call: async (rawArgs: unknown) => shared.handler(
        normalizeRuntimeToolArgs(rawArgs, shared.inputSchema) as Record<string, unknown>,
        { runtime: 'third-party-test-engine' },
      ),
    };

    const result = await fakeThirdPartyAdapter.call({ payload: '{"nested": true}' });

    expect(fakeThirdPartyAdapter.name).toBe('third-party-test:third_party_probe');
    expect(fakeThirdPartyAdapter.schema).toMatchObject({
      type: 'object',
      properties: { payload: { type: 'string' } },
    });
    expect(handler).toHaveBeenCalledWith(
      { payload: '{"nested": true}' },
      { runtime: 'third-party-test-engine' },
    );
    expect((result.content[0] as any).text).toBe(JSON.stringify({payload: '{"nested": true}'}));
  });

  it('keeps one timing receipt when a registry observer wraps an already timed SDK handler', async () => {
    const lifecycle = createLifecycle('run-observed-registry-tool');
    const events: string[] = [];
    const registry = new McpToolRegistry({
      runManifestAttributionSink: lifecycle.builder,
      toolObserver: event => {events.push(event.phase);},
    });
    registry.registerTool(toolDefinition('execute_sql'), 'execute_sql', 'public');
    // The descriptor the Claude engine hands to its in-process server.
    const descriptor = createClaudeSdkToolFromSharedSpec(registry.list()[0].shared);
    try {
      await descriptor.handler({q: 'select 1'} as any, {});
      expect(events).toEqual(['started', 'completed']);
      expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
        expect.objectContaining({outcome: 'ok', toolCallIdHash: expect.stringMatching(/^sha256:/)}),
      ]);
    } finally {
      lifecycle.dispose();
    }
  });

  it.each([true, false])('times each shared/SDK guarded invocation once with allowNewEvidence=%s', async allowNewEvidence => {
    const lifecycle = createLifecycle(`run-guarded-${allowNewEvidence}`);
    const body = jest.fn(async () => createRuntimeToolResult({success: true}));
    const sdk = createClaudeSdkToolFromSharedSpec({
      name: 'acquire', description: 'Acquire evidence', exposure: 'public', inputSchema: {}, handler: body,
    });
    const events: string[] = [];
    const factory = jest.spyOn(runtimeToolSpec, 'withRuntimeToolConcurrency');
    try {
      const registry = new McpToolRegistry({
        requestScope: {sessionId: 's1', hasCodebaseAccess: false, allowNewEvidence},
        runManifestAttributionSink: lifecycle.builder,
        toolObserver: event => {events.push(event.phase);},
      });
      // An SDK descriptor registered again keeps its single timing receipt.
      registry.registerTool(sdk as unknown as RuntimeToolDefinition, 'acquire', 'public', {evidenceEffect: 'acquire'});
      // Keep the registered runtime spec and its SDK descriptor, even when discovery hides them.
      const shared = factory.mock.results[0].value as SharedToolSpec;
      const descriptor = createClaudeSdkToolFromSharedSpec(shared);
      const fromShared = await shared.handler({}, {toolCallId: 'shared'});
      const fromSdk = await descriptor.handler({}, {toolCallId: 'sdk'});
      expect(readRuntimeToolResultFacts(fromShared)).toEqual({success: allowNewEvidence});
      expect(readRuntimeToolResultFacts(fromSdk)).toEqual({success: allowNewEvidence});
      expect(body).toHaveBeenCalledTimes(allowNewEvidence ? 2 : 0);
      expect(events).toEqual(['started', 'completed', 'started', 'completed']);
      expect(lifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([
        expect.objectContaining({outcome: allowNewEvidence ? 'ok' : 'error'}),
        expect.objectContaining({outcome: allowNewEvidence ? 'ok' : 'error'}),
      ]);
    } finally {
      factory.mockRestore();
      lifecycle.dispose();
    }
  });
});

describe('run authorization wrappers', () => {
  const revoked = new Error('analysis_context_changed_restart_required');
  const fence = (failAt: Array<'pre' | 'post'>) => {
    const events: string[] = [];
    let checks = 0;
    return {
      events,
      authorization: {
        assertCurrentInTurn: () => {
          const at = checks++ === 0 ? 'pre' : 'post';
          events.push(`check:${at}`);
          if (failAt.includes(at)) throw revoked;
        },
        settled: async () => { events.push('settled'); },
      },
    };
  };
  const timedExtra = () => {
    const recorder = createRuntimePerformanceRecorder();
    return {recorder, extra: {toolCallId: 'call-1', runManifestAttributionSink: {runtimePerformanceRecorder: recorder} as any}};
  };
  const spec = (body: () => Promise<any>): SharedToolSpec => ({name: 'probe', description: 'probe', exposure: 'public',
    inputSchema: {}, handler: async () => body()});

  it.each([
    ['pre-check', ['pre'] as Array<'pre' | 'post'>, async () => createRuntimeToolResult({success: true}), ['check:pre', 'settled'], 0],
    ['body error', [] as Array<'pre' | 'post'>, async () => { throw new Error('body'); }, ['check:pre', 'settled'], 1],
    ['post-check', ['post'] as Array<'pre' | 'post'>, async () => createRuntimeToolResult({success: true}), ['check:pre', 'check:post', 'settled'], 1],
  ])('waits for the revoke to settle on a failing %s and keeps one timing receipt per executed body', async (_label, failAt, body, expected, timedCalls) => {
    for (const wrap of ['composite', 'auth_only'] as const) {
      const {events, authorization} = fence(failAt);
      const {recorder, extra} = timedExtra();
      const wrapped = wrap === 'composite'
        ? runtimeToolSpec.withRuntimeToolAuthorization(spec(body), authorization)
        : runtimeToolSpec.withRunAuthorizationOnly(withRuntimeToolTiming(spec(body)), authorization);
      await expect(wrapped.handler({}, extra)).rejects.toThrow();
      expect(events).toEqual(expected);
      expect(recorder.seal().tools).toHaveLength(timedCalls);
    }
  });

  it('is the composition auth-only ∘ timing, and auth-only alone records no tool timing', async () => {
    const composite = timedExtra();
    const authOnly = timedExtra();
    const body = async () => createRuntimeToolResult({success: true});
    const allow = {assertCurrentInTurn: () => undefined, settled: async () => undefined};
    await runtimeToolSpec.withRuntimeToolAuthorization(spec(body), allow).handler({}, composite.extra);
    await runtimeToolSpec.withRunAuthorizationOnly(spec(body), allow).handler({}, authOnly.extra);
    expect(composite.recorder.seal().tools).toHaveLength(1);
    expect(authOnly.recorder.seal().tools).toEqual([]);
    // The composite stays marked as timed, so outer wrappers do not time it again.
    const outer = withRuntimeToolTiming(runtimeToolSpec.withRuntimeToolAuthorization(spec(body), allow));
    const again = timedExtra();
    await outer.handler({}, again.extra);
    expect(again.recorder.seal().tools).toHaveLength(1);
  });
});
