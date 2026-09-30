// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

type BootstrapModule = typeof import('../bootstrap');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Evaluate modules the way `bin.ts` does: the env-first entry, then whatever
 * the CLI graph imports after it, in one fresh module registry.
 */
function loadCliEntry<T>(argv: string[], afterEntry: (bootstrap: BootstrapModule) => T): T {
  process.argv = [process.execPath, path.join(BACKEND_ROOT, 'src/cli-user/bin.ts'), ...argv];
  let result!: T;
  jest.isolateModules(() => {
    require('../envEntry');
    result = afterEntry(require('../bootstrap') as BootstrapModule);
  });
  return result;
}

describe('CLI env-first entry', () => {
  const originalArgv = process.argv;
  const originalCwd = process.cwd();
  const originalEnv = {...process.env};
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-cli-env-entry-')));
    for (const key of [
      'LOG_LEVEL',
      'TP_PORT_MIN',
      'SMARTPERFETTO_HOME',
      'SMARTPERFETTO_BACKEND_DATA_DIR',
      'SMARTPERFETTO_BACKEND_LOG_DIR',
      'SMARTPERFETTO_TRACE_UPLOAD_DIR',
      'SMARTPERFETTO_PACKAGE_ROOT',
      'SMARTPERFETTO_DISTRIBUTION',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('is the first import of bin.ts', () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, 'src/cli-user/bin.ts'), 'utf-8');
    const firstImport = source.match(/^import\s[^;]*;/m)?.[0];
    expect(firstImport).toBe("import './envEntry';");
    expect(source.match(/^import '\.\/envEntry';$/gm)).toHaveLength(1);
  });

  it('lets an --env-file reach module-scope config reads', () => {
    const envFile = path.join(tempDir, 'cli.env');
    fs.writeFileSync(envFile, 'LOG_LEVEL=debug\nTP_PORT_MIN=9345\n');
    const sessionDir = path.join(tempDir, 'home');

    const seen = loadCliEntry([`--env-file=${envFile}`, '--session-dir', sessionDir, 'doctor'], () => ({
      logLevel: (require('../../utils/logger') as typeof import('../../utils/logger')).getLogLevel(),
      tpPortMin: (require('../../config') as typeof import('../../config')).traceProcessorConfig.portRange.min,
      logDir: process.env.SMARTPERFETTO_BACKEND_LOG_DIR,
    }));

    expect(seen).toEqual({
      logLevel: 'debug',
      tpPortMin: 9345,
      logDir: path.join(sessionDir, 'runtime', 'logs'),
    });
  });

  it('lets the CLI home env file reach module-scope config reads', () => {
    const sessionDir = path.join(tempDir, 'home');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'env'), 'TP_PORT_MIN=9456\n');

    const tpPortMin = loadCliEntry([`--session-dir=${sessionDir}`, 'list'], () =>
      (require('../../config') as typeof import('../../config')).traceProcessorConfig.portRange.min);

    expect(tpPortMin).toBe(9456);
  });

  it('creates no directories until a command bootstraps', () => {
    const sessionDir = path.join(tempDir, 'home');

    const {bootstrap} = loadCliEntry(['--session-dir', sessionDir, '--help'], (b) => b);
    expect(fs.existsSync(sessionDir)).toBe(false);

    expect(bootstrap({sessionDir}).paths.home).toBe(sessionDir);
    expect(fs.existsSync(path.join(sessionDir, 'sessions'))).toBe(true);
  });

  it('records a missing --env-file and surfaces it from the command bootstrap', () => {
    const envFile = path.join(tempDir, 'missing.env');

    const {bootstrap} = loadCliEntry(['--env-file', envFile, 'doctor'], (b) => b);

    expect(() => bootstrap({envFile})).toThrow(`--env-file not found: ${envFile}`);
    expect(() => bootstrap({envFile})).toThrow(`--env-file not found: ${envFile}`);
  });

  it('records an unreadable --env-file instead of loading nothing', () => {
    const envFile = path.join(tempDir, 'a-directory');
    fs.mkdirSync(envFile);

    const {bootstrap} = loadCliEntry(['--env-file', envFile, 'doctor'], (b) => b);

    expect(() => bootstrap({envFile})).toThrow(`--env-file could not be read: ${envFile}`);
  });

  it('fails probe on the recorded env error without creating the layout', async () => {
    const envFile = path.join(tempDir, 'missing.env');
    const sessionDir = path.join(tempDir, 'home');
    const errors: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation((message) => { errors.push(String(message)); });
    try {
      const exitCode = await loadCliEntry(['--env-file', envFile, '--session-dir', sessionDir, 'probe'], () =>
        (require('../commands/probe') as typeof import('../commands/probe')).runProbeCommand({envFile, sessionDir}));

      expect(exitCode).toBe(1);
      expect(errors).toEqual([`env FAIL --env-file not found: ${envFile}`]);
      expect(fs.existsSync(sessionDir)).toBe(false);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('resolves user paths against the invocation directory after moving cwd', () => {
    process.chdir(tempDir);
    fs.writeFileSync(path.join(tempDir, 'cli.env'), 'LOG_LEVEL=warn\n');

    const {resolveInvocationPath, bootstrap} = loadCliEntry(
      ['--env-file', 'cli.env', '--session-dir', 'home', 'doctor'],
      (b) => b,
    );

    expect(process.cwd()).toBe(fs.realpathSync(BACKEND_ROOT));
    expect(process.env.LOG_LEVEL).toBe('warn');
    expect(resolveInvocationPath('trace.pftrace')).toBe(path.join(tempDir, 'trace.pftrace'));
    // Commander hands the command the same relative flags the entry read.
    expect(bootstrap({envFile: 'cli.env', sessionDir: 'home'}).paths.home).toBe(path.join(tempDir, 'home'));
  });

  it('refuses a command bootstrap that disagrees with the prepared environment', () => {
    const sessionDir = path.join(tempDir, 'a');
    const {bootstrap} = loadCliEntry(['--session-dir', sessionDir, 'list'], (b) => b);

    expect(bootstrap({sessionDir}).paths.home).toBe(sessionDir);
    expect(() => bootstrap({sessionDir: path.join(tempDir, 'b')}))
      .toThrow('CLI environment was prepared for a different --env-file/--session-dir');
  });

  it('fails the command when the raw scan misreads another option value', () => {
    const envFile = path.join(tempDir, 'x.env');
    fs.writeFileSync(envFile, '');
    // Commander reads `--env-file=...` here as the value of -q.
    const {bootstrap} = loadCliEntry(['run', 't.pftrace', '-q', `--env-file=${envFile}`], (b) => b);

    expect(() => bootstrap({})).toThrow('CLI environment was prepared for a different --env-file/--session-dir');
  });
});

describe('readCliEnvironmentArgs', () => {
  const {readCliEnvironmentArgs} = require('../bootstrap') as BootstrapModule;

  it.each([
    [['--env-file', 'a.env'], {envFile: 'a.env'}],
    [['--env-file=a.env', '--session-dir=/h'], {envFile: 'a.env', sessionDir: '/h'}],
    [['run', 't.pftrace', '--session-dir', '/h'], {sessionDir: '/h'}],
    [['--env-file', 'a.env', '--env-file=b.env'], {envFile: 'b.env'}],
    [['--env-file', '--verbose'], {envFile: '--verbose'}],
    [['--env-file'], {}],
    [['--', '--env-file', 'a.env'], {}],
    [['--env-files', 'a.env'], {}],
  ])('reads %j', (argv, expected) => {
    expect(readCliEnvironmentArgs(argv)).toEqual(expected);
  });
});
