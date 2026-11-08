#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const {spawnSync} = require('node:child_process');
const path = require('node:path');

// Only system launch inputs cross into this test; no provider credentials or host SDK configuration.
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'TMPDIR']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const script = String.raw`
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {z} from 'zod';
import {createLoopbackServerFixture} from './tests/helpers/loopbackServer.ts';
import {loadOpenCodeSdkModule, createOpenCodeHardenedConfig, createOpenCodeToolAllowlist,
  extractOpenCodeAssistantText, __testing as native} from './src/agentRuntime/engines/opencode/openCodeRuntime.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'smartperfetto-opencode-wire-'));
const servers = createLoopbackServerFixture();
const modelsPath = path.join(root, 'empty-models.json');
await writeFile(modelsPath, '{}');
const sdk = await loadOpenCodeSdkModule({});
let active;
let serverFailure;
const reasoning = '私有推理_NATIVE_WIRE_CANARY';
const bodies = [];
let bridgeCalls = 0;
const definitions = [{name: 'native_probe', exposure: 'public', tool: {}, shared: {
  name: 'native_probe', description: 'Return the exact supplied value', inputSchema: {value: z.string()},
  handler: async args => {bridgeCalls++; return {content: [{type: 'text', text: 'probe:' + args.value}]};},
}}];
function sse(response, model, deltas, finish) {
  response.writeHead(200, {'Content-Type': 'text/event-stream'});
  for (const delta of deltas) response.write('data: ' + JSON.stringify({id: 'wire-response', model,
    choices: [{index: 0, delta, finish_reason: null}]}) + '\n\n');
  response.end('data: ' + JSON.stringify({id: 'wire-response', model,
    choices: [{index: 0, delta: {}, finish_reason: finish}],
    usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}) + '\n\ndata: [DONE]\n\n');
}
const fake = await servers.listen(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); bodies.push(body);
    assert.ok(active); assert.equal(body.model, active.model);
    const index = active.requests++;
    if (active.mode === 'tool' && index < 2) {
      const toolName = body.tools?.find(tool => tool.function?.name.endsWith('native_probe'))?.function.name;
      assert.ok(toolName, 'The native host must expose the authorized MCP tool');
      assert.ok(!body.tools.some(tool => tool.function?.name === 'bash'));
      if (index === 1) {
        const previous = body.messages.find(message => message.tool_calls?.[0]?.id === 'call-0');
        if (active.reasoningReplay) assert.equal(previous?.reasoning_content, reasoning + '0');
        assert.equal(previous.tool_calls[0].function.arguments, '{"value":"round-0"}');
        assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-0'));
      }
      sse(response, body.model, [{role: 'assistant'}, {reasoning_content: reasoning.slice(0, 3)},
        {reasoning_content: reasoning.slice(3) + index},
        {tool_calls: [{index: 0, id: 'call-' + index, type: 'function', function: {name: toolName, arguments: '{"value":'}}]},
        {tool_calls: [{index: 0, function: {arguments: '"round-' + index + '"}'}}]}], 'tool_calls');
    } else if (active.mode === 'denied' && index === 0) {
      assert.ok(!body.tools?.some(tool => tool.function?.name === 'bash'));
      sse(response, body.model, [{role: 'assistant', tool_calls: [{index: 0, id: 'denied-call', type: 'function',
        function: {name: 'bash', arguments: JSON.stringify({command: 'touch ' + active.deniedPath})}}]}], 'tool_calls');
    } else {
      if (active.mode === 'tool') {
        assert.equal(index, 2);
        for (let round = 0; round < 2; round++) {
          const previous = body.messages.find(message => message.tool_calls?.[0]?.id === 'call-' + round);
          if (active.reasoningReplay) assert.equal(previous?.reasoning_content, reasoning + round);
        }
      }
      sse(response, body.model, [{role: 'assistant', content: 'NATIVE_FINAL'}], 'stop');
    }
  } catch (error) {serverFailure = error; response.writeHead(500); response.end('fixture_failure');}
});
const address = fake.address(); assert.ok(address && typeof address === 'object');
const fakeBase = 'http://127.0.0.1:' + address.port + '/v1';
async function runCase({model, officialBase, purpose, mode = 'answer', expectedReasoningReplay = false, expectedControls}) {
  const caseRoot = await mkdtemp(path.join(root, 'case-'));
  const dirs = {projectDir: path.join(caseRoot, 'project'), homeDir: path.join(caseRoot, 'home'), configDir: path.join(caseRoot, 'config')};
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir, {recursive: true})));
  const captured = native.resolveOpenCodeModelConfig({SMARTPERFETTO_OPENCODE_MODEL_JSON: JSON.stringify({
    modelID: model, baseURL: officialBase, apiKey: 'test-only-key'})}, {source: 'env', runtimeKind: 'opencode'});
  const options = native.openCodePurposeAgentOptions(captured, purpose, typeof sdk.createOpencodeClient === 'function');
  assert.deepEqual(options, expectedControls);
  assert.equal(captured.providerConfig.smartperfetto.models[model].temperature, undefined);
  assert.deepEqual(captured.providerConfig.smartperfetto.models[model].interleaved,
    expectedReasoningReplay ? {field: 'reasoning_content'} : undefined);
  // The product resolves the official facts first. Only the test transport destination is replaced.
  captured.providerConfig.smartperfetto.options.baseURL = fakeBase;
  const bridge = mode === 'tool' ? await native.startOpenCodeMcpBridge(definitions) : undefined;
  const allowed = bridge ? ['native_probe'] : [];
  const config = createOpenCodeHardenedConfig(allowed, {}, bridge, captured, mode === 'answer' ? 2 : 5, options);
  config.logLevel = 'ERROR';
  const state = active = {model, mode, requests: 0, deniedPath: path.join(caseRoot, 'must-not-exist'),
    reasoningReplay: expectedReasoningReplay};
  const firstBody = bodies.length;
  let host;
  try {
    host = await native.createOpenCodeInstanceWithExplicitEnv(sdk, dirs, {PATH: process.env.PATH},
      {hostname: '127.0.0.1', timeout: 20000, config}, {spawnChild: (exe, args, spawnOptions) => spawn(exe, args,
        {...spawnOptions, env: {...spawnOptions.env, OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_MODELS_PATH: modelsPath, OPENCODE_DISABLE_AUTOUPDATE: 'true'}})});
    const signal = AbortSignal.timeout(30000);
    const query = {directory: dirs.projectDir};
    async function prompt() {
      const created = await host.client.session.create({body: {title: 'Native wire contract'}, query, signal});
      assert.ok(created.data?.id);
      const reply = await host.client.session.prompt({path: {id: created.data.id}, query, signal, body: {
        model: captured.model, agent: 'smartperfetto', system: 'Follow the supplied protocol.',
        tools: createOpenCodeToolAllowlist(allowed), parts: [{type: 'text', text: 'Run the native contract.'}],
      }});
      if (serverFailure) throw serverFailure;
      assert.equal(reply.data?.info?.finish, 'stop');
      assert.equal(extractOpenCodeAssistantText(reply.data), 'NATIVE_FINAL');
      assert.ok(!extractOpenCodeAssistantText(reply.data).includes(reasoning));
      return reply;
    }
    await prompt();
    assert.equal(state.requests, mode === 'tool' ? 3 : mode === 'denied' ? 2 : 1);
    const first = bodies[firstBody];
    if (model === 'unknown-native-model') assert.equal(first.temperature, undefined);
    if (purpose) {
      assert.deepEqual(first.thinking, expectedControls?.thinking);
      assert.equal(first.reasoning_effort, expectedControls?.reasoningEffort);
      if (expectedControls?.response_format) assert.deepEqual(first.response_format, expectedControls.response_format);
    } else {assert.equal(first.thinking, undefined); assert.equal(first.reasoning_effort, undefined);}
    if (mode === 'tool') {
      state.mode = 'answer'; state.requests = 0;
      const next = bodies.length;
      await prompt();
      assert.equal(state.requests, 1);
      assert.ok(!JSON.stringify(bodies[next].messages).includes(reasoning));
    }
    if (mode === 'denied') await assert.rejects(access(state.deniedPath));
  } finally {await host?.server.close(); await bridge?.close(); await rm(caseRoot, {recursive: true, force: true});}
}
try {
  await runCase({model: 'glm-5.3-flash', officialBase: 'https://open.bigmodel.cn/api/coding/paas/v4', purpose: 'classification',
    expectedReasoningReplay: true, expectedControls: {thinking: {type: 'enabled'}, reasoningEffort: 'low'}});
  await runCase({model: 'deepseek-flash', officialBase: 'https://api.deepseek.com/v1', purpose: 'classification',
    expectedReasoningReplay: true, expectedControls: {thinking: {type: 'disabled'}}});
  await runCase({model: 'glm-5.3-flash', officialBase: 'https://open.bigmodel.cn/api/coding/paas/v4', mode: 'tool', expectedReasoningReplay: true});
  await runCase({model: 'deepseek-flash', officialBase: 'https://api.deepseek.com/v1', mode: 'tool', expectedReasoningReplay: true});
  await runCase({model: 'unknown-native-model', officialBase: 'https://unknown.invalid/v1', mode: 'tool'});
  await runCase({model: 'unknown-native-model', officialBase: 'https://unknown.invalid/v1', mode: 'denied'});
  assert.equal(bridgeCalls, 6);
  assert.equal(bodies.length, 16);
  console.log('OpenCode native provider contract: PASS (6 hosts, 16 requests, 6 authorized tool calls; stage controls, reasoning continuity, fresh-session isolation, unknown metadata, denied built-in)');
} finally {await servers.close(); await rm(root, {recursive: true, force: true});}
`;
const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
  cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', timeout: 180000,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
