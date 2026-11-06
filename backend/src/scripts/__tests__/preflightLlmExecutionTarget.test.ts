// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildRuntimeConfigCommitments, runtimeConfigCommitmentsFingerprint,
  runtimeConfigControlsFingerprint} from '../../agentRuntime/runtimePerformance';
import type {LlmTargetPreflightRequest, LlmTargetPreflightResult} from '../preflightLlmExecutionTarget';

const backendRoot = path.resolve(__dirname, '../../..');
const repositoryRoot = path.dirname(backendRoot);
const entry = path.join(backendRoot, 'src/scripts/preflightLlmExecutionTarget.ts');
const lifecycle: {fingerprintSourceTree(root: string): string} = require('../../../scripts/llm-execution-lifecycle.cjs');
const CANARY = 'PRIVATE_PREFLIGHT_FIXTURE_CANARY';

// Installed after loader bootstrap, before the real entrypoint. The production gate is never mocked.
const guardSource = String.raw`
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const sourceRoot = fs.realpathSync(path.join(process.env.PREFLIGHT_BACKEND_ROOT, 'src')) + path.sep;
const journal = {attempts: [], forbiddenImports: [], guardedSdk: [], configCalls: [], sdkModes: [], purposeInputs: [], configKeys: [], events: [], allowedBootstrap: 0};
let loadedConfig;
let umbrellaImportDepth = 0;
const blocked = name => function () {journal.attempts.push(name); throw new Error('blocked_test_operation');};
globalThis.fetch = blocked('fetch');
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  for (const key of ['request', 'get', 'createServer']) module[key] = blocked(name + ':' + key);
}
const net = require('node:net'), tls = require('node:tls');
net.connect = blocked('net.connect'); net.createConnection = blocked('net.createConnection');
net.createServer = blocked('net.createServer'); net.Socket.prototype.connect = blocked('Socket.connect');
net.Server.prototype.listen = blocked('Server.listen'); tls.connect = blocked('tls.connect');
const child = require('node:child_process');
for (const key of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = child[key];
  child[key] = function (command, ...args) {
    if (/trace_processor/i.test(String(command))) return blocked('TraceProcessor')();
    return original.call(this, command, ...args);
  };
}
const originalLoad = Module._load, constructors = new WeakMap(), alreadyWrapped = new WeakSet();
const sdkModules = new WeakMap(), configModules = new WeakMap(), gateModules = new WeakMap(), clientModules = new WeakMap();
function guardConstructor(value, name) {
  if (alreadyWrapped.has(value)) return value;
  let wrapped = constructors.get(value);
  if (!wrapped) {
    if (name === 'OpenAIProvider') value.prototype.getModel = blocked('sdk:OpenAIProvider.getModel');
    wrapped = new Proxy(value, {construct(target, args, newTarget) {
      if (name === 'OpenAIProvider' && umbrellaImportDepth > 0 && journal.allowedBootstrap === 0 && args.length === 1 &&
          args[0] && Object.keys(args[0]).length === 1 && args[0].cacheResponsesWebSocketModels === false) {
        journal.allowedBootstrap++; journal.events.push('allowed_sdk_bootstrap');
        return Reflect.construct(target, args, newTarget);
      }
      return blocked('sdk:' + name)();
    }, apply: blocked('sdk:' + name)});
    constructors.set(value, wrapped); alreadyWrapped.add(wrapped); journal.guardedSdk.push(name);
  }
  return wrapped;
}
Module._load = function (request, parent, isMain) {
  let resolved = '';
  try {resolved = Module._resolveFilename(request, parent);} catch {}
  if (resolved.startsWith(sourceRoot) &&
      /^(?:routes[/\\]|server\.|index\.|scripts[/\\]verifyAgentSseScrolling\.|agentRuntime[/\\]engines[/\\]openai[/\\]openAiRuntime\.)/.test(resolved.slice(sourceRoot.length))) {
    const relative = filename => {
      if (typeof filename !== 'string') return '[unknown]';
      const value = path.relative(process.env.PREFLIGHT_BACKEND_ROOT, filename);
      return value.startsWith('..') || path.isAbsolute(value) ? '[outside_backend]' : value.slice(0, 240);
    };
    const parents = [];
    for (let current = parent; current && parents.length < 12; current = current.parent) parents.push(relative(current.filename));
    if (journal.forbiddenImports.length < 4) journal.forbiddenImports.push({resolved: relative(resolved), parents});
    return blocked('forbidden_runtime_import')();
  }
  const umbrella = /@openai[/\\]agents[/\\]dist[/\\]index\.(?:js|mjs)$/.test(resolved);
  let value;
  if (umbrella) umbrellaImportDepth++;
  try {value = originalLoad.call(this, request, parent, isMain);} finally {if (umbrella) umbrellaImportDepth--;}
  if (/[/\\]openai[/\\](?:index|client)\.(?:js|mjs)$/.test(resolved)) {
    if (typeof value === 'function') return guardConstructor(value, 'OpenAIClient');
    if (!clientModules.has(value)) clientModules.set(value, new Proxy(value, {get(target, key, receiver) {
      const item = Reflect.get(target, key, receiver);
      return ['default', 'OpenAI'].includes(key) && typeof item === 'function' ? guardConstructor(item, 'OpenAIClient') : item;
    }}));
    return clientModules.get(value);
  }
  if (/(?:@openai[/\\]agents(?:-core|-openai)?[/\\].*[/\\]index\.(?:js|mjs)$)/.test(resolved)) {
    if (!sdkModules.has(value)) sdkModules.set(value, new Proxy(value, {get(target, key, receiver) {
      const item = Reflect.get(target, key, receiver);
      if (['Agent', 'Runner', 'OpenAIProvider', 'StreamedRunResult'].includes(key) && typeof item === 'function') return guardConstructor(item, key);
      if (['run', 'runStreamed'].includes(key) && typeof item === 'function') return blocked('sdk:' + key);
      return item;
    }}));
    return sdkModules.get(value);
  }
  if (/[/\\]engines[/\\]openai[/\\]openAiConfig\.(?:ts|js)$/.test(resolved)) {
    if (!configModules.has(value)) configModules.set(value, new Proxy(value, {get(target, key, receiver) {
      const item = Reflect.get(target, key, receiver);
      if (key === 'loadOpenAIConfig') return function (providerId, providerScope) {
          journal.events.push('load_config');
          journal.configCalls.push({providerId: providerId === undefined ? 'absent' : providerId,
            providerScope: providerScope === undefined ? 'absent' : providerScope});
          loadedConfig = item.apply(this, arguments);
          journal.configKeys = Object.keys(loadedConfig);
          return loadedConfig;
        };
      if (['resolveOpenAiClassifierOutputLimit', 'createOpenAiFinalizationConfig'].includes(key)) return function (config) {
          journal.events.push(key);
          journal.purposeInputs.push({helper: key, sameConfig: config === loadedConfig});
          return item.apply(this, arguments);
        };
      return item;
    }}));
    return configModules.get(value);
  }
  if (/[/\\]engines[/\\]openai[/\\]openAiFinalSubmissionConfig\.(?:ts|js)$/.test(resolved)) {
    if (!gateModules.has(value)) gateModules.set(value, new Proxy(value, {get(target, key, receiver) {
      const item = Reflect.get(target, key, receiver);
      if (key === 'installedOpenAiSdkCompatibility') return function (mode) {
        journal.sdkModes.push(mode === undefined ? 'absent' : mode);
        return item.apply(this, arguments);
      };
      if (key !== 'admitFinalSubmissionConfiguration') return item;
      return function () {journal.events.push('production_gate'); return item.apply(this, arguments);};
    }}));
    return gateModules.get(value);
  }
  return value;
};
journal.events.push('guard_installed');
process.once('exit', () => fs.writeFileSync(process.env.PREFLIGHT_GUARD_JOURNAL, JSON.stringify(journal)));
`;

interface GuardJournal {
  attempts: string[]; guardedSdk: string[]; events: string[]; allowedBootstrap: number;
  forbiddenImports: Array<{resolved: string; parents: string[]}>;
  configCalls: Array<{providerId: unknown; providerScope: unknown}>;
  sdkModes: string[];
  configKeys: string[]; purposeInputs: Array<{helper: string; sameConfig: boolean}>;
}

describe('maintained LLM execution target preflight', () => {
  let directory: string;
  let sequence = 0;
  beforeEach(() => {directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llm-preflight-')));});
  afterEach(() => {fs.rmSync(directory, {recursive: true, force: true});});

  function fixture(overrides: Partial<LlmTargetPreflightRequest> = {}) {
    const root = path.join(directory, `probe-${++sequence}`), runtime = path.join(root, 'runtime');
    fs.mkdirSync(path.join(runtime, 'data'), {recursive: true});
    fs.mkdirSync(path.join(runtime, 'logs'));
    const dotenv = path.join(runtime, '.benchmark-empty.env'); fs.writeFileSync(dotenv, '');
    const input = path.join(root, 'request.json'), output = path.join(root, 'receipt.json');
    const guard = path.join(root, 'guard.cjs'), journal = path.join(root, 'guard.json');
    fs.writeFileSync(guard, guardSource);
    const fields = buildRuntimeConfigCommitments({configuration: {model: 'declared-only'}, environment: {
      SMARTPERFETTO_FINAL_SUBMISSION: 'assistant_text', SMARTPERFETTO_CONCLUSION_AUTHORING: 'canonical_v1'}})!;
    const request: LlmTargetPreflightRequest = {schemaVersion: 'llm_target_preflight_request@1', nonce: 'a'.repeat(32),
      side: 'base', cellId: 'scheduler', requestedMode: 'auto', expectedSourceFingerprint: lifecycle.fingerprintSourceTree(repositoryRoot),
      declaredConfig: {schemaVersion: 'benchmark_config_commitments@2', fields,
        fullFingerprint: runtimeConfigCommitmentsFingerprint(fields)!, controlsFingerprint: runtimeConfigControlsFingerprint(fields)!,
        legacyConfigFingerprint: 'b'.repeat(64)}, treatmentHash: 'c'.repeat(64), ...overrides};
    fs.writeFileSync(input, JSON.stringify(request));
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: root, TMPDIR: os.tmpdir(),
      SMARTPERFETTO_BACKEND_DATA_DIR: path.join(runtime, 'data'), SMARTPERFETTO_BACKEND_LOG_DIR: path.join(runtime, 'logs'),
      SMARTPERFETTO_ENV_FILE: dotenv, DOTENV_CONFIG_PATH: dotenv, DOTENV_CONFIG_QUIET: 'true',
      OPENAI_API_KEY: CANARY, OPENAI_BASE_URL: `https://${CANARY.toLowerCase()}.invalid/v1`,
      OPENAI_MODEL: 'unknown-baseline-model', OPENAI_LIGHT_MODEL: 'unknown-baseline-light',
      OPENAI_AGENTS_PROTOCOL: 'responses', OPENAI_ANALYSIS_REASONING_EFFORT: 'xhigh',
      SMARTPERFETTO_FINAL_SUBMISSION: 'assistant_text', SMARTPERFETTO_CONCLUSION_AUTHORING: 'canonical_v1',
      PREFLIGHT_GUARD_JOURNAL: journal, PREFLIGHT_BACKEND_ROOT: backendRoot};
    const run = (extra: NodeJS.ProcessEnv = {}, args = ['--input', input, '--output', output]) => {
      const result = spawnSync(process.execPath, ['--require', require.resolve('tsx/preflight'),
        '--import', pathToFileURL(require.resolve('tsx')).href, '--import', pathToFileURL(guard).href, entry, ...args],
      {cwd: backendRoot, env: {...env, ...extra}, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024});
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      const observed: GuardJournal = JSON.parse(fs.readFileSync(journal, 'utf8'));
      expect(observed.forbiddenImports).toEqual([]);
      expect(observed.attempts).toEqual([]);
      expect(observed.events[0]).toBe('guard_installed');
      expect(observed.allowedBootstrap).toBeLessThanOrEqual(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(CANARY);
      return {...result, observed};
    };
    const receipt = () => JSON.parse(fs.readFileSync(output, 'utf8')) as LlmTargetPreflightResult;
    return {root, runtime, input, output, env, request, run, receipt};
  }

  it.each([
    'src/index.ts',
    'src/agentRuntime/engines/openai/openAiRuntime.ts',
    'src/scripts/verifyAgentSseScrolling.ts',
    'src/routes/agentRoutes.ts',
  ])('blocks the actual product entry before evaluating it: %s', modulePath => {
    const test = fixture();
    const result = spawnSync(process.execPath, ['--require', require.resolve('tsx/preflight'),
      '--import', pathToFileURL(require.resolve('tsx')).href,
      '--import', pathToFileURL(path.join(test.root, 'guard.cjs')).href,
      '--eval', 'require(process.argv[1])', path.join(backendRoot, modulePath)],
    {cwd: backendRoot, env: test.env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024});
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
    const journal: GuardJournal = JSON.parse(fs.readFileSync(path.join(test.root, 'guard.json'), 'utf8'));
    expect(journal.attempts).toEqual(['forbidden_runtime_import']);
    expect(journal.forbiddenImports).toEqual([{resolved: path.normalize(modulePath), parents: expect.any(Array)}]);
    expect(journal.events).toEqual(['guard_installed']);
    expect(journal.guardedSdk).toEqual([]); expect(journal.configCalls).toEqual([]);
    expect(result.stderr).toContain('blocked_test_operation');
    expect(`${result.stdout}${result.stderr}`).not.toContain(CANARY);
  });

  function assertPurposeContracts(receipt: LlmTargetPreflightResult, journal: GuardJournal,
    input: {protocol: string; model: string; lightModel: string; baseURL: string; cap?: number;
      classifierLimit: number; classifierField: string; reviewField: string}) {
    if (receipt.status !== 'ready') throw new Error('Expected purpose contracts after actual gate success');
    expect(receipt.schemaVersion).toBe('llm_target_preflight@3');
    expect(receipt.outputImplementation).toEqual({kind: 'assistant', nativeContract: 'openai_native_completion_observer@1'});
    expect(journal.sdkModes).toEqual(['assistant_text']);
    expect(receipt.sdk.nodeVersion).toBe(process.versions.node);
    expect(receipt.actualResolvedConfig.some(row => row.field === '/sdk/nodeVersion')).toBe(false);
    expect(journal.purposeInputs).toEqual([
      {helper: 'createOpenAiFinalizationConfig', sameConfig: true},
      {helper: 'resolveOpenAiClassifierOutputLimit', sameConfig: true},
    ]);
    const gate = journal.events.indexOf('production_gate');
    expect(gate).toBeGreaterThan(journal.events.indexOf('load_config'));
    for (const item of journal.purposeInputs) expect(journal.events.indexOf(item.helper)).toBeGreaterThan(gate);
    const {classification, review} = receipt.purposeContracts;
    expect(Object.keys(receipt.purposeContracts).sort()).toEqual(['classification', 'review', 'schemaVersion']);
    expect(receipt.purposeContracts.schemaVersion).toBe('llm_purpose_controls@1');
    const sdk = {packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'};
    const sdkRows = buildRuntimeConfigCommitments({sdk})!.filter(row => row.field !== '');
    const sharedRows = (rows: typeof classification.commonConfig) => rows.filter(row => row.field !== '' &&
      row.field !== '/sdk' && !row.field.startsWith('/sdk/') &&
      row.field !== '/outputConfig' && !row.field.startsWith('/outputConfig/'));
    expect(sharedRows(classification.commonConfig)).toEqual(sharedRows(receipt.actualResolvedConfig));
    const classificationKeys = journal.configKeys.filter(key => !['apiKey', 'outputConfig'].includes(key)).concat('runtime', 'sdk');
    const expectedRoot = buildRuntimeConfigCommitments(Object.fromEntries(classificationKeys.map(key => [key, undefined])))![0];
    expect(classification.commonConfig[0]).toEqual(expectedRoot);
    for (const contract of [classification, review]) {
      expect(Object.keys(contract).sort()).toEqual(['commonConfig', 'tokenLimit']);
      expect(contract.commonConfig.filter(row => row.field === '/sdk' || row.field.startsWith('/sdk/'))).toEqual(sdkRows);
      expect(contract.commonConfig.some(row => row.field === '/apiKey' || row.field.startsWith('/outputConfig'))).toBe(false);
    }
    expect(review.commonConfig).toEqual(buildRuntimeConfigCommitments({baseURL: input.baseURL,
      protocol: input.protocol, lightModel: input.model,
      ...(input.cap === undefined ? {} : {maxOutputTokens: input.cap}), runtime: 'openai-agents-sdk', sdk}));
    const expectedLight = buildRuntimeConfigCommitments({lightModel: input.lightModel})!.find(row => row.field === '/lightModel');
    expect(classification.commonConfig.find(row => row.field === '/lightModel')).toEqual(expectedLight);
    const limit = (value: number, field: string) => ({status: 'explicit', field,
      valueCommitment: buildRuntimeConfigCommitments({limit: value})!.find(row => row.field === '/limit')!.valueCommitment});
    expect(classification.tokenLimit).toEqual(limit(input.classifierLimit, input.classifierField));
    expect(review.tokenLimit).toEqual(input.cap === undefined ? {status: 'absent'} : limit(input.cap, input.reviewField));
  }

  it.each(['auto', 'fast', 'full'] as const)('uses the real assistant gate without typed model/effort restrictions: %s', requestedMode => {
    const test = fixture({requestedMode});
    const result = test.run();
    expect(result.status).toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
    expect(result.observed.guardedSdk).toEqual(expect.arrayContaining(['Agent', 'Runner', 'OpenAIProvider', 'StreamedRunResult']));
    expect(result.observed.configCalls).toEqual([{providerId: 'absent', providerScope: 'absent'}]);
    expect(result.observed.allowedBootstrap).toBe(1);
    expect(result.observed.events.filter(event => ['guard_installed', 'load_config', 'production_gate'].includes(event)))
      .toEqual(['guard_installed', 'load_config', 'production_gate']);
    const receipt = test.receipt();
    expect(receipt).toMatchObject({status: 'ready', requestedMode, observedSourceFingerprint: test.request.expectedSourceFingerprint,
      capturedOutput: {finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'},
      sdk: {agentsCoreVersion: '0.13.0', agentsOpenAiVersion: '0.13.0', identity: 'matched', nodeVersion: process.versions.node},
      declaredConfigFingerprint: test.request.declaredConfig.fullFingerprint});
    if (receipt.status !== 'ready') throw new Error('Expected actual gate success');
    expect(receipt.actualResolvedConfig).not.toEqual(test.request.declaredConfig.fields);
    expect(receipt.actualResolvedConfig.some(item => item.field === '/apiKey')).toBe(false);
    expect(receipt.actualResolvedConfig).toEqual(expect.arrayContaining([
      expect.objectContaining({field: '/outputConfig/finalSubmission', type: 'string'}),
      expect.objectContaining({field: '/model', type: 'string'}),
      expect.objectContaining({field: '/maxOutputTokens', presence: 'present', type: 'undefined'}),
      expect.objectContaining({field: '/sdk/identity', type: 'string'}),
    ]));
    const serialized = fs.readFileSync(test.output, 'utf8');
    for (const value of [CANARY, CANARY.toLowerCase(), 'unknown-baseline-model', 'declared-only', test.root]) expect(serialized).not.toContain(value);
    assertPurposeContracts(receipt, result.observed, {protocol: 'responses', model: 'unknown-baseline-model',
      lightModel: 'unknown-baseline-light', baseURL: test.env.OPENAI_BASE_URL!, classifierLimit: 2048,
      classifierField: 'max_output_tokens', reviewField: 'max_output_tokens'});
  });

  it.each([
    {configured: undefined, classifierLimit: 2048},
    {configured: 4096, classifierLimit: 2048},
    {configured: 1000, classifierLimit: 1000},
  ])('records exact production caps and complete stage configurations: $configured', ({configured, classifierLimit}) => {
    const test = fixture();
    const result = test.run({OPENAI_MAX_OUTPUT_TOKENS: configured?.toString(), OPENAI_AGENTS_PROTOCOL: 'chat_completions',
      OPENAI_MODEL: 'gpt-5.6', OPENAI_LIGHT_MODEL: 'glm-5.3-flash'});
    expect(result.status).toBe(0);
    assertPurposeContracts(test.receipt(), result.observed, {protocol: 'chat_completions', model: 'gpt-5.6',
      lightModel: 'glm-5.3-flash', baseURL: test.env.OPENAI_BASE_URL!, cap: configured, classifierLimit,
      classifierField: 'max_tokens', reviewField: 'max_completion_tokens'});
    expect(fs.readFileSync(test.output, 'utf8')).not.toContain(CANARY);
  });

  it.each([
    {protocol: 'chat_completions', model: 'glm-5.3-flash', lightModel: 'gpt-5.6',
      classifierField: 'max_completion_tokens', reviewField: 'max_tokens'},
    {protocol: 'responses', model: 'gpt-5.6', lightModel: 'glm-5.3-flash',
      classifierField: 'max_output_tokens', reviewField: 'max_output_tokens'},
  ])('maps each stage actual model to its sole token field: $protocol', input => {
    const test = fixture();
    const result = test.run({OPENAI_MAX_OUTPUT_TOKENS: '4096', OPENAI_AGENTS_PROTOCOL: input.protocol,
      OPENAI_MODEL: input.model, OPENAI_LIGHT_MODEL: input.lightModel});
    expect(result.status).toBe(0);
    assertPurposeContracts(test.receipt(), result.observed, {...input, baseURL: test.env.OPENAI_BASE_URL!,
      cap: 4096, classifierLimit: 2048});
  });

  it('passes the exact explicit provider and scope to the real loader, preserving null versus absent', () => {
    const scope = {tenantId: 'tenant-one', workspaceId: 'workspace-one', userId: 'user-one'};
    for (const providerId of ['fixture-provider', null]) {
      const test = fixture({providerId, providerScope: scope});
      fs.writeFileSync(path.join(test.runtime, 'data/providers.json'), JSON.stringify([{
        id: 'fixture-provider', name: CANARY, type: 'openai', isActive: true,
        models: {primary: 'selected-provider-model', light: 'selected-provider-light'},
        connection: {agentRuntime: 'openai-agents-sdk', apiKey: CANARY, baseUrl: 'https://fixture.invalid/v1', openaiProtocol: 'responses'},
      }]));
      const result = test.run();
      expect(result.status).toBe(0);
      expect(result.observed.configCalls).toEqual([{providerId, providerScope: scope}]);
      const receipt = test.receipt();
      if (receipt.status !== 'ready') throw new Error('Expected actual provider selection');
      const expectedModel = providerId === null ? 'unknown-baseline-model' : 'selected-provider-model';
      const expected = buildRuntimeConfigCommitments({model: expectedModel})!.find(item => item.field === '/model');
      expect(receipt.actualResolvedConfig.find(item => item.field === '/model')).toEqual(expected);
    }
  });

  it('returns fixed real typed-gate refusal without sending a model request', () => {
    const test = fixture({side: 'candidate'});
    const result = test.run({SMARTPERFETTO_FINAL_SUBMISSION: 'authored_claim_document_v1'});
    expect(result.status).toBe(1);
    expect(result.observed.purposeInputs).toEqual([]);
    expect(test.receipt()).toMatchObject({schemaVersion: 'llm_target_preflight@3', status: 'failed', failureCode: 'unsupported_final_submission'});
  });

  it('keeps a supported typed-v1 production gate separate from v3 treatment eligibility', () => {
    const test = fixture({side: 'candidate'});
    const result = test.run({SMARTPERFETTO_FINAL_SUBMISSION: 'authored_claim_document_v1',
      OPENAI_AGENTS_PROTOCOL: 'chat_completions', OPENAI_BASE_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      OPENAI_MODEL: 'glm-5.3-flash', OPENAI_LIGHT_MODEL: 'glm-5.3-flash', OPENAI_ANALYSIS_REASONING_EFFORT: 'low'});
    expect(result.status).toBe(1);
    expect(test.receipt()).toMatchObject({status: 'failed', failureCode: 'invalid_configuration'});
  });

  it('refuses actual output that differs from the declared side after the real gate', () => {
    const test = fixture({side: 'candidate'});
    const result = test.run();
    expect(result.status).toBe(1);
    expect(test.receipt()).toMatchObject({status: 'failed', failureCode: 'invalid_configuration'});
  });

  it('does not expose a bad configuration value or a selected missing provider', () => {
    const badConfig = fixture();
    expect(badConfig.run({OPENAI_MAX_OUTPUT_TOKENS: CANARY}).status).toBe(1);
    expect(badConfig.receipt()).toMatchObject({status: 'failed', failureCode: 'invalid_configuration'});
    const missing = fixture({providerId: CANARY});
    expect(missing.run().status).toBe(1);
    expect(missing.receipt()).toMatchObject({status: 'failed', failureCode: 'invalid_configuration'});
    expect(fs.readFileSync(missing.output, 'utf8')).not.toContain(CANARY);
  });

  it('recomputes the checkout source and refuses a mismatch before loading a provider', () => {
    const test = fixture({expectedSourceFingerprint: '0'.repeat(64)});
    const result = test.run();
    expect(result.status).toBe(1); expect(result.observed.configCalls).toEqual([]);
    expect(test.receipt()).toMatchObject({status: 'failed', failureCode: 'source_mismatch',
      observedSourceFingerprint: lifecycle.fingerprintSourceTree(repositoryRoot)});
  });

  it('fails closed before a user-store or host-dotenv fallback', () => {
    const test = fixture();
    const result = test.run({SMARTPERFETTO_BACKEND_DATA_DIR: undefined});
    expect(result.status).toBe(1); expect(result.observed.configCalls).toEqual([]);
    expect(test.receipt()).toMatchObject({status: 'failed', failureCode: 'probe_unavailable'});
  });

  it('rejects invalid commitments and oversized or malformed input without creating a receipt', () => {
    for (const content of ['PRIVATE_INVALID_JSON_CANARY', ' '.repeat(1024 * 1024 + 1), 'commitment']) {
      const test = fixture();
      fs.writeFileSync(test.input, content === 'commitment' ? JSON.stringify({...test.request,
        declaredConfig: {...test.request.declaredConfig, fullFingerprint: '0'.repeat(64)}}) : content);
      const result = test.run();
      expect(result.status).toBe(2); expect(result.observed.configCalls).toEqual([]);
      expect(fs.existsSync(test.output)).toBe(false);
      expect(result.stderr).toBe('LLM execution preflight unavailable.\n');
    }
  });

  it('rejects foreign modes, cells and request fields before reading production configuration', () => {
    for (const extra of [{requestedMode: 'smart'}, {cellId: 'foreign'}, {providerScope: null}, {privateText: CANARY}]) {
      const test = fixture();
      fs.writeFileSync(test.input, JSON.stringify({...test.request, ...extra}));
      const result = test.run();
      expect(result.status).toBe(2); expect(result.observed.configCalls).toEqual([]);
      expect(fs.existsSync(test.output)).toBe(false);
      expect(result.stderr).toBe('LLM execution preflight unavailable.\n');
    }
  });

  it('refuses duplicate arguments, reused output and symlink input without overwriting evidence', () => {
    const duplicate = fixture();
    expect(duplicate.run({}, ['--input', duplicate.input, '--output', duplicate.output, '--input', duplicate.input]).status).toBe(2);
    const reused = fixture(); fs.writeFileSync(reused.output, 'sentinel');
    expect(reused.run().status).toBe(2); expect(fs.readFileSync(reused.output, 'utf8')).toBe('sentinel');
    const linked = fixture(), link = path.join(linked.root, 'linked.json'); fs.symlinkSync(linked.input, link);
    expect(linked.run({}, ['--input', link, '--output', linked.output]).status).toBe(2);
    expect(fs.existsSync(linked.output)).toBe(false);
  });
});
