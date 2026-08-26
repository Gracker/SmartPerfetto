// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';

import {describe, expect, it} from '@jest/globals';

import type {CodebaseRef} from '../codebase/codebaseRegistry';
import type {PathPreviewResult} from '../codebase/pathSecurityGate';
import {
  MAX_SOURCE_CHUNKS_PER_GENERATION,
  assertCodebaseRootIdentity,
  resolveMaxSourceChunks,
  inspectSourceGeneration,
  selectCodebasePreviewFiles,
  selectEnumeratedSourceFiles,
} from '../rag/sourceFileSelection';

const ref: CodebaseRef = {
  codebaseId: 'cb-test',
  kind: 'app_source',
  displayName: 'App',
  rootPath: '/repo',
  rootRealpath: '/repo',
  pathFilters: ['app/src'],
  consent: {
    sendToProvider: false,
    consentedAt: 1,
    consentedBy: 'test',
    consentHash: 'hash',
  },
  indexGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};

const preview: PathPreviewResult = {
  rootPath: '/repo',
  rootRealpath: '/repo',
  blocked: false,
  acceptedFiles: [
    {relativePath: 'app/src/Main.kt', sizeBytes: 1},
    {relativePath: 'tools/Secret.kt', sizeBytes: 1},
  ],
  skippedFiles: [],
  skippedFileCount: 0,
};

describe('selectCodebasePreviewFiles', () => {
  it('rejects physical root drift while preserving Windows case-insensitive identity', () => {
    expect(() => assertCodebaseRootIdentity('/repo/source', '/repo/other', 'linux'))
      .toThrow('codebase_root_realpath_drift');
    expect(() => assertCodebaseRootIdentity('C:\\Repo\\Source', 'c:\\repo\\source', 'win32'))
      .not.toThrow();
  });

  it('intersects a request prefix with registered filters instead of expanding them', () => {
    expect(selectCodebasePreviewFiles(preview, ref, 'tools')).toEqual([]);
    expect(selectCodebasePreviewFiles(preview, ref, 'app')).toEqual([preview.acceptedFiles[0]]);
  });

  it('matches registered filters, request prefixes, and exclude globs case-insensitively on Windows', () => {
    const windowsRef: CodebaseRef = {
      ...ref,
      pathFilters: ['APP/SRC'],
      excludeGlobs: ['**/GENERATED/**'],
    };
    const windowsPreview: PathPreviewResult = {
      ...preview,
      acceptedFiles: [
        {relativePath: 'app/src/Main.KT', sizeBytes: 1},
        {relativePath: 'app/src/Generated/Skip.kt', sizeBytes: 1},
      ],
    };

    expect(selectCodebasePreviewFiles(windowsPreview, windowsRef, 'App/Src', 'win32'))
      .toEqual([windowsPreview.acceptedFiles[0]]);
  });

  it('applies a finite generation-wide chunk limit', () => {
    expect(resolveMaxSourceChunks(undefined)).toBe(MAX_SOURCE_CHUNKS_PER_GENERATION);
    expect(resolveMaxSourceChunks(7)).toBe(7);
    expect(() => resolveMaxSourceChunks(0)).toThrow('maxChunks must be an integer');
    expect(() => resolveMaxSourceChunks(MAX_SOURCE_CHUNKS_PER_GENERATION + 1))
      .toThrow('maxChunks must be an integer');
  });

  it('filters a max-size enumerated corpus without rebuilding selection policy per file', () => {
    const largeRef: CodebaseRef = {
      ...ref,
      excludeGlobs: Array.from({length: 128}, (_, index) =>
        `**/generated-${index}/**`),
    };
    const enumeration = {
      backend: 'git' as const,
      fidelity: 'exact' as const,
      files: Array.from({length: 20_000}, (_, index) => ({
        relativePath: `app/src/module-${index}/Main.kt`,
        sizeBytes: 1,
      })),
      enumerationComplete: true,
      deterministic: true,
      skipped: [],
      skippedCount: 0,
    };
    const startedAt = Date.now();

    const selected = selectEnumeratedSourceFiles(
      enumeration,
      largeRef,
      undefined,
      20_000,
      20_000,
    );

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(selected.files).toHaveLength(20_000);
  });

  it('does not execute repository-controlled core.fsmonitor while reading git provenance', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-generation-git-'));
    const marker = path.join(root, 'fsmonitor-marker');
    const fsmonitor = path.join(root, 'fsmonitor.sh');
    try {
      fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
      fs.writeFileSync(fsmonitor, [
        '#!/bin/sh',
        `touch '${marker}'`,
        'exit 0',
        '',
      ].join('\n'));
      fs.chmodSync(fsmonitor, 0o700);
      execFileSync('git', ['init', '-q'], {cwd: root});
      execFileSync('git', ['add', 'Main.kt'], {cwd: root});
      execFileSync(
        'git',
        ['-c', 'user.name=SmartPerfetto Test', '-c', 'user.email=test@smartperfetto.local', 'commit', '-qm', 'fixture'],
        {cwd: root},
      );
      execFileSync('git', ['config', 'core.fsmonitor', fsmonitor], {cwd: root});

      await inspectSourceGeneration(
        root,
        [{relativePath: 'Main.kt', sizeBytes: 11}],
        (_sourceRoot, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'),
      );

      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('degrades to content-only provenance when git status exceeds its deadline', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-generation-slow-git-'));
    const fakeBin = path.join(root, 'bin');
    const git = path.join(fakeBin, 'git');
    const previousPath = process.env.PATH;
    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
      fs.writeFileSync(git, [
        '#!/bin/sh',
        'case " $* " in',
        "  *' rev-parse HEAD '*) printf '%s\\n' '0123456789abcdef0123456789abcdef01234567' ;;",
        "  *' status --porcelain=v1 '*) exec /bin/sleep 12 ;;",
        '  *) exit 2 ;;',
        'esac',
        '',
      ].join('\n'));
      fs.chmodSync(git, 0o700);
      process.env.PATH = fakeBin + path.delimiter + (previousPath ?? '');
      const startedAt = Date.now();
      const provenance = await inspectSourceGeneration(
        root,
        [{relativePath: 'Main.kt', sizeBytes: 11}],
        (_sourceRoot, relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(10_000);
      expect(provenance).toMatchObject({
        sourceDirty: false,
        commitProvenance: 'content_only',
      });
      expect(provenance.indexedRevision).toBeUndefined();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, {recursive: true, force: true});
    }
  });
});
