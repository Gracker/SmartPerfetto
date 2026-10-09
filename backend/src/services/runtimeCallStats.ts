// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Observed durations of delivery calls (review, declaration repair,
 * continuation), so a call that cannot finish in the time left is not sent.
 *
 * Durable server runs append each sealed RunManifest's model calls to an
 * append-only JSONL journal under the user data directory; one short line per
 * call, written with O_APPEND, so concurrent writers never interleave a line.
 * Reads compact the journal into a p75 snapshot written by temporary file plus
 * rename. Everything here is an estimator: a missing, unreadable or torn file
 * falls back to fixed per-provider defaults and is recorded as a closed
 * diagnostic, never as an error of the run. The CLI keeps no durable manifest
 * and therefore never aggregates; it always uses the defaults.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  RUNTIME_MODEL_CALL_INPUT_BYTES_BUCKETS,
  RUNTIME_MODEL_CALL_PURPOSES,
  runtimeModelCallInputBytesBucket,
  runtimeProviderOrigin,
  type RuntimeModelCallInputBytesBucket,
  type RuntimeModelCallPurpose,
  recordRuntimeDeliveryBudget,
  type RuntimePerformanceDeliveryBudgetReceiptV1,
  type RuntimePerformanceModelCallReceiptV1,
  type RuntimePerformanceRecorder,
} from '../agentRuntime/runtimePerformance';
import {atomicWriteFileSync} from '../utils/atomicFileWriter';
import {tryParseStoredJson} from '../utils/storedData';
import {getSelfEvolutionLifecycleSnapshot} from './selfEvolution/selfEvolutionLifecycle';
import type {RunManifestV1} from '../types/selfEvolution';

export const RUNTIME_CALL_STATS_JOURNAL = 'runtime-call-stats.jsonl';
export const RUNTIME_CALL_STATS_SNAPSHOT = 'runtime-call-stats.json';

const ENTRY_SCHEMA = 'runtime_call_stats_entry@1';
const SNAPSHOT_SCHEMA = 'runtime_call_stats_snapshot@1';
/** Recent successful samples kept per key; older ones age out. */
const MAX_SAMPLES_PER_KEY = 64;
/** Fewer successful samples than this is no estimate. */
const MIN_SAMPLES = 3;
/** The live journal rotates to `.1` above this size, bounding both files. */
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_CHARS = 128;

/** Delivery purposes whose durations are estimated; classification and answer turns are not. */
const ESTIMATED_PURPOSES: ReadonlySet<RuntimeModelCallPurpose> = new Set(['review', 'declaration_repair', 'continuation']);

const GLM_ORIGINS = new Set(['https://open.bigmodel.cn', 'https://api.z.ai']);

/**
 * Fixed estimates without samples, per provider family. A GLM review took
 * minutes with default thinking; DeepSeek about two; Anthropic and unknown
 * providers are given the shorter default.
 */
export function defaultDeliveryCallEstimateMs(providerOrigin: string | undefined): number {
  if (providerOrigin && GLM_ORIGINS.has(providerOrigin)) return 180_000;
  if (providerOrigin === 'https://api.deepseek.com') return 120_000;
  return 90_000;
}

export interface RuntimeCallStatsKey {
  providerOrigin: string;
  model: string;
  purpose: RuntimeModelCallPurpose;
  inputBytesBucket: RuntimeModelCallInputBytesBucket;
}

interface JournalEntry extends RuntimeCallStatsKey {
  schemaVersion: typeof ENTRY_SCHEMA;
  durationMs: number;
}

interface SnapshotEntry extends RuntimeCallStatsKey {
  p75Ms: number;
  samples: number;
}

interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA;
  /** Sizes and modification times of the journal files the snapshot summarizes. */
  source: string;
  entries: SnapshotEntry[];
}

export interface RuntimeCallStatsEstimate {
  p75Ms?: number;
  diagnostic?: 'stats_unreadable' | 'no_samples';
}

function keyOf(key: RuntimeCallStatsKey): string {
  return [key.providerOrigin, key.model, key.purpose, key.inputBytesBucket].join('\u0000');
}

function boundedModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed && trimmed.length <= MAX_MODEL_CHARS ? trimmed : undefined;
}

function readKey(value: Record<string, unknown>): RuntimeCallStatsKey | undefined {
  const providerOrigin = runtimeProviderOrigin(value.providerOrigin);
  const model = boundedModel(value.model);
  const purpose = value.purpose;
  const bucket = value.inputBytesBucket;
  if (!providerOrigin || providerOrigin !== value.providerOrigin || !model ||
    !(RUNTIME_MODEL_CALL_PURPOSES as readonly unknown[]).includes(purpose) ||
    !(RUNTIME_MODEL_CALL_INPUT_BYTES_BUCKETS as readonly unknown[]).includes(bucket)) return undefined;
  return {providerOrigin, model, purpose: purpose as RuntimeModelCallPurpose,
    inputBytesBucket: bucket as RuntimeModelCallInputBytesBucket};
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonnegativeMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Nearest-rank 75th percentile. */
function p75(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.75) - 1)]!;
}

export class RuntimeCallStatsStore {
  private readonly journalPath: string;
  private readonly rotatedPath: string;
  private readonly snapshotPath: string;
  private cached: {source: string; entries: Map<string, SnapshotEntry>; unreadable: boolean} | undefined;

  private readonly maxJournalBytes: number;

  constructor(readonly directory: string, options: {maxJournalBytes?: number} = {}) {
    this.maxJournalBytes = options.maxJournalBytes ?? MAX_JOURNAL_BYTES;
    this.journalPath = path.join(directory, RUNTIME_CALL_STATS_JOURNAL);
    this.rotatedPath = `${this.journalPath}.1`;
    this.snapshotPath = path.join(directory, RUNTIME_CALL_STATS_SNAPSHOT);
  }

  /**
   * Append the delivery calls of one sealed run. Only completed calls with a
   * known provider origin, model and input size are samples; a cancelled or
   * failed call says nothing about how long a successful one takes.
   */
  appendModelCalls(calls: readonly RuntimePerformanceModelCallReceiptV1[]): number {
    const lines: string[] = [];
    for (const call of calls) {
      if (call.outcome !== 'ok' || !ESTIMATED_PURPOSES.has(call.purpose)) continue;
      const key = readKey(call as unknown as Record<string, unknown>);
      const durationMs = nonnegativeMs(call.durationMs);
      if (!key || durationMs === undefined) continue;
      const entry: JournalEntry = {schemaVersion: ENTRY_SCHEMA, ...key, durationMs};
      lines.push(JSON.stringify(entry));
    }
    if (lines.length === 0) return 0;
    fs.mkdirSync(this.directory, {recursive: true});
    try {
      if (fs.statSync(this.journalPath).size > this.maxJournalBytes) fs.renameSync(this.journalPath, this.rotatedPath);
    } catch { /* No journal yet, or another writer rotated it first. */ }
    // One write of whole lines with O_APPEND; each line is far below PIPE_BUF. A line a
    // crashed writer left without its newline is closed first, so it stays the only torn one.
    const prefix = this.journalEndsMidLine() ? '\n' : '';
    fs.appendFileSync(this.journalPath, `${prefix}${lines.join('\n')}\n`, {encoding: 'utf8', flag: 'a'});
    return lines.length;
  }

  private journalEndsMidLine(): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.journalPath, 'r');
      const size = fs.fstatSync(fd).size;
      if (size === 0) return false;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } catch { return false; } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  estimate(key: RuntimeCallStatsKey): RuntimeCallStatsEstimate {
    const state = this.load();
    const entry = state.entries.get(keyOf(key));
    if (entry && entry.samples >= MIN_SAMPLES) return {p75Ms: entry.p75Ms};
    return {diagnostic: state.unreadable && !entry ? 'stats_unreadable' : 'no_samples'};
  }

  private sourceIdentity(): string {
    return [this.rotatedPath, this.journalPath].map(file => {
      try {
        const stat = fs.statSync(file);
        return `${stat.size}:${stat.mtimeMs}`;
      } catch { return '-'; }
    }).join('|');
  }

  private load(): {entries: Map<string, SnapshotEntry>; unreadable: boolean} {
    const source = this.sourceIdentity();
    if (this.cached?.source === source) return this.cached;
    const snapshot = this.readSnapshot();
    if (snapshot?.source === source) {
      this.cached = {source, unreadable: false,
        entries: new Map(snapshot.entries.map(entry => [keyOf(entry), entry]))};
      return this.cached;
    }
    const compacted = this.compact(source);
    this.cached = compacted;
    return compacted;
  }

  private readSnapshot(): Snapshot | undefined {
    let text: string;
    try { text = fs.readFileSync(this.snapshotPath, 'utf8'); } catch { return undefined; }
    const parsed = tryParseStoredJson(text, 'runtime call stats snapshot');
    const value = parsed.ok ? record(parsed.value) : undefined;
    if (!value || value.schemaVersion !== SNAPSHOT_SCHEMA || typeof value.source !== 'string' ||
      !Array.isArray(value.entries)) return undefined;
    const entries: SnapshotEntry[] = [];
    for (const raw of value.entries) {
      const item = record(raw);
      const key = item && readKey(item);
      const p75Ms = item && nonnegativeMs(item.p75Ms);
      const samples = item && nonnegativeMs(item.samples);
      if (!key || p75Ms === undefined || samples === undefined) return undefined;
      entries.push({...key, p75Ms, samples});
    }
    return {schemaVersion: SNAPSHOT_SCHEMA, source: value.source, entries};
  }

  /** Recompute the snapshot from the journal files; a torn line is skipped, never fatal. */
  private compact(source: string): {source: string; entries: Map<string, SnapshotEntry>; unreadable: boolean} {
    const samples = new Map<string, {key: RuntimeCallStatsKey; values: number[]}>();
    let readable = 0;
    let unreadable = 0;
    for (const file of [this.rotatedPath, this.journalPath]) {
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable++;
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const parsed = tryParseStoredJson(line, 'runtime call stats journal');
        const value = parsed.ok ? record(parsed.value) : undefined;
        const key = value?.schemaVersion === ENTRY_SCHEMA ? readKey(value) : undefined;
        const durationMs = value ? nonnegativeMs(value.durationMs) : undefined;
        if (!key || durationMs === undefined) { unreadable++; continue; }
        readable++;
        const bucket = samples.get(keyOf(key)) ?? {key, values: []};
        bucket.values.push(durationMs);
        if (bucket.values.length > MAX_SAMPLES_PER_KEY) bucket.values.shift();
        samples.set(keyOf(key), bucket);
      }
    }
    const entries = new Map<string, SnapshotEntry>();
    for (const [id, {key, values}] of samples) entries.set(id, {...key, p75Ms: p75(values), samples: values.length});
    if (readable > 0) {
      const snapshot: Snapshot = {schemaVersion: SNAPSHOT_SCHEMA, source, entries: [...entries.values()]};
      try { atomicWriteFileSync(this.snapshotPath, JSON.stringify(snapshot)); } catch { /* The estimate stands without it. */ }
    }
    return {source, entries, unreadable: unreadable > 0 && readable === 0};
  }
}

let durableStore: RuntimeCallStatsStore | undefined;

/**
 * The store of a durable server process, or none. Aggregation follows
 * RunManifest persistence: without an available persistent user data root
 * (the CLI, tests, a read-only package) nothing is written or read.
 */
export function durableRuntimeCallStatsStore(): RuntimeCallStatsStore | undefined {
  const persistence = getSelfEvolutionLifecycleSnapshot().persistence;
  if (persistence.persistence !== 'available' || !persistence.dataRoot) return undefined;
  if (durableStore?.directory !== persistence.dataRoot) durableStore = new RuntimeCallStatsStore(persistence.dataRoot);
  return durableStore;
}

/** Seal observer for durable RunManifests; observability never fails the run. */
export function recordRuntimeCallStatsFromManifest(
  manifest: Pick<RunManifestV1, 'performance'>,
  store: RuntimeCallStatsStore | undefined = durableRuntimeCallStatsStore(),
): void {
  if (!store || !manifest.performance?.modelCalls?.length) return;
  try { store.appendModelCalls(manifest.performance.modelCalls); } catch { /* Stats are an estimator only. */ }
}

export interface DeliveryCallBudgetInput {
  providerOrigin?: string;
  model?: string;
  purpose: RuntimeModelCallPurpose;
  inputBytes: number;
  remainingMs: number;
  /**
   * A report deliverable is dispatched whatever the estimate: its quality gate
   * fails without the call, so the deadline, not the estimate, bounds it.
   */
  failOpen?: boolean;
  /** Defaults to the durable server store; `null` means stats are not configured (CLI). */
  store?: RuntimeCallStatsStore | null;
}

export type DeliveryCallBudget = RuntimePerformanceDeliveryBudgetReceiptV1;

/**
 * Decide whether one delivery call is worth sending: compare the time left
 * with the p75 duration observed for the same provider origin, model, purpose
 * and input size, else a fixed per-provider default.
 */
export function assessDeliveryCallBudget(input: DeliveryCallBudgetInput): DeliveryCallBudget {
  const providerOrigin = runtimeProviderOrigin(input.providerOrigin);
  const model = boundedModel(input.model);
  const inputBytesBucket = runtimeModelCallInputBytesBucket(input.inputBytes);
  const store = input.store === null ? undefined : input.store ?? durableRuntimeCallStatsStore();
  let estimate: RuntimeCallStatsEstimate = {diagnostic: 'no_samples'};
  if (store && providerOrigin && model && inputBytesBucket) {
    try {
      estimate = store.estimate({providerOrigin, model, purpose: input.purpose, inputBytesBucket});
    } catch {
      estimate = {diagnostic: 'stats_unreadable'};
    }
  }
  const source = estimate.p75Ms !== undefined ? 'stats' : 'default';
  const estimateMs = estimate.p75Ms ?? defaultDeliveryCallEstimateMs(providerOrigin);
  const remainingMs = Number.isFinite(input.remainingMs) ? Math.max(0, Math.round(input.remainingMs)) : 0;
  const diagnostic = source === 'stats' ? undefined : !store ? 'stats_not_configured' : estimate.diagnostic ?? 'no_samples';
  return {purpose: input.purpose, decision: input.failOpen || remainingMs >= estimateMs ? 'dispatch' : 'skip',
    source, estimateMs, remainingMs, ...(diagnostic ? {diagnostic} : {})};
}

/**
 * Whether a delivery call is sent whatever its estimate, bounded only by the
 * deadline: a report's quality gate fails without its calls, and a
 * continuation of a candidate with no answer body is the only way the user
 * gets an answer at all. Skipping either would save time only by guaranteeing
 * the worse outcome.
 */
export function deliveryCallFailsOpen(
  intent: {status?: string; deliverable?: string} | undefined,
  options: {bodyMissing?: boolean} = {},
): boolean {
  return intent?.status === 'resolved' && intent.deliverable === 'report' || options.bodyMissing === true;
}

/**
 * The runtime-side admission of one repair or continuation call: assess its
 * budget, record the decision on the run's receipt, and answer whether to send it.
 */
export function admitDeliveryCall(
  recorder: RuntimePerformanceRecorder | undefined,
  input: DeliveryCallBudgetInput,
): boolean {
  let budget: DeliveryCallBudget;
  try { budget = assessDeliveryCallBudget(input); } catch { return true; }
  recordRuntimeDeliveryBudget(recorder, budget);
  return budget.decision === 'dispatch';
}
