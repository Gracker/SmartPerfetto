// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {Model, ModelsSimpleStreamOptions} from '@earendil-works/pi-ai';
import type {ResourceLoader, Skill, ToolDefinition} from '@earendil-works/pi-coding-agent';
import type {ChatProfile} from './config';

const importEsm = new Function('name', 'return import(name)') as <T>(name: string) => Promise<T>;
export type ChatTool = ToolDefinition;
export interface ChatExchange { user: string; answer: string }
export interface PiTurn {
  profile: ChatProfile;
  history: readonly ChatExchange[];
  tools: ChatTool[];
  skill?: Pick<Skill, 'name' | 'description'>;
  traceAttached: boolean;
  text: string;
  signal: AbortSignal;
  canDispatch(): Promise<void>;
  onDelta(delta: string): void;
}

export async function runPiTurn(turn: PiTurn): Promise<string> {
  const source = await readFile(path.join(__dirname, '../../strategies/perfetto-chat.template.md'), 'utf8')
    .catch(() => '');
  const instructions = source.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!instructions) throw new Error('PI_PROMPT_CONFIGURATION_ERROR');
  const [sdk, ai, completions] = await Promise.all([
    importEsm<typeof import('@earendil-works/pi-coding-agent')>('@earendil-works/pi-coding-agent'),
    importEsm<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai'),
    importEsm<{streamSimple(model: Model<'openai-completions'>,
      context: import('@earendil-works/pi-ai').Context,
      opts: ModelsSimpleStreamOptions): import('@earendil-works/pi-ai').AssistantMessageEventStream}>(
      '@earendil-works/pi-ai/api/openai-completions',
    ),
  ]);
  const cwd = '/';
  const {endpoint, model: modelId, apiKey} = turn.profile;
  const model: Model<'openai-completions'> = {
    id: modelId, name: modelId, api: 'openai-completions', provider: 'smartperfetto-chat',
    baseUrl: endpoint.toString().replace(/\/$/, ''), reasoning: false, input: ['text'],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 64_000, maxTokens: 4096,
    ...(endpoint.hostname === 'api.z.ai' ? {compat: {zaiToolStream: true}} : {}),
  };
  const modelRuntime = await sdk.ModelRuntime.create({
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(),
  });
  modelRuntime.registerProvider(model.provider, {
    api: model.api, baseUrl: model.baseUrl, models: [model],
  });
  await modelRuntime.setRuntimeApiKey(model.provider, apiKey, {signal: turn.signal});
  let modelRequests = 0;
  let upstreamFailure: string | undefined;
  modelRuntime.streamSimple = (_model, context, options) => completions.streamSimple(model, context, {
    apiKey, signal: options?.signal, maxRetries: 0, cacheRetention: 'none',
    fetch: async (input, init) => {
      turn.signal.throwIfAborted();
      if (modelRequests++ >= 12) throw new Error('MODEL_REQUEST_LIMIT');
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (target.origin !== endpoint.origin ||
          target.pathname !== endpoint.pathname.replace(/\/$/, '') + '/chat/completions' ||
          target.search || target.hash) throw new Error('MODEL_ENDPOINT_CHANGED');
      if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > 384_000) {
        throw new Error('MODEL_REQUEST_TOO_LARGE');
      }
      await turn.canDispatch();
      turn.signal.throwIfAborted();
      const response = await fetch(input, {...init, redirect: 'error', signal: turn.signal});
      if (response.status === 429) upstreamFailure = 'MODEL_RATE_LIMITED';
      if (response.status === 401 || response.status === 403) upstreamFailure = 'MODEL_AUTH_FAILED';
      return limitResponse(response);
    },
  });
  const skill: Skill | undefined = turn.skill && {
    ...turn.skill, filePath: 'SKILL.md', baseDir: '.',
    sourceInfo: {path: 'SKILL.md', source: 'perfetto-chat', scope: 'temporary', origin: 'package'},
    disableModelInvocation: false,
  };
  const extensions = {extensions: [], errors: [], runtime: sdk.createExtensionRuntime()};
  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({skills: skill ? [skill] : [], diagnostics: []}),
    getPrompts: () => ({prompts: [], diagnostics: []}),
    getThemes: () => ({themes: [], diagnostics: []}),
    getAgentsFiles: () => ({agentsFiles: []}),
    getSystemPrompt: () => [
      instructions,
      skill ? `Available standard Skill: ${skill.name}. ${skill.description}`
        : 'The standard Skill bundle is unavailable. Answer general questions only.',
      turn.traceAttached ? 'A local trace is attached.' : 'No local trace is attached.',
    ].join('\n\n'),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  for (const exchange of turn.history) {
    sessionManager.appendMessage({role: 'user', content: exchange.user, timestamp: Date.now()});
    sessionManager.appendMessage({
      role: 'assistant', content: [{type: 'text', text: exchange.answer}],
      api: model.api, provider: model.provider, model: model.id,
      usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      timestamp: Date.now(), stopReason: 'stop',
    });
  }
  const {session} = await sdk.createAgentSession({
    cwd, agentDir: cwd, model, modelRuntime, sessionManager, resourceLoader,
    customTools: turn.tools, noTools: 'builtin',
    settingsManager: sdk.SettingsManager.inMemory({
      cacheWarming: 'off', compaction: {enabled: false}, retry: {enabled: false},
    }),
    thinkingLevel: 'off',
  });

  let finalText: string | undefined;
  let aborting: Promise<void> | undefined;
  const abort = () => { aborting ??= session.abort(); };
  const unsubscribe = session.subscribe(event => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      if (!turn.signal.aborted) turn.onDelta(event.assistantMessageEvent.delta);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message;
      finalText = message.stopReason === 'stop'
        ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
        : undefined;
    }
  });
  turn.signal.addEventListener('abort', abort, {once: true});
  try {
    const expected = turn.tools.map(tool => tool.name).sort();
    if (session.getActiveToolNames().sort().join() !== expected.join()) {
      throw new Error('PI_TOOL_CONFIGURATION_ERROR');
    }
    turn.signal.throwIfAborted();
    await session.prompt(turn.text, {expandPromptTemplates: false});
    turn.signal.throwIfAborted();
    if (!finalText?.trim()) throw new Error(upstreamFailure ?? 'MODEL_RESPONSE_FAILED');
    return finalText;
  } finally {
    turn.signal.removeEventListener('abort', abort);
    try {
      await aborting;
    } finally {
      unsubscribe();
      session.dispose();
    }
  }
}

function limitResponse(response: Response): Response {
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('MODEL_RESPONSE_TOO_LARGE');
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, {status: response.status, statusText: response.statusText, headers: response.headers});
}
