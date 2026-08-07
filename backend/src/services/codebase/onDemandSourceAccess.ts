// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {execFile} from 'child_process';
import * as path from 'path';

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
import {redactSecrets} from '../security/secretPatterns';
import {
  assertCodebaseRootIdentity,
  codebaseSourcePathMatches,
  previewRegisteredCodebaseRoot,
  selectCodebasePreviewFiles,
} from '../rag/sourceFileSelection';

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;
const MAX_READ_LINES = 200;
const RIPGREP_TIMEOUT_MS = 3_000;
const RIPGREP_MAX_BUFFER_BYTES = 1024 * 1024;

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
  ripgrepPath?: string;
}

type RegisteredCodebase = CodebaseRef & {lifecycleState?: 'active' | 'deleting'};

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

function pathHasPrefix(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export class OnDemandSourceAccessService {
  private readonly registry: CodebaseRegistry;
  private readonly gate: PathSecurityGate;
  private readonly ripgrepPath: string;

  constructor(options: OnDemandSourceAccessServiceOptions) {
    this.registry = options.registry;
    this.gate = options.gate ?? new PathSecurityGate();
    this.ripgrepPath = options.ripgrepPath ?? 'rg';
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
    assertCodebaseRootIdentity(ref.rootRealpath, root);
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
      this.gate.validateRelativeSourcePrefix(prefix)))];
    const requested = requestedPrefix
      ? this.gate.validateRelativeSourcePrefix(requestedPrefix)
      : undefined;
    if (!requested) return {effectivePrefixes: registered, disjoint: false};
    if (registered.length === 0) {
      return {requestedPrefix: requested, effectivePrefixes: [requested], disjoint: false};
    }
    const effectivePrefixes = [...new Set(registered.flatMap(prefix => {
      if (pathHasPrefix(prefix, requested)) return [requested];
      if (pathHasPrefix(requested, prefix)) return [prefix];
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
  ): string[] {
    const policy = this.gate.getSourceSearchPolicy();
    const option = policy.caseInsensitive ? '--iglob' : '--glob';
    const includeGlobs = policy.allowedExtensions.flatMap(extension => {
      if (effectivePrefixes.length === 0) return [`*${escapeLiteralGlob(extension)}`];
      return effectivePrefixes.map(prefix =>
        `${escapeLiteralGlob(prefix)}/**/*${escapeLiteralGlob(extension)}`);
    });
    const allowedExtensions = new Set(policy.allowedExtensions);
    const exactPrefixGlobs = effectivePrefixes
      .filter(prefix => {
        const rawExtension = path.posix.extname(prefix);
        const extension = policy.caseInsensitive
          ? rawExtension.toLocaleLowerCase('en-US')
          : rawExtension;
        return allowedExtensions.has(extension);
      })
      .map(escapeLiteralGlob);
    const excludeGlobs = [
      ...policy.excludeNames.map(name => `!**/${escapeLiteralGlob(name)}/**`),
      '!**/.env*',
      '!**/*.log',
      '!**/*.bak',
      ...(ref.excludeGlobs ?? []).map(pattern => `!${pattern}`),
    ];
    return [...exactPrefixGlobs, ...includeGlobs, ...excludeGlobs]
      .flatMap(glob => [option, glob]);
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
      };
    }
    try {
      const matches = await this.searchWithRipgrep(
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
        matches: matches.slice(0, maxResults),
        truncated: matches.length > maxResults,
        backend: 'ripgrep',
      };
    } catch (error) {
      if (!this.shouldUseNodeFallback(error)) throw error;
      const matches = await this.searchWithNode(
        ref,
        root,
        input.query,
        input.mode,
        prefixes.requestedPrefix,
        maxResults,
      );
      return {
        success: true,
        codebaseId: input.codebaseId,
        matches,
        truncated: matches.length >= maxResults,
        backend: 'node',
      };
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
    if (input.mode !== 'provider_send') {
      return {
        success: false,
        codebaseId: input.codebaseId,
        truncated: false,
        unsupportedReason: 'provider_send_disabled_for_session',
      };
    }
    const consentFailure = this.consentFailure(ref, input.mode);
    if (consentFailure) {
      return {
        success: false,
        codebaseId: input.codebaseId,
        truncated: false,
        unsupportedReason: consentFailure,
      };
    }
    const root = await this.validateRoot(ref);
    const filePath = this.gate.validateRelativeSourcePath(input.filePath);
    if (!codebaseSourcePathMatches(ref, filePath)) {
      throw new Error('source_path_outside_registered_filters');
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
  ): Promise<OnDemandSourceReference[]> {
    return new Promise((resolve, reject) => {
      execFile(
        this.ripgrepPath,
        [
          '--json',
          '--fixed-strings',
          '--line-number',
          '--no-heading',
          '--color',
          'never',
          '--hidden',
          '--max-filesize',
          String(this.gate.getSourceReadLimits().maxFileBytes),
          ...this.ripgrepGlobArguments(ref, effectivePrefixes),
          '--',
          query,
          '.',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: RIPGREP_TIMEOUT_MS,
          maxBuffer: RIPGREP_MAX_BUFFER_BYTES,
        },
        (error, stdout) => {
          const exitCode = (error as {code?: string | number} | null)?.code;
          if (error && exitCode !== 1 && exitCode !== '1') {
            reject(error);
            return;
          }
          const matches: OnDemandSourceReference[] = [];
          for (const line of stdout.split('\n')) {
            if (!line || matches.length > maxResults) break;
            try {
              const event = JSON.parse(line) as {
                type?: string;
                data?: {
                  path?: {text?: string};
                  line_number?: number;
                  lines?: {text?: string};
                };
              };
              if (event.type !== 'match') continue;
              const rawPath = event.data?.path?.text;
              const lineNumber = event.data?.line_number;
              const rawText = event.data?.lines?.text;
              if (!rawPath || !Number.isInteger(lineNumber) || typeof rawText !== 'string') continue;
              const filePath = this.gate.validateRelativeSourcePath(rawPath);
              if (!codebaseSourcePathMatches(ref, filePath, pathPrefix)) continue;
              const text = rawText.replace(/\r?\n$/, '');
              matches.push({
                referenceId: referenceId(ref.codebaseId, filePath, lineNumber!),
                codebaseId: ref.codebaseId,
                filePath,
                lineRange: {start: lineNumber!, end: lineNumber!},
                ...sourceTextForMode(text, mode),
              });
            } catch {
              continue;
            }
          }
          resolve(matches);
        },
      );
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
    maxResults: number,
  ): Promise<OnDemandSourceReference[]> {
    const preview = await previewRegisteredCodebaseRoot(this.gate, ref);
    if (preview.blocked) throw new Error(preview.blockedReason ?? 'source_root_unavailable');
    assertCodebaseRootIdentity(root, preview.rootRealpath);
    const files = selectCodebasePreviewFiles(preview, ref, pathPrefix);
    const matches: OnDemandSourceReference[] = [];
    for (const file of files) {
      const content = readAcceptedTextFileSync(
        root,
        file.relativePath,
        this.gate.getSourceReadLimits().maxFileBytes,
      );
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index]!.includes(query)) continue;
        const lineNumber = index + 1;
        matches.push({
          referenceId: referenceId(ref.codebaseId, file.relativePath, lineNumber),
          codebaseId: ref.codebaseId,
          filePath: file.relativePath,
          lineRange: {start: lineNumber, end: lineNumber},
          ...sourceTextForMode(lines[index]!, mode),
        });
        if (matches.length >= maxResults) return matches;
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return matches;
  }
}
