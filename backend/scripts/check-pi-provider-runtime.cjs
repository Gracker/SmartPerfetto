#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const {spawnSync} = require('child_process');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const isolatedEnv = {...process.env};
const providerEnvPrefixes = [
  'AI_GATEWAY_', 'ANT_LING_', 'ANTHROPIC_', 'AWS_', 'AZURE_OPENAI_',
  'BASETEN_', 'CEREBRAS_', 'CLOUDFLARE_', 'COPILOT_', 'DEEPSEEK_',
  'FIREWORKS_', 'GCLOUD_',
  'GEMINI_', 'GOOGLE_', 'GROQ_', 'HF_', 'KIMI_', 'MINIMAX_', 'MISTRAL_',
  'MOONSHOT_', 'NVIDIA_', 'OPENCODE_', 'OPENAI_', 'OPENROUTER_',
  'QWEN_TOKEN_PLAN_', 'RADIUS_', 'TOGETHER_', 'XAI_', 'XIAOMI_', 'ZAI_',
];
const providerEnvKeys = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'PI_CACHE_RETENTION',
]);
for (const key of Object.keys(isolatedEnv)) {
  if (
    providerEnvKeys.has(key) ||
    providerEnvPrefixes.some(prefix => key.startsWith(prefix))
  ) {
    delete isolatedEnv[key];
  }
}
const script = String.raw`
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createAssistantMessageEventStream,
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {createPiAgentCoreProviderRuntime} from './src/agentRuntime/engines/pi/piAgentCoreProvider.ts';
import {
  PI_AGENT_CORE_MODEL_JSON_ENV,
  PiAgentCoreRuntime,
  loadPiAgentCoreModule,
} from './src/agentRuntime/engines/pi/piAgentCoreRuntime.ts';

const {Agent} = await loadPiAgentCoreModule();

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const calls = [];
faux.setResponses([
  fauxAssistantMessage(fauxToolCall('echo', {value: 'provider-explicit'}), {stopReason: 'toolUse'}),
  fauxAssistantMessage('finished'),
]);
const agent = new Agent({
  initialState: {
    model: faux.getModel(),
    systemPrompt: 'SmartPerfetto Pi provider-explicit integration test',
    tools: [{
      name: 'echo',
      label: 'Echo',
      description: 'Echo a value',
      parameters: Type.Object({value: Type.String()}),
      execute: async (_toolCallId, args) => {
        calls.push(args);
        return {content: [{type: 'text', text: 'echo:' + args.value}], details: {}};
      },
    }],
  },
  streamFn: models.streamSimple.bind(models),
  toolExecution: 'sequential',
});
await agent.prompt('call the echo tool');
assert.deepEqual(calls, [{value: 'provider-explicit'}]);
assert.equal(agent.state.messages.at(-1)?.stopReason, 'stop');

const resumedMessages = structuredClone(agent.state.messages);
faux.setResponses([fauxAssistantMessage('resumed-finished')]);
const resumedAgent = new Agent({
  initialState: {
    model: faux.getModel(),
    systemPrompt: 'SmartPerfetto Pi provider-explicit integration test',
    tools: [],
    messages: resumedMessages,
  },
  streamFn: models.streamSimple.bind(models),
});
await resumedAgent.prompt('continue from the snapshot');
assert.equal(resumedAgent.state.messages.at(-1)?.content[0]?.text, 'resumed-finished');
assert.equal(agent.state.messages.length, resumedMessages.length);

const abortModels = createModels();
const abortFaux = fauxProvider({tokensPerSecond: 1, tokenSize: {min: 1, max: 1}});
abortModels.setProvider(abortFaux.provider);
abortFaux.setResponses([fauxAssistantMessage('this response is deliberately slow')]);
const abortAgent = new Agent({
  initialState: {model: abortFaux.getModel(), tools: []},
  streamFn: abortModels.streamSimple.bind(abortModels),
});
let resolveUpdate;
const firstUpdate = new Promise((resolve) => { resolveUpdate = resolve; });
abortAgent.subscribe((event) => {
  if (event.type === 'message_update') resolveUpdate();
});
const prompt = abortAgent.prompt('start');
await firstUpdate;
abortAgent.abort();
await prompt;
assert.equal(abortAgent.state.messages.at(-1)?.stopReason, 'aborted');

const model = {
  id: 'private-model',
  name: 'Private Model',
  api: 'openai-completions',
  provider: 'smartperfetto-isolation',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
  contextWindow: 8192,
  maxTokens: 1024,
};

function createTraceProcessorService() {
  return {
    query: async () => ({columns: [], rows: [], durationMs: 1}),
    getTrace: () => ({
      id: 'trace-pi-real',
      filename: 'trace.pftrace',
      size: 1,
      uploadTime: new Date(),
      status: 'ready',
      traceOs: 'android',
      traceFormat: 'perfetto_protobuf',
    }),
  };
}

function createRuntimeProvider(options) {
  const runtimeModels = createModels();
  const runtimeFaux = fauxProvider(options);
  runtimeModels.setProvider(runtimeFaux.provider);
  return {
    runtimeFaux,
    loader: async () => ({
      model: runtimeFaux.getModel(),
      models: runtimeModels,
      streamFn: runtimeModels.streamSimple.bind(runtimeModels),
    }),
  };
}

function createRuntime(providerRuntimeLoader) {
  return new PiAgentCoreRuntime(
    createTraceProcessorService(),
    {kind: 'pi-agent-core', source: 'env'},
    {
      env: {[PI_AGENT_CORE_MODEL_JSON_ENV]: JSON.stringify(model)},
      moduleLoader: loadPiAgentCoreModule,
      providerRuntimeLoader,
    },
  );
}

function createSnapshotFields(overrides = {}) {
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
    ...overrides,
  };
}

const firstRuntimeProvider = createRuntimeProvider();
firstRuntimeProvider.runtimeFaux.setResponses([fauxAssistantMessage('runtime-first')]);
const firstRuntime = createRuntime(firstRuntimeProvider.loader);
await firstRuntime.analyze(
  'Give a concise trace status.',
  'session-real-runtime',
  'trace-pi-real',
  {analysisMode: 'fast'},
);
const runtimeSnapshot = firstRuntime.takeSnapshot(
  'session-real-runtime',
  'trace-pi-real',
  createSnapshotFields(),
);
assert.equal(runtimeSnapshot.engineState?.kind, 'pi-agent-core');
assert.ok(runtimeSnapshot.engineState.pi.opaque?.messageCount > 0);

const resumedRuntimeProvider = createRuntimeProvider();
resumedRuntimeProvider.runtimeFaux.setResponses([fauxAssistantMessage('runtime-resumed')]);
const resumedRuntime = createRuntime(resumedRuntimeProvider.loader);
resumedRuntime.restoreFromSnapshot(
  'session-real-runtime',
  'trace-pi-real',
  runtimeSnapshot,
);
await resumedRuntime.analyze(
  'Continue from the snapshot.',
  'session-real-runtime',
  'trace-pi-real',
  {analysisMode: 'fast'},
);
const resumedSnapshot = resumedRuntime.takeSnapshot(
  'session-real-runtime',
  'trace-pi-real',
  createSnapshotFields(),
);
assert.ok(
  resumedSnapshot.engineState?.kind === 'pi-agent-core' &&
  resumedSnapshot.engineState.pi.opaque?.messageCount >
    runtimeSnapshot.engineState.pi.opaque.messageCount,
);

resumedRuntimeProvider.runtimeFaux.setResponses([fauxAssistantMessage('private-runtime')]);
await resumedRuntime.analyze(
  'Analyze with private source context.',
  'session-real-runtime',
  'trace-pi-real',
  {
    analysisMode: 'fast',
    codeAwareMode: 'metadata_only',
    codebaseIds: ['private-codebase'],
  },
);
const privateRuntimeSnapshot = resumedRuntime.takeSnapshot(
  'session-real-runtime',
  'trace-pi-real',
  createSnapshotFields({
    codeAwareMode: 'metadata_only',
    codebaseIds: ['private-codebase'],
  }),
);
assert.equal(
  privateRuntimeSnapshot.engineState?.kind === 'pi-agent-core'
    ? privateRuntimeSnapshot.engineState.pi.opaque
    : undefined,
  undefined,
);

async function assertRuntimeAbort(abortRuntime) {
  const abortRuntimeProvider = createRuntimeProvider({
    tokensPerSecond: 1,
    tokenSize: {min: 1, max: 1},
  });
  abortRuntimeProvider.runtimeFaux.setResponses([
    fauxAssistantMessage('this runtime response is deliberately slow'),
  ]);
  const runtime = createRuntime(abortRuntimeProvider.loader);
  const analysis = runtime.analyze(
    'Start an abortable analysis.',
    'session-real-abort',
    'trace-pi-real',
    {analysisMode: 'fast'},
  );
  for (let index = 0; index < 100 && abortRuntimeProvider.runtimeFaux.state.callCount === 0; index++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(abortRuntimeProvider.runtimeFaux.state.callCount, 1);
  abortRuntime(runtime);
  const result = await analysis;
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, 'timeout');
  assert.match(result.conclusion, /aborted/i);
}

await assertRuntimeAbort(runtime => runtime.abortSession('session-real-abort'));
await assertRuntimeAbort(runtime => runtime.abortActiveRun());
const [first, second] = await Promise.all([
  createPiAgentCoreProviderRuntime({model, apiKeyEnv: 'PI_PRIVATE_KEY'}, {PI_PRIVATE_KEY: 'first-secret'}),
  createPiAgentCoreProviderRuntime({model, apiKeyEnv: 'PI_PRIVATE_KEY'}, {PI_PRIVATE_KEY: 'second-secret'}),
]);
assert.equal((await first.models.getAuth(first.model))?.auth.apiKey, 'first-secret');
assert.equal((await second.models.getAuth(second.model))?.auth.apiKey, 'second-secret');
assert.notEqual(first.models, second.models);
assert.notEqual(first.streamFn, second.streamFn);

process.env.AWS_ACCESS_KEY_ID = 'ambient-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'ambient-secret-key';
process.env.AWS_REGION = 'ambient-region';
const bedrock = await createPiAgentCoreProviderRuntime({
  model: {
    ...model,
    id: 'us.anthropic.claude-sonnet-test',
    name: 'Bedrock Test Model',
    provider: 'amazon-bedrock',
    api: 'bedrock-converse-stream',
    baseUrl: 'https://bedrock-runtime.scoped-region.amazonaws.com',
  },
}, {
  AWS_ACCESS_KEY_ID: 'scoped-access-key',
  AWS_SECRET_ACCESS_KEY: 'scoped-secret-key',
  AWS_SESSION_TOKEN: 'scoped-session-token',
  AWS_REGION: 'scoped-region',
});
assert.deepEqual((await bedrock.models.getAuth(bedrock.model))?.env, {
  AWS_ACCESS_KEY_ID: 'scoped-access-key',
  AWS_REGION: 'scoped-region',
  AWS_SECRET_ACCESS_KEY: 'scoped-secret-key',
  AWS_SESSION_TOKEN: 'scoped-session-token',
});
process.env.AWS_PROFILE = 'ambient-profile';
await assert.rejects(
  createPiAgentCoreProviderRuntime({
    model: {
      ...model,
      id: 'us.anthropic.claude-sonnet-test',
      provider: 'amazon-bedrock',
      api: 'bedrock-converse-stream',
      baseUrl: 'https://bedrock-runtime.scoped-region.amazonaws.com',
    },
  }, {
    AWS_ACCESS_KEY_ID: 'scoped-access-key',
    AWS_SECRET_ACCESS_KEY: 'scoped-secret-key',
    AWS_REGION: 'scoped-region',
  }).then(runtime => runtime.models.getAuth(runtime.model)),
  /cannot use ambient AWS_PROFILE outside the selected runtime environment/,
);
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;
delete process.env.AWS_REGION;
delete process.env.AWS_PROFILE;

const oauth = await createPiAgentCoreProviderRuntime({
  model: {
    ...model,
    id: 'openrouter/test-model',
    name: 'OpenRouter Test Model',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  credential: {
    type: 'oauth',
    refresh: 'refresh-secret',
    access: 'access-secret',
    expires: Date.now() + 60 * 60 * 1000,
  },
}, {});
assert.deepEqual(await oauth.models.getAuth(oauth.model), {
  auth: {apiKey: 'access-secret'},
  source: 'OAuth',
});

process.env.AZURE_OPENAI_BASE_URL = 'https://ambient-azure.example.invalid';
const oauthAzure = await createPiAgentCoreProviderRuntime({
  model: {
    ...model,
    id: 'azure-oauth-isolation',
    provider: 'openrouter',
    api: 'azure-openai-responses',
    baseUrl: 'https://scoped-azure.example.invalid',
  },
  credential: {
    type: 'oauth',
    refresh: 'refresh-secret',
    access: 'access-secret',
    expires: Date.now() + 60 * 60 * 1000,
  },
}, {});
let oauthAzureFetches = 0;
const oauthAzureResult = await oauthAzure.streamFn(oauthAzure.model, {messages: []}, {
  fetch: async () => {
    oauthAzureFetches += 1;
    throw new Error('OAuth Azure isolation must fail before fetch');
  },
}).result();
assert.equal(oauthAzureResult.stopReason, 'error');
assert.match(
  oauthAzureResult.errorMessage,
  /cannot use ambient AZURE_OPENAI_BASE_URL outside the selected runtime environment/,
);
assert.equal(oauthAzureFetches, 0);
delete process.env.AZURE_OPENAI_BASE_URL;

let optionEnvSeen;
const optionEnvProvider = await createPiAgentCoreProviderRuntime({
  model: {
    ...model,
    id: 'azure-request-env-precedence',
    provider: 'smartperfetto-request-env',
    api: 'azure-openai-responses',
    baseUrl: 'https://model-default.example.invalid',
  },
  apiKey: 'request-env-secret',
}, {
  AZURE_OPENAI_BASE_URL: 'https://captured-default.example.invalid',
}, async specifier => {
  if (specifier === '@earendil-works/pi-ai/api/azure-openai-responses.lazy') {
    return {
      azureOpenAIResponsesApi: () => ({
        stream: (_model, _context, options) => {
          optionEnvSeen = options?.env;
          const stream = createAssistantMessageEventStream();
          stream.end(fauxAssistantMessage('request-env'));
          return stream;
        },
        streamSimple: (_model, _context, options) => {
          optionEnvSeen = options?.env;
          const stream = createAssistantMessageEventStream();
          stream.end(fauxAssistantMessage('request-env'));
          return stream;
        },
      }),
    };
  }
  return import(specifier);
});
await optionEnvProvider.streamFn(optionEnvProvider.model, {messages: []}, {
  env: {AZURE_OPENAI_BASE_URL: 'https://request-override.example.invalid'},
}).result();
assert.equal(
  optionEnvSeen.AZURE_OPENAI_BASE_URL,
  'https://request-override.example.invalid',
);

async function listenMetadataServer() {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({
      AccessKeyId: 'must-not-be-read',
      SecretAccessKey: 'must-not-be-read',
      Token: 'must-not-be-read',
      Expiration: new Date(Date.now() + 60_000).toISOString(),
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  return {
    url: 'http://127.0.0.1:' + address.port + '/credentials',
    hits: () => hits,
    close: () => new Promise((resolve, reject) => server.close(error => (
      error ? reject(error) : resolve()
    ))),
  };
}

const ambientMetadata = await listenMetadataServer();
const scopedMetadata = await listenMetadataServer();
process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = ambientMetadata.url;
try {
  await assert.rejects(
    createPiAgentCoreProviderRuntime({
      model: {
        ...model,
        id: 'bedrock-container-isolation',
        provider: 'amazon-bedrock',
        api: 'bedrock-converse-stream',
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      },
    }, {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: scopedMetadata.url,
      AWS_REGION: 'us-east-1',
    }),
    /does not support AWS_CONTAINER_CREDENTIALS_FULL_URI/,
  );
  assert.equal(ambientMetadata.hits(), 0);
  assert.equal(scopedMetadata.hits(), 0);
} finally {
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  await Promise.all([ambientMetadata.close(), scopedMetadata.close()]);
}

const vertexCredentialsDir = await mkdtemp(path.join(os.tmpdir(), 'smartperfetto-pi-vertex-'));
const vertexCredentialsPath = path.join(vertexCredentialsDir, 'service-account.json');
await writeFile(vertexCredentialsPath, '{}', 'utf8');
try {
  const vertex = await createPiAgentCoreProviderRuntime({
    model: {
      ...model,
      id: 'vertex-isolation',
      provider: 'google-vertex',
      api: 'google-vertex',
      baseUrl: 'https://aiplatform.googleapis.com',
    },
  }, {
    GOOGLE_APPLICATION_CREDENTIALS: vertexCredentialsPath,
    GOOGLE_CLOUD_PROJECT: 'scoped-project',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
  });
  assert.deepEqual((await vertex.models.getAuth(vertex.model))?.env, {
    GOOGLE_APPLICATION_CREDENTIALS: vertexCredentialsPath,
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    GOOGLE_CLOUD_PROJECT: 'scoped-project',
  });
} finally {
  await rm(vertexCredentialsDir, {recursive: true, force: true});
}

for (const api of ['smartperfetto-unknown-api', 'constructor', 'toString', '__proto__']) {
  await assert.rejects(
    createPiAgentCoreProviderRuntime({
      model: {id: 'unknown-api-model', api, provider: 'smartperfetto'},
    }, {}),
    new RegExp('Unsupported Pi model API: ' + api),
  );
}
await assert.rejects(
  createPiAgentCoreProviderRuntime({
    model: {...model, baseUrl: ''},
  }, {}),
  /Pi model field baseUrl must be a non-empty string/,
);
`;

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', script],
  {cwd: backendRoot, encoding: 'utf8', env: isolatedEnv},
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Pi provider runtime integration: PASS');
