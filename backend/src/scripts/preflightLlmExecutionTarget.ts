// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import fs from 'node:fs';
import path from 'node:path';
import type {ProviderScope} from '../services/providerManager';
import type {RuntimeBenchmarkConfigCommitmentsV2, RuntimeConfigFieldCommitment} from '../agentRuntime/runtimePerformance';
import type {OpenAIAgentConfig} from '../agentRuntime/engines/openai/openAiConfig';
import {OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION, type OpenAiOutputImplementation} from '../agentRuntime/finalSubmissionImplementation';
import {parseStoredJson} from '../utils/storedData';

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface LlmTargetPreflightRequest {
  readonly schemaVersion: 'llm_target_preflight_request@1';
  readonly nonce: string;
  readonly side: 'base' | 'candidate';
  readonly cellId: string;
  readonly requestedMode: 'auto' | 'fast' | 'full';
  readonly providerId?: string | null;
  readonly providerScope?: ProviderScope;
  readonly expectedSourceFingerprint: string;
  readonly declaredConfig: RuntimeBenchmarkConfigCommitmentsV2;
  readonly treatmentHash: string;
}
type PreflightOutputConfig =
  | Readonly<{finalSubmission: 'assistant_text'; declarationSyntax: 'canonical_v1'}>
  | Readonly<{finalSubmission: 'authored_claim_document_v2'; declarationSyntax: 'authoring_v2'}>;
type PreflightFailureCode = 'invalid_configuration' | 'unsupported_final_submission' | 'source_mismatch' | 'probe_unavailable';
export type PurposeTokenLimit = Readonly<{status: 'absent'}> | Readonly<{
  status: 'explicit';
  field: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  valueCommitment: string;
}>;
interface PurposeContract {
  readonly commonConfig: readonly RuntimeConfigFieldCommitment[];
  readonly tokenLimit: PurposeTokenLimit;
}
export interface LlmPurposeContractsV1 {
  readonly schemaVersion: 'llm_purpose_controls@1';
  readonly classification: PurposeContract;
  readonly review: PurposeContract;
}
interface PreflightBindings {
  readonly schemaVersion: 'llm_target_preflight@3';
  readonly nonce: string;
  readonly side: 'base' | 'candidate';
  readonly cellId: string;
  readonly requestedMode: 'auto' | 'fast' | 'full';
  readonly observedSourceFingerprint: string;
  readonly declaredConfigFingerprint: string;
  readonly declaredControlsFingerprint: string;
  readonly declaredTreatmentHash: string;
}
export type LlmTargetPreflightResult = PreflightBindings & (
  | Readonly<{status: 'ready'; capturedOutput: PreflightOutputConfig;
    outputImplementation: OpenAiOutputImplementation;
    actualResolvedConfig: readonly RuntimeConfigFieldCommitment[];
    purposeContracts: LlmPurposeContractsV1;
    sdk: Readonly<{agentsCoreVersion: string; agentsOpenAiVersion: string; identity: 'matched' | 'unknown'; nodeVersion: string}>}>
  | Readonly<{status: 'failed'; failureCode: PreflightFailureCode}>
);

function unavailable(): never {throw new Error('llm_preflight_unavailable');}

function purposeContract(config: Pick<OpenAIAgentConfig, 'lightModel' | 'protocol'>, limit: number | undefined): PurposeContract {
  const {buildRuntimeCommonModelConfig, buildRuntimeConfigCommitments}:
    typeof import('../agentRuntime/runtimePerformance') = require('../agentRuntime/runtimePerformance');
  const {buildOpenAIChatCompletionsTokenLimit}:
    typeof import('../services/providerManager/openAiChatCompletionsCompat') = require('../services/providerManager/openAiChatCompletionsCompat');
  const common = buildRuntimeCommonModelConfig(config, {runtime: 'openai-agents-sdk', sdk: {
    packageName: 'node:fetch', version: process.versions.node, adapterContractVersion: 'openai-text-http@1'}});
  if (!common) unavailable();
  const commonConfig = buildRuntimeConfigCommitments(common);
  if (!commonConfig) unavailable();
  if (limit === undefined) return {commonConfig, tokenLimit: {status: 'absent'}};
  const limits = config.protocol === 'responses' ? {max_output_tokens: limit}
    : buildOpenAIChatCompletionsTokenLimit(config.lightModel, limit);
  const entries = Object.entries(limits);
  if (entries.length !== 1) unavailable();
  const [field, value] = entries[0];
  if (field !== 'max_tokens' && field !== 'max_completion_tokens' && field !== 'max_output_tokens') unavailable();
  const committed = buildRuntimeConfigCommitments({limit: value})?.find(row => row.field === '/limit');
  if (!committed || committed.type !== 'number') unavailable();
  return {commonConfig, tokenLimit: {status: 'explicit', field, valueCommitment: committed.valueCommitment}};
}

/** No runtime, verifier, server or processor imports belong in this entrypoint. */
function quiet<T>(work: () => T): T {
  const saved = {log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug};
  const silent = () => undefined;
  Object.assign(console, {log: silent, info: silent, warn: silent, error: silent, debug: silent});
  try {return work();} finally {Object.assign(console, saved);}
}

function readBoundedInput(filename: string): unknown {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) unavailable();
    const bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > MAX_REQUEST_BYTES) unavailable();
    return parseStoredJson(bytes.subarray(0, count).toString('utf8'), 'LLM preflight request');
  } finally {fs.closeSync(descriptor);}
}

function futurePath(filename: string): string {
  let ancestor = path.resolve(filename);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) unavailable();
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function isolatedChildPath(value: string | undefined, directory: string): string {
  if (!value || !path.isAbsolute(value)) unavailable();
  const resolved = futurePath(value);
  const relative = path.relative(directory, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) unavailable();
  return resolved;
}

function assertIsolatedEnvironment(directory: string): void {
  isolatedChildPath(process.env.SMARTPERFETTO_BACKEND_DATA_DIR, directory);
  isolatedChildPath(process.env.SMARTPERFETTO_BACKEND_LOG_DIR, directory);
  if (process.env.PROVIDER_DATA_DIR_OVERRIDE !== undefined) isolatedChildPath(process.env.PROVIDER_DATA_DIR_OVERRIDE, directory);
  const dotenv = isolatedChildPath(process.env.DOTENV_CONFIG_PATH, directory);
  if (isolatedChildPath(process.env.SMARTPERFETTO_ENV_FILE, directory) !== dotenv ||
      process.env.DOTENV_KEY !== undefined || process.env.DOTENV_CONFIG_OVERRIDE !== undefined) unavailable();
  const descriptor = fs.openSync(dotenv, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== 0) unavailable();
  } finally {fs.closeSync(descriptor);}
}

function parseRequest(value: unknown): LlmTargetPreflightRequest {
  const lifecycle: {CELLS: readonly string[]} = require('../../scripts/llm-execution-lifecycle.cjs');
  const {parseRuntimeBenchmarkConfigCommitments}: typeof import('../agentRuntime/runtimePerformance') = require('../agentRuntime/runtimePerformance');
  const required = ['schemaVersion', 'nonce', 'side', 'cellId', 'requestedMode',
    'expectedSourceFingerprint', 'declaredConfig', 'treatmentHash'];
  if (!record(value) || required.some(key => !own(value, key)) ||
      Object.keys(value).some(key => ![...required, 'providerId', 'providerScope'].includes(key)) ||
      value.schemaVersion !== 'llm_target_preflight_request@1' || typeof value.nonce !== 'string' || !NONCE.test(value.nonce) ||
      (value.side !== 'base' && value.side !== 'candidate') || typeof value.cellId !== 'string' || !lifecycle.CELLS.includes(value.cellId) ||
      (value.requestedMode !== 'auto' && value.requestedMode !== 'fast' && value.requestedMode !== 'full') ||
      typeof value.expectedSourceFingerprint !== 'string' || !HASH.test(value.expectedSourceFingerprint) ||
      typeof value.treatmentHash !== 'string' || !HASH.test(value.treatmentHash)) unavailable();
  if (own(value, 'providerId') && value.providerId !== null &&
      (typeof value.providerId !== 'string' || value.providerId.length === 0 || value.providerId.length > 256 ||
        value.providerId.trim() !== value.providerId)) unavailable();
  let providerScope: ProviderScope | undefined;
  if (own(value, 'providerScope')) {
    const scope = value.providerScope;
    if (!record(scope) || !own(scope, 'tenantId') || !own(scope, 'workspaceId') ||
        Object.keys(scope).some(key => !['tenantId', 'workspaceId', 'userId'].includes(key)) ||
        Object.values(scope).some(item => typeof item !== 'string' || item.length > 256 || !/^[a-zA-Z0-9._:-]+$/.test(item))) unavailable();
    providerScope = {tenantId: scope.tenantId as string, workspaceId: scope.workspaceId as string,
      ...(own(scope, 'userId') ? {userId: scope.userId as string} : {})};
  }
  const declaredConfig = parseRuntimeBenchmarkConfigCommitments(value.declaredConfig);
  if (!declaredConfig) unavailable();
  return {schemaVersion: 'llm_target_preflight_request@1', nonce: value.nonce, side: value.side,
    cellId: value.cellId, requestedMode: value.requestedMode, expectedSourceFingerprint: value.expectedSourceFingerprint,
    declaredConfig, treatmentHash: value.treatmentHash,
    ...(own(value, 'providerId') ? {providerId: value.providerId as string | null} : {}),
    ...(providerScope ? {providerScope} : {})};
}

function inspectTarget(request: LlmTargetPreflightRequest, directory: string): LlmTargetPreflightResult {
  const lifecycle: {fingerprintSourceTree(root: string): string} = require('../../scripts/llm-execution-lifecycle.cjs');
  const observedSourceFingerprint = lifecycle.fingerprintSourceTree(path.resolve(__dirname, '../../..'));
  if (!HASH.test(observedSourceFingerprint)) unavailable();
  const bindings: PreflightBindings = {schemaVersion: 'llm_target_preflight@3', nonce: request.nonce,
    side: request.side, cellId: request.cellId, requestedMode: request.requestedMode, observedSourceFingerprint,
    declaredConfigFingerprint: request.declaredConfig.fullFingerprint,
    declaredControlsFingerprint: request.declaredConfig.controlsFingerprint, declaredTreatmentHash: request.treatmentHash};
  const failed = (failureCode: PreflightFailureCode): LlmTargetPreflightResult => ({...bindings, status: 'failed', failureCode});
  if (observedSourceFingerprint !== request.expectedSourceFingerprint) return failed('source_mismatch');
  try {
    assertIsolatedEnvironment(directory);
    const {loadOpenAIConfig, resolveOpenAiClassifierOutputLimit, createOpenAiFinalizationConfig}:
      typeof import('../agentRuntime/engines/openai/openAiConfig') = require('../agentRuntime/engines/openai/openAiConfig');
    const {admitFinalSubmissionConfiguration, installedOpenAiSdkCompatibility}:
      typeof import('../agentRuntime/engines/openai/openAiFinalSubmissionConfig') = require('../agentRuntime/engines/openai/openAiFinalSubmissionConfig');
    const {FinalSubmissionConfigurationError}: typeof import('../agentRuntime/finalSubmissionConfig') = require('../agentRuntime/finalSubmissionConfig');
    let config: ReturnType<typeof loadOpenAIConfig>;
    try {config = loadOpenAIConfig(request.providerId, request.providerScope);} catch {return failed('invalid_configuration');}
    try {admitFinalSubmissionConfiguration(config, request.requestedMode);} catch (error) {
      return failed(error instanceof FinalSubmissionConfigurationError ? error.code : 'probe_unavailable');
    }
    // The production gate ran first. This probe serves only the declared v3 treatment.
    const output = config.outputConfig as Readonly<{finalSubmission: string; declarationSyntax: string}>;
    let capturedOutput: PreflightOutputConfig;
    if (request.side === 'base' && output.finalSubmission === 'assistant_text' && output.declarationSyntax === 'canonical_v1') {
      capturedOutput = {finalSubmission: 'assistant_text', declarationSyntax: 'canonical_v1'};
    } else return failed('invalid_configuration');
    const observedSdk = installedOpenAiSdkCompatibility(config.outputConfig.finalSubmission);
    const version = (value: string) => /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value) ? value : 'unknown';
    const agentsCoreVersion = version(observedSdk.agentsCoreVersion), agentsOpenAiVersion = version(observedSdk.agentsOpenAiVersion);
    const sdk = {agentsCoreVersion, agentsOpenAiVersion,
      identity: agentsCoreVersion !== 'unknown' && agentsOpenAiVersion !== 'unknown' && observedSdk.contractVersion !== 'unknown'
        ? 'matched' as const : 'unknown' as const};
    const outputImplementation = OPENAI_ASSISTANT_OUTPUT_IMPLEMENTATION;
    const {buildRuntimeCommonModelConfig, buildRuntimeConfigCommitments}:
      typeof import('../agentRuntime/runtimePerformance') = require('../agentRuntime/runtimePerformance');
    const common = buildRuntimeCommonModelConfig(config, {runtime: 'openai-agents-sdk', sdk});
    if (!common) return failed('probe_unavailable');
    const actualResolvedConfig = buildRuntimeConfigCommitments({...common, outputConfig: config.outputConfig});
    if (!actualResolvedConfig) return failed('probe_unavailable');
    const finalizationConfig = createOpenAiFinalizationConfig(config);
    const purposeContracts: LlmPurposeContractsV1 = {schemaVersion: 'llm_purpose_controls@1',
      classification: purposeContract(config, resolveOpenAiClassifierOutputLimit(config)),
      review: purposeContract(finalizationConfig, finalizationConfig.maxOutputTokens)};
    return {...bindings, status: 'ready', capturedOutput, outputImplementation, actualResolvedConfig, purposeContracts,
      sdk: {...sdk, nodeVersion: process.versions.node}};
  } catch {return failed('probe_unavailable');}
}

export function parseLlmTargetPreflightArgs(argv: readonly string[]): {input: string; output: string} {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!['--input', '--output'].includes(key) || args.has(key) || !value || value.startsWith('--')) unavailable();
    args.set(key, value);
  }
  const input = args.get('--input'), output = args.get('--output');
  if (!input || !output) unavailable();
  return {input, output};
}

export function preflightLlmExecutionTarget(options: {input: string; output: string}): LlmTargetPreflightResult {
  const directory = fs.realpathSync(path.dirname(path.resolve(options.input)));
  if (fs.realpathSync(path.dirname(path.resolve(options.output))) !== directory || fs.existsSync(options.output)) unavailable();
  const result = quiet(() => inspectTarget(parseRequest(readBoundedInput(options.input)), directory));
  const bytes = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_RESULT_BYTES) unavailable();
  fs.writeFileSync(options.output, bytes, {flag: 'wx', mode: 0o600});
  return result;
}

if (require.main === module) {
  try {
    const result = preflightLlmExecutionTarget(parseLlmTargetPreflightArgs(process.argv.slice(2)));
    process.exitCode = result.status === 'ready' ? 0 : 1;
  } catch {
    console.error('LLM execution preflight unavailable.');
    process.exitCode = 2;
  }
}
