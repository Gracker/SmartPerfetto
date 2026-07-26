// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {ApplicationUpdateStatus} from '../../services/applicationUpdate/types';
import {beginCliUpdateNotice} from '../updateNotice';

let home: string;
const status: ApplicationUpdateStatus = {
  schemaVersion: 1,
  state: 'update_available',
  checkedAt: '2026-07-26T08:00:00.000Z',
  source: 'npm-registry',
  current: {
    distribution: 'npm',
    channel: 'stable',
    version: '1.2.2',
    target: {os: 'linux', arch: 'x64'},
    signingMode: 'npm-registry',
  },
  latest: {
    version: '1.3.0',
    releaseUrl: 'https://www.npmjs.com/package/@gracker/smartperfetto/v/1.3.0',
  },
  action: {
    kind: 'npm',
    command: 'npm install -g @gracker/smartperfetto@latest',
    url: 'https://www.npmjs.com/package/@gracker/smartperfetto/v/1.3.0',
  },
};

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-update-notice-'));
});

afterAll(async () => {
  await fs.rm(home, {recursive: true, force: true});
});

describe('beginCliUpdateNotice', () => {
  it('prints at most once per version per day', () => {
    const write = jest.fn();
    const service = {getStatus: jest.fn(() => status)};
    const options = {
      argv: ['node', 'smp', 'doctor'],
      env: {} as NodeJS.ProcessEnv,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      now: () => new Date('2026-07-26T09:00:00.000Z'),
      service,
      bootstrapOptions: {sessionDir: home},
      write,
    };

    beginCliUpdateNotice(options).flush();
    beginCliUpdateNotice(options).flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('1.2.2 → 1.3.0');
  });

  it.each([
    {argv: ['node', 'smp', '--help'], env: {}, stdoutIsTTY: true, stderrIsTTY: true},
    {argv: ['node', 'smp', 'update', 'check'], env: {}, stdoutIsTTY: true, stderrIsTTY: true},
    {argv: ['node', 'smp', 'doctor', '--format', 'json'], env: {}, stdoutIsTTY: true, stderrIsTTY: true},
    {argv: ['node', 'smp', 'doctor'], env: {CI: '1'}, stdoutIsTTY: true, stderrIsTTY: true},
    {argv: ['node', 'smp', 'doctor'], env: {}, stdoutIsTTY: false, stderrIsTTY: true},
    {argv: ['node', 'smp', 'doctor'], env: {}, stdoutIsTTY: true, stderrIsTTY: false},
  ])('stays silent for noninteractive or structured invocations', input => {
    const write = jest.fn();
    beginCliUpdateNotice({
      argv: input.argv,
      env: input.env as NodeJS.ProcessEnv,
      stdoutIsTTY: input.stdoutIsTTY,
      stderrIsTTY: input.stderrIsTTY,
      service: {getStatus: () => status},
      bootstrapOptions: {sessionDir: home},
      write,
    }).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps update-check failures silent', () => {
    const write = jest.fn();
    beginCliUpdateNotice({
      argv: ['node', 'smp', 'doctor'],
      env: {} as NodeJS.ProcessEnv,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      service: {
        getStatus: () => ({
          ...status,
          state: 'error',
          latest: undefined,
          action: undefined,
        }),
      },
      bootstrapOptions: {sessionDir: home},
      write,
    }).flush();
    expect(write).not.toHaveBeenCalled();
  });
});
