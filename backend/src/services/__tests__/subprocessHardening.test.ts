// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  hardenedGitEnvironment,
  hardenedGitPrefixArguments,
  hardenedRipgrepEnvironment,
  hardenedRipgrepPrefixArguments,
} from '../codebase/subprocessHardening';

describe('codebase subprocess hardening', () => {
  it('disables ripgrep config injection and symlink following', () => {
    const env = hardenedRipgrepEnvironment({
      PATH: '/usr/bin',
      HOME: '/private/user',
      RIPGREP_CONFIG_PATH: '/tmp/hostile-ripgreprc',
      SECRET_TOKEN: 'must-not-leak',
    });
    const args = hardenedRipgrepPrefixArguments(200 * 1024);

    expect(args).toEqual(expect.arrayContaining([
      '--no-config',
      '--no-require-git',
      '--hidden',
      '--glob',
      '!**/.git/',
      '--glob',
      '!**/.repo/',
    ]));
    expect(args).not.toContain('-L');
    expect(args).not.toContain('--follow');
    expect(env.RIPGREP_CONFIG_PATH).toBe('');
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it('disables repository-controlled git hooks and fsmonitor helpers', () => {
    const args = hardenedGitPrefixArguments('/repo');
    const env = hardenedGitEnvironment({
      PATH: '/usr/bin',
      HOME: '/private/user',
      GIT_CONFIG_GLOBAL: '/tmp/hostile.gitconfig',
      SECRET_TOKEN: 'must-not-leak',
    });

    expect(args).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      '/repo',
    ]);
    expect(env).toEqual(expect.objectContaining({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    }));
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  it('uses the native Windows null device for git configuration and hooks', () => {
    const args = hardenedGitPrefixArguments('C:\\repo', 'win32');
    const env = hardenedGitEnvironment({PATH: 'C:\\Git\\bin'}, 'win32');

    expect(args).toEqual(expect.arrayContaining([
      'core.hooksPath=NUL',
    ]));
    expect(env.GIT_CONFIG_GLOBAL).toBe('NUL');
  });
});
