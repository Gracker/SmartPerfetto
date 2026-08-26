// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {spawn} from 'child_process';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

import type {PathSecurityGate} from './pathSecurityGate';
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
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function pathHasPrefix(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function directoryCanContain(directory: string, policy: SourceSelectionIR): boolean {
  const segments = directory.split('/').filter(Boolean);
  if (segments.some(segment => policy.hardExcludeDirs.includes(segment))) return false;
  if (policy.includePrefixes.length === 0) return true;
  return policy.includePrefixes.some(prefix =>
    pathHasPrefix(directory, prefix) || pathHasPrefix(prefix, directory));
}

export class SourceEnumerator {
  private readonly ripgrepPath: string;
  private readonly gitPath: string;
  private readonly maxVisitedEntries: number;
  private readonly maxDirectories: number;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs?: number;
  private readonly maxSkippedDiagnostics: number;

  constructor(options: SourceEnumeratorOptions = {}) {
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
    const normalizeIdentity = (value: string): string => process.platform === 'win32'
      ? path.resolve(value).toLocaleLowerCase('en-US')
      : path.resolve(value);
    if (normalizeIdentity(root) !== normalizeIdentity(requestedRealpath)) {
      throw new Error('codebase_root_realpath_drift');
    }
    const timeoutMs = this.timeoutMs ?? (input.policy.includePrefixes.length > 0 ? 5_000 : 15_000);
    try {
      const collected = await this.collectNullSeparated(
        this.ripgrepPath,
        [
          '--files',
          '--null',
          ...hardenedRipgrepPrefixArguments(input.policy.maxFileBytes),
          ...sourceSelectionRipgrepArguments(input.policy),
          '--',
          ...(input.policy.includePrefixes.length > 0 ? input.policy.includePrefixes : ['.']),
        ],
        root,
        hardenedRipgrepEnvironment(),
        timeoutMs,
        candidate => sourceSelectionAdmits(input.policy, normalizeRelative(candidate)),
      );
      return this.materializeCandidates(root, input.policy, 'ripgrep', 'exact', collected);
    } catch (error) {
      if (!this.backendUnavailable(error)) throw error;
    }
    try {
      const collected = await this.collectGitPaths(root, input.policy, timeoutMs);
      return this.materializeCandidates(root, input.policy, 'git', 'exact', collected);
    } catch (error) {
      if (!this.backendUnavailable(error)) throw error;
    }
    return this.enumerateWithNode(root, input.policy, timeoutMs);
  }

  private backendUnavailable(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'EACCES';
  }

  private async collectGitPaths(
    root: string,
    policy: SourceSelectionIR,
    timeoutMs: number,
  ): Promise<CollectedPaths> {
    const startedAt = Date.now();
    const rootPaths = await this.collectGitWorktreePaths(
      root,
      sourceSelectionGitPathspecs(policy),
      timeoutMs,
      candidate => sourceSelectionAdmits(policy, normalizeRelative(candidate)),
    );
    const submodules = await this.readGitSubmodulePaths(root, policy);
    const paths = [...rootPaths.paths];
    let complete = rootPaths.complete && submodules.complete;
    let reason = rootPaths.reason ?? (submodules.complete ? undefined : 'traversal_error');
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
          candidate => sourceSelectionAdmits(
            policy,
            `${submodulePath}/${normalizeRelative(candidate)}`,
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
        '--exclude-standard',
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
  ): Promise<GitSubmodulePaths> {
    const gitmodulesPath = path.join(root, '.gitmodules');
    let stat;
    try {
      stat = await fsPromises.lstat(gitmodulesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {paths: [], complete: true};
      return {paths: [], complete: false};
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      return {paths: [], complete: false};
    }
    let contents: string;
    try {
      contents = await fsPromises.readFile(gitmodulesPath, 'utf8');
    } catch {
      return {paths: [], complete: false};
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
      if (directoryCanContain(candidate, policy)) paths.push(candidate);
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
      let acceptedBytes = 0;
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
        buffer = Buffer.concat([buffer, chunk]);
        let separator = buffer.indexOf(0);
        while (separator >= 0 && !intentionalCancel) {
          const candidate = buffer.subarray(0, separator).toString('utf8');
          buffer = buffer.subarray(separator + 1);
          if (candidate && acceptCandidate(candidate)) {
            acceptedBytes += Buffer.byteLength(candidate, 'utf8') + 1;
            if (acceptedBytes > this.maxOutputBytes) {
              terminate('enumeration_budget');
              break;
            }
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
      if (!sourceSelectionAdmits(policy, candidate)) continue;
      try {
        const inspected = await this.inspectCandidate(root, candidate, policy.maxFileBytes);
        if (inspected) files.push(inspected);
        else {
          traversalError = true;
          recordSkipped(candidate, 'source_path_not_regular_file');
        }
      } catch {
        traversalError = true;
        recordSkipped(candidate, 'traversal_error');
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
  ): Promise<{relativePath: string; sizeBytes: number} | undefined> {
    const absolute = path.join(root, ...relativePath.split('/'));
    const stat = await fsPromises.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) return undefined;
    const real = await fsPromises.realpath(absolute);
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return {relativePath, sizeBytes: stat.size};
  }

  private async enumerateWithNode(
    root: string,
    policy: SourceSelectionIR,
    timeoutMs: number,
  ): Promise<EnumerationResult> {
    const files: EnumerationResult['files'] = [];
    const skipped: EnumerationResult['skipped'] = [];
    let skippedCount = 0;
    let visitedEntries = 0;
    let visitedDirectories = 0;
    const stack = [''];
    const deadline = Date.now() + timeoutMs;
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
      let entries;
      try {
        entries = await fsPromises.readdir(absolute, {withFileTypes: true});
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
          if (directoryCanContain(relativePath, policy)) stack.push(relativePath);
          continue;
        }
        if (!entry.isFile() || !sourceSelectionAdmits(policy, relativePath)) continue;
        try {
          const inspected = await this.inspectCandidate(root, relativePath, policy.maxFileBytes);
          if (inspected) files.push(inspected);
        } catch {
          skippedCount += 1;
          if (skipped.length < this.maxSkippedDiagnostics) skipped.push({relativePath, reason: 'traversal_error'});
        }
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
