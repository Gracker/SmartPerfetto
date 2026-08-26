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
      maxOutputBytes: 32,
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
});
