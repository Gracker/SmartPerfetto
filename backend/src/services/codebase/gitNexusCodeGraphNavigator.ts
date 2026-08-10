// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {execFile} from 'child_process';
import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  type CodebaseRef,
  type CodebaseRegistry,
  type CodebaseScope,
} from './codebaseRegistry';
import {PathSecurityGate} from './pathSecurityGate';
import {
  assertCodebaseRootIdentity,
  codebaseSourcePathMatches,
} from '../rag/sourceFileSelection';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_PROCESSES = 10;
const GITNEXUS_TIMEOUT_MS = 3_000;
const GITNEXUS_MAX_BUFFER_BYTES = 1024 * 1024;

export interface CodeGraphReference {
  referenceId: string;
  codebaseId: string;
  filePath: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  kind?: string;
}

export interface CodeGraphProcessSummary {
  name: string;
  kind?: string;
  summary?: string;
}

export interface CodeGraphMetadata {
  engine: 'gitnexus';
  freshness: 'current' | 'stale' | 'unknown';
  verificationRequired: true;
}

export interface CodeGraphNavigationResult {
  success: boolean;
  codebaseId: string;
  references: CodeGraphReference[];
  processes: CodeGraphProcessSummary[];
  graph: CodeGraphMetadata;
  truncated: boolean;
  unsupportedReason?: string;
}

export interface CodeGraphNavigator {
  query(input: {
    codebaseId: string;
    scope: CodebaseScope;
    query: string;
    limit?: number;
  }): Promise<CodeGraphNavigationResult>;
  inspectSymbol(input: {
    codebaseId: string;
    scope: CodebaseScope;
    symbol: string;
    filePath?: string;
    limit?: number;
  }): Promise<CodeGraphNavigationResult>;
}

export interface GitNexusCodeGraphNavigatorOptions {
  registry: CodebaseRegistry;
  gate?: PathSecurityGate;
  command?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

type RegisteredCodebase = CodebaseRef & {lifecycleState?: 'active' | 'deleting'};

interface GitNexusExecution {
  success: boolean;
  stdout: string;
  unsupportedReason?: string;
}

function boundedLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIMIT) {
    throw new Error('limit_invalid');
  }
  return resolved;
}

function boundedText(value: string, field: 'query' | 'symbol'): string {
  const max = field === 'query' ? 512 : 256;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || trimmed.includes('\0')) {
    throw new Error(`${field}_invalid`);
  }
  return trimmed;
}

function referenceId(codebaseId: string, filePath: string, line: number, symbol?: string): string {
  return `graph_${createHash('sha256')
    .update(`${codebaseId}\0${filePath}\0${line}\0${symbol ?? ''}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const allowedKeys = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'GIT_EXEC_PATH',
    'GITNEXUS_HOME',
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !allowedKeys.has(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function execFileUtf8(
  command: string,
  args: readonly string[],
  options: {cwd?: string; timeout: number; maxBuffer: number},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: sanitizedEnv(),
        encoding: 'utf8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseJson(stdout: string): unknown | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    const first = stdout.split(/\r?\n/).find(line => line.trim().startsWith('{') || line.trim().startsWith('['));
    if (!first) return undefined;
    try {
      return JSON.parse(first);
    } catch {
      return undefined;
    }
  }
}

function candidateArrays(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  for (const key of ['results', 'hits', 'items', 'references', 'symbols', 'matches']) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [value];
}

function readNestedString(object: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ['path', 'file', 'filePath', 'relativePath', 'text']) {
        if (typeof nested[nestedKey] === 'string') return nested[nestedKey] as string;
      }
    }
  }
  return undefined;
}

function readLineRange(object: Record<string, unknown>): {start: number; end: number} | undefined {
  const rawRange = object.lineRange ?? object.range ?? object.location;
  if (rawRange && typeof rawRange === 'object' && !Array.isArray(rawRange)) {
    const range = rawRange as Record<string, unknown>;
    const start = Number(range.start ?? range.startLine ?? range.line ?? range.lineNumber);
    const end = Number(range.end ?? range.endLine ?? range.line ?? range.lineNumber ?? start);
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) {
      return {start, end};
    }
  }
  const line = Number(object.line ?? object.lineNumber ?? object.line_number ?? object.startLine);
  const end = Number(object.endLine ?? object.end_line ?? line);
  if (Number.isInteger(line) && Number.isInteger(end) && line > 0 && end >= line) {
    return {start: line, end};
  }
  return undefined;
}

function walkObjects(
  value: unknown,
  visit: (object: Record<string, unknown>) => void,
  budget: {remaining: number} = {remaining: 200},
): void {
  if (budget.remaining <= 0 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (budget.remaining <= 0) break;
      walkObjects(item, visit, budget);
    }
    return;
  }
  budget.remaining -= 1;
  const object = value as Record<string, unknown>;
  visit(object);
  for (const nested of Object.values(object).slice(0, 40)) {
    walkObjects(nested, visit, budget);
  }
}

function sanitizeProcessText(root: string, value: string | undefined): string | undefined {
  return value
    ?.split(root).join('[registered-root]')
    .replace(/[A-Za-z]:[\\/][^\s,;]+|\/[^\s,;]+/g, '[path]');
}

export class GitNexusCodeGraphNavigator implements CodeGraphNavigator {
  private readonly registry: CodebaseRegistry;
  private readonly gate: PathSecurityGate;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: GitNexusCodeGraphNavigatorOptions) {
    this.registry = options.registry;
    this.gate = options.gate ?? new PathSecurityGate();
    this.command = options.command ?? 'gitnexus';
    this.timeoutMs = options.timeoutMs ?? GITNEXUS_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? GITNEXUS_MAX_BUFFER_BYTES;
  }

  async query(input: {
    codebaseId: string;
    scope: CodebaseScope;
    query: string;
    limit?: number;
  }): Promise<CodeGraphNavigationResult> {
    const query = boundedText(input.query, 'query');
    const limit = boundedLimit(input.limit);
    const resolved = await this.resolveRoot(input.codebaseId, input.scope);
    if (!resolved.success) return resolved.result;
    return this.runGitNexus(
      resolved.ref,
      resolved.root,
      ['query', '--repo', resolved.root, `--query=${query}`, '--limit', String(limit)],
      limit,
    );
  }

  async inspectSymbol(input: {
    codebaseId: string;
    scope: CodebaseScope;
    symbol: string;
    filePath?: string;
    limit?: number;
  }): Promise<CodeGraphNavigationResult> {
    const symbol = boundedText(input.symbol, 'symbol');
    const limit = boundedLimit(input.limit);
    const resolved = await this.resolveRoot(input.codebaseId, input.scope);
    if (!resolved.success) return resolved.result;
    const args = ['context', '--repo', resolved.root];
    if (input.filePath) {
      const filePath = this.gate.validateRelativeSourcePath(input.filePath);
      if (!codebaseSourcePathMatches(resolved.ref, filePath)) {
        return this.unsupported(input.codebaseId, 'source_path_outside_registered_filters');
      }
      args.push(`--file=${filePath}`);
    }
    args.push('--limit', String(limit), '--', symbol);
    return this.runGitNexus(resolved.ref, resolved.root, args, limit);
  }

  private async resolveRoot(
    codebaseId: string,
    scope: CodebaseScope,
  ): Promise<
    | {success: true; ref: RegisteredCodebase; root: string}
    | {success: false; result: CodeGraphNavigationResult}
  > {
    const ref = this.registry.get(codebaseId, scope) as RegisteredCodebase | undefined;
    if (!ref) return {success: false, result: this.unsupported(codebaseId, 'codebase_not_found')};
    if ((ref.lifecycleState ?? 'active') !== 'active') {
      return {success: false, result: this.unsupported(codebaseId, 'codebase_deleting')};
    }
    let root: string;
    try {
      root = await this.gate.validateRoot(
        ref.rootRealpath,
        ref.rootAuthorization === 'native_picker'
          ? {additionalAllowlistRoots: [ref.rootRealpath]}
          : undefined,
      );
      assertCodebaseRootIdentity(ref.rootRealpath, root);
    } catch {
      return {success: false, result: this.unsupported(codebaseId, 'codebase_root_unavailable')};
    }
    if (!fs.existsSync(path.join(root, '.gitnexus'))) {
      return {success: false, result: this.unsupported(codebaseId, 'missing_gitnexus_index')};
    }
    return {success: true, ref, root};
  }

  private runGitNexus(
    ref: RegisteredCodebase,
    root: string,
    args: readonly string[],
    limit: number,
  ): Promise<CodeGraphNavigationResult> {
    return new Promise(resolve => {
      execFile(
        this.command,
        [...args],
        {
          cwd: root,
          env: sanitizedEnv(),
          encoding: 'utf8',
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
        },
        async (error, stdout) => {
          const execution = this.classifyExecution(error, stdout);
          if (!execution.success) {
            resolve(this.unsupported(ref.codebaseId, execution.unsupportedReason ?? 'gitnexus_unavailable'));
            return;
          }
          const parsed = parseJson(execution.stdout);
          if (parsed === undefined) {
            resolve(this.unsupported(ref.codebaseId, 'malformed_gitnexus_json'));
            return;
          }
          const freshness = await this.detectFreshness(root);
          const references = this.collectReferences(ref, root, parsed, limit);
          const processes = this.collectProcesses(ref, root, parsed);
          resolve({
            success: true,
            codebaseId: ref.codebaseId,
            references,
            processes,
            graph: {engine: 'gitnexus', freshness, verificationRequired: true},
            truncated: references.length >= limit || processes.length >= MAX_PROCESSES,
          });
        },
      );
    });
  }

  private classifyExecution(error: unknown, stdout: string): GitNexusExecution {
    if (!error) return {success: true, stdout};
    const err = error as NodeJS.ErrnoException & {killed?: boolean; signal?: string};
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      return {success: false, stdout: '', unsupportedReason: 'missing_gitnexus_binary'};
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return {success: false, stdout: '', unsupportedReason: 'gitnexus_timeout'};
    }
    return {success: false, stdout: '', unsupportedReason: 'gitnexus_nonzero_exit'};
  }

  private async detectFreshness(root: string): Promise<CodeGraphMetadata['freshness']> {
    let indexedRevision: string | undefined;
    try {
      const metaPath = path.join(root, '.gitnexus', 'meta.json');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      indexedRevision = safeString(
        meta.lastCommit ?? meta.indexedCommit ?? meta.indexed_commit ?? meta.commit ?? meta.commitHash ?? meta.head,
        80,
      );
    } catch {
      return 'unknown';
    }
    if (!indexedRevision) return 'unknown';
    try {
      const dirty = await execFileUtf8(
        'git',
        ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.'],
        {
          timeout: 1_000,
          maxBuffer: 128 * 1024,
        },
      );
      if (dirty.trim()) return 'stale';
      const head = (await execFileUtf8('git', ['-C', root, 'rev-parse', 'HEAD'], {
        timeout: 1_000,
        maxBuffer: 1024,
      })).trim();
      return head === indexedRevision ? 'current' : 'stale';
    } catch {
      return 'unknown';
    }
  }

  private collectReferences(
    ref: RegisteredCodebase,
    root: string,
    parsed: unknown,
    limit: number,
  ): CodeGraphReference[] {
    const references: CodeGraphReference[] = [];
    const seen = new Set<string>();
    const collect = (object: Record<string, unknown>): void => {
      if (references.length >= limit) return;
      const rawPath = readNestedString(object, ['filePath', 'file_path', 'relativePath', 'path', 'file']);
      const filePath = rawPath ? this.sanitizeFilePath(ref, root, rawPath) : undefined;
      if (!filePath) return;
      const lineRange = readLineRange(object);
      const symbol = sanitizeProcessText(root, safeString(object.symbol ?? object.name ?? object.qualifiedName, 160));
      const kind = sanitizeProcessText(root, safeString(object.kind ?? object.type, 60));
      const line = lineRange?.start ?? 1;
      const key = `${filePath}:${line}:${symbol ?? ''}:${kind ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      references.push({
        referenceId: referenceId(ref.codebaseId, filePath, line, symbol),
        codebaseId: ref.codebaseId,
        filePath,
        ...(lineRange ? {lineRange} : {}),
        ...(symbol ? {symbol} : {}),
        ...(kind ? {kind} : {}),
      });
    };
    const budget = {remaining: 200};
    for (const item of candidateArrays(parsed)) {
      walkObjects(item, collect, budget);
      if (references.length >= limit) break;
    }
    return references;
  }

  private sanitizeFilePath(
    ref: RegisteredCodebase,
    root: string,
    rawPath: string,
  ): string | undefined {
    let candidate = rawPath.trim();
    if (!candidate || candidate.includes('\0')) return undefined;
    if (path.isAbsolute(candidate)) {
      const relative = path.relative(root, candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
      candidate = relative;
    }
    try {
      const filePath = this.gate.validateRelativeSourcePath(candidate);
      return codebaseSourcePathMatches(ref, filePath) ? filePath : undefined;
    } catch {
      return undefined;
    }
  }

  private collectProcesses(
    ref: RegisteredCodebase,
    root: string,
    parsed: unknown,
  ): CodeGraphProcessSummary[] {
    if ((ref.pathFilters?.length ?? 0) > 0 || (ref.excludeGlobs?.length ?? 0) > 0) {
      return [];
    }
    const processes: CodeGraphProcessSummary[] = [];
    const seen = new Set<string>();
    const push = (object: Record<string, unknown>): void => {
      if (processes.length >= MAX_PROCESSES) return;
      const id = safeString(object.id ?? object.process_id ?? object.processId, 140);
      const processId = id?.startsWith('proc_') ? id : undefined;
      const processName = sanitizeProcessText(
        root,
        safeString(
          object.process ?? object.processName ?? object.name ?? object.summary ?? object.label ?? processId,
          120,
        ),
      );
      if (!processName) return;
      const hasProcessSignal = object.process !== undefined ||
        object.processName !== undefined ||
        object.process_id !== undefined ||
        object.processId !== undefined ||
        object.processType !== undefined ||
        object.process_type !== undefined ||
        processId !== undefined ||
        object.step_count !== undefined ||
        object.stepCount !== undefined ||
        object.earliest_broken_step !== undefined ||
        object.total_hits !== undefined;
      if (!hasProcessSignal) return;
      const summary = safeString(object.summary ?? object.description ?? object.label, 180);
      const sanitizedSummary = sanitizeProcessText(root, summary);
      const kind = sanitizeProcessText(
        root,
        safeString(object.kind ?? object.type ?? object.processType ?? object.process_type, 60),
      );
      const key = `${processName}:${kind ?? ''}:${sanitizedSummary ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      processes.push({
        name: processName,
        ...(kind ? {kind} : {}),
        ...(sanitizedSummary ? {summary: sanitizedSummary} : {}),
      });
    };
    walkObjects(parsed, push);
    return processes;
  }

  private unsupported(
    codebaseId: string,
    unsupportedReason: string,
  ): CodeGraphNavigationResult {
    return {
      success: false,
      codebaseId,
      references: [],
      processes: [],
      graph: {engine: 'gitnexus', freshness: 'unknown', verificationRequired: true},
      truncated: false,
      unsupportedReason,
    };
  }
}
