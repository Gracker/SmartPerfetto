// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {performance as nodePerformance} from 'perf_hooks';

import {immutableCanonicalSnapshot} from '../services/selfEvolution/canonicalJson';
import type {RuntimeToolConcurrencyFallbackReason} from './runtimeToolConcurrency';

export type RuntimePhaseName =
  | 'classification'
  | 'quick_evidence'
  | 'focus'
  | 'architecture'
  | 'completeness'
  | 'comparison'
  | 'skill_registry'
  | 'knowledge'
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

export interface RuntimePerformanceReceiptV1 {
  schemaVersion: 1;
  firstOutputMs?: number;
  phases: RuntimePerformancePhaseReceiptV1[];
  tools: RuntimePerformanceToolReceiptV1[];
  sql: RuntimePerformanceSqlReceiptV1[];
  truncated?: {
    phases: number;
    tools: number;
    sql: number;
  };
}

type RuntimePerformanceTruncationBucket = 'phases' | 'tools' | 'sql';

export interface RuntimePerformanceSpan {
  end(outcome?: RuntimePerformanceOutcome): void;
}

export interface RuntimePerformanceRecorderOptions {
  now?: () => number;
  hashSalt?: string;
  maxPhases?: number;
  maxTools?: number;
  maxSql?: number;
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
  private readonly maxHashInputBytes: number;
  private readonly startedAt: number;
  private lastOffsetMs = 0;
  private firstOutputMs: number | undefined;
  private readonly phases: RuntimePerformancePhaseReceiptV1[] = [];
  private readonly tools: RuntimePerformanceToolReceiptV1[] = [];
  private readonly sql: RuntimePerformanceSqlReceiptV1[] = [];
  private nextToolSequence = 0;
  private readonly truncated = {
    phases: 0,
    tools: 0,
    sql: 0,
  };
  private sealedReceipt: RuntimePerformanceReceiptV1 | undefined;

  constructor(options: RuntimePerformanceRecorderOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.hashSalt = options.hashSalt ?? '';
    this.maxPhases = positiveCap(options.maxPhases, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxTools = positiveCap(options.maxTools, DEFAULT_MAX_RECEIPT_ITEMS);
    this.maxSql = positiveCap(options.maxSql, DEFAULT_MAX_RECEIPT_ITEMS);
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
      || this.truncated.phases > 0
      || this.truncated.tools > 0
      || this.truncated.sql > 0
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
      ...(this.truncated.phases > 0
        || this.truncated.tools > 0
        || this.truncated.sql > 0
        ? {truncated: {...this.truncated}}
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
  recordFirstOutput(): void;
  finalize(outcome?: RuntimePerformanceOutcome): void;
}

const noopSpan: RuntimePerformanceSpan = {end: () => undefined};

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
