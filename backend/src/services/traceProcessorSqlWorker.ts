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
import {currentRunManifestAttributionSink} from './selfEvolution/runManifestLifecycle';

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

function resolveWorkerThreadPath(): { filename: string; execArgv: string[] } {
  const jsPath = path.join(__dirname, 'traceProcessorSqlWorkerThread.js');
  if (fs.existsSync(jsPath)) {
    return { filename: jsPath, execArgv: [] };
  }

  return {
    filename: path.join(__dirname, 'traceProcessorSqlWorkerThread.ts'),
    execArgv: ['--require', 'tsx/cjs'],
  };
}

export class TraceProcessorSqlWorker {
  private readonly processorId: string;
  private readonly traceId: string;
  private readonly processorKey: string;
  private readonly port: number;
  private readonly hostname: string;
  private readonly forceInline: boolean;
  private readonly rawExecutor?: (request: TraceProcessorHttpRpcRequest) => Promise<Buffer>;
  private readonly maxQueuedTasks: number;
  private readonly maxQueuedBytes: number;
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
    this.traceId = options.traceId;
    this.processorKey = options.processorKey ?? options.traceId;
    this.port = options.port;
    this.hostname = options.hostname || '127.0.0.1';
    this.forceInline = options.forceInline ?? IS_TEST_ENV;
    this.rawExecutor = options.rawExecutor;
    this.maxQueuedTasks = Math.max(1, options.maxQueuedTasks ?? DEFAULT_MAX_QUEUED_TASKS);
    this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES);
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
    const startTime = Date.now();
    try {
      const response = await this.enqueueRaw(encodeQueryArgs(sql), options);
      const parsed = decodeQueryResult(response);
      return {
        columns: parsed.columnNames,
        rows: parsed.rows,
        durationMs: Date.now() - startTime,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
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
      const response = await this.enqueueRawInternal(
        encodeQueryArgs(sql),
        options,
      );
      const parsed = decodeQueryResult(response, {maxRows: options.maxRows});
      return {
        columns: parsed.columnNames,
        rows: parsed.rows,
        durationMs: Date.now() - startTime,
        ...(parsed.error ? {error: parsed.error} : {}),
      };
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
    return this.enqueueRawInternal(body, options);
  }

  private enqueueRawInternal(
    body: Buffer,
    options: TraceProcessorQueryOptions & {maxResponseBytes?: number},
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
        queuedAtMs: nodePerformance.now(),
        runtimePerformanceRecorder:
          currentRunManifestAttributionSink()?.runtimePerformanceRecorder,
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
