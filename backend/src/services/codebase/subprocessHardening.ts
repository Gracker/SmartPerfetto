// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const PASSTHROUGH_ENVIRONMENT_KEYS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;

export function minimalSubprocessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return {...environment, ...overrides};
}

export function hardenedRipgrepEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return minimalSubprocessEnvironment(source, {RIPGREP_CONFIG_PATH: ''});
}

export function hardenedRipgrepPrefixArguments(maxFileBytes: number): string[] {
  return [
    '--no-config',
    '--no-require-git',
    '--hidden',
    '--glob',
    '!**/.git/',
    '--glob',
    '!**/.repo/',
    '--max-filesize',
    String(maxFileBytes),
  ];
}

export function hardenedGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return minimalSubprocessEnvironment(source, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
}

export function hardenedGitPrefixArguments(root: string): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-C',
    root,
  ];
}
