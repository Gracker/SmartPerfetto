// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {spawn} from 'child_process';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import {StringDecoder} from 'string_decoder';

import type {CodeAwareMode} from './codeAwareFeature';
import {
  codebaseRootAvailable,
  type CodebaseRef,
  type CodebaseRegistry,
  type CodebaseScope,
} from './codebaseRegistry';
import {
  PathSecurityGate,
  readAcceptedTextFileSync,
} from './pathSecurityGate';
import {
  hardenedRipgrepEnvironment,
  hardenedRipgrepPrefixArguments,
} from './subprocessHardening';
import {
  createSourceProviderPathPredicate,
} from './sourceDisclosure';
import {
  sourceSelectionCanDescend,
  sourceSelectionForRef,
  sourceSelectionRipgrepArguments,
} from './sourceSelectionPolicy';
import {redactSecrets} from '../security/secretPatterns';
import {
  assertCodebaseRootIdentity,
  codebaseSourcePathMatches,
} from '../rag/sourceFileSelection';

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_READ_LINES = 200;
const RIPGREP_TIMEOUT_MS = 3_000;
const RIPGREP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SUBPROCESS_TERMINATION_GRACE_MS = 250;
const NODE_WALK_MAX_VISITED_ENTRIES = 20_000;
const NODE_WALK_MAX_DIRECTORIES = 5_000;

export type SourceSearchIncompleteReason =
  | 'enumeration_budget'
  | 'time_budget'
  | 'output_budget'
  | 'traversal_error'
  | 'backend_degraded';

interface SourceSearchBackendResult {
  matches: OnDemandSourceReference[];
  truncated: boolean;
  coverageComplete: boolean;
  searchIncompleteReason?: SourceSearchIncompleteReason;
}

export interface OnDemandSourceReference {
  referenceId: string;
  codebaseId: string;
  filePath: string;
  lineRange: {start: number; end: number};
  text?: string;
  redactedCount?: number;
}

export interface OnDemandSourceSearchResult {
  success: boolean;
  codebaseId: string;
  matches: OnDemandSourceReference[];
  truncated: boolean;
  backend: 'ripgrep' | 'node';
  coverageComplete: boolean;
  searchIncompleteReason?: SourceSearchIncompleteReason;
  enumerationBackend: 'ripgrep' | 'git' | 'node-walk';
  backendFidelity: 'exact' | 'degraded';
  unsupportedReason?: string;
}

export interface OnDemandSourceReadResult {
  success: boolean;
  codebaseId: string;
  reference?: OnDemandSourceReference;
  truncated: boolean;
  unsupportedReason?: string;
}

export interface OnDemandSourceAccessServiceOptions {
  registry: CodebaseRegistry;
  gate?: PathSecurityGate;
  platform?: NodeJS.Platform;
  ripgrepPath?: string;
  searchTimeoutMs?: number;
  maxSearchOutputBytes?: number;
  maxConcurrentSearches?: number;
  concurrencyWaitTimeoutMs?: number;
}

type RegisteredCodebase = CodebaseRef & {lifecycleState?: 'active' | 'deleting'};
type SearchWaiter = {grant: () => void; timeout?: NodeJS.Timeout};

export function codebaseOnDemandAvailability(
  ref: Pick<CodebaseRef, 'lifecycleState' | 'rootRealpath'>,
): {available: true} | {available: false; reason: 'codebase_deleting' | 'codebase_root_unavailable'} {
  if (ref.lifecycleState === 'deleting') {
    return {available: false, reason: 'codebase_deleting'};
  }
  return codebaseRootAvailable(ref)
    ? {available: true}
    : {available: false, reason: 'codebase_root_unavailable'};
}

function referenceId(codebaseId: string, filePath: string, line: number): string {
  return `source_${createHash('sha256')
    .update(`${codebaseId}\0${filePath}\0${line}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new Error(`${field}_invalid`);
  }
  return resolved;
}

function sourceTextForMode(text: string, mode: CodeAwareMode): {
  text?: string;
  redactedCount?: number;
} {
  if (mode !== 'provider_send') return {};
  const redacted = redactSecrets(text);
  return {text: redacted.text, redactedCount: redacted.redactedCount};
}

function escapeLiteralGlob(value: string): string {
  return value.replace(/[\\*?\[\]{}!]/g, character => `\\${character}`);
}

function pathHasPrefix(
  parent: string,
  child: string,
  platform: NodeJS.Platform,
): boolean {
  const comparable = (value: string): string => platform === 'win32'
    ? value.toLocaleLowerCase('en-US')
    : value;
  const comparableParent = comparable(parent);
  const comparableChild = comparable(child);
  return comparableChild === comparableParent || comparableChild.startsWith(`${comparableParent}/`);
}

export class OnDemandSourceAccessService {
  private readonly registry: CodebaseRegistry;
  private readonly gate: PathSecurityGate;
  private readonly platform: NodeJS.Platform;
  private readonly ripgrepPath: string;
  private readonly searchTimeoutMs: number;
  private readonly maxSearchOutputBytes: number;
  private readonly maxConcurrentSearches: number;
  private readonly concurrencyWaitTimeoutMs: number;
  private activeSearches = 0;
  private readonly searchWaiters: SearchWaiter[] = [];

  constructor(options: OnDemandSourceAccessServiceOptions) {
    this.registry = options.registry;
    this.gate = options.gate ?? new PathSecurityGate();
    this.platform = options.platform ?? process.platform;
    this.ripgrepPath = options.ripgrepPath ?? 'rg';
    this.searchTimeoutMs = boundedPositiveInteger(
      options.searchTimeoutMs,
      RIPGREP_TIMEOUT_MS,
      60_000,
      'search_timeout_ms',
    );
    this.maxSearchOutputBytes = boundedPositiveInteger(
      options.maxSearchOutputBytes,
      RIPGREP_MAX_OUTPUT_BYTES,
      64 * 1024 * 1024,
      'max_search_output_bytes',
    );
    this.maxConcurrentSearches = boundedPositiveInteger(
      options.maxConcurrentSearches,
      4,
      32,
      'max_concurrent_searches',
    );
    this.concurrencyWaitTimeoutMs = boundedPositiveInteger(
      options.concurrencyWaitTimeoutMs,
      this.searchTimeoutMs,
      60_000,
      'concurrency_wait_timeout_ms',
    );
  }

  private acquireSearchSlot(): Promise<boolean> {
    if (this.activeSearches < this.maxConcurrentSearches) {
      this.activeSearches += 1;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const waiter: SearchWaiter = {grant: () => resolve(true)};
      waiter.timeout = setTimeout(() => {
        const index = this.searchWaiters.indexOf(waiter);
        if (index >= 0) this.searchWaiters.splice(index, 1);
        resolve(false);
      }, this.concurrencyWaitTimeoutMs);
      waiter.timeout.unref();
      this.searchWaiters.push(waiter);
    });
  }

  private releaseSearchSlot(): void {
    this.activeSearches = Math.max(0, this.activeSearches - 1);
    const waiter = this.searchWaiters.shift();
    if (!waiter) return;
    if (waiter.timeout) clearTimeout(waiter.timeout);
    this.activeSearches += 1;
    waiter.grant();
  }

  private resolveRef(codebaseId: string, scope: CodebaseScope): RegisteredCodebase {
    const ref = this.registry.get(codebaseId, scope);
    if (!ref) throw new Error('codebase_not_found');
    const availability = codebaseOnDemandAvailability(ref);
    if (!availability.available) throw new Error(availability.reason);
    return ref;
  }

  private async validateRoot(ref: RegisteredCodebase): Promise<string> {
    const root = await this.gate.validateRoot(
      ref.rootRealpath,
      ref.rootAuthorization === 'native_picker'
        ? {additionalAllowlistRoots: [ref.rootRealpath]}
        : undefined,
    );
    assertCodebaseRootIdentity(ref.rootRealpath, root, this.platform);
    return root;
  }

  private consentFailure(
    ref: RegisteredCodebase,
    mode: CodeAwareMode,
  ): string | undefined {
    if (mode !== 'provider_send') return undefined;
    return ref.consent.sendToProvider ? undefined : 'no_send_to_provider_consent';
  }

  private sourceSearchPrefixes(
    ref: RegisteredCodebase,
    requestedPrefix: string | undefined,
  ): {requestedPrefix?: string; effectivePrefixes: string[]; disjoint: boolean} {
    const registered = [...new Set((ref.pathFilters ?? []).map(prefix =>
      this.gate.validateRelativeSourcePrefix(prefix, {enforceConfiguredExcludes: false})))];
    const requested = requestedPrefix
      ? this.gate.validateRelativeSourcePrefix(requestedPrefix, {enforceConfiguredExcludes: false})
      : undefined;
    if (!requested) return {effectivePrefixes: registered, disjoint: false};
    if (registered.length === 0) {
      return {requestedPrefix: requested, effectivePrefixes: [requested], disjoint: false};
    }
    const effectivePrefixes = [...new Set(registered.flatMap(prefix => {
      if (pathHasPrefix(prefix, requested, this.platform)) return [requested];
      if (pathHasPrefix(requested, prefix, this.platform)) return [prefix];
      return [];
    }))];
    return {
      requestedPrefix: requested,
      effectivePrefixes,
      disjoint: effectivePrefixes.length === 0,
    };
  }

  private ripgrepGlobArguments(
    ref: RegisteredCodebase,
    effectivePrefixes: readonly string[],
    policy = sourceSelectionForRef(ref, this.gate.getSourceReadLimits().maxFileBytes),
  ): string[] {
    const caseInsensitive = this.platform === 'win32';
    const option = caseInsensitive ? '--iglob' : '--glob';
    const includeGlobs = [...policy.extensions].flatMap(extension => {
      if (effectivePrefixes.length === 0) return [`*${escapeLiteralGlob(extension)}`];
      return effectivePrefixes.map(prefix =>
        `${escapeLiteralGlob(prefix)}/**/*${escapeLiteralGlob(extension)}`);
    });
    const allowedExtensions = new Set(policy.extensions);
    const exactPrefixGlobs = effectivePrefixes
      .filter(prefix => {
        const rawExtension = path.posix.extname(prefix);
        const extension = caseInsensitive
          ? rawExtension.toLocaleLowerCase('en-US')
          : rawExtension;
        return allowedExtensions.has(extension);
      })
      .map(escapeLiteralGlob);
    return [
      ...[...exactPrefixGlobs, ...includeGlobs].flatMap(glob => [option, glob]),
      ...sourceSelectionRipgrepArguments(policy, this.platform),
    ];
  }

  async search(input: {
    codebaseId: string;
    scope: CodebaseScope;
    query: string;
    mode: CodeAwareMode;
    pathPrefix?: string;
    maxResults?: number;
  }): Promise<OnDemandSourceSearchResult> {
    if (!input.query || input.query.length > 512 || input.query.includes('\0')) {
      throw new Error('source_query_invalid');
    }
    const maxResults = boundedPositiveInteger(
      input.maxResults,
      DEFAULT_MAX_RESULTS,
      MAX_RESULTS,
      'max_results',
    );
    const ref = this.resolveRef(input.codebaseId, input.scope);
    const consentFailure = this.consentFailure(ref, input.mode);
    if (consentFailure) {
      return {
        success: false,
        codebaseId: input.codebaseId,
        matches: [],
        truncated: false,
        backend: 'ripgrep',
        coverageComplete: true,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        unsupportedReason: consentFailure,
      };
    }
    const root = await this.validateRoot(ref);
    const prefixes = this.sourceSearchPrefixes(ref, input.pathPrefix);
    if (prefixes.disjoint) {
      return {
        success: true,
        codebaseId: input.codebaseId,
        matches: [],
        truncated: false,
        backend: 'ripgrep',
        coverageComplete: true,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
      };
    }
    if (!await this.acquireSearchSlot()) {
      return {
        success: true,
        codebaseId: input.codebaseId,
        matches: [],
        truncated: true,
        backend: 'ripgrep',
        coverageComplete: false,
        searchIncompleteReason: 'time_budget',
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
      };
    }
    try {
      try {
        const result = await this.searchWithRipgrep(
          ref,
          root,
          input.query,
          input.mode,
          prefixes.requestedPrefix,
          prefixes.effectivePrefixes,
          maxResults,
        );
        return {
          success: true,
          codebaseId: input.codebaseId,
          matches: result.matches.slice(0, maxResults),
          truncated: result.truncated,
          backend: 'ripgrep',
          coverageComplete: result.coverageComplete,
          ...(result.searchIncompleteReason
            ? {searchIncompleteReason: result.searchIncompleteReason}
            : {}),
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
        };
      } catch (error) {
        if (!this.shouldUseNodeFallback(error)) throw error;
        const result = await this.searchWithNode(
          ref,
          root,
          input.query,
          input.mode,
          prefixes.requestedPrefix,
          prefixes.effectivePrefixes,
          maxResults,
        );
        return {
          success: true,
          codebaseId: input.codebaseId,
          matches: result.matches.slice(0, maxResults),
          truncated: result.truncated,
          backend: 'node',
          coverageComplete: result.coverageComplete,
          searchIncompleteReason: result.searchIncompleteReason ?? 'backend_degraded',
          enumerationBackend: 'node-walk',
          backendFidelity: 'degraded',
        };
      }
    } finally {
      this.releaseSearchSlot();
    }
  }

  async read(input: {
    codebaseId: string;
    scope: CodebaseScope;
    filePath: string;
    startLine?: number;
    maxLines?: number;
    mode: CodeAwareMode;
  }): Promise<OnDemandSourceReadResult> {
    const ref = this.resolveRef(input.codebaseId, input.scope);
    if (input.mode === 'off') {
      return {
        success: false,
        codebaseId: input.codebaseId,
        truncated: false,
        unsupportedReason: 'code_aware_disabled_for_session',
      };
    }
    if (input.mode === 'provider_send') {
      const consentFailure = this.consentFailure(ref, input.mode);
      if (consentFailure) {
        return {
          success: false,
          codebaseId: input.codebaseId,
          truncated: false,
          unsupportedReason: consentFailure,
        };
      }
    }
    const root = await this.validateRoot(ref);
    const filePath = this.gate.validateRelativeSourcePath(
      input.filePath,
      {enforceConfiguredExcludes: false},
    );
    const selectionPolicy = sourceSelectionForRef(
      ref,
      this.gate.getSourceReadLimits().maxFileBytes,
    );
    if (!codebaseSourcePathMatches(
      ref,
      filePath,
      undefined,
      this.platform,
      selectionPolicy,
    )) {
      throw new Error('source_path_outside_registered_filters');
    }
    const providerPathAllowed = input.mode === 'provider_send'
      ? createSourceProviderPathPredicate(ref, this.platform, selectionPolicy)
      : undefined;
    if (providerPathAllowed && !providerPathAllowed(filePath)) {
      throw new Error('source_path_outside_provider_grant');
    }
    const startLine = boundedPositiveInteger(input.startLine, 1, Number.MAX_SAFE_INTEGER, 'start_line');
    const maxLines = boundedPositiveInteger(input.maxLines, 80, MAX_READ_LINES, 'max_lines');
    const content = readAcceptedTextFileSync(
      root,
      filePath,
      this.gate.getSourceReadLimits().maxFileBytes,
    );
    const lines = content.split(/\r?\n/);
    if (startLine > lines.length) throw new Error('source_line_out_of_range');
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const endLine = startLine + selected.length - 1;
    const projected = sourceTextForMode(selected.join('\n'), input.mode);
    if (selected.length === 0) {
      return {
        success: false,
        codebaseId: input.codebaseId,
        truncated: false,
        unsupportedReason: 'source_line_out_of_range',
      };
    }
    return {
      success: true,
      codebaseId: input.codebaseId,
      reference: {
        referenceId: referenceId(input.codebaseId, filePath, startLine),
        codebaseId: input.codebaseId,
        filePath,
        lineRange: {start: startLine, end: endLine},
        ...projected,
      },
      truncated: endLine < lines.length,
    };
  }

  private searchWithRipgrep(
    ref: RegisteredCodebase,
    root: string,
    query: string,
    mode: CodeAwareMode,
    pathPrefix: string | undefined,
    effectivePrefixes: readonly string[],
    maxResults: number,
  ): Promise<SourceSearchBackendResult> {
    const selectionPolicy = sourceSelectionForRef(
      ref,
      this.gate.getSourceReadLimits().maxFileBytes,
    );
    const providerPathAllowed = mode === 'provider_send'
      ? createSourceProviderPathPredicate(ref, this.platform, selectionPolicy)
      : undefined;
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.ripgrepPath,
        [
          '--json',
          '--fixed-strings',
          '--line-number',
          '--no-heading',
          '--color',
          'never',
          ...hardenedRipgrepPrefixArguments(this.gate.getSourceReadLimits().maxFileBytes),
          ...this.ripgrepGlobArguments(ref, effectivePrefixes, selectionPolicy),
          '--',
          query,
          '.',
        ],
        {
          cwd: root,
          env: hardenedRipgrepEnvironment(),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const matches: OnDemandSourceReference[] = [];
      const decoder = new StringDecoder('utf8');
      let stdoutBuffer = '';
      let stdoutBytes = 0;
      let stderrObserved = false;
      let locatorReadError = false;
      let settled = false;
      let intentionalCancel = false;
      let incompleteReason: SourceSearchIncompleteReason | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = (reason: SourceSearchIncompleteReason): void => {
        if (intentionalCancel) return;
        intentionalCancel = true;
        incompleteReason = reason;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, SUBPROCESS_TERMINATION_GRACE_MS);
        killTimer.unref();
      };

      const processLine = (line: string): void => {
        if (!line || intentionalCancel) return;
        let candidateObserved = false;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            data?: {
              path?: {text?: string};
              line_number?: number;
            };
          };
          if (event.type !== 'match') return;
          const rawPath = event.data?.path?.text;
          const lineNumber = event.data?.line_number;
          if (!rawPath || !Number.isInteger(lineNumber)) return;
          candidateObserved = true;
          const filePath = this.gate.validateRelativeSourcePath(
            rawPath,
            {enforceConfiguredExcludes: false},
          );
          if (!codebaseSourcePathMatches(
            ref,
            filePath,
            pathPrefix,
            this.platform,
            selectionPolicy,
          )) return;
          if (providerPathAllowed && !providerPathAllowed(filePath)) return;
          const content = readAcceptedTextFileSync(
            root,
            filePath,
            this.gate.getSourceReadLimits().maxFileBytes,
          );
          const text = content.split(/\r?\n/)[lineNumber! - 1];
          if (text === undefined || !text.includes(query)) return;
          matches.push({
            referenceId: referenceId(ref.codebaseId, filePath, lineNumber!),
            codebaseId: ref.codebaseId,
            filePath,
            lineRange: {start: lineNumber!, end: lineNumber!},
            ...sourceTextForMode(text, mode),
          });
          if (matches.length > maxResults) terminate('enumeration_budget');
        } catch {
          // Ripgrep output is an untrusted locator. Invalid, stale, or unsafe
          // candidates disappear rather than projecting subprocess text.
          if (candidateObserved) locatorReadError = true;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (intentionalCancel) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxSearchOutputBytes) {
          terminate('output_budget');
          return;
        }
        stdoutBuffer += decoder.write(chunk);
        let newline = stdoutBuffer.indexOf('\n');
        while (newline >= 0 && !intentionalCancel) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          processLine(line);
          newline = stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.on('data', () => {
        stderrObserved = true;
      });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (!intentionalCancel && code !== 0 && code !== 1 && code !== 2) {
          const error = new Error(`ripgrep_search_failed:${code ?? 'signal'}`) as NodeJS.ErrnoException;
          error.code = String(code ?? 'signal');
          reject(error);
          return;
        }
        const reason = incompleteReason ?? (code === 2 ? 'traversal_error' : undefined) ?? (
          stderrObserved || locatorReadError ? 'traversal_error' : undefined
        );
        resolve({
          matches,
          truncated: reason !== undefined,
          coverageComplete: reason === undefined,
          ...(reason ? {searchIncompleteReason: reason} : {}),
        });
      });
      const timeout = setTimeout(() => terminate('time_budget'), this.searchTimeoutMs);
      timeout.unref();
    });
  }

  private shouldUseNodeFallback(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'EACCES';
  }

  private async searchWithNode(
    ref: RegisteredCodebase,
    root: string,
    query: string,
    mode: CodeAwareMode,
    pathPrefix: string | undefined,
    effectivePrefixes: readonly string[],
    maxResults: number,
  ): Promise<SourceSearchBackendResult> {
    assertCodebaseRootIdentity(ref.rootRealpath, root, this.platform);
    const selectionPolicy = sourceSelectionForRef(
      ref,
      this.gate.getSourceReadLimits().maxFileBytes,
    );
    const providerPathAllowed = mode === 'provider_send'
      ? createSourceProviderPathPredicate(ref, this.platform, selectionPolicy)
      : undefined;
    const matches: OnDemandSourceReference[] = [];
    const stack = [''];
    const deadline = Date.now() + this.searchTimeoutMs;
    let visitedEntries = 0;
    let visitedDirectories = 0;
    let traversalError = false;
    while (stack.length > 0) {
      if (Date.now() >= deadline) {
        return {
          matches,
          truncated: true,
          coverageComplete: false,
          searchIncompleteReason: 'time_budget',
        };
      }
      const directory = stack.pop()!;
      visitedDirectories += 1;
      if (visitedDirectories > NODE_WALK_MAX_DIRECTORIES) {
        return {
          matches,
          truncated: true,
          coverageComplete: false,
          searchIncompleteReason: 'enumeration_budget',
        };
      }
      const absoluteDirectory = directory
        ? path.join(root, ...directory.split('/'))
        : root;
      try {
        const handle = await fsPromises.opendir(absoluteDirectory);
        for await (const entry of handle) {
          if (Date.now() >= deadline) {
            return {
              matches,
              truncated: true,
              coverageComplete: false,
              searchIncompleteReason: 'time_budget',
            };
          }
          visitedEntries += 1;
          if (visitedEntries > NODE_WALK_MAX_VISITED_ENTRIES) {
            return {
              matches,
              truncated: true,
              coverageComplete: false,
              searchIncompleteReason: 'enumeration_budget',
            };
          }
          const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!sourceSelectionCanDescend(
              selectionPolicy,
              relativePath,
              this.platform,
              effectivePrefixes,
            )) continue;
            stack.push(relativePath);
            continue;
          }
          if (!entry.isFile()) continue;
          let acceptedPath: string;
          try {
            acceptedPath = this.gate.validateRelativeSourcePath(
              relativePath,
              {enforceConfiguredExcludes: false},
            );
          } catch {
            continue;
          }
          if (!codebaseSourcePathMatches(
            ref,
            acceptedPath,
            pathPrefix,
            this.platform,
            selectionPolicy,
          )) continue;
          if (providerPathAllowed && !providerPathAllowed(acceptedPath)) continue;
          if (Date.now() >= deadline) {
            return {
              matches,
              truncated: true,
              coverageComplete: false,
              searchIncompleteReason: 'time_budget',
            };
          }
          try {
            const content = readAcceptedTextFileSync(
              root,
              acceptedPath,
              this.gate.getSourceReadLimits().maxFileBytes,
            );
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              if (!lines[index]!.includes(query)) continue;
              const lineNumber = index + 1;
              matches.push({
                referenceId: referenceId(ref.codebaseId, acceptedPath, lineNumber),
                codebaseId: ref.codebaseId,
                filePath: acceptedPath,
                lineRange: {start: lineNumber, end: lineNumber},
                ...sourceTextForMode(lines[index]!, mode),
              });
              if (matches.length > maxResults) {
                return {
                  matches: matches.slice(0, maxResults),
                  truncated: true,
                  coverageComplete: false,
                  searchIncompleteReason: 'enumeration_budget',
                };
              }
            }
          } catch {
            traversalError = true;
          }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } catch {
        traversalError = true;
      }
    }
    return {
      matches,
      truncated: false,
      coverageComplete: false,
      searchIncompleteReason: traversalError ? 'traversal_error' : 'backend_degraded',
    };
  }
}
