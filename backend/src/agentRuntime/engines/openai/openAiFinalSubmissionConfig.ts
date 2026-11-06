// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {Agent, OpenAIProvider, Runner, StreamedRunResult} from '@openai/agents';
import {isPlainObject} from '../../../utils/llmJson';
import {resolveModelExecutionProfile, type ResolvedModelExecutionProfile} from '../../../services/providerManager/modelExecutionProfile';
import {OPENAI_AGENT_RUNTIME_KIND} from '../../runtimeKinds';
import {assertFinalSubmissionPreDispatch, type FinalSubmissionSdkCompatibility, type FinalSubmissionMode} from '../../finalSubmissionConfig';
import {OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION} from './openAiTypedFinalAdmission';
import type {OpenAIAgentConfig} from './openAiConfig';

/** Resolve the packages used by the already imported umbrella SDK, not a configured version label. */
export function installedOpenAiSdkCompatibility(_finalSubmission: FinalSubmissionMode = 'authored_claim_document_v1'): FinalSubmissionSdkCompatibility {
  const unknown = {agentsCoreVersion: 'unknown', agentsOpenAiVersion: 'unknown', contractVersion: 'unknown'};
  try {
    const sdkRequire = createRequire(require.resolve('@openai/agents'));
    const coreEntry = sdkRequire.resolve('@openai/agents-core'), openAiEntry = sdkRequire.resolve('@openai/agents-openai');
    const core = require(coreEntry), openAi = require(openAiEntry);
    if (core.Agent !== Agent || core.Runner !== Runner || core.StreamedRunResult !== StreamedRunResult ||
      openAi.OpenAIProvider !== OpenAIProvider) return unknown;
    const version = (entry: string, name: string): string => {
      const value: unknown = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
      return isPlainObject(value) && value.name === name && typeof value.version === 'string' ? value.version : 'unknown';
    };
    return {agentsCoreVersion: version(coreEntry, '@openai/agents-core'),
      agentsOpenAiVersion: version(openAiEntry, '@openai/agents-openai'), contractVersion: OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION};
  } catch {return unknown;}
}

export function admitFinalSubmissionConfiguration(config: OpenAIAgentConfig, requestedMode: 'auto' | 'fast' | 'full'): ReadonlyMap<string, ResolvedModelExecutionProfile> | undefined {
  if (config.outputConfig.finalSubmission === 'assistant_text') {
    assertFinalSubmissionPreDispatch({outputConfig: config.outputConfig, runtimeKind: OPENAI_AGENT_RUNTIME_KIND});
    return undefined;
  }
  const sdk = installedOpenAiSdkCompatibility();
  const models = [...new Set(requestedMode === 'full' ? [config.model] : [config.model, config.lightModel])];
  const modelProfiles = models.map(modelId => resolveModelExecutionProfile({runtimeKind: OPENAI_AGENT_RUNTIME_KIND,
    protocol: config.protocol, modelId, baseUrl: config.baseURL,
    sdk: {packageName: '@openai/agents-openai', version: sdk.agentsOpenAiVersion,
      adapterContractVersion: OPENAI_TYPED_FINAL_ADMISSION_CONTRACT_VERSION},
    sdkCapabilities: {surface: 'none', thinking: 'unknown', reasoningRoundtrip: 'unknown', source: 'contract_test'},
    effective: {...config.outputConfig,
      ...(config.analysisReasoningEffort === undefined ? {} : {authoredReasoning: config.analysisReasoningEffort === 'none'
        ? {mode: 'disabled' as const} : {mode: 'enabled' as const, effort: config.analysisReasoningEffort}}),
      maxOutputTokens: config.maxOutputTokens, maxTurns: config.maxTurns,
      quickMaxTurns: config.quickMaxTurns, quickTargetTurns: config.quickTargetTurns,
      fullPerTurnMs: config.fullPathPerTurnMs, quickPerTurnMs: config.quickPathPerTurnMs,
      fullRequestTimeoutMs: config.fullRequestTimeoutMs, streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      maxRunTimeoutMs: config.maxRunTimeoutMs, classifierTimeoutMs: config.classifierTimeoutMs,
      maxHistoryBytes: config.maxHistoryBytes}}));
  assertFinalSubmissionPreDispatch({outputConfig: config.outputConfig, runtimeKind: OPENAI_AGENT_RUNTIME_KIND,
    protocol: config.protocol, sdk, modelSelection: {primaryModel: config.model, lightModel: config.lightModel, requestedMode}, modelProfiles});
  return new Map(modelProfiles.map(profile => [profile.model.requestedId!, profile]));
}

