// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RuntimeModelCallPurpose, RuntimeModelDispatchPurpose} from './runtimePerformance';
import type {ModelControlSurface, ModelExecutionFingerprint, ReasoningEffort, ReasoningSetting,
  ResolvedModelExecutionProfile} from '../services/providerManager/modelExecutionProfile';

export type StageNativeControls =
  | Readonly<{surface: 'none'}>
  | Readonly<{surface: 'openai_chat';
      thinking: Readonly<{type: 'enabled' | 'disabled'}>; reasoning_effort?: ReasoningEffort}>
  | Readonly<{surface: 'openai_responses'; reasoning: Readonly<{effort: 'none' | ReasoningEffort}>}>
  | Readonly<{surface: 'pi_stream'; reasoning: 'off' | ReasoningEffort}>
  | Readonly<{surface: 'claude_effort'; effort: 'low' | 'medium' | 'high' | 'max'}>;

export type ModelPolicyFailure = 'unsupported_authored_mode' | 'unsupported_authored_effort' |
  'candidate_stage_not_allowed' | 'adapter_surface_mismatch';
export type ModelPolicyReason = ModelPolicyFailure | 'preserve_requested' | 'authored_precedence' |
  'candidate_minimum_legal' | 'server_capability_unknown' | 'sdk_capability_unknown' | 'no_common_control';
export interface ModelExecutionPolicyReceipt {
  readonly schemaVersion: 'model_execution_policy@1';
  readonly purpose: RuntimeModelCallPurpose;
  readonly selection: 'preserve' | 'minimum_legal_candidate';
  readonly modelId?: string;
  readonly executionFingerprint: ModelExecutionFingerprint;
  readonly authored: ReasoningSetting | 'absent';
  readonly sdkEffective: ReasoningSetting | 'unknown';
  /** Documented server interpretation, not a rewritten setting or an observed wire result. */
  readonly documentedAuthoredEffort?: ReasoningEffort;
  readonly mapped: ReasoningSetting | 'unknown' | 'unchanged';
  readonly outcome: 'preserved' | 'candidate_applied' | 'not_applied_unknown' | 'not_applied_unsupported' | 'rejected';
  readonly reason: ModelPolicyReason;
  /** Only the later actual dispatch observer can attest wire settings. */
  readonly wireObservation: 'not_observed';
}
export interface ResolveModelExecutionPolicyInput {
  readonly profile: ResolvedModelExecutionProfile;
  readonly purpose: RuntimeModelDispatchPurpose;
  readonly outputOnly?: true;
  readonly selection: 'preserve' | 'minimum_legal_candidate';
}
export type ModelExecutionPolicyResult =
  | Readonly<{status: 'ready'; controls: StageNativeControls; receipt: ModelExecutionPolicyReceipt}>
  | Readonly<{status: 'unsupported'; reason: ModelPolicyFailure; receipt: ModelExecutionPolicyReceipt}>;

const STAGES: Readonly<Record<RuntimeModelDispatchPurpose, 'main' | 'bounded' | 'continuation'>> = {
  answer_turn: 'main', classification: 'bounded', review: 'bounded', continuation: 'continuation',
};
const NO_CONTROLS: StageNativeControls = Object.freeze({surface: 'none'});
function surfaceMatches(profile: ResolvedModelExecutionProfile): boolean {
  const {runtimeKind, protocol, adapter} = profile;
  if (adapter.surface === 'none') return true;
  switch (runtimeKind) {
    case 'openai-agents-sdk': return protocol === 'chat_completions' && adapter.surface === 'openai_chat' ||
      protocol === 'responses' && adapter.surface === 'openai_responses';
    case 'pi-agent-core': return adapter.surface === 'pi_stream' &&
      ['chat_completions', 'responses', 'anthropic_messages'].includes(protocol);
    case 'claude-agent-sdk': return adapter.surface === 'claude_effort' && ['anthropic_messages', 'native'].includes(protocol);
  }
}
function supportsDisable(surface: ModelControlSurface): boolean {
  return ['openai_chat', 'openai_responses', 'pi_stream'].includes(surface);
}
function supportsEffort(surface: ModelControlSurface, effort: ReasoningEffort): boolean {
  return surface !== 'none' && (surface !== 'claude_effort' || ['low', 'medium', 'high', 'max'].includes(effort));
}
function documentedAuthoredEffort(profile: ResolvedModelExecutionProfile): ReasoningEffort | undefined {
  const authored = profile.effective.authoredReasoning;
  if (authored?.mode !== 'enabled' || authored.effort === undefined) return undefined;
  const {efforts, effortAliases} = profile.server;
  if (efforts.status === 'supported' && efforts.value.includes(authored.effort)) return authored.effort;
  return effortAliases.status === 'supported'
    ? effortAliases.value.find(alias => alias.accepted === authored.effort)?.documented : undefined;
}
function authoredFailure(profile: ResolvedModelExecutionProfile): ModelPolicyFailure | undefined {
  const authored = profile.effective.authoredReasoning;
  if (!authored) return undefined;
  const {server, adapter} = profile;
  if (authored.mode === 'disabled') {
    if (server.thinking.status === 'supported' && server.thinking.value === 'required' || adapter.thinking === 'required' ||
      adapter.thinking !== 'unknown' && !supportsDisable(adapter.surface)) return 'unsupported_authored_mode';
  } else {
    if (server.thinking.status === 'unsupported' || server.thinking.status === 'supported' && server.thinking.value === 'none' ||
      adapter.thinking === 'none') return 'unsupported_authored_mode';
    if (authored.effort !== undefined && (server.efforts.status === 'unsupported' ||
      server.efforts.status === 'supported' && documentedAuthoredEffort(profile) === undefined ||
      adapter.efforts !== undefined && !adapter.efforts.includes(authored.effort) ||
      adapter.surface !== 'none' && !supportsEffort(adapter.surface, authored.effort))) return 'unsupported_authored_effort';
  }
  return undefined;
}
function controlsFor(surface: ModelControlSurface, setting: ReasoningSetting): StageNativeControls | undefined {
  switch (surface) {
    case 'openai_chat': return Object.freeze({surface, thinking: Object.freeze({type: setting.mode}),
      ...(setting.mode === 'enabled' && setting.effort ? {reasoning_effort: setting.effort} : {})});
    case 'openai_responses': return setting.mode === 'disabled' || setting.effort
      ? Object.freeze({surface, reasoning: Object.freeze({effort: setting.mode === 'disabled' ? 'none' : setting.effort!})}) : undefined;
    case 'pi_stream': return setting.mode === 'disabled' || setting.effort
      ? Object.freeze({surface, reasoning: setting.mode === 'disabled' ? 'off' : setting.effort!}) : undefined;
    case 'claude_effort': {
      if (setting.mode === 'disabled' || !setting.effort || !supportsEffort(surface, setting.effort)) return undefined;
      return Object.freeze({surface, effort: setting.effort as 'low' | 'medium' | 'high' | 'max'});
    }
    case 'none': return undefined;
  }
}

/** Pure parameter selection. It neither sends a request nor creates a deadline, pin or permission. */
export function resolveModelExecutionPolicy(input: ResolveModelExecutionPolicyInput): ModelExecutionPolicyResult {
  // Validate before constructing any receipt: rejected arbitrary strings must never be echoed.
  if (!input || typeof input.purpose !== 'string' || !Object.prototype.hasOwnProperty.call(STAGES, input.purpose) ||
    typeof input.selection !== 'string' || !['preserve', 'minimum_legal_candidate'].includes(input.selection)) {
    throw new Error('model_execution_invalid_policy_selection');
  }
  const {profile, purpose, selection} = input;
  const documentedEffort = documentedAuthoredEffort(profile);
  const receipt = (outcome: ModelExecutionPolicyReceipt['outcome'], reason: ModelPolicyReason,
    mapped: ModelExecutionPolicyReceipt['mapped']): ModelExecutionPolicyReceipt => Object.freeze({
    schemaVersion: 'model_execution_policy@1', purpose, selection,
    ...(profile.model.requestedId !== undefined ? {modelId: profile.model.requestedId} : {}),
    executionFingerprint: profile.fingerprint, authored: profile.effective.authoredReasoning ?? 'absent',
    sdkEffective: profile.effective.sdkEffectiveReasoning ?? 'unknown',
    ...(documentedEffort !== undefined ? {documentedAuthoredEffort: documentedEffort} : {}),
    mapped, outcome, reason, wireObservation: 'not_observed',
  });
  const reject = (reason: ModelPolicyFailure): ModelExecutionPolicyResult => Object.freeze({
    status: 'unsupported', reason, receipt: receipt('rejected', reason, 'unchanged'),
  });
  const unchanged = (outcome: ModelExecutionPolicyReceipt['outcome'], reason: ModelPolicyReason): ModelExecutionPolicyResult =>
    Object.freeze({status: 'ready', controls: NO_CONTROLS, receipt: receipt(outcome, reason,
      outcome === 'preserved' ? 'unchanged' : 'unknown')});
  if (!surfaceMatches(profile)) return reject('adapter_surface_mismatch');
  const unsupported = authoredFailure(profile);
  if (unsupported) return reject(unsupported);
  if (selection === 'minimum_legal_candidate' &&
    (STAGES[purpose] === 'main' || STAGES[purpose] === 'continuation' && input.outputOnly !== true)) return reject('candidate_stage_not_allowed');
  // Authored values already belong to the captured native config: never replace them with a stage default.
  if (profile.effective.authoredReasoning) return unchanged('preserved', 'authored_precedence');
  if (selection === 'preserve') return unchanged('preserved', 'preserve_requested');
  const {server, adapter} = profile;
  if (server.thinking.status === 'unknown') return unchanged('not_applied_unknown', 'server_capability_unknown');
  if (adapter.thinking === 'unknown') return unchanged('not_applied_unknown', 'sdk_capability_unknown');
  if (server.thinking.status === 'unsupported' || server.thinking.value === 'none' || adapter.thinking === 'none' ||
    adapter.surface === 'none') return unchanged('not_applied_unsupported', 'no_common_control');
  let setting: ReasoningSetting;
  if (server.thinking.value === 'optional' && adapter.thinking === 'optional' && supportsDisable(adapter.surface)) {
    setting = Object.freeze({mode: 'disabled'});
  } else {
    if (server.efforts.status === 'unknown') return unchanged('not_applied_unknown', 'server_capability_unknown');
    if (adapter.efforts === undefined) return unchanged('not_applied_unknown', 'sdk_capability_unknown');
    const effort = server.efforts.status === 'supported' ? server.efforts.value.find(value =>
      adapter.efforts!.includes(value) && supportsEffort(adapter.surface, value)) : undefined;
    if (!effort) return unchanged('not_applied_unsupported', 'no_common_control');
    setting = Object.freeze({mode: 'enabled', effort});
  }
  const controls = controlsFor(adapter.surface, setting);
  return controls ? Object.freeze({status: 'ready', controls,
    receipt: receipt('candidate_applied', 'candidate_minimum_legal', setting)}) : unchanged('not_applied_unsupported', 'no_common_control');
}
