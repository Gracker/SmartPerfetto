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
  createClaudeSdkToolFromSharedSpec,
  createJsonSchemaFromZodRawShape,
  deduplicateNullableSchemaDescriptions,
  isClaudeSdkToolLike,
  normalizeRuntimeToolArgs,
  preserveRuntimeLiteralStrings,
  preserveRuntimeLiteralJson,
  sharedToolSpecFromClaudeSdkTool,
  stringifyRuntimeToolResult,
  withRuntimeToolConcurrency,
  withRuntimeToolTiming,
  type SharedToolSpec,
} from '../runtimeToolSpec';

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
import {createRuntimePerformanceRecorder, createRuntimePerformanceRun, startRuntimeModelCall, recordRuntimeFinalReview} from '../runtimePerformance';
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

function sdkTool(name: string) {
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
    runtime: 'qoder-agent-sdk',
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
    const spec = sharedToolSpecFromClaudeSdkTool('execute_sql', {
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

  it('builds a shared tool body from the existing Claude SDK descriptor shape', async () => {
    const existing = sdkTool('invoke_skill');
    const shared = sharedToolSpecFromClaudeSdkTool(
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

  it('builds a Claude SDK-native descriptor from a shared spec', async () => {
    const existing = sdkTool('execute_sql');
    const shared = sharedToolSpecFromClaudeSdkTool('execute_sql', existing, 'public');
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
    const existing = sdkTool('direct_shared_tool');
    existing.handler.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return {content: [{type: 'text' as const, text: 'ok'}]};
    });
    const shared = sharedToolSpecFromClaudeSdkTool('direct_shared_tool', existing, 'public');

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
    const existing = sdkTool('adapter_shared_tool');
    const shared = sharedToolSpecFromClaudeSdkTool('adapter_shared_tool', existing, 'public');
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
        recordRuntimeFinalReview(undefined, {necessity: 'not_required', triggers: [], declaredClaimCount: 0});
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
    const sealedShared = sharedToolSpecFromClaudeSdkTool('sealed_tool', sdkTool('sealed_tool'), 'public');

    await expect(withRunManifestLifecycle(sealedLifecycle, () =>
      sealedShared.handler({}, {}))).resolves.toBeDefined();
    sealedLifecycle.dispose();

    const overCapLifecycle = createLifecycle('run-over-cap-tool');
    const longIdShared = sharedToolSpecFromClaudeSdkTool('over_cap_tool', sdkTool('over_cap_tool'), 'public');

    await expect(withRunManifestLifecycle(overCapLifecycle, () =>
      longIdShared.handler({}, {toolCallId: 'x'.repeat(300)}))).resolves.toBeDefined();
    expect(overCapLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    overCapLifecycle.dispose();
  });

  it('records cancelled shared tool outcome while preserving the thrown tool error', async () => {
    const lifecycle = createLifecycle('run-cancelled-tool');
    const abort = new AbortController();
    abort.abort(new Error('user cancelled'));
    const existing = sdkTool('cancelled_tool');
    existing.handler.mockImplementation(async () => {
      const error = new Error('AbortError: user cancelled');
      error.name = 'AbortError';
      throw error;
    });
    const shared = sharedToolSpecFromClaudeSdkTool('cancelled_tool', existing, 'public');

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
    registry.registerSdk(sdkTool('execute_sql'), 'execute_sql', 'public');
    const descriptor = registry.list()[0].tool as ReturnType<typeof createClaudeSdkToolFromSharedSpec>;
    try {
      if (!isClaudeSdkToolLike(descriptor)) throw new Error('Expected an SDK tool descriptor');
      await descriptor.handler({q: 'select 1'}, {});
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
    const factory = jest.spyOn(runtimeToolSpec, 'createClaudeSdkToolFromSharedSpec');
    try {
      const registry = new McpToolRegistry({
        requestScope: {sessionId: 's1', hasCodebaseAccess: false, allowNewEvidence},
        runManifestAttributionSink: lifecycle.builder,
        toolObserver: event => {events.push(event.phase);},
      });
      registry.registerSdk(sdk, 'acquire', 'public', {evidenceEffect: 'acquire'});
      // Keep the actual generated descriptors, even when discovery hides them.
      const shared = factory.mock.calls[0][0];
      const descriptor = factory.mock.results[0].value;
      if (!isClaudeSdkToolLike(descriptor)) throw new Error('Expected SDK descriptor');
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


describe('schema-owned literal JSON subtree', () => {
  it('preserves nested literal data and number identity without cloning the marked subtree', () => {
    const document = {parts: ['{"literal":true}', '[1,2]', 'null', 'None'],
      values: JSON.parse('[null,1e999,-0]'), nested: {selector: '{"a":1}'}};
    const field = preserveRuntimeLiteralJson(z.object({parts: z.array(z.string())}));
    const normalized = normalizeRuntimeToolArgs({document, ordinary: '{"n":1}'}, {document: field}) as Record<string, unknown>;
    expect(normalized.document).toBe(document);
    expect(normalized.ordinary).toEqual({n: 1});
    expect(document.parts).toEqual(['{"literal":true}', '[1,2]', 'null', 'None']);
    expect(Object.is(document.values[1], Infinity)).toBe(true);
    expect(Object.is(document.values[2], -0)).toBe(true);
  });

  it.each([null, 'null', 'None', '{"parts":[]}', '[1,2]'])('leaves wrong-type or placeholder %p for the owning compiler to reject', value => {
    const field = preserveRuntimeLiteralJson(z.object({parts: z.array(z.string())}));
    expect(normalizeRuntimeToolArgs({document: value}, {document: field})).toEqual({document: value});
  });

  it('does not serialize the private marker or change an unmarked schema instance', () => {
    const schema = z.object({parts: z.array(z.string())});
    const before = createJsonSchemaFromZodRawShape({document: schema});
    const marked = preserveRuntimeLiteralJson(schema);
    expect(marked).toBe(schema);
    expect(createJsonSchemaFromZodRawShape({document: marked})).toEqual(before);
    const plain = z.object({parts: z.array(z.string())});
    expect(normalizeRuntimeToolArgs({document: {parts: ['{"literal":true}']}}, {document: plain}))
      .toEqual({document: {parts: [{literal: true}]}});
    expect(normalizeRuntimeToolArgs({document: {parts: ['{"literal":true}']}}, {document: marked}))
      .toEqual({document: {parts: ['{"literal":true}']}});
  });
});

// B2 leaf contract: local call identities below do not establish actual HTTP visibility.
describe('private quote sidecars at the actual normalized tool output', () => {
  type Call = {responseId: string; callId: string; nativeName: string; rawArguments: string;
    sdkArguments: unknown; normalizedArguments: unknown; collector: object; collectorDispatchOrdinal: number};
  type Factory = (input: {store: import('../../agentv3/artifactStore').ArtifactStore;
    scope: {runId: string; allowedTraces: Array<{traceId: string; traceSide: 'current'}>}; assertCurrent(): void;
    productSignal: AbortSignal; deadlineAtMs: number}) => ReturnType<typeof import('../../services/evidence/evidenceQuoteContext').createEvidenceQuoteContext>;
  function api() {
    const file = path.resolve(__dirname, '../../services/evidence/evidenceQuoteContext.ts');
    expect(fs.existsSync(file)).toBe(true);
    const module = jest.requireActual<{createEvidenceQuoteContext?: Factory}>(file);
    expect(typeof module.createEvidenceQuoteContext).toBe('function');
    const results = jest.requireActual<typeof import('../runtimeToolResult') & {
      readRuntimeToolQuoteProjection?: (result: unknown) => object | undefined}>('../runtimeToolResult');
    expect(typeof results.readRuntimeToolQuoteProjection).toBe('function');
    if (!module.createEvidenceQuoteContext || !results.readRuntimeToolQuoteProjection) throw new Error('Missing B2 quote API');
    return {create: module.createEvidenceQuoteContext, read: results.readRuntimeToolQuoteProjection, normalize: results.normalizeRuntimeToolResult};
  }
  async function prepared() {
    const quote = api();
    const {ArtifactStore} = require('../../agentv3/artifactStore') as typeof import('../../agentv3/artifactStore');
    const {captureEvidenceTable} = require('../../services/evidence/evidenceCapture') as typeof import('../../services/evidence/evidenceCapture');
    const {buildTraceProcessorQueryProvenance} = require('../../services/traceProcessorConnectionModel') as typeof import('../../services/traceProcessorConnectionModel');
    const {createClaudeMcpServer} = require('../../agentv3/claudeMcpServer') as typeof import('../../agentv3/claudeMcpServer');
    const {SkillExecutor} = require('../../services/skillEngine/skillExecutor') as typeof import('../../services/skillEngine/skillExecutor');
    const {createOpenAIToolsFromMcpDefinitions} = require('../engines/openai/openAiToolAdapter') as typeof import('../engines/openai/openAiToolAdapter');
    const store = new ArtifactStore(), data = {columns: ['duration'], rows: [[4], [null], ['0004.50']]};
    const witness = captureEvidenceTable(data, {duration: {unit: 'ns', metricId: 'B2_PRIVATE_METRIC_CANARY',
      populationKey: 'B2_PRIVATE_POPULATION_CANARY', origin: {kind: 'skill_literal', definitionFingerprint: 'B2_PRIVATE_DEFINITION_CANARY'}}});
    const artifactId = store.store({skillId: 'quote-spec-fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'quote-spec-trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(artifactId, witness, {evidenceRefId: 'quote-spec-evidence', originRunId: 'quote-spec-run'})).toBe(true);
    const product = new AbortController(); let current = true;
    const context = quote.create({store, scope: {runId: 'quote-spec-run', allowedTraces: [{traceId: 'quote-spec-trace', traceSide: 'current'}]},
      assertCurrent() {if (!current) throw new Error('quote_owner_revoked');}, productSignal: product.signal, deadlineAtMs: Date.now() + 60_000});
    const service = {query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0}))} as unknown as import('../../services/traceProcessorService').TraceProcessorService;
    const options = {traceId: 'quote-spec-trace', runId: 'quote-spec-run', sessionId: 'quote-spec-session', artifactStore: store,
      traceProcessorService: service, skillExecutor: new SkillExecutor(service), quoteContext: context};
    const server = createClaudeMcpServer(options);
    const definition = server.toolDefinitions.find(item => item.name === 'fetch_artifact');
    if (!definition) throw new Error('Expected actual fetch definition');
    const args = {artifactId, detail: 'rows'};
    const result = await definition.shared.handler(args, {toolCallId: 'quote-fetch-call'});
    expect(result.structuredContent).toBeDefined();
    const projection = quote.read(result); expect(projection).toBeDefined();
    const tool = createOpenAIToolsFromMcpDefinitions([definition])[0];
    const call: Call = {responseId: 'unit-response', callId: 'quote-fetch-call', nativeName: definition.name,
      rawArguments: JSON.stringify(args), sdkArguments: args, normalizedArguments: args, collector: {}, collectorDispatchOrdinal: 1};
    return {quote, result, projection: projection!, payload: result.structuredContent!, tool, call, context, product,
      revoke: () => {current = false;}, query: service.query};
  }

  it('keeps issued preparation through actual normalization, one decoration and final receipt serialization', async () => {
    const h = await prepared();
    try {
      const decorate = jest.fn((text: string) => `Trusted warning\n${text}\nTrusted reminder`);
      const options = {quoteProjection: h.projection, decorate};
      const raw = createRuntimeToolResult(h.payload, options);
      const spec = withRuntimeToolTiming({name: 'quote-fixture', description: 'Quote fixture', exposure: 'internal', inputSchema: {}, handler: async () => raw});
      const normalized = await spec.handler({}, {});
      expect(h.quote.read(normalized)).toBe(h.projection);
      expect(h.quote.normalize(normalized)).toBe(normalized);
      expect(decorate).toHaveBeenCalledTimes(1);
      const output = stringifyRuntimeToolResult(normalized);
      expect(h.payload.rows).toEqual([{rowIndex: 0, values: [4]}, {rowIndex: 1, values: [null]}, {rowIndex: 2, values: ['0004.50']}]);
      expect(JSON.parse(output)).toEqual({_meta: raw._meta, content: raw.content});
      expect(h.context.sealToolQuoteOutput(normalized, h.tool, h.call, output)).toBeDefined();
      expect(output).not.toContain('prepared_quote_projection');
      expect(output).not.toMatch(/B2_PRIVATE_(METRIC|POPULATION|DEFINITION)_CANARY/);
      expect(h.query).not.toHaveBeenCalled();
    } finally {h.context.dispose();}
  });

  it.each(['clone', 'spread', 'content_mutation', 'receipt_mutation', 'duplicate_payload', 'changed_payload', 'fake_token', 'changed_final_string'] as const)(
    'does not seal %s from public facts or copied sidecars', async mode => {
      const h = await prepared();
      try {
        let result: unknown = h.result;
        if (mode === 'clone') result = JSON.parse(JSON.stringify(h.result));
        if (mode === 'spread') result = {...h.result};
        if (mode === 'content_mutation') {
          const content = h.result.content[0];
          if (content.type !== 'text') throw new Error('Expected actual text content');
          content.text += '\nALTERED';
        }
        if (mode === 'receipt_mutation') Object.assign(h.result._meta ?? {}, {unexpected: true});
        if (mode === 'duplicate_payload') {
          const options = {quoteProjection: h.projection, decorate: (text: string) => text + '\n' + text};
          result = createRuntimeToolResult(h.payload, options);
        }
        if (mode === 'changed_payload') {
          const options = {quoteProjection: h.projection, facts: {success: true}};
          result = createRuntimeToolResult({...h.payload, rows: [{rowIndex: 0, values: [11]}]}, options);
        }
        if (mode === 'fake_token') {
          const options = {quoteProjection: {kind: 'prepared_tool_quote_projection'}, facts: {success: true}};
          result = createRuntimeToolResult(h.payload, options);
        }
        const output = stringifyRuntimeToolResult(result) + (mode === 'changed_final_string' ? '\nALTERED' : '');
        expect(h.context.sealToolQuoteOutput(result, h.tool, h.call, output)).toBeUndefined();
      } finally {h.context.dispose();}
    });

  it.each(['revoke', 'cancel', 'dispose'] as const)('does not use pending preparation after %s', async mode => {
    const h = await prepared();
    if (mode === 'revoke') h.revoke();
    if (mode === 'cancel') h.product.abort();
    if (mode === 'dispose') h.context.dispose();
    try {expect(() => h.context.sealToolQuoteOutput(h.result, h.tool, h.call, stringifyRuntimeToolResult(h.result))).toThrow();}
    finally {h.context.dispose();}
  });
});

// The input is captured before the first external owner guard can reenter.
describe('quote preparation input snapshot', () => {
  it('submits the original frozen locator, page and scope when the first owner guard rewrites callers to another valid capture', () => {
    const file = path.resolve(__dirname, '../../services/evidence/evidenceQuoteContext.ts');
    expect(fs.existsSync(file)).toBe(true);
    const module = jest.requireActual<{createEvidenceQuoteContext?: typeof import('../../services/evidence/evidenceQuoteContext').createEvidenceQuoteContext}>(file);
    expect(typeof module.createEvidenceQuoteContext).toBe('function');
    if (!module.createEvidenceQuoteContext) throw new Error('Missing B2 createEvidenceQuoteContext');
    const {ArtifactStore} = require('../../agentv3/artifactStore') as typeof import('../../agentv3/artifactStore');
    const {captureEvidenceTable} = require('../../services/evidence/evidenceCapture') as typeof import('../../services/evidence/evidenceCapture');
    const {buildTraceProcessorQueryProvenance} = require('../../services/traceProcessorConnectionModel') as typeof import('../../services/traceProcessorConnectionModel');
    const store = new ArtifactStore();
    const register = (runId: string, traceId: string, column: string, rows: number[][]) => {
      const data = {columns: [column], rows};
      const witness = captureEvidenceTable(data, {[column]: {unit: 'ns',
        origin: {kind: 'skill_literal', definitionFingerprint: `${runId}-producer`}}});
      const id = store.store({skillId: 'quote-guard-fixture', data,
        traceProvenance: buildTraceProcessorQueryProvenance({traceId, traceSide: 'current'})});
      expect(store.registerEvidenceCapture(id, witness, {evidenceRefId: `${runId}-evidence`, originRunId: runId})).toBe(true);
      return id;
    };
    const artifactA = register('run-A', 'trace-A', 'duration', [[4]]);
    const artifactB = register('run-B', 'trace-B', 'alternate', [[0], [11]]);
    const locator = {artifactId: artifactA};
    const scope = {runId: 'run-A', allowedTraces: [{traceId: 'trace-A', traceSide: 'current' as const}]};
    const page = {rows: [0], columns: ['duration'], cells: [{rowIndex: 0, column: 'duration', value: 4, unit: 'ns', availability: 'visible' as const}],
      page: {hasMore: 'no' as const, coverage: 'visible_page_only' as const}};
    const originalPage = structuredClone(page), originalScope = structuredClone(scope);
    let armed = false, mutations = 0;
    const order: string[] = [];
    const context = module.createEvidenceQuoteContext({store, scope, productSignal: new AbortController().signal,
      deadlineAtMs: Date.now() + 60_000, assertCurrent() {
        if (!armed || mutations) return;
        mutations++; order.push('guard-mutated-callers');
        locator.artifactId = artifactB;
        scope.runId = 'run-B'; scope.allowedTraces[0].traceId = 'trace-B';
        page.rows[0] = 1; page.columns[0] = 'alternate';
        page.cells[0].rowIndex = 1; page.cells[0].column = 'alternate'; page.cells[0].value = 11;
      }});
    const actualPrepare = store.prepareQuoteProjectionBinding.bind(store);
    let submittedPage: unknown, actualBinding: unknown;
    const prepare = jest.spyOn(store, 'prepareQuoteProjectionBinding').mockImplementation((receivedLocator, actual) => {
      order.push('store-prepared');
      expect(receivedLocator).toEqual({artifactId: artifactA});
      expect(receivedLocator).not.toBe(locator);
      expect(actual.scope).toEqual(originalScope); expect(actual.scope).not.toBe(scope);
      expect(actual.page).toEqual(originalPage); expect(actual.page).not.toBe(page);
      for (const value of [receivedLocator, actual.scope, actual.scope.allowedTraces, actual.scope.allowedTraces[0],
        actual.page, actual.page.rows, actual.page.columns, actual.page.cells, actual.page.cells[0], actual.page.page]) {
        expect(Object.isFrozen(value)).toBe(true);
      }
      submittedPage = actual.page;
      // Call the real registration checker: neither a boolean stub nor a raw getter.
      const binding = actualPrepare(receivedLocator, actual);
      actualBinding = binding;
      return binding;
    });
    try {
      armed = true;
      expect(context.prepareModelQuoteView(locator, page)).toBeDefined();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(actualBinding).toBeDefined();
      expect(prepare.mock.calls[0][1].page).toBe(submittedPage);
      expect(order).toEqual(['guard-mutated-callers', 'store-prepared']);
      expect(mutations).toBe(1);
      expect(locator).toEqual({artifactId: artifactB});
      expect(scope).toEqual({runId: 'run-B', allowedTraces: [{traceId: 'trace-B', traceSide: 'current'}]});
      expect(page).toEqual({rows: [1], columns: ['alternate'], cells: [{rowIndex: 1, column: 'alternate', value: 11, unit: 'ns', availability: 'visible'}],
        page: {hasMore: 'no', coverage: 'visible_page_only'}});
      for (const value of [locator, scope, scope.allowedTraces, scope.allowedTraces[0], page, page.rows, page.columns, page.cells, page.cells[0]]) {
        expect(Object.isFrozen(value)).toBe(false);
      }
    } finally {prepare.mockRestore(); context.dispose(); store.clear();}
  });
});

// Local request parsing only: this does not attest an HTTP dispatch or native issuer.
describe('quote request visibility is independent of declaration and diagnostic byte caps', () => {
  it('recognizes an actually sealed tool page in a readable request larger than 2 MiB', async () => {
    const file = path.resolve(__dirname, '../../services/evidence/evidenceQuoteContext.ts');
    expect(fs.existsSync(file)).toBe(true);
    const api = jest.requireActual<typeof import('../../services/evidence/evidenceQuoteContext')>(file);
    expect(typeof api.createEvidenceQuoteContext).toBe('function');
    const {ArtifactStore} = require('../../agentv3/artifactStore') as typeof import('../../agentv3/artifactStore');
    const {captureEvidenceTable} = require('../../services/evidence/evidenceCapture') as typeof import('../../services/evidence/evidenceCapture');
    const {buildTraceProcessorQueryProvenance} = require('../../services/traceProcessorConnectionModel') as typeof import('../../services/traceProcessorConnectionModel');
    const {createClaudeMcpServer} = require('../../agentv3/claudeMcpServer') as typeof import('../../agentv3/claudeMcpServer');
    const {SkillExecutor} = require('../../services/skillEngine/skillExecutor') as typeof import('../../services/skillEngine/skillExecutor');
    const {createOpenAIToolsFromMcpDefinitions} = require('../engines/openai/openAiToolAdapter') as typeof import('../engines/openai/openAiToolAdapter');
    const store = new ArtifactStore(), data = {columns: ['duration'], rows: [[4]]};
    const artifactId = store.store({skillId: 'large-request-view', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'large-request-trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(artifactId, captureEvidenceTable(data),
      {evidenceRefId: 'large-request-evidence', originRunId: 'large-request-run'})).toBe(true);
    const context = api.createEvidenceQuoteContext({store, scope: {runId: 'large-request-run',
      allowedTraces: [{traceId: 'large-request-trace', traceSide: 'current'}]}, assertCurrent() {},
      productSignal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000});
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const service = {query} as unknown as import('../../services/traceProcessorService').TraceProcessorService;
    const server = createClaudeMcpServer({traceId: 'large-request-trace', runId: 'large-request-run', artifactStore: store,
      traceProcessorService: service, skillExecutor: new SkillExecutor(service), quoteContext: context});
    const stringify = jest.spyOn(runtimeToolSpec, 'stringifyRuntimeToolResult');
    try {
      const definition = server.toolDefinitions.find(item => item.name === 'fetch_artifact');
      if (!definition) throw new Error('Expected actual fetch_artifact');
      const args = {artifactId, detail: 'rows'}, rawArguments = JSON.stringify(args);
      const result = await definition.shared.handler(args, {toolCallId: 'large-request-call'});
      const installed = createOpenAIToolsFromMcpDefinitions([definition])[0], output = runtimeToolSpec.stringifyRuntimeToolResult(result);
      expect(context.sealToolQuoteOutput(result, installed, {responseId: 'unit-producing-response', callId: 'large-request-call',
        nativeName: definition.name, rawArguments, sdkArguments: args, normalizedArguments: args,
        collector: {}, collectorDispatchOrdinal: 1}, output)).toBeDefined();
      const unrelated = 'x'.repeat(2 * 1024 * 1024 + 1);
      const body = JSON.stringify({messages: [{role: 'assistant', content: null,
        tool_calls: [{id: 'large-request-call', type: 'function', function: {name: definition.name, arguments: rawArguments}}]},
      {role: 'tool', tool_call_id: 'large-request-call', content: output}, {role: 'user', content: unrelated}]});
      expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024);
      expect(context.observeProducingRequest({}, 2, body)).toEqual({status: 'observed', viewCount: 1});
      const retryWithoutPage = JSON.stringify({messages: [{role: 'user', content: unrelated}]});
      expect(context.observeProducingRequest({}, 3, retryWithoutPage)).toEqual({status: 'observed', viewCount: 0});
      expect(stringify).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
    } finally {stringify.mockRestore(); context.dispose(); store.clear();}
  });
});

// Exceptional JavaScript callers must not run conversion/prototype hooks at these leaf boundaries.
describe('quote transport leaf zero-side-effect input guards', () => {
  async function realSealedCarrier() {
    const api = jest.requireActual<typeof import('../../services/evidence/evidenceQuoteContext')>(
      '../../services/evidence/evidenceQuoteContext');
    const {ArtifactStore} = require('../../agentv3/artifactStore') as typeof import('../../agentv3/artifactStore');
    const {captureEvidenceTable} = require('../../services/evidence/evidenceCapture') as typeof import('../../services/evidence/evidenceCapture');
    const {buildTraceProcessorQueryProvenance} = require('../../services/traceProcessorConnectionModel') as typeof import('../../services/traceProcessorConnectionModel');
    const {createClaudeMcpServer} = require('../../agentv3/claudeMcpServer') as typeof import('../../agentv3/claudeMcpServer');
    const {SkillExecutor} = require('../../services/skillEngine/skillExecutor') as typeof import('../../services/skillEngine/skillExecutor');
    const {createOpenAIToolsFromMcpDefinitions} = require('../engines/openai/openAiToolAdapter') as typeof import('../engines/openai/openAiToolAdapter');
    const store = new ArtifactStore(), data = {columns: ['duration'], rows: [[4]]};
    const artifactId = store.store({skillId: 'zero-trap-fixture', data,
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'zero-trap-trace', traceSide: 'current'})});
    expect(store.registerEvidenceCapture(artifactId, captureEvidenceTable(data),
      {evidenceRefId: 'zero-trap-evidence', originRunId: 'zero-trap-run'})).toBe(true);
    const context = api.createEvidenceQuoteContext({store, scope: {runId: 'zero-trap-run',
      allowedTraces: [{traceId: 'zero-trap-trace', traceSide: 'current'}]}, assertCurrent() {},
      productSignal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000});
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const service = {query} as unknown as import('../../services/traceProcessorService').TraceProcessorService;
    const server = createClaudeMcpServer({traceId: 'zero-trap-trace', runId: 'zero-trap-run', artifactStore: store,
      traceProcessorService: service, skillExecutor: new SkillExecutor(service), quoteContext: context});
    try {
      const definition = server.toolDefinitions.find(item => item.name === 'fetch_artifact');
      if (!definition) throw new Error('Expected actual fetch_artifact');
      const args = {artifactId, detail: 'rows'}, rawArguments = JSON.stringify(args);
      const result = await definition.shared.handler(args, {toolCallId: 'zero-trap-call'});
      const tool = createOpenAIToolsFromMcpDefinitions([definition])[0];
      const output = runtimeToolSpec.stringifyRuntimeToolResult(result);
      const call = {responseId: 'unit-zero-trap-response', callId: 'zero-trap-call', nativeName: definition.name,
        rawArguments, sdkArguments: args, normalizedArguments: args, collector: {}, collectorDispatchOrdinal: 1};
      expect(context.sealToolQuoteOutput(result, tool, call, output)).toBeDefined();
      const body = JSON.stringify({messages: [{role: 'assistant', content: null,
        tool_calls: [{id: call.callId, type: 'function', function: {name: call.nativeName, arguments: rawArguments}}]},
      {role: 'tool', tool_call_id: call.callId, content: output}]});
      expect(context.observeProducingRequest({}, 2, body)).toEqual({status: 'observed', viewCount: 1});
      expect(query).not.toHaveBeenCalled();
      return {context, result, tool, call, output, body, dispose: () => {context.dispose(); store.clear();}};
    } catch (error) {context.dispose(); store.clear(); throw error;}
  }

  it('rejects a Proxy Uint8Array without invoking its getPrototypeOf trap after real carrier preparation', async () => {
    const h = await realSealedCarrier();
    const prototypeTrap = jest.fn((target: Uint8Array) => Reflect.getPrototypeOf(target));
    const malicious = new Proxy(new TextEncoder().encode(h.body), {getPrototypeOf: prototypeTrap});
    try {
      const outcome = h.context.observeProducingRequest({}, 3, malicious);
      expect({outcome, traps: prototypeTrap.mock.calls.length}).toEqual({outcome: {status: 'unavailable', viewCount: 0}, traps: 0});
    } finally {h.dispose();}
  });

  it('rejects an object exactOutput without invoking ToPrimitive on a real issued carrier', async () => {
    const h = await realSealedCarrier();
    const toPrimitive = jest.fn(() => h.output);
    const malicious = {[Symbol.toPrimitive]: toPrimitive};
    try {
      // Reflect.apply models a JavaScript caller violating the TS signature; it invents no backing token.
      const seal: unknown = Reflect.apply(h.context.sealToolQuoteOutput, undefined, [h.result, h.tool, h.call, malicious]);
      expect({accepted: seal !== undefined, coercions: toPrimitive.mock.calls.length}).toEqual({accepted: false, coercions: 0});
    } finally {h.dispose();}
  });
});
