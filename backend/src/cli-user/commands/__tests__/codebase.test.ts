// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  runCodebasePreviewCommand,
  runCodebaseRegisterCommand,
  runCodebaseReindexCommand,
  runCodebaseSymbolsCommand,
} from '../codebase';

let tmpDir: string;
let sessionDir: string;
let root: string;
let logSpy: jest.SpiedFunction<typeof console.log>;
let errorSpy: jest.SpiedFunction<typeof console.error>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-codebase-'));
  sessionDir = path.join(tmpDir, 'sessions');
  root = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(root, 'drivers/android'), {recursive: true});
  fs.writeFileSync(path.join(root, 'drivers/android/binder.c'), [
    '// SPDX-License-Identifier: GPL-2.0-only',
    'int binder_wait_for_work(void) { return 0; }',
  ].join('\n'));
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('smp codebase command handlers', () => {
  it('previews through the source enumerator and reports backend coverage', async () => {
    fs.writeFileSync(path.join(root, 'lib.dart'), 'void main() {}\n');

    const code = await runCodebasePreviewCommand({
      rootPath: root,
      kind: 'app_source',
      pathFilters: [],
      excludeGlobs: [],
      sessionDir,
    });

    expect(code).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('"enumerationBackend":');
    expect(logSpy.mock.calls.join('\n')).toContain('"backendFidelity":');
  });

  it('supports dry-run registration without writing registry state', async () => {
    const code = await runCodebaseRegisterCommand({
      rootPath: root,
      kind: 'kernel_source',
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
      excludeGlobs: ['**/generated/**'],
      dryRun: true,
      sessionDir,
    });

    expect(code).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('"kind": "kernel_source"');
    expect(logSpy.mock.calls.join('\n')).toContain('"excludeGlobs"');
    expect(fs.existsSync(path.join(sessionDir, 'codebase_registry.json'))).toBe(false);
  });

  it('keeps the empty-selection code stable and prints an actionable explanation', async () => {
    const emptyRoot = path.join(tmpDir, 'empty-repo');
    fs.mkdirSync(emptyRoot, {recursive: true});

    const code = await runCodebaseRegisterCommand({
      rootPath: emptyRoot,
      kind: 'app_source',
      sessionDir,
    });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain('effective_source_selection_empty');
    expect(errorSpy.mock.calls.join('\n')).toMatch(/no source files.*filter|filter.*no source files/i);
  });

  it.each([
    ['kernel_source', {pathFilters: ['drivers/android'] as string[]}, 'vendor'],
    ['kernel_source', {vendor: 'mtk'}, 'pathFilters'],
    ['aosp', {}, 'licenseTag'],
    ['oem_sdk', {vendor: 'vendor'}, 'licenseTag'],
  ] as const)('enforces %s registration metadata before dry-run', async (kind, options, missing) => {
    const code = await runCodebaseRegisterCommand({
      rootPath: root,
      kind,
      dryRun: true,
      sessionDir,
      ...options,
    });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.join('\n')).toContain(`\`${missing}\` is required`);
    expect(fs.existsSync(path.join(sessionDir, 'codebase_registry.json'))).toBe(false);
  });

  it('registers, reindexes, and resolves kernel symbols', async () => {
    await runCodebaseRegisterCommand({
      rootPath: root,
      kind: 'kernel_source',
      name: 'mtk-kernel',
      vendor: 'mtk',
      pathFilters: ['drivers/android'],
      sendToProvider: true,
      sessionDir,
    });
    const firstLine = String(logSpy.mock.calls[logSpy.mock.calls.length - 1]?.[0] ?? '');
    const codebaseId = firstLine.split('\t')[0];

    const reindex = await runCodebaseReindexCommand({codebaseId, sessionDir});
    expect(reindex).toBe(0);

    const symbols = await runCodebaseSymbolsCommand({
      symbol: 'binder_wait_for_work',
      codebaseId,
      sessionDir,
    });
    expect(symbols).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('binder_wait_for_work');
  });
});
