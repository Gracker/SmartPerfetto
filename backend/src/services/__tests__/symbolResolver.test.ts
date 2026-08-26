// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {RagStore} from '../ragStore';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {resolveCodebaseScope} from '../codebase/codebaseRegistry';
import {parseBreakpadSym, resolveBreakpadAddress} from '../symbol/breakpadSymParser';
import {parseKallsyms, resolveKallsymsAddress} from '../symbol/kallsymsParser';
import {parseR8Mapping, retraceR8Symbol} from '../symbol/r8MappingParser';
import {SymbolResolver} from '../symbol/symbolResolver';
import {normalizeTraceSymbolRows} from '../symbol/traceSymbolContext';

let tmpDir: string;
let store: RagStore;
let registry: CodebaseRegistry;
const scope = resolveCodebaseScope();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-resolver-'));
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('R8 mapping parser', () => {
  it('retraces obfuscated class and method names with line ranges', () => {
    const mappings = parseR8Mapping(`
com.example.di.AppModule -> a.b:
    1:3:retrofit2.Retrofit provideRetrofit():42:44 -> a
    4:5:okhttp3.Client provideClient():47:48 -> a
`);
    const result = retraceR8Symbol(mappings, {
      obfuscatedClass: 'a.b',
      obfuscatedMethod: 'a',
      line: 2,
    });

    expect(result).toMatchObject({
      success: true,
      originalClass: 'com.example.di.AppModule',
      originalName: 'provideRetrofit',
      originalSymbol: 'com.example.di.AppModule.provideRetrofit',
      lineRange: {start: 42, end: 44},
    });
    expect(result.inlineFrames).toHaveLength(1);
  });
});

describe('native and kernel parsers', () => {
  it('resolves kallsyms addresses to nearest symbol', () => {
    const entries = parseKallsyms('ffff0000 T binder_thread_read\nffff0100 T binder_wait_for_work\n');
    const result = resolveKallsymsAddress(entries, BigInt('0xffff0110'));
    expect(result?.entry.symbol).toBe('binder_wait_for_work');
    expect(result?.offset).toBe(BigInt(0x10));
  });

  it('resolves breakpad FUNC ranges', () => {
    const module = parseBreakpadSym('MODULE Linux arm64 ABC libhwui.so\nFUNC 1000 40 0 DrawFrameTask::run\n');
    const result = resolveBreakpadAddress(module, BigInt('0x1010'));
    expect(result?.func.name).toBe('DrawFrameTask::run');
    expect(result?.offset).toBe(BigInt(0x10));
  });
});

describe('SymbolResolver', () => {
  it('uses R8 retrace before app source lookup', () => {
    const appRef = registry.register({
      kind: 'app_source',
      displayName: 'App',
      rootPath: tmpDir,
      sendToProvider: false,
    });
    const appGeneration = 'codebase_2_app';
    registry.activateIndexGeneration(appRef.codebaseId, scope, appRef.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: appGeneration,
      contentFingerprint: 'app-content',
      chunkCount: 1,
    });
    store.addChunk({
      chunkId: 'app-1',
      kind: 'app_source',
      uri: 'codebase://cb-app/app/src/main/java/AppModule.kt',
      snippet: 'fun provideRetrofit() = Retrofit.Builder().build()',
      indexedAt: Date.now(),
      filePath: 'app/src/main/java/AppModule.kt',
      lineRange: {start: 42, end: 44},
      symbol: 'provideRetrofit',
      buildId: 'app-build',
      codebaseId: appRef.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: appGeneration,
    }, scope);

    const result = new SymbolResolver(store, scope, registry).resolveApp({
      symbol: 'a.b.a',
      codebaseId: appRef.codebaseId,
      r8MappingText: 'com.example.di.AppModule -> a.b:\n    1:3:retrofit2.Retrofit provideRetrofit():42:44 -> a\n',
      buildId: 'app-build',
    });

    expect(result.success).toBe(true);
    expect(result.query).toBe('com.example.di.AppModule.provideRetrofit');
    expect(result.candidates[0]).toMatchObject({chunkId: 'app-1', confidence: 'exact'});
  });

  it('resolves kernel and native symbols through source-backed chunks', () => {
    const kernelRef = registry.register({
      kind: 'kernel_source',
      displayName: 'Kernel',
      rootPath: tmpDir,
      sendToProvider: false,
      vendor: 'mtk',
    });
    const aospRef = registry.register({
      kind: 'aosp',
      displayName: 'AOSP',
      rootPath: tmpDir,
      sendToProvider: false,
      buildId: 'aosp-build',
    });
    const kernelGeneration = 'codebase_2_kernel';
    registry.activateIndexGeneration(kernelRef.codebaseId, scope, kernelRef.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: kernelGeneration,
      contentFingerprint: 'kernel-content',
      chunkCount: 1,
    });
    const aospGeneration = 'codebase_2_aosp';
    registry.activateIndexGeneration(aospRef.codebaseId, scope, aospRef.indexGeneration, {
      lastIngestStatus: 'ok',
      activeGeneration: aospGeneration,
      contentFingerprint: 'aosp-content',
      chunkCount: 1,
    });
    store.addChunk({
      chunkId: 'kernel-1',
      kind: 'kernel_source',
      uri: 'codebase://cb-k/drivers/android/binder.c',
      snippet: 'int binder_wait_for_work(void) { return 0; }',
      license: 'GPL-2.0-only',
      indexedAt: Date.now(),
      filePath: 'drivers/android/binder.c',
      lineRange: {start: 1, end: 3},
      symbol: 'binder_wait_for_work',
      vendor: 'mtk',
      codebaseId: kernelRef.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: kernelGeneration,
    }, scope);
    store.addChunk({
      chunkId: 'aosp-1',
      kind: 'aosp',
      uri: 'codebase://cb-a/frameworks/base/libs/hwui/DrawFrameTask.cpp',
      snippet: 'void DrawFrameTask::run() {}',
      license: 'Apache-2.0',
      indexedAt: Date.now(),
      filePath: 'frameworks/base/libs/hwui/DrawFrameTask.cpp',
      lineRange: {start: 1, end: 3},
      symbol: 'run',
      buildId: 'aosp-build',
      codebaseId: aospRef.codebaseId,
      registryOrigin: 'codebase_registry',
      sourceGeneration: aospGeneration,
    }, scope);

    const resolver = new SymbolResolver(store, scope, registry);
    expect(resolver.resolveKernel({
      address: 'ffff0110',
      vendor: 'mtk',
      kallsymsText: 'ffff0100 T binder_wait_for_work\n',
    }).candidates[0].chunkId).toBe('kernel-1');
    expect(resolver.resolveNative({
      address: '1010',
      buildId: 'aosp-build',
      breakpadSymText: 'MODULE Linux arm64 AOSP libhwui.so\nFUNC 1000 40 0 DrawFrameTask::run\n',
    }).candidates[0].chunkId).toBe('aosp-1');
  });

  it('normalizes trace symbol rows into build-id aware context', () => {
    const context = normalizeTraceSymbolRows([
      {module_name: 'libhwui.so', build_id: 'abc', relative_pc: '0x10', function_name: 'DrawFrameTask::run'},
      {mapping_name: 'vmlinux', symbol: 'binder_wait_for_work'},
    ]);
    expect(context.hasBuildIds).toBe(true);
    expect(context.modules).toEqual(['libhwui.so', 'vmlinux']);
    expect(context.frames[0]).toMatchObject({module: 'libhwui.so', buildId: 'abc'});
  });
});
