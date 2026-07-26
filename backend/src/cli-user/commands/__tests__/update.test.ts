// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterAll, beforeAll, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {ApplicationUpdateStatus} from '../../../services/applicationUpdate/types';
import {runUpdateCheckCommand} from '../update';

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-update-command-'));
});

afterAll(async () => {
  jest.restoreAllMocks();
  await fs.rm(home, {recursive: true, force: true});
});

describe('runUpdateCheckCommand', () => {
  it('emits machine-readable status without changing success semantics', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const status: ApplicationUpdateStatus = {
      schemaVersion: 1,
      state: 'up_to_date',
      current: {
        distribution: 'npm',
        channel: 'stable',
        version: '1.2.2',
        target: {os: 'linux', arch: 'x64'},
        signingMode: 'npm-registry',
      },
    };
    const exitCode = await runUpdateCheckCommand({
      sessionDir: home,
      format: 'json',
      service: {checkNow: async () => status},
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      state: 'up_to_date',
      current: {distribution: 'npm'},
    });
  });

  it.each([
    {state: 'update_available', exitCode: 0},
    {state: 'error', exitCode: 1},
  ] as const)('returns $exitCode for $state', async ({state, exitCode}) => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runUpdateCheckCommand({
      sessionDir: home,
      format: 'text',
      service: {
        checkNow: async () => ({
          schemaVersion: 1,
          state,
          current: {
            distribution: 'npm',
            channel: 'stable',
            version: '1.2.2',
            target: {os: 'linux', arch: 'x64'},
            signingMode: 'npm-registry',
          },
          ...(state === 'update_available'
            ? {
                latest: {
                  version: '1.3.0',
                  releaseUrl: 'https://www.npmjs.com/package/@gracker/smartperfetto/v/1.3.0',
                },
                action: {
                  kind: 'npm' as const,
                  command: 'npm install -g @gracker/smartperfetto@latest',
                  url: 'https://www.npmjs.com/package/@gracker/smartperfetto/v/1.3.0',
                },
              }
            : {
                lastError: {
                  code: 'network_error' as const,
                  message: 'offline',
                  at: '2026-07-26T08:00:00.000Z',
                },
              }),
        }),
      },
    });
    expect(result).toBe(exitCode);
  });
});
