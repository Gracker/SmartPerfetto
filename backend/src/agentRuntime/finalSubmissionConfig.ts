// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {CONCLUSION_AUTHORING_ENV, resolveConclusionDeclarationSyntax} from '../agent/core/conclusionAuthoring';
import type {ConclusionDeclarationSyntax} from '../agent/core/conclusionContract';
import type {ModelExecutionProtocol, ResolvedModelExecutionProfile} from '../services/providerManager/modelExecutionProfile';
import {expectedOpenAiTypedFinalContract, getFinalSubmissionModeDescriptor,
  getAuthoredFinalSubmissionModeDescriptor, type FinalSubmissionModeKey} from './finalSubmissionImplementation';

export const SMARTPERFETTO_FINAL_SUBMISSION_ENV = 'SMARTPERFETTO_FINAL_SUBMISSION';
export type FinalSubmissionMode = FinalSubmissionModeKey;
export interface CapturedAnalysisOutputConfig {
  readonly finalSubmission: FinalSubmissionMode;
  readonly declarationSyntax: ConclusionDeclarationSyntax;
}

type ConfigurationReason = 'mode' | 'captured_config' | 'declaration_syntax' | 'declaration_syntax_conflict' |
  'runtime' | 'protocol' | 'sdk' | 'model_set' | 'function_tool_primitive';

/** Internal configuration only; this error never reflects environment or model values. */
export class FinalSubmissionConfigurationError extends Error {
  constructor(readonly code: 'invalid_configuration' | 'unsupported_final_submission', readonly reason: ConfigurationReason) {
    super(`${code}:final_submission:${reason}`);
    this.name = 'FinalSubmissionConfigurationError';
  }
}

export function isFinalSubmissionMode(value: unknown): value is FinalSubmissionMode {
  return getFinalSubmissionModeDescriptor(value) !== undefined;
}

export function assertCapturedAnalysisOutputConfig(config: CapturedAnalysisOutputConfig): void {
  if (!config || !isFinalSubmissionMode(config.finalSubmission) ||
      !['canonical_v1', 'authoring_v1', 'authoring_v2'].includes(config.declarationSyntax)) {
    throw new FinalSubmissionConfigurationError('invalid_configuration', 'captured_config');
  }
  const descriptor = getAuthoredFinalSubmissionModeDescriptor(config.finalSubmission);
  if (descriptor && config.declarationSyntax !== descriptor.requiredDeclarationSyntax) {
    throw new FinalSubmissionConfigurationError('invalid_configuration', 'declaration_syntax_conflict');
  }
}

/** Capture once before classification; no ambient default permits a later re-read. */
export function captureAnalysisOutputConfig(env: Readonly<Record<string, string | undefined>>): CapturedAnalysisOutputConfig {
  const requested = env[SMARTPERFETTO_FINAL_SUBMISSION_ENV];
  const finalSubmission = requested === undefined ? 'assistant_text' : requested;
  if (!isFinalSubmissionMode(finalSubmission)) throw new FinalSubmissionConfigurationError('invalid_configuration', 'mode');
  let declarationSyntax: ConclusionDeclarationSyntax;
  try {declarationSyntax = resolveConclusionDeclarationSyntax(env[CONCLUSION_AUTHORING_ENV]);}
  catch {throw new FinalSubmissionConfigurationError('invalid_configuration', 'declaration_syntax');}
  const config = {finalSubmission, declarationSyntax};
  assertCapturedAnalysisOutputConfig(config);
  return Object.freeze(config);
}

/** Shared early refusal for runtimes that do not implement the experimental bridge. */
export function assertFinalSubmissionRuntime(config: CapturedAnalysisOutputConfig, runtimeKind: string): void {
  assertCapturedAnalysisOutputConfig(config);
  if (config.finalSubmission !== 'assistant_text' && runtimeKind !== 'openai-agents-sdk') {
    throw new FinalSubmissionConfigurationError('unsupported_final_submission', 'runtime');
  }
}

export interface FinalSubmissionSdkCompatibility {
  readonly agentsCoreVersion: string;
  readonly agentsOpenAiVersion: string;
  /** Adapter-owned installed-SDK contract, never a model/client declaration. */
  readonly contractVersion: string;
}

export interface FinalSubmissionPreDispatchInput {
  readonly outputConfig: CapturedAnalysisOutputConfig;
  readonly runtimeKind: string;
  readonly protocol?: ModelExecutionProtocol;
  readonly sdk?: FinalSubmissionSdkCompatibility;
  readonly modelSelection?: Readonly<{primaryModel: string; lightModel: string; requestedMode: 'auto' | 'fast' | 'full'}>;
  readonly modelProfiles?: readonly ResolvedModelExecutionProfile[];
}

/** Checks experimental eligibility, not actual adoption, native completion or analysis quality. */
export function assertFinalSubmissionPreDispatch(input: FinalSubmissionPreDispatchInput): void {
  assertFinalSubmissionRuntime(input.outputConfig, input.runtimeKind);
  if (input.outputConfig.finalSubmission === 'assistant_text') return;
  function unsupported(reason: ConfigurationReason): never {
    throw new FinalSubmissionConfigurationError('unsupported_final_submission', reason);
  }
  if (input.protocol !== 'chat_completions') unsupported('protocol');
  const implementation = expectedOpenAiTypedFinalContract(input.outputConfig.finalSubmission);
  const sdkContract = implementation.admissionVersion;
  if (input.sdk?.agentsCoreVersion !== '0.13.0' || input.sdk.agentsOpenAiVersion !== '0.13.0' ||
      input.sdk.contractVersion !== sdkContract) unsupported('sdk');
  const selection = input.modelSelection;
  if (!selection || !['auto', 'fast', 'full'].includes(selection.requestedMode)) unsupported('model_set');
  // A failed quick classifier retains the primary model; checking only the
  // expected light-model path would admit an unsupported paid fallback.
  const modelIds = [...new Set(selection.requestedMode === 'full'
    ? [selection.primaryModel] : [selection.primaryModel, selection.lightModel])];
  if (modelIds.some(id => typeof id !== 'string' || !id.trim() || id.trim() !== id)) unsupported('model_set');
  const profiles = input.modelProfiles;
  if (!profiles || profiles.length !== modelIds.length ||
      new Set(profiles.map(profile => profile.model.requestedId)).size !== profiles.length) unsupported('model_set');
  if (profiles.some(profile => profile.endpoint.identityHash !== profiles[0].endpoint.identityHash)) unsupported('model_set');
  for (const modelId of modelIds) {
    const profile = profiles.find(candidate => candidate.model.requestedId === modelId);
    if (!profile || profile.model.identity !== 'configured' || profile.runtimeKind !== input.runtimeKind ||
        profile.protocol !== input.protocol || profile.sdk.version !== input.sdk.agentsOpenAiVersion ||
        implementation.representationVersion === 'authored_claim_document@2' && profile.sdk.adapterContractVersion !== sdkContract ||
        profile.effective.finalSubmission !== input.outputConfig.finalSubmission ||
        profile.effective.declarationSyntax !== input.outputConfig.declarationSyntax) unsupported('model_set');
    if (profile.server.functionTools.status !== 'supported' ||
        profile.server.functionTools.value !== 'function_call_arguments') unsupported('function_tool_primitive');
  }
}
