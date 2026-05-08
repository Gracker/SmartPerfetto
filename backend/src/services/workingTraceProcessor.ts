// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import { spawn, spawnSync, ChildProcess, execSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { encodeQueryArgs, decodeQueryResult } from './traceProcessorProtobuf';
import { getPortPool } from './portPool';
import { traceProcessorConfig } from '../config';
import logger from '../utils/logger';
import { getPerfettoStdlibModules, groupModulesByNamespace } from './perfettoStdlibScanner';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

// Path to the trace_processor_shell binary.
// Use the locally built version from perfetto/out/ui which has the viz stdlib modules.
// Can be overridden via TRACE_PROCESSOR_PATH environment variable.
// Keep this as a runtime getter: CLI loads .env after module imports, so a module-level
// process.env read would miss TRACE_PROCESSOR_PATH from backend/.env / --env-file.
// Path: backend/src/services/ -> ../../../ -> perfetto/out/ui/
export function getBundledTraceProcessorPath(): string {
  return path.resolve(__dirname, '../../../perfetto/out/ui/trace_processor_shell');
}

export function getUserTraceProcessorPath(): string {
  const home = process.env.SMARTPERFETTO_HOME && process.env.SMARTPERFETTO_HOME.trim()
    ? path.resolve(process.env.SMARTPERFETTO_HOME)
    : path.join(os.homedir(), '.smartperfetto');
  return path.join(home, 'bin', 'trace_processor_shell');
}

export function getTraceProcessorPath(): string {
  if (process.env.TRACE_PROCESSOR_PATH) {
    return path.resolve(process.env.TRACE_PROCESSOR_PATH);
  }

  const bundledPath = getBundledTraceProcessorPath();
  if (fs.existsSync(bundledPath)) return bundledPath;

  return getUserTraceProcessorPath();
}

const traceProcessorCorsFlagSupportCache = new Map<string, boolean>();

export function supportsTraceProcessorCorsOriginsFlag(binaryPath = getTraceProcessorPath()): boolean {
  const cached = traceProcessorCorsFlagSupportCache.get(binaryPath);
  if (cached !== undefined) return cached;

  const result = spawnSync(binaryPath, ['--help'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const help = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const supported = help.includes('--http-additional-cors-origins') || help.includes('additional-cors');
  traceProcessorCorsFlagSupportCache.set(binaryPath, supported);
  return supported;
}

function isTraceProcessorReadyMessage(text: string): boolean {
  return text.includes('Starting HTTP server') ||
    text.includes('Starting RPC server') ||
    text.includes('Trace loaded');
}

// Tier 0: absolute minimum stdlib modules needed for any analysis to start.
// Only the 3 most heavily referenced modules (19-32 skill/TS usages each).
// All other modules load on-demand via skill YAML prerequisites or explicit
// INCLUDE PERFETTO MODULE in SQL queries — no need to preload them here.
const CRITICAL_STDLIB_MODULES = [
  'android.frames.timeline',    // 19 skills, 19 TS refs — frame/jank analysis foundation
  'android.startup.startups',   // 16 skills, 32 TS refs — startup analysis foundation
  'android.binder',             // 22 skills,  6 TS refs — IPC/blocking analysis foundation
];

export function isFatalTraceProcessorListenFailure(text: string): boolean {
  if (!(text.includes('Failed to listen') || text.includes('Address already in use'))) {
    return false;
  }

  // Docker/Linux containers commonly have IPv6 loopback disabled. Perfetto can
  // still serve backend queries on 127.0.0.1, so this warning is not fatal.
  if (text.includes('IPv6 socket') || text.includes('[::')) {
    return false;
  }

  if (text.includes('errno: 0, No error')) {
    return false;
  }

  return true;
}

/**
 * Kill all orphan trace_processor_shell processes.
 * This should be called at startup to clean up processes from previous runs.
 */
export function killOrphanProcessors(): number {
  if (!IS_TEST_ENV) {
    console.log('[TraceProcessor] Checking for orphan trace_processor_shell processes...');
  }

  try {
    // Find all trace_processor_shell processes
    const result = execSync('pgrep -f trace_processor_shell 2>/dev/null || true', { encoding: 'utf-8' });
    const pids = result.trim().split('\n').filter(pid => pid.length > 0);

    if (pids.length === 0) {
      if (!IS_TEST_ENV) {
        console.log('[TraceProcessor] No orphan processes found');
      }
      return 0;
    }

    if (!IS_TEST_ENV) {
      console.log(`[TraceProcessor] Found ${pids.length} orphan process(es): ${pids.join(', ')}`);
    }

    // Kill each process
    let killed = 0;
    for (const pid of pids) {
      try {
        execSync(`kill ${pid} 2>/dev/null || true`);
        killed++;
        if (!IS_TEST_ENV) {
          console.log(`[TraceProcessor] Killed orphan process ${pid}`);
        }
      } catch (e) {
        // Process may already be dead
      }
    }

    if (!IS_TEST_ENV) {
      console.log(`[TraceProcessor] Killed ${killed} orphan process(es)`);
    }
    return killed;
  } catch (error: any) {
    if (!IS_TEST_ENV) {
      console.log('[TraceProcessor] Error checking for orphan processes:', error.message);
    }
    return 0;
  }
}

export interface QueryResult {
  columns: string[];
  rows: any[][];
  durationMs: number;
  error?: string;
}

export interface TraceProcessor {
  id: string;
  traceId: string;
  status: 'initializing' | 'ready' | 'busy' | 'error';
  activeQueries: number;
  query(sql: string): Promise<QueryResult>;
  destroy(): void;
}

/**
 * A working Trace Processor that uses trace_processor_shell in HTTP mode.
 *
 * This implementation:
 * 1. Starts trace_processor_shell with --httpd flag
 * 2. Loads the trace file once at initialization
 * 3. Executes queries via HTTP requests (fast, no reload)
 * 4. Properly cleans up the process on destroy
 */
export class WorkingTraceProcessor extends EventEmitter implements TraceProcessor {
  public id: string;
  public traceId: string;
  public status: 'initializing' | 'ready' | 'busy' | 'error' = 'initializing';

  private process: ChildProcess | null = null;
  private tracePath: string;
  private _httpPort: number;

  /** Get the HTTP port this processor is listening on */
  public get httpPort(): number {
    return this._httpPort;
  }
  private isDestroyed = false;
  private serverReady = false;
  private _activeQueries = 0;
  private queryQueue: Promise<void> = Promise.resolve();
  private _criticalModulesLoaded = false;
  private _criticalModulesLoadPromise: Promise<void> | null = null;
  private _criticalModulesLoadFailures = 0;
  private static readonly MAX_STDLIB_LOAD_RETRIES = 3;

  /** Number of in-flight queries. Factory uses this to avoid evicting busy processors. */
  public get activeQueries(): number {
    return this._activeQueries;
  }

  constructor(traceId: string, tracePath: string) {
    super();
    this.id = uuidv4();
    this.traceId = traceId;
    this.tracePath = tracePath;

    // Allocate port from pool
    this._httpPort = getPortPool().allocate(traceId);
  }

  async initialize(): Promise<void> {
    console.log(`[TraceProcessor] Initializing HTTP mode for trace: ${this.tracePath}`);
    console.log(`[TraceProcessor] Using port: ${this.httpPort}`);

    // Check if trace file exists
    if (!fs.existsSync(this.tracePath)) {
      throw new Error(`Trace file not found: ${this.tracePath}`);
    }

    // Check if trace_processor_shell exists
    const traceProcessorPath = getTraceProcessorPath();
    if (!fs.existsSync(traceProcessorPath)) {
      throw new Error(`trace_processor_shell not found at: ${traceProcessorPath}`);
    }

    if (this.isDestroyed) {
      throw new Error('Processor destroyed during initialization');
    }

    // Start trace_processor_shell in HTTP mode
    try {
      await this.startHttpServer();

      // Verify server is working with a test query
      console.log(`[TraceProcessor] Verifying server with test query...`);
      const testResult = await this.executeHttpQuery('SELECT 1 as test');

      if (testResult.error) {
        throw new Error(`Server verification failed: ${testResult.error}`);
      }

      this.status = 'ready';
      console.log(`[TraceProcessor] Processor ${this.id} ready (HTTP mode) for trace ${this.traceId}`);
      this.emit('ready');

      // Stdlib modules are loaded on demand:
      // - Skills handle their own prerequisites via INCLUDE PERFETTO MODULE
      //   (skillExecutor.buildSqlWithModuleIncludes)
      // - Raw `execute_sql` / `execute_sql_on` calls go through
      //   sqlIncludeInjector (backend/src/agentv3/sqlIncludeInjector.ts),
      //   which scans the SQL and prepends required INCLUDEs.
      // Background preload was removed because it competes with Agent queries
      // for the single-threaded trace_processor_shell, causing socket hang ups
      // on large traces (200MB+).
    } catch (error: any) {
      console.error(`[TraceProcessor] Initialization failed:`, error.message);
      this.status = 'error';
      this.destroy();
      throw error;
    }
  }

  /**
   * Start trace_processor_shell HTTP server
   */
  private async startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build CORS origins string from config
      const corsOrigins = `${traceProcessorConfig.perfettoUiOrigin},${traceProcessorConfig.perfettoUiOrigin.replace('localhost', '127.0.0.1')}`;
      const args = [
        '--httpd',
        '--http-port', String(this.httpPort),
        // Only pass --http-additional-cors-origins when supported (added after v47);
        // older binaries (≤v47) don't enforce CORS and exit with code 1 on unknown flags.
        ...(supportsTraceProcessorCorsOriginsFlag() ? ['--http-additional-cors-origins', corsOrigins] : []),
        this.tracePath
      ];

      const traceProcessorPath = getTraceProcessorPath();
      console.log(`[TraceProcessor] Starting: ${traceProcessorPath} ${args.join(' ')}`);

      this.process = spawn(traceProcessorPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      // Timeout for server startup
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Server startup timeout. stdout: ${stdout}, stderr: ${stderr}`));
        }
      }, traceProcessorConfig.startupTimeoutMs);

      this.process.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        console.log(`[TraceProcessor] stdout: ${text.trim()}`);

        // Check if server is ready
        if (isTraceProcessorReadyMessage(text)) {
          // Wait a bit for server to be fully ready
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              this.serverReady = true;
              resolve();
            }
          }, 500);
        }
      });

      this.process.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        if (!IS_TEST_ENV) {
          console.log(`[TraceProcessor] stderr: ${text.trim()}`);
        }

        // Also check stderr for server ready message
        if (isTraceProcessorReadyMessage(text)) {
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              this.serverReady = true;
              resolve();
            }
          }, 500);
        }

        // Check for errors
        if (text.includes('Could not open') || text.includes('Could not read')) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`Failed to load trace: ${text}`));
          }
        }

        // Check for port in use error
        if (isFatalTraceProcessorListenFailure(text)) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            reject(new Error(`PORT_IN_USE:${this.httpPort}`));
          }
        }
      });

      this.process.on('error', (error) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.process.on('close', (code) => {
        if (!IS_TEST_ENV) {
          console.log(`[TraceProcessor] Process exited with code ${code}`);
        }
        this.serverReady = false;
        this.status = 'error';
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`Process exited unexpectedly with code ${code}`));
        }
      });
    });
  }

  async query(sql: string): Promise<QueryResult> {
    if (this.status !== 'ready') {
      throw new Error(`Trace processor not ready (status: ${this.status})`);
    }

    if (!this.serverReady) {
      throw new Error('HTTP server not ready');
    }

    // Sequential stdlib loading on first query.
    // Each module gets its own HTTP request (never exceeds the 60s query timeout),
    // unlike the previous bulk approach that concatenated all 22 INCLUDEs into one
    // request which timed out on large (200MB+) traces.
    if (!this._criticalModulesLoaded
        && this._criticalModulesLoadFailures < WorkingTraceProcessor.MAX_STDLIB_LOAD_RETRIES
        && !this._criticalModulesLoadPromise) {
      this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();
    }
    if (this._criticalModulesLoadPromise) {
      await this._criticalModulesLoadPromise;
    }

    logger.debug('TraceProcessor', `Executing HTTP query: ${sql.substring(0, 100)}...`);
    return this.enqueueHttpQuery(sql);
  }

  private async enqueueHttpQuery(sql: string): Promise<QueryResult> {
    this._activeQueries++;
    const run = this.queryQueue.then(() => this.executeHttpQuery(sql));
    this.queryQueue = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this._activeQueries--;
    }
  }

  /**
   * Load critical stdlib modules one at a time in the background.
   * With only 3 Tier-0 modules this completes in a few seconds,
   * well within the default 60s query timeout per module.
   */
  private async _loadCriticalModulesSequentially(): Promise<void> {
    this._activeQueries++;
    const startTime = Date.now();
    let loaded = 0;
    let failed = 0;
    try {
      for (const m of CRITICAL_STDLIB_MODULES) {
        if (this.isDestroyed) break;
        const result = await this.enqueueHttpQuery(`INCLUDE PERFETTO MODULE ${m};`);
        if (result.error) {
          failed++;
          if (!result.error.includes('not found') && !result.error.includes('no such')) {
            console.warn(`[TraceProcessor] Failed to load stdlib module ${m}: ${result.error}`);
          }
        } else {
          loaded++;
        }
      }
      // Only mark as loaded if the loop ran to completion (not interrupted by destroy).
      // Partial module failures are expected (e.g., GPU modules on traces without GPU data).
      if (!this.isDestroyed) {
        this._criticalModulesLoaded = true;
      }
      const elapsed = Date.now() - startTime;
      console.log(`[TraceProcessor] Critical stdlib modules loaded for trace ${this.traceId}: ${loaded}/${CRITICAL_STDLIB_MODULES.length} in ${elapsed}ms (${failed} failed)`);
    } catch (err) {
      this._criticalModulesLoadFailures++;
      console.warn(`[TraceProcessor] Stdlib sequential load attempt ${this._criticalModulesLoadFailures}/${WorkingTraceProcessor.MAX_STDLIB_LOAD_RETRIES} failed for trace ${this.traceId}:`, err);
    } finally {
      this._activeQueries--;
      this._criticalModulesLoadPromise = null;
    }
  }

  /**
   * Execute SQL query via HTTP
   */
  private executeHttpQuery(sql: string): Promise<QueryResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      let settled = false;
      let req: http.ClientRequest | null = null;
      let wallClockTimer: NodeJS.Timeout | undefined;

      const finish = (result: QueryResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(wallClockTimer);
        resolve(result);
      };

      // `http.request({ timeout })` is socket-idle based. Some trace_processor
      // hangs keep the HTTP request open, so enforce an absolute wall-clock cap.
      wallClockTimer = setTimeout(() => {
        logger.warn(
          'TraceProcessor',
          `Query exceeded ${traceProcessorConfig.queryTimeoutMs}ms; aborting request for processor ${this.id}`,
        );
        req?.destroy();
        finish({
          columns: [],
          rows: [],
          durationMs: Date.now() - startTime,
          error: 'Query timeout',
        });
      }, traceProcessorConfig.queryTimeoutMs);

      if (IS_TEST_ENV && typeof (wallClockTimer as any).unref === 'function') {
        (wallClockTimer as any).unref();
      }

      // Encode QueryArgs protobuf
      const requestBody = encodeQueryArgs(sql);

      const options = {
        hostname: 'localhost',
        port: this.httpPort,
        path: '/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Content-Length': requestBody.length,
        },
        timeout: traceProcessorConfig.queryTimeoutMs,
      };

      req = http.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          if (settled) return;
          const responseBuffer = Buffer.concat(chunks);
          const durationMs = Date.now() - startTime;

          try {
            // Decode QueryResult protobuf
            const parsed = decodeQueryResult(responseBuffer);

            if (parsed.error) {
              logger.warn('TraceProcessor', `Query error: ${parsed.error}`);
              finish({
                columns: parsed.columnNames,
                rows: parsed.rows,
                durationMs,
                error: parsed.error,
              });
            } else {
              logger.debug('TraceProcessor', `Query returned ${parsed.rows.length} rows in ${durationMs}ms`);
              finish({
                columns: parsed.columnNames,
                rows: parsed.rows,
                durationMs,
              });
            }
          } catch (parseError: any) {
            console.error(`[TraceProcessor] Failed to parse response:`, parseError.message);
            finish({
              columns: [],
              rows: [],
              durationMs,
              error: `Failed to parse response: ${parseError.message}`,
            });
          }
        });
      });

      req.on('error', (error) => {
        if (settled) return;
        console.error(`[TraceProcessor] HTTP request failed:`, error.message);
        finish({
          columns: [],
          rows: [],
          durationMs: Date.now() - startTime,
          error: `HTTP request failed: ${error.message}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        finish({
          columns: [],
          rows: [],
          durationMs: Date.now() - startTime,
          error: 'Query timeout',
        });
      });

      req.write(requestBody);
      req.end();
    });
  }

  private async preloadModules(
    modules: string[],
    label: string,
  ): Promise<{ loaded: string[]; failed: string[] }> {
    const loaded: string[] = [];
    const failed: string[] = [];

    if (modules.length === 0) {
      console.warn(`[TraceProcessor] No ${label} stdlib modules found to preload`);
      return { loaded, failed };
    }

    const startTime = Date.now();

    if (label === 'all') {
      const namespaceGroups = groupModulesByNamespace(modules);
      console.log(
        `[TraceProcessor] Preloading ${modules.length} ${label} stdlib modules:`,
        namespaceGroups,
      );
    } else {
      console.log(
        `[TraceProcessor] Preloading ${modules.length} ${label} stdlib modules: ${modules.join(', ')}`,
      );
    }

    // Load modules sequentially to avoid overwhelming the single-threaded
    // trace_processor_shell. Parallel batches cause "socket hang up" on large traces
    // because queued HTTP connections time out while TP processes earlier queries.
    for (const moduleName of modules) {
      let result: { status: 'fulfilled' | 'rejected'; value?: string; reason?: Error };
      try {
        const queryResult = await this.executeHttpQuery(`INCLUDE PERFETTO MODULE ${moduleName};`);
        if (queryResult.error) {
          result = { status: 'rejected', reason: new Error(queryResult.error) };
        } else {
          result = { status: 'fulfilled', value: moduleName };
        }
      } catch (err: any) {
        result = { status: 'rejected', reason: err };
      }

      {
        // Classify result as loaded or failed
        if (result.status === 'fulfilled') {
          loaded.push(moduleName);
        } else {
          failed.push(moduleName);
          // Only log errors for non-trivial failures (not "module not found" which is expected
          // when trace doesn't have the required data)
          const errorMsg = result.reason?.message || String(result.reason);
          if (!errorMsg.includes('not found') && !errorMsg.includes('no such')) {
            logger.debug('TraceProcessor', `Failed to load module ${moduleName}: ${errorMsg}`);
          }
        }
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[TraceProcessor] Preloaded ${loaded.length}/${modules.length} ${label} stdlib modules in ${elapsed}ms ` +
        `(${failed.length} failed)`
    );

    return { loaded, failed };
  }

  /**
   * Preload critical modules used by frequently hit analysis paths.
   */
  async preloadCriticalPerfettoModules(): Promise<{ loaded: string[]; failed: string[] }> {
    return this.preloadModules(CRITICAL_STDLIB_MODULES, 'critical');
  }

  /**
   * Preload all Perfetto stdlib modules to make additional views/tables available.
   */
  async preloadAllPerfettoModules(): Promise<{ loaded: string[]; failed: string[] }> {
    return this.preloadModules(getPerfettoStdlibModules(), 'all');
  }

  destroy(): void {
    if (!IS_TEST_ENV) {
      console.log(`[TraceProcessor] Destroying processor ${this.id} for trace ${this.traceId}`);
    }
    this.isDestroyed = true;
    this.serverReady = false;
    this.status = 'error';

    if (this.process) {
      try {
        const traceId = this.traceId;
        const proc = this.process;
        let released = false;
        const releasePortOnce = (): void => {
          if (released) return;
          released = true;
          getPortPool().release(traceId);
        };

        // Force kill after timeout (fallback).
        const killTimer = setTimeout(() => {
          if (!proc.killed) {
            try {
              proc.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
          // Ensure port is eventually released even if close event is missed.
          releasePortOnce();
        }, traceProcessorConfig.killTimeoutMs);

        // Release the port as soon as the process actually exits.
        // Also clears the kill timer to avoid late callbacks/noisy logs in tests.
        proc.once('close', () => {
          clearTimeout(killTimer);
          releasePortOnce();
        });

        // In Jest, don't let this timer keep the event loop alive.
        if (IS_TEST_ENV && typeof (killTimer as any).unref === 'function') {
          (killTimer as any).unref();
        }

        // Try graceful shutdown last (after handlers are registered)
        proc.kill('SIGTERM');
      } catch (e) {
        // Process may already be dead, still release port
        getPortPool().release(this.traceId);
      }
      this.process = null;
    } else {
      // No process, but still release port
      getPortPool().release(this.traceId);
    }

    this.removeAllListeners();
  }
}

/**
 * Factory for creating trace processors
 */
type ManagedTraceProcessor = WorkingTraceProcessor | ExternalRpcProcessor;

export class TraceProcessorFactory {
  private static processors: Map<string, ManagedTraceProcessor> = new Map();
  private static externalProcessorsByPort: Map<number, ExternalRpcProcessor> = new Map();
  private static maxProcessors = 5;

  static async create(traceId: string, tracePath: string): Promise<WorkingTraceProcessor> {
    // Check if processor already exists and is ready
    const existing = this.processors.get(traceId);
    if (existing instanceof WorkingTraceProcessor && existing.status === 'ready') {
      console.log(`[TraceProcessorFactory] Reusing existing processor for trace ${traceId}`);
      return existing;
    }

    // Clean up failed processor if exists
    if (existing) {
      console.log(`[TraceProcessorFactory] Cleaning up existing processor for trace ${traceId}`);
      this.remove(traceId);
    }

    // Clean up oldest owned idle processors if too many (skip busy/external ones).
    while (this.processors.size >= this.maxProcessors) {
      const idle = Array.from(this.processors.entries())
        .find(([, p]) => p instanceof WorkingTraceProcessor && p.activeQueries === 0);
      if (idle) {
        console.log(`[TraceProcessorFactory] Cleaning up idle processor: ${idle[0]}`);
        idle[1].destroy();
        this.processors.delete(idle[0]);
      } else {
        // All processors are busy — allow temporary over-limit rather than killing active work
        console.warn(`[TraceProcessorFactory] All ${this.processors.size} processors are busy, allowing temporary over-limit`);
        break;
      }
    }

    const maxAttempts = 8;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Create new processor (allocates a port from the pool)
      console.log(`[TraceProcessorFactory] Creating new HTTP-mode processor for trace ${traceId} (attempt ${attempt}/${maxAttempts})`);
      const processor = new WorkingTraceProcessor(traceId, tracePath);

      processor.on('error', () => {
        this.processors.delete(traceId);
      });

      this.processors.set(traceId, processor);

      try {
        await processor.initialize();
        return processor;
      } catch (error: any) {
        lastError = error;

        // Ensure we don't keep a failed processor around.
        try {
          processor.destroy();
        } catch {
          // ignore
        }
        this.processors.delete(traceId);

        // Retry with a different port if the chosen port is already in use by another process.
        const msg = String(error?.message || '');
        if (msg.startsWith('PORT_IN_USE:')) {
          const portStr = msg.split(':')[1];
          const port = Number(portStr);
          if (Number.isFinite(port)) {
            getPortPool().blockPort(port);
          } else {
            // Fallback: release any allocation for this traceId so next attempt can allocate again.
            getPortPool().release(traceId);
          }
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to create trace processor');
  }

  static get(traceId: string): ManagedTraceProcessor | undefined {
    return this.processors.get(traceId);
  }

  static remove(traceId: string): boolean {
    const processor = this.processors.get(traceId);
    if (processor) {
      console.log(`[TraceProcessorFactory] Removing processor for trace ${traceId}`);
      this.processors.delete(traceId);
      if (processor instanceof ExternalRpcProcessor) {
        const stillReferenced = Array.from(this.processors.values()).some(p => p === processor);
        if (!stillReferenced) {
          processor.destroy();
          this.externalProcessorsByPort.delete(processor.httpPort);
        }
      } else {
        processor.destroy();
      }
      return true;
    }
    return false;
  }

  static cleanup(): void {
    console.log(`[TraceProcessorFactory] Cleaning up all processors`);
    for (const processor of new Set(this.processors.values())) {
      processor.destroy();
    }
    this.processors.clear();
    this.externalProcessorsByPort.clear();
  }

  static getStats(): { count: number; traceIds: string[] } {
    return {
      count: this.processors.size,
      traceIds: Array.from(this.processors.keys()),
    };
  }

  /**
   * Create a processor that connects to an existing external HTTP RPC endpoint.
   * This is used when the frontend is already connected to a trace_processor via HTTP RPC.
   * We don't start a new process, we just create a wrapper that queries the existing one.
   */
  static async createFromExternalRpc(traceId: string, port: number): Promise<ExternalRpcProcessor> {
    const current = this.processors.get(traceId);
    if (current instanceof ExternalRpcProcessor && current.httpPort === port && current.status === 'ready') {
      console.log(`[TraceProcessorFactory] Reusing external RPC processor for trace ${traceId} on port ${port}`);
      return current;
    }
    if (current) {
      console.log(`[TraceProcessorFactory] Remapping trace ${traceId} to external RPC port ${port}`);
      this.remove(traceId);
    }

    const existing = this.externalProcessorsByPort.get(port);
    if (existing && existing.status === 'ready') {
      console.log(`[TraceProcessorFactory] Reusing external RPC processor for port ${port}`);
      this.processors.set(traceId, existing);
      return existing;
    }
    if (existing) {
      this.externalProcessorsByPort.delete(port);
    }

    console.log(`[TraceProcessorFactory] Creating external RPC processor for port ${port}`);

    const processor = new ExternalRpcProcessor(traceId, port);

    // Verify connection with raw query — avoid triggering lazy stdlib load at registration time
    try {
      await processor._execRaw('SELECT 1');
      console.log(`[TraceProcessorFactory] External RPC connection verified on port ${port}`);
    } catch (error) {
      console.error(`[TraceProcessorFactory] Failed to verify external RPC connection:`, error);
      throw new Error(`Cannot connect to external trace_processor on port ${port}`);
    }

    this.processors.set(traceId, processor);
    this.externalProcessorsByPort.set(port, processor);
    return processor;
  }
}

/**
 * A lightweight processor that connects to an external trace_processor HTTP RPC endpoint.
 * Unlike WorkingTraceProcessor, this doesn't start a new process.
 */
export class ExternalRpcProcessor extends EventEmitter implements TraceProcessor {
  public id: string;
  public traceId: string;
  public status: 'initializing' | 'ready' | 'busy' | 'error' = 'ready';

  private _httpPort: number;
  private _activeQueries = 0;
  private queryQueue: Promise<void> = Promise.resolve();
  private _criticalModulesLoaded = false;
  private _criticalModulesLoadPromise: Promise<void> | null = null;
  private _criticalModulesLoadFailures = 0;
  // TODO: If external TP restarts on the same port, _criticalModulesLoaded stays true
  // but modules are gone. Detect connection errors and reset flag to force reload.
  private static readonly MAX_STDLIB_LOAD_RETRIES = 3;

  public get httpPort(): number {
    return this._httpPort;
  }

  /** Number of in-flight or queued queries. Factory uses this to avoid unsafe eviction. */
  public get activeQueries(): number {
    return this._activeQueries;
  }

  constructor(traceId: string, port: number) {
    super();
    this.id = `external-${port}`;
    this.traceId = traceId;
    this._httpPort = port;
    console.log(`[ExternalRpcProcessor] Created for trace ${traceId} on port ${port}`);
  }

  async query(sql: string): Promise<QueryResult> {
    // Sequential stdlib loading on first query (same pattern as WorkingTraceProcessor).
    if (!this._criticalModulesLoaded
        && this._criticalModulesLoadFailures < ExternalRpcProcessor.MAX_STDLIB_LOAD_RETRIES
        && !this._criticalModulesLoadPromise) {
      this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();
    }
    if (this._criticalModulesLoadPromise) {
      await this._criticalModulesLoadPromise;
    }

    return this.enqueueRawQuery(sql);
  }

  /**
   * Load critical stdlib modules one at a time in the background.
   * With only 3 Tier-0 modules this completes in a few seconds.
   */
  private async _loadCriticalModulesSequentially(): Promise<void> {
    this._activeQueries++;
    const startTime = Date.now();
    let loaded = 0;
    let failed = 0;
    try {
      for (const m of CRITICAL_STDLIB_MODULES) {
        const result = await this.enqueueRawQuery(`INCLUDE PERFETTO MODULE ${m};`);
        if (result.error) {
          failed++;
          if (!result.error.includes('not found') && !result.error.includes('no such')) {
            console.warn(`[ExternalRpcProcessor] Failed to load stdlib module ${m}: ${result.error}`);
          }
        } else {
          loaded++;
        }
      }
      this._criticalModulesLoaded = true;
      const elapsed = Date.now() - startTime;
      console.log(`[ExternalRpcProcessor] Critical stdlib modules loaded for trace ${this.traceId}: ${loaded}/${CRITICAL_STDLIB_MODULES.length} in ${elapsed}ms (${failed} failed)`);
    } catch (err) {
      this._criticalModulesLoadFailures++;
      console.warn(`[ExternalRpcProcessor] Stdlib sequential load attempt ${this._criticalModulesLoadFailures}/${ExternalRpcProcessor.MAX_STDLIB_LOAD_RETRIES} failed:`, err);
    } finally {
      this._activeQueries--;
      this._criticalModulesLoadPromise = null;
    }
  }

  private async enqueueRawQuery(sql: string): Promise<QueryResult> {
    this._activeQueries++;
    const run = this.queryQueue.then(() => this._execRaw(sql));
    this.queryQueue = run.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await run;
    } finally {
      this._activeQueries--;
    }
  }

  /** Low-level query without stdlib lazy-load. Used by factory for connectivity checks. */
  _execRaw(sql: string): Promise<QueryResult> {
    const startTime = Date.now();

    try {
      // Use protobuf encoding for the query
      const requestBody = encodeQueryArgs(sql);

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: this._httpPort,
          path: '/query',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-protobuf',
            'Content-Length': requestBody.length,
          },
        }, (res) => {
          const chunks: Buffer[] = [];

          res.on('data', (chunk) => chunks.push(chunk));

          res.on('end', () => {
            const responseBody = Buffer.concat(chunks);

            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${responseBody.toString()}`));
              return;
            }

            try {
              const result = decodeQueryResult(responseBody);
              resolve({
                columns: result.columnNames,
                rows: result.rows,
                durationMs: Date.now() - startTime,
                error: result.error,
              });
            } catch (decodeError: any) {
              reject(new Error(`Failed to decode response: ${decodeError.message}`));
            }
          });
        });

        req.on('error', reject);
        req.write(requestBody);
        req.end();
      });
    } catch (error: any) {
      return Promise.resolve({
        columns: [],
        rows: [],
        durationMs: Date.now() - startTime,
        error: error.message,
      });
    }
  }

  destroy(): void {
    // External RPC processor doesn't own the process, so nothing to clean up
    console.log(`[ExternalRpcProcessor] Destroyed (trace ${this.traceId})`);
    this.status = 'error';
    this.emit('destroyed');
  }
}
