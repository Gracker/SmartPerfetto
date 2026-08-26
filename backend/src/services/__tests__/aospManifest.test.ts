// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {describe, expect, it, jest} from '@jest/globals';

import {parseAospManifestProjects, readAospManifestProjects} from '../codebase/aospManifest';
import {readBoundedMetadataFile} from '../codebase/boundedMetadataFile';

describe('AOSP manifest scope discovery', () => {
  it('returns bounded project paths and groups without repository internals', () => {
    const projects = parseAospManifestProjects(`
      <manifest>
        <project name="platform/frameworks/base" path="frameworks/base" groups="pdk,android" />
        <project name="platform/system/core" groups="android" />
        <project name="unsafe" path="../outside" groups="private" />
      </manifest>
    `);

    expect(projects).toEqual([
      {name: 'platform/frameworks/base', path: 'frameworks/base', groups: ['android', 'pdk']},
      {name: 'platform/system/core', path: 'platform/system/core', groups: ['android']},
    ]);
    expect(JSON.stringify(projects)).not.toContain('.repo');
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('rejects a selected-root identity that changes before manifest discovery', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-manifest-root-'));
    const first = path.join(tmpDir, 'first');
    const second = path.join(tmpDir, 'second');
    const selected = path.join(tmpDir, 'selected');
    for (const [root, name] of [[first, 'first/project'], [second, 'second/project']] as const) {
      fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
      fs.writeFileSync(
        path.join(root, '.repo', 'manifest.xml'),
        `<manifest><project name="${name}" /></manifest>`,
      );
    }
    fs.symlinkSync(first, selected, 'dir');
    const expectedRoot = fs.realpathSync(selected);
    fs.unlinkSync(selected);
    fs.symlinkSync(second, selected, 'dir');

    try {
      await expect(readAospManifestProjects(selected, expectedRoot))
        .rejects.toThrow('codebase_root_realpath_drift');
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  posixIt('rejects an ancestor-directory swap before manifest descriptor open', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-manifest-ancestor-'));
    const root = path.join(tmpDir, 'root');
    const manifests = path.join(root, '.repo', 'manifests');
    const savedManifests = path.join(root, '.repo', 'manifests-before-swap');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(manifests, {recursive: true});
    fs.mkdirSync(outside, {recursive: true});
    fs.writeFileSync(
      path.join(manifests, 'default.xml'),
      '<manifest><project name="inside/project" /></manifest>',
    );
    fs.writeFileSync(
      path.join(outside, 'default.xml'),
      '<manifest><project name="outside/project" /></manifest>',
    );
    fs.symlinkSync('manifests/default.xml', path.join(root, '.repo', 'manifest.xml'));
    const originalOpen = fs.promises.open.bind(fs.promises);
    const open = jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
      fs.renameSync(manifests, savedManifests);
      fs.symlinkSync(outside, manifests, 'dir');
      return originalOpen(args[0], args[1], args[2]);
    });

    try {
      await expect(readAospManifestProjects(root, fs.realpathSync(root)))
        .rejects.toThrow(/changed|outside|identity/);
    } finally {
      open.mockRestore();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  it('applies a bounded deadline to manifest metadata reads', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-manifest-deadline-'));
    const root = path.join(tmpDir, 'root');
    fs.mkdirSync(path.join(root, '.repo'), {recursive: true});
    fs.writeFileSync(
      path.join(root, '.repo', 'manifest.xml'),
      '<manifest><project name="platform/system/core" /></manifest>',
    );
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(Number.MAX_SAFE_INTEGER);

    try {
      await expect(readAospManifestProjects(root, fs.realpathSync(root)))
        .rejects.toThrow('source_metadata_time_budget');
    } finally {
      now.mockRestore();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  it('returns within a wall-clock timeout when filesystem metadata never resolves', async () => {
    const realpath = jest.spyOn(fs.promises, 'realpath')
      .mockImplementationOnce(async (..._args: any[]) => await new Promise<never>(() => {}));
    let guard: NodeJS.Timeout | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('test_guard_timeout')), 200);
    });

    try {
      await expect(Promise.race([
        readAospManifestProjects('/never-resolves', '/never-resolves', 20),
        guardFailure,
      ])).rejects.toThrow('source_metadata_time_budget');
    } finally {
      if (guard) clearTimeout(guard);
      realpath.mockRestore();
    }
  });

  it('closes a manifest handle that opens after the wall-clock timeout', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aosp-manifest-late-open-'));
    const root = path.join(tmpDir, 'root');
    const manifestPath = path.join(root, '.repo', 'manifest.xml');
    fs.mkdirSync(path.dirname(manifestPath), {recursive: true});
    fs.writeFileSync(manifestPath, '<manifest><project name="platform/system/core" /></manifest>');
    const handle = await fs.promises.open(manifestPath, fs.constants.O_RDONLY);
    const originalClose = handle.close.bind(handle);
    const stat = jest.spyOn(handle, 'stat');
    let releaseOpen!: (value: typeof handle) => void;
    const delayedOpen = new Promise<typeof handle>(resolve => {
      releaseOpen = resolve;
    });
    let reportClosed!: () => void;
    const closed = new Promise<void>(resolve => {
      reportClosed = resolve;
    });
    let handleClosed = false;
    const close = jest.spyOn(handle, 'close').mockImplementation(async () => {
      try {
        await originalClose();
      } finally {
        handleClosed = true;
        reportClosed();
      }
    });
    const open = jest.spyOn(fs.promises, 'open')
      .mockImplementationOnce(async (..._args: any[]) => await delayedOpen);
    let timeoutGuard: NodeJS.Timeout | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      timeoutGuard = setTimeout(() => reject(new Error('test_guard_timeout')), 200);
    });

    try {
      await expect(Promise.race([
        readAospManifestProjects(root, fs.realpathSync(root), 20),
        guardFailure,
      ])).rejects.toThrow('source_metadata_time_budget');
      const afterDeadline = jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
      try {
        releaseOpen(handle);
        await expect(Promise.race([closed, guardFailure])).resolves.toBeUndefined();
        expect(stat).not.toHaveBeenCalled();
      } finally {
        afterDeadline.mockRestore();
      }
    } finally {
      if (timeoutGuard) clearTimeout(timeoutGuard);
      releaseOpen(handle);
      open.mockRestore();
      close.mockRestore();
      stat.mockRestore();
      if (!handleClosed) await originalClose().catch(() => undefined);
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  it('uses Windows-compatible flags for bounded metadata files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-metadata-win32-'));
    const filePath = path.join(tmpDir, 'metadata.xml');
    fs.writeFileSync(filePath, '<manifest />');
    const open = jest.spyOn(fs.promises, 'open');
    const input: Parameters<typeof readBoundedMetadataFile>[0] & {platform: NodeJS.Platform} = {
      filePath,
      expectedRealpath: fs.realpathSync(filePath),
      maxBytes: 1024,
      platform: 'win32',
    };

    try {
      await expect(readBoundedMetadataFile(input)).resolves.toBe('<manifest />');
      expect(open).toHaveBeenCalledWith(filePath, fs.constants.O_RDONLY);
    } finally {
      open.mockRestore();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  it('fails closed when Windows file identity has no stable inode', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-metadata-win32-identity-'));
    const filePath = path.join(tmpDir, 'metadata.xml');
    fs.writeFileSync(filePath, '<manifest />');
    const actual = await fs.promises.lstat(filePath);
    const lstat = jest.spyOn(fs.promises, 'lstat').mockResolvedValueOnce({
      ...actual,
      ino: 0,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as typeof actual);

    try {
      await expect(readBoundedMetadataFile({
        filePath,
        expectedRealpath: fs.realpathSync(filePath),
        maxBytes: 1024,
        platform: 'win32',
      })).rejects.toThrow('source_metadata_identity_changed');
    } finally {
      lstat.mockRestore();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });
});
