// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import {
  ExternalRpcProcessor,
  WorkingTraceProcessor,
  TraceProcessorFactory,
} from './workingTraceProcessor';
import type {
  TraceProcessorBoundedQueryOptions,
  TraceProcessorQueryOptions,
} from './traceProcessorSqlWorker';
import {
  getTraceProcessorLeaseStore,
  type TraceProcessorLeaseMode,
  type TraceProcessorLeaseState,
} from './traceProcessorLeaseStore';
import { traceProcessorProcessorKey } from './traceProcessorConnectionModel';
import type { EnterpriseRepositoryScope } from './enterpriseRepository';
import {
  raceWithTraceProcessorCancellation,
  rethrowIfTraceProcessorQueryCancelled,
  throwIfTraceProcessorQueryCancelled,
} from './traceProcessorCancellation';
import {currentRunManifestAttributionSink} from './selfEvolution/runManifestLifecycle';
import {splitSqlStatements} from './sqlStdlibDependencyAnalyzer';
import type {ResolveCapabilityTraceProcessorIdentityInput} from './capabilityManifestRuntimeIdentity';

export interface TraceInfo {
  id: string;
  filename: string;
  size: number;
  filePath?: string;
  uploadTime: Date;
  lastAccessTime?: Date; // Track last query/access time for smart cleanup
  status: 'uploading' | 'processing' | 'ready' | 'error';
  error?: string;
  /** Detected trace OS — determines knowledge injection and vendor detection */
  traceOs?: 'android' | 'harmonyos' | 'unknown';
  /** Detected trace format */
  traceFormat?: 'perfetto_protobuf' | 'systrace_text' | 'atrace_text' | 'unknown';
  metadata?: {
    duration?: number;
    startTime?: number;
    endTime?: number;
    numEvents?: number;
    packages?: string[];
  };
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  durationMs: number;
  error?: string;
}

export type RunningTraceSummaryInput =
  | {
      source: 'local_file';
      tracePath: string;
      port: number;
      binarySelection: Extract<ResolveCapabilityTraceProcessorIdentityInput, {source: 'local_binary'}>;
    }
  | {source: 'external_rpc'};

export interface TraceProcessor {
  id: string;
  traceId: string;
  status: 'initializing' | 'ready' | 'busy' | 'error';
  /** Number of in-flight queries. Used by factory to avoid evicting busy processors. */
  activeQueries: number;
  query(sql: string, options?: TraceProcessorQueryOptions): Promise<QueryResult>;
  queryRaw(body: Buffer, options?: TraceProcessorQueryOptions): Promise<Buffer>;
  destroy(): void;
}

export interface TraceProcessorLeaseQueryContext {
  traceId: string;
  leaseId: string;
  mode: TraceProcessorLeaseMode | string;
  leaseScope?: EnterpriseRepositoryScope;
}

interface TraceProcessorLeaseQueryContextMap {
  traceLeases: Record<string, TraceProcessorLeaseQueryContext>;
}

export type TraceProcessorServiceQueryOptions = TraceProcessorQueryOptions & {
  leaseId?: string;
  leaseMode?: TraceProcessorLeaseMode | string;
  leaseScope?: EnterpriseRepositoryScope;
};

export type TraceProcessorServiceBoundedQueryOptions =
  TraceProcessorBoundedQueryOptions & {
    leaseId?: string;
    leaseMode?: TraceProcessorLeaseMode | string;
    leaseScope?: EnterpriseRepositoryScope;
  };

export interface TraceProcessorLeaseRestartPolicy {
  backoffMs?: number[];
  jitterMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface TraceProcessorLeaseSnapshot {
  status: TraceProcessor['status'];
  port?: number;
}

const DEFAULT_LEASE_RESTART_BACKOFF_MS = [1000, 5000, 15000];
const DEFAULT_LEASE_RESTART_JITTER_MS = 250;
const LEASE_RESTART_CONFLICT_STATES = new Set<TraceProcessorLeaseState>(['draining', 'released', 'failed']);
type LeaseRestartOwnerToken = symbol;

class LeaseProcessorRestartCancelledError extends Error {
  constructor(processorKey: string) {
    super(`Lease processor restart cancelled for ${processorKey}`);
    this.name = 'LeaseProcessorRestartCancelledError';
  }
}

function recordRunManifestSqlStatements(sql: string, success: boolean): void {
  const sink = currentRunManifestAttributionSink();
  if (!sink) return;
  const statementCount = splitSqlStatements(sql).length;
  for (let index = 0; index < statementCount; index++) {
    sink.recordSqlStatement(success);
  }
}

/**
 * Manages trace files and processors using the actual Perfetto Trace Processor WASM
 */
export class TraceProcessorService extends EventEmitter {
  private traces: Map<string, TraceInfo> = new Map();
  private traceSources = new WeakMap<TraceInfo, 'local_file' | 'external_rpc'>();
  /** Deletion tombstones block same-id registration and disk reload until teardown settles. */
  private traceDeletionInProgress: Map<string, Promise<void>> = new Map();
  private processors: Map<string, TraceProcessor> = new Map();
  /** Service-level mapping owner; shared external processors may expose another alias's traceId. */
  private processorTraceIds: Map<string, string> = new Map();
  private uploads: Map<string, any> = new Map();
  private uploadDir: string;
  /** Guards against concurrent auto-recovery for the same trace. */
  private recoveryInProgress: Map<string, Promise<TraceProcessor>> = new Map();
  /** Single-flight processor creation per processor key. */
  private processorCreationInProgress: Map<string, Promise<TraceProcessor>> = new Map();
  /** Trace object that owns each creation, so delete/re-register cannot inherit stale work. */
  private processorCreationOwners: Map<string, TraceInfo> = new Map();
  /** Prevent duplicate destroy calls when deletion races a late factory resolution. */
  private discardedProcessors = new WeakSet<TraceProcessor>();
  /** Single lease supervisor per processor key; holders wait instead of retrying. */
  private leaseRestartInProgress: Map<string, Promise<TraceProcessor>> = new Map();
  /** Exact trace ownership for restart keys; processor keys are not parsed. */
  private leaseRestartTraceIds: Map<string, string> = new Map();
  /** Synchronous per-key sentinel allowing only the restart owner to create replacement processors. */
  private leaseRestartOwnerTokens: Map<string, LeaseRestartOwnerToken> = new Map();
  /** Cancellation marker for cleanup of the exact in-flight restart owner. */
  private leaseRestartCancelledOwnerTokens: Map<string, LeaseRestartOwnerToken> = new Map();
  private readonly queryLeaseContext =
    new AsyncLocalStorage<TraceProcessorLeaseQueryContext | TraceProcessorLeaseQueryContextMap>();

  constructor(
    uploadDir = resolveDefaultTraceUploadDir(),
    private readonly leaseRestartPolicy: TraceProcessorLeaseRestartPolicy = {},
  ) {
    super();
    this.uploadDir = path.resolve(uploadDir);
    this.ensureUploadDir();
  }

  private ensureUploadDir(): void {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  private storeTraceInfo(
    traceInfo: TraceInfo,
    source: 'local_file' | 'external_rpc',
  ): void {
    if (this.traceDeletionInProgress.has(traceInfo.id)) {
      throw new Error(`Trace ${traceInfo.id} deletion in progress`);
    }
    this.traces.set(traceInfo.id, traceInfo);
    this.traceSources.set(traceInfo, source);
  }

  private processorKeyForLease(
    traceId: string,
    leaseId?: string,
    mode: TraceProcessorLeaseMode | string = 'shared',
  ): string {
    return traceProcessorProcessorKey(traceId, leaseId, mode);
  }

  private discardProcessor(processorKey: string, processor: TraceProcessor): void {
    if (this.processors.get(processorKey) === processor) {
      this.processors.delete(processorKey);
      this.processorTraceIds.delete(processorKey);
    }
    if (this.discardedProcessors.has(processor)) return;

    if (TraceProcessorFactory.get(processorKey) === processor) {
      if (!(processor instanceof ExternalRpcProcessor)) {
        this.discardedProcessors.add(processor);
      }
      TraceProcessorFactory.remove(processorKey);
      return;
    }
    if (
      processor instanceof ExternalRpcProcessor
      && TraceProcessorFactory.hasProcessorReference(processor)
    ) {
      return;
    }
    this.discardedProcessors.add(processor);
    try {
      processor.destroy();
    } catch {
      // Best-effort teardown for a factory result that lost trace ownership.
    }
  }

  private publishProcessor(
    processorKey: string,
    traceId: string,
    processor: TraceProcessor,
  ): void {
    this.processors.set(processorKey, processor);
    this.processorTraceIds.set(processorKey, traceId);
  }

  public runWithLease<T>(
    context: TraceProcessorLeaseQueryContext | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!context) return fn();
    return this.queryLeaseContext.run(context, fn);
  }

  public runWithLeases<T>(
    contexts: Array<TraceProcessorLeaseQueryContext | null | undefined>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const traceLeases: Record<string, TraceProcessorLeaseQueryContext> = {};
    for (const context of contexts) {
      if (!context) continue;
      traceLeases[context.traceId] = context;
    }
    if (Object.keys(traceLeases).length === 0) return fn();
    return this.queryLeaseContext.run({ traceLeases }, fn);
  }

  private resolveLeaseQueryContext(
    traceId: string,
    options: TraceProcessorServiceQueryOptions = {},
  ): TraceProcessorLeaseQueryContext | undefined {
    if (options.leaseId) {
      return {
        traceId,
        leaseId: options.leaseId,
        mode: options.leaseMode ?? 'shared',
        ...(options.leaseScope ? { leaseScope: options.leaseScope } : {}),
      };
    }
    const stored = this.queryLeaseContext.getStore();
    if (stored && 'traceLeases' in stored) {
      return stored.traceLeases[traceId];
    }
    return stored?.traceId === traceId ? stored : undefined;
  }

  /**
   * Initialize a trace upload
   */
  public async initializeUpload(filename: string, size: number): Promise<string> {
    const traceId = uuidv4();
    const traceInfo: TraceInfo = {
      id: traceId,
      filename,
      size,
      uploadTime: new Date(),
      status: 'uploading',
    };

    this.storeTraceInfo(traceInfo, 'local_file');
    this.emit('trace-initialized', traceInfo);

    return traceId;
  }

  /**
   * Initialize a trace upload with a specific ID
   * Use this when you already have a trace ID (e.g., from a file upload)
   */
  public async initializeUploadWithId(
    traceId: string,
    filename: string,
    size: number,
    filePath?: string,
  ): Promise<void> {
    const traceInfo: TraceInfo = {
      id: traceId,
      filename,
      size,
      ...(filePath ? { filePath } : {}),
      uploadTime: new Date(),
      status: 'uploading',
    };

    this.storeTraceInfo(traceInfo, 'local_file');
    this.emit('trace-initialized', traceInfo);
  }

  /**
   * Register an already-authorized on-disk trace without starting a processor.
   * Viewer leases use this after a backend restart to avoid creating an
   * unrelated shared processor before their isolated processor is admitted.
   */
  public registerStoredTrace(input: {
    id: string;
    filename: string;
    size: number;
    filePath: string;
    uploadedAt?: string | Date;
  }): TraceInfo {
    const filePath = path.resolve(input.filePath);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      throw new Error(`Trace path is not a regular file: ${filePath}`);
    }

    const existing = this.traces.get(input.id);
    if (existing) {
      const existingPath = path.resolve(this.getTraceFilePath(input.id));
      if (existingPath !== filePath) {
        throw new Error(`Trace ${input.id} is already registered from a different path`);
      }
      return existing;
    }

    const traceInfo: TraceInfo = {
      id: input.id,
      filename: input.filename,
      size: stats.size,
      filePath,
      uploadTime: new Date(input.uploadedAt ?? stats.mtime),
      status: 'ready',
    };
    this.storeTraceInfo(traceInfo, 'local_file');
    this.emit('trace-initialized', traceInfo);
    return traceInfo;
  }

  /**
   * Remove metadata for a trace registered from a managed external file.
   * Unlike deleteTrace(), this never deletes the source file.
   */
  public unregisterStoredTrace(
    traceId: string,
    expectedFilePath: string,
  ): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;
    if (
      path.resolve(this.getTraceFilePath(traceId))
      !== path.resolve(expectedFilePath)
    ) {
      throw new Error(
        `Trace ${traceId} is registered from an unexpected path`,
      );
    }
    if ([...this.processors.values()].some(
      processor => processor.traceId === traceId,
    )) {
      throw new Error(
        `Trace ${traceId} still has an active processor`,
      );
    }
    this.traces.delete(traceId);
    this.emit('trace-unregistered', traceId);
    return true;
  }

  /**
   * Handle chunk upload for large files
   */
  public async uploadChunk(traceId: string, chunk: Buffer, offset: number): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    const filePath = this.getTraceFilePath(traceId);

    // Create write stream if not exists
    if (!this.uploads.has(traceId)) {
      const writeStream = fs.createWriteStream(filePath, { flags: 'w' });
      this.uploads.set(traceId, writeStream);
    }

    const writeStream = this.uploads.get(traceId);

    // Write chunk at specific offset
    return new Promise((resolve, reject) => {
      // For simplicity, we'll append chunks
      // In production, you might want to use random access for better performance
      writeStream.write(chunk, (error: any) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Complete the upload and start processing
   */
  public async completeUpload(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    // Close write stream
    const writeStream = this.uploads.get(traceId);
    if (writeStream) {
      writeStream.end();
      this.uploads.delete(traceId);
    }

    // Update status
    trace.status = 'processing';
    this.emit('trace-status-changed', trace);

    // Start processing
    await this.processTrace(traceId);
  }

  /**
   * Process the uploaded trace file
   */
  private async processTrace(traceId: string): Promise<void> {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    const traceIsCurrent = () => this.traces.get(traceId) === trace;

    try {
      // Detect trace format and OS before creating processor
      const filePath = this.getTraceFilePath(traceId);
      if (filePath && fs.existsSync(filePath)) {
        try {
          const { detectTraceFormat } = await import('./traceFormatDetector');
          const formatInfo = await detectTraceFormat(filePath);
          trace.traceOs = formatInfo.os;
          trace.traceFormat = formatInfo.format;
          console.log(`[TraceProcessorService] Detected trace: os=${formatInfo.os}, format=${formatInfo.format} (${formatInfo.reason})`);
        } catch (detectError: any) {
          console.warn(`[TraceProcessorService] Format detection failed:`, detectError.message);
          trace.traceOs = 'unknown';
          trace.traceFormat = 'unknown';
        }
      }
      if (!traceIsCurrent()) return;

      // Create a processor instance
      const processor = await this.createProcessor(traceId);
      if (!traceIsCurrent()) {
        this.discardProcessor(traceId, processor);
        return;
      }
      this.publishProcessor(traceId, traceId, processor);

      // Extract metadata
      const metadata = await this.extractMetadata(processor);
      if (!traceIsCurrent()) {
        this.discardProcessor(traceId, processor);
        return;
      }
      trace.metadata = metadata;

      trace.status = 'ready';
      this.emit('trace-processed', trace);
      this.emit('trace-status-changed', trace);
    } catch (error: any) {
      if (!traceIsCurrent()) return;
      console.error(`[TraceProcessorService] Failed to process trace ${traceId}:`, error.message);
      trace.status = 'error';
      trace.error = error.message;
      this.emit('trace-status-changed', trace);
    }
  }

  /**
   * Create a new Trace Processor instance.
   * All traces use the default Perfetto trace_processor_shell,
   * which handles both Perfetto protobuf and ftrace text formats.
   */
  private async createProcessor(
    traceId: string,
    leaseContext?: Pick<TraceProcessorLeaseQueryContext, 'leaseId' | 'mode'>,
    restartOwnerToken?: LeaseRestartOwnerToken,
  ): Promise<TraceProcessor> {
    const traceOwner = this.traces.get(traceId);
    if (!traceOwner) {
      throw new Error(`Trace ${traceId} not found`);
    }
    const filePath = this.getTraceFilePath(traceId);
    const processorKey = this.processorKeyForLease(traceId, leaseContext?.leaseId, leaseContext?.mode);
    const restartInProgress = this.leaseRestartInProgress.get(processorKey);
    const restartOwner = this.leaseRestartOwnerTokens.get(processorKey);
    if (restartInProgress && restartOwner !== restartOwnerToken) {
      return restartInProgress;
    }

    const inProgress = this.processorCreationInProgress.get(processorKey);
    if (inProgress) {
      if (this.processorCreationOwners.get(processorKey) === traceOwner) {
        return inProgress;
      }
      try {
        await inProgress;
      } catch {
        // The stale trace owner retains cleanup responsibility. A replacement
        // trace with the same id may create only after that work settles.
      }
      if (this.traces.get(traceId) !== traceOwner) {
        throw new Error(`Trace ${traceId} changed during processor creation`);
      }
      return this.createProcessor(traceId, leaseContext, restartOwnerToken);
    }

    const creation = TraceProcessorFactory.create(traceId, filePath, {
      processorKey,
      leaseId: leaseContext?.leaseId,
      leaseMode: leaseContext?.mode ?? 'shared',
    }).then(processor => {
      if (this.traces.get(traceId) !== traceOwner) {
        this.discardProcessor(processorKey, processor);
        throw new Error(`Trace ${traceId} changed during processor creation`);
      }
      this.publishProcessor(processorKey, traceId, processor);
      return processor;
    });

    this.processorCreationInProgress.set(processorKey, creation);
    this.processorCreationOwners.set(processorKey, traceOwner);

    try {
      return await creation;
    } finally {
      if (this.processorCreationInProgress.get(processorKey) === creation) {
        this.processorCreationInProgress.delete(processorKey);
        this.processorCreationOwners.delete(processorKey);
      }
    }
  }

  /**
   * Extract basic metadata from the trace
   */
  private async extractMetadata(processor: TraceProcessor): Promise<TraceInfo['metadata']> {
    try {
      // Query basic trace information
      const result = await processor.query(`
        SELECT
          MIN(ts) as startTime,
          MAX(ts) as endTime,
          COUNT(*) as numEvents
        FROM slice
        UNION ALL
        SELECT
          MIN(ts) as startTime,
          MAX(ts) as endTime,
          COUNT(*) as numEvents
        FROM counter
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const startTime = row[0];
        const endTime = row[1];
        const numEvents = row[2];

        return {
          startTime,
          endTime,
          duration: endTime - startTime,
          numEvents,
        };
      }

      return {};
    } catch (error) {
      console.error('Failed to extract metadata:', error);
      return {};
    }
  }

  /**
   * Execute a SQL query on a trace.
   * If the processor has died (status=error), attempts to auto-recover once
   * by re-creating the processor from the on-disk trace file.
   * Concurrent callers share the same recovery promise to avoid thundering herd.
   */
  private async processorForQuery(
    traceId: string,
    options: TraceProcessorServiceQueryOptions = {},
  ): Promise<TraceProcessor> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    const leaseContext = this.resolveLeaseQueryContext(traceId, options);
    const processorKey = this.processorKeyForLease(traceId, leaseContext?.leaseId, leaseContext?.mode);
    let processor = this.processors.get(processorKey);
    if (!processor && leaseContext) {
      processor = await raceWithTraceProcessorCancellation(
        this.ensureProcessorForLease(
          traceId,
          leaseContext.leaseId,
          leaseContext.mode,
          leaseContext.leaseScope,
        ),
        options.signal,
      );
    }
    if (!processor) {
      throw new Error(`No processor for trace ${traceId}`);
    }

    // Update last access time for smart cleanup
    this.touchTrace(traceId);

    // Auto-recover dead processor
    if (processor.status === 'error') {
      if (leaseContext?.leaseId) {
        try {
          processor = await raceWithTraceProcessorCancellation(
            this.restartLeaseProcessor(traceId, leaseContext),
            options.signal,
          );
        } catch (err: any) {
          rethrowIfTraceProcessorQueryCancelled(err);
          throw new Error(`HTTP server not ready (auto-recovery failed: ${err.message})`);
        }
        return processor;
      }
      // Serialize concurrent recovery attempts for the same trace
      let recovery = this.recoveryInProgress.get(processorKey);
      if (!recovery) {
        console.log(`[TraceProcessorService] Processor for ${traceId} (${processorKey}) is dead, attempting auto-recovery...`);
        recovery = this.createProcessor(traceId, leaseContext).then(
          (p) => {
            console.log(`[TraceProcessorService] Auto-recovery succeeded for ${traceId} (${processorKey})`);
            this.recoveryInProgress.delete(processorKey);
            return p;
          },
          (err) => {
            console.error(`[TraceProcessorService] Auto-recovery failed for ${traceId} (${processorKey}):`, err.message);
            this.recoveryInProgress.delete(processorKey);
            throw err;
          },
        );
        this.recoveryInProgress.set(processorKey, recovery);
      } else {
        console.log(`[TraceProcessorService] Waiting for in-progress recovery of ${traceId} (${processorKey})...`);
      }

      try {
        processor = await raceWithTraceProcessorCancellation(recovery, options.signal);
      } catch (err: any) {
        rethrowIfTraceProcessorQueryCancelled(err);
        throw new Error(`HTTP server not ready (auto-recovery failed: ${err.message})`);
      }
    }

    throwIfTraceProcessorQueryCancelled(options.signal);
    return processor;
  }

  public async query(
    traceId: string,
    sql: string,
    options: TraceProcessorServiceQueryOptions = {},
  ): Promise<QueryResult> {
    try {
      const processor = await this.processorForQuery(traceId, options);
      const { leaseId: _leaseId, leaseMode: _leaseMode, leaseScope: _leaseScope, ...queryOptions } = options;
      const result = await processor.query(sql, queryOptions);
      recordRunManifestSqlStatements(sql, !result.error);
      return result;
    } catch (error) {
      recordRunManifestSqlStatements(sql, false);
      throw error;
    }
  }

  public async queryBounded(
    traceId: string,
    sql: string,
    options: TraceProcessorServiceBoundedQueryOptions,
  ): Promise<QueryResult> {
    try {
      const processor = await this.processorForQuery(traceId, options);
      const boundedProcessor = processor as TraceProcessor & {
        queryBounded?: (
          boundedSql: string,
          boundedOptions: TraceProcessorBoundedQueryOptions,
        ) => Promise<QueryResult>;
      };
      if (!boundedProcessor.queryBounded) {
        throw new Error('bounded_query_not_supported_by_trace_processor');
      }
      const {
        leaseId: _leaseId,
        leaseMode: _leaseMode,
        leaseScope: _leaseScope,
        ...queryOptions
      } = options;
      const result = await boundedProcessor.queryBounded(sql, queryOptions);
      recordRunManifestSqlStatements(sql, !result.error);
      return result;
    } catch (error) {
      recordRunManifestSqlStatements(sql, false);
      throw error;
    }
  }

  public async queryRaw(
    traceId: string,
    body: Buffer,
    options: TraceProcessorServiceQueryOptions = {},
  ): Promise<Buffer> {
    const processor = await this.processorForQuery(traceId, options);
    const { leaseId: _leaseId, leaseMode: _leaseMode, leaseScope: _leaseScope, ...queryOptions } = options;
    return await processor.queryRaw(body, queryOptions);
  }

  /**
   * Update the last access time for a trace (called on any activity)
   * This prevents active traces from being cleaned up prematurely
   */
  public touchTrace(traceId: string): void {
    const trace = this.traces.get(traceId);
    if (trace) {
      trace.lastAccessTime = new Date();
    }
  }

  /**
   * Get trace information
   */
  public getTrace(traceId: string): TraceInfo | undefined {
    return this.traces.get(traceId);
  }

  public getTraceSourceKind(
    traceId: string,
  ): 'local_file' | 'external_rpc' | undefined {
    const traceInfo = this.traces.get(traceId);
    return traceInfo ? this.traceSources.get(traceInfo) : undefined;
  }

  public getRunningCapabilityTraceProcessorInput(
    traceId: string,
    options: TraceProcessorServiceQueryOptions = {},
  ): ResolveCapabilityTraceProcessorIdentityInput | undefined {
    const leaseContext = this.resolveLeaseQueryContext(traceId, options);
    const processorKey = this.processorKeyForLease(
      traceId,
      leaseContext?.leaseId,
      leaseContext?.mode,
    );
    const processor = this.processors.get(processorKey);
    if (!processor) return undefined;
    return processor instanceof WorkingTraceProcessor
      ? processor.getRuntimeBinarySelection()
      : {source: 'external_rpc'};
  }

  public getRunningTraceSummaryInput(
    traceId: string,
    options: TraceProcessorServiceQueryOptions = {},
  ): RunningTraceSummaryInput | undefined {
    if (this.getTraceSourceKind(traceId) === 'external_rpc') {
      return {source: 'external_rpc'};
    }
    const tracePath = this.getTraceFilePath(traceId);
    if (!fs.existsSync(tracePath)) return undefined;
    const leaseContext = this.resolveLeaseQueryContext(traceId, options);
    const processorKey = this.processorKeyForLease(
      traceId,
      leaseContext?.leaseId,
      leaseContext?.mode,
    );
    const processor = this.processors.get(processorKey);
    if (!(processor instanceof WorkingTraceProcessor) || processor.status !== 'ready') {
      return undefined;
    }
    return {
      source: 'local_file',
      tracePath,
      port: processor.httpPort,
      binarySelection: processor.getRuntimeBinarySelection(),
    };
  }

  /**
   * Get the HTTP port of the trace processor for a given trace
   * This port can be used by the frontend to connect via HTTP RPC mode
   * Only returns port if the processor is actually ready
   */
  public getProcessorPort(traceId: string): number | undefined {
    const processor = this.processors.get(traceId) as WorkingTraceProcessor | undefined;
    // Only return port if processor is ready
    if (processor?.status === 'ready') {
      // Touch trace to prevent cleanup while frontend is using it
      this.touchTrace(traceId);
      return processor.httpPort;
    }
    return undefined;
  }

  /**
   * Get trace info with processor port for frontend
   * Also updates last access time to prevent cleanup
   */
  public getTraceWithPort(traceId: string): (TraceInfo & { port?: number; processor?: { status: string } }) | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const processor = this.processors.get(traceId) as WorkingTraceProcessor | undefined;
    // Only return port if processor is actually ready (not in error state)
    const port = (processor?.status === 'ready') ? processor.httpPort : undefined;

    // Touch trace to prevent cleanup while frontend is accessing it
    if (port) {
      this.touchTrace(traceId);
    }

    return {
      ...trace,
      port,
      processor: processor ? { status: processor.status } : undefined,
    };
  }

  public getTraceWithLeasePort(
    traceId: string,
    leaseId: string,
    mode: TraceProcessorLeaseMode | string,
  ): (TraceInfo & { port?: number; processor?: { status: string } }) | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;

    const processorKey = this.processorKeyForLease(traceId, leaseId, mode);
    const processor = this.processors.get(processorKey) as WorkingTraceProcessor | undefined;
    const port = (processor?.status === 'ready') ? processor.httpPort : undefined;

    if (port) {
      this.touchTrace(traceId);
    }

    return {
      ...trace,
      port,
      processor: processor ? { status: processor.status } : undefined,
    };
  }

  public getLeaseProcessorSnapshot(
    traceId: string,
    leaseId: string,
    mode: TraceProcessorLeaseMode | string,
  ): TraceProcessorLeaseSnapshot | undefined {
    const processorKey = this.processorKeyForLease(traceId, leaseId, mode);
    const processor = this.processors.get(processorKey) as WorkingTraceProcessor | undefined;
    if (!processor) return undefined;
    return {
      status: processor.status,
      ...(Number.isInteger(processor.httpPort) && processor.httpPort > 0
        ? {port: processor.httpPort}
        : {}),
    };
  }

  /**
   * Register an external RPC connection (frontend already connected to trace_processor)
   * This allows AI analysis to work with traces loaded via external HTTP RPC
   * @param traceId - A generated trace ID for this external connection
   * @param port - The port number where trace_processor is running
   * @param traceName - Display name for the trace
   */
  public async registerExternalRpc(traceId: string, port: number, traceName: string): Promise<void> {
    console.log(`[TraceProcessorService] Registering external RPC: ${traceId} on port ${port}`);
    if (this.processorCreationInProgress.has(traceId)) {
      throw new Error(`Processor creation already in progress for trace ${traceId}`);
    }

    const now = new Date();
    // Create a trace info entry for this external connection
    const traceInfo: TraceInfo = {
      id: traceId,
      filename: traceName,
      size: 0, // Unknown size for external traces
      uploadTime: now,
      lastAccessTime: now, // Set initial access time
      status: 'ready', // Assume it's ready since frontend is already connected
    };

    this.storeTraceInfo(traceInfo, 'external_rpc');

    // Create a proxy processor that uses the existing HTTP RPC connection
    const creation = TraceProcessorFactory.createFromExternalRpc(traceId, port);
    this.processorCreationInProgress.set(traceId, creation);
    this.processorCreationOwners.set(traceId, traceInfo);

    try {
      const processor = await creation;
      if (this.traces.get(traceId) !== traceInfo) {
        this.discardProcessor(traceId, processor);
        throw new Error(`Trace ${traceId} changed during processor creation`);
      }
      this.publishProcessor(traceId, traceId, processor);

      console.log(`[TraceProcessorService] External RPC registered successfully: ${traceId}`);
      this.emit('trace-processed', traceInfo);
    } finally {
      if (this.processorCreationInProgress.get(traceId) === creation) {
        this.processorCreationInProgress.delete(traceId);
        this.processorCreationOwners.delete(traceId);
      }
    }
  }

  /**
   * Load trace from disk if it exists but is not in memory
   * This is useful after server restart when traces are on disk but not loaded
   */
  public async loadTraceFromDisk(traceId: string): Promise<TraceInfo | undefined> {
    if (this.traceDeletionInProgress.has(traceId)) return undefined;
    // Already in memory
    if (this.traces.has(traceId)) {
      return this.traces.get(traceId);
    }

    // Check if metadata file exists
    const metadataPath = path.join(this.uploadDir, `${traceId}.json`);
    const tracePath = this.getTraceFilePath(traceId);

    if (!fs.existsSync(tracePath)) {
      console.log(`[TraceProcessorService] Trace file not found: ${tracePath}`);
      return undefined;
    }

    try {
      let traceInfo: TraceInfo;

      // Try to load metadata from JSON file
      if (fs.existsSync(metadataPath)) {
        const metadataRaw = fs.readFileSync(metadataPath, 'utf8');
        const metadata = JSON.parse(metadataRaw);
        traceInfo = {
          id: traceId,
          filename: metadata.filename || `${traceId}.trace`,
          size: metadata.size || fs.statSync(tracePath).size,
          filePath: tracePath,
          uploadTime: new Date(metadata.uploadedAt || Date.now()),
          status: 'ready',
          traceOs: metadata.traceOs,
          traceFormat: metadata.traceFormat,
          metadata: metadata.metadata,
        };
      } else {
        // Create basic metadata from trace file
        const stats = fs.statSync(tracePath);
        traceInfo = {
          id: traceId,
          filename: `${traceId}.trace`,
          size: stats.size,
          filePath: tracePath,
          uploadTime: new Date(stats.mtime),
          status: 'ready',
        };
      }

      // Detect trace format if not already known
      if (!traceInfo.traceOs) {
        try {
          const { detectTraceFormat } = await import('./traceFormatDetector');
          const formatInfo = await detectTraceFormat(tracePath);
          traceInfo.traceOs = formatInfo.os;
          traceInfo.traceFormat = formatInfo.format;
          console.log(`[TraceProcessorService] Detected trace from disk: os=${formatInfo.os}, format=${formatInfo.format}`);
        } catch { /* default to unknown */ }
      }

      // Register in memory
      this.storeTraceInfo(traceInfo, 'local_file');

      // Create processor
      const processor = await this.createProcessor(traceId);
      this.publishProcessor(traceId, traceId, processor);

      console.log(`[TraceProcessorService] Loaded trace from disk: ${traceId}`);
      return traceInfo;
    } catch (error: any) {
      console.error(`[TraceProcessorService] Failed to load trace from disk:`, error.message);
      return undefined;
    }
  }

  /**
   * Get or load trace - checks memory first, then tries to load from disk
   */
  public async getOrLoadTrace(traceId: string): Promise<TraceInfo | undefined> {
    if (this.traceDeletionInProgress.has(traceId)) return undefined;
    const trace = this.getTrace(traceId);
    if (trace) {
      return trace;
    }
    return this.loadTraceFromDisk(traceId);
  }

  public async ensureProcessorForLease(
    traceId: string,
    leaseId: string,
    mode: TraceProcessorLeaseMode | string,
    leaseScope?: EnterpriseRepositoryScope,
  ): Promise<TraceProcessor> {
    if (this.traceDeletionInProgress.has(traceId)) {
      throw new Error(`Trace ${traceId} deletion in progress`);
    }
    const key = this.processorKeyForLease(traceId, leaseId, mode);
    const restartInProgress = this.leaseRestartInProgress.get(key);
    if (restartInProgress) {
      console.log(`[TraceProcessorService] Waiting for lease supervisor restart of ${key}`);
      return restartInProgress;
    }

    const existing = this.processors.get(key);
    if (existing && existing.status === 'ready') {
      this.touchTrace(traceId);
      return existing;
    }
    if (existing && existing.status === 'error') {
      return this.restartLeaseProcessor(traceId, {
        traceId,
        leaseId,
        mode,
        ...(leaseScope ? { leaseScope } : {}),
      });
    }

    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found`);
    }

    const filePath = this.getTraceFilePath(traceId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Trace file not found for lease ${leaseId}: ${filePath}`);
    }

    return this.createProcessor(traceId, { leaseId, mode });
  }

  public async restartLease(
    traceId: string,
    leaseId: string,
    mode: TraceProcessorLeaseMode | string,
    leaseScope: EnterpriseRepositoryScope,
  ): Promise<TraceProcessor> {
    return this.restartLeaseProcessor(traceId, {
      traceId,
      leaseId,
      mode,
      leaseScope,
    });
  }

  private async restartLeaseProcessor(
    traceId: string,
    leaseContext: TraceProcessorLeaseQueryContext,
  ): Promise<TraceProcessor> {
    const processorKey = this.processorKeyForLease(traceId, leaseContext.leaseId, leaseContext.mode);
    const inProgress = this.leaseRestartInProgress.get(processorKey);
    if (inProgress) {
      console.log(`[TraceProcessorService] Waiting for lease supervisor restart of ${processorKey}`);
      return inProgress;
    }

    const restartOwnerToken: LeaseRestartOwnerToken = Symbol(processorKey);
    this.leaseRestartOwnerTokens.set(processorKey, restartOwnerToken);
    this.leaseRestartTraceIds.set(processorKey, traceId);

    let restart: Promise<TraceProcessor>;
    restart = Promise.resolve()
      .then(() => this.runLeaseRestartSupervisor(traceId, leaseContext, processorKey, restartOwnerToken))
      .finally(() => {
        if (this.leaseRestartInProgress.get(processorKey) === restart) {
          this.leaseRestartInProgress.delete(processorKey);
        }
        if (this.leaseRestartOwnerTokens.get(processorKey) === restartOwnerToken) {
          this.leaseRestartOwnerTokens.delete(processorKey);
        }
        if (this.leaseRestartCancelledOwnerTokens.get(processorKey) === restartOwnerToken) {
          this.leaseRestartCancelledOwnerTokens.delete(processorKey);
        }
        if (this.leaseRestartTraceIds.get(processorKey) === traceId) {
          this.leaseRestartTraceIds.delete(processorKey);
        }
      });
    this.leaseRestartInProgress.set(processorKey, restart);
    return restart;
  }

  private async runLeaseRestartSupervisor(
    traceId: string,
    leaseContext: TraceProcessorLeaseQueryContext,
    processorKey: string,
    restartOwnerToken: LeaseRestartOwnerToken,
  ): Promise<TraceProcessor> {
    const backoffMs = this.leaseRestartPolicy.backoffMs ?? DEFAULT_LEASE_RESTART_BACKOFF_MS;
    const attempts = Math.max(1, backoffMs.length);
    let lastError: unknown;

    console.warn(`[TraceProcessorService] Lease processor crashed; supervisor restarting ${processorKey}`);
    this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
    this.markLeaseCrashedForRestart(leaseContext);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const delayMs = this.restartBackoffDelayMs(backoffMs, attempt);
      if (delayMs > 0) {
        await this.restartSleep(delayMs);
        this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
      }

      await this.waitForProcessorCreationBeforeRestart(processorKey);
      this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
      this.markLeaseRestarting(leaseContext);
      this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
      this.destroyProcessorForRestart(processorKey);
      this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);

      try {
        const processor = await this.createProcessor(traceId, leaseContext, restartOwnerToken);
        if (this.isLeaseRestartCancelled(processorKey, restartOwnerToken)) {
          this.destroyProcessorForRestart(processorKey);
          throw new LeaseProcessorRestartCancelledError(processorKey);
        }
        this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
        this.markLeaseReadyAfterRestart(leaseContext);
        console.log(
          `[TraceProcessorService] Lease processor restart succeeded for ${processorKey} ` +
          `(attempt ${attempt + 1}/${attempts})`,
        );
        return processor;
      } catch (error: any) {
        this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
        if (error instanceof LeaseProcessorRestartCancelledError) {
          throw error;
        }
        lastError = error;
        console.warn(
          `[TraceProcessorService] Lease processor restart failed for ${processorKey} ` +
          `(attempt ${attempt + 1}/${attempts}): ${error?.message || error}`,
        );
      }
    }

    this.throwIfLeaseRestartCancelled(processorKey, restartOwnerToken);
    this.markLeaseFailedAfterRestart(leaseContext);
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Lease processor restart failed'));
  }

  private isLeaseRestartCancelled(
    processorKey: string,
    restartOwnerToken: LeaseRestartOwnerToken,
  ): boolean {
    return this.leaseRestartCancelledOwnerTokens.get(processorKey) === restartOwnerToken;
  }

  private throwIfLeaseRestartCancelled(
    processorKey: string,
    restartOwnerToken: LeaseRestartOwnerToken,
  ): void {
    if (this.isLeaseRestartCancelled(processorKey, restartOwnerToken)) {
      throw new LeaseProcessorRestartCancelledError(processorKey);
    }
  }

  private async waitForProcessorCreationBeforeRestart(processorKey: string): Promise<void> {
    const inProgress = this.processorCreationInProgress.get(processorKey);
    if (!inProgress) return;
    try {
      await inProgress;
    } catch {
      // The creator owns cleanup for its failed initializing processor; the
      // restart supervisor owns the replacement attempt after it settles.
    }
  }

  private restartBackoffDelayMs(backoffMs: number[], attemptIndex: number): number {
    const base = backoffMs[Math.min(attemptIndex, backoffMs.length - 1)] ?? 0;
    const jitterMs = this.leaseRestartPolicy.jitterMs ?? DEFAULT_LEASE_RESTART_JITTER_MS;
    if (base <= 0 || jitterMs <= 0) return Math.max(0, base);
    const random = this.leaseRestartPolicy.random ?? Math.random;
    return base + Math.floor(random() * jitterMs);
  }

  private restartSleep(delayMs: number): Promise<void> {
    if (this.leaseRestartPolicy.sleep) return this.leaseRestartPolicy.sleep(delayMs);
    return new Promise(resolve => {
      const timer = setTimeout(resolve, delayMs);
      if (typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }
    });
  }

  private destroyProcessorForRestart(processorKey: string): void {
    const processor = this.processors.get(processorKey);
    this.processors.delete(processorKey);
    this.processorTraceIds.delete(processorKey);
    if (TraceProcessorFactory.remove(processorKey)) return;
    try {
      processor?.destroy();
    } catch {
      // Best-effort cleanup before the supervisor creates the replacement.
    }
  }

  private markLeaseCrashedForRestart(context: TraceProcessorLeaseQueryContext): void {
    if (!context.leaseScope) return;
    const store = getTraceProcessorLeaseStore();
    const lease = store.getLeaseById(context.leaseScope, context.leaseId);
    if (!lease) throw new Error(`Trace processor lease not found: ${context.leaseId}`);
    if (LEASE_RESTART_CONFLICT_STATES.has(lease.state)) {
      throw new Error(`Trace processor lease ${lease.id} is ${lease.state}`);
    }
    if (lease.state === 'crashed' || lease.state === 'restarting') return;
    store.markCrashed(context.leaseScope, lease.id);
  }

  private markLeaseRestarting(context: TraceProcessorLeaseQueryContext): void {
    if (!context.leaseScope) return;
    const store = getTraceProcessorLeaseStore();
    const lease = store.getLeaseById(context.leaseScope, context.leaseId);
    if (!lease) throw new Error(`Trace processor lease not found: ${context.leaseId}`);
    if (lease.state === 'restarting') return;
    if (lease.state !== 'crashed') return;
    store.markRestarting(context.leaseScope, lease.id);
  }

  private markLeaseReadyAfterRestart(context: TraceProcessorLeaseQueryContext): void {
    if (!context.leaseScope) return;
    getTraceProcessorLeaseStore().markReady(context.leaseScope, context.leaseId);
  }

  private markLeaseFailedAfterRestart(context: TraceProcessorLeaseQueryContext): void {
    if (!context.leaseScope) return;
    const store = getTraceProcessorLeaseStore();
    const lease = store.getLeaseById(context.leaseScope, context.leaseId);
    if (!lease || lease.state === 'failed' || lease.state === 'released') return;
    store.markFailed(context.leaseScope, context.leaseId);
  }

  /**
   * Get all traces
   */
  public getAllTraces(): TraceInfo[] {
    return Array.from(this.traces.values());
  }

  /**
   * Delete a trace
   */
  public async deleteTrace(traceId: string): Promise<void> {
    const inProgress = this.traceDeletionInProgress.get(traceId);
    if (inProgress) return inProgress;

    const trace = this.traces.get(traceId);
    if (!trace) return;

    const deletion = this.performTraceDeletion(traceId, trace);
    this.traceDeletionInProgress.set(traceId, deletion);
    try {
      await deletion;
    } finally {
      if (this.traceDeletionInProgress.get(traceId) === deletion) {
        this.traceDeletionInProgress.delete(traceId);
      }
    }
  }

  private async performTraceDeletion(traceId: string, trace: TraceInfo): Promise<void> {
    // Invalidate trace identity before any asynchronous teardown. Creators
    // capture the TraceInfo object and must discard results once it is no
    // longer the current instance for this id.
    const filePath = trace.filePath || path.join(this.uploadDir, `${traceId}.trace`);
    const traceSource = this.traceSources.get(trace) ?? 'local_file';
    this.traces.delete(traceId);

    const pendingCreations = Array.from(this.processorCreationInProgress.entries())
      .filter(([processorKey]) => this.processorCreationOwners.get(processorKey) === trace);
    const processorKeys = new Set<string>([
      traceId,
      ...pendingCreations.map(([processorKey]) => processorKey),
      ...Array.from(this.processors.entries())
        .filter(([processorKey, processor]) =>
          this.processorTraceIds.get(processorKey) === traceId
          || (!this.processorTraceIds.has(processorKey) && processor.traceId === traceId))
        .map(([processorKey]) => processorKey),
      ...Array.from(this.leaseRestartInProgress.keys())
        .filter(processorKey => this.leaseRestartTraceIds.get(processorKey) === traceId),
    ]);

    for (const processorKey of processorKeys) {
      const restartOwnerToken = this.leaseRestartOwnerTokens.get(processorKey);
      if (restartOwnerToken) {
        this.leaseRestartCancelledOwnerTokens.set(processorKey, restartOwnerToken);
      }
      const processor = this.processors.get(processorKey)
        ?? TraceProcessorFactory.get(processorKey);
      if (processor) {
        this.discardProcessor(processorKey, processor);
      }
    }

    // Deletion is a lifecycle barrier: it does not report completion while a
    // creator can still publish a processor for the invalidated TraceInfo.
    await Promise.allSettled(pendingCreations.map(([, creation]) => creation));

    // Destroy all processors for this trace, including isolated lease processors.
    for (const [processorKey, processor] of Array.from(this.processors.entries())) {
      const processorTraceId = this.processorTraceIds.get(processorKey) ?? processor.traceId;
      if (processorTraceId !== traceId) continue;
      this.discardProcessor(processorKey, processor);
    }

    // Delete file
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      // Restore a fresh TraceInfo identity so callers can retry deletion while
      // every async task that captured the invalidated object stays stale.
      if (!this.traces.has(traceId)) {
        const restoredTrace = {...trace};
        this.traces.set(traceId, restoredTrace);
        this.traceSources.set(restoredTrace, traceSource);
      }
      throw error;
    }

    this.emit('trace-deleted', traceId);
  }

  public cleanupProcessorsForTraces(traceIds: Iterable<string>): number {
    const traceIdSet = new Set(traceIds);
    let cleaned = 0;
    for (const [processorKey, processor] of Array.from(this.processors.entries())) {
      const processorTraceId = this.processorTraceIds.get(processorKey) ?? processor.traceId;
      if (!traceIdSet.has(processorTraceId)) continue;
      if (!TraceProcessorFactory.remove(processorKey)) {
        processor.destroy();
      }
      this.processors.delete(processorKey);
      this.processorTraceIds.delete(processorKey);
      cleaned++;
    }
    return cleaned;
  }

  public cleanupLeaseProcessor(
    traceId: string,
    leaseId: string,
    mode: TraceProcessorLeaseMode | string,
  ): boolean {
    const processorKey = this.processorKeyForLease(traceId, leaseId, mode);
    const processor = this.processors.get(processorKey);
    const restartOwnerToken = this.leaseRestartOwnerTokens.get(processorKey);
    if (restartOwnerToken) {
      this.leaseRestartCancelledOwnerTokens.set(processorKey, restartOwnerToken);
    }

    const removedFactoryProcessor = TraceProcessorFactory.remove(processorKey);
    if (!removedFactoryProcessor && processor) {
      processor.destroy();
    }
    this.processors.delete(processorKey);
    this.processorTraceIds.delete(processorKey);
    return Boolean(processor || removedFactoryProcessor || restartOwnerToken || this.leaseRestartInProgress.has(processorKey));
  }

  /**
   * Load a trace directly from a file path (for CLI/testing use)
   * This copies the file to the upload directory and processes it
   */
  public async loadTraceFromFilePath(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const filename = path.basename(filePath);
    const stats = fs.statSync(filePath);
    const traceId = uuidv4();

    // Create trace info
    const traceInfo: TraceInfo = {
      id: traceId,
      filename,
      size: stats.size,
      uploadTime: new Date(),
      status: 'processing',
    };

    this.storeTraceInfo(traceInfo, 'local_file');
    this.emit('trace-initialized', traceInfo);

    // Copy file to upload directory
    const destPath = this.getTraceFilePath(traceId);
    fs.copyFileSync(filePath, destPath);
    traceInfo.filePath = destPath;

    // Process the trace
    await this.processTrace(traceId);

    return traceId;
  }

  /**
   * Get file path for a trace.
   *
   * NOTE: public so that scene-reconstruction's traceHash + report-store
   * code paths can hash the on-disk content. Existence of the file at the
   * returned path is also the source of truth for "is this trace
   * file-backed or external RPC".
   */
  public getTraceFilePath(traceId: string): string {
    return this.traces.get(traceId)?.filePath || path.join(this.uploadDir, `${traceId}.trace`);
  }

  /**
   * Cleanup old traces with smart activity detection
   *
   * A trace is only cleaned up when BOTH conditions are met:
   * 1. Upload time exceeds maxAge (how old the trace is)
   * 2. Last access time exceeds idleTimeout (how long since last activity)
   *
   * This prevents active traces from being cleaned up prematurely while
   * still cleaning up truly abandoned traces.
   *
   * @param maxAge - Maximum age since upload before trace becomes eligible for cleanup (default: 2 hours)
   * @param idleTimeout - Minimum idle time (no queries) before trace can be cleaned (default: 30 minutes)
   */
  public async cleanup(
    maxAge = 2 * 60 * 60 * 1000,      // 2 hours since upload
    idleTimeout = 30 * 60 * 1000       // 30 minutes since last access
  ): Promise<void> {
    const now = Date.now();
    const tracesToDelete: string[] = [];
    const skippedDueToActivity: string[] = [];

    for (const [traceId, trace] of this.traces) {
      const uploadAge = now - trace.uploadTime.getTime();

      // Only consider traces older than maxAge
      if (uploadAge > maxAge) {
        // Check if trace has been accessed recently
        const lastAccess = trace.lastAccessTime?.getTime() ?? trace.uploadTime.getTime();
        const idleTime = now - lastAccess;

        if (idleTime > idleTimeout) {
          // Trace is old AND idle - safe to clean up
          tracesToDelete.push(traceId);
        } else {
          // Trace is old but still active - skip cleanup
          skippedDueToActivity.push(traceId);
        }
      }
    }

    if (skippedDueToActivity.length > 0) {
      console.log(`[TraceProcessorService] Skipping ${skippedDueToActivity.length} active trace(s) (recently accessed)`);
    }

    if (tracesToDelete.length > 0) {
      console.log(`[TraceProcessorService] Cleaning up ${tracesToDelete.length} old and idle trace(s)`);
      for (const traceId of tracesToDelete) {
        await this.deleteTrace(traceId);
      }
    }
    // Note: Don't call TraceProcessorFactory.cleanup() here as it would
    // destroy ALL processors, not just those for deleted traces.
    // The deleteTrace() method already handles processor cleanup for each trace.
  }

  /**
   * Check if a trace is considered active (recently accessed)
   */
  public isTraceActive(traceId: string, idleTimeout = 30 * 60 * 1000): boolean {
    const trace = this.traces.get(traceId);
    if (!trace) return false;

    const now = Date.now();
    const lastAccess = trace.lastAccessTime?.getTime() ?? trace.uploadTime.getTime();
    return (now - lastAccess) <= idleTimeout;
  }
}

function resolveDefaultTraceUploadDir(): string {
  const configured = process.env.SMARTPERFETTO_TRACE_UPLOAD_DIR?.trim();
  return configured || './uploads/traces';
}

// Singleton instance for sharing across route modules
let _singletonInstance: TraceProcessorService | null = null;

export function getTraceProcessorService(): TraceProcessorService {
  if (!_singletonInstance) {
    _singletonInstance = new TraceProcessorService();
  }
  return _singletonInstance;
}

export function setTraceProcessorServiceForTests(service: TraceProcessorService | null): void {
  _singletonInstance = service;
}
