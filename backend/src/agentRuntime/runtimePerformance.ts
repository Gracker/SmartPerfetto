// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {performance as nodePerformance} from 'perf_hooks';

import {immutableCanonicalSnapshot} from '../services/selfEvolution/canonicalJson';
import {isPlainObject} from '../utils/llmJson';
import type {RuntimeToolConcurrencyFallbackReason} from './runtimeToolConcurrency';
import {isSceneEntryNotRunReason, type RuntimePerformanceSceneEvidenceReceiptV1} from '../types/sceneEntryEvidence';

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
export type RuntimeModelCallReasoning = 'provider_default' | 'disabled';

/** Provider-reported token counts, copied only when the provider returns them. */
export interface RuntimeModelCallUsageV1 {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface RuntimePerformanceModelCallReceiptV1 {
  purpose: RuntimeModelCallPurpose;
  trigger?: RuntimeModelCallTrigger;
  /** Model the provider reported, else the one requested. Internal receipt only. */
  model?: string;
  reasoning?: RuntimeModelCallReasoning;
  startOffsetMs: number;
  durationMs: number;
  /** Time from this call's dispatch to its first provider output, when the stream exposes it. */
  firstOutputMs?: number;
  outcome: RuntimePerformanceOutcome;
  /** Visible body vs machine declaration characters of the text this call produced. */
  output?: {bodyChars: number; sidecarChars: number};
  usage?: RuntimeModelCallUsageV1;
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

export interface RuntimePerformanceReceiptV1 {
  schemaVersion: 1;
  firstOutputMs?: number;
  phases: RuntimePerformancePhaseReceiptV1[];
  tools: RuntimePerformanceToolReceiptV1[];
  sql: RuntimePerformanceSqlReceiptV1[];
  /** Absent in receipts recorded before per-call records existed. */
  modelCalls?: RuntimePerformanceModelCallReceiptV1[];
  finalReview?: RuntimePerformanceFinalReviewReceiptV1;
  /** The run's product-owned scene entry evidence attempt; never a model tool call. */
  sceneEvidence?: RuntimePerformanceSceneEvidenceReceiptV1;
  truncated?: {
    phases: number;
    tools: number;
    sql: number;
    modelCalls?: number;
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
}

export interface RuntimeModelCallEnd {
  outcome?: RuntimePerformanceOutcome;
  /** Replaces the requested model when the provider reported the one it used. */
  model?: string;
  /** Request-side reasoning control, when only the transport knows it. */
  reasoning?: RuntimeModelCallReasoning;
  output?: {bodyChars: number; sidecarChars: number};
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
  maxHashInputBytes?: number;
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

interface RuntimePerformanceSink {
  readonly runtimePerformanceRecorder?: RuntimePerformanceRecorder;
}

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
  private readonly maxHashInputBytes: number;
  private readonly startedAt: number;
  private lastOffsetMs = 0;
  private firstOutputMs: number | undefined;
  private readonly phases: RuntimePerformancePhaseReceiptV1[] = [];
  private readonly tools: RuntimePerformanceToolReceiptV1[] = [];
  private readonly sql: RuntimePerformanceSqlReceiptV1[] = [];
  private readonly modelCalls: RuntimePerformanceModelCallReceiptV1[] = [];
  private finalReview: RuntimePerformanceFinalReviewReceiptV1 | undefined;
  private sceneEvidence: RuntimePerformanceSceneEvidenceReceiptV1 | undefined;
  private nextToolSequence = 0;
  private readonly truncated = {
    phases: 0,
    tools: 0,
    sql: 0,
    modelCalls: 0,
  };
  private sealedReceipt: RuntimePerformanceReceiptV1 | undefined;

  constructor(options: RuntimePerformanceRecorderOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.hashSalt = options.hashSalt ?? '';
    this.maxPhases = positiveCap(options.maxPhases, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxTools = positiveCap(options.maxTools, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxSql = positiveCap(options.maxSql, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxModelCalls = positiveCap(options.maxModelCalls, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxHashInputBytes = positiveCap(
      options.maxHashInputBytes,
      DEFAULT_MAX_HASH_INPUT_BYTES,
    );
    this.startedAt = this.now();
  }

  get hasRecordedData(): boolean {
    return (
      this.firstOutputMs !== undefined
      || this.phases.length > 0
      || this.tools.length > 0
      || this.sql.length > 0
      || this.modelCalls.length > 0
      || this.finalReview !== undefined
      || this.sceneEvidence !== undefined
      || this.truncated.phases > 0
      || this.truncated.tools > 0
      || this.truncated.sql > 0
      || this.truncated.modelCalls > 0
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

  startModelCall(input: RuntimeModelCallStart): RuntimeModelCallSpan {
    this.assertCollecting('start_model_call');
    const startOffsetMs = this.offsetMs();
    let firstOutputMs: number | undefined;
    let doneOffsetMs: number | undefined;
    let doneUsage: unknown;
    let ended = false;
    return {
      recordFirstOutput: () => {
        if (ended || firstOutputMs !== undefined || doneOffsetMs !== undefined) return;
        firstOutputMs = this.offsetMs() - startOffsetMs;
      },
      markDone: usage => {
        if (ended || doneOffsetMs !== undefined) return;
        doneOffsetMs = this.offsetMs();
        doneUsage = usage;
      },
      end: (end = {}) => {
        if (ended || this.sealedReceipt) return;
        ended = true;
        const model = boundedModelName(end.model) ?? boundedModelName(input.model);
        const usage = normalizeModelCallUsage(end.usage ?? doneUsage);
        const output = end.output && Number.isSafeInteger(end.output.bodyChars) && end.output.bodyChars >= 0 &&
          Number.isSafeInteger(end.output.sidecarChars) && end.output.sidecarChars >= 0
          ? {bodyChars: end.output.bodyChars, sidecarChars: end.output.sidecarChars} : undefined;
        this.pushCapped('modelCalls', this.maxModelCalls, this.modelCalls, {
          purpose: input.purpose,
          ...(input.trigger ? {trigger: input.trigger} : {}),
          ...(model ? {model} : {}),
          ...(end.reasoning ?? input.reasoning ? {reasoning: end.reasoning ?? input.reasoning} : {}),
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
    const receipt: RuntimePerformanceReceiptV1 = {
      schemaVersion: 1,
      ...(this.firstOutputMs !== undefined
        ? {firstOutputMs: this.firstOutputMs}
        : {}),
      phases: [...this.phases],
      tools: [...this.tools],
      sql: [...this.sql],
      ...(this.modelCalls.length > 0 ? {modelCalls: [...this.modelCalls]} : {}),
      ...(this.finalReview ? {finalReview: this.finalReview} : {}),
      ...(this.sceneEvidence ? {sceneEvidence: this.sceneEvidence} : {}),
      ...(this.truncated.phases > 0
        || this.truncated.tools > 0
        || this.truncated.sql > 0
        || this.truncated.modelCalls > 0
        ? {truncated: {
          phases: this.truncated.phases,
          tools: this.truncated.tools,
          sql: this.truncated.sql,
          ...(this.truncated.modelCalls > 0 ? {modelCalls: this.truncated.modelCalls} : {}),
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
    if (!this.sealedReceipt) return;
    throw new Error(`runtime_performance_already_sealed:${operation}`);
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
    span = recorder?.startModelCall(input) ?? noopModelCallSpan;
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

/** Record the finalizer's review decision on an optional recorder; never throws. */
export function recordRuntimeFinalReview(
  recorder: RuntimePerformanceRecorder | undefined,
  input: RuntimePerformanceFinalReviewReceiptV1,
): void {
  try { recorder?.recordFinalReview(input); } catch { /* Internal observability only. */ }
}

export function createRuntimePerformanceRun(
  sink?: RuntimePerformanceSink,
): RuntimePerformanceRun {
  const recorder = sink?.runtimePerformanceRecorder;
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
