// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {activeCodebaseGeneration, CodebaseRegistry} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {AospSourceIngester} from '../rag/aospSourceIngester';
import {KernelSourceIngester} from '../rag/kernelSourceIngester';
import {RagStore} from '../ragStore';

let tmpDir: string;
let sourceRoot: string;
let registry: CodebaseRegistry;
let store: RagStore;
let gate: PathSecurityGate;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-source-ingester-'));
  sourceRoot = path.join(tmpDir, 'src');
  fs.mkdirSync(sourceRoot, {recursive: true});
  registry = new CodebaseRegistry(path.join(tmpDir, 'codebases.json'));
  store = new RagStore(path.join(tmpDir, 'rag.json'));
  gate = new PathSecurityGate({allowlistRoots: [sourceRoot]});
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('KernelSourceIngester', () => {
  it('indexes vendor-isolated kernel chunks with SPDX license and line metadata', async () => {
    fs.mkdirSync(path.join(sourceRoot, 'drivers/android'), {recursive: true});
    fs.writeFileSync(path.join(sourceRoot, 'drivers/android/binder.c'), [
      '// SPDX-License-Identifier: GPL-2.0-only',
      'int binder_wait_for_work(void) {',
      '  return 0;',
      '}',
    ].join('\n'));
    const ref = registry.register({
      kind: 'kernel_source',
      displayName: 'mtk-kernel',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
      sendToProvider: true,
    });

    const result = await new KernelSourceIngester(store, registry, gate).ingest(ref.codebaseId);

    expect(result.errors).toHaveLength(0);
    expect(result.chunksAdded).toBeGreaterThan(0);
    const search = store.search('binder_wait_for_work', {
      kinds: ['kernel_source'],
      codebaseIds: [ref.codebaseId],
      vendor: 'mtk',
      pathPrefix: 'drivers/android',
      activeCodebaseGenerations: {
        [ref.codebaseId]: activeCodebaseGeneration(registry.get(ref.codebaseId)!)!,
      },
      scope: ref,
    });
    expect(search.results[0].chunk).toMatchObject({
      kind: 'kernel_source',
      vendor: 'mtk',
      filePath: 'drivers/android/binder.c',
      symbol: 'binder_wait_for_work',
      license: 'GPL-2.0-only',
      registryOrigin: 'codebase_registry',
    });
  });

  it('fails closed when vendor or path filter is missing', async () => {
    const noVendor = registry.register({
      kind: 'kernel_source',
      displayName: 'kernel',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
      pathFilters: ['drivers/android'],
    });
    await expect(new KernelSourceIngester(store, registry, gate).ingest(noVendor.codebaseId))
      .rejects.toThrow(/requires vendor/);

    const noPathFilter = registry.register({
      kind: 'kernel_source',
      displayName: 'kernel2',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
      vendor: 'mtk',
    });
    await expect(new KernelSourceIngester(store, registry, gate).ingest(noPathFilter.codebaseId))
      .rejects.toThrow(/requires pathFilters/);
  });

  it('fails before staging a source file that exceeds the chunk budget', async () => {
    fs.mkdirSync(path.join(sourceRoot, 'drivers/android'), {recursive: true});
    fs.writeFileSync(path.join(sourceRoot, 'drivers/android/many.c'), [
      'int first_symbol(void) { return 1; }',
      'int second_symbol(void) { return 2; }',
    ].join('\n'.repeat(300)));
    const ref = registry.register({
      kind: 'kernel_source',
      displayName: 'bounded-kernel',
      rootPath: sourceRoot,
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
    });

    await expect(new KernelSourceIngester(store, registry, gate).ingest(
      ref.codebaseId,
      {maxChunkChars: 256, maxChunks: 1},
    )).rejects.toThrow('source_chunk_limit_exceeded:1');
    expect(store.listChunks({scope: ref})).toHaveLength(0);
  });
});

describe('AospSourceIngester', () => {
  it('fails closed when licensed-source provenance is incomplete', async () => {
    const noLicense = registry.register({
      kind: 'aosp',
      displayName: 'aosp-without-license',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
    });
    await expect(new AospSourceIngester(store, registry, gate).ingest(noLicense.codebaseId))
      .rejects.toThrow(/requires licenseTag/);

    const noVendor = registry.register({
      kind: 'oem_sdk',
      displayName: 'oem-sdk-without-vendor',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
      licenseTag: 'LicenseRef-OEM-SDK',
    });
    await expect(new AospSourceIngester(store, registry, gate).ingest(noVendor.codebaseId))
      .rejects.toThrow(/requires vendor/);
  });

  it('indexes registered AOSP/native source with codebase metadata', async () => {
    fs.mkdirSync(path.join(sourceRoot, 'frameworks/base/libs/hwui'), {recursive: true});
    fs.writeFileSync(path.join(sourceRoot, 'frameworks/base/libs/hwui/DrawFrameTask.cpp'), [
      'void DrawFrameTask::run() {',
      '  // draw frame',
      '}',
    ].join('\n'));
    const ref = registry.register({
      kind: 'aosp',
      displayName: 'aosp',
      rootPath: sourceRoot,
      rootRealpath: sourceRoot,
      licenseTag: 'Apache-2.0',
      commitHash: 'abc123',
      buildId: 'build-aosp',
      pathFilters: ['frameworks/base'],
      sendToProvider: true,
    });

    const result = await new AospSourceIngester(store, registry, gate).ingest(ref.codebaseId);

    expect(result.errors).toHaveLength(0);
    const hit = store.search('DrawFrameTask run', {
      kinds: ['aosp'],
      codebaseIds: [ref.codebaseId],
      buildId: 'build-aosp',
      activeCodebaseGenerations: {
        [ref.codebaseId]: activeCodebaseGeneration(registry.get(ref.codebaseId)!)!,
      },
      scope: ref,
    }).results[0].chunk;
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({
      kind: 'aosp',
      codebaseId: ref.codebaseId,
      registryOrigin: 'codebase_registry',
      filePath: 'frameworks/base/libs/hwui/DrawFrameTask.cpp',
      commitProvenance: 'content_only',
    });
    expect(hit!.commitHash).toBeUndefined();
    expect(hit!.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('native-picker root authorization', () => {
  it('reuses the selected root for kernel and licensed-source reindex only', async () => {
    fs.mkdirSync(path.join(sourceRoot, 'drivers/android'), {recursive: true});
    fs.writeFileSync(
      path.join(sourceRoot, 'drivers/android/binder.c'),
      '// SPDX-License-Identifier: GPL-2.0-only\nint binder_native(void) { return 0; }\n',
    );
    fs.mkdirSync(path.join(sourceRoot, 'frameworks/base'), {recursive: true});
    fs.writeFileSync(
      path.join(sourceRoot, 'frameworks/base/Native.cpp'),
      'void native_aosp(void) {}\n',
    );
    const selectedGate = new PathSecurityGate({
      allowlistRoots: [path.join(tmpDir, 'configured-only')],
    });
    const kernel = registry.register({
      kind: 'kernel_source',
      displayName: 'Selected kernel',
      rootPath: sourceRoot,
      rootAuthorization: 'native_picker',
      vendor: 'qualcomm',
      pathFilters: ['drivers/android'],
    });
    const aosp = registry.register({
      kind: 'aosp',
      displayName: 'Selected AOSP',
      rootPath: sourceRoot,
      rootAuthorization: 'native_picker',
      licenseTag: 'Apache-2.0',
      pathFilters: ['frameworks/base'],
    });

    const kernelResult = await new KernelSourceIngester(
      store,
      registry,
      selectedGate,
    ).ingest(kernel.codebaseId);
    expect(kernelResult.filesProcessed).toBe(1);
    expect(kernelResult.chunksAdded).toBeGreaterThan(0);

    const aospResult = await new AospSourceIngester(
      store,
      registry,
      selectedGate,
    ).ingest(aosp.codebaseId);
    expect(aospResult.filesProcessed).toBe(1);
    expect(aospResult.chunksAdded).toBeGreaterThan(0);
    await expect(selectedGate.preview(sourceRoot)).resolves.toMatchObject({
      blocked: true,
      blockedReason: 'root_outside_allowlist',
    });
  });
});
