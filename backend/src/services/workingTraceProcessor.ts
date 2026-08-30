// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { EventEmitter } from 'events';
import { spawn, spawnSync, ChildProcess, execFileSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import {
  decodeQueryArgsSql,
  encodeQueryResult,
} from './traceProcessorProtobuf';
import { executeTraceProcessorHttpRpcSql } from './traceProcessorHttpRpcClient';
import { getPortPool } from './portPool';
import { traceProcessorConfig } from '../config';
import logger, {diagnosticLogIdentity} from '../utils/logger';
import { getPerfettoStdlibModules, groupModulesByNamespace } from './perfettoStdlibScanner';
import { readProcessRssBytes } from './processRss';
import {
  TraceProcessorSqlWorker,
  type TraceProcessorBoundedQueryOptions,
  type TraceProcessorQueryOptions,
} from './traceProcessorSqlWorker';
import {
  raceWithTraceProcessorCancellation,
  throwIfTraceProcessorQueryCancelled,
} from './traceProcessorCancellation';
import {
  assertTraceProcessorAdmission,
  getTraceProcessorRamBudgetStats,
  type TraceProcessorRamBudgetStats,
} from './traceProcessorRamBudget';
import { getTraceProcessorLeaseStore } from './traceProcessorLeaseStore';

const IS_TEST_ENV = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
const GIB = 1024 * 1024 * 1024;

export function resolveTraceProcessorStartupTimeoutMs(
  traceSizeBytes: number,
  config: {
    startupTimeoutMs: number;
    startupTimeoutPerGiBMs: number;
    startupTimeoutMaxMs: number;
  } = traceProcessorConfig,
): number {
  const sizeGiB = Math.max(1, Math.ceil(Math.max(0, traceSizeBytes) / GIB));
  const sizeAdjusted = sizeGiB * config.startupTimeoutPerGiBMs;
  const upperBound = Math.max(config.startupTimeoutMs, config.startupTimeoutMaxMs);
  return Math.min(Math.max(config.startupTimeoutMs, sizeAdjusted), upperBound);
}

// Path to the trace_processor_shell binary.
// Use the locally built version from perfetto/out/ui which has the viz stdlib modules.
// Can be overridden via TRACE_PROCESSOR_PATH environment variable.
// Keep this as a runtime getter: CLI loads .env after module imports, so a module-level
// process.env read would miss TRACE_PROCESSOR_PATH from backend/.env / --env-file.
// Path: backend/src/services/ -> ../../../ -> perfetto/out/ui/
export function getBundledTraceProcessorPath(): string {
  const executableName = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  return path.resolve(__dirname, '../../../perfetto/out/ui', executableName);
}

export function getPrebuiltTraceProcessorPlatformKey(): string | undefined {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return undefined;
}

export function getPrebuiltTraceProcessorPath(): string | undefined {
  const platformKey = getPrebuiltTraceProcessorPlatformKey();
  if (!platformKey) return undefined;
  const executableName = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  return path.resolve(__dirname, '../../prebuilts/trace_processor', platformKey, executableName);
}

export function getBackendBinTraceProcessorPath(): string {
  const executableName = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  return path.resolve(__dirname, '../../bin', executableName);
}

export function getUserTraceProcessorPath(): string {
  const home = process.env.SMARTPERFETTO_HOME && process.env.SMARTPERFETTO_HOME.trim()
    ? path.resolve(process.env.SMARTPERFETTO_HOME)
    : path.join(os.homedir(), '.smartperfetto');
  const executableName = process.platform === 'win32' ? 'trace_processor_shell.exe' : 'trace_processor_shell';
  return path.join(home, 'bin', executableName);
}

export function isTraceProcessorPathPlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/');
  return normalized === '/path/to/trace_processor_shell' ||
    normalized === '/path/to/trace_processor_shell.exe' ||
    normalized === 'path/to/trace_processor_shell' ||
    normalized === 'path/to/trace_processor_shell.exe' ||
    normalized === '/absolute/path/to/trace_processor_shell' ||
    normalized === '/absolute/path/to/trace_processor_shell.exe' ||
    /^[A-Za-z]:\/path\/to\/trace_processor_shell(?:\.exe)?$/.test(normalized);
}

let warnedTraceProcessorPathPlaceholder = false;

function resolveEnvTraceProcessorPath(): string | undefined {
  const configured = process.env.TRACE_PROCESSOR_PATH?.trim();
  if (!configured) return undefined;
  if (isTraceProcessorPathPlaceholder(configured)) {
    if (!warnedTraceProcessorPathPlaceholder) {
      warnedTraceProcessorPathPlaceholder = true;
      console.warn(
        '[TraceProcessor] Ignoring placeholder TRACE_PROCESSOR_PATH. ' +
          'Comment it out or set it to an absolute trace_processor_shell path.',
      );
    }
    return undefined;
  }
  return path.resolve(configured);
}

export function getTraceProcessorPath(): string {
  const envPath = resolveEnvTraceProcessorPath();
  if (envPath) return envPath;

  const prebuiltPath = getPrebuiltTraceProcessorPath();
  if (prebuiltPath && fs.existsSync(prebuiltPath)) return prebuiltPath;

  const bundledPath = getBundledTraceProcessorPath();
  if (fs.existsSync(bundledPath)) return bundledPath;

  const backendBinPath = getBackendBinTraceProcessorPath();
  if (fs.existsSync(backendBinPath)) return backendBinPath;

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

export function isTraceProcessorReadyMessage(text: string): boolean {
  return text.includes('Starting HTTP server') ||
    text.includes('Starting RPC server');
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

  return text
    .split(/\r?\n/)
    .filter(line => line.includes('Failed to listen') || line.includes('Address already in use'))
    .some(line => {
      // Docker/Linux containers commonly have IPv6 loopback disabled. Perfetto can
      // still serve backend queries on 127.0.0.1, so this warning is not fatal.
      if (line.includes('IPv6 socket') || line.includes('[::')) {
        return false;
      }

      if (line.includes('errno: 0, No error')) {
        return false;
      }

      return true;
    });
}

export interface TraceProcessorProcessInfo {
  pid: number;
  parentPid: number;
  command: string;
}

export interface TraceProcessorOrphanCleanupOptions {
  processTable?: string;
  isProcessAlive?: (pid: number) => boolean;
  resolveProcessExecutable?: (pid: number) => string | undefined;
  terminateProcess?: (pid: number) => void;
}

function defaultResolveProcessExecutable(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

function isTraceProcessorCommand(
  pid: number,
  command: string,
  resolveProcessExecutable: (pid: number) => string | undefined,
): boolean {
  const executableName = path.basename(command.replace(/\\/g, '/')).toLowerCase();
  if (executableName === 'trace_processor_shell' || executableName === 'trace_processor_shell.exe') {
    return true;
  }

  // Linux truncates `comm` to TASK_COMM_LEN. Resolve /proc/<pid>/exe before
  // accepting the truncated prefix so similarly named services are untouched.
  if (executableName !== 'trace_processor') return false;
  const resolved = resolveProcessExecutable(pid);
  if (!resolved) return false;
  const resolvedName = path.basename(resolved.replace(/\\/g, '/')).toLowerCase();
  return resolvedName === 'trace_processor_shell' || resolvedName === 'trace_processor_shell.exe';
}

export function parseTraceProcessorProcessTable(
  output: string,
  resolveProcessExecutable: (pid: number) => string | undefined = defaultResolveProcessExecutable,
): TraceProcessorProcessInfo[] {
  const processes: TraceProcessorProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[3];
    if (!isTraceProcessorCommand(pid, command, resolveProcessExecutable)) continue;
    processes.push({
      pid,
      parentPid: Number(match[2]),
      command,
    });
  }
  return processes;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readTraceProcessorProcessTable(): string {
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop';",
      "Get-CimInstance Win32_Process -Filter \"Name = 'trace_processor_shell.exe'\" |",
      "ForEach-Object { '{0} {1} trace_processor_shell.exe' -f $_.ProcessId, $_.ParentProcessId }",
    ].join(' ');
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024},
    );
  }

  if (process.platform === 'darwin') {
    // Darwin's `ps ... comm=` truncates executable names to MAXCOMLEN, so
    // trace_processor_shell appears as an unrelated path prefix. pgrep reads
    // the kernel process name without that display truncation; after it has
    // selected exact candidates, query only their parent PIDs and emit the
    // canonical rows consumed by the platform-neutral ownership logic.
    const result = spawnSync(
      '/usr/bin/pgrep',
      ['-x', 'trace_processor_shell'],
      {encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024},
    );
    if (result.error) throw result.error;
    if (result.status === 1) return '';
    if (result.status !== 0) {
      throw new Error(`pgrep failed with status ${result.status ?? 'unknown'}`);
    }

    const rows: string[] = [];
    for (const value of result.stdout.split(/\s+/)) {
      if (!/^\d+$/.test(value)) continue;
      const pid = Number(value);
      try {
        const parentPidText = execFileSync(
          '/bin/ps',
          ['-p', String(pid), '-o', 'ppid='],
          {encoding: 'utf-8', maxBuffer: 64 * 1024},
        ).trim();
        if (!/^\d+$/.test(parentPidText)) continue;
        rows.push(`${pid} ${parentPidText} trace_processor_shell`);
      } catch {
        // The process can exit between pgrep and ps; omit that stale row.
      }
    }
    return rows.join('\n');
  }

  if (process.platform === 'linux') {
    const rows: string[] = [];
    for (const entry of fs.readdirSync('/proc', {withFileTypes: true})) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const executable = fs.realpathSync(`/proc/${pid}/exe`);
        if (path.basename(executable) !== 'trace_processor_shell') continue;
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
        const parentMatch = /^PPid:\s+(\d+)$/m.exec(status);
        if (!parentMatch) continue;
        rows.push(`${pid} ${parentMatch[1]} trace_processor_shell`);
      } catch {
        // Processes can exit while /proc is being scanned, and inaccessible
        // processes cannot belong to this user-owned backend instance.
      }
    }
    return rows.join('\n');
  }

  // Fallback for other Unix-like platforms. Their `comm` output is accepted
  // only when it exposes the exact executable name.
  return execFileSync(
    'ps',
    ['-axo', 'pid=,ppid=,comm='],
    {encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024},
  );
}

export function findOrphanTraceProcessorPids(
  processTable: string,
  parentIsAlive: (pid: number) => boolean = isProcessAlive,
  resolveProcessExecutable: (pid: number) => string | undefined = defaultResolveProcessExecutable,
): number[] {
  return parseTraceProcessorProcessTable(processTable, resolveProcessExecutable)
    .filter(processInfo => processInfo.pid !== process.pid)
    .filter(processInfo => processInfo.parentPid <= 1 || !parentIsAlive(processInfo.parentPid))
    .map(processInfo => processInfo.pid);
}

/**
 * Clean up trace processors whose owning process has exited.
 *
 * A process with a live parent belongs to another active SmartPerfetto/CLI/test
 * instance and must not be touched. After an owner crashes, Unix reparents the
 * child to PID 1; the liveness fallback also covers a process-table race where
 * the recorded parent has just exited.
 */
export function killOrphanProcessors(options: TraceProcessorOrphanCleanupOptions = {}): number {
  if (!IS_TEST_ENV) {
    console.log('[TraceProcessor] Checking for orphan trace_processor_shell processes...');
  }

  try {
    const processTable = options.processTable ?? readTraceProcessorProcessTable();
    const pids = findOrphanTraceProcessorPids(
      processTable,
      options.isProcessAlive ?? isProcessAlive,
      options.resolveProcessExecutable ?? defaultResolveProcessExecutable,
    );

    if (pids.length === 0) {
      if (!IS_TEST_ENV) {
        console.log('[TraceProcessor] No orphan processes found');
      }
      return 0;
    }

    if (!IS_TEST_ENV) {
      console.log(`[TraceProcessor] Found ${pids.length} orphan process(es): ${pids.join(', ')}`);
    }

    const terminateProcess = options.terminateProcess ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
    let killed = 0;
    for (const pid of pids) {
      try {
        terminateProcess(pid);
        killed++;
        if (!IS_TEST_ENV) {
          console.log(`[TraceProcessor] Killed orphan process ${pid}`);
        }
      } catch {
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
  getRuntimeStats(): TraceProcessorRuntimeStats;
  query(sql: string, options?: TraceProcessorQueryOptions): Promise<QueryResult>;
  queryRaw(body: Buffer, options?: TraceProcessorQueryOptions): Promise<Buffer>;
  queryHealth(timeoutMs?: number): Promise<TraceProcessorHealthProbeResult>;
  checkHealth(options?: TraceProcessorHealthCheckOptions): Promise<TraceProcessorHealthStatus>;
  destroy(): void;
}

export interface TraceProcessorHealthProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
}

export interface TraceProcessorHealthCheckOptions {
  queryTimeoutMs?: number;
  rpcAcceptTimeoutMs?: number;
}

export interface TraceProcessorHealthStatus {
  ok: boolean;
  checkedAt: string;
  processorId: string;
  traceId: string;
  httpPort: number;
  liveness: TraceProcessorHealthProbeResult;
  rpcAccept: TraceProcessorHealthProbeResult;
  queryResponsive: TraceProcessorHealthProbeResult;
}

export interface TraceProcessorRuntimeStats {
  kind: 'owned_process' | 'external_rpc';
  processorId: string;
  processorKey?: string;
  traceId: string;
  leaseId?: string;
  leaseMode?: 'shared' | 'isolated' | string;
  status: 'initializing' | 'ready' | 'busy' | 'error';
  activeQueries: number;
  httpPort: number;
  pid?: number;
  rssBytes: number | null;
  startupRssBytes?: number | null;
  peakRssBytes?: number | null;
  lastRssSampleAt?: number | null;
  rssSampleSource: 'procfs' | 'ps' | 'unavailable' | 'external';
  rssSampleError?: string;
  sqlWorker?: {
    running: boolean;
    queuedP0: number;
    queuedP1: number;
    queuedP2: number;
    usesWorkerThread: boolean;
  };
}

export interface TraceProcessorCreateOptions {
  processorKey?: string;
  leaseId?: string;
  leaseMode?: 'shared' | 'isolated' | string;
}

function probeOk(startTime: number, detail?: string): TraceProcessorHealthProbeResult {
  return {
    ok: true,
    durationMs: Date.now() - startTime,
    ...(detail ? { detail } : {}),
  };
}

function probeError(startTime: number, error: unknown, detail?: string): TraceProcessorHealthProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    durationMs: Date.now() - startTime,
    error: message,
    ...(detail ? { detail } : {}),
  };
}

function probeTcpAccept(
  port: number,
  timeoutMs: number,
  hostname = '127.0.0.1',
): Promise<TraceProcessorHealthProbeResult> {
  const startTime = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: hostname, port });
    const finish = (result: TraceProcessorHealthProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(probeError(startTime, new Error('RPC accept timeout')));
    }, timeoutMs);
    if (typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
    socket.once('connect', () => finish(probeOk(startTime)));
    socket.once('error', error => finish(probeError(startTime, error)));
  });
}

async function probeDedicatedHealthQuery(
  port: number,
  timeoutMs: number,
): Promise<TraceProcessorHealthProbeResult> {
  const startTime = Date.now();
  try {
    const result = await executeTraceProcessorHttpRpcSql({
      port,
      sql: 'SELECT 1',
      timeoutMs,
    });
    if (result.error) {
      return probeError(startTime, new Error(result.error));
    }
    return probeOk(startTime);
  } catch (error) {
    return probeError(startTime, error);
  }
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
  private readonly processorKey: string;
  private readonly leaseId?: string;
  private readonly leaseMode: 'shared' | 'isolated' | string;
  private runtimeBinarySelection?: Readonly<{
    source: 'local_binary';
    selectedPath: string;
    selectionOrigin: 'default' | 'env_override';
  }>;
  private _httpPort: number;

  /** Get the HTTP port this processor is listening on */
  public get httpPort(): number {
    return this._httpPort;
  }
  private isDestroyed = false;
  private serverReady = false;
  private _activeQueries = 0;
  private readonly sqlWorker: TraceProcessorSqlWorker;
  private startupRssBytes: number | null = null;
  private peakRssBytes: number | null = null;
  private lastRssBytes: number | null = null;
  private lastRssSampleAt: number | null = null;
  private lastRssSampleSource: TraceProcessorRuntimeStats['rssSampleSource'] = 'unavailable';
  private lastRssSampleError: string | undefined;
  private _criticalModulesLoaded = false;
  private _criticalModulesLoadPromise: Promise<void> | null = null;
  private _criticalModulesLoadFailures = 0;
  private static readonly MAX_STDLIB_LOAD_RETRIES = 3;

  /** Number of in-flight queries. Factory uses this to avoid evicting busy processors. */
  public get activeQueries(): number {
    return this._activeQueries;
  }

  public getRuntimeBinarySelection(): {
    source: 'local_binary';
    selectedPath: string;
    selectionOrigin: 'default' | 'env_override';
  } {
    if (!this.runtimeBinarySelection) {
      throw new Error('Trace processor binary selection is unavailable before initialization');
    }
    return {...this.runtimeBinarySelection};
  }

  public getRuntimeStats(): TraceProcessorRuntimeStats {
    const rssSample = this.sampleRss();
    return {
      kind: 'owned_process',
      processorId: this.id,
      processorKey: this.processorKey,
      traceId: this.traceId,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
      leaseMode: this.leaseMode,
      status: this.status,
      activeQueries: this.activeQueries,
      httpPort: this.httpPort,
      ...(this.process?.pid ? { pid: this.process.pid } : {}),
      rssBytes: rssSample.rssBytes,
      startupRssBytes: this.startupRssBytes,
      peakRssBytes: this.peakRssBytes,
      lastRssSampleAt: this.lastRssSampleAt,
      rssSampleSource: rssSample.source,
      ...(rssSample.error ? { rssSampleError: rssSample.error } : {}),
      sqlWorker: this.sqlWorker.getStats(),
    };
  }

  private sampleRss(): { rssBytes: number | null; source: TraceProcessorRuntimeStats['rssSampleSource']; error?: string } {
    const pid = this.process?.pid;
    const rssSample = pid ? readProcessRssBytes(pid) : null;
    this.lastRssBytes = rssSample?.rssBytes ?? null;
    this.lastRssSampleSource = rssSample?.source ?? 'unavailable';
    this.lastRssSampleError = rssSample?.error;
    this.lastRssSampleAt = Date.now();
    if (this.lastRssBytes !== null) {
      if (this.startupRssBytes === null) this.startupRssBytes = this.lastRssBytes;
      this.peakRssBytes = Math.max(this.peakRssBytes ?? 0, this.lastRssBytes);
    }
    return {
      rssBytes: this.lastRssBytes,
      source: this.lastRssSampleSource,
      ...(this.lastRssSampleError ? { error: this.lastRssSampleError } : {}),
    };
  }

  constructor(traceId: string, tracePath: string, options: TraceProcessorCreateOptions = {}) {
    super();
    this.id = uuidv4();
    this.traceId = traceId;
    this.tracePath = tracePath;
    this.processorKey = options.processorKey ?? traceId;
    this.leaseId = options.leaseId;
    this.leaseMode = options.leaseMode ?? 'shared';

    // Allocate port from pool
    this._httpPort = getPortPool().allocate(this.processorKey);
    this.sqlWorker = new TraceProcessorSqlWorker({
      processorId: this.id,
      traceId: this.traceId,
      processorKey: this.processorKey,
      port: this._httpPort,
    });
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
    const envOverridePath = resolveEnvTraceProcessorPath();
    const binarySelection = Object.freeze({
      source: 'local_binary' as const,
      selectedPath: traceProcessorPath,
      selectionOrigin: envOverridePath === traceProcessorPath
        ? 'env_override' as const
        : 'default' as const,
    });
    this.runtimeBinarySelection = binarySelection;
    if (!fs.existsSync(traceProcessorPath)) {
      throw new Error(`trace_processor_shell not found at: ${traceProcessorPath}`);
    }

    if (this.isDestroyed) {
      throw new Error('Processor destroyed during initialization');
    }

    // Start trace_processor_shell in HTTP mode
    try {
      await this.startHttpServer(binarySelection);

      // Verify server is working with a test query
      console.log(`[TraceProcessor] Verifying server with test query...`);
      const testResult = await this.executeHttpQuery('SELECT 1 as test', { priority: 'p1' });

      if (testResult.error) {
        throw new Error(`Server verification failed: ${testResult.error}`);
      }
      this.sampleRss();

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
  private async startHttpServer(binarySelection: Readonly<{
    source: 'local_binary';
    selectedPath: string;
    selectionOrigin: 'default' | 'env_override';
  }>): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build CORS origins string from config
      const corsOrigins = `${traceProcessorConfig.perfettoUiOrigin},${traceProcessorConfig.perfettoUiOrigin.replace('localhost', '127.0.0.1')}`;
      const args = [
        '--httpd',
        '--http-port', String(this.httpPort),
        // Only pass --http-additional-cors-origins when supported (added after v47);
        // older binaries (≤v47) don't enforce CORS and exit with code 1 on unknown flags.
        ...(supportsTraceProcessorCorsOriginsFlag(binarySelection.selectedPath) ? ['--http-additional-cors-origins', corsOrigins] : []),
        this.tracePath
      ];

      const traceProcessorPath = binarySelection.selectedPath;
      console.log(`[TraceProcessor] Starting: ${traceProcessorPath} ${args.join(' ')}`);

      this.process = spawn(traceProcessorPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const startupTimeoutMs = resolveTraceProcessorStartupTimeoutMs(
        fs.statSync(this.tracePath).size,
      );
      // Timeout includes trace parsing before the HTTP ready line is emitted.
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Server startup timeout. stdout: ${stdout}, stderr: ${stderr}`));
        }
      }, startupTimeoutMs);

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

  async query(sql: string, options: TraceProcessorQueryOptions = {}): Promise<QueryResult> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    if (this.status !== 'ready') {
      throw new Error(`Trace processor not ready (status: ${this.status})`);
    }

    if (!this.serverReady) {
      throw new Error('HTTP server not ready');
    }

    // Sequential stdlib loading on first query.
    // Each module gets its own HTTP request (bounded by the configured query timeout),
    // unlike the previous bulk approach that concatenated all 22 INCLUDEs into one
    // request which timed out on large (200MB+) traces.
    if (!this._criticalModulesLoaded
        && this._criticalModulesLoadFailures < WorkingTraceProcessor.MAX_STDLIB_LOAD_RETRIES
        && !this._criticalModulesLoadPromise) {
      this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();
    }
    if (this._criticalModulesLoadPromise) {
      await raceWithTraceProcessorCancellation(this._criticalModulesLoadPromise, options.signal);
    }
    throwIfTraceProcessorQueryCancelled(options.signal);

    logger.sql('TraceProcessor', sql);
    return this.enqueueHttpQuery(sql, options);
  }

  async queryBounded(
    sql: string,
    options: TraceProcessorBoundedQueryOptions,
  ): Promise<QueryResult> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    if (this.status !== 'ready') {
      throw new Error(`Trace processor not ready (status: ${this.status})`);
    }
    if (!this.serverReady) {
      throw new Error('HTTP server not ready');
    }

    if (!this._criticalModulesLoaded
        && this._criticalModulesLoadFailures < WorkingTraceProcessor.MAX_STDLIB_LOAD_RETRIES
        && !this._criticalModulesLoadPromise) {
      this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();
    }
    if (this._criticalModulesLoadPromise) {
      await raceWithTraceProcessorCancellation(this._criticalModulesLoadPromise, options.signal);
    }
    throwIfTraceProcessorQueryCancelled(options.signal);

    logger.sql('TraceProcessor', sql);
    this._activeQueries++;
    try {
      return await this.sqlWorker.queryBounded(sql, {
        ...options,
        timeoutMs: options.timeoutMs ?? traceProcessorConfig.queryTimeoutMs,
      });
    } finally {
      this._activeQueries--;
    }
  }

  async queryRaw(body: Buffer, options: TraceProcessorQueryOptions = {}): Promise<Buffer> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    if (this.status !== 'ready') {
      throw new Error(`Trace processor not ready (status: ${this.status})`);
    }

    if (!this.serverReady) {
      throw new Error('HTTP server not ready');
    }

    this._activeQueries++;
    try {
      return await this.sqlWorker.enqueueRaw(body, options);
    } finally {
      this._activeQueries--;
    }
  }

  async queryHealth(
    timeoutMs = traceProcessorConfig.healthQueryTimeoutMs,
  ): Promise<TraceProcessorHealthProbeResult> {
    return probeDedicatedHealthQuery(this.httpPort, timeoutMs);
  }

  async checkHealth(
    options: TraceProcessorHealthCheckOptions = {},
  ): Promise<TraceProcessorHealthStatus> {
    const liveness = this.checkProcessLiveness();
    const rpcAccept = await probeTcpAccept(
      this.httpPort,
      options.rpcAcceptTimeoutMs ?? traceProcessorConfig.healthRpcAcceptTimeoutMs,
    );
    const queryResponsive = await this.queryHealth(
      options.queryTimeoutMs ?? traceProcessorConfig.healthQueryTimeoutMs,
    );
    return {
      ok: liveness.ok && rpcAccept.ok && queryResponsive.ok,
      checkedAt: new Date().toISOString(),
      processorId: this.id,
      traceId: this.traceId,
      httpPort: this.httpPort,
      liveness,
      rpcAccept,
      queryResponsive,
    };
  }

  private checkProcessLiveness(): TraceProcessorHealthProbeResult {
    const startTime = Date.now();
    const pid = this.process?.pid;
    if (!pid) {
      return probeError(startTime, new Error('No trace_processor pid'));
    }
    try {
      process.kill(pid, 0);
      return probeOk(startTime);
    } catch (error) {
      return probeError(startTime, error);
    }
  }

  private async enqueueHttpQuery(sql: string, options: TraceProcessorQueryOptions): Promise<QueryResult> {
    this._activeQueries++;
    try {
      return await this.executeHttpQuery(sql, options);
    } finally {
      this._activeQueries--;
    }
  }

  /**
   * Load critical stdlib modules one at a time in the background.
   * With only 3 Tier-0 modules this completes in a few seconds,
   * well within the configured query timeout per module.
   */
  private async _loadCriticalModulesSequentially(): Promise<void> {
    this._activeQueries++;
    const startTime = Date.now();
    let loaded = 0;
    let failed = 0;
    try {
      for (const m of CRITICAL_STDLIB_MODULES) {
        if (this.isDestroyed) break;
        const result = await this.enqueueHttpQuery(`INCLUDE PERFETTO MODULE ${m};`, { priority: 'p1' });
        if (result.error) {
          failed++;
          if (!result.error.includes('not found') && !result.error.includes('no such')) {
            console.warn(
              `[TraceProcessor] Failed to load stdlib module ${m}: ${diagnosticLogIdentity(result.error, {domain: 'trace_processor', classifier: 'sql'})}`,
            );
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
  private async executeHttpQuery(
    sql: string,
    options: TraceProcessorQueryOptions = {},
  ): Promise<QueryResult> {
    const result = await this.sqlWorker.query(sql, {
      ...options,
      timeoutMs: options.timeoutMs ?? traceProcessorConfig.queryTimeoutMs,
    });
    if (result.error === 'Query timeout') {
      logger.warn(
        'TraceProcessor',
        `Query exceeded ${traceProcessorConfig.queryTimeoutMs}ms; aborting request for processor ${this.id}`,
      );
    } else if (result.error && !options.suppressErrorLog) {
      logger.warn('TraceProcessor', `Query error: ${diagnosticLogIdentity(result.error, {domain: 'trace_processor', classifier: 'sql'})}`);
    } else if (result.error) {
      logger.debug('TraceProcessor', `Suppressed query error: ${diagnosticLogIdentity(result.error, {domain: 'trace_processor', classifier: 'sql'})}`);
    } else {
      logger.debug('TraceProcessor', `Query returned ${result.rows.length} rows in ${result.durationMs}ms`);
    }
    return result;
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
        const queryResult = await this.executeHttpQuery(`INCLUDE PERFETTO MODULE ${moduleName};`, { priority: 'p2' });
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
    this.sqlWorker.destroy();

    if (this.process) {
      try {
        const processorKey = this.processorKey;
        const proc = this.process;
        let released = false;
        const releasePortOnce = (): void => {
          if (released) return;
          released = true;
          getPortPool().release(processorKey);
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
        getPortPool().release(this.processorKey);
      }
      this.process = null;
    } else {
      // No process, but still release port
      getPortPool().release(this.processorKey);
    }

    this.removeAllListeners();
  }
}

/**
 * Factory for creating trace processors
 */
type ManagedTraceProcessor = WorkingTraceProcessor | ExternalRpcProcessor;

export function isTraceProcessorEvictionCandidate(
  processor: ManagedTraceProcessor,
  hasActiveLeaseHolders = false,
): boolean {
  return (
    processor instanceof WorkingTraceProcessor &&
    processor.activeQueries === 0 &&
    !processor.getRuntimeStats().leaseId &&
    !hasActiveLeaseHolders
  );
}

export class TraceProcessorFactory {
  private static processors: Map<string, ManagedTraceProcessor> = new Map();
  private static externalProcessorsByPort: Map<number, ExternalRpcProcessor> = new Map();
  private static maxProcessors = 5;

  static async create(
    traceId: string,
    tracePath: string,
    options: TraceProcessorCreateOptions = {},
  ): Promise<WorkingTraceProcessor> {
    const processorKey = options.processorKey ?? traceId;
    // Check if processor already exists and is ready
    const existing = this.processors.get(processorKey);
    if (existing instanceof WorkingTraceProcessor && existing.status === 'ready') {
      console.log(`[TraceProcessorFactory] Reusing existing processor for trace ${traceId} (${processorKey})`);
      return existing;
    }

    // Clean up failed processor if exists
    if (existing) {
      console.log(`[TraceProcessorFactory] Cleaning up existing processor for trace ${traceId} (${processorKey})`);
      this.remove(processorKey);
    }

    // Clean up oldest unleased idle processors if too many. A UI WebSocket does
    // not increment activeQueries, so lease-backed processors must be preserved.
    while (this.processors.size >= this.maxProcessors) {
      const idle = Array.from(this.processors.entries())
        .find(([, processor]) => {
          const traceIdHasActiveLeaseHolders =
            processor instanceof WorkingTraceProcessor &&
            getTraceProcessorLeaseStore().hasActiveHoldersForTrace(processor.traceId);
          return isTraceProcessorEvictionCandidate(processor, traceIdHasActiveLeaseHolders);
        });
      if (idle) {
        console.log(`[TraceProcessorFactory] Cleaning up idle processor: ${idle[0]}`);
        idle[1].destroy();
        this.processors.delete(idle[0]);
      } else {
        // All candidates are busy or lease-backed. RAM admission remains the
        // authoritative guard for a temporary process-count overage.
        console.warn(`[TraceProcessorFactory] All ${this.processors.size} processors are busy or leased, allowing temporary over-limit`);
        break;
      }
    }

    const traceSizeBytes = fs.statSync(tracePath).size;
    assertTraceProcessorAdmission({
      traceId,
      traceSizeBytes,
      processors: Array.from(this.processors.values()).map(processor => processor.getRuntimeStats()),
    });

    const maxAttempts = 8;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Create new processor (allocates a port from the pool)
      console.log(`[TraceProcessorFactory] Creating new HTTP-mode processor for trace ${traceId} (${processorKey}) (attempt ${attempt}/${maxAttempts})`);
      const processor = new WorkingTraceProcessor(traceId, tracePath, {
        ...options,
        processorKey,
      });

      processor.on('error', () => {
        this.processors.delete(processorKey);
      });

      this.processors.set(processorKey, processor);

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
        this.processors.delete(processorKey);

        // Retry with a different port if the chosen port is already in use by another process.
        const msg = String(error?.message || '');
        if (msg.startsWith('PORT_IN_USE:')) {
          const portStr = msg.split(':')[1];
          const port = Number(portStr);
          if (Number.isFinite(port)) {
            getPortPool().blockPort(port);
          } else {
            // Fallback: release any allocation for this processor key so next attempt can allocate again.
            getPortPool().release(processorKey);
          }
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Failed to create trace processor');
  }

  static get(processorKey: string): ManagedTraceProcessor | undefined {
    return this.processors.get(processorKey);
  }

  static hasProcessorReference(processor: ManagedTraceProcessor): boolean {
    return Array.from(this.processors.values()).some(candidate => candidate === processor);
  }

  static remove(processorKey: string): boolean {
    const processor = this.processors.get(processorKey);
    if (processor) {
      console.log(`[TraceProcessorFactory] Removing processor ${processorKey}`);
      this.processors.delete(processorKey);
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

  static getStats(): {
    count: number;
    traceIds: string[];
    processorKeys: string[];
    processors: TraceProcessorRuntimeStats[];
    ramBudget: TraceProcessorRamBudgetStats;
  } {
    const processors = Array.from(this.processors.values()).map(processor => processor.getRuntimeStats());
    return {
      count: this.processors.size,
      traceIds: Array.from(new Set(processors.map(processor => processor.traceId))),
      processorKeys: Array.from(this.processors.keys()),
      processors,
      ramBudget: getTraceProcessorRamBudgetStats(processors),
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

    // Verify connection with a dedicated health query — avoid triggering lazy
    // stdlib load or the main SQL worker queue at registration time.
    try {
      const health = await processor.queryHealth(traceProcessorConfig.healthQueryTimeoutMs);
      if (!health.ok) {
        throw new Error(health.error || 'Health query failed');
      }
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
  private readonly sqlWorker: TraceProcessorSqlWorker;
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

  public getRuntimeStats(): TraceProcessorRuntimeStats {
    return {
      kind: 'external_rpc',
      processorId: this.id,
      traceId: this.traceId,
      status: this.status,
      activeQueries: this.activeQueries,
      httpPort: this.httpPort,
      rssBytes: null,
      rssSampleSource: 'external',
      sqlWorker: this.sqlWorker.getStats(),
    };
  }

  constructor(traceId: string, port: number) {
    super();
    this.id = `external-${port}`;
    this.traceId = traceId;
    this._httpPort = port;
    this.sqlWorker = new TraceProcessorSqlWorker({
      processorId: this.id,
      traceId: this.traceId,
      processorKey: this.traceId,
      port: this._httpPort,
      forceInline: IS_TEST_ENV,
      rawExecutor: IS_TEST_ENV
        ? async (request) => {
          const sql = decodeQueryArgsSql(request.body);
          const result = await this._execRaw(sql);
          return encodeQueryResult({
            columnNames: result.columns,
            rows: result.rows,
            ...(result.error ? { error: result.error } : {}),
          });
        }
        : undefined,
    });
    console.log(`[ExternalRpcProcessor] Created for trace ${traceId} on port ${port}`);
  }

  async query(sql: string, options: TraceProcessorQueryOptions = {}): Promise<QueryResult> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    // Sequential stdlib loading on first query (same pattern as WorkingTraceProcessor).
    if (!this._criticalModulesLoaded
        && this._criticalModulesLoadFailures < ExternalRpcProcessor.MAX_STDLIB_LOAD_RETRIES
        && !this._criticalModulesLoadPromise) {
      this._criticalModulesLoadPromise = this._loadCriticalModulesSequentially();
    }
    if (this._criticalModulesLoadPromise) {
      await raceWithTraceProcessorCancellation(this._criticalModulesLoadPromise, options.signal);
    }
    throwIfTraceProcessorQueryCancelled(options.signal);

    return this.enqueueRawQuery(sql, options);
  }

  async queryRaw(body: Buffer, options: TraceProcessorQueryOptions = {}): Promise<Buffer> {
    throwIfTraceProcessorQueryCancelled(options.signal);
    this._activeQueries++;
    try {
      return await this.sqlWorker.enqueueRaw(body, options);
    } finally {
      this._activeQueries--;
    }
  }

  async queryHealth(
    timeoutMs = traceProcessorConfig.healthQueryTimeoutMs,
  ): Promise<TraceProcessorHealthProbeResult> {
    return probeDedicatedHealthQuery(this.httpPort, timeoutMs);
  }

  async checkHealth(
    options: TraceProcessorHealthCheckOptions = {},
  ): Promise<TraceProcessorHealthStatus> {
    const startTime = Date.now();
    const liveness = probeOk(startTime, 'external_rpc_no_owned_process');
    const rpcAccept = await probeTcpAccept(
      this.httpPort,
      options.rpcAcceptTimeoutMs ?? traceProcessorConfig.healthRpcAcceptTimeoutMs,
    );
    const queryResponsive = await this.queryHealth(
      options.queryTimeoutMs ?? traceProcessorConfig.healthQueryTimeoutMs,
    );
    return {
      ok: liveness.ok && rpcAccept.ok && queryResponsive.ok,
      checkedAt: new Date().toISOString(),
      processorId: this.id,
      traceId: this.traceId,
      httpPort: this.httpPort,
      liveness,
      rpcAccept,
      queryResponsive,
    };
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
        const result = await this.enqueueRawQuery(`INCLUDE PERFETTO MODULE ${m};`, { priority: 'p1' });
        if (result.error) {
          failed++;
          if (!result.error.includes('not found') && !result.error.includes('no such')) {
            console.warn(
              `[ExternalRpcProcessor] Failed to load stdlib module ${m}: ${diagnosticLogIdentity(result.error, {domain: 'trace_processor', classifier: 'sql'})}`,
            );
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

  private async enqueueRawQuery(
    sql: string,
    options: TraceProcessorQueryOptions = {},
  ): Promise<QueryResult> {
    this._activeQueries++;
    try {
      return await this.sqlWorker.query(sql, {
        ...options,
        timeoutMs: options.timeoutMs ?? traceProcessorConfig.queryTimeoutMs,
      });
    } finally {
      this._activeQueries--;
    }
  }

  /** Low-level query without stdlib lazy-load. Used by factory for connectivity checks. */
  _execRaw(sql: string, options: TraceProcessorQueryOptions = {}): Promise<QueryResult> {
    return executeTraceProcessorHttpRpcSql({
      port: this._httpPort,
      sql,
      timeoutMs: options.timeoutMs ?? traceProcessorConfig.queryTimeoutMs,
    });
  }

  destroy(): void {
    // External RPC processor doesn't own the process, so nothing to clean up
    console.log(`[ExternalRpcProcessor] Destroyed (trace ${this.traceId})`);
    this.status = 'error';
    this.sqlWorker.destroy();
    this.emit('destroyed');
  }
}
