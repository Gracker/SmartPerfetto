// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as path from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';

import {
  hasConfiguredUserDataRoot,
  resolveUserDataRoot,
  userDataPath,
} from '../runtimePaths';

const originalDataDir = process.env.SMARTPERFETTO_BACKEND_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.SMARTPERFETTO_BACKEND_DATA_DIR;
  } else {
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = originalDataDir;
  }
});

describe('user data paths', () => {
  it('uses the explicit backend data directory as the durable user-data root', () => {
    const configured = path.resolve('/tmp', 'smartperfetto-explicit-data');
    const env = {SMARTPERFETTO_BACKEND_DATA_DIR: configured};
    expect(hasConfiguredUserDataRoot(env)).toBe(true);
    expect(resolveUserDataRoot(env, '/ignored-home')).toBe(configured);
  });

  it('falls back outside source package assets without treating the fallback as configured', () => {
    const home = path.resolve('/tmp', 'smartperfetto-home');
    expect(hasConfiguredUserDataRoot({})).toBe(false);
    expect(resolveUserDataRoot({}, home)).toBe(
      path.join(home, '.smartperfetto', 'runtime', 'data'),
    );
  });

  it('joins userDataPath segments at call time', () => {
    const configured = path.resolve('/tmp', 'smartperfetto-runtime-data');
    process.env.SMARTPERFETTO_BACKEND_DATA_DIR = configured;
    expect(userDataPath('self_improve', 'eval.db')).toBe(
      path.join(configured, 'self_improve', 'eval.db'),
    );
  });
});
