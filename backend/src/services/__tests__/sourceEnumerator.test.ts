// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {execFileSync} from 'child_process';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';

import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {SourceEnumerator} from '../codebase/sourceEnumerator';
import {buildSourceSelectionIR} from '../codebase/sourceSelectionPolicy';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-enumerator-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

describe('SourceEnumerator', () => {
  it('falls back to a bounded node walk and reports degraded fidelity', async () => {
    const root = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.mkdirSync(path.join(root, '.repo', 'projects'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'Main.dart'), 'void main() {}\n');
    fs.writeFileSync(path.join(root, '.repo', 'projects', 'Secret.java'), 'class Secret {}\n');

    const result = await new SourceEnumerator({
      ripgrepPath: '__missing_rg__',
      gitPath: '__missing_git__',
      maxVisitedEntries: 100,
    }).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source', includePrefixes: ['src']}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result).toEqual(expect.objectContaining({
      backend: 'node-walk',
      fidelity: 'degraded',
      enumerationComplete: true,
      deterministic: true,
    }));
    expect(result.files).toEqual([{relativePath: 'src/Main.dart', sizeBytes: expect.any(Number)}]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('falls through an installed git that cannot enumerate a plain directory', async () => {
    const root = path.join(tmpDir, 'plain-directory');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');

    const result = await new SourceEnumerator({
      ripgrepPath: '__missing_rg__',
    }).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result).toEqual(expect.objectContaining({
      backend: 'node-walk',
      fidelity: 'degraded',
      enumerationComplete: true,
    }));
    expect(result.files.map(file => file.relativePath)).toEqual(['Main.kt']);
  });

  it('applies include prefixes before visiting unrelated large subtrees', async () => {
    const root = path.join(tmpDir, 'scoped');
    fs.mkdirSync(path.join(root, 'src', 'trace_processor'), {recursive: true});
    fs.mkdirSync(path.join(root, 'buildtools'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'trace_processor', 'engine.cc'), 'void Run() {}\n');
    for (let index = 0; index < 30; index += 1) {
      fs.writeFileSync(path.join(root, 'buildtools', `tool-${index}.cc`), 'void Tool() {}\n');
    }

    const result = await new SourceEnumerator({
      ripgrepPath: '__missing_rg__',
      gitPath: '__missing_git__',
      maxVisitedEntries: 8,
    }).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'aosp', includePrefixes: ['src/trace_processor']}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result.enumerationComplete).toBe(true);
    expect(result.files.map(file => file.relativePath)).toEqual(['src/trace_processor/engine.cc']);
  });

  it.each([
    ['git', true],
    ['node-walk', false],
  ] as const)('matches include-prefix casing with the %s backend on win32', async (
    expectedBackend,
    useGit,
  ) => {
    const root = path.join(tmpDir, `win32-prefix-${expectedBackend}`);
    fs.mkdirSync(path.join(root, 'Src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'Src', 'Main.kt'), 'class WindowsCaseNeedle\n');
    if (useGit) {
      execFileSync('git', ['init', '-q'], {cwd: root});
      execFileSync('git', ['add', 'Src/Main.kt'], {cwd: root});
    }

    const result = await new SourceEnumerator({
      platform: 'win32',
      ripgrepPath: '__missing_rg__',
      ...(useGit ? {} : {gitPath: '__missing_git__'}),
    } as any).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source', includePrefixes: ['src']}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result.backend).toBe(expectedBackend);
    expect(result.enumerationComplete).toBe(true);
    expect(result.files.map(file => file.relativePath)).toEqual(['Src/Main.kt']);
  });

  it('marks node-walk candidate inspection failures incomplete', async () => {
    const root = path.join(tmpDir, 'node-candidate-race');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Race.kt'), 'class Race\n');
    const enumerator = new SourceEnumerator({
      ripgrepPath: '__missing_rg__',
      gitPath: '__missing_git__',
    });
    jest.spyOn(enumerator as any, 'inspectCandidate')
      .mockRejectedValueOnce(new Error('simulated_candidate_disappearance'));

    const result = await enumerator.enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result).toEqual(expect.objectContaining({
      backend: 'node-walk',
      enumerationComplete: false,
      deterministic: false,
      incompleteReason: 'traversal_error',
    }));
  });

  it('fails closed if .gitmodules changes identity before descriptor open', async () => {
    const root = path.join(tmpDir, 'gitmodules-race');
    const outside = path.join(tmpDir, 'outside-gitmodules');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    fs.writeFileSync(path.join(root, '.gitmodules'), '');
    fs.writeFileSync(outside, '');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt'], {cwd: root});
    const originalOpen = fs.promises.open.bind(fs.promises);
    const open = jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: any[]) => {
      fs.unlinkSync(path.join(root, '.gitmodules'));
      fs.symlinkSync(outside, path.join(root, '.gitmodules'));
      return originalOpen(args[0], args[1], args[2]);
    });

    try {
      const result = await new SourceEnumerator({ripgrepPath: '__missing_rg__'}).enumerate({
        rootRealpath: fs.realpathSync(root),
        policy: buildSourceSelectionIR({kind: 'app_source'}),
        gate: new PathSecurityGate({allowlistRoots: [root]}),
      });
      expect(open).toHaveBeenCalled();
      expect(result.enumerationComplete).toBe(false);
      expect(result.incompleteReason).toBe('traversal_error');
    } finally {
      open.mockRestore();
    }
  });

  it('bounds a .gitmodules descriptor open that never resolves', async () => {
    const root = path.join(tmpDir, 'gitmodules-never-open');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    fs.writeFileSync(path.join(root, '.gitmodules'), '');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt', '.gitmodules'], {cwd: root});
    const open = jest.spyOn(fs.promises, 'open')
      .mockImplementationOnce(async (..._args: any[]) => await new Promise<never>(() => {}));
    let guard: NodeJS.Timeout | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('test_guard_timeout')), 300);
    });

    try {
      const result = await Promise.race([
        new SourceEnumerator({ripgrepPath: '__missing_rg__', timeoutMs: 50}).enumerate({
          rootRealpath: fs.realpathSync(root),
          policy: buildSourceSelectionIR({kind: 'app_source'}),
          gate: new PathSecurityGate({allowlistRoots: [root]}),
        }),
        guardFailure,
      ]);
      expect(open).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        backend: 'git',
        enumerationComplete: false,
        incompleteReason: 'time_budget',
      }));
    } finally {
      if (guard) clearTimeout(guard);
      open.mockRestore();
    }
  });

  it('bounds a .gitmodules lstat that never resolves', async () => {
    const root = path.join(tmpDir, 'gitmodules-never-lstat');
    const gitmodulesPath = path.join(root, '.gitmodules');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    fs.writeFileSync(gitmodulesPath, '');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt', '.gitmodules'], {cwd: root});
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    const lstat = jest.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: any[]) =>
      String(args[0]).endsWith(`${path.sep}.gitmodules`)
        ? await new Promise<never>(() => {})
        : originalLstat(args[0]));
    let guard: NodeJS.Timeout | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('test_guard_timeout')), 300);
    });

    try {
      const result = await Promise.race([
        new SourceEnumerator({ripgrepPath: '__missing_rg__', timeoutMs: 50}).enumerate({
          rootRealpath: fs.realpathSync(root),
          policy: buildSourceSelectionIR({kind: 'app_source'}),
          gate: new PathSecurityGate({allowlistRoots: [root]}),
        }),
        guardFailure,
      ]);
      expect(result).toEqual(expect.objectContaining({
        backend: 'git',
        enumerationComplete: false,
        incompleteReason: 'time_budget',
      }));
    } finally {
      if (guard) clearTimeout(guard);
      lstat.mockRestore();
    }
  });

  it('closes a .gitmodules handle that opens after its deadline', async () => {
    const root = path.join(tmpDir, 'gitmodules-late-open');
    const gitmodulesPath = path.join(root, '.gitmodules');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    fs.writeFileSync(gitmodulesPath, '');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt', '.gitmodules'], {cwd: root});
    const handle = await fs.promises.open(gitmodulesPath, fs.constants.O_RDONLY);
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
    let guard: NodeJS.Timeout | undefined;
    const guardFailure = new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error('test_guard_timeout')), 300);
    });

    try {
      const result = await Promise.race([
        new SourceEnumerator({ripgrepPath: '__missing_rg__', timeoutMs: 50}).enumerate({
          rootRealpath: fs.realpathSync(root),
          policy: buildSourceSelectionIR({kind: 'app_source'}),
          gate: new PathSecurityGate({allowlistRoots: [root]}),
        }),
        guardFailure,
      ]);
      expect(result).toEqual(expect.objectContaining({
        backend: 'git',
        enumerationComplete: false,
        incompleteReason: 'time_budget',
      }));
      const afterDeadline = jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
      try {
        releaseOpen(handle);
        await expect(Promise.race([closed, guardFailure])).resolves.toBeUndefined();
        expect(stat).not.toHaveBeenCalled();
      } finally {
        afterDeadline.mockRestore();
      }
    } finally {
      if (guard) clearTimeout(guard);
      releaseOpen(handle);
      open.mockRestore();
      close.mockRestore();
      stat.mockRestore();
      if (!handleClosed) await originalClose().catch(() => undefined);
    }
  });

  it('enumerates initialized git submodules in a second bounded pass', async () => {
    const child = path.join(tmpDir, 'child');
    fs.mkdirSync(child, {recursive: true});
    fs.writeFileSync(path.join(child, 'Child.kt'), 'class Child\n');
    execFileSync('git', ['init', '-q'], {cwd: child});
    execFileSync('git', ['add', 'Child.kt'], {cwd: child});
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'child'], {cwd: child});

    const root = path.join(tmpDir, 'parent');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt'], {cwd: root});
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child'], {cwd: root});
    execFileSync('git', ['add', '.gitmodules', 'vendor/child'], {cwd: root});

    const result = await new SourceEnumerator({ripgrepPath: '__missing_rg__'}).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result.backend).toBe('git');
    expect(result.enumerationComplete).toBe(true);
    expect(result.files.map(file => file.relativePath)).toEqual([
      'Main.kt',
      'vendor/child/Child.kt',
    ]);
  });

  it('keeps Git enumeration complete when an otherwise valid source exceeds the file budget', async () => {
    const root = path.join(tmpDir, 'git-large-file');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    fs.writeFileSync(path.join(root, 'Huge.kt'), 'x'.repeat(201 * 1024));
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', 'Main.kt', 'Huge.kt'], {cwd: root});

    const result = await new SourceEnumerator({ripgrepPath: '__missing_rg__'}).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result.backend).toBe('git');
    expect(result.enumerationComplete).toBe(true);
    expect(result.files.map(file => file.relativePath)).toEqual(['Main.kt']);
  });

  it('honors include-ignored policy in the Git discovery backend', async () => {
    const root = path.join(tmpDir, 'git-ignored-source');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, '.gitignore'), 'Ignored.kt\n');
    fs.writeFileSync(path.join(root, 'Ignored.kt'), 'class Ignored\n');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', '.gitignore'], {cwd: root});

    const result = await new SourceEnumerator({ripgrepPath: '__missing_rg__'}).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source', ignoreMode: 'include_ignored'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result.backend).toBe('git');
    expect(result.files.map(file => file.relativePath)).toEqual(['Ignored.kt']);
  });

  it('applies the whole-operation deadline while materializing candidates', async () => {
    const root = path.join(tmpDir, 'materialize-deadline');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'Main.kt'), 'class Main\n');
    const enumerator = new SourceEnumerator();

    const result = await (enumerator as any).materializeCandidates(
      root,
      buildSourceSelectionIR({kind: 'app_source'}),
      'git',
      'exact',
      {paths: ['Main.kt'], complete: true, stderrObserved: false},
      Date.now() - 1,
    );

    expect(result).toEqual(expect.objectContaining({
      enumerationComplete: false,
      deterministic: false,
      incompleteReason: 'time_budget',
    }));
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt.each([
    ['ripgrep', false],
    ['git', true],
  ] as const)('filters disallowed %s paths before enumeration budgets', async (_backend, useGit) => {
    const root = path.join(tmpDir, `budget-${_backend}`);
    fs.mkdirSync(path.join(root, 'src'), {recursive: true});
    fs.writeFileSync(path.join(root, 'src', 'Main.kt'), 'class Main\n');
    const executable = path.join(tmpDir, `fake-${_backend}`);
    const disallowed = Array.from({length: 100}, (_, index) => `assets/blob-${index}.bin`);
    fs.writeFileSync(executable, [
      '#!/usr/bin/env node',
      `process.stdout.write(Buffer.from(${JSON.stringify([...disallowed, 'src/Main.kt'].join('\0') + '\0')}, 'utf8'));`,
    ].join('\n'));
    fs.chmodSync(executable, 0o755);

    const result = await new SourceEnumerator({
      ripgrepPath: useGit ? '__missing_rg__' : executable,
      gitPath: useGit ? executable : '__missing_git__',
      maxVisitedEntries: 1,
      maxOutputBytes: 1024 * 1024,
    }).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result).toEqual(expect.objectContaining({
      backend: _backend,
      enumerationComplete: true,
      deterministic: true,
    }));
    expect(result.files).toEqual([{relativePath: 'src/Main.kt', sizeBytes: expect.any(Number)}]);
  });

  posixIt('bounds total subprocess output even when every path is rejected', async () => {
    const root = path.join(tmpDir, 'total-output-budget');
    fs.mkdirSync(root, {recursive: true});
    const executable = path.join(tmpDir, 'fake-noisy-rg');
    const disallowed = Array.from({length: 100}, (_, index) => `assets/${'x'.repeat(32)}-${index}.bin`);
    fs.writeFileSync(executable, [
      '#!/usr/bin/env node',
      `process.stdout.write(Buffer.from(${JSON.stringify(`${disallowed.join('\0')}\0`)}, 'utf8'));`,
    ].join('\n'));
    fs.chmodSync(executable, 0o755);

    const result = await new SourceEnumerator({
      ripgrepPath: executable,
      maxOutputBytes: 64,
    }).enumerate({
      rootRealpath: fs.realpathSync(root),
      policy: buildSourceSelectionIR({kind: 'app_source'}),
      gate: new PathSecurityGate({allowlistRoots: [root]}),
    });

    expect(result).toEqual(expect.objectContaining({
      enumerationComplete: false,
      incompleteReason: 'enumeration_budget',
    }));
  });

  it('streams node fallback directories before applying the entry budget', async () => {
    const root = path.join(tmpDir, 'streamed-node-directory');
    fs.mkdirSync(root, {recursive: true});
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(root, `File${index}.kt`), `class File${index}\n`);
    }
    const readdir = jest.spyOn(fs.promises, 'readdir');
    const opendir = jest.spyOn(fs.promises, 'opendir');

    try {
      const result = await new SourceEnumerator({
        ripgrepPath: '__missing_rg__',
        gitPath: '__missing_git__',
        maxVisitedEntries: 2,
      }).enumerate({
        rootRealpath: fs.realpathSync(root),
        policy: buildSourceSelectionIR({kind: 'app_source'}),
        gate: new PathSecurityGate({allowlistRoots: [root]}),
      });

      expect(readdir).not.toHaveBeenCalled();
      expect(opendir).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({
        enumerationComplete: false,
        incompleteReason: 'enumeration_budget',
      }));
    } finally {
      readdir.mockRestore();
      opendir.mockRestore();
    }
  });
});
