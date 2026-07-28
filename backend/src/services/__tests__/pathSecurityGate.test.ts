// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {
  PathSecurityGate,
  isWithinAllowlist,
  openedFileIdentityError,
  readAcceptedTextFileSync,
} from '../codebase/pathSecurityGate';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-gate-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('PathSecurityGate', () => {
  it('uses path.relative boundary semantics for sibling paths', () => {
    const root = path.join(tmpDir, 'code');
    const sibling = path.join(tmpDir, 'code2');
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);

    expect(isWithinAllowlist(path.join(root), [root])).toBe(true);
    expect(isWithinAllowlist(path.join(sibling), [root])).toBe(false);
  });

  it('previews only allowed source files and skips excluded paths', async () => {
    const root = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.mkdirSync(path.join(root, 'build'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'MainActivity.kt'), 'class MainActivity\n');
    fs.writeFileSync(path.join(root, 'src', '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(root, 'build', 'Generated.kt'), 'class Generated\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# docs\n');

    const gate = new PathSecurityGate({allowlistRoots: [tmpDir]});
    const preview = await gate.preview(root);

    expect(preview.blocked).toBe(false);
    expect(preview.rootRealpath).toBe(fs.realpathSync(root));
    expect(preview.acceptedFiles.map(f => f.relativePath)).toEqual(['src/MainActivity.kt']);
    expect(preview.skippedFiles.map(f => f.relativePath)).toEqual(
      expect.arrayContaining(['README.md', 'src/.env']),
    );
  });

  it('uses Windows case-insensitive extension and excluded-directory semantics', async () => {
    const root = path.join(tmpDir, 'windows-repo');
    fs.mkdirSync(path.join(root, 'Node_Modules'), {recursive: true});
    fs.mkdirSync(path.join(root, 'SRC'), {recursive: true});
    fs.writeFileSync(path.join(root, 'Node_Modules', 'Hidden.KT'), 'class Hidden\n');
    fs.writeFileSync(path.join(root, 'SRC', 'Visible.KT'), 'class Visible\n');

    const preview = await new PathSecurityGate({allowlistRoots: [tmpDir], platform: 'win32'})
      .preview(root);

    expect(preview.acceptedFiles.map(file => file.relativePath)).toEqual(['SRC/Visible.KT']);
  });

  it('rejects roots outside the allowlist', async () => {
    const root = path.join(tmpDir, 'repo');
    fs.mkdirSync(root);
    const gate = new PathSecurityGate({allowlistRoots: [path.join(tmpDir, 'other')]});
    const preview = await gate.preview(root);
    expect(preview.blocked).toBe(true);
    expect(preview.blockedReason).toBe('root_outside_allowlist');
  });

  it('applies additional roots to one preview without mutating the gate allowlist', async () => {
    const root = path.join(tmpDir, 'selected-repo');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    const gate = new PathSecurityGate({
      allowlistRoots: [path.join(tmpDir, 'configured-only')],
    });

    const selectedPreview = await gate.preview(root, {
      additionalAllowlistRoots: [root],
    });
    const laterPreview = await gate.preview(root);

    expect(selectedPreview.blocked).toBe(false);
    expect(selectedPreview.acceptedFiles).toHaveLength(1);
    expect(laterPreview.blocked).toBe(true);
    expect(laterPreview.blockedReason).toBe('root_outside_allowlist');
  });

  it('bounds traversal and skipped diagnostics even when every path is disallowed', async () => {
    const root = path.join(tmpDir, 'path-flood');
    fs.mkdirSync(root);
    for (let index = 0; index < 12; index += 1) {
      fs.writeFileSync(path.join(root, `payload-${index}.bin`), 'ignored');
    }
    const preview = await new PathSecurityGate({
      allowlistRoots: [tmpDir],
      maxVisitedEntries: 5,
      maxSkippedDiagnostics: 2,
    }).preview(root);

    expect(preview.blocked).toBe(true);
    expect(preview.blockedReason).toBe('too_many_paths');
    expect(preview.skippedFiles).toHaveLength(2);
    expect(preview.skippedFileCount).toBeGreaterThan(preview.skippedFiles.length);
  });

  it('bounds directory traversal independently of accepted file count', async () => {
    const root = path.join(tmpDir, 'directory-flood');
    fs.mkdirSync(root);
    for (let index = 0; index < 6; index += 1) {
      fs.mkdirSync(path.join(root, `dir-${index}`));
    }
    const preview = await new PathSecurityGate({
      allowlistRoots: [tmpDir],
      maxDirectories: 3,
      maxVisitedEntries: 20,
    }).preview(root);

    expect(preview.blocked).toBe(true);
    expect(preview.blockedReason).toBe('too_many_paths');
    expect(preview.acceptedFiles).toEqual([]);
  });

  it('reads a dedicated knowledge-root environment allowlist at preview time', async () => {
    const root = path.join(tmpDir, 'wiki');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'article.md'), '# Article');
    process.env.SMARTPERFETTO_TEST_KNOWLEDGE_ROOTS = tmpDir;
    const gate = new PathSecurityGate({
      allowlistEnvironmentVariable: 'SMARTPERFETTO_TEST_KNOWLEDGE_ROOTS',
      allowedExtensions: ['.md'],
    });

    const preview = await gate.preview(root);

    delete process.env.SMARTPERFETTO_TEST_KNOWLEDGE_ROOTS;
    expect(preview.blocked).toBe(false);
    expect(preview.acceptedFiles).toEqual([{
      relativePath: 'article.md',
      sizeBytes: expect.any(Number),
    }]);
  });

  it('rejects an opened descriptor that no longer matches the previewed path identity', () => {
    expect(openedFileIdentityError(
      {dev: 1, ino: 10, size: 42, mtimeMs: 100},
      {dev: 1, ino: 11, size: 42, mtimeMs: 100},
      true,
    )).toBe('source_file_identity_changed');
  });

  it('rejects a canonical source root that is replaced by a symlink before reading', () => {
    if (process.platform === 'win32') return;
    const root = path.join(tmpDir, 'registered-root');
    const originalRoot = path.join(tmpDir, 'registered-root-original');
    const replacementRoot = path.join(tmpDir, 'replacement-root');
    fs.mkdirSync(root);
    fs.mkdirSync(replacementRoot);
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Original');
    fs.writeFileSync(path.join(replacementRoot, 'Main.kt'), 'class Replacement');
    const registeredRoot = fs.realpathSync(root);
    fs.renameSync(root, originalRoot);
    fs.symlinkSync(replacementRoot, root, 'dir');

    expect(() => readAcceptedTextFileSync(registeredRoot, 'Main.kt'))
      .toThrow('codebase_root_realpath_drift');
  });
});
