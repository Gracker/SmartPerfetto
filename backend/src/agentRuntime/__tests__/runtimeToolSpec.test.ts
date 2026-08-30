// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import {
  createClaudeSdkToolFromSharedSpec,
  createJsonSchemaFromZodRawShape,
  normalizeRuntimeToolArgs,
  sharedToolSpecFromClaudeSdkTool,
  stringifyRuntimeToolResult,
  withRuntimeToolConcurrency,
  withRuntimeToolTiming,
  type SharedToolSpec,
} from '../runtimeToolSpec';
import {createRuntimeToolConcurrencyCoordinator} from '../runtimeToolConcurrency';
import {
  RunManifestLifecycle,
  withRunManifestLifecycle,
} from '../../services/selfEvolution/runManifestLifecycle';
import type {RunManifestStore} from '../../services/selfEvolution/runManifestStore';

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
    const coordinator = createRuntimeToolConcurrencyCoordinator({now: () => now});
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

  it('keeps a request-bound RunManifest sink authoritative over stale per-call extras', async () => {
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
    expect(boundLifecycle.builder.runtimePerformanceRecorder.seal().tools).toHaveLength(1);
    expect(staleLifecycle.builder.runtimePerformanceRecorder.seal().tools).toEqual([]);
    boundLifecycle.dispose();
    staleLifecycle.dispose();
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
    const coordinator = createRuntimeToolConcurrencyCoordinator();
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
        normalizeRuntimeToolArgs(rawArgs) as Record<string, unknown>,
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
      { payload: { nested: true } },
      { runtime: 'third-party-test-engine' },
    );
    expect((result.content[0] as any).text).toBe('{"payload":{"nested":true}}');
  });
});
