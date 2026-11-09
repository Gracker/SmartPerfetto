// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {
  isLocalDirectoryPickerRequest,
  NativeDirectoryPicker,
} from '../codebase/nativeDirectoryPicker';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-picker-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true});
});

function localPicker(
  overrides: ConstructorParameters<typeof NativeDirectoryPicker>[0] = {},
): NativeDirectoryPicker {
  return new NativeDirectoryPicker({
    platform: 'linux',
    env: {DISPLAY: ':0', PATH: '/usr/bin'},
    distribution: 'source',
    enterprise: false,
    bindHost: '127.0.0.1',
    findExecutable: name => name === 'zenity' ? '/usr/bin/zenity' : undefined,
    runCommand: async () => ({stdout: `${tmpDir}\n`, stderr: ''}),
    ...overrides,
  });
}

describe('NativeDirectoryPicker capability', () => {
  it.each([
    [{distribution: 'docker' as const}, 'unsupported_distribution'],
    [{enterprise: true}, 'enterprise_mode'],
    [{bindHost: '0.0.0.0'}, 'non_loopback_bind'],
    [{
      env: {PATH: '/usr/bin'},
      findExecutable: () => undefined,
    }, 'no_graphical_session'],
    [{
      findExecutable: () => undefined,
    }, 'no_supported_dialog'],
  ])('fails closed for unavailable local-host conditions', (overrides, reason) => {
    expect(localPicker(overrides).capability()).toMatchObject({
      available: false,
      reason,
    });
  });

  it('requires loopback Host, socket, and Origin when invoked by the UI', () => {
    expect(isLocalDirectoryPickerRequest({
      hostname: 'localhost',
      remoteAddress: '::ffff:127.0.0.1',
      origin: 'http://127.0.0.1:10000',
    })).toBe(true);
    expect(isLocalDirectoryPickerRequest({
      hostname: 'localhost',
      remoteAddress: '10.0.0.8',
      origin: 'http://127.0.0.1:10000',
    })).toBe(false);
    expect(isLocalDirectoryPickerRequest({
      hostname: 'localhost',
      remoteAddress: '127.0.0.1',
      origin: 'https://smartperfetto.example.com',
    })).toBe(false);
    expect(isLocalDirectoryPickerRequest({
      hostname: 'smartperfetto.example.com',
      remoteAddress: '127.0.0.1',
    })).toBe(false);
    expect(isLocalDirectoryPickerRequest({
      hostname: 'localhost',
      remoteAddress: '127.0.0.1',
    })).toBe(false);
    expect(isLocalDirectoryPickerRequest({
      hostname: 'localhost',
      remoteAddress: '127.0.0.1',
    }, {allowMissingOrigin: true})).toBe(true);
  });

  it('builds static native commands for macOS and Windows', async () => {
    const macRunner = jest.fn(async (
      _executable: string,
      _args: readonly string[],
    ) => ({stdout: `${tmpDir}\n`, stderr: ''}));
    const macPicker = localPicker({
      platform: 'darwin',
      env: {PATH: '/usr/bin'},
      findExecutable: name => name === 'osascript' ? '/usr/bin/osascript' : undefined,
      runCommand: macRunner,
    });
    await expect(macPicker.chooseDirectory({})).resolves.toMatchObject({
      selected: true,
      rootPath: fs.realpathSync(tmpDir),
    });
    expect(macPicker.capability()).toMatchObject({provider: 'macos'});
    expect(macRunner).toHaveBeenCalledWith(
      expect.stringContaining('osascript'),
      expect.arrayContaining(['-e']),
    );

    const windowsRunner = jest.fn(async (
      _executable: string,
      _args: readonly string[],
    ) => ({
      stdout: 'C:\\Source\\App\r\n',
      stderr: '',
    }));
    const windowsPicker = localPicker({
      platform: 'win32',
      env: {PATH: 'C:\\Windows'},
      findExecutable: name => name === 'powershell.exe'
        ? 'C:\\Windows\\powershell.exe'
        : undefined,
      runCommand: windowsRunner,
      resolveDirectory: () => tmpDir,
    });
    await expect(windowsPicker.chooseDirectory({})).resolves.toMatchObject({
      selected: true,
      rootPath: tmpDir,
    });
    expect(windowsPicker.capability()).toMatchObject({provider: 'windows'});
    expect(windowsRunner).toHaveBeenCalledWith(
      'C:\\Windows\\powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-STA']),
    );
  });

  it('uses Windows selection with wslpath in WSL and kdialog as a Linux fallback', async () => {
    const wslRunner = jest.fn(async (
      executable: string,
      _args: readonly string[],
    ) => (
      executable === '/usr/bin/wslpath'
        ? {stdout: `${tmpDir}\n`, stderr: ''}
        : {stdout: 'C:\\Source\\App\r\n', stderr: ''}
    ));
    const wslPicker = localPicker({
      env: {PATH: '/usr/bin', WSL_DISTRO_NAME: 'Ubuntu'},
      findExecutable: name => ({
        'powershell.exe': '/mnt/c/Windows/powershell.exe',
        wslpath: '/usr/bin/wslpath',
      })[name],
      runCommand: wslRunner,
    });
    await expect(wslPicker.chooseDirectory({})).resolves.toMatchObject({
      selected: true,
      rootPath: fs.realpathSync(tmpDir),
    });
    expect(wslPicker.capability()).toMatchObject({provider: 'windows_wsl'});
    expect(wslRunner).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/wslpath',
      ['-u', 'C:\\Source\\App'],
    );

    const kdialogRunner = jest.fn(async (
      _executable: string,
      _args: readonly string[],
    ) => ({
      stdout: `${tmpDir}\n`,
      stderr: '',
    }));
    const kdialogPicker = localPicker({
      findExecutable: name => name === 'kdialog' ? '/usr/bin/kdialog' : undefined,
      runCommand: kdialogRunner,
    });
    await expect(kdialogPicker.chooseDirectory({})).resolves.toMatchObject({
      selected: true,
    });
    expect(kdialogPicker.capability()).toMatchObject({provider: 'kdialog'});
    expect(kdialogRunner).toHaveBeenCalledWith(
      '/usr/bin/kdialog',
      ['--getexistingdirectory', '.', '--title', 'Choose a source code folder'],
    );
  });
});

describe('NativeDirectoryPicker selection authorization', () => {
  it('binds a short-lived selection to its canonical path and scope', async () => {
    let now = 1000;
    const picker = localPicker({
      now: () => now,
      idGenerator: () => 'selection-a',
      selectionTtlMs: 5000,
    });
    const scope = {
      tenantId: 'tenant-a',
      workspaceId: 'workspace-a',
      userId: 'user-a',
    };

    const result = await picker.chooseDirectory(scope);

    expect(result).toMatchObject({
      selected: true,
      rootPath: fs.realpathSync(tmpDir),
      directorySelectionId: 'selection-a',
      expiresAt: 6000,
    });
    expect(picker.validateSelection('selection-a', tmpDir, scope))
      .toBe(fs.realpathSync(tmpDir));
    expect(() => picker.validateSelection('selection-a', tmpDir, {
      ...scope,
      userId: 'user-b',
    })).toThrow(expect.objectContaining({
      code: 'DIRECTORY_SELECTION_SCOPE_MISMATCH',
    }));

    await picker.runWithSelection('selection-a', tmpDir, scope, () => undefined);
    await expect(picker.runWithSelection(
      'selection-a',
      tmpDir,
      scope,
      () => undefined,
    ))
      .rejects.toMatchObject({
        code: 'DIRECTORY_SELECTION_NOT_FOUND',
      });

    const second = await picker.chooseDirectory(scope);
    expect(second.selected).toBe(true);
    now = 7000;
    expect(() => picker.validateSelection('selection-a', tmpDir, scope))
      .toThrow(expect.objectContaining({
        code: 'DIRECTORY_SELECTION_EXPIRED',
      }));
  });

  it('does not authorize a different directory with a valid selection id', async () => {
    const otherDir = path.join(tmpDir, 'other');
    fs.mkdirSync(otherDir);
    const picker = localPicker({idGenerator: () => 'selection-path'});
    const result = await picker.chooseDirectory({});
    expect(result.selected).toBe(true);

    await expect(picker.runWithSelection(
      'selection-path',
      otherDir,
      {},
      () => undefined,
    ))
      .rejects.toMatchObject({
        code: 'DIRECTORY_SELECTION_PATH_MISMATCH',
      });
    await expect(picker.runWithSelection(
      'selection-path',
      tmpDir,
      {},
      rootRealpath => rootRealpath,
    ))
      .resolves.toBe(fs.realpathSync(tmpDir));
  });

  it('restores a selection when its synchronous persistence step fails', async () => {
    const picker = localPicker({idGenerator: () => 'selection-retry'});
    await picker.chooseDirectory({});

    await expect(picker.runWithSelection(
      'selection-retry',
      tmpDir,
      {},
      () => {
        throw new Error('persist_failed');
      },
    )).rejects.toThrow('persist_failed');

    await expect(picker.runWithSelection(
      'selection-retry',
      tmpDir,
      {},
      rootRealpath => rootRealpath,
    )).resolves.toBe(fs.realpathSync(tmpDir));
    expect(() => picker.validateSelection('selection-retry', tmpDir, {}))
      .toThrow(expect.objectContaining({
        code: 'DIRECTORY_SELECTION_NOT_FOUND',
      }));
  });

  it('takes a selection for an asynchronous operation: a concurrent replay is refused, a failure gives it back', async () => {
    let now = 1000;
    const picker = localPicker({idGenerator: () => 'selection-async', now: () => now, selectionTtlMs: 5000});
    await picker.chooseDirectory({});
    // A preview checks the selection without using it up.
    expect(picker.validateSelection('selection-async', tmpDir, {})).toBe(fs.realpathSync(tmpDir));
    expect(picker.validateSelection('selection-async', tmpDir, {})).toBe(fs.realpathSync(tmpDir));

    let failFirst: ((error: Error) => void) | undefined;
    const first = picker.runWithSelection('selection-async', tmpDir, {},
      () => new Promise<never>((_resolve, reject) => { failFirst = reject; }));
    await expect(picker.runWithSelection('selection-async', tmpDir, {}, () => 'replayed'))
      .rejects.toMatchObject({code: 'DIRECTORY_SELECTION_NOT_FOUND'});
    expect(() => picker.validateSelection('selection-async', tmpDir, {}))
      .toThrow(expect.objectContaining({code: 'DIRECTORY_SELECTION_NOT_FOUND'}));
    failFirst!(new Error('register_failed'));
    await expect(first).rejects.toThrow('register_failed');

    // Given back after the failure, then used up by a success.
    await expect(picker.runWithSelection('selection-async', tmpDir, {}, async root => root))
      .resolves.toBe(fs.realpathSync(tmpDir));
    await expect(picker.runWithSelection('selection-async', tmpDir, {}, () => 'again'))
      .rejects.toMatchObject({code: 'DIRECTORY_SELECTION_NOT_FOUND'});

    // A selection that expired while its operation ran is not given back.
    await picker.chooseDirectory({});
    await expect(picker.runWithSelection('selection-async', tmpDir, {}, async () => {
      now = 7000;
      throw new Error('slow_failure');
    })).rejects.toThrow('slow_failure');
    expect(() => picker.validateSelection('selection-async', tmpDir, {}))
      .toThrow(expect.objectContaining({code: 'DIRECTORY_SELECTION_NOT_FOUND'}));
  });

  it('titles the dialog by what the folder is for', async () => {
    const runCommand = jest.fn(async (_executable: string, _args: readonly string[]) =>
      ({stdout: `${tmpDir}\n`, stderr: ''}));
    const picker = localPicker({runCommand});
    await picker.chooseDirectory({}, 'knowledge');
    await picker.chooseDirectory({});
    expect(runCommand.mock.calls[0]![1]).toContain('--title=Choose a documents folder');
    expect(runCommand.mock.calls[1]![1]).toContain('--title=Choose a source code folder');
  });

  it('limits pending selections and allows only one system dialog at a time', async () => {
    let releaseDialog: ((value: {stdout: string; stderr: string}) => void) | undefined;
    const runCommand = jest.fn(() => new Promise<{stdout: string; stderr: string}>(
      resolve => {
        releaseDialog = resolve;
      },
    ));
    const picker = localPicker({
      runCommand,
      maxPendingSelectionsPerScope: 1,
      idGenerator: () => 'selection-limit',
    });

    const first = picker.chooseDirectory({});
    await expect(picker.chooseDirectory({})).rejects.toMatchObject({
      code: 'DIRECTORY_PICKER_BUSY',
    });
    releaseDialog?.({stdout: `${tmpDir}\n`, stderr: ''});
    await expect(first).resolves.toMatchObject({selected: true});
    await expect(picker.chooseDirectory({})).rejects.toMatchObject({
      code: 'DIRECTORY_SELECTION_LIMIT_REACHED',
    });
  });

  it('classifies a native cancel separately from picker failures', async () => {
    const cancelled = localPicker({
      runCommand: async () => {
        const error = new Error('cancelled') as Error & {code: number; stderr: string};
        error.code = 1;
        error.stderr = '';
        throw error;
      },
    });
    await expect(cancelled.chooseDirectory({})).resolves.toEqual({
      selected: false,
      cancelled: true,
    });

    const failed = localPicker({
      runCommand: async () => {
        throw new Error('boom');
      },
    });
    await expect(failed.chooseDirectory({})).rejects.toEqual(
      expect.objectContaining({
        code: 'DIRECTORY_PICKER_FAILED',
      }),
    );

    const timeout = localPicker({
      runCommand: async () => {
        const error = new Error('timed out') as Error & {
          code: number;
          killed: boolean;
        };
        error.code = 1;
        error.killed = true;
        throw error;
      },
    });
    await expect(timeout.chooseDirectory({})).rejects.toEqual(
      expect.objectContaining({
        code: 'DIRECTORY_PICKER_TIMEOUT',
      }),
    );

    const unexpectedExit = localPicker({
      runCommand: async () => {
        const error = new Error('unexpected') as Error & {code: number};
        error.code = 2;
        throw error;
      },
    });
    await expect(unexpectedExit.chooseDirectory({})).rejects.toEqual(
      expect.objectContaining({
        code: 'DIRECTORY_PICKER_FAILED',
      }),
    );
  });
});

describe('NativeDirectoryPicker default path', () => {
  function recording(overrides: ConstructorParameters<typeof NativeDirectoryPicker>[0] = {}) {
    const calls: Array<{executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv}> = [];
    const picker = localPicker({
      homeDirectory: '/home/me',
      statDirectory: async () => true,
      runCommand: async (executable, args, env) => {
        calls.push({executable, args, env});
        return {stdout: `${tmpDir}\n`, stderr: ''};
      },
      ...overrides,
    });
    return {picker, calls};
  }

  it('starts the dialog at a typed folder as an argument', async () => {
    const {picker, calls} = recording();
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', '~/work/app');
    expect(calls[0].args).toContain('--filename=/home/me/work/app/');
  });

  it('passes the path to AppleScript as argv, never as source', async () => {
    const hostile = '/Volumes/x" & (do shell script "id") & "';
    const {picker, calls} = recording({platform: 'darwin', findExecutable: () => '/usr/bin/osascript'});
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', hostile);
    const script = calls[0].args.slice(0, -1).join(' ');
    expect(script).not.toContain('do shell script');
    expect(calls[0].args[calls[0].args.length - 1]).toBe(hostile);
  });

  it('passes the path to PowerShell through the environment', async () => {
    const {picker, calls} = recording({
      platform: 'win32',
      env: {SystemRoot: tmpDir, PATH: ''},
      homeDirectory: 'C:\\Users\\me',
      findExecutable: name => name === 'powershell.exe' ? 'powershell.exe' : undefined,
    });
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', 'D:\\src\\app');
    expect(calls[0].args.join(' ')).not.toContain('D:\\src');
    expect(calls[0].env?.SMARTPERFETTO_PICKER_DEFAULT_PATH).toBe('D:\\src\\app');
  });

  it.each([
    ['the filesystem root', '/'],
    ['the home directory', '/home/me'],
    ['a hidden directory in home', '/home/me/.ssh'],
    ['a folder inside a hidden directory', '/home/me/.codex/sessions'],
    ['a relative path', 'work/app'],
    ['a network path', '//server/share'],
    ['control characters', '/home/me/a\nb'],
    ['a very long path', `/home/me/${'a'.repeat(2000)}`],
  ])('ignores %s', async (_label, value) => {
    const {picker, calls} = recording();
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', value);
    expect(calls[0].args.join(' ')).not.toContain('--filename');
  });

  it.each(['/\\server\\share\\sub', '\\/server\\share\\sub', '\\\\server\\share'])('never stats the Windows network path %s', async value => {
    const statDirectory = jest.fn(async () => true);
    const {picker} = recording({
      platform: 'win32',
      env: {SystemRoot: tmpDir, PATH: ''},
      homeDirectory: 'C:\\Users\\me',
      findExecutable: name => name === 'powershell.exe' ? 'powershell.exe' : undefined,
      statDirectory,
    });
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', value);
    expect(statDirectory).not.toHaveBeenCalled();
  });

  it('ignores a folder that does not exist', async () => {
    const {picker, calls} = recording({statDirectory: async () => false});
    await picker.chooseDirectory({tenantId: 't', workspaceId: 'w', userId: 'u'}, 'codebase', '/srv/missing');
    expect(calls[0].args.join(' ')).not.toContain('--filename');
  });
});

describe('NativeDirectoryPicker confirmation', () => {
  it('passes the text as data', async () => {
    const calls: Array<readonly string[]> = [];
    const picker = localPicker({
      platform: 'darwin',
      findExecutable: () => '/usr/bin/osascript',
      runCommand: async (_executable, args) => {
        calls.push(args);
        return {stdout: '', stderr: ''};
      },
    });
    await expect(picker.confirm('Endpoint: "); do shell script "id')).resolves.toBe(true);
    expect(calls[0].slice(0, -1).join(' ')).not.toContain('do shell script');
  });

  it('reads a declined dialog as no', async () => {
    const picker = localPicker({
      runCommand: async () => {
        throw Object.assign(new Error('declined'), {code: 1, stderr: ''});
      },
    });
    await expect(picker.confirm('Message')).resolves.toBe(false);
  });

  it('is refused where no dialog can be shown', async () => {
    await expect(localPicker({distribution: 'docker'}).confirm('Message'))
      .rejects.toMatchObject({code: 'DIRECTORY_PICKER_UNAVAILABLE'});
  });
});
