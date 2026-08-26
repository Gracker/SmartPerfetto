// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RagChunk} from '../../types/sparkContracts';
import {
  activeCodebaseGeneration,
  type CodebaseKind,
  type CodebaseRegistry,
} from '../codebase/codebaseRegistry';
import type {RagStore} from '../ragStore';
import type {KnowledgeScope} from '../scopedKnowledgeStore';
import {parseBreakpadSym, resolveBreakpadAddress} from './breakpadSymParser';
import {parseKallsyms, resolveKallsymsAddress} from './kallsymsParser';
import {parseR8Mapping, retraceR8Symbol} from './r8MappingParser';

export interface ResolveAppSymbolOptions {
  symbol: string;
  codebaseId?: string;
  buildId?: string;
  filePath?: string;
  r8MappingText?: string;
  obfuscatedClass?: string;
  obfuscatedMethod?: string;
  line?: number;
  topK?: number;
}

export interface ResolveKernelSymbolOptions {
  symbol?: string;
  address?: string;
  codebaseId?: string;
  vendor?: string;
  buildId?: string;
  kallsymsText?: string;
  systemMapText?: string;
  topK?: number;
}

export interface ResolveNativeSymbolOptions {
  symbol?: string;
  address?: string;
  codebaseId?: string;
  buildId?: string;
  breakpadSymText?: string;
  topK?: number;
}

export interface ResolvedSymbolCandidate {
  chunkId: string;
  codebaseId?: string;
  filePath?: string;
  lineRange?: {start: number; end: number};
  symbol?: string;
  language?: RagChunk['language'];
  confidence: 'exact' | 'file' | 'text';
}

export interface ResolveAppSymbolResult {
  success: boolean;
  query: string;
  candidates: ResolvedSymbolCandidate[];
  degradedReason?: 'missing_build_id' | 'no_match' | 'symbol_only_low_confidence';
}

export type ResolveSymbolResult = ResolveAppSymbolResult;

function toCandidate(chunk: RagChunk, confidence: ResolvedSymbolCandidate['confidence']): ResolvedSymbolCandidate {
  return {
    chunkId: chunk.chunkId,
    ...(chunk.codebaseId ? {codebaseId: chunk.codebaseId} : {}),
    ...(chunk.filePath ? {filePath: chunk.filePath} : {}),
    ...(chunk.lineRange ? {lineRange: chunk.lineRange} : {}),
    ...(chunk.symbol ? {symbol: chunk.symbol} : {}),
    ...(chunk.language ? {language: chunk.language} : {}),
    confidence,
  };
}

export class SymbolResolver {
  constructor(
    private readonly store: RagStore,
    private readonly scope?: KnowledgeScope,
    private readonly codebaseRegistry?: CodebaseRegistry,
  ) {}

  resolveApp(opts: ResolveAppSymbolOptions): ResolveAppSymbolResult {
    const retraced = opts.r8MappingText
      ? retraceR8Symbol(parseR8Mapping(opts.r8MappingText), {
          obfuscatedSymbol: opts.symbol,
          obfuscatedClass: opts.obfuscatedClass,
          obfuscatedMethod: opts.obfuscatedMethod,
          line: opts.line,
        })
      : undefined;
    const querySymbol = retraced?.originalSymbol ?? opts.symbol;
    const symbolName = retraced?.originalName ?? querySymbol.split('.').pop() ?? querySymbol;
    const topK = opts.topK ?? 5;
    const base = {
      kinds: ['app_source' as const],
      topK,
      scope: this.scope,
      ...(opts.codebaseId ? {codebaseIds: [opts.codebaseId]} : {}),
      ...(opts.buildId ? {buildId: opts.buildId} : {}),
      activeCodebaseGenerations: this.activeCodebaseGenerations(opts.codebaseId),
    };

    const exact = this.store.search(querySymbol, {
      ...base,
      symbolExact: symbolName,
    });
    if (exact.results.length > 0) {
      return {
        success: true,
        query: querySymbol,
        candidates: exact.results
          .filter(hit => hit.chunk)
          .map(hit => toCandidate(hit.chunk!, 'exact')),
        degradedReason: opts.buildId ? undefined : 'symbol_only_low_confidence',
      };
    }

    if (opts.filePath) {
      const byFile = this.store.search(querySymbol, {
        ...base,
        filePathExact: opts.filePath,
      });
      if (byFile.results.length > 0) {
        return {
          success: true,
          query: querySymbol,
          candidates: byFile.results
            .filter(hit => hit.chunk)
            .map(hit => toCandidate(hit.chunk!, 'file')),
          degradedReason: opts.buildId ? undefined : 'symbol_only_low_confidence',
        };
      }
    }

    const text = this.store.search(querySymbol, base);
    return {
      success: text.results.length > 0,
      query: querySymbol,
      candidates: text.results
        .filter(hit => hit.chunk)
        .map(hit => toCandidate(hit.chunk!, 'text')),
      degradedReason: text.results.length > 0
        ? (opts.buildId ? undefined : 'symbol_only_low_confidence')
        : 'no_match',
    };
  }

  resolveKernel(opts: ResolveKernelSymbolOptions): ResolveSymbolResult {
    let query = opts.symbol;
    if (!query && opts.address && (opts.kallsymsText || opts.systemMapText)) {
      const parsed = parseKallsyms(opts.kallsymsText ?? opts.systemMapText ?? '');
      const resolved = resolveKallsymsAddress(parsed, parseAddress(opts.address));
      query = resolved?.entry.symbol;
    }
    if (!query) {
      return {success: false, query: opts.address ?? '', candidates: [], degradedReason: 'no_match'};
    }
    return this.resolveSourceKinds(query, ['kernel_source'], {
      codebaseId: opts.codebaseId,
      vendor: opts.vendor,
      buildId: opts.buildId,
      topK: opts.topK,
    });
  }

  resolveNative(opts: ResolveNativeSymbolOptions): ResolveSymbolResult {
    let query = opts.symbol;
    if (!query && opts.address && opts.breakpadSymText) {
      const module = parseBreakpadSym(opts.breakpadSymText);
      const resolved = resolveBreakpadAddress(module, parseAddress(opts.address));
      query = resolved?.func.name;
    }
    if (!query) {
      return {success: false, query: opts.address ?? '', candidates: [], degradedReason: 'no_match'};
    }
    const registeredKind = opts.codebaseId
      ? this.codebaseRegistry?.get(opts.codebaseId, this.scope)?.kind
      : undefined;
    const kinds: Array<Extract<CodebaseKind, 'aosp' | 'oem_sdk'>> = registeredKind === 'oem_sdk'
      ? ['oem_sdk']
      : registeredKind === 'aosp'
        ? ['aosp']
        : ['aosp', 'oem_sdk'];
    return this.resolveSourceKinds(query, kinds, {
      codebaseId: opts.codebaseId,
      buildId: opts.buildId,
      topK: opts.topK,
    });
  }

  private resolveSourceKinds(
    symbol: string,
    kinds: Array<Extract<CodebaseKind, 'kernel_source' | 'aosp' | 'oem_sdk'>>,
    opts: {codebaseId?: string; vendor?: string; buildId?: string; topK?: number},
  ): ResolveSymbolResult {
    const topK = opts.topK ?? 5;
    const symbolName = symbol.split('::').pop()?.split('.').pop() ?? symbol;
    const base = {
      kinds,
      topK,
      scope: this.scope,
      ...(opts.codebaseId ? {codebaseIds: [opts.codebaseId]} : {}),
      ...(opts.vendor ? {vendor: opts.vendor} : {}),
      ...(opts.buildId ? {buildId: opts.buildId} : {}),
      activeCodebaseGenerations: this.activeCodebaseGenerations(opts.codebaseId),
    };
    const exact = this.store.search(symbol, {...base, symbolExact: symbolName});
    const result = exact.results.length > 0 ? exact : this.store.search(symbol, base);
    return {
      success: result.results.length > 0,
      query: symbol,
      candidates: result.results
        .filter(hit => hit.chunk)
        .map(hit => toCandidate(hit.chunk!, exact.results.length > 0 ? 'exact' : 'text')),
      degradedReason: result.results.length > 0
        ? (opts.buildId ? undefined : 'symbol_only_low_confidence')
        : 'no_match',
    };
  }

  private activeCodebaseGenerations(codebaseId?: string): Record<string, string> {
    if (!this.codebaseRegistry) return {};
    const refs = codebaseId
      ? [this.codebaseRegistry.get(codebaseId, this.scope)].filter(Boolean)
      : this.codebaseRegistry.list(this.scope);
    return Object.fromEntries(refs.flatMap(ref => {
      const generation = activeCodebaseGeneration(ref!);
      return generation ? [[ref!.codebaseId, generation]] : [];
    }));
  }
}

function parseAddress(value: string): bigint {
  const trimmed = value.trim();
  return BigInt(trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed : `0x${trimmed}`);
}
