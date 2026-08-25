// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import {EventEmitter} from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {PassThrough} from 'stream';
import net from 'net';
import {
  EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
  OPENCODE_RUNTIME_KIND,
  OpenCodeRuntime,
  completeOpenCodeFinalReportPhaseIfDelivered,
  createOpenCodeHardenedConfig,
  createOpenCodeStandaloneMcpConfig,
  createOpenCodeStandaloneMcpToolNames,
  createOpenCodeToolAllowlist,
  dispatchOpenCodeBridgeRequest,
  extractOpenCodeAssistantText,
  getOpenCodePlanCompletionStatus,
  getOpenCodeEngineCapabilities,
  getOpenCodeRuntimeDiagnostics,
  __testing as openCodeTesting,
  projectOpenCodeEventToStreamingUpdate,
  runOpenCodePrompt,
  sanitizeOpenCodeConclusionText,
  type OpenCodeSdkModuleLoader,
} from '../openCodeRuntime';
import type { RuntimeFactoryInput } from '../runtimeRegistry';
import type { QueryResult, TraceInfo, TraceProcessorService } from '../../services/traceProcessorService';
import { createTraceProcessorQueryCancelledError } from '../../services/traceProcessorCancellation';
import * as quickEvidenceDirectAnswer from '../quickEvidenceDirectAnswer';

type FakeTraceProcessorService = TraceProcessorService & {
  query: jest.MockedFunction<(traceId: string, sql: string) => Promise<QueryResult>>;
  getTrace: jest.MockedFunction<(traceId: string) => TraceInfo>;
};

function createFakeTraceProcessorService(): FakeTraceProcessorService {
  return {
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    getTrace: jest.fn(() => ({
      id: 'trace-opencode',
      filename: 'trace.pftrace',
      size: 1,
      uploadTime: new Date(),
      status: 'ready',
      traceOs: 'android',
      traceFormat: 'perfetto_protobuf',
    })),
  } as unknown as FakeTraceProcessorService;
}

function createFakeRuntimeInput(overrides: Partial<RuntimeFactoryInput> = {}): RuntimeFactoryInput {
  return {
    traceProcessorService: overrides.traceProcessorService ?? createFakeTraceProcessorService(),
    selection: overrides.selection ?? {
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      source: 'env',
    },
  };
}

function createSnapshotFields(): any {
  return {
    conversationSteps: [],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    runSequence: 1,
    conversationOrdinal: 0,
  };
}

async function withBackendDataDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-state-'));
  const previous = process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
  process.env.SMARTPERFETTO_BACKEND_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
    else process.env.SMARTPERFETTO_BACKEND_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createFakeModuleLoader(record: {
  createOptions?: Record<string, unknown>;
  promptInput?: unknown;
  closeCount: number;
}): OpenCodeSdkModuleLoader {
  return jest.fn(async () => ({
    createOpencodeWithEnv: jest.fn(async (options: Record<string, unknown>) => {
      record.createOptions = options;
      return {
        server: {
          url: 'http://127.0.0.1:4106',
          close: jest.fn(() => {
            record.closeCount += 1;
          }),
        },
        client: {
          session: {
            create: jest.fn(async () => ({ data: { id: 'ses-opencode-test' } })),
            prompt: jest.fn(async (input: unknown) => {
              record.promptInput = input;
              return { data: { info: { role: 'user' }, parts: [] } };
            }),
          },
        },
      };
    }),
  }));
}

function createCompletedScrollingPlanWithFinalPhase(): any {
  return {
    phases: [
      {
        id: 'p1',
        name: '滑动概览与代表帧深钻',
        goal: '采集全帧分布并深钻代表帧',
        expectedTools: ['invoke_skill'],
        expectedCalls: [{tool: 'invoke_skill', skillId: 'jank_frame_detail'}],
        status: 'completed',
        summary: '已采集全帧根因分布并用 jank_frame_detail 完成代表帧机制级深钻。',
      },
      {
        id: 'p2',
        name: '综合结论',
        goal: '输出完整最终报告',
        expectedTools: [],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '输出包含完整滑动场景合同的最终报告',
    submittedAt: 1,
    toolCallLog: [{
      toolName: 'invoke_skill',
      skillId: 'jank_frame_detail',
      inputSummary: 'jank_frame_detail(frameId)',
      success: true,
      matchedPhaseId: 'p1',
      timestamp: 1,
    }],
  };
}

function createCompletedStartupPlanWithFinalPhase(): any {
  return {
    phases: [
      {
        id: 'p1',
        name: '启动证据采集与根因深钻',
        goal: '采集启动指标、阶段分解与根因证据',
        expectedTools: [],
        status: 'completed',
        summary: '已完成启动类型、TTID/TTFD、阶段耗时和根因证据采集。',
      },
      {
        id: 'p2',
        name: '综合结论',
        goal: '输出完整启动分析报告',
        expectedTools: [],
        status: 'in_progress',
        summary: '',
      },
    ],
    successCriteria: '输出包含完整启动场景合同的最终报告',
    submittedAt: 1,
    toolCallLog: [
      {toolName: 'invoke_skill', skillId: 'anr_analysis', success: true, timestamp: 1},
      {toolName: 'invoke_skill', skillId: 'startup_analysis', success: true, timestamp: 2},
    ],
  };
}

function mockOpenCodePreparation(
  runtime: OpenCodeRuntime,
  plan: any,
  sceneType: 'scrolling' | 'startup' | 'anr',
  prompt: string,
  hypotheses: any[] = [],
): void {
  jest.spyOn(runtime as any, 'prepareAnalysis').mockResolvedValue({
    systemPrompt: 'SmartPerfetto system prompt',
    prompt,
    toolDefinitions: [],
    allowedToolNames: new Set<string>(),
    quickMode: false,
    sceneType,
    packageName: 'com.example.app',
    sessionContext: {addTurn: jest.fn()},
    previousTurns: [],
    analysisPlan: {current: plan, history: []},
    notes: [],
    hypotheses,
    uncertaintyFlags: [],
    analysisRunSpec: {outputLanguage: 'zh-CN'},
  });
}

function mockOpenCodeScrollingPreparation(runtime: OpenCodeRuntime, plan: any): void {
  mockOpenCodePreparation(runtime, plan, 'scrolling', '分析滑动性能');
}

function openCodeAssistantResponse(id: string, text: string): unknown {
  return {
    data: {
      info: {role: 'assistant', finish: 'stop', id},
      parts: [{type: 'text', text}],
    },
  };
}

function createOpenCodeReportModuleLoader(
  responses: Array<unknown | (() => unknown | Promise<unknown>)>,
  promptInputs: unknown[],
  close: () => void,
): OpenCodeSdkModuleLoader {
  const prompt = jest.fn(async (input: unknown) => {
    promptInputs.push(input);
    const nextResponse = responses.shift();
    const response = typeof nextResponse === 'function'
      ? await nextResponse()
      : nextResponse;
    if (response instanceof Error) throw response;
    return response ?? openCodeAssistantResponse('empty', '');
  });
  return jest.fn(async () => ({
    createOpencodeWithEnv: jest.fn(async () => ({
      server: {url: 'http://127.0.0.1:4106', close},
      client: {
        session: {
          create: jest.fn(async () => ({data: {id: 'ses-opencode-report'}})),
          prompt,
        },
      },
    })),
  }));
}

describe('experimental OpenCode runtime contract', () => {
  it('cleans stale dead-owner private directories without deleting a live owner', () => {
    const now = Date.now();
    const liveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-private-live-test-'));
    const deadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-private-dead-test-'));
    const staleDate = new Date(now - 25 * 60 * 60 * 1000);
    try {
      fs.writeFileSync(
        path.join(liveRoot, '.owner.json'),
        JSON.stringify({pid: process.pid, createdAt: now - 26 * 60 * 60 * 1000}),
      );
      fs.writeFileSync(
        path.join(deadRoot, '.owner.json'),
        JSON.stringify({pid: 2_147_483_647, createdAt: now - 26 * 60 * 60 * 1000}),
      );
      fs.utimesSync(liveRoot, staleDate, staleDate);
      fs.utimesSync(deadRoot, staleDate, staleDate);

      openCodeTesting.cleanupStaleEphemeralOpenCodeDirs(now);

      expect(fs.existsSync(liveRoot)).toBe(true);
      expect(fs.existsSync(deadRoot)).toBe(false);
    } finally {
      fs.rmSync(liveRoot, {recursive: true, force: true});
      fs.rmSync(deadRoot, {recursive: true, force: true});
    }
  });

  it('resolves the packaged OpenCode native CLI without relying on PATH shims', () => {
    const cliPath = openCodeTesting.resolveOpenCodeCliPath();
    expect(cliPath).toContain(`${path.sep}opencode-ai${path.sep}bin${path.sep}`);
    expect(fs.statSync(cliPath).isFile()).toBe(true);
  });

  it('keeps draining server output after startup without retaining logs', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;

    const ready = openCodeTesting.waitForOpenCodeServer(child, 1_000);
    child.stdout.write('opencode server listening on http://127.0.0.1:43210\n');

    await expect(ready).resolves.toBe('http://127.0.0.1:43210');
    await Promise.all([
      new Promise<void>(resolve => child.stdout.write(Buffer.alloc(256 * 1024), resolve)),
      new Promise<void>(resolve => child.stderr.write(Buffer.alloc(256 * 1024), resolve)),
    ]);
    expect(child.stdout.readableFlowing).toBe(true);
    expect(child.stderr.readableFlowing).toBe(true);
  });

  it('retries a dynamically selected non-zero port and authenticates the local client', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-opencode-start-test-'));
    const dirs = {
      projectDir: path.join(root, 'project'),
      homeDir: path.join(root, 'home'),
      configDir: path.join(root, 'config'),
    };
    Object.values(dirs).forEach(dir => fs.mkdirSync(dir, {recursive: true}));
    const ports = [43101, 43102];
    const spawned: Array<{args: string[]; env: NodeJS.ProcessEnv}> = [];
    const clientConfig: Array<Record<string, any>> = [];
    try {
      const instance = await openCodeTesting.createOpenCodeInstanceWithExplicitEnv(
        {
          createOpencodeClient: jest.fn((config: Record<string, any>) => {
            clientConfig.push(config);
            return {session: {}};
          }),
        } as any,
        dirs,
        {
          OPENCODE_SERVER_USERNAME: 'host-user',
          OPENCODE_SERVER_PASSWORD: 'host-password',
          SMARTPERFETTO_API_KEY: 'backend-secret-must-not-reach-child',
          SMARTPERFETTO_SSO_COOKIE_SECRET: 'sso-secret-must-not-reach-child',
          OPENAI_API_KEY: 'provider-secret-required-by-child',
          PATH: process.env.PATH,
        },
        {hostname: '127.0.0.1', timeout: 1_000, config: {logLevel: 'error'}},
        {
          allocatePort: jest.fn(async () => ports.shift()!),
          spawnChild: jest.fn((_executable: string, args: string[], options: any) => {
            const child = new EventEmitter() as any;
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.exitCode = null;
            child.signalCode = null;
            child.pid = 4321 + spawned.length;
            child.kill = jest.fn(() => {
              if (child.exitCode === null) {
                child.exitCode = 0;
                queueMicrotask(() => child.emit('exit', 0));
              }
              return true;
            });
            spawned.push({args, env: options.env});
            queueMicrotask(() => {
              if (spawned.length === 1) {
                child.stderr.write('EADDRINUSE: address already in use\n');
                child.exitCode = 1;
                child.emit('exit', 1);
              } else {
                child.stdout.write('opencode server listening on http://127.0.0.1:43102\n');
              }
            });
            return child;
          }),
        },
      );

      expect(spawned).toHaveLength(2);
      expect(spawned.map(item => item.args.find(arg => arg.startsWith('--port='))))
        .toEqual(['--port=43101', '--port=43102']);
      expect(spawned.every(item => !item.args.includes('--port=0'))).toBe(true);
      expect(spawned[1].env.OPENCODE_SERVER_USERNAME).not.toBe('host-user');
      expect(spawned[1].env.OPENCODE_SERVER_PASSWORD).not.toBe('host-password');
      expect(spawned[1].env.SMARTPERFETTO_API_KEY).toBeUndefined();
      expect(spawned[1].env.SMARTPERFETTO_SSO_COOKIE_SECRET).toBeUndefined();
      expect(spawned[1].env.OPENAI_API_KEY).toBe('provider-secret-required-by-child');
      expect(spawned[1].env.PATH).toBe(process.env.PATH);
      const expectedAuth = `Basic ${Buffer.from(
        `${spawned[1].env.OPENCODE_SERVER_USERNAME}:${spawned[1].env.OPENCODE_SERVER_PASSWORD}`,
      ).toString('base64')}`;
      expect(clientConfig).toEqual([expect.objectContaining({
        baseUrl: 'http://127.0.0.1:43102',
        headers: {Authorization: expectedAuth},
      })]);
      await instance.server?.close();
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('terminates the complete OpenCode process tree on Windows', () => {
    expect(openCodeTesting.windowsTaskkillArgs(4321)).toEqual([
      '/PID',
      '4321',
      '/T',
      '/F',
    ]);
  });

  it('describes OpenCode as hidden, server-backed, JSON Schema, and no shell/file tools', () => {
    expect(getOpenCodeEngineCapabilities()).toEqual({
      kind: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      displayName: 'Experimental OpenCode',
      production: false,
      publicRuntime: false,
      promptCache: { systemPromptDynamicBoundary: false },
    });
  });

  it('hardens OpenCode config and disables dangerous built-in tools', () => {
    const config = createOpenCodeHardenedConfig(['smartperfetto_query_trace']);

    expect(config).toMatchObject({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      instructions: [],
      mcp: {},
      lsp: false,
      formatter: false,
      permission: {
        edit: 'deny',
        bash: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      grep: false,
      glob: false,
      edit: false,
      write: false,
      apply_patch: false,
      webfetch: false,
      websearch: false,
      skill: false,
      todowrite: false,
      question: false,
      smartperfetto_query_trace: true,
    });
    expect((config.agent as any).smartperfetto.tools).toMatchObject(
      config.tools as Record<string, unknown>,
    );
  });

  it('adds standalone public MCP only behind the hidden OpenCode MCP gate', () => {
    expect(createOpenCodeStandaloneMcpConfig({})).toEqual({});

    const config = createOpenCodeHardenedConfig([], {
      SMARTPERFETTO_OPENCODE_ENABLE_STANDALONE_MCP: '1',
      SMARTPERFETTO_OPENCODE_MCP_COMMAND_JSON: '["/usr/bin/node","/tmp/smartperfetto-mcp.js"]',
      SMARTPERFETTO_OPENCODE_MCP_TIMEOUT_MS: '7777',
    });

    expect(config.mcp).toEqual({
      smartperfetto: {
        type: 'local',
        enabled: true,
        timeout: 7777,
        command: ['/usr/bin/node', '/tmp/smartperfetto-mcp.js'],
        environment: {
          SMARTPERFETTO_STANDALONE_MCP: '1',
        },
      },
    });
    expect(config.tools).toMatchObject({
      bash: false,
      read: false,
      edit: false,
      write: false,
      apply_patch: false,
      lookup_blog_knowledge: true,
      smartperfetto_lookup_blog_knowledge: true,
      mcp__smartperfetto__lookup_blog_knowledge: true,
    });
  });

  it('uses the engine-local loader-free OpenCode MCP bridge child', () => {
    const command = openCodeTesting.resolveOpenCodeBridgeCommand({});

    expect(command).toEqual([
      process.execPath,
      path.resolve(
        process.cwd(),
        'src/agentRuntime/engines/opencode/openCodeMcpBridgeChild.cjs',
      ),
    ]);
  });

  it('closes unauthenticated MCP bridge clients before they can buffer an oversized frame', async () => {
    const bridge = await openCodeTesting.startOpenCodeMcpBridge([]);
    const socket = net.createConnection({host: '127.0.0.1', port: bridge.port});
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));

    socket.write('x'.repeat(65 * 1024));
    await closed;

    expect(bridge.getDiagnostics().lastError).toBe('bridge_request_too_large');
    await bridge.close();
  });

  it('accepts the configured SmartPerfetto MCP bridge only after OpenCode reports it connected', async () => {
    const status = jest.fn(async (_input?: unknown) => ({
      data: {smartperfetto: {status: 'connected'}},
    }));

    await expect(openCodeTesting.assertOpenCodeMcpReady({mcp: {status}} as any, '/tmp/project'))
      .resolves.toBeUndefined();
    expect(status).toHaveBeenCalledWith({query: {directory: '/tmp/project'}});
  });

  it('fails before prompting when OpenCode cannot connect the SmartPerfetto MCP bridge', async () => {
    const diagnostics = {
      connectionCount: 0,
      requestCount: 0,
    };
    const status = jest.fn(async (_input?: unknown) => {
      diagnostics.connectionCount = 1;
      diagnostics.requestCount = 2;
      return {
        data: {
          smartperfetto: {
            status: 'failed',
            error: 'bridge child exited before initialization',
          },
        },
      };
    });

    await expect(openCodeTesting.assertOpenCodeMcpReady(
      {mcp: {status}} as any,
      '/tmp/project',
      () => diagnostics,
    )).rejects.toThrow(
      'bridge child exited before initialization (connections=1, requests=2',
    );
  });

  it('enumerates conservative standalone MCP tool-name variants for OpenCode', () => {
    expect(createOpenCodeStandaloneMcpToolNames()).toEqual(
      expect.arrayContaining([
        'lookup_blog_knowledge',
        'smartperfetto_lookup_blog_knowledge',
        'mcp__smartperfetto__lookup_blog_knowledge',
        'recall_similar_case',
        'smartperfetto_recall_similar_case',
        'mcp__smartperfetto__recall_similar_case',
      ]),
    );
  });

  it('builds per-request tool allowlists by denying built-ins first', () => {
    expect(createOpenCodeToolAllowlist(['smartperfetto_query_trace'])).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      read: false,
      apply_patch: false,
      smartperfetto_query_trace: true,
    });
  });

  it('extracts final assistant text without leaking user prompts or reasoning', () => {
    const response = {
      data: [
        {
          info: { role: 'user' },
          parts: [{ type: 'text', text: '用户原始问题，不应作为报告' }],
        },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'step-start' },
            { type: 'reasoning', text: 'internal reasoning should not leak' },
            { type: 'text', text: '最终报告正文' },
            { type: 'step-finish' },
          ],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe('最终报告正文');
  });

  it('prefers a full assistant report over a later short assistant summary', () => {
    const fullReport = [
      '# 启动性能分析报告',
      '',
      '## 结论',
      '这是 OpenCode 生成的完整报告正文。',
      '',
      '## 证据',
      '- smartperfetto_query_trace 返回了启动阶段证据。',
      '',
      '## 建议',
      '继续保留完整证据链。',
    ].join('\n');
    const response = {
      data: [
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: fullReport }],
        },
        {
          info: { role: 'assistant', finish: 'stop' },
          parts: [{ type: 'text', text: '分析完成，完整报告已经生成。' }],
        },
      ],
    };

    expect(extractOpenCodeAssistantText(response)).toBe(fullReport);
  });

  it('uses OpenCode promptAsync and polls completed assistant messages', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({
        data: [
          {
            info: { role: 'assistant', finish: 'stop' },
            parts: [{ type: 'text', text: '异步最终报告' }],
          },
        ],
      });
    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith({
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project', limit: 50, order: 'asc' },
    });
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('异步最终报告');
  });

  it('waits for the target OpenCode session to become idle after an intermediate message completes', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const intermediateAssistant = {
      info: { role: 'assistant', finish: 'tool-calls', id: 'msg-intermediate' },
      parts: [{ type: 'text', text: '先提交分析计划，再继续调用工具。' }],
    };
    const finalAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-final' },
      parts: [{ type: 'text', text: '完整最终报告' }],
    };
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [intermediateAssistant] })
      .mockResolvedValueOnce({ data: [intermediateAssistant, finalAssistant] });
    const status = jest.fn<any>()
      .mockResolvedValueOnce({ data: { 'ses-opencode': { type: 'busy' } } })
      .mockResolvedValueOnce({ data: { 'ses-opencode': { type: 'idle' } } });

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
          status,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(status).toHaveBeenCalledTimes(2);
    expect(messages).toHaveBeenCalledTimes(3);
    expect((result.messagesResponse as any).data.at(-1)).toEqual(finalAssistant);
  }, 10_000);

  it('falls back to a completed assistant message when status omits the target session', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          info: { role: 'assistant', finish: 'stop', id: 'msg-final' },
          parts: [{ type: 'text', text: '目标会话最终报告' }],
        }],
      });
    const status = jest.fn(async () => ({ data: { 'ses-other': { type: 'idle' } } }));

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
          status,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 5_000,
    });

    expect(status).toHaveBeenCalledTimes(1);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('目标会话最终报告');
  });

  it('does not return an assistant message that existed before the async prompt', async () => {
    const promptAsync = jest.fn(async (_input?: unknown) => ({ response: { status: 204 } }));
    const oldAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-old' },
      parts: [{ type: 'text', text: '上一轮旧报告' }],
    };
    const newAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-new' },
      parts: [{ type: 'text', text: '本轮新报告' }],
    };
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [oldAssistant] })
      .mockResolvedValueOnce({ data: [oldAssistant, newAssistant] });

    const result = await runOpenCodePrompt({
      client: {
        session: {
          prompt: jest.fn(),
          promptAsync,
          messages,
        },
      },
      server: { url: 'http://127.0.0.1:4106', close: jest.fn() },
    } as any, {
      path: { id: 'ses-opencode' },
      query: { directory: '/tmp/project' },
      body: { parts: [{ type: 'text', text: '继续分析启动性能' }] },
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 4_000,
    });

    expect(messages).toHaveBeenCalledTimes(3);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('本轮新报告');
  });

  it('does not return a longer assistant report that existed before a synchronous prompt', async () => {
    const oldAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-old' },
      parts: [{ type: 'text', text: [
        '# 上一轮旧报告',
        '',
        '## 旧结论',
        '这是已经存在于会话历史中的长报告，不得被本轮同步 prompt 重新选中。'.repeat(20),
      ].join('\n') }],
    };
    const newAssistant = {
      info: { role: 'assistant', finish: 'stop', id: 'msg-new' },
      parts: [{ type: 'text', text: '本轮同步短报告' }],
    };
    const prompt = jest.fn(async () => ({data: newAssistant}));
    const messages = jest.fn<any>()
      .mockResolvedValueOnce({data: [oldAssistant]})
      .mockResolvedValueOnce({data: [oldAssistant, newAssistant]});

    const result = await runOpenCodePrompt({
      client: {session: {prompt, messages}},
      server: {url: 'http://127.0.0.1:4106', close: jest.fn()},
    } as any, {
      path: {id: 'ses-opencode'},
      query: {directory: '/tmp/project'},
      body: {parts: [{type: 'text', text: '继续分析启动性能'}]},
    }, {
      sessionId: 'ses-opencode',
      projectDir: '/tmp/project',
      timeoutMs: 4_000,
    });

    expect(messages).toHaveBeenCalledTimes(2);
    expect(extractOpenCodeAssistantText(result.messagesResponse)).toBe('本轮同步短报告');
  });

  it('emits SmartPerfetto tool dispatch and response events from the OpenCode MCP bridge', async () => {
    const updates: any[] = [];
    const handler = jest.fn(async (args: Record<string, unknown>, extra: any) => ({
      content: [{ type: 'text', text: `ran ${args.sql} aborted=${extra.signal?.aborted ?? null}` }],
    }));
    const controller = new AbortController();
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler,
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-1',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    }, update => updates.push(update), {
      getSignal: () => controller.signal,
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-1',
      result: {
        content: [{ type: 'text', text: 'ran select 1 aborted=false' }],
      },
    });
    expect(handler).toHaveBeenCalledWith(
      { sql: 'select 1' },
      { runtime: 'opencode', signal: controller.signal },
    );
    expect(updates).toEqual([
      expect.objectContaining({
        type: 'agent_task_dispatched',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          toolName: 'smartperfetto_query_trace',
          args: { sql: 'select 1' },
        }),
      }),
      expect.objectContaining({
        type: 'agent_response',
        content: expect.objectContaining({
          taskId: 'tool-call-1',
          result: 'ran select 1 aborted=false',
        }),
      }),
    ]);
  });

  it('projects private wiki results before emitting OpenCode responses', async () => {
    const updates: any[] = [];
    await dispatchOpenCodeBridgeRequest([{
      name: 'lookup_blog_knowledge',
      exposure: 'internal',
      tool: {},
      shared: {
        name: 'lookup_blog_knowledge',
        description: 'Lookup knowledge',
        exposure: 'internal',
        inputSchema: {},
        handler: jest.fn(async () => ({content: [{type: 'text', text: JSON.stringify({result: {
          query: 'Handler',
          probed: ['android_internals_wiki'],
          retrievedAt: 1,
          legacyPath: false,
          hits: [{
            chunkId: 'wiki-1',
            score: 1,
            metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
            snippet: 'OPENCODE_PRIVATE_WIKI_CANARY',
          }],
        }})}]})),
      },
    } as any], {
      jsonrpc: '2.0',
      id: 'wiki-call',
      method: 'tools/call',
      params: {name: 'lookup_blog_knowledge', arguments: {}},
    }, update => updates.push(update));

    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENCODE_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('records OpenCode MCP bridge tool executions into the shared analysis plan evidence log', async () => {
    const plan = {
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'in_progress',
          summary: '',
        },
      ],
      successCriteria: '完整解释代表掉帧根因',
      submittedAt: 1,
      toolCallLog: [],
    } as any;
    const response = await dispatchOpenCodeBridgeRequest([
      {
        name: 'invoke_skill',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'invoke_skill',
          description: 'Invoke a SmartPerfetto skill',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => ({
            content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
          })),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      method: 'tools/call',
      params: {
        name: 'mcp__smartperfetto__invoke_skill',
        arguments: { skillId: 'jank_frame_detail', params: { frameId: 59665219 } },
      },
    }, undefined, {
      analysisPlan: { current: plan },
    });

    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'tool-call-frame-detail',
      result: {
        content: [{ type: 'text', text: '{"planPhaseId":"p-frame-detail","ok":true}' }],
      },
    });
    expect(plan.toolCallLog).toEqual([
      expect.objectContaining({
        toolName: 'invoke_skill',
        skillId: 'jank_frame_detail',
        inputSummary: 'jank_frame_detail(frameId)',
        matchedPhaseId: 'p-frame-detail',
      }),
    ]);
  });

  it('rethrows bridge tool cancellation instead of returning a JSON-RPC tool error', async () => {
    await expect(dispatchOpenCodeBridgeRequest([
      {
        name: 'smartperfetto_query_trace',
        exposure: 'internal',
        tool: {},
        shared: {
          name: 'smartperfetto_query_trace',
          description: 'Run a trace query',
          exposure: 'internal',
          inputSchema: {},
          handler: jest.fn(async () => {
            throw createTraceProcessorQueryCancelledError();
          }),
        },
      } as any,
    ], {
      jsonrpc: '2.0',
      id: 'tool-call-cancel',
      method: 'tools/call',
      params: {
        name: 'smartperfetto_query_trace',
        arguments: { sql: 'select 1' },
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats completed and skipped OpenCode plan phases as closed', () => {
    expect(getOpenCodePlanCompletionStatus({
      phases: [
        { id: 'p1', status: 'completed', summary: '已完成概览采集并记录关键证据。' },
        { id: 'p2', status: 'skipped', summary: '已确认该阶段在当前 trace 中不可验证并跳过。' },
      ],
    } as any)).toMatchObject({ complete: true, pending: [] });

    expect(getOpenCodePlanCompletionStatus({
      phases: [
        { id: 'p1', status: 'completed', summary: '已完成概览采集并记录关键证据。' },
        { id: 'p2', status: 'in_progress' },
      ],
    } as any)).toMatchObject({ complete: false, pending: ['p2'] });
  });

  it('does not treat a completed OpenCode phase as closed when required tool evidence is missing', () => {
    const status = getOpenCodePlanCompletionStatus({
      phases: [
        {
          id: 'p-frame-detail',
          name: '代表帧深钻',
          goal: '调用 jank_frame_detail 获取代表掉帧调用栈',
          expectedTools: ['invoke_skill'],
          expectedCalls: [{ tool: 'invoke_skill', skillId: 'jank_frame_detail' }],
          status: 'completed',
          summary: '已完成代表帧根因分析，并整理出主线程阻塞调用栈证据。',
        },
      ],
      toolCallLog: [],
    } as any);

    expect(status).toMatchObject({
      complete: false,
      pending: ['p-frame-detail'],
    });
    expect(status.evidenceGaps?.[0].missingExpectedCalls).toEqual([
      { tool: 'invoke_skill', skillId: 'jank_frame_detail' },
    ]);
  });

  it('auto-closes only the final OpenCode report phase after a deliverable report is present', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '概览采集',
          goal: '采集滑动概览',
          status: 'completed',
          summary: '已采集滑动概览、掉帧数量和最长帧耗时等关键证据。',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整分析报告',
          status: 'in_progress',
        },
      ],
    } as any;
    const report = [
      '# 滑动性能分析报告',
      '',
      '## 代表帧分析',
      '- evidence/source: art-frame-detail 显示主线程阻塞 18.2ms。',
      '',
      '## 优化建议',
      '- 将长任务拆分到异步阶段。',
    ].join('\n');

    const closed = completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 42);

    expect(closed?.id).toBe('p3');
    expect(plan.phases[1]).toMatchObject({
      status: 'completed',
      completedAt: 42,
      summary: expect.stringContaining('最终报告已由 OpenCode 直接交付'),
    });
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({ complete: true, pending: [] });
  });

  it('auto-closes the sole pending OpenCode conclusion phase after a deliverable report is present', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '架构检测与概览采集',
          goal: '执行 scrolling_analysis 获取帧统计和卡顿分布',
          status: 'completed',
          summary: '已完成帧统计、掉帧分布和关键证据采集。',
        },
        {
          id: 'p2',
          name: '根因深钻',
          goal: '对主要 reason_code 选取代表帧完成结构化深钻',
          status: 'completed',
          summary: '已完成代表帧根因、阻塞调用和阻塞链交叉验证。',
        },
        {
          id: 'p3',
          name: 'CPU与系统验证',
          goal: '分析 CPU 调度、频率等系统层因素',
          status: 'completed',
          summary: '已完成 CPU 调度、频率和系统侧证据核对。',
        },
        {
          id: 'p4',
          name: '综合结论',
          goal: '汇总所有证据，输出结构化最终报告',
          status: 'pending',
        },
      ],
    } as any;
    const report = [
      '## 综合结论',
      '',
      '主线程 animation 回调是主要卡顿来源。',
      '',
      '## 代表帧分析',
      '- evidence/source: art-frame-detail 显示主线程阻塞 59.31ms。',
      '',
      '## 优化建议',
      '- 将长任务拆分到异步阶段。',
    ].join('\n');

    const closed = completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 45);

    expect(closed?.id).toBe('p4');
    expect(plan.phases[3]).toMatchObject({
      status: 'completed',
      completedAt: 45,
      summary: expect.stringContaining('最终报告已由 OpenCode 直接交付'),
    });
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({complete: true, pending: []});
  });

  it('does not auto-close a sole pending phase that is not conclusion-like', () => {
    const plan = {
      phases: [{
        id: 'p1',
        name: '代表帧深钻',
        goal: '调用 jank_frame_detail 获取代表帧证据',
        status: 'pending',
      }],
    } as any;
    const report = '## 综合结论\n\n主线程 animation 回调是主要卡顿来源。';

    expect(completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 46))
      .toBeUndefined();
    expect(plan.phases[0].status).toBe('pending');
  });

  it('does not auto-close a pending conclusion phase with missing expected-call evidence', () => {
    const plan = {
      phases: [{
        id: 'p1',
        name: '综合结论',
        goal: '汇总证据并输出完整报告',
        expectedCalls: [{tool: 'invoke_skill', skillId: 'blocking_chain_analysis'}],
        status: 'pending',
      }],
      toolCallLog: [],
    } as any;
    const report = '## 综合结论\n\n主线程 animation 回调是主要卡顿来源。';

    expect(completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 47))
      .toBeUndefined();
    expect(plan.phases[0].status).toBe('pending');
  });

  it('auto-closes the real startup report-output phase after a deliverable report is present', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动概览与类型判定',
          goal: '获取启动指标、TTID/TTFD 和启动类型',
          status: 'completed',
          summary: '已完成启动类型、TTID/TTFD 和主线程热点证据采集。',
        },
        {
          id: 'p2',
          name: '启动阶段分解与阻塞分析',
          goal: '分解阶段耗时和关键阻塞关系',
          status: 'completed',
          summary: '已完成四象限、热点任务、阻塞链和关键阶段证据核对。',
        },
        {
          id: 'p3',
          name: '根因综合与报告输出',
          goal: '综合所有证据，输出启动分析报告、根因编号引用、分层建议',
          status: 'in_progress',
        },
      ],
    } as any;
    const report = [
      '## 综合结论',
      '',
      '冷启动耗时 1338.65ms，ChaosTask 是主要热点。',
      '',
      '## 优化建议',
      '- [App 层] 将非关键初始化移至首帧后。',
      '',
      '## 证据索引',
      '- evidence/source: art-startup-detail',
    ].join('\n');

    const closed = completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 44);

    expect(closed?.id).toBe('p3');
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({complete: true, pending: []});
  });

  it('requests one bounded final-report continuation and uses only the corrected OpenCode report', async () => {
    const initialReport = [
      '# Final Report',
      '',
      '## 综合结论',
      '已完成滑动证据采集，但本稿尚未展开场景合同必需小节。',
    ].join('\n');
    const correctedReport = [
      '# Final Report',
      '',
      '## 综合结论',
      '当前采集窗口共 347 帧，真实掉帧 1 帧，最长帧 62.73ms。',
      '',
      '## 峰值/口径指标',
      '真实掉帧 1 帧；最长帧 62.73ms；Buffer Stuffing 假阳性已单独排除。',
      '',
      '## 全帧根因分布',
      '| 根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| workload_heavy | 1 | 100% |',
      '',
      '## 代表帧分析',
      '代表帧 frame_id=59665234，帧耗时 62.73ms，超预算 7.5x，vsync_missed=7。',
      'jank_frame_detail 证据显示主线程 animation 回调内的同步重计算构成关键阻塞链。',
      '',
      '## 优化建议',
      '将同步重计算拆分并移出主线程 animation 回调。',
    ].join('\n');
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', initialReport),
        openCodeAssistantResponse('corrected', correctedReport),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect((promptInputs[1] as any).body.parts[0].text).toContain('Final Report Contract');
    expect((promptInputs[1] as any).body.parts[0].text).toContain('全帧根因分布');
    expect(result.conclusion).toContain('## 全帧根因分布');
    expect(result.conclusion).toContain('## 代表帧分析');
    expect(result.conclusion).not.toContain('本稿尚未展开');
    expect(result.partial).not.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('delivers a verified completed final-phase report instead of an older OpenCode compaction summary', async () => {
    const completedReport = [
      '## 综合结论与报告',
      '',
      '当前采集窗口共 347 帧，真实掉帧 1 帧，最长帧 62.73ms。',
      '',
      '## 峰值/口径指标',
      '真实掉帧 1 帧；最长帧 62.73ms；Buffer Stuffing 假阳性已单独排除。',
      '',
      '## 全帧根因分布',
      '| 根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| workload_heavy | 1 | 100% |',
      '',
      '## 代表帧分析',
      '代表帧 frame_id=59665234，帧耗时 62.73ms，超预算 7.5x，vsync_missed=7。',
      'jank_frame_detail 证据显示主线程 animation 回调内的同步重计算构成关键阻塞链。',
      '',
      '## 优化建议',
      '将同步重计算拆分并移出主线程 animation 回调。',
    ].join('\n');
    const plan = createCompletedScrollingPlanWithFinalPhase();
    plan.phases[1].status = 'completed';
    plan.phases[1].summary = completedReport;
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('compaction', [
          '## Objective',
          '分析滑动性能。',
          '',
          '## Work State',
          '仍在整理最终报告。',
          '',
          '## Next Move',
          '继续输出最终报告。',
        ].join('\n')),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, plan);

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-final-phase-report',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(1);
    expect(result.conclusion).toContain('## 综合结论');
    expect(result.conclusion).toContain('## 全帧根因分布');
    expect(result.conclusion).not.toContain('## Objective');
    expect(result.partial).not.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('includes the exact missing startup contract section in the continuation prompt', async () => {
    const startupReport = (includeRootCauseSection: boolean) => [
      '## 综合结论',
      '',
      '本次为温启动，dur_ms=1339ms，TTID=1912ms，TTFD 不可用；关键延迟集中在应用主线程同步初始化。',
      '',
      '## 阶段耗时分解',
      'startup_detail 的 evidence/source: art-startup-detail 显示主线程热点 self_ms=456ms，占已观测启动窗口的 34.1%。',
      '',
      '## 关键证据链',
      'evidence/source: art-startup-detail 将 456ms 主线程热点定位到 bindApplication 阶段；evidence/source: art-main-thread 记录同一窗口内连续同步初始化。',
      '两条证据在时间窗口与线程身份上相互印证，当前没有观察到等量级的平台侧阻塞证据。',
      ...(includeRootCauseSection ? [
        '',
        '## 根因编号引用',
        'SR12：bindApplication 阶段的同步初始化占比过高；对应 evidence/source: art-startup-detail，self_ms=456ms。',
      ] : []),
      '',
      '## 已排除因素',
      '当前 trace 未显示足以解释 1339ms 启动窗口的平台侧 Binder、锁竞争或磁盘 IO 证据。',
      '',
      '## App/系统分层建议',
      '**[App 层]** 将 art-startup-detail 指向的非关键同步初始化移至首帧后，并复测 TTID 与 456ms 热点。',
      '**[系统/平台层]** 当前 trace 没有平台归因证据，不建议据此修改系统调度或 IO 策略。',
    ].join('\n');
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', startupReport(false)),
        openCodeAssistantResponse('corrected', startupReport(true)),
      ], promptInputs, close),
    });
    mockOpenCodePreparation(
      runtime,
      createCompletedStartupPlanWithFinalPhase(),
      'anr',
      '请调用 anr_analysis 检查这个启动 Trace 是否包含 ANR。',
    );

    const result = await runtime.analyze(
      '请调用 anr_analysis 检查这个启动 Trace 是否包含 ANR。',
      'session-opencode-startup-contract-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect((promptInputs[1] as any).body.parts[0].text).toContain('根因编号引用');
    expect(result.conclusion).toContain('## 根因编号引用');
    expect(result.conclusion).toContain('SR12');
    expect(result.partial).not.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requests one bounded continuation when a complete report violates the kernel-wait boundary', async () => {
    const completeScrollingReport = (kernelBoundary: string) => [
      '# Final Report',
      '',
      '## 综合结论',
      '当前采集窗口共 347 帧，真实掉帧 1 帧，最长帧 62.73ms。',
      '',
      '## 峰值/口径指标',
      '真实掉帧 1 帧；最长帧 62.73ms；Buffer Stuffing 假阳性已单独排除。',
      '',
      '## 全帧根因分布',
      '| 根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| workload_heavy | 1 | 100% |',
      '',
      '## 代表帧分析',
      '代表帧 frame_id=59665234，帧耗时 62.73ms，超预算 7.5x，vsync_missed=7。',
      'jank_frame_detail 证据显示主线程 animation 回调内的同步重计算构成关键阻塞链。',
      '',
      '## 内核等待边界',
      kernelBoundary,
      '',
      '## 优化建议',
      '将同步重计算拆分并移出主线程 animation 回调。',
    ].join('\n');
    const initialReport = completeScrollingReport('D 状态证明磁盘 IO 是根因。');
    const correctedReport = completeScrollingReport(
      'D 状态只是不可中断等待，仍需 IO 证据才能证明根因。当前 trace 未提供可验证的文件或数据库活动，因此本报告不把它列为磁盘 IO 根因。',
    );
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', initialReport),
        openCodeAssistantResponse('corrected', correctedReport),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-quality-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect((promptInputs[1] as any).body.parts[0].text).toContain(
      'D/DK 只能说明不可中断等待',
    );
    expect((promptInputs[1] as any).body.parts[0].text).toContain(
      'D 状态证明磁盘 IO 是根因',
    );
    expect(result.conclusion).toContain('不把它列为磁盘 IO 根因');
    expect(result.conclusion).not.toContain('D 状态证明磁盘 IO 是根因');
    expect(result.partial).not.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps an invalid OpenCode continuation partial instead of repairing it into success', async () => {
    const initialReport = '# Final Report\n\n## 综合结论\n初稿缺少滑动场景合同结构。';
    const invalidContinuation = '我已经检查了报告，但还需要继续整理结构。';
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', initialReport),
        openCodeAssistantResponse('invalid', invalidContinuation),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-invalid-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect(result.conclusion).toBe(initialReport);
    expect(result.partial).toBe(true);
    expect(result.terminationReason).toBe('plan_incomplete');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses bounded plan continuations and requires a fresh report after evidence completion', async () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '概览证据',
          goal: '采集概览证据',
          expectedTools: [],
          status: 'in_progress',
          summary: '',
        },
        {
          id: 'p2',
          name: '根因证据',
          goal: '采集根因证据',
          expectedTools: [],
          status: 'pending',
          summary: '',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整最终报告',
          expectedTools: [],
          status: 'pending',
          summary: '',
        },
      ],
      successCriteria: '完成证据采集并输出最终报告',
      submittedAt: 1,
      toolCallLog: [],
    };
    const initialReport = '# Final Report\n\n## 综合结论\n这是补证前的旧报告。';
    const correctedReport = [
      '# Final Report',
      '',
      '## 综合结论',
      '当前采集窗口共 347 帧，真实掉帧 1 帧，最长帧 62.73ms。',
      '',
      '## 峰值/口径指标',
      '真实掉帧 1 帧；最长帧 62.73ms；Buffer Stuffing 假阳性已单独排除。',
      '',
      '## 全帧根因分布',
      '| 根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| workload_heavy | 1 | 100% |',
      '',
      '## 代表帧分析',
      '代表帧 frame_id=59665234，帧耗时 62.73ms，超预算 7.5x，vsync_missed=7。',
      'jank_frame_detail 证据显示同步重计算构成关键阻塞链。',
      '',
      '## 优化建议',
      '将同步重计算拆分并移出主线程 animation 回调。',
    ].join('\n');
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', initialReport),
        () => {
          plan.phases[0].status = 'completed';
          plan.phases[0].summary = '概览证据已经完成采集、身份核对、口径确认和关键指标复核。';
          return openCodeAssistantResponse('plan-1', '已闭合 p1，继续处理剩余阶段。');
        },
        () => {
          plan.phases[1].status = 'completed';
          plan.phases[1].summary = '根因证据已经完成采集、因果链核对和反向证据排除。';
          plan.phases[2].status = 'completed';
          plan.phases[2].summary = '全部证据阶段已经完成，等待输出吸收最新证据的最终报告。';
          return openCodeAssistantResponse('plan-2', '所有计划阶段已经闭合。');
        },
        openCodeAssistantResponse('corrected', correctedReport),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, plan);

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-plan-completion',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(4);
    expect((promptInputs[1] as any).body.parts[0].text).toContain('p1');
    expect((promptInputs[2] as any).body.parts[0].text).toContain('p2');
    expect((promptInputs[3] as any).body.parts[0].text).toContain('Final Report Contract');
    expect(result.conclusion).toContain('## 全帧根因分布');
    expect(result.conclusion).not.toContain('补证前的旧报告');
    expect(result.partial).not.toBe(true);
    expect(result.rounds).toBe(4);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops after two plan continuations and remains partial when required evidence is still missing', async () => {
    const plan = createCompletedScrollingPlanWithFinalPhase();
    plan.phases[0].status = 'completed';
    plan.phases[0].summary = '阶段摘要足够长，但 legacy expectedTools 的匹配工具证据仍然缺失。';
    plan.phases[0].expectedCalls = [];
    plan.toolCallLog = [];
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', '# Final Report\n\n## 综合结论\n证据仍未补齐。'),
        openCodeAssistantResponse('plan-1', '第一次补全仍未获得所需工具证据。'),
        openCodeAssistantResponse('plan-2', '第二次补全仍未获得所需工具证据。'),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, plan);

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-plan-still-incomplete',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(3);
    expect((promptInputs[1] as any).body.parts[0].text).toContain(
      '"missingGenericToolEvidence": true',
    );
    expect(result.partial).toBe(true);
    expect(result.terminationMessage).toContain('p1');
    expect(result.rounds).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses one independent continuation to resolve a formed hypothesis', async () => {
    const plan = createCompletedScrollingPlanWithFinalPhase();
    plan.phases[1].status = 'completed';
    plan.phases[1].summary = '完整最终报告阶段已经完成并记录了足够长的交付摘要。';
    const hypotheses: any[] = [{
      id: 'h1',
      statement: '同步重计算是代表帧的主要根因',
      basis: '代表帧耗时与主线程热点重叠',
      status: 'formed',
      supportingEvidence: [],
    }];
    const completeReport = [
      '# Final Report',
      '',
      '## 综合结论',
      '当前采集窗口共 347 帧，真实掉帧 1 帧，最长帧 62.73ms。',
      '',
      '## 峰值/口径指标',
      '真实掉帧 1 帧；最长帧 62.73ms；Buffer Stuffing 假阳性已单独排除。',
      '',
      '## 全帧根因分布',
      '| 根因 | 帧数 | 占比 |',
      '| --- | ---: | ---: |',
      '| workload_heavy | 1 | 100% |',
      '',
      '## 代表帧分析',
      '代表帧 frame_id=59665234，帧耗时 62.73ms，超预算 7.5x，vsync_missed=7。',
      'jank_frame_detail 证据确认同步重计算构成关键阻塞链。',
      '',
      '## 优化建议',
      '将同步重计算拆分并移出主线程 animation 回调。',
    ].join('\n');
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', completeReport),
        () => {
          hypotheses[0].status = 'confirmed';
          hypotheses[0].supportingEvidence = ['art-frame-detail'];
          return openCodeAssistantResponse('hypothesis', completeReport);
        },
      ], promptInputs, close),
    });
    mockOpenCodePreparation(runtime, plan, 'scrolling', '分析滑动性能', hypotheses);

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-hypothesis-resolution',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect((promptInputs[1] as any).body.parts[0].text).toContain('"id": "h1"');
    expect(result.hypotheses[0].status).toBe('confirmed');
    expect(result.partial).not.toBe(true);
    expect(result.rounds).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-abort plan-continuation failure sticky partial', async () => {
    const plan = createCompletedScrollingPlanWithFinalPhase();
    plan.phases[0].status = 'in_progress';
    plan.phases[0].summary = '';
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', '# Final Report\n\n## 综合结论\n当前报告仍缺证。'),
        new Error('provider stream terminated'),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, plan);

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-plan-continuation-failed',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect(result.partial).toBe(true);
    expect(result.terminationMessage).toContain('计划补全失败');
    expect(result.rounds).toBe(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the original OpenCode report partial when a continuation fails', async () => {
    const initialReport = '# Final Report\n\n## 综合结论\n初稿缺少滑动场景合同结构。';
    const promptInputs: unknown[] = [];
    const close = jest.fn();
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: createOpenCodeReportModuleLoader([
        openCodeAssistantResponse('initial', initialReport),
        new Error('provider stream terminated'),
      ], promptInputs, close),
    });
    mockOpenCodeScrollingPreparation(runtime, createCompletedScrollingPlanWithFinalPhase());

    const result = await runtime.analyze(
      '分析滑动性能',
      'session-opencode-failed-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );

    expect(promptInputs).toHaveLength(2);
    expect(result.conclusion).toBe(initialReport);
    expect(result.partial).toBe(true);
    expect(result.terminationMessage).toContain('补写失败');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rethrows a real aborted OpenCode plan continuation and closes each resource once', async () => {
    const promptInputs: unknown[] = [];
    const closeServer = jest.fn<() => void>();
    let rejectContinuation: ((reason?: unknown) => void) | undefined;
    let continuationStartedResolve: (() => void) | undefined;
    const continuationStarted = new Promise<void>(resolve => {
      continuationStartedResolve = resolve;
    });
    const prompt = jest.fn(async (input: unknown) => {
      promptInputs.push(input);
      if (promptInputs.length === 1) {
        return openCodeAssistantResponse(
          'initial',
          '# Final Report\n\n## 综合结论\n初稿缺少滑动场景合同结构。',
        );
      }
      continuationStartedResolve?.();
      return new Promise<never>((_resolve, reject) => {
        rejectContinuation = reject;
      });
    });
    const abort = jest.fn(async () => {
      rejectContinuation?.(new Error('OpenCode prompt aborted'));
      return {data: true};
    });
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput({
      selection: {kind: OPENCODE_RUNTIME_KIND, source: 'env'},
    }), {
      env: {
        SMARTPERFETTO_OPENCODE_MODEL_JSON:
          '{"providerID":"smartperfetto","modelID":"test-model"}',
      },
      moduleLoader: jest.fn(async () => ({
        createOpencodeWithEnv: jest.fn(async () => ({
          server: {url: 'http://127.0.0.1:4106', close: closeServer},
          client: {
            session: {
              create: jest.fn(async () => ({data: {id: 'ses-opencode-report'}})),
              prompt,
              abort,
            },
          },
        })),
      })),
    });
    const plan = createCompletedScrollingPlanWithFinalPhase();
    plan.phases[0].status = 'in_progress';
    plan.phases[0].summary = '';
    mockOpenCodeScrollingPreparation(runtime, plan);

    const analysis = runtime.analyze(
      '分析滑动性能',
      'session-opencode-aborted-continuation',
      'trace-opencode',
      {analysisMode: 'full'},
    );
    const rejection = analysis.then(
      () => undefined,
      error => error as Error,
    );
    await continuationStarted;
    const activeHandle = (runtime as any).activeSessions.get(
      'session-opencode-aborted-continuation',
    );
    const originalCloseBridge = activeHandle.closeBridge;
    const closeBridge = jest.fn(async () => originalCloseBridge?.());
    activeHandle.closeBridge = closeBridge;

    await runtime.abortSession('session-opencode-aborted-continuation');

    await expect(rejection).resolves.toMatchObject({message: 'OpenCode prompt aborted'});
    expect(promptInputs).toHaveLength(2);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeBridge).toHaveBeenCalledTimes(1);
  });

  it('recognizes a structurally named conclusion phase when auto-closing a delivered report', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '启动证据对比',
          goal: '采集并核对双端启动证据',
          status: 'completed',
          summary: '已完成双端启动证据对比与根因交叉验证。',
        },
        {
          id: 'p2',
          name: '结构化结论',
          goal: '输出 Delta 表格、根因分析和分层建议',
          status: 'in_progress',
        },
      ],
    } as any;
    const report = [
      '## 综合结论',
      '',
      '左侧冷启动显著慢于右侧。',
      '',
      '## 关键证据',
      '- evidence/source: art-startup 显示 TTID 差异。',
    ].join('\n');

    const closed = completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 43);

    expect(closed?.id).toBe('p2');
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({ complete: true, pending: [] });
  });

  it('removes provider process narration before a delivered OpenCode report', () => {
    expect(sanitizeOpenCodeConclusionText([
      'Now I have all evidence. Let me produce the final comprehensive analysis report.',
      '',
      '---',
      '',
      '## 综合结论',
      '',
      '主线程 animation 回调是主要卡顿来源。',
    ].join('\n'))).toBe([
      '## 综合结论',
      '',
      '主线程 animation 回调是主要卡顿来源。',
    ].join('\n'));
  });

  it('does not auto-close OpenCode phases when earlier work is still pending', () => {
    const plan = {
      phases: [
        {
          id: 'p1',
          name: '概览采集',
          goal: '采集滑动概览',
          status: 'in_progress',
        },
        {
          id: 'p3',
          name: '综合结论',
          goal: '输出完整分析报告',
          status: 'pending',
        },
      ],
    } as any;
    const report = '# 滑动性能分析报告\n\n## 代表帧分析\n- evidence/source: art-frame-detail';

    expect(completeOpenCodeFinalReportPhaseIfDelivered(plan, report, 'zh-CN', () => 42)).toBeUndefined();
    expect(getOpenCodePlanCompletionStatus(plan)).toMatchObject({ complete: false, pending: ['p1', 'p3'] });
  });

  it('projects OpenCode events without synthesizing route terminal events', () => {
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.text.delta.1',
      data: { delta: 'hello' },
    }, 10)).toEqual({
      type: 'answer_token',
      content: 'hello',
      timestamp: 10,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.called.1',
      data: {
        tool: 'smartperfetto_query_trace',
        callID: 'call-1',
        input: { sql: 'select 1' },
      },
    }, 11)).toMatchObject({
      type: 'tool_call',
      content: {
        name: 'smartperfetto_query_trace',
        callId: 'call-1',
        runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      },
      timestamp: 11,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'session.next.tool.failed.1',
      data: { tool: 'bash', error: { message: 'denied' } },
    }, 12)).toMatchObject({
      type: 'degraded',
      content: {
        source: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
        reason: 'tool_failed',
        tool: 'bash',
      },
      timestamp: 12,
    });
    expect(projectOpenCodeEventToStreamingUpdate({
      name: 'analysis_completed',
      data: {},
    })).toBeUndefined();
  });

  it('runs hidden no-reply smoke with isolated config and closes the server', async () => {
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
      env: {
        SMARTPERFETTO_OPENCODE_SERVER_PORT: '4106',
        SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '12345',
      },
      moduleLoader: createFakeModuleLoader(record),
    });
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '分析启动性能',
      'session-opencode',
      'trace-opencode',
      { analysisMode: 'full', packageName: 'com.example' },
    );

    expect(result).toMatchObject({
      success: true,
      partial: true,
      terminationReason: 'plan_incomplete',
    });
    expect(result.conclusion).toContain('OpenCode hidden runtime smoke completed');
    expect(record.closeCount).toBe(1);
    expect(record.createOptions).toMatchObject({
      hostname: '127.0.0.1',
      port: 4106,
      timeout: 12345,
      config: expect.objectContaining({
        share: 'disabled',
        snapshot: false,
        instructions: [],
        mcp: {},
      }),
    });
    expect(record.promptInput).toMatchObject({
      path: { id: 'ses-opencode-test' },
      body: {
        noReply: true,
        tools: expect.objectContaining({
          bash: false,
          edit: false,
          write: false,
          apply_patch: false,
        }),
      },
    });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
    ]));
  });

  it('keeps private source sessions out of durable OpenCode state and removes temporary files', async () => {
    await withBackendDataDir(async dataDir => {
      const paths: {home?: string; config?: string; project?: string; env?: NodeJS.ProcessEnv} = {};
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        env: {
          XDG_DATA_HOME: '/host/xdg/data',
          XDG_STATE_HOME: '/host/xdg/state',
          XDG_CACHE_HOME: '/host/xdg/cache',
          XDG_CONFIG_HOME: '/host/xdg/config',
          USERPROFILE: 'C:\\host-profile',
          APPDATA: 'C:\\host-appdata',
          LOCALAPPDATA: 'C:\\host-localappdata',
          OPENCODE_SERVER_USERNAME: 'host-user',
          OPENCODE_SERVER_PASSWORD: 'host-password',
        },
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            paths.env = processEnv;
            paths.home = processEnv.HOME;
            paths.config = processEnv.OPENCODE_CONFIG_DIR;
            fs.writeFileSync(path.join(paths.home!, 'provider-state'), 'PRIVATE_PROVIDER_STATE');
            fs.writeFileSync(path.join(paths.config!, 'tool-state'), 'PRIVATE_TOOL_STATE');
            return {
              server: {url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined)},
              client: {
                session: {
                  create: jest.fn(async () => ({data: {id: 'ses-private'}})),
                  prompt: jest.fn(async (input: any) => {
                    paths.project = input.query.directory;
                    fs.writeFileSync(
                      path.join(paths.project!, 'session-state'),
                      'PRIVATE_SESSION_STATE',
                    );
                    return {data: {info: {role: 'user'}, parts: []}};
                  }),
                },
              },
            };
          }),
        }),
      });

      await runtime.analyze(
        'analyze with private source',
        'session-opencode-private',
        'trace-opencode',
        {
          analysisMode: 'full',
          codeAwareMode: 'provider_send',
          codebaseIds: ['codebase-private'],
        },
      );

      expect(paths.home).toContain('smartperfetto-opencode-private-');
      expect(paths.config).toContain('smartperfetto-opencode-private-');
      expect(paths.project).toContain('smartperfetto-opencode-private-');
      const ephemeralRoot = path.dirname(paths.project!);
      for (const key of [
        'HOME',
        'USERPROFILE',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'APPDATA',
        'LOCALAPPDATA',
        'TMPDIR',
        'TMP',
        'TEMP',
        'OPENCODE_CONFIG_DIR',
      ]) {
        expect(path.resolve(paths.env![key]!)).toContain(`${path.resolve(ephemeralRoot)}${path.sep}`);
      }
      expect(paths.env?.OPENCODE_SERVER_USERNAME).not.toBe('host-user');
      expect(paths.env?.OPENCODE_SERVER_PASSWORD).not.toBe('host-password');
      expect(fs.existsSync(paths.home!)).toBe(false);
      expect(fs.existsSync(paths.config!)).toBe(false);
      expect(fs.existsSync(paths.project!)).toBe(false);
      expect(fs.existsSync(path.join(
        dataDir,
        'agent-runtime',
        'opencode',
        'session-opencode-private',
      ))).toBe(false);
    });
  });

  it('fails closed when a custom adapter cannot accept an explicit process environment', async () => {
    const legacyCreate = jest.fn(async () => {
      throw new Error('legacy create should not be called');
    });
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
      moduleLoader: async () => ({createOpencode: legacyCreate}),
    });

    await expect(runtime.analyze(
      'private source analysis',
      'session-opencode-legacy-adapter',
      'trace-opencode',
      {codeAwareMode: 'metadata_only', codebaseIds: ['codebase-private']},
    )).rejects.toThrow('does not support explicit per-process environment isolation');
    expect(legacyCreate).not.toHaveBeenCalled();
  });

  it('injects dual-trace pane mapping into the OpenCode comparison system prompt', async () => {
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (traceId: string, sql: string) => {
      if (!sql.includes('sqlite_master')) return {columns: [], rows: [], durationMs: 1};
      return {
        columns: ['name'],
        rows: [[traceId === 'trace-current' ? 'android_current_only' : 'android_reference_only']],
        durationMs: 1,
      };
    });
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader: createFakeModuleLoader(record),
      },
    );

    await runtime.analyze(
      '对比左右 Trace 的启动速度差异',
      'session-opencode-compare',
      'trace-current',
      {
        analysisMode: 'full',
        packageName: 'com.example',
        referenceTraceId: 'trace-reference',
        tracePairContext: {
          schemaVersion: 1,
          layout: 'horizontal',
          primarySide: 'left',
          referenceSide: 'right',
          workspaceOpen: true,
          panes: [
            {
              side: 'left',
              traceSide: 'current',
              traceId: 'trace-current',
              traceName: 'Current Trace',
              visualState: 'live',
            },
            {
              side: 'right',
              traceSide: 'reference',
              traceId: 'trace-reference',
              traceName: 'Reference Trace',
              visualState: 'live',
            },
          ],
        },
      },
    );

    const promptInput = record.promptInput as { body?: { system?: string } } | undefined;
    expect(promptInput?.body?.system).toContain('## 对比模式');
    expect(promptInput?.body?.system).toContain('### 窗口映射');
    expect(promptInput?.body?.system).toContain('左侧/基线 Trace');
    expect(promptInput?.body?.system).toContain('右侧/对比 Trace');
    expect(promptInput?.body?.system).toContain('共有表/视图**: 0 个，不可直接对比');
    expect(promptInput?.body?.system).toContain('android_current_only');
    expect(promptInput?.body?.system).toContain('android_reference_only');
  });

  it('answers default auto trace facts directly without loading the OpenCode SDK', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    traceProcessorService.query.mockImplementation(async (_traceId: string, sql: string) => {
      expect(sql).toContain('runtime_cpu_core_count');
      return {
        columns: [
          'observed_cpu_count',
          'observed_cpus',
          'universe_source',
          'cpu_table_count',
          'cpu_table_cpus',
          'source_table',
        ],
        rows: [[
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'sched_observed',
          7,
          '0, 1, 2, 3, 4, 5, 6',
          'sched_slice/thread_state',
        ]],
        durationMs: 2,
      };
    });
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const moduleLoader = createFakeModuleLoader(record);
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader,
      },
    );
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '这个 trace 的 CPU 有几个核心？',
      'session-opencode-auto-quick',
      'trace-opencode',
    );

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(record.promptInput).toBeUndefined();
    expect(record.createOptions).toBeUndefined();
    expect(record.closeCount).toBe(0);
    expect(result.quickRun).toMatchObject({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      actualTurns: 0,
      stopReason: 'answered',
      evidence: {
        currentRunDataEnvelopes: 1,
        citedEvidenceRefs: 1,
      },
    });
    expect(result.rounds).toBe(0);
    expect(result.conclusion).toContain('7 个 CPU 核心');
    expect(result.conclusionContract?.claims?.[0]?.references?.[0]).toMatchObject({
      column: 'observed_cpu_count',
      value: 7,
    });
    expect(result.terminationReason).toBeUndefined();
    expect(traceProcessorService.query).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      expect.objectContaining({ type: 'data' }),
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
      expect.objectContaining({ type: 'answer_token' }),
    ]);
  });

  it('does not pre-run quick direct evidence for auto full scrolling diagnostics', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const moduleLoader = createFakeModuleLoader(record);
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader,
      },
    );
    runtime.restoreArchitectureCache('trace-opencode-full-scroll', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });
    const directEvidence = jest.spyOn(
      quickEvidenceDirectAnswer,
      'buildRuntimeQuickEvidenceDirectAnswer',
    );

    try {
      const result = await runtime.analyze(
        '分析滑动性能',
        'session-opencode-full-scroll',
        'trace-opencode-full-scroll',
      );

      expect(directEvidence).not.toHaveBeenCalled();
      expect(moduleLoader).toHaveBeenCalledTimes(1);
      expect(record.promptInput).toBeDefined();
      expect(result.quickRun).toBeUndefined();
    } finally {
      directEvidence.mockRestore();
    }
  });

  it('bounds the OpenCode architecture cache with shared LRU semantics', () => {
    const runtime = new OpenCodeRuntime(createFakeRuntimeInput());
    for (let index = 0; index < 51; index += 1) {
      runtime.restoreArchitectureCache(`trace-${index}`, {
        type: 'STANDARD',
        confidence: 1,
        evidence: [],
      });
    }

    expect(runtime.getCachedArchitecture('trace-0')).toBeUndefined();
    expect(runtime.getCachedArchitecture('trace-50')).toBeDefined();
    runtime.reset();
    expect(runtime.getCachedArchitecture('trace-50')).toBeUndefined();
  });

  it('skips focus detection for package-scoped trace fact fallback preparation', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const sqlQueries: string[] = [];
    traceProcessorService.query.mockImplementation(async (_traceId: string, sql: string) => {
      sqlQueries.push(sql);
      return { columns: [], rows: [], durationMs: 1 };
    });
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const moduleLoader = createFakeModuleLoader(record);
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {
          SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
        },
        moduleLoader,
      },
    );
    runtime.restoreArchitectureCache('trace-opencode', {
      type: 'STANDARD',
      confidence: 0.9,
      evidence: [],
    });

    await runtime.analyze(
      '滑动 FPS 是多少？',
      'session-opencode-package-fallback',
      'trace-opencode',
      { packageName: 'com.example.app' },
    );

    expect(moduleLoader).toHaveBeenCalledTimes(1);
    expect(record.promptInput).toBeDefined();
    expect(sqlQueries.some(sql => sql.includes('runtime_frame_metrics'))).toBe(true);
    expect(sqlQueries.some(sql => sql.includes('android_battery_stats_event_slices'))).toBe(false);
    expect(sqlQueries.some(sql => sql.includes('android_oom_adj_intervals'))).toBe(false);
  });

  it('answers acknowledgement follow-ups directly without loading the OpenCode SDK', async () => {
    const traceProcessorService = createFakeTraceProcessorService();
    const record: { createOptions?: Record<string, unknown>; promptInput?: unknown; closeCount: number } = {
      closeCount: 0,
    };
    const moduleLoader = createFakeModuleLoader(record);
    const runtime = new OpenCodeRuntime(
      createFakeRuntimeInput({
        traceProcessorService,
        selection: { kind: OPENCODE_RUNTIME_KIND, source: 'env' },
      }),
      {
        env: {},
        moduleLoader,
      },
    );
    const updates: unknown[] = [];
    runtime.on('update', update => updates.push(update));

    const result = await runtime.analyze(
      '谢谢',
      'session-opencode-ack',
      'trace-opencode',
    );

    expect(moduleLoader).not.toHaveBeenCalled();
    expect(record.promptInput).toBeUndefined();
    expect(record.createOptions).toBeUndefined();
    expect(record.closeCount).toBe(0);
    expect(traceProcessorService.query).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      conclusion: '收到。',
      confidence: 1,
      rounds: 0,
      quickRun: {
        requestedMode: 'auto',
        resolvedMode: 'quick',
        actualTurns: 0,
        stopReason: 'answered',
      },
    });
    expect(result.claimVerificationResult).toBeUndefined();
    expect(updates).toEqual([
      expect.objectContaining({ type: 'progress' }),
      expect.objectContaining({ type: 'conclusion' }),
      expect.objectContaining({ type: 'answer_token' }),
    ]);
  });

  it('hydrates OpenCode opaque session state and prompts the restored session', async () => {
    await withBackendDataDir(async (dataDir) => {
      const firstRecord = {
        closeCount: 0,
        createInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const firstRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            firstRecord.homeAtCreate = processEnv.HOME;
            firstRecord.configAtCreate = processEnv.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4106',
                close: jest.fn(() => {
                  firstRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  create: jest.fn(async (input: unknown) => {
                    firstRecord.createInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    firstRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });

      await firstRuntime.analyze('first OpenCode question', 'session-opencode-resume', 'trace-opencode');
      const snapshot = firstRuntime.takeSnapshot(
        'session-opencode-resume',
        'trace-opencode',
        createSnapshotFields(),
      );
      const opaque = snapshot.engineState?.kind === 'opencode'
        ? snapshot.engineState.opencode.opaque
        : undefined;

      expect(opaque).toMatchObject({
        version: 1,
        openCodeSessionId: 'ses-opencode-original',
      });
      expect(opaque?.projectDir).toContain(dataDir);
      expect(opaque?.homeDir).toContain(dataDir);
      expect(opaque?.configDir).toContain(dataDir);
      expect(firstRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(firstRecord.configAtCreate).toBe(opaque?.configDir);

      const restoredRecord = {
        closeCount: 0,
        createCalls: 0,
        getInput: undefined as unknown,
        promptInput: undefined as unknown,
        homeAtCreate: undefined as string | undefined,
        configAtCreate: undefined as string | undefined,
      };
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
            restoredRecord.homeAtCreate = processEnv.HOME;
            restoredRecord.configAtCreate = processEnv.OPENCODE_CONFIG_DIR;
            return {
              server: {
                url: 'http://127.0.0.1:4107',
                close: jest.fn(() => {
                  restoredRecord.closeCount += 1;
                }),
              },
              client: {
                session: {
                  get: jest.fn(async (input: unknown) => {
                    restoredRecord.getInput = input;
                    return { data: { id: 'ses-opencode-original' } };
                  }),
                  create: jest.fn(async () => {
                    restoredRecord.createCalls += 1;
                    return { data: { id: 'ses-opencode-new' } };
                  }),
                  prompt: jest.fn(async (input: unknown) => {
                    restoredRecord.promptInput = input;
                    return { data: { info: { role: 'user' }, parts: [] } };
                  }),
                },
              },
            };
          }),
        }),
      });
      restoredRuntime.restoreFromSnapshot('session-opencode-resume', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up OpenCode question', 'session-opencode-resume', 'trace-opencode');

      expect(restoredRecord.createCalls).toBe(0);
      expect(restoredRecord.getInput).toEqual({
        path: { id: 'ses-opencode-original' },
        query: { directory: opaque?.projectDir },
      });
      expect(restoredRecord.promptInput).toMatchObject({
        path: { id: 'ses-opencode-original' },
        query: { directory: opaque?.projectDir },
      });
      expect(restoredRecord.homeAtCreate).toBe(opaque?.homeDir);
      expect(restoredRecord.configAtCreate).toBe(opaque?.configDir);
    });
  });

  it('degrades OpenCode restore when the third-party session is unavailable', async () => {
    await withBackendDataDir(async () => {
      const runtime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined) },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: 'ses-opencode-original' } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          })),
        }),
      });
      await runtime.analyze('first', 'session-opencode-missing', 'trace-opencode');
      const snapshot = runtime.takeSnapshot(
        'session-opencode-missing',
        'trace-opencode',
        createSnapshotFields(),
      );

      const createCalls: unknown[] = [];
      const updates: any[] = [];
      const restoredRuntime = new OpenCodeRuntime(createFakeRuntimeInput(), {
        moduleLoader: async () => ({
          createOpencodeWithEnv: jest.fn(async () => ({
            server: { url: 'http://127.0.0.1:4107', close: jest.fn(() => undefined) },
            client: {
              session: {
                get: jest.fn(async () => {
                  throw new Error('missing session');
                }),
                create: jest.fn(async (input: unknown) => {
                  createCalls.push(input);
                  return { data: { id: 'ses-opencode-fresh' } };
                }),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          })),
        }),
      });
      restoredRuntime.on('update', update => updates.push(update));
      restoredRuntime.restoreFromSnapshot('session-opencode-missing', 'trace-opencode', snapshot);

      await restoredRuntime.analyze('follow-up', 'session-opencode-missing', 'trace-opencode');

      expect(createCalls).toHaveLength(1);
      expect(updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'degraded',
          content: expect.objectContaining({
            module: 'opencode',
            fallback: 'fresh_session',
            reason: 'session_restore_failed',
            message: 'OpenCode session state unavailable; started a fresh OpenCode session with SmartPerfetto context.',
          }),
        }),
      ]));
    });
  });

  it('passes per-process OpenCode env without mutating global HOME during concurrent startup', async () => {
    await withBackendDataDir(async () => {
      let activeCreates = 0;
      let maxActiveCreates = 0;
      const createRecords: Array<{ home?: string; config?: string }> = [];
      const moduleLoader: OpenCodeSdkModuleLoader = async () => ({
        createOpencodeWithEnv: jest.fn(async (_options: any, processEnv: NodeJS.ProcessEnv) => {
          activeCreates += 1;
          maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
          createRecords.push({
            home: processEnv.HOME,
            config: processEnv.OPENCODE_CONFIG_DIR,
          });
          await new Promise(resolve => setTimeout(resolve, 20));
          activeCreates -= 1;
          return {
            server: { url: 'http://127.0.0.1:4106', close: jest.fn(() => undefined) },
            client: {
              session: {
                create: jest.fn(async () => ({ data: { id: `ses-${createRecords.length}` } })),
                prompt: jest.fn(async () => ({ data: { info: { role: 'user' }, parts: [] } })),
              },
            },
          };
        }),
      });
      const runtimeA = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });
      const runtimeB = new OpenCodeRuntime(createFakeRuntimeInput(), { moduleLoader });
      const originalHome = process.env.HOME;
      const originalConfig = process.env.OPENCODE_CONFIG_DIR;

      await Promise.all([
        runtimeA.analyze('first', 'session-opencode-a', 'trace-opencode'),
        runtimeB.analyze('second', 'session-opencode-b', 'trace-opencode'),
      ]);

      expect(maxActiveCreates).toBe(2);
      expect(process.env.HOME).toBe(originalHome);
      expect(process.env.OPENCODE_CONFIG_DIR).toBe(originalConfig);
      expect(createRecords).toHaveLength(2);
      expect(createRecords[0].home).toContain('session-opencode-a');
      expect(createRecords[1].home).toContain('session-opencode-b');
      expect(createRecords[0].config).toContain('session-opencode-a');
      expect(createRecords[1].config).toContain('session-opencode-b');
    });
  });

  it('reports hidden runtime diagnostics without exposing a public provider', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH: '/tmp/sdk.js',
      SMARTPERFETTO_OPENCODE_PROJECT_DIR: '/tmp/project',
      SMARTPERFETTO_OPENCODE_SERVER_PORT: '4107',
      SMARTPERFETTO_OPENCODE_SERVER_TIMEOUT_MS: '5000',
    }, EXPERIMENTAL_OPENCODE_RUNTIME_KIND)).toMatchObject({
      configured: true,
      runtime: EXPERIMENTAL_OPENCODE_RUNTIME_KIND,
      experimental: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
      modulePath: '/tmp/sdk.js',
      projectDir: '/tmp/project',
      serverPort: 4107,
      serverTimeoutMs: 5000,
      standaloneMcpEnabled: false,
      standaloneMcpTimeoutMs: 5000,
    });
  });

  it('reports public OpenCode diagnostics by default for M14 provider checks', () => {
    expect(getOpenCodeRuntimeDiagnostics({
      PATH: '/usr/bin',
      SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"providerID":"smartperfetto","modelID":"test-model"}',
    })).toMatchObject({
      configured: true,
      runtime: 'opencode',
      experimental: false,
      modelConfigured: true,
      package: '@opencode-ai/sdk',
      cliPackage: 'opencode-ai',
    });
  });
});
