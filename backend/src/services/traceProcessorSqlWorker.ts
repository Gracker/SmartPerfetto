// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import path from 'path';
import {performance as nodePerformance} from 'perf_hooks';
import { Worker } from 'worker_threads';
import { traceProcessorConfig } from '../config';
import type {
  RuntimePerformanceOutcome,
  RuntimePerformanceRecorder,
} from '../agentRuntime/runtimePerformance';
import {
  decodeQueryResult,
  encodeQueryArgs,
} from './traceProcessorProtobuf';
import {
  executeTraceProcessorHttpRpcRaw,
  type TraceProcessorHttpRpcRequest,
} from './traceProcessorHttpRpcClient';
import {
  createTraceProcessorQueryCancelledError,
  isTraceProcessorQueryCancelledError,
  raceWithTraceProcessorCancellation,
  throwIfTraceProcessorQueryCancelled,
} from './traceProcessorCancellation';
import type { QueryResult } from './workingTraceProcessor';
import {currentRuntimePerformanceRecorder} from './selfEvolution/runManifestLifecycle';
import {beginRawSqlNativeQuery, invalidateRawSqlNativeProvenance, sealRawSqlNativeQuery,
  type RawSqlBootstrapCapability, type RawSqlNativeProvenance, type RawSqlNativeQuery} from './evidence/rawSqlNativeProvenance';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

export type TraceProcessorQueryPriority = 'p0' | 'p1' | 'p2';

export interface TraceProcessorQueryOptions {
  priority?: TraceProcessorQueryPriority;
  timeoutMs?: number;
  suppressErrorLog?: boolean;
  signal?: AbortSignal;
}

export interface TraceProcessorBoundedQueryOptions
  extends TraceProcessorQueryOptions {
  maxResponseBytes: number;
  maxRows: number;
}

export interface TraceProcessorSqlWorkerOptions {
  processorId: string;
  traceId: string;
  processorKey?: string;
  port: number;
  hostname?: string;
  forceInline?: boolean;
  rawExecutor?: (request: TraceProcessorHttpRpcRequest) => Promise<Buffer>;
  maxQueuedTasks?: number;
  maxQueuedBytes?: number;
  nativeProvenance?: RawSqlNativeProvenance;
}

interface SqlTaskOrigin {
  sql: string;
  bootstrapCapability?: RawSqlBootstrapCapability;
  decode: (body: Buffer, query: RawSqlNativeQuery | undefined) => void;
}

interface QueueTask {
  id: number;
  body: Buffer;
  priority: TraceProcessorQueryPriority;
  timeoutMs: number;
  deadlineAt: number;
  queueTimer?: NodeJS.Timeout;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  queuedAtMs: number;
  runtimePerformanceRecorder?: RuntimePerformanceRecorder;
  runtimePerformanceRecorded?: boolean;
  sqlOrigin?: SqlTaskOrigin;
  onAbort?: () => void;
  resolve: (body: Buffer) => void;
  reject: (error: Error) => void;
}

interface PendingWorkerRequest {
  resolve: (body: Buffer) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const PRIORITY_ORDER: TraceProcessorQueryPriority[] = ['p0', 'p1', 'p2'];
const DEFAULT_MAX_QUEUED_TASKS = 256;
const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export class TraceProcessorSqlQueueOverloadedError extends Error {
  readonly code = 'TRACE_PROCESSOR_SQL_QUEUE_OVERLOADED';
  constructor(message: string) {
    super(message);
    this.name = 'TraceProcessorSqlQueueOverloadedError';
  }
}

export class TraceProcessorSqlDeadlineExceededError extends Error {
  readonly code = 'TRACE_PROCESSOR_SQL_DEADLINE_EXCEEDED';
  constructor() {
    super('Trace processor SQL query deadline exceeded while queued');
    this.name = 'TraceProcessorSqlDeadlineExceededError';
  }
}

export function normalizeTraceProcessorQueryPriority(
  value: unknown,
  fallback: TraceProcessorQueryPriority = 'p1',
): TraceProcessorQueryPriority {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['p0', 'frontend', 'interactive', 'user'].includes(normalized)) return 'p0';
  if (['p1', 'agent', 'analysis', 'normal'].includes(normalized)) return 'p1';
  if (['p2', 'report', 'batch', 'heavy', 'background'].includes(normalized)) return 'p2';
  return fallback;
}

function resolveWorkerThreadPath(): {
  filename: string;
  execArgv: string[];
  eval?: boolean;
  workerData?: {loaderPath: string; entryPath: string};
} {
  const jsPath = path.join(__dirname, 'traceProcessorSqlWorkerThread.js');
  if (fs.existsSync(jsPath)) {
    return { filename: jsPath, execArgv: [] };
  }

  return {
    // An ESM preload can make Node treat a .ts worker entry as ESM before the
    // tsx CJS hook sees it. Bootstrap as CJS and explicitly require the entry.
    // Resolve loader paths in the parent; data never becomes executable text.
    filename: 'const {workerData} = require("node:worker_threads"); require(workerData.loaderPath); require(workerData.entryPath);',
    execArgv: [],
    eval: true,
    workerData: {
      loaderPath: require.resolve('tsx/cjs'),
      entryPath: path.join(__dirname, 'traceProcessorSqlWorkerThread.ts'),
    },
  };
}


/**
 * Turn trace_processor's SQL error into the sentence it is trying to say.
 *
 * It reports failures in a Python-shaped traceback whose only frame is
 * `File "stdin"`, so the reader gets four lines of scaffolding around one line
 * of meaning:
 *
 *   Traceback (most recent call last):
 *     File "stdin" line 1 col 1
 *       select bogus from nowhere
 *       ^
 *   no such table: nowhere
 *
 * The header promises a call stack that does not exist, and `smp query` was
 * printing the whole thing verbatim. Keep the diagnosis and the position, drop
 * the scaffolding; anything that does not match this shape is passed through
 * untouched, because trace_processor also emits plain single-line errors.
 */
export function normalizeTraceProcessorSqlError(raw: string): string {
  const text = raw?.trim();
  if (!text || !text.startsWith('Traceback (most recent call last):')) return raw;

  const lines = text.split('\n');
  const diagnosis = lines[lines.length - 1]?.trim();
  if (!diagnosis) return raw;

  const position = lines
    .map(line => /File\s+"[^"]*"\s+line\s+(\d+)\s+col\s+(\d+)/.exec(line))
    .find((match): match is RegExpExecArray => match !== null);

  return position ? `${diagnosis} (line ${position[1]}, col ${position[2]})` : diagnosis;
}

/** What a trace_processor SQL failure says about the schema it ran against. */
export type TraceProcessorSqlErrorKind = 'unknown_module' | 'missing_table' | 'missing_column' | 'other';

/**
 * The kind of a trace_processor SQL error, from its diagnosis line: the stdlib
 * lacks the module, the schema lacks a table, a column or function does not
 * exist, or anything else. The one place these messages are read.
 */
export function classifyTraceProcessorSqlError(message: string): TraceProcessorSqlErrorKind {
  if (/unknown module/i.test(message)) return 'unknown_module';
  if (/no such table/i.test(message)) return 'missing_table';
  if (/no such column|no such function/i.test(message)) return 'missing_column';
  return 'other';
}

export class TraceProcessorSqlWorker {
  private readonly processorId: string;
  private readonly processorKey: string;
  private readonly port: number;
  private readonly hostname: string;
  private readonly forceInline: boolean;
  private readonly rawExecutor?: (request: TraceProcessorHttpRpcRequest) => Promise<Buffer>;
  private readonly maxQueuedTasks: number;
  private readonly maxQueuedBytes: number;
  private readonly nativeProvenance?: RawSqlNativeProvenance;
  private readonly queues: Record<TraceProcessorQueryPriority, QueueTask[]> = {
    p0: [],
    p1: [],
    p2: [],
  };
  private pendingWorkerRequests = new Map<number, PendingWorkerRequest>();
  private worker: Worker | null = null;
  private running = false;
  private destroyed = false;
  private nextTaskId = 1;
  private queuedBytes = 0;

  constructor(options: TraceProcessorSqlWorkerOptions) {
    this.processorId = options.processorId;
    this.processorKey = options.processorKey ?? options.traceId;
    this.port = options.port;
    this.hostname = options.hostname || '127.0.0.1';
    this.forceInline = options.forceInline ?? IS_TEST_ENV;
    this.rawExecutor = options.rawExecutor;
    this.maxQueuedTasks = Math.max(1, options.maxQueuedTasks ?? DEFAULT_MAX_QUEUED_TASKS);
    this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);
    this.nativeProvenance = options.nativeProvenance;
  }

  get activeCount(): number {
    return (this.running ? 1 : 0) + this.queues.p0.length + this.queues.p1.length + this.queues.p2.length;
  }

  getStats(): {
    running: boolean;
    queuedP0: number;
    queuedP1: number;
    queuedP2: number;
    usesWorkerThread: boolean;
    queuedBytes: number;
  } {
    return {
      running: this.running,
      queuedP0: this.queues.p0.length,
      queuedP1: this.queues.p1.length,
      queuedP2: this.queues.p2.length,
      usesWorkerThread: !this.forceInline && !this.rawExecutor,
      queuedBytes: this.queuedBytes,
    };
  }

  async query(sql: string, options: TraceProcessorQueryOptions = {}): Promise<QueryResult> {
    return this.querySql(sql, options);
  }

  queryBootstrap(sql: string, capability: RawSqlBootstrapCapability, options: TraceProcessorQueryOptions = {}): Promise<QueryResult> {
    return this.querySql(sql, options, capability);
  }

  private async querySql(sql: string, options: TraceProcessorQueryOptions, bootstrapCapability?: RawSqlBootstrapCapability): Promise<QueryResult> {
    const startTime = Date.now();
    try {
      let result!: QueryResult;
      await this.enqueueRawInternal(encodeQueryArgs(sql), options, {sql, bootstrapCapability, decode: (response, query) => {
        const parsed = decodeQueryResult(response);
        result = {columns: parsed.columnNames, rows: parsed.rows, durationMs: Date.now() - startTime,
          ...(parsed.error ? {error: normalizeTraceProcessorSqlError(parsed.error)} : {})};
        sealRawSqlNativeQuery(query, result);
      }});
      return result;
    } catch (error: any) {
      if (isTraceProcessorQueryCancelledError(error)) {
        throw error;
      }
      return {
        columns: [],
        rows: [],
        durationMs: Date.now() - startTime,
        error: error?.message || String(error),
      };
    }
  }

  async queryBounded(
    sql: string,
    options: TraceProcessorBoundedQueryOptions,
  ): Promise<QueryResult> {
    const startTime = Date.now();
    try {
      if (
        !Number.isSafeInteger(options.maxResponseBytes)
        || options.maxResponseBytes < 0
        || !Number.isSafeInteger(options.maxRows)
        || options.maxRows < 0
      ) {
        throw new Error('trace_processor_query_budget_invalid');
      }
      let result!: QueryResult;
      await this.enqueueRawInternal(
        encodeQueryArgs(sql),
        options,
        {sql, decode: (response, query) => {
          const parsed = decodeQueryResult(response, {maxRows: options.maxRows});
          result = {columns: parsed.columnNames, rows: parsed.rows, durationMs: Date.now() - startTime,
            ...(parsed.error ? {error: parsed.error} : {})};
          sealRawSqlNativeQuery(query, result);
        }},
      );
      return result;
    } catch (error: any) {
      if (isTraceProcessorQueryCancelledError(error)) throw error;
      return {
        columns: [],
        rows: [],
        durationMs: Date.now() - startTime,
        error: error?.message || String(error),
      };
    }
  }

  enqueueRaw(body: Buffer, options: TraceProcessorQueryOptions = {}): Promise<Buffer> {
    if (this.nativeProvenance) invalidateRawSqlNativeProvenance(this.nativeProvenance);
    return this.enqueueRawInternal(body, options);
  }

  private enqueueRawInternal(
    body: Buffer,
    options: TraceProcessorQueryOptions & {maxResponseBytes?: number},
    sqlOrigin?: SqlTaskOrigin,
  ): Promise<Buffer> {
    if (this.destroyed) {
      return Promise.reject(new Error(`SQL worker for processor ${this.processorId} is destroyed`));
    }
    try {
      throwIfTraceProcessorQueryCancelled(options.signal);
    } catch (error) {
      return Promise.reject(error);
    }

    const priority = normalizeTraceProcessorQueryPriority(options.priority);
    const timeoutMs = options.timeoutMs ?? traceProcessorConfig.queryTimeoutMs;
    const queuedTaskCount = this.activeCount - (this.running ? 1 : 0);
    if (queuedTaskCount >= this.maxQueuedTasks || this.queuedBytes + body.byteLength > this.maxQueuedBytes) {
      return Promise.reject(new TraceProcessorSqlQueueOverloadedError(
        `SQL queue capacity exceeded for processor ${this.processorId}`,
      ));
    }
    const taskId = this.nextTaskId++;

    return new Promise((resolve, reject) => {
      const task: QueueTask = {
        id: taskId,
        body,
        priority,
        timeoutMs,
        deadlineAt: Date.now() + timeoutMs,
        signal: options.signal,
        maxResponseBytes: options.maxResponseBytes,
        sqlOrigin,
        queuedAtMs: nodePerformance.now(),
        runtimePerformanceRecorder: currentRuntimePerformanceRecorder(),
        resolve,
        reject,
      };
      if (options.signal) {
        task.onAbort = () => this.cancelQueuedTask(task);
        options.signal.addEventListener('abort', task.onAbort, { once: true });
        if (options.signal.aborted) {
          this.cleanupTaskAbortListener(task);
          reject(createTraceProcessorQueryCancelledError(options.signal.reason));
          return;
        }
      }
      task.queueTimer = setTimeout(() => this.expireQueuedTask(task), timeoutMs);
      task.queueTimer.unref?.();
      this.queues[priority].push(task);
      this.queuedBytes += body.byteLength;
      this.drain();
    });
  }

  destroy(): void {
    this.destroyed = true;
    const error = new Error(`SQL worker for processor ${this.processorId} was destroyed`);
    for (const priority of PRIORITY_ORDER) {
      const tasks = this.queues[priority].splice(0);
      for (const task of tasks) {
        this.cleanupQueuedTask(task);
        task.reject(error);
      }
    }
    this.queuedBytes = 0;
    for (const pending of this.pendingWorkerRequests.values()) {
      this.cleanupPendingAbortListener(pending);
      pending.reject(error);
    }
    this.pendingWorkerRequests.clear();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }

  private drain(): void {
    if (this.running || this.destroyed) return;
    const task = this.nextTask();
    if (!task) return;

    this.running = true;
    void this.runTask(task)
      .then(task.resolve, task.reject)
      .finally(() => {
        this.running = false;
        this.drain();
      });
  }

  private nextTask(): QueueTask | undefined {
    for (const priority of PRIORITY_ORDER) {
      const task = this.queues[priority].shift();
      if (task) {
        this.queuedBytes -= task.body.byteLength;
        this.cleanupQueuedTask(task);
        return task;
      }
    }
    return undefined;
  }

  private async runTask(task: QueueTask): Promise<Buffer> {
    const executionStartedAtMs = nodePerformance.now();
    try {
      throwIfTraceProcessorQueryCancelled(task.signal);
      const remainingTimeoutMs = task.deadlineAt - Date.now();
      if (remainingTimeoutMs <= 0) {
        throw new TraceProcessorSqlDeadlineExceededError();
      }
      const nativeQuery = this.nativeProvenance && task.sqlOrigin
        ? beginRawSqlNativeQuery(this.nativeProvenance, task.sqlOrigin.sql, task.sqlOrigin.bootstrapCapability)
        : undefined;
      const request: TraceProcessorHttpRpcRequest = {
        hostname: this.hostname,
        port: this.port,
        body: task.body,
        timeoutMs: remainingTimeoutMs,
        signal: task.signal,
        maxResponseBytes: task.maxResponseBytes,
      };

      const response = this.forceInline || this.rawExecutor
        ? await raceWithTraceProcessorCancellation(
            (this.rawExecutor || executeTraceProcessorHttpRpcRaw)(request),
            task.signal,
          )
        : await this.postToWorker(task, remainingTimeoutMs);
      task.sqlOrigin?.decode(response, nativeQuery);
      this.recordSqlPerformance(task, executionStartedAtMs, 'ok');
      return response;
    } catch (error) {
      this.recordSqlPerformance(
        task,
        executionStartedAtMs,
        isTraceProcessorQueryCancelledError(error) ? 'cancelled' : 'error',
      );
      throw error;
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = resolveWorkerThreadPath();
    const worker = new Worker(workerPath.filename, {
      execArgv: workerPath.execArgv,
      ...(workerPath.eval ? {eval: true, workerData: workerPath.workerData} : {}),
      env: process.env,
    });

    worker.on('message', (message: { id: number; ok: boolean; body?: Uint8Array; error?: string }) => {
      const pending = this.pendingWorkerRequests.get(message.id);
      if (!pending) return;
      this.pendingWorkerRequests.delete(message.id);
      this.cleanupPendingAbortListener(pending);
      if (message.ok) {
        pending.resolve(Buffer.from(message.body || []));
      } else {
        pending.reject(new Error(message.error || 'SQL worker query failed'));
      }
    });

    worker.on('error', error => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectPendingWorkerRequests(normalized);
      this.worker = null;
    });

    worker.on('exit', code => {
      if (code !== 0 && !this.destroyed) {
        this.rejectPendingWorkerRequests(new Error(`SQL worker exited with code ${code}`));
      }
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private postToWorker(task: QueueTask, timeoutMs: number): Promise<Buffer> {
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const pending: PendingWorkerRequest = {
        resolve,
        reject,
        signal: task.signal,
      };
      this.pendingWorkerRequests.set(task.id, pending);
      if (task.signal) {
        pending.onAbort = () => {
          this.pendingWorkerRequests.delete(task.id);
          this.cleanupPendingAbortListener(pending);
          worker.postMessage({ id: task.id, cancel: true });
          reject(createTraceProcessorQueryCancelledError(task.signal?.reason));
        };
        task.signal.addEventListener('abort', pending.onAbort, { once: true });
        if (task.signal.aborted) {
          pending.onAbort();
          return;
        }
      }
      worker.postMessage({
        id: task.id,
        hostname: this.hostname,
        port: this.port,
        body: task.body,
        timeoutMs,
        maxResponseBytes: task.maxResponseBytes,
      });
    });
  }

  private rejectPendingWorkerRequests(error: Error): void {
    for (const pending of this.pendingWorkerRequests.values()) {
      this.cleanupPendingAbortListener(pending);
      pending.reject(error);
    }
    this.pendingWorkerRequests.clear();
  }

  private cancelQueuedTask(task: QueueTask): void {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues[priority];
      const index = queue.findIndex(candidate => candidate.id === task.id);
      if (index < 0) continue;
      queue.splice(index, 1);
      this.queuedBytes -= task.body.byteLength;
      this.cleanupQueuedTask(task);
      this.recordSqlPerformance(task, nodePerformance.now(), 'cancelled', 0);
      task.reject(createTraceProcessorQueryCancelledError(task.signal?.reason));
      return;
    }
  }

  private expireQueuedTask(task: QueueTask): void {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues[priority];
      const index = queue.findIndex(candidate => candidate.id === task.id);
      if (index < 0) continue;
      queue.splice(index, 1);
      this.queuedBytes -= task.body.byteLength;
      this.cleanupQueuedTask(task);
      this.recordSqlPerformance(task, nodePerformance.now(), 'error', 0);
      task.reject(new TraceProcessorSqlDeadlineExceededError());
      return;
    }
  }

  private cleanupQueuedTask(task: QueueTask): void {
    if (task.queueTimer) {
      clearTimeout(task.queueTimer);
      task.queueTimer = undefined;
    }
    this.cleanupTaskAbortListener(task);
  }

  private cleanupTaskAbortListener(task: QueueTask): void {
    if (!task.signal || !task.onAbort) return;
    task.signal.removeEventListener('abort', task.onAbort);
    task.onAbort = undefined;
  }

  private cleanupPendingAbortListener(pending: PendingWorkerRequest): void {
    if (!pending.signal || !pending.onAbort) return;
    pending.signal.removeEventListener('abort', pending.onAbort);
    pending.onAbort = undefined;
  }

  private recordSqlPerformance(
    task: QueueTask,
    executionStartedAtMs: number,
    outcome: RuntimePerformanceOutcome,
    executionMs = nodePerformance.now() - executionStartedAtMs,
  ): void {
    if (task.runtimePerformanceRecorded) return;
    task.runtimePerformanceRecorded = true;
    const recorder = task.runtimePerformanceRecorder;
    if (!recorder) return;
    try {
      recorder.recordSql({
        processorKey: this.processorKey,
        priority: task.priority,
        queueWaitMs: executionStartedAtMs - task.queuedAtMs,
        executionMs,
        outcome,
      });
    } catch {
      // Performance receipts are internal observability only; SQL behavior must
      // not change because a run manifest was already sealed or diagnostics
      // were rejected.
    }
  }
}
