// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {types as nodeUtilTypes} from 'node:util';
import {RuntimeActivityRecorder, type RuntimeActivitySnapshot, type RuntimeActivitySpan, type RuntimeCaptureActivityInput} from './runtimeActivity';
import {resolveRuntimePerformanceRecorder, type RuntimePerformanceSource} from './runtimePerformanceContext';
import {performance as nodePerformance} from 'perf_hooks';

import {canonicalContentHash, immutableCanonicalSnapshot} from '../services/selfEvolution/canonicalJson';
import {analysisDeliveryFingerprint, type AnalysisCandidateIdentity} from '../types/analysisDelivery';
import {isPlainObject} from '../utils/llmJson';
import type {RuntimeToolConcurrencyFallbackReason} from './runtimeToolConcurrency';
import {isSceneEntryNotRunReason, type RuntimePerformanceSceneEvidenceReceiptV1} from '../types/sceneEntryEvidence';
import type {ModelExecutionPolicyReceipt} from './modelExecutionPolicy';
import type {ReasoningSetting} from '../services/providerManager/modelExecutionProfile';

export type RuntimePhaseName =
  | 'classification'
  | 'quick_evidence'
  | 'focus'
  | 'architecture'
  | 'completeness'
  | 'comparison'
  | 'skill_registry'
  | 'knowledge'
  | 'scene_evidence'
  | 'sdk_start'
  | 'provider'
  | 'verification'
  | 'correction'
  | 'finalization';

export type RuntimePerformanceOutcome = 'ok' | 'error' | 'cancelled';

export interface RuntimePerformancePhaseReceiptV1 {
  name: RuntimePhaseName;
  startOffsetMs: number;
  durationMs: number;
  outcome: RuntimePerformanceOutcome;
}

export interface RuntimePerformanceToolReceiptV1 {
  toolCallIdHash: string;
  mode: 'exclusive' | 'commutative_read';
  schedulerWaitMs: number;
  fallbackReason?: RuntimeToolConcurrencyFallbackReason;
  durationMs: number;
  outcome: RuntimePerformanceOutcome;
}

export interface RuntimePerformanceSqlReceiptV1 {
  processorKeyHash: string;
  priority: 'p0' | 'p1' | 'p2';
  queueWaitMs: number;
  executionMs: number;
  outcome: RuntimePerformanceOutcome;
}

/**
 * Why a model call was made. `continuation` asks for more or corrected answer
 * text; `declaration_repair` asks only for the machine declaration of an
 * unchanged body; `review` is the finalizer's one no-tool semantic review.
 */
export const RUNTIME_MODEL_CALL_PURPOSES = [
  'classification', 'answer_turn', 'declaration_repair', 'continuation', 'review',
] as const;
export type RuntimeModelCallPurpose = typeof RUNTIME_MODEL_CALL_PURPOSES[number];

/** The closed condition that admitted a continuation or declaration repair. */
export const RUNTIME_MODEL_CALL_TRIGGERS = [
  'output_limit', 'empty_body', 'invalid_protocol', 'missing_declaration', 'invalid_declaration', 'turn_limit', 'timeout',
] as const;
export type RuntimeModelCallTrigger = typeof RUNTIME_MODEL_CALL_TRIGGERS[number];

/** Why the finalizer's semantic review was required. */
export const RUNTIME_FINAL_REVIEW_TRIGGERS = [
  'report', 'selection', 'source', 'investigation', 'claims_verifiable', 'acknowledgement',
] as const;
export type RuntimeFinalReviewTrigger = typeof RUNTIME_FINAL_REVIEW_TRIGGERS[number];

export const RUNTIME_FINAL_REVIEW_NECESSITIES = ['required', 'not_required', 'declaration_ineligible'] as const;

/** Request-side reasoning setting; `provider_default` sends no reasoning control. */
export type RuntimeModelCallReasoning = 'provider_default' | 'disabled' | 'enabled';
export const RUNTIME_MODEL_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type RuntimeModelReasoningEffort = typeof RUNTIME_MODEL_REASONING_EFFORTS[number];

export type RuntimeModelPolicyReceipt = Pick<ModelExecutionPolicyReceipt, 'schemaVersion' | 'purpose' |
  'executionFingerprint' | 'selection' | 'outcome' | 'reason' | 'authored' | 'mapped' | 'sdkEffective' | 'wireObservation'>;

/** Policy selection only: never a dispatch receipt, server behavior or stage completion. */
export interface RuntimeModelPolicyObservation extends RuntimeModelPolicyReceipt {
  observationOrdinal: number;
  observedOffsetMs: number;
}

const POLICY_SELECTIONS: Record<ModelExecutionPolicyReceipt['selection'], true> = {preserve: true, minimum_legal_candidate: true};
const POLICY_OUTCOMES: Record<ModelExecutionPolicyReceipt['outcome'], true> = {
  preserved: true, candidate_applied: true, not_applied_unknown: true, not_applied_unsupported: true, rejected: true,
};
const POLICY_REASONS: Record<ModelExecutionPolicyReceipt['reason'], true> = {
  unsupported_authored_mode: true, unsupported_authored_effort: true, candidate_stage_not_allowed: true,
  adapter_surface_mismatch: true, preserve_requested: true, authored_precedence: true,
  candidate_minimum_legal: true, server_capability_unknown: true, sdk_capability_unknown: true, no_common_control: true,
};
function policyMember<T extends string>(value: unknown, entries: Record<T, true>): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(entries, value);
}
function policySetting(value: unknown): ReasoningSetting | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.mode === 'disabled') return value.effort === undefined ? {mode: 'disabled'} : undefined;
  if (value.mode !== 'enabled') return undefined;
  if (value.effort === undefined) return {mode: 'enabled'};
  return typeof value.effort === 'string' && RUNTIME_MODEL_REASONING_EFFORTS.includes(value.effort as RuntimeModelReasoningEffort)
    ? {mode: 'enabled', effort: value.effort as RuntimeModelReasoningEffort} : undefined;
}

/** The same closed projection is applied at collection and stored-metrics export.
 * Unknown fields (including modelId) never leave this boundary. No raw error text. */
export function projectRuntimeModelPolicyReceipt(value: unknown): RuntimeModelPolicyReceipt | undefined {
  try {
    if (!isPlainObject(value) || value.schemaVersion !== 'model_execution_policy@1' ||
        typeof value.purpose !== 'string' || !RUNTIME_MODEL_CALL_PURPOSES.includes(value.purpose as RuntimeModelCallPurpose) ||
        !policyMember(value.selection, POLICY_SELECTIONS) || !policyMember(value.outcome, POLICY_OUTCOMES) ||
        !policyMember(value.reason, POLICY_REASONS) || value.wireObservation !== 'not_observed') return undefined;
    const fingerprint = value.executionFingerprint;
    if (!isPlainObject(fingerprint) || fingerprint.schemaVersion !== 'model_execution_fingerprint@1' ||
        typeof fingerprint.value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprint.value)) return undefined;
    const authored = value.authored === 'absent' ? 'absent' : policySetting(value.authored);
    const mapped = value.mapped === 'unknown' || value.mapped === 'unchanged' ? value.mapped : policySetting(value.mapped);
    const sdkEffective = value.sdkEffective === 'unknown' ? 'unknown' : policySetting(value.sdkEffective);
    if (authored === undefined || mapped === undefined || sdkEffective === undefined) return undefined;
    return {schemaVersion: 'model_execution_policy@1', purpose: value.purpose as RuntimeModelCallPurpose,
      executionFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: fingerprint.value},
      selection: value.selection, outcome: value.outcome, reason: value.reason,
      authored, mapped, sdkEffective, wireObservation: 'not_observed'};
  } catch { return undefined; }
}

/** Internal observation schema. None of these values confer execution or evidence authority. */
export interface RuntimeConfigFieldCommitment {
  readonly field: string;
  readonly presence: 'absent' | 'present';
  readonly type: 'absent' | 'undefined' | 'null' | 'boolean' | 'number' | 'string' | 'object' | 'array';
  readonly valueCommitment: string;
}
export interface RuntimeBenchmarkConfigCommitmentsV2 {
  readonly schemaVersion: 'benchmark_config_commitments@2';
  readonly fields: readonly RuntimeConfigFieldCommitment[];
  readonly fullFingerprint: string;
  readonly controlsFingerprint: string;
  readonly legacyConfigFingerprint: string;
}
export interface RuntimeObservedOutputConfig {
  readonly finalSubmission: 'assistant_text' | 'authored_claim_document_v1' | 'authored_claim_document_v2';
  readonly declarationSyntax: 'canonical_v1' | 'authoring_v1' | 'authoring_v2';
}
export interface RuntimeExecutionProfileObservation {
  readonly schemaVersion: 'execution_profile_observation@1';
  readonly role: 'main_controls' | 'stage_policy' | 'typed_admission';
  readonly purpose: RuntimeModelCallPurpose;
  readonly modelHash: string;
  readonly originalFingerprint: {readonly schemaVersion: 'model_execution_fingerprint@1'; readonly value: string};
  readonly fields: readonly RuntimeConfigFieldCommitment[];
  readonly structureFingerprint: string;
}
export interface RuntimeAppliedModelControls {
  readonly schemaVersion: 'applied_model_controls@1';
  readonly requestedOutput: RuntimeObservedOutputConfig;
  readonly commonConfig: readonly RuntimeConfigFieldCommitment[];
  readonly appliedSettings: readonly RuntimeConfigFieldCommitment[];
  readonly profiles: readonly RuntimeExecutionProfileObservation[];
  readonly fullFingerprint: string;
}
export type RuntimeObservedHash = Readonly<{status: 'observed'; hash: string}> | Readonly<{status: 'unknown'}>;
export type RuntimeObservedNativeStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'unknown';
export type RuntimeObservedDrainStatus = 'fulfilled' | 'rejected' | 'unavailable';
export interface RuntimeObservedNativeFact {
  readonly attemptKey: string;
  readonly logicalCallKey: string;
  readonly response: RuntimeObservedHash;
  readonly actualModel: RuntimeObservedHash;
  readonly nativeStatus: RuntimeObservedNativeStatus;
  readonly finish: 'stop' | 'length' | 'tool_calls' | 'completed' | 'incomplete' | 'failed' | 'other' | 'unknown';
  readonly rawMaterial: RuntimeObservedHash;
  readonly nativeContract: 'openai_native_completion_observer@1';
  readonly sdkStreamCompleted: boolean;
}
export type RuntimeFinalTransportEventInput =
  | Readonly<{kind: 'main_dispatch'; attemptKey: string; logicalCallKey: string;
      purpose: 'answer_turn' | 'declaration_repair' | 'continuation'; configuredModelHash: string;
      providerOriginHash: string; controls: RuntimeAppliedModelControls}>
  | Readonly<{kind: 'stage_dispatch'; stageCallKey: string; purpose: RuntimeModelCallPurpose;
      configuredModelHash: string; providerOriginHash: string; controls: RuntimeAppliedModelControls}>
  | Readonly<{kind: 'native_terminal'; fact: RuntimeObservedNativeFact; drainStatus: RuntimeObservedDrainStatus}>
  | Readonly<{kind: 'typed_issued_after_drain'; attemptKey: string; logicalCallKey: string; responseKey: string;
      callKey: string; actualModel: RuntimeObservedHash; nativeStatus: 'completed'; drainStatus: 'fulfilled';
      nativeBodyHash: string; representationVersion: 'authored_claim_document@1' | 'authored_claim_document@2';
      compilerVersion: string; admissionVersion: string}>
  | Readonly<{kind: 'candidate_retained'; nativeCandidateKey: string; carrier: 'assistant_text' | 'model_tool_arguments';
      transform: 'native' | 'declaration_repair';
      authors: readonly Readonly<{role: 'body' | 'declaration' | 'body_and_declaration'; terminalEventKey: string}>[];
      declaredBody: 'present' | 'absent'; declaredClaims: 'present' | 'absent' | 'invalid' | 'unknown';
      productStatus: RuntimeObservedNativeStatus}>
  | Readonly<{kind: 'finalizer_selected'; retainedEventKey: string; nativeCandidateKey: string; displayCandidateKey: string;
      canonicalSourceCandidateKey: string; canonicalCandidateKey: string; productStatus: RuntimeObservedNativeStatus}>
  | Readonly<{kind: 'not_exercised'; reason: 'program_ack' | 'direct_without_main'}>;
export type RuntimeFinalTransportEvent = RuntimeFinalTransportEventInput & Readonly<{
  eventKey: string; sequence: number; offsetMs: number;
}>;
export interface RuntimeFinalTransportObservation {
  readonly schemaVersion: 'final_transport_observation@1';
  readonly events: readonly RuntimeFinalTransportEvent[];
  readonly truncated: number;
}

const observationOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);
const OBSERVATION_HASH = /^[a-f0-9]{64}$/;
const CONFIG_TYPES = ['absent', 'undefined', 'null', 'boolean', 'number', 'string', 'object', 'array'] as const;
const OUTPUT_MODES = ['assistant_text', 'authored_claim_document_v1', 'authored_claim_document_v2'] as const;
const OUTPUT_SYNTAXES = ['canonical_v1', 'authoring_v1', 'authoring_v2'] as const;
const FINAL_NATIVE_STATUSES = ['completed', 'incomplete', 'failed', 'cancelled', 'unknown'] as const;
const TREATMENT_CONFIG_FIELDS = ['/environment/SMARTPERFETTO_FINAL_SUBMISSION',
  '/environment/SMARTPERFETTO_CONCLUSION_AUTHORING'] as const;
const MAX_CONFIG_FIELDS = 4096;
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Exact UTF-8 hash, not the older shortened/salted timing identifier. */
export function runtimeObservationHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Keep the actual issued object's property order, matching the existing projection's identity. */
export function runtimeCandidateObservationKey(candidate: AnalysisCandidateIdentity): string {
  return analysisDeliveryFingerprint(candidate);
}
function observationData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value) || !isPlainObject(value)) {
    throw new Error('runtime_observation_object_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(descriptors).length ||
      Object.values(descriptors).some(item => !item.enumerable || !observationOwn(item, 'value'))) {
    throw new Error('runtime_observation_data_invalid');
  }
  return value as Record<string, unknown>;
}
function exactObservationObject(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const object = observationData(value);
  if (keys.some(key => !observationOwn(object, key)) || Object.keys(object).some(key => !keys.includes(key) && !optional.includes(key))) {
    throw new Error('runtime_observation_fields_invalid');
  }
  return object;
}
function observationMember<T extends string>(value: unknown, members: readonly T[]): T {
  if (typeof value !== 'string' || !members.includes(value as T)) throw new Error('runtime_observation_enum_invalid');
  return value as T;
}
function observationHash(value: unknown): string {
  if (typeof value !== 'string' || !OBSERVATION_HASH.test(value)) throw new Error('runtime_observation_hash_invalid');
  return value;
}
function absentConfigField(field: string): RuntimeConfigFieldCommitment {
  return {field, presence: 'absent', type: 'absent', valueCommitment: canonicalContentHash(['absent'])};
}
/** Leaf values and container structure are committed separately, so a treatment leaf can be masked alone. */
export function buildRuntimeConfigCommitments(value: unknown): readonly RuntimeConfigFieldCommitment[] | undefined {
  try {
    const rows: RuntimeConfigFieldCommitment[] = [];
    const ancestors = new Set<object>();
    let bytes = 0;
    const visit = (item: unknown, field: string, depth: number): void => {
      if (rows.length >= MAX_CONFIG_FIELDS || depth > 24 || field.length > 4096) throw new Error('runtime_observation_limit');
      const add = (type: RuntimeConfigFieldCommitment['type'], material: unknown) => {
        rows.push({field, presence: 'present', type, valueCommitment: canonicalContentHash(material)});
      };
      if (item === undefined) {add('undefined', ['undefined']); return;}
      if (item === null) {add('null', ['null']); return;}
      if (typeof item === 'string') {
        bytes += Buffer.byteLength(item, 'utf8');
        if (bytes > MAX_CONFIG_BYTES) throw new Error('runtime_observation_limit');
        add('string', ['string', item]); return;
      }
      if (typeof item === 'boolean') {add('boolean', ['boolean', item]); return;}
      if (typeof item === 'number' && Number.isFinite(item)) {
        add('number', ['number', Object.is(item, -0) ? '-0' : String(item)]); return;
      }
      if (!item || typeof item !== 'object' || nodeUtilTypes.isProxy(item) || ancestors.has(item)) throw new Error('runtime_observation_value_invalid');
      ancestors.add(item);
      try {
        const array = Array.isArray(item);
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
        if (Reflect.ownKeys(item).length !== Object.keys(descriptors).length ||
            keys.some(key => !descriptors[key].enumerable || !observationOwn(descriptors[key], 'value'))) throw new Error('runtime_observation_data_invalid');
        if (array) {
          if (item.length > MAX_CONFIG_FIELDS || keys.some(key => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new Error('runtime_observation_array_invalid');
          add('array', ['array', item.length, keys.map(Number).sort((a, b) => a - b)]);
        } else {
          observationData(item);
          add('object', ['object', [...keys].sort()]);
        }
        for (const key of keys.sort()) visit(descriptors[key].value,
          `${field}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
      } finally {ancestors.delete(item);}
    };
    visit(value, '', 0);
    return immutableCanonicalSnapshot(rows.sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  } catch { return undefined; }
}
function parseConfigFields(value: unknown): readonly RuntimeConfigFieldCommitment[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 || value.length > MAX_CONFIG_FIELDS) throw new Error('runtime_observation_fields_invalid');
  let previous: string | undefined;
  const fields = value.map(item => {
    const row = exactObservationObject(item, ['field', 'presence', 'type', 'valueCommitment']);
    if (typeof row.field !== 'string' || row.field.length > 4096 || !/^(?:\/(?:[^~\/]|~[01])*)*$/.test(row.field) ||
        previous !== undefined && row.field <= previous) throw new Error('runtime_observation_path_invalid');
    previous = row.field;
    const presence = observationMember(row.presence, ['absent', 'present']);
    const type = observationMember(row.type, CONFIG_TYPES);
    const valueCommitment = observationHash(row.valueCommitment);
    if ((presence === 'absent') !== (type === 'absent') || presence === 'absent' && valueCommitment !== absentConfigField(row.field).valueCommitment) throw new Error('runtime_observation_absence_invalid');
    return {field: row.field, presence, type, valueCommitment};
  });
  if (fields[0]?.field !== '') throw new Error('runtime_observation_root_missing');
  return fields;
}
export function runtimeConfigCommitmentsFingerprint(fields: readonly RuntimeConfigFieldCommitment[]): string | undefined {
  try {return canonicalContentHash({schemaVersion: 'benchmark_config_commitments@2', fields: parseConfigFields(fields)});}
  catch {return undefined;}
}
export function runtimeConfigControlsFingerprint(fields: readonly RuntimeConfigFieldCommitment[]): string | undefined {
  try {
    return canonicalContentHash({schemaVersion: 'benchmark_config_commitments@2', fields: parseConfigFields(fields).map(row =>
      TREATMENT_CONFIG_FIELDS.includes(row.field as typeof TREATMENT_CONFIG_FIELDS[number])
        ? {...row, valueCommitment: canonicalContentHash(['treatment_value', row.field])} : row)});
  } catch {return undefined;}
}
export function alignRuntimeConfigCommitments(left: readonly RuntimeConfigFieldCommitment[], right: readonly RuntimeConfigFieldCommitment[]):
  readonly [readonly RuntimeConfigFieldCommitment[], readonly RuntimeConfigFieldCommitment[]] | undefined {
  try {
    const sides = [new Map(parseConfigFields(left).map(row => [row.field, row])), new Map(parseConfigFields(right).map(row => [row.field, row]))];
    const keys = [...new Set(sides.flatMap(side => [...side.keys()]))].sort();
    if (keys.length > MAX_CONFIG_FIELDS) return undefined;
    return [keys.map(key => sides[0].get(key) ?? absentConfigField(key)), keys.map(key => sides[1].get(key) ?? absentConfigField(key))];
  } catch {return undefined;}
}
export function parseRuntimeBenchmarkConfigCommitments(value: unknown): RuntimeBenchmarkConfigCommitmentsV2 | undefined {
  try {
    const input = exactObservationObject(value, ['schemaVersion', 'fields', 'fullFingerprint', 'controlsFingerprint', 'legacyConfigFingerprint']);
    if (input.schemaVersion !== 'benchmark_config_commitments@2') return undefined;
    const fields = parseConfigFields(input.fields);
    if (runtimeConfigCommitmentsFingerprint(fields) !== input.fullFingerprint || runtimeConfigControlsFingerprint(fields) !== input.controlsFingerprint) return undefined;
    return immutableCanonicalSnapshot({schemaVersion: 'benchmark_config_commitments@2', fields,
      fullFingerprint: observationHash(input.fullFingerprint), controlsFingerprint: observationHash(input.controlsFingerprint),
      legacyConfigFingerprint: observationHash(input.legacyConfigFingerprint)});
  } catch {return undefined;}
}
/** Raw values remain caller-local until committed; credentials/output choices are never common controls. */
export function buildRuntimeCommonModelConfig(config: unknown, context?: Readonly<{runtime: 'openai-agents-sdk';
  sdk: Readonly<{agentsCoreVersion: string; agentsOpenAiVersion: string; identity: 'matched' | 'unknown'}> |
    Readonly<{packageName: string; version: string; adapterContractVersion: string}>}>): Readonly<Record<string, unknown>> | undefined {
  try {
    const source = observationData(config);
    const common = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'apiKey' && key !== 'outputConfig')
      .map(([key, value]) => [key, key === 'cwd' && value === process.cwd() ? '<process.cwd>' : value]));
    if (context) {
      const identity = exactObservationObject(context, ['runtime', 'sdk']);
      const sdk = observationData(identity.sdk);
      if (identity.runtime !== 'openai-agents-sdk' || observationOwn(common, 'runtime') || observationOwn(common, 'sdk')) return undefined;
      if (observationOwn(sdk, 'packageName')) {
        exactObservationObject(sdk, ['packageName', 'version', 'adapterContractVersion']);
        if ([sdk.packageName, sdk.version, sdk.adapterContractVersion].some(value => typeof value !== 'string' ||
            !/^[a-zA-Z0-9@:_./+-]{1,128}$/.test(value))) return undefined;
      } else {
        exactObservationObject(sdk, ['agentsCoreVersion', 'agentsOpenAiVersion', 'identity']);
        if ([sdk.agentsCoreVersion, sdk.agentsOpenAiVersion].some(value => typeof value !== 'string' ||
            !/^(?:unknown|[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?)$/.test(value))) return undefined;
        observationMember(sdk.identity, ['matched', 'unknown']);
      }
      common.runtime = identity.runtime; common.sdk = {...sdk};
    }
    return buildRuntimeConfigCommitments(common) ? common : undefined;
  } catch {return undefined;}
}
function parseOutputConfig(value: unknown): RuntimeObservedOutputConfig {
  const input = exactObservationObject(value, ['finalSubmission', 'declarationSyntax']);
  return {finalSubmission: observationMember(input.finalSubmission, OUTPUT_MODES),
    declarationSyntax: observationMember(input.declarationSyntax, OUTPUT_SYNTAXES)};
}
function parseProfileObservation(value: unknown): RuntimeExecutionProfileObservation {
  const input = exactObservationObject(value, ['schemaVersion', 'role', 'purpose', 'modelHash', 'originalFingerprint', 'fields', 'structureFingerprint']);
  const fingerprint = exactObservationObject(input.originalFingerprint, ['schemaVersion', 'value']);
  const fields = parseConfigFields(input.fields);
  if (input.schemaVersion !== 'execution_profile_observation@1' || fingerprint.schemaVersion !== 'model_execution_fingerprint@1' ||
      typeof fingerprint.value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fingerprint.value) ||
      runtimeConfigCommitmentsFingerprint(fields) !== input.structureFingerprint) throw new Error('runtime_observation_profile_invalid');
  return {schemaVersion: 'execution_profile_observation@1', role: observationMember(input.role, ['main_controls', 'stage_policy', 'typed_admission']),
    purpose: observationMember(input.purpose, RUNTIME_MODEL_CALL_PURPOSES), modelHash: observationHash(input.modelHash),
    originalFingerprint: {schemaVersion: 'model_execution_fingerprint@1', value: fingerprint.value}, fields, structureFingerprint: observationHash(input.structureFingerprint)};
}
export function buildRuntimeExecutionProfileObservation(profile: unknown,
  identity: Pick<RuntimeExecutionProfileObservation, 'role' | 'purpose'>): RuntimeExecutionProfileObservation | undefined {
  try {
    const input = observationData(profile), model = observationData(input.model);
    const fingerprint = exactObservationObject(input.fingerprint, ['schemaVersion', 'value']);
    const body = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'fingerprint'));
    const fields = buildRuntimeConfigCommitments(body);
    if (!fields || typeof model.requestedId !== 'string' || !model.requestedId || input.schemaVersion !== 'model_execution_profile@1' ||
        fingerprint.value !== `sha256:${runtimeObservationHash(JSON.stringify(body))}`) return undefined;
    return immutableCanonicalSnapshot(parseProfileObservation({schemaVersion: 'execution_profile_observation@1', ...identity,
      modelHash: runtimeObservationHash(model.requestedId), originalFingerprint: fingerprint, fields,
      structureFingerprint: runtimeConfigCommitmentsFingerprint(fields)}));
  } catch {return undefined;}
}
function parseAppliedControls(value: unknown): RuntimeAppliedModelControls {
  const input = exactObservationObject(value, ['schemaVersion', 'requestedOutput', 'commonConfig', 'appliedSettings', 'profiles', 'fullFingerprint']);
  if (input.schemaVersion !== 'applied_model_controls@1' || !Array.isArray(input.profiles) || input.profiles.length > 16) throw new Error('runtime_observation_controls_invalid');
  const body = {schemaVersion: 'applied_model_controls@1' as const, requestedOutput: parseOutputConfig(input.requestedOutput),
    commonConfig: parseConfigFields(input.commonConfig), appliedSettings: parseConfigFields(input.appliedSettings),
    profiles: input.profiles.map(parseProfileObservation)};
  if (canonicalContentHash(body) !== input.fullFingerprint) throw new Error('runtime_observation_controls_hash_invalid');
  return {...body, fullFingerprint: observationHash(input.fullFingerprint)};
}
export function buildRuntimeAppliedModelControls(input: {requestedOutput: RuntimeObservedOutputConfig; commonConfig: unknown;
  appliedSettings: unknown; profiles?: readonly RuntimeExecutionProfileObservation[]}): RuntimeAppliedModelControls | undefined {
  try {
    const commonConfig = buildRuntimeConfigCommitments(input.commonConfig), appliedSettings = buildRuntimeConfigCommitments(input.appliedSettings);
    if (!commonConfig || !appliedSettings) return undefined;
    const body = {schemaVersion: 'applied_model_controls@1' as const, requestedOutput: parseOutputConfig(input.requestedOutput),
      commonConfig, appliedSettings, profiles: (input.profiles ?? []).map(parseProfileObservation)};
    return immutableCanonicalSnapshot({...body, fullFingerprint: canonicalContentHash(body)});
  } catch {return undefined;}
}

function parseObservedHash(value: unknown): RuntimeObservedHash {
  const input = observationData(value);
  if (input.status === 'unknown') {exactObservationObject(input, ['status']); return {status: 'unknown'};}
  exactObservationObject(input, ['status', 'hash']);
  if (input.status !== 'observed') throw new Error('runtime_observation_status_invalid');
  return {status: 'observed', hash: observationHash(input.hash)};
}
function parseFinalTransportInput(value: unknown): RuntimeFinalTransportEventInput {
  // Check descriptors/proxies before any nested read, including arrays of references/profiles.
  if (!buildRuntimeConfigCommitments(value)) throw new Error('runtime_observation_data_invalid');
  const input = observationData(value);
  const keys = (required: readonly string[]) => exactObservationObject(input, ['kind', ...required]);
  switch (input.kind) {
    case 'main_dispatch':
      keys(['attemptKey', 'logicalCallKey', 'purpose', 'configuredModelHash', 'providerOriginHash', 'controls']);
      return {kind: input.kind, attemptKey: observationHash(input.attemptKey), logicalCallKey: observationHash(input.logicalCallKey),
        purpose: observationMember(input.purpose, ['answer_turn', 'declaration_repair', 'continuation']),
        configuredModelHash: observationHash(input.configuredModelHash), providerOriginHash: observationHash(input.providerOriginHash),
        controls: parseAppliedControls(input.controls)};
    case 'stage_dispatch':
      keys(['stageCallKey', 'purpose', 'configuredModelHash', 'providerOriginHash', 'controls']);
      return {kind: input.kind, stageCallKey: observationHash(input.stageCallKey), purpose: observationMember(input.purpose, RUNTIME_MODEL_CALL_PURPOSES),
        configuredModelHash: observationHash(input.configuredModelHash), providerOriginHash: observationHash(input.providerOriginHash),
        controls: parseAppliedControls(input.controls)};
    case 'native_terminal': {
      keys(['fact', 'drainStatus']);
      const fact = exactObservationObject(input.fact, ['attemptKey', 'logicalCallKey', 'response', 'actualModel', 'nativeStatus',
        'finish', 'rawMaterial', 'nativeContract', 'sdkStreamCompleted']);
      if (fact.nativeContract !== 'openai_native_completion_observer@1' || typeof fact.sdkStreamCompleted !== 'boolean') throw new Error('runtime_observation_contract_invalid');
      return {kind: input.kind, fact: {attemptKey: observationHash(fact.attemptKey), logicalCallKey: observationHash(fact.logicalCallKey),
        response: parseObservedHash(fact.response), actualModel: parseObservedHash(fact.actualModel),
        nativeStatus: observationMember(fact.nativeStatus, FINAL_NATIVE_STATUSES),
        finish: observationMember(fact.finish, ['stop', 'length', 'tool_calls', 'completed', 'incomplete', 'failed', 'other', 'unknown']),
        rawMaterial: parseObservedHash(fact.rawMaterial), nativeContract: fact.nativeContract, sdkStreamCompleted: fact.sdkStreamCompleted},
        drainStatus: observationMember(input.drainStatus, ['fulfilled', 'rejected', 'unavailable'])};
    }
    case 'typed_issued_after_drain':
      keys(['attemptKey', 'logicalCallKey', 'responseKey', 'callKey', 'actualModel', 'nativeStatus', 'drainStatus',
        'nativeBodyHash', 'representationVersion', 'compilerVersion', 'admissionVersion']);
      if (input.nativeStatus !== 'completed' || input.drainStatus !== 'fulfilled') throw new Error('runtime_observation_typed_invalid');
      return {kind: input.kind, attemptKey: observationHash(input.attemptKey), logicalCallKey: observationHash(input.logicalCallKey),
        responseKey: observationHash(input.responseKey), callKey: observationHash(input.callKey), actualModel: parseObservedHash(input.actualModel),
        nativeStatus: input.nativeStatus, drainStatus: input.drainStatus, nativeBodyHash: observationHash(input.nativeBodyHash),
        representationVersion: observationMember(input.representationVersion, ['authored_claim_document@1', 'authored_claim_document@2']),
        compilerVersion: observationMember(input.compilerVersion, ['authored_claim_document_compiler@1', 'authored_claim_document_compiler@2']),
        admissionVersion: observationMember(input.admissionVersion, ['openai_typed_final_admission@1', 'openai_typed_final_admission@2'])};
    case 'candidate_retained':
      keys(['nativeCandidateKey', 'carrier', 'transform', 'authors', 'declaredBody', 'declaredClaims', 'productStatus']);
      if (!Array.isArray(input.authors) || input.authors.length > 2) throw new Error('runtime_observation_authors_invalid');
      return {kind: input.kind, nativeCandidateKey: observationHash(input.nativeCandidateKey),
        carrier: observationMember(input.carrier, ['assistant_text', 'model_tool_arguments']),
        transform: observationMember(input.transform, ['native', 'declaration_repair']), authors: input.authors.map(value => {
          const author = exactObservationObject(value, ['role', 'terminalEventKey']);
          return {role: observationMember(author.role, ['body', 'declaration', 'body_and_declaration']), terminalEventKey: observationHash(author.terminalEventKey)};
        }), declaredBody: observationMember(input.declaredBody, ['present', 'absent']),
        declaredClaims: observationMember(input.declaredClaims, ['present', 'absent', 'invalid', 'unknown']),
        productStatus: observationMember(input.productStatus, FINAL_NATIVE_STATUSES)};
    case 'finalizer_selected':
      keys(['retainedEventKey', 'nativeCandidateKey', 'displayCandidateKey', 'canonicalSourceCandidateKey', 'canonicalCandidateKey', 'productStatus']);
      return {kind: input.kind, retainedEventKey: observationHash(input.retainedEventKey), nativeCandidateKey: observationHash(input.nativeCandidateKey),
        displayCandidateKey: observationHash(input.displayCandidateKey), canonicalSourceCandidateKey: observationHash(input.canonicalSourceCandidateKey),
        canonicalCandidateKey: observationHash(input.canonicalCandidateKey), productStatus: observationMember(input.productStatus, FINAL_NATIVE_STATUSES)};
    case 'not_exercised':
      keys(['reason']);
      return {kind: input.kind, reason: observationMember(input.reason, ['program_ack', 'direct_without_main'])};
    default: throw new Error('runtime_observation_event_invalid');
  }
}
/** Strict shared stored-receipt projection, not an authority check or a quality verdict. */
export function projectRuntimeFinalTransportObservation(value: unknown): RuntimeFinalTransportObservation | undefined {
  try {
    const input = exactObservationObject(value, ['schemaVersion', 'events', 'truncated']);
    if (input.schemaVersion !== 'final_transport_observation@1' || !Array.isArray(input.events) || nodeUtilTypes.isProxy(input.events) ||
        input.events.length > DEFAULT_MAX_RECEIPT_ITEMS || !Number.isSafeInteger(input.truncated) || (input.truncated as number) < 0) return undefined;
    const seen = new Set<string>();
    let previousOffset = -1;
    const events = input.events.map((value, index) => {
      const event = observationData(value);
      const {eventKey, sequence, offsetMs, ...payload} = event;
      const parsed = parseFinalTransportInput(payload);
      if (sequence !== index + 1 || typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < previousOffset || offsetMs < 0 ||
          typeof eventKey !== 'string' || seen.has(eventKey) || eventKey !== canonicalContentHash({sequence, offsetMs, ...parsed})) throw new Error('runtime_observation_event_identity_invalid');
      previousOffset = offsetMs; seen.add(eventKey);
      return {...parsed, eventKey, sequence, offsetMs} as RuntimeFinalTransportEvent;
    });
    return immutableCanonicalSnapshot({schemaVersion: 'final_transport_observation@1', events, truncated: input.truncated as number});
  } catch {return undefined;}
}

/** Provider-reported token counts, copied only when the provider returns them. */
export interface RuntimeModelCallUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** Closed request-size bucket of a model call's prompt and system text. */
export const RUNTIME_MODEL_CALL_INPUT_BYTES_BUCKETS = ['le32k', 'le128k', 'gt128k'] as const;
export type RuntimeModelCallInputBytesBucket = typeof RUNTIME_MODEL_CALL_INPUT_BYTES_BUCKETS[number];

export function runtimeModelCallInputBytesBucket(bytes: number): RuntimeModelCallInputBytesBucket | undefined {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  return bytes <= 32 * 1024 ? 'le32k' : bytes <= 128 * 1024 ? 'le128k' : 'gt128k';
}

/** The URL origin of a configured provider base URL; never its path, query or credentials. */
export function runtimeProviderOrigin(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return undefined;
  try {
    const url = new URL(baseUrl.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin.length <= 256 ? url.origin : undefined;
  } catch { return undefined; }
}

export const RUNTIME_DECLARATION_AUTHORING_STATUSES = ['expanded', 'invalid', 'not_observed'] as const;
export const RUNTIME_DECLARATION_AUTHORING_VERSIONS = ['conclusion_authoring@1', 'conclusion_authoring@2'] as const;

interface RuntimeModelCallOutput {
  bodyChars: number;
  sidecarChars: number;
  /** Observed input-codec result only; absence/not_observed does not identify canonical syntax or establish proof. */
  declarationAuthoringStatus?: typeof RUNTIME_DECLARATION_AUTHORING_STATUSES[number];
  /** Actual successfully decoded grammar, never copied from the requested run setting. */
  declarationAuthoringVersion?: typeof RUNTIME_DECLARATION_AUTHORING_VERSIONS[number];
}

export interface RuntimePerformanceModelCallReceiptV1 {
  purpose: RuntimeModelCallPurpose;
  trigger?: RuntimeModelCallTrigger;
  /** Model the provider reported, else the one requested. Internal receipt only. */
  model?: string;
  /** Explicit producer provenance; a configured fallback never certifies the provider model. */
  modelSource?: 'configured' | 'provider_reported';
  /** Origin of the configured provider base URL (`runtimeProviderOrigin`). Internal receipt only. */
  providerOrigin?: string;
  inputBytesBucket?: RuntimeModelCallInputBytesBucket;
  reasoning?: RuntimeModelCallReasoning;
  /** Explicit request-side effort, not proof of the server's internal reasoning behavior. */
  reasoningEffort?: RuntimeModelReasoningEffort;
  startOffsetMs: number;
  durationMs: number;
  /** Time from this call's dispatch to its first provider output, when the stream exposes it. */
  firstOutputMs?: number;
  outcome: RuntimePerformanceOutcome;
  /** Visible body vs machine declaration characters of the text this call produced. */
  output?: RuntimeModelCallOutput;
  usage?: RuntimeModelCallUsageV1;
}

export const MODEL_REQUEST_COMPONENTS = ['system', 'toolDescription', 'toolSchema', 'user', 'assistant',
  'reasoning', 'toolArguments', 'toolResults', 'other'] as const;
export interface ModelRequestBodyMetrics {
  status: 'observed' | 'body_unobservable';
  /** Bytes of the actual supplied body, before HTTP transfer encoding. Not tokens. */
  bodyBytes?: number;
  /** Re-encoded JSON values, never original wire slices. Compare separately from bodyBytes. */
  normalized?: {measurement: 'normalized_json_utf8'; totalBytes: number;
    components: Record<typeof MODEL_REQUEST_COMPONENTS[number], number>};
  normalizedUnavailableReason?: 'non_json' | 'too_large' | 'unsupported_shape';
}

/** A fetch dispatch, not a native model turn. Headers do not certify stream completion.
 * Native usage/output stay in modelCalls: there is no inferred dispatch association. */
export interface RuntimeModelRequestReceiptV1 {
  dispatchOrdinal: number;
  purpose?: RuntimeModelCallPurpose;
  trigger?: RuntimeModelCallTrigger;
  startOffsetMs: number;
  fetchOutcome: 'pending' | 'headers' | 'error' | 'cancelled';
  headersMs?: number;
  httpStatus?: number;
  body: ModelRequestBodyMetrics;
}

export interface RuntimeModelRequestSpan {
  headers(httpStatus: number): void;
  fail(cancelled: boolean): void;
}

/**
 * A delivery call's budget decision made before dispatch
 * (`assessDeliveryCallBudget`): the estimate it compared and where it came from.
 */
export interface RuntimePerformanceDeliveryBudgetReceiptV1 {
  purpose: RuntimeModelCallPurpose;
  decision: 'dispatch' | 'skip';
  source: 'stats' | 'default';
  estimateMs: number;
  remainingMs: number;
  /** Why the estimate is a fixed default. */
  diagnostic?: 'stats_not_configured' | 'stats_unreadable' | 'no_samples';
}

/**
 * Whether the finalizer's semantic review was required, and what required it.
 * Counts only; no claim ids, text or evidence values.
 */
export interface RuntimePerformanceFinalReviewReceiptV1 {
  necessity: typeof RUNTIME_FINAL_REVIEW_NECESSITIES[number];
  triggers: RuntimeFinalReviewTrigger[];
  declaredClaimCount: number;
}

export const RUNTIME_DECLARATION_STATUSES = ['absent', 'valid', 'partially_valid', 'invalid'] as const;
export const RUNTIME_DECLARATION_REPAIR_OUTCOMES = [
  'not_requested', 'accepted', 'rejected', 'budget_skipped', 'cancelled', 'error', 'not_completed',
] as const;

/** The first canonical declaration and its repair outcome; counts and closed facts only. */
export interface RuntimePerformanceDeclarationReceiptV1 {
  status: typeof RUNTIME_DECLARATION_STATUSES[number];
  declaredClaimCount: number;
  repair: typeof RUNTIME_DECLARATION_REPAIR_OUTCOMES[number];
}

export interface RuntimePerformanceReceiptV1 {
  schemaVersion: 1;
  /** Internal run activity, not a verification or progress verdict. */
  activity?: RuntimeActivitySnapshot;
  firstOutputMs?: number;
  phases: RuntimePerformancePhaseReceiptV1[];
  tools: RuntimePerformanceToolReceiptV1[];
  sql: RuntimePerformanceSqlReceiptV1[];
  /** Absent in receipts recorded before per-call records existed. */
  modelCalls?: RuntimePerformanceModelCallReceiptV1[];
  modelRequests?: RuntimeModelRequestReceiptV1[];
  policyObservations?: RuntimeModelPolicyObservation[];
  finalTransportObservation?: RuntimeFinalTransportObservation;
  finalReview?: RuntimePerformanceFinalReviewReceiptV1;
  declaration?: RuntimePerformanceDeclarationReceiptV1;
  deliveryBudgets?: RuntimePerformanceDeliveryBudgetReceiptV1[];
  /** The run's product-owned scene entry evidence attempt; never a model tool call. */
  sceneEvidence?: RuntimePerformanceSceneEvidenceReceiptV1;
  truncated?: {
    phases: number;
    tools: number;
    sql: number;
    modelCalls?: number;
    modelRequests?: number;
    policyObservations?: number;
  };
}

type RuntimePerformanceTruncationBucket = 'phases' | 'tools' | 'sql' | 'modelCalls';

export interface RuntimePerformanceSpan {
  end(outcome?: RuntimePerformanceOutcome): void;
}

export interface RuntimeModelCallStart {
  purpose: RuntimeModelCallPurpose;
  trigger?: RuntimeModelCallTrigger;
  model?: string;
  reasoning?: RuntimeModelCallReasoning;
  reasoningEffort?: RuntimeModelReasoningEffort;
  providerOrigin?: string;
  inputBytesBucket?: RuntimeModelCallInputBytesBucket;
}

export interface RuntimeModelCallEnd {
  outcome?: RuntimePerformanceOutcome;
  /** Replaces the requested model; without provenance its source remains unknown. */
  model?: string;
  /** Only the actual producer may attach this to the same valid end.model. */
  modelSource?: 'provider_reported';
  /** Request-side reasoning control, when only the transport knows it. */
  reasoning?: RuntimeModelCallReasoning;
  reasoningEffort?: RuntimeModelReasoningEffort;
  output?: RuntimeModelCallOutput;
  usage?: unknown;
}

/** One model call; every method is a no-op after `end`, and observability never throws. */
export interface RuntimeModelCallSpan {
  recordFirstOutput(): void;
  /** Fix the end time at the provider's terminal event; `end` may attach facts later. */
  markDone(usage?: unknown): void;
  end(input?: RuntimeModelCallEnd): void;
}

export interface RuntimePerformanceRecorderOptions {
  now?: () => number;
  hashSalt?: string;
  maxPhases?: number;
  maxTools?: number;
  maxSql?: number;
  maxModelCalls?: number;
  maxModelRequests?: number;
  maxPolicyObservations?: number;
  maxFinalTransportEvents?: number;
  maxHashInputBytes?: number;
  onActivity?(snapshot: RuntimeActivitySnapshot): void;
}

export interface RuntimePerformanceToolInput {
  toolCallId?: string;
  mode: RuntimePerformanceToolReceiptV1['mode'];
  schedulerWaitMs: number;
  fallbackReason?: RuntimeToolConcurrencyFallbackReason;
  durationMs: number;
  outcome: RuntimePerformanceOutcome;
}

export interface RuntimePerformanceSqlInput {
  processorKey: string;
  priority: RuntimePerformanceSqlReceiptV1['priority'];
  queueWaitMs: number;
  executionMs: number;
  outcome: RuntimePerformanceOutcome;
}

type RuntimePerformanceSink = RuntimePerformanceSource;

const MAX_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MODEL_NAME_CHARS = 128;
const HASH_PREFIX_LENGTH = 32;
const DEFAULT_MAX_RECEIPT_ITEMS = 512;
const DEFAULT_MAX_HASH_INPUT_BYTES = 256;
const PRIVACY_FIELD_PATTERN =
  /(?:prompt|sql|query|model|credential|secret|token|url|path|raw)/i;
const TOOL_FALLBACK_REASONS = new Set<RuntimeToolConcurrencyFallbackReason>([
  'disabled_by_env',
  'commutative_read_not_admitted',
]);

function defaultNow(): number {
  return nodePerformance.now();
}

function safeHash(value: string, salt = '', maxBytes = DEFAULT_MAX_HASH_INPUT_BYTES): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('runtime_performance_empty_hash_input');
  }
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new Error('runtime_performance_hash_input_too_large');
  }
  return `sha256:${createHash('sha256')
    .update(salt)
    .update('\0')
    .update(normalized)
    .digest('hex')
    .slice(0, HASH_PREFIX_LENGTH)}`;
}

function boundedMs(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`runtime_performance_invalid_ms:${label}`);
  }
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`runtime_performance_invalid_ms:${label}`);
  }
  return Math.min(MAX_MS, Math.max(0, rounded));
}

function assertKnownFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (allowedSet.has(key)) continue;
    if (PRIVACY_FIELD_PATTERN.test(key)) {
      throw new Error(`runtime_performance_privacy_field:${key}`);
    }
    throw new Error(`runtime_performance_unknown_field:${key}`);
  }
}

export class RuntimePerformanceRecorder {
  private readonly now: () => number;
  private readonly hashSalt: string;
  private readonly maxPhases: number;
  private readonly maxTools: number;
  private readonly maxSql: number;
  private readonly maxModelCalls: number;
  private readonly maxModelRequests: number;
  private readonly maxPolicyObservations: number;
  private readonly maxFinalTransportEvents: number;
  private readonly maxHashInputBytes: number;
  private readonly startedAt: number;
  private lastOffsetMs = 0;
  private firstOutputMs: number | undefined;
  private readonly phases: RuntimePerformancePhaseReceiptV1[] = [];
  private readonly tools: RuntimePerformanceToolReceiptV1[] = [];
  private readonly sql: RuntimePerformanceSqlReceiptV1[] = [];
  private readonly modelCalls: RuntimePerformanceModelCallReceiptV1[] = [];
  private readonly modelRequests: RuntimeModelRequestReceiptV1[] = [];
  private readonly policyObservations: RuntimeModelPolicyObservation[] = [];
  private readonly finalTransportEvents: RuntimeFinalTransportEvent[] = [];
  private finalTransportTruncated = 0;
  private finalReview: RuntimePerformanceFinalReviewReceiptV1 | undefined;
  private declaration: RuntimePerformanceDeclarationReceiptV1 | undefined;
  // Independent of capped timing arrays. Absence from those arrays cannot
  // establish that no repair was attempted.
  private declarationRepair: RuntimePerformanceDeclarationReceiptV1['repair'] = 'not_requested';
  private readonly deliveryBudgets: RuntimePerformanceDeliveryBudgetReceiptV1[] = [];
  private sceneEvidence: RuntimePerformanceSceneEvidenceReceiptV1 | undefined;
  private nextToolSequence = 0;
  private readonly truncated = {
    phases: 0,
    tools: 0,
    sql: 0,
    modelCalls: 0,
    modelRequests: 0,
    policyObservations: 0,
  };
  private sealedReceipt: RuntimePerformanceReceiptV1 | undefined;
  private activityLifetime?: () => boolean;
  private readonly activity: RuntimeActivityRecorder;
  private readonly onActivity?: (snapshot: RuntimeActivitySnapshot) => void;

  constructor(options: RuntimePerformanceRecorderOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.hashSalt = options.hashSalt ?? '';
    this.maxPhases = positiveCap(options.maxPhases, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxTools = positiveCap(options.maxTools, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxSql = positiveCap(options.maxSql, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxModelCalls = positiveCap(options.maxModelCalls, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxModelRequests = positiveCap(options.maxModelRequests, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxPolicyObservations = Math.min(DEFAULT_MAX_RECEIPT_ITEMS,
      positiveCap(options.maxPolicyObservations, DEFAULT_MAX_RECEIPT_ITEMS));
    this.maxFinalTransportEvents = Math.min(DEFAULT_MAX_RECEIPT_ITEMS, positiveCap(options.maxFinalTransportEvents, DEFAULT_MAX_RECEIPT_ITEMS));
    this.maxHashInputBytes = positiveCap(
      options.maxHashInputBytes,
      DEFAULT_MAX_HASH_INPUT_BYTES,
    );
    this.startedAt = this.now();
    this.onActivity = options.onActivity;
    this.activity = new RuntimeActivityRecorder(() => this.canObserveActivity(), () => this.offsetMs(), () => {
      try { if (this.canObserveActivity()) this.onActivity?.(this.activity.snapshot()); } catch { /* Observability only. */ }
    });
  }

  /** Additional product lifetimes can only restrict an existing recorder. */
  bindActivityLifetime(active: () => boolean): void {
    const previous = this.activityLifetime;
    this.activityLifetime = previous ? () => previous() && active() : active;
  }

  private canObserveActivity(): boolean {
    if (this.sealedReceipt) return false;
    try { return this.activityLifetime?.() !== false; } catch { return false; }
  }

  startToolActivity(toolName: string, args: Record<string, unknown>): RuntimeActivitySpan {
    return this.activity.start(toolName, args);
  }

  recordCaptureActivity(witness: object, input: RuntimeCaptureActivityInput): void {
    this.activity.capture(witness, input);
  }

  markActivityPartial(): void {
    if (!this.sealedReceipt) this.activity.markPartial();
  }

  activitySnapshot(): RuntimeActivitySnapshot {
    return this.sealedReceipt?.activity ?? this.activity.snapshot();
  }

  get hasRecordedData(): boolean {
    return (
      this.activity.hasRecordedData
      || this.firstOutputMs !== undefined
      || this.phases.length > 0
      || this.tools.length > 0
      || this.sql.length > 0
      || this.modelCalls.length > 0
      || this.modelRequests.length > 0
      || this.policyObservations.length > 0
      || this.finalTransportEvents.length > 0
      || this.finalTransportTruncated > 0
      || this.finalReview !== undefined
      || this.declaration !== undefined
      || this.deliveryBudgets.length > 0
      || this.sceneEvidence !== undefined
      || this.truncated.phases > 0
      || this.truncated.tools > 0
      || this.truncated.sql > 0
      || this.truncated.modelCalls > 0
      || this.truncated.modelRequests > 0
      || this.truncated.policyObservations > 0
    );
  }

  startPhase(name: RuntimePhaseName): RuntimePerformanceSpan {
    this.assertCollecting('start_phase');
    const startOffsetMs = this.offsetMs();
    let ended = false;
    return {
      end: (outcome: RuntimePerformanceOutcome = 'ok') => {
        if (ended) return;
        this.assertCollecting('finish_phase');
        ended = true;
        this.pushCapped('phases', this.maxPhases, this.phases, {
          name,
          startOffsetMs,
          durationMs: boundedMs(this.offsetMs() - startOffsetMs, 'phase_duration'),
          outcome,
        });
      },
    };
  }

  recordFirstOutput(): void {
    this.assertCollecting('record_first_output');
    if (this.firstOutputMs !== undefined) return;
    this.firstOutputMs = this.offsetMs();
  }

  recordTool(input: RuntimePerformanceToolInput): void {
    this.assertCollecting('record_tool');
    assertKnownFields(input as unknown as Record<string, unknown>, [
      'toolCallId',
      'mode',
      'schedulerWaitMs',
      'fallbackReason',
      'durationMs',
      'outcome',
    ]);
    if (!['exclusive', 'commutative_read'].includes(input.mode)) {
      throw new Error(`runtime_performance_invalid_tool_mode:${input.mode}`);
    }
    if (input.fallbackReason !== undefined && !TOOL_FALLBACK_REASONS.has(input.fallbackReason)) {
      throw new Error(`runtime_performance_invalid_tool_fallback_reason:${input.fallbackReason}`);
    }
    this.pushCapped('tools', this.maxTools, this.tools, {
      toolCallIdHash: safeHash(
        input.toolCallId ?? this.nextFallbackToolCallId(),
        this.hashSalt,
        this.maxHashInputBytes,
      ),
      mode: input.mode,
      schedulerWaitMs: boundedMs(input.schedulerWaitMs, 'tool_scheduler_wait'),
      ...(input.fallbackReason ? {fallbackReason: input.fallbackReason} : {}),
      durationMs: boundedMs(input.durationMs, 'tool_duration'),
      outcome: input.outcome,
    });
  }

  startTool(
    toolCallId?: string,
    mode: RuntimePerformanceToolReceiptV1['mode'] = 'exclusive',
    schedulerWaitMs = 0,
    fallbackReason?: RuntimeToolConcurrencyFallbackReason,
  ): RuntimePerformanceSpan {
    this.assertCollecting('start_tool');
    const startOffsetMs = this.offsetMs();
    let ended = false;
    return {
      end: (outcome: RuntimePerformanceOutcome = 'ok') => {
        if (ended) return;
        ended = true;
        this.recordTool({
          toolCallId,
          mode,
          schedulerWaitMs,
          fallbackReason,
          durationMs: this.offsetMs() - startOffsetMs,
          outcome,
        });
      },
    };
  }

  recordSql(input: RuntimePerformanceSqlInput): void {
    this.assertCollecting('record_sql');
    assertKnownFields(input as unknown as Record<string, unknown>, [
      'processorKey',
      'priority',
      'queueWaitMs',
      'executionMs',
      'outcome',
    ]);
    if (!['p0', 'p1', 'p2'].includes(input.priority)) {
      throw new Error(`runtime_performance_invalid_sql_priority:${input.priority}`);
    }
    this.pushCapped('sql', this.maxSql, this.sql, {
      processorKeyHash: safeHash(
        input.processorKey,
        this.hashSalt,
        this.maxHashInputBytes,
      ),
      priority: input.priority,
      queueWaitMs: boundedMs(input.queueWaitMs, 'sql_queue_wait'),
      executionMs: boundedMs(input.executionMs, 'sql_execution'),
      outcome: input.outcome,
    });
  }

  recordFinalTransportEvent(input: RuntimeFinalTransportEventInput): string | undefined {
    this.assertCollecting('record_final_transport');
    if (this.finalTransportEvents.length >= this.maxFinalTransportEvents) {this.finalTransportTruncated++; return undefined;}
    let payload: RuntimeFinalTransportEventInput;
    try {payload = parseFinalTransportInput(input);} catch {this.finalTransportTruncated++; return undefined;}
    const event = {sequence: this.finalTransportEvents.length + 1, offsetMs: this.offsetMs(), ...payload};
    const eventKey = canonicalContentHash(event);
    this.finalTransportEvents.push(immutableCanonicalSnapshot({...event, eventKey}));
    return eventKey;
  }

  findFinalTransportRetainedEvent(nativeCandidateKey: string): Readonly<{eventKey: string; nativeCandidateKey: string}> | undefined {
    if (this.sealedReceipt || this.finalTransportTruncated) return undefined;
    const found = this.finalTransportEvents.filter(event => event.kind === 'candidate_retained' && event.nativeCandidateKey === nativeCandidateKey);
    if (found.length !== 1) return undefined;
    return Object.freeze({eventKey: found[0].eventKey, nativeCandidateKey});
  }

  recordModelExecutionPolicy(input: unknown): void {
    this.assertCollecting('record_model_execution_policy');
    const receipt = projectRuntimeModelPolicyReceipt(input);
    if (!receipt) return;
    if (this.policyObservations.length >= this.maxPolicyObservations) {
      this.truncated.policyObservations++;
      return;
    }
    this.policyObservations.push({...receipt, observationOrdinal: this.policyObservations.length + 1,
      observedOffsetMs: this.offsetMs()});
  }

  startModelRequest(input: {purpose?: RuntimeModelCallPurpose; trigger?: RuntimeModelCallTrigger;
    body: ModelRequestBodyMetrics}): RuntimeModelRequestSpan | undefined {
    this.assertCollecting('start_model_request');
    if (this.modelRequests.length >= this.maxModelRequests) {
      this.truncated.modelRequests++;
      return undefined;
    }
    const body: ModelRequestBodyMetrics = {status: 'body_unobservable'};
    if (input.body.status === 'observed' && Number.isSafeInteger(input.body.bodyBytes) && input.body.bodyBytes! >= 0) {
      body.status = 'observed';
      body.bodyBytes = input.body.bodyBytes;
      const normalized = input.body.normalized;
      if (normalized?.measurement === 'normalized_json_utf8' && Number.isSafeInteger(normalized.totalBytes) &&
          normalized.totalBytes >= 0 && MODEL_REQUEST_COMPONENTS.every(key =>
          Number.isSafeInteger(normalized.components[key]) && normalized.components[key] >= 0)) {
        body.normalized = {measurement: 'normalized_json_utf8', totalBytes: normalized.totalBytes,
          components: Object.fromEntries(MODEL_REQUEST_COMPONENTS.map(key => [key, normalized.components[key]])) as
            NonNullable<ModelRequestBodyMetrics['normalized']>['components']};
      }
      if (input.body.normalizedUnavailableReason &&
          ['non_json', 'too_large', 'unsupported_shape'].includes(input.body.normalizedUnavailableReason)) {
        body.normalizedUnavailableReason = input.body.normalizedUnavailableReason;
      }
    }
    const entry: RuntimeModelRequestReceiptV1 = {dispatchOrdinal: this.modelRequests.length + 1,
      ...(input.purpose && RUNTIME_MODEL_CALL_PURPOSES.includes(input.purpose) ? {purpose: input.purpose} : {}),
      ...(input.trigger && RUNTIME_MODEL_CALL_TRIGGERS.includes(input.trigger) ? {trigger: input.trigger} : {}),
      startOffsetMs: this.offsetMs(), fetchOutcome: 'pending', body};
    this.modelRequests.push(entry);
    return {
      headers: status => {
        if (!this.canObserveActivity() || entry.fetchOutcome !== 'pending') return;
        entry.fetchOutcome = 'headers';
        entry.headersMs = boundedMs(this.offsetMs() - entry.startOffsetMs, 'model_request_headers');
        if (Number.isSafeInteger(status) && status >= 0 && status <= 599) entry.httpStatus = status;
      },
      fail: cancelled => {
        if (!this.canObserveActivity() || entry.fetchOutcome !== 'pending') return;
        entry.fetchOutcome = cancelled ? 'cancelled' : 'error';
      },
    };
  }

  startModelCall(input: RuntimeModelCallStart): RuntimeModelCallSpan {
    this.assertCollecting('start_model_call');
    const startOffsetMs = this.offsetMs();
    if (!this.declaration && input.purpose === 'declaration_repair') this.declarationRepair = 'not_completed';
    let firstOutputMs: number | undefined;
    let doneOffsetMs: number | undefined;
    let doneUsage: unknown;
    let ended = false;
    return {
      recordFirstOutput: () => {
        if (ended || !this.canObserveActivity() || firstOutputMs !== undefined || doneOffsetMs !== undefined) return;
        firstOutputMs = this.offsetMs() - startOffsetMs;
      },
      markDone: usage => {
        if (ended || !this.canObserveActivity() || doneOffsetMs !== undefined) return;
        doneOffsetMs = this.offsetMs();
        doneUsage = usage;
      },
      end: (end = {}) => {
        if (ended || !this.canObserveActivity()) return;
        ended = true;
        // A native success is not declaration acceptance. Keep an explicit
        // acceptance decision even if the transport attaches its facts later.
        if (!this.declaration && input.purpose === 'declaration_repair' &&
          this.declarationRepair !== 'accepted' && this.declarationRepair !== 'rejected') {
          this.declarationRepair = end.outcome === 'cancelled' || end.outcome === 'error' ? end.outcome : 'not_completed';
        }
        const model = boundedModelName(end.model) ?? boundedModelName(input.model);
        const modelSource = model && end.modelSource === 'provider_reported' && typeof end.model === 'string' &&
          end.model === model && end.model.length <= MAX_MODEL_NAME_CHARS ? 'provider_reported'
          : model && end.model === undefined && end.modelSource === undefined ? 'configured' : undefined;
        const usage = normalizeModelCallUsage(end.usage ?? doneUsage);
        const requestedReasoning = end.reasoning ?? input.reasoning;
        const reasoning = requestedReasoning && ['provider_default', 'disabled', 'enabled'].includes(requestedReasoning)
          ? requestedReasoning : undefined;
        const requestedEffort = end.reasoningEffort ?? input.reasoningEffort;
        const reasoningEffort = reasoning === 'enabled' && requestedEffort && RUNTIME_MODEL_REASONING_EFFORTS.includes(requestedEffort)
          ? requestedEffort : undefined;
        const authoringStatus = end.output?.declarationAuthoringStatus;
        const authoringVersion = end.output?.declarationAuthoringVersion;
        const output = end.output && Number.isSafeInteger(end.output.bodyChars) && end.output.bodyChars >= 0 &&
          Number.isSafeInteger(end.output.sidecarChars) && end.output.sidecarChars >= 0
          ? {bodyChars: end.output.bodyChars, sidecarChars: end.output.sidecarChars,
            ...(authoringStatus && RUNTIME_DECLARATION_AUTHORING_STATUSES.includes(authoringStatus)
              ? {declarationAuthoringStatus: authoringStatus} : {}),
            ...(authoringStatus === 'expanded' && authoringVersion && RUNTIME_DECLARATION_AUTHORING_VERSIONS.includes(authoringVersion)
              ? {declarationAuthoringVersion: authoringVersion} : {})} : undefined;
        this.pushCapped('modelCalls', this.maxModelCalls, this.modelCalls, {
          purpose: input.purpose,
          ...(input.trigger ? {trigger: input.trigger} : {}),
          ...(model ? {model} : {}),
          ...(modelSource ? {modelSource} : {}),
          ...(runtimeProviderOrigin(input.providerOrigin) ? {providerOrigin: runtimeProviderOrigin(input.providerOrigin)} : {}),
          ...(input.inputBytesBucket && RUNTIME_MODEL_CALL_INPUT_BYTES_BUCKETS.includes(input.inputBytesBucket)
            ? {inputBytesBucket: input.inputBytesBucket} : {}),
          ...(reasoning ? {reasoning} : {}), ...(reasoningEffort ? {reasoningEffort} : {}),
          startOffsetMs,
          durationMs: boundedMs((doneOffsetMs ?? this.offsetMs()) - startOffsetMs, 'model_call_duration'),
          ...(firstOutputMs !== undefined ? {firstOutputMs: boundedMs(firstOutputMs, 'model_call_first_output')} : {}),
          outcome: end.outcome ?? 'ok',
          ...(output ? {output} : {}),
          ...(usage ? {usage} : {}),
        });
      },
    };
  }

  /**
   * The run's own finalization decides first; a later finalization that shares
   * this manifest scope cannot replace that decision.
   */
  recordFinalReview(input: RuntimePerformanceFinalReviewReceiptV1): void {
    this.assertCollecting('record_final_review');
    if (this.finalReview) return;
    this.finalReview = {
      necessity: input.necessity,
      triggers: [...new Set(input.triggers)],
      declaredClaimCount: Number.isSafeInteger(input.declaredClaimCount) && input.declaredClaimCount >= 0
        ? input.declaredClaimCount : 0,
    };
  }

  /** Only the declaration acceptance boundary may supply either decision. */
  recordDeclarationRepair(outcome: 'accepted' | 'rejected'): void {
    this.assertCollecting('record_declaration_repair');
    if (outcome !== 'accepted' && outcome !== 'rejected') throw new Error('runtime_performance_invalid_declaration_repair');
    if (this.declaration) return;
    this.declarationRepair = outcome;
  }

  /** Freeze all declaration facts at the first canonical finalization, not at seal. */
  recordFinalDeclaration(input: Omit<RuntimePerformanceDeclarationReceiptV1, 'repair'>): void {
    this.assertCollecting('record_final_declaration');
    assertKnownFields(input as unknown as Record<string, unknown>, ['status', 'declaredClaimCount']);
    if (!RUNTIME_DECLARATION_STATUSES.includes(input.status)) throw new Error('runtime_performance_invalid_declaration_status');
    if (!Number.isSafeInteger(input.declaredClaimCount) || input.declaredClaimCount < 0) {
      throw new Error('runtime_performance_invalid_declaration_count');
    }
    if (this.declaration) return;
    this.declaration = {status: input.status, declaredClaimCount: input.declaredClaimCount, repair: this.declarationRepair};
  }

  recordDeliveryBudget(input: RuntimePerformanceDeliveryBudgetReceiptV1): void {
    this.assertCollecting('record_delivery_budget');
    if (!this.declaration && input.purpose === 'declaration_repair' &&
      this.declarationRepair !== 'accepted' && this.declarationRepair !== 'rejected') {
      if (input.decision === 'skip') this.declarationRepair = 'budget_skipped';
      if (input.decision === 'dispatch') this.declarationRepair = 'not_completed';
    }
    if (this.deliveryBudgets.length >= DEFAULT_MAX_RECEIPT_ITEMS) return;
    this.deliveryBudgets.push({purpose: input.purpose, decision: input.decision, source: input.source,
      estimateMs: boundedMs(input.estimateMs, 'delivery_budget_estimate'),
      remainingMs: boundedMs(input.remainingMs, 'delivery_budget_remaining'),
      ...(input.diagnostic ? {diagnostic: input.diagnostic} : {})});
  }

  /** At most one entry Skill per run: the first record wins. Closed fields only. */
  recordSceneEvidence(input: RuntimePerformanceSceneEvidenceReceiptV1): void {
    this.assertCollecting('record_scene_evidence');
    assertKnownFields(input as unknown as Record<string, unknown>,
      ['skillId', 'status', 'reason', 'durationMs', 'artifactCount', 'captureCount']);
    if (this.sceneEvidence) return;
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(input.skillId)) throw new Error('runtime_performance_invalid_scene_skill');
    if (input.status !== 'ran' && input.status !== 'not_run') throw new Error('runtime_performance_invalid_scene_status');
    if (input.status === 'not_run' ? !isSceneEntryNotRunReason(input.reason) : input.reason !== undefined) {
      throw new Error('runtime_performance_invalid_scene_reason');
    }
    const count = (value: number, label: string) => {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`runtime_performance_invalid_scene_count:${label}`);
      return value;
    };
    this.sceneEvidence = {
      skillId: input.skillId,
      status: input.status,
      ...(input.reason ? {reason: input.reason} : {}),
      durationMs: boundedMs(input.durationMs, 'scene_evidence_duration'),
      artifactCount: count(input.artifactCount, 'artifacts'),
      captureCount: count(input.captureCount, 'captures'),
    };
  }

  seal(): RuntimePerformanceReceiptV1 {
    if (this.sealedReceipt) return this.sealedReceipt;
    if (this.activity.snapshot().inFlight > 0) this.activity.markPartial();
    const receipt: RuntimePerformanceReceiptV1 = {
      schemaVersion: 1,
      ...(this.activity.hasRecordedData ? {activity: this.activity.snapshot()} : {}),
      ...(this.firstOutputMs !== undefined
        ? {firstOutputMs: this.firstOutputMs}
        : {}),
      phases: [...this.phases],
      tools: [...this.tools],
      sql: [...this.sql],
      ...(this.modelCalls.length > 0 ? {modelCalls: [...this.modelCalls]} : {}),
      ...(this.modelRequests.length > 0 ? {modelRequests: [...this.modelRequests]} : {}),
      ...(this.policyObservations.length > 0 ? {policyObservations: [...this.policyObservations]} : {}),
      ...(this.finalTransportEvents.length || this.finalTransportTruncated ? {finalTransportObservation: {
        schemaVersion: 'final_transport_observation@1' as const, events: [...this.finalTransportEvents], truncated: this.finalTransportTruncated}} : {}),
      ...(this.finalReview ? {finalReview: this.finalReview} : {}),
      ...(this.declaration ? {declaration: this.declaration} : {}),
      ...(this.deliveryBudgets.length > 0 ? {deliveryBudgets: [...this.deliveryBudgets]} : {}),
      ...(this.sceneEvidence ? {sceneEvidence: this.sceneEvidence} : {}),
      ...(this.truncated.phases > 0
        || this.truncated.tools > 0
        || this.truncated.sql > 0
        || this.truncated.modelCalls > 0
        || this.truncated.modelRequests > 0
        || this.truncated.policyObservations > 0
        ? {truncated: {
          phases: this.truncated.phases,
          tools: this.truncated.tools,
          sql: this.truncated.sql,
          ...(this.truncated.modelCalls > 0 ? {modelCalls: this.truncated.modelCalls} : {}),
          ...(this.truncated.modelRequests > 0 ? {modelRequests: this.truncated.modelRequests} : {}),
          ...(this.truncated.policyObservations > 0 ? {policyObservations: this.truncated.policyObservations} : {}),
        }}
        : {}),
    };
    this.sealedReceipt = immutableCanonicalSnapshot(receipt);
    return this.sealedReceipt;
  }

  private offsetMs(): number {
    const current = boundedMs(this.now() - this.startedAt, 'offset');
    this.lastOffsetMs = Math.max(this.lastOffsetMs, current);
    return this.lastOffsetMs;
  }

  private assertCollecting(operation: string): void {
    if (this.sealedReceipt) throw new Error(`runtime_performance_already_sealed:${operation}`);
    if (this.activityLifetime?.() === false) throw new Error('runtime_performance_scope_inactive');
  }

  private pushCapped<T>(
    bucket: RuntimePerformanceTruncationBucket,
    cap: number,
    target: T[],
    value: T,
  ): void {
    if (target.length >= cap) {
      this.truncated[bucket]++;
      return;
    }
    target.push(value);
  }

  private nextFallbackToolCallId(): string {
    this.nextToolSequence += 1;
    return `runtime-tool-sequence:${this.nextToolSequence}`;
  }
}

/** A model name is configuration, not content; keep it short and printable. */
function boundedModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed ? trimmed.slice(0, MAX_MODEL_NAME_CHARS) : undefined;
}

function tokenCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * Copy only the token counts a provider returned. Accepts the Agents SDK
 * camelCase usage and the raw Chat Completions / Responses snake_case shapes.
 */
export function normalizeModelCallUsage(value: unknown): RuntimeModelCallUsageV1 | undefined {
  if (!isPlainObject(value)) return undefined;
  const usage = value;
  const inputDetails = [usage.inputTokensDetails, usage.input_tokens_details, usage.prompt_tokens_details]
    .find(isPlainObject);
  const outputDetails = [usage.outputTokensDetails, usage.output_tokens_details, usage.completion_tokens_details]
    .find(isPlainObject);
  const inputTokens = tokenCount(usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = tokenCount(usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const reasoningTokens = tokenCount(outputDetails?.reasoning_tokens, outputDetails?.reasoningTokens);
  const cachedInputTokens = tokenCount(inputDetails?.cached_tokens, inputDetails?.cachedTokens);
  const result: RuntimeModelCallUsageV1 = {
    ...(inputTokens !== undefined ? {inputTokens} : {}),
    ...(outputTokens !== undefined ? {outputTokens} : {}),
    ...(reasoningTokens !== undefined ? {reasoningTokens} : {}),
    ...(cachedInputTokens !== undefined ? {cachedInputTokens} : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function positiveCap(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('runtime_performance_invalid_cap');
  }
  return value;
}

export function createRuntimePerformanceRecorder(
  options: RuntimePerformanceRecorderOptions = {},
): RuntimePerformanceRecorder {
  return new RuntimePerformanceRecorder(options);
}

export interface RuntimePerformanceRun {
  finishClassification(outcome?: RuntimePerformanceOutcome): void;
  startPhase(name: RuntimePhaseName): RuntimePerformanceSpan;
  startModelCall(input: RuntimeModelCallStart): RuntimeModelCallSpan;
  /** The run's scene entry evidence receipt; never throws. */
  recordSceneEvidence(input: RuntimePerformanceSceneEvidenceReceiptV1): void;
  recordFirstOutput(): void;
  finalize(outcome?: RuntimePerformanceOutcome): void;
}

const noopSpan: RuntimePerformanceSpan = {end: () => undefined};
const noopModelCallSpan: RuntimeModelCallSpan = {
  recordFirstOutput: () => undefined, markDone: () => undefined, end: () => undefined,
};

/**
 * Start a model-call record on an optional recorder. Observability never
 * throws into the call it measures, including after the receipt was sealed.
 */
export function startRuntimeModelCall(
  recorder: RuntimePerformanceRecorder | undefined,
  input: RuntimeModelCallStart,
): RuntimeModelCallSpan {
  let span: RuntimeModelCallSpan;
  try {
    span = resolveRuntimePerformanceRecorder(recorder ? {runtimePerformanceRecorder: recorder} : undefined)?.startModelCall(input) ?? noopModelCallSpan;
  } catch {
    return noopModelCallSpan;
  }
  const guard = (operation: () => void) => {
    try { operation(); } catch { /* Runtime performance is internal observability only. */ }
  };
  return {
    recordFirstOutput: () => guard(() => span.recordFirstOutput()),
    markDone: usage => guard(() => span.markDone(usage)),
    end: input => guard(() => span.end(input)),
  };
}

/** Safe transport callback target. Explicit sources retain current-run identity;
 * absent sources use only the active scope, never a last-request/global recorder. */
export function recordRuntimeModelExecutionPolicy(source: RuntimePerformanceSource | undefined, receipt: unknown): void {
  try { resolveRuntimePerformanceRecorder(source)?.recordModelExecutionPolicy(receipt); }
  catch { /* A policy observation cannot change provider execution. */ }
}

/** Observation-only append. Missing/currentness/seal failures never affect execution. */
export function recordRuntimeFinalTransportEvent(source: RuntimePerformanceSource | undefined,
  input: RuntimeFinalTransportEventInput): string | undefined {
  try {return resolveRuntimePerformanceRecorder(source)?.recordFinalTransportEvent(input);}
  catch {return undefined;}
}
/** Lookup a recorded lineage summary; this does not grant or recreate any native capability. */
export function findRuntimeRetainedTransportEvent(source: RuntimePerformanceSource | undefined,
  nativeCandidateKey: string): Readonly<{eventKey: string; nativeCandidateKey: string}> | undefined {
  try {return resolveRuntimePerformanceRecorder(source)?.findFinalTransportRetainedEvent(nativeCandidateKey);}
  catch {return undefined;}
}

/** Record the finalizer's review decision on an optional recorder; never throws. */
export function recordRuntimeFinalReview(
  recorder: RuntimePerformanceRecorder | undefined,
  input: RuntimePerformanceFinalReviewReceiptV1,
): void {
  try { resolveRuntimePerformanceRecorder(recorder ? {runtimePerformanceRecorder: recorder} : undefined)?.recordFinalReview(input); } catch { /* Internal observability only. */ }
}

/** Record the acceptance boundary's decision; never alters the candidate or throws. */
export function recordRuntimeDeclarationRepair(
  recorder: RuntimePerformanceRecorder | undefined,
  outcome: 'accepted' | 'rejected',
): void {
  try { resolveRuntimePerformanceRecorder(recorder ? {runtimePerformanceRecorder: recorder} : undefined)?.recordDeclarationRepair(outcome); } catch { /* Internal observability only. */ }
}

/** Record the first canonical declaration without changing its verification state. */
export function recordRuntimeFinalDeclaration(
  recorder: RuntimePerformanceRecorder | undefined,
  input: Omit<RuntimePerformanceDeclarationReceiptV1, 'repair'>,
): void {
  try { resolveRuntimePerformanceRecorder(recorder ? {runtimePerformanceRecorder: recorder} : undefined)?.recordFinalDeclaration(input); } catch { /* Internal observability only. */ }
}

/** Record a delivery call's pre-dispatch budget decision on an optional recorder; never throws. */
export function recordRuntimeDeliveryBudget(
  recorder: RuntimePerformanceRecorder | undefined,
  input: RuntimePerformanceDeliveryBudgetReceiptV1,
): void {
  try { resolveRuntimePerformanceRecorder(recorder ? {runtimePerformanceRecorder: recorder} : undefined)?.recordDeliveryBudget(input); } catch { /* Internal observability only. */ }
}

export function createRuntimePerformanceRun(
  sink?: RuntimePerformanceSink,
): RuntimePerformanceRun {
  const recorder = resolveRuntimePerformanceRecorder(sink);
  const safeStartPhase = (name: RuntimePhaseName): RuntimePerformanceSpan => {
    try {
      return recorder?.startPhase(name) ?? noopSpan;
    } catch {
      return noopSpan;
    }
  };
  const classification = safeStartPhase('classification');
  let classificationFinished = false;
  let finalized = false;

  const finishClassification = (
    outcome: RuntimePerformanceOutcome = 'ok',
  ): void => {
    if (classificationFinished) return;
    classificationFinished = true;
    try {
      classification.end(outcome);
    } catch {
      // Runtime performance is internal observability only.
    }
  };
  const startPhase = (name: RuntimePhaseName): RuntimePerformanceSpan => {
    const span = safeStartPhase(name);
    let ended = false;
    return {
      end: (outcome: RuntimePerformanceOutcome = 'ok') => {
        if (ended) return;
        ended = true;
        try {
          span.end(outcome);
        } catch {
          // Runtime performance is internal observability only.
        }
      },
    };
  };

  return {
    finishClassification,
    startPhase,
    startModelCall: input => startRuntimeModelCall(recorder, input),
    recordSceneEvidence: input => {
      try { recorder?.recordSceneEvidence(input); } catch { /* Internal observability only. */ }
    },
    recordFirstOutput: () => {
      try {
        recorder?.recordFirstOutput();
      } catch {
        // Runtime performance is internal observability only.
      }
    },
    finalize: (outcome: RuntimePerformanceOutcome = 'ok') => {
      if (finalized) return;
      finalized = true;
      finishClassification(outcome);
    },
  };
}

export function runtimeOutcomeFromError(
  error: unknown,
  signal?: AbortSignal,
): RuntimePerformanceOutcome {
  if (signal?.aborted) return 'cancelled';
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /abort|cancel/i.test(`${name} ${message}`) ? 'cancelled' : 'error';
}
