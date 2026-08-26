// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {CodebaseRegistry, activeCodebaseGeneration} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {AospSourceIngester} from '../rag/aospSourceIngester';
import {RagStore} from '../ragStore';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-source-ingester-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('AospSourceIngester', () => {
  it('indexes an AOSP registration through the active generation contract', async () => {
    const root = path.join(tmpDir, 'aosp');
    const sourcePath = path.join(root, 'frameworks', 'base', 'core', 'java', 'android');
    fs.mkdirSync(sourcePath, {recursive: true});
    fs.writeFileSync(
      path.join(sourcePath, 'TraceHooks.java'),
      'package android;\nfinal class TraceHooks { void installTracing() {} }\n',
    );
    const registry = new CodebaseRegistry(path.join(tmpDir, 'registry.json'));
    const ref = registry.register({
      kind: 'aosp',
      displayName: 'AOSP',
      rootPath: root,
      pathFilters: ['frameworks/base'],
      licenseTag: 'Apache-2.0',
    });
    const store = new RagStore(path.join(tmpDir, 'rag.json'));

    const result = await new AospSourceIngester(
      store,
      registry,
      new PathSecurityGate({allowlistRoots: [root]}),
    ).ingest(ref.codebaseId);

    const active = registry.get(ref.codebaseId)!;
    expect(result).toEqual(expect.objectContaining({
      filesProcessed: 1,
      chunksAdded: expect.any(Number),
      errors: [],
    }));
    expect(result.chunksAdded).toBeGreaterThan(0);
    expect(active.lastIngestStatus).toBe('ok');
    expect(activeCodebaseGeneration(active)).toBe(active.activeGeneration);
  });
});
