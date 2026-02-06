import { EventEmitter } from 'events';
import { spawn, ChildProcess, execSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { encodeQueryArgs, decodeQueryResult } from './traceProcessorProtobuf';
import { getPortPool } from './portPool';
import { traceProcessorConfig } from '../config';
import logger from '../utils/logger';
import { getPerfettoStdlibModules, groupModulesByNamespace } from './perfettoStdlibScanner';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

// Path to the trace_processor_shell binary
// Use the locally built version from perfetto/out/ui which has the viz stdlib modules
// Can be overridden via TRACE_PROCESSOR_PATH environment variable
// Path: backend/src/services/ -> ../../../ -> perfetto/out/ui/
const TRACE_PROCESSOR_PATH = process.env.TRACE_PROCESSOR_PATH ||
  path.resolve(__dirname, '../../../perfetto/out/ui/trace_processor_shell');

// Small subset used by core Android analysis paths that query stdlib views directly.
const CRITICAL_STDLIB_MODULES = [
  'android.frames.timeline',
  'android.binder',
  'android.startup.startups',
  'android.input',
];

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
    if (!fs.existsSync(TRACE_PROCESSOR_PATH)) {
      throw new Error(`trace_processor_shell not found at: ${TRACE_PROCESSOR_PATH}`);
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

      // Preload a small critical module set first to keep startup latency low.
      if (traceProcessorConfig.preloadCriticalStdlibModules) {
        await this.preloadCriticalPerfettoModules();
      }

      this.status = 'ready';
      console.log(`[TraceProcessor] Processor ${this.id} ready (HTTP mode) for trace ${this.traceId}`);
      this.emit('ready');

      // Optional full prewarm runs in background so upload response is not blocked.
      if (traceProcessorConfig.preloadAllStdlibModules) {
        void this.preloadAllPerfettoModules().catch((error: any) => {
          console.warn('[TraceProcessor] Background stdlib preload failed:', error?.message || error);
        });
      }
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
        // Allow CORS from the Perfetto UI origin
        '--http-additional-cors-origins', corsOrigins,
        this.tracePath
      ];

      console.log(`[TraceProcessor] Starting: ${TRACE_PROCESSOR_PATH} ${args.join(' ')}`);

      this.process = spawn(TRACE_PROCESSOR_PATH, args, {
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
        if (text.includes('Starting HTTP server') || text.includes('Trace loaded')) {
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
        if (text.includes('Starting HTTP server') || text.includes('Trace loaded')) {
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
        if (text.includes('Failed to listen') || text.includes('Address already in use')) {
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

    const startTime = Date.now();
    logger.debug('TraceProcessor', `Executing HTTP query: ${sql.substring(0, 100)}...`);

    return this.executeHttpQuery(sql);
  }

  /**
   * Execute SQL query via HTTP
   */
  private executeHttpQuery(sql: string): Promise<QueryResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
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

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(chunk));

        res.on('end', () => {
          const responseBuffer = Buffer.concat(chunks);
          const durationMs = Date.now() - startTime;

          try {
            // Decode QueryResult protobuf
            const parsed = decodeQueryResult(responseBuffer);

            if (parsed.error) {
              logger.warn('TraceProcessor', `Query error: ${parsed.error}`);
              resolve({
                columns: parsed.columnNames,
                rows: parsed.rows,
                durationMs,
                error: parsed.error,
              });
            } else {
              logger.debug('TraceProcessor', `Query returned ${parsed.rows.length} rows in ${durationMs}ms`);
              resolve({
                columns: parsed.columnNames,
                rows: parsed.rows,
                durationMs,
              });
            }
          } catch (parseError: any) {
            console.error(`[TraceProcessor] Failed to parse response:`, parseError.message);
            resolve({
              columns: [],
              rows: [],
              durationMs,
              error: `Failed to parse response: ${parseError.message}`,
            });
          }
        });
      });

      req.on('error', (error) => {
        console.error(`[TraceProcessor] HTTP request failed:`, error.message);
        resolve({
          columns: [],
          rows: [],
          durationMs: Date.now() - startTime,
          error: `HTTP request failed: ${error.message}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
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

    // Load modules in parallel batches for efficiency
    const BATCH_SIZE = 10;
    for (let i = 0; i < modules.length; i += BATCH_SIZE) {
      const batch = modules.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (moduleName) => {
          const result = await this.executeHttpQuery(`INCLUDE PERFETTO MODULE ${moduleName};`);
          if (result.error) {
            throw new Error(result.error);
          }
          return moduleName;
        })
      );

      // Classify results as loaded or failed
      results.forEach((result, idx) => {
        const moduleName = batch[idx];
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
      });
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
export class TraceProcessorFactory {
  private static processors: Map<string, WorkingTraceProcessor> = new Map();
  private static maxProcessors = 5;

  static async create(traceId: string, tracePath: string): Promise<WorkingTraceProcessor> {
    // Check if processor already exists and is ready
    const existing = this.processors.get(traceId);
    if (existing && existing.status === 'ready') {
      console.log(`[TraceProcessorFactory] Reusing existing processor for trace ${traceId}`);
      return existing;
    }

    // Clean up failed processor if exists
    if (existing && existing.status !== 'ready') {
      console.log(`[TraceProcessorFactory] Cleaning up failed processor for trace ${traceId}`);
      existing.destroy();
      this.processors.delete(traceId);
    }

    // Clean up oldest processors if too many
    while (this.processors.size >= this.maxProcessors) {
      const oldest = Array.from(this.processors.entries())[0];
      if (oldest) {
        console.log(`[TraceProcessorFactory] Cleaning up oldest processor: ${oldest[0]}`);
        oldest[1].destroy();
        this.processors.delete(oldest[0]);
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

  static get(traceId: string): WorkingTraceProcessor | undefined {
    return this.processors.get(traceId);
  }

  static remove(traceId: string): boolean {
    const processor = this.processors.get(traceId);
    if (processor) {
      console.log(`[TraceProcessorFactory] Removing processor for trace ${traceId}`);
      processor.destroy();
      this.processors.delete(traceId);
      return true;
    }
    return false;
  }

  static cleanup(): void {
    console.log(`[TraceProcessorFactory] Cleaning up all processors`);
    for (const processor of this.processors.values()) {
      processor.destroy();
    }
    this.processors.clear();
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
    console.log(`[TraceProcessorFactory] Creating external RPC processor for port ${port}`);

    const processor = new ExternalRpcProcessor(traceId, port);

    // Verify connection by running a simple query
    try {
      await processor.query('SELECT 1');
      console.log(`[TraceProcessorFactory] External RPC connection verified on port ${port}`);
    } catch (error) {
      console.error(`[TraceProcessorFactory] Failed to verify external RPC connection:`, error);
      throw new Error(`Cannot connect to external trace_processor on port ${port}`);
    }

    this.processors.set(traceId, processor as any);
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

  public get httpPort(): number {
    return this._httpPort;
  }

  constructor(traceId: string, port: number) {
    super();
    this.id = `external-${port}`;
    this.traceId = traceId;
    this._httpPort = port;
    console.log(`[ExternalRpcProcessor] Created for trace ${traceId} on port ${port}`);
  }

  async query(sql: string): Promise<QueryResult> {
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
      return {
        columns: [],
        rows: [],
        durationMs: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  destroy(): void {
    // External RPC processor doesn't own the process, so nothing to clean up
    console.log(`[ExternalRpcProcessor] Destroyed (trace ${this.traceId})`);
    this.status = 'error';
    this.emit('destroyed');
  }
}
