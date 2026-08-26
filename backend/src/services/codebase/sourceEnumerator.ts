// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawn} from 'child_process';
import type {Dirent} from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import type {PathSecurityGate} from './pathSecurityGate';
import {
  readBoundedMetadataFile,
  SourceMetadataDeadlineExceededError,
} from './boundedMetadataFile';
import {
  hardenedGitEnvironment,
  hardenedGitPrefixArguments,
  hardenedRipgrepEnvironment,
  hardenedRipgrepPrefixArguments,
} from './subprocessHardening';
import {
  sourceSelectionAdmits,
  sourceSelectionGitPathspecs,
  sourceSelectionRipgrepArguments,
  type SourceSelectionIR,
} from './sourceSelectionPolicy';

export interface EnumerationResult {
  backend: 'ripgrep' | 'git' | 'node-walk';
  fidelity: 'exact' | 'degraded';
  files: Array<{relativePath: string; sizeBytes: number}>;
  enumerationComplete: boolean;
  deterministic: boolean;
  incompleteReason?: 'enumeration_budget' | 'time_budget' | 'traversal_error' | 'backend_degraded';
  skipped: Array<{relativePath: string; reason: string}>;
  skippedCount: number;
}

export interface SourceEnumeratorOptions {
  platform?: NodeJS.Platform;
  ripgrepPath?: string;
  gitPath?: string;
  maxVisitedEntries?: number;
  maxDirectories?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxSkippedDiagnostics?: number;
}

interface CollectedPaths {
  paths: string[];
  complete: boolean;
  reason?: EnumerationResult['incompleteReason'];
  stderrObserved: boolean;
}

interface GitSubmodulePaths {
  paths: string[];
  complete: boolean;
  reason?: 'time_budget' | 'traversal_error';
}

interface CandidateInspection {
  file?: {relativePath: string; sizeBytes: number};
  reason?: string;
  traversalError: boolean;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function pathHasPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function directoryCanContain(
  directory: string,
  policy: SourceSelectionIR,
  platform: NodeJS.Platform,
): boolean {
  const comparable = (value: string): string => platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  const comparableDirectory = comparable(directory);
  const hardExcludes = new Set(policy.hardExcludeDirs.map(comparable));
  const segments = comparableDirectory.split('/').filter(Boolean);
  if (segments.some(segment => hardExcludes.has(segment))) return false;
  if (policy.includePrefixes.length === 0) return true;
  return policy.includePrefixes.map(comparable).some(prefix =>
    pathHasPrefix(comparableDirectory, prefix) || pathHasPrefix(prefix, comparableDirectory));
}

export class SourceEnumerator {
  private readonly platform: NodeJS.Platform;
  private readonly ripgrepPath: string;
  private readonly gitPath: string;
  private readonly maxVisitedEntries: number;
  private readonly maxDirectories: number;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs?: number;
  private readonly maxSkippedDiagnostics: number;

  constructor(options: SourceEnumeratorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.ripgrepPath = options.ripgrepPath ?? 'rg';
    this.gitPath = options.gitPath ?? 'git';
    this.maxVisitedEntries = options.maxVisitedEntries ?? 200_000;
    this.maxDirectories = options.maxDirectories ?? 50_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs;
    this.maxSkippedDiagnostics = options.maxSkippedDiagnostics ?? 100;
  }

  async enumerate(input: {
    rootRealpath: string;
    policy: SourceSelectionIR;
    gate: PathSecurityGate;
    additionalAllowlistRoots?: readonly string[];
    expectedRootRealpath?: string;
  }): Promise<EnumerationResult> {
    const root = await input.gate.validateRoot(input.rootRealpath, input.additionalAllowlistRoots
      ? {additionalAllowlistRoots: input.additionalAllowlistRoots}
      : undefined);
    const requestedRealpath = input.expectedRootRealpath ?? await fsPromises.realpath(input.rootRealpath);
    const normalizeIdentity = (value: string): string => this.platform === 'win32'
      ? path.resolve(value).toLocaleLowerCase('en-US')
      : path.resolve(value);
    if (normalizeIdentity(root) !== normalizeIdentity(requestedRealpath)) {
      throw new Error('codebase_root_realpath_drift');
    }
    const timeoutMs = this.timeoutMs ?? (input.policy.includePrefixes.length > 0 ? 5_000 : 15_000);
    const deadline = Date.now() + timeoutMs;
    try {
      const collected = await this.collectNullSeparated(
        this.ripgrepPath,
        [
          '--files',
          '--null',
          ...hardenedRipgrepPrefixArguments(input.policy.maxFileBytes),
          ...sourceSelectionRipgrepArguments(input.policy, this.platform),
          '--',
          ...(input.policy.includePrefixes.length > 0 ? input.policy.includePrefixes : ['.']),
        ],
        root,
        hardenedRipgrepEnvironment(),
        Math.max(1, deadline - Date.now()),
        candidate => sourceSelectionAdmits(
          input.policy,
          normalizeRelative(candidate),
          this.platform,
        ),
      );
      return this.materializeCandidates(root, input.policy, 'ripgrep', 'exact', collected, deadline);
    } catch (error) {
      if (!this.backendUnavailable(error, 'ripgrep')) throw error;
    }
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return this.nodeResult([], [], 0, false, 'time_budget');
      const collected = await this.collectGitPaths(root, input.policy, remainingMs);
      return this.materializeCandidates(root, input.policy, 'git', 'exact', collected, deadline);
    } catch (error) {
      if (!this.backendUnavailable(error, 'git')) throw error;
    }
    return this.enumerateWithNode(root, input.policy, deadline);
  }

  private backendUnavailable(error: unknown, backend: 'ripgrep' | 'git'): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'EACCES' || (backend === 'git' && code === '128');
  }

  private async collectGitPaths(
    root: string,
    policy: SourceSelectionIR,
    timeoutMs: number,
  ): Promise<CollectedPaths> {
    const startedAt = Date.now();
    const rootPaths = await this.collectGitWorktreePaths(
      root,
      sourceSelectionGitPathspecs(policy, this.platform),
      timeoutMs,
      policy.ignoreMode === 'include_ignored',
      candidate => sourceSelectionAdmits(policy, normalizeRelative(candidate), this.platform),
    );
    const submodules = await this.readGitSubmodulePaths(root, policy, startedAt + timeoutMs);
    const paths = [...rootPaths.paths];
    let complete = rootPaths.complete && submodules.complete;
    let reason = rootPaths.reason ?? submodules.reason;
    let stderrObserved = rootPaths.stderrObserved;
    for (const submodulePath of submodules.paths) {
      if (paths.length > this.maxVisitedEntries) {
        complete = false;
        reason = 'enumeration_budget';
        break;
      }
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        complete = false;
        reason = 'time_budget';
        break;
      }
      const submoduleRoot = path.join(root, ...submodulePath.split('/'));
      try {
        const stat = await fsPromises.lstat(submoduleRoot);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('submodule_unavailable');
        const real = await fsPromises.realpath(submoduleRoot);
        const relativeReal = path.relative(root, real);
        if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
          throw new Error('submodule_outside_root');
        }
        await fsPromises.lstat(path.join(submoduleRoot, '.git'));
        const nested = await this.collectGitWorktreePaths(
          submoduleRoot,
          [':(literal).'],
          remainingMs,
          policy.ignoreMode === 'include_ignored',
          candidate => sourceSelectionAdmits(
            policy,
            `${submodulePath}/${normalizeRelative(candidate)}`,
            this.platform,
          ),
        );
        paths.push(...nested.paths.map(candidate =>
          `${submodulePath}/${normalizeRelative(candidate)}`));
        complete = complete && nested.complete;
        reason ??= nested.reason;
        stderrObserved = stderrObserved || nested.stderrObserved;
      } catch {
        complete = false;
        reason ??= 'traversal_error';
      }
    }
    if (paths.length > this.maxVisitedEntries) {
      paths.length = this.maxVisitedEntries;
      complete = false;
      reason = 'enumeration_budget';
    }
    return {
      paths,
      complete,
      ...(reason ? {reason} : {}),
      stderrObserved,
    };
  }

  private collectGitWorktreePaths(
    root: string,
    pathspecs: string[],
    timeoutMs: number,
    includeIgnored: boolean,
    acceptCandidate: (candidate: string) => boolean,
  ): Promise<CollectedPaths> {
    return this.collectNullSeparated(
      this.gitPath,
      [
        ...hardenedGitPrefixArguments(root),
        'ls-files',
        '-z',
        '--cached',
        '--others',
        ...(includeIgnored ? [] : ['--exclude-standard']),
        '--',
        ...pathspecs,
      ],
      root,
      hardenedGitEnvironment(),
      timeoutMs,
      acceptCandidate,
    );
  }

  private async readGitSubmodulePaths(
    root: string,
    policy: SourceSelectionIR,
    deadline: number,
  ): Promise<GitSubmodulePaths> {
    const gitmodulesPath = path.join(root, '.gitmodules');
    let contents: string;
    try {
      contents = await readBoundedMetadataFile({
        filePath: gitmodulesPath,
        expectedRealpath: gitmodulesPath,
        maxBytes: 1024 * 1024,
        deadline,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {paths: [], complete: true};
      return {
        paths: [],
        complete: false,
        reason: error instanceof SourceMetadataDeadlineExceededError
          ? 'time_budget'
          : 'traversal_error',
      };
    }
    const paths: string[] = [];
    let complete = true;
    for (const match of contents.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
      const candidate = normalizeRelative(match[1] ?? '');
      const segments = candidate.split('/');
      if (
        !candidate ||
        path.posix.isAbsolute(candidate) ||
        path.win32.isAbsolute(candidate) ||
        candidate.includes('\0') ||
        segments.some(segment => !segment || segment === '.' || segment === '..')
      ) {
        complete = false;
        continue;
      }
      if (directoryCanContain(candidate, policy, this.platform)) paths.push(candidate);
      if (paths.length > 256) return {paths: paths.slice(0, 256), complete: false};
    }
    return {paths: [...new Set(paths)].sort(), complete};
  }

  private collectNullSeparated(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    acceptCandidate: (candidate: string) => boolean,
  ): Promise<CollectedPaths> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
      const paths: string[] = [];
      let buffer = Buffer.alloc(0);
      let receivedBytes = 0;
      let stderrObserved = false;
      let intentionalCancel = false;
      let reason: CollectedPaths['reason'];
      let settled = false;
      const terminate = (nextReason: CollectedPaths['reason']): void => {
        if (intentionalCancel) return;
        intentionalCancel = true;
        reason = nextReason;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 250).unref();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (intentionalCancel) return;
        receivedBytes += chunk.length;
        if (receivedBytes > this.maxOutputBytes) {
          terminate('enumeration_budget');
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        let separator = buffer.indexOf(0);
        while (separator >= 0 && !intentionalCancel) {
          const candidate = buffer.subarray(0, separator).toString('utf8');
          buffer = buffer.subarray(separator + 1);
          if (candidate && acceptCandidate(candidate)) {
            paths.push(candidate);
          }
          if (paths.length > this.maxVisitedEntries) terminate('enumeration_budget');
          separator = buffer.indexOf(0);
        }
        if (buffer.length > 4096) terminate('enumeration_budget');
      });
      child.stderr.on('data', () => {
        stderrObserved = true;
      });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (!intentionalCancel && code !== 0) {
          const error = new Error(`source_enumerator_failed:${code ?? 'signal'}`) as NodeJS.ErrnoException;
          error.code = String(code ?? 'signal');
          reject(error);
          return;
        }
        const finalReason = reason ?? (stderrObserved ? 'traversal_error' : undefined);
        resolve({
          paths,
          complete: finalReason === undefined,
          ...(finalReason ? {reason: finalReason} : {}),
          stderrObserved,
        });
      });
      const timeout = setTimeout(() => terminate('time_budget'), timeoutMs);
      timeout.unref();
    });
  }

  private async materializeCandidates(
    root: string,
    policy: SourceSelectionIR,
    backend: EnumerationResult['backend'],
    fidelity: EnumerationResult['fidelity'],
    collected: CollectedPaths,
    deadline: number,
  ): Promise<EnumerationResult> {
    const files: EnumerationResult['files'] = [];
    const skipped: EnumerationResult['skipped'] = [];
    let skippedCount = 0;
    let traversalError = false;
    const recordSkipped = (relativePath: string, reason: string): void => {
      skippedCount += 1;
      if (skipped.length < this.maxSkippedDiagnostics) skipped.push({relativePath, reason});
    };
    for (const candidate of [...new Set(collected.paths.map(normalizeRelative))].sort()) {
      if (Date.now() >= deadline) {
        return {
          backend,
          fidelity,
          files,
          enumerationComplete: false,
          deterministic: false,
          incompleteReason: 'time_budget',
          skipped,
          skippedCount,
        };
      }
      if (!sourceSelectionAdmits(policy, candidate, this.platform)) continue;
      try {
        const inspected = await this.inspectCandidate(root, candidate, policy.maxFileBytes);
        if (inspected.file) files.push(inspected.file);
        if (inspected.reason) recordSkipped(candidate, inspected.reason);
        traversalError = traversalError || inspected.traversalError;
      } catch {
        traversalError = true;
        recordSkipped(candidate, 'traversal_error');
      }
      if (Date.now() >= deadline) {
        return {
          backend,
          fidelity,
          files,
          enumerationComplete: false,
          deterministic: false,
          incompleteReason: 'time_budget',
          skipped,
          skippedCount,
        };
      }
    }
    const complete = collected.complete && !traversalError;
    const incompleteReason = collected.reason ?? (traversalError ? 'traversal_error' : undefined);
    return {
      backend,
      fidelity,
      files,
      enumerationComplete: complete,
      deterministic: complete,
      ...(incompleteReason ? {incompleteReason} : {}),
      skipped,
      skippedCount,
    };
  }

  private async inspectCandidate(
    root: string,
    relativePath: string,
    maxFileBytes: number,
  ): Promise<CandidateInspection> {
    const absolute = path.join(root, ...relativePath.split('/'));
    const stat = await fsPromises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {reason: 'source_path_not_regular_file', traversalError: true};
    }
    if (stat.size > maxFileBytes) {
      return {reason: 'source_file_too_large', traversalError: false};
    }
    const real = await fsPromises.realpath(absolute);
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {reason: 'source_path_outside_root', traversalError: true};
    }
    return {file: {relativePath, sizeBytes: stat.size}, traversalError: false};
  }

  private async enumerateWithNode(
    root: string,
    policy: SourceSelectionIR,
    deadline: number,
  ): Promise<EnumerationResult> {
    const files: EnumerationResult['files'] = [];
    const skipped: EnumerationResult['skipped'] = [];
    let skippedCount = 0;
    let visitedEntries = 0;
    let visitedDirectories = 0;
    const stack = [''];
    while (stack.length > 0) {
      if (Date.now() >= deadline) {
        return this.nodeResult(files, skipped, skippedCount, false, 'time_budget');
      }
      const directory = stack.pop()!;
      visitedDirectories += 1;
      if (visitedDirectories > this.maxDirectories) {
        return this.nodeResult(files, skipped, skippedCount, false, 'enumeration_budget');
      }
      const absolute = directory ? path.join(root, ...directory.split('/')) : root;
      const entries: Dirent[] = [];
      let directoryOverflow = false;
      try {
        const handle = await fsPromises.opendir(absolute);
        for await (const entry of handle) {
          if (Date.now() >= deadline) {
            return this.nodeResult(files, skipped, skippedCount, false, 'time_budget');
          }
          if (visitedEntries + entries.length >= this.maxVisitedEntries) {
            directoryOverflow = true;
            break;
          }
          entries.push(entry);
        }
      } catch {
        skippedCount += 1;
        if (skipped.length < this.maxSkippedDiagnostics) skipped.push({relativePath: directory, reason: 'traversal_error'});
        return this.nodeResult(files, skipped, skippedCount, false, 'traversal_error');
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (Date.now() >= deadline) {
          return this.nodeResult(files, skipped, skippedCount, false, 'time_budget');
        }
        visitedEntries += 1;
        if (visitedEntries > this.maxVisitedEntries) {
          return this.nodeResult(files, skipped, skippedCount, false, 'enumeration_budget');
        }
        const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (directoryCanContain(relativePath, policy, this.platform)) stack.push(relativePath);
          continue;
        }
        if (!entry.isFile() || !sourceSelectionAdmits(policy, relativePath, this.platform)) continue;
        try {
          const inspected = await this.inspectCandidate(root, relativePath, policy.maxFileBytes);
          if (inspected.file) files.push(inspected.file);
          if (inspected.reason) {
            skippedCount += 1;
            if (skipped.length < this.maxSkippedDiagnostics) {
              skipped.push({relativePath, reason: inspected.reason});
            }
          }
          if (inspected.traversalError) {
            return this.nodeResult(files, skipped, skippedCount, false, 'traversal_error');
          }
        } catch {
          skippedCount += 1;
          if (skipped.length < this.maxSkippedDiagnostics) skipped.push({relativePath, reason: 'traversal_error'});
          return this.nodeResult(files, skipped, skippedCount, false, 'traversal_error');
        }
      }
      if (directoryOverflow) {
        return this.nodeResult(files, skipped, skippedCount, false, 'enumeration_budget');
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return this.nodeResult(files, skipped, skippedCount, true, 'backend_degraded');
  }

  private nodeResult(
    files: EnumerationResult['files'],
    skipped: EnumerationResult['skipped'],
    skippedCount: number,
    complete: boolean,
    reason: EnumerationResult['incompleteReason'],
  ): EnumerationResult {
    return {
      backend: 'node-walk',
      fidelity: 'degraded',
      files,
      enumerationComplete: complete,
      deterministic: complete,
      incompleteReason: reason,
      skipped,
      skippedCount,
    };
  }
}
