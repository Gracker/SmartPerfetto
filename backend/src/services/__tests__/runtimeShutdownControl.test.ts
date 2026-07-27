// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {installRuntimeShutdownControl} from '../runtimeShutdownControl';

const temporaryRoots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

describe('installRuntimeShutdownControl', () => {
  it('does nothing when the portable launcher did not provide a control file', () => {
    const onShutdown = jest.fn();
    const stop = installRuntimeShutdownControl(onShutdown, {shutdownFile: ''});
    stop();
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('fires once when a regular shutdown file appears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-shutdown-'));
    temporaryRoots.push(root);
    const shutdownFile = path.join(root, 'backend.shutdown');
    const onShutdown = jest.fn();
    const stop = installRuntimeShutdownControl(onShutdown, {
      shutdownFile,
      pollIntervalMs: 5,
    });

    fs.writeFileSync(shutdownFile, 'shutdown\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledWith('launcher-control-file');
  });

  it('ignores directories and symbolic links until a regular file appears', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-shutdown-kind-'));
    temporaryRoots.push(root);
    const shutdownFile = path.join(root, 'backend.shutdown');
    const onShutdown = jest.fn();
    const stop = installRuntimeShutdownControl(onShutdown, {
      shutdownFile,
      pollIntervalMs: 5,
    });

    fs.mkdirSync(shutdownFile);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onShutdown).not.toHaveBeenCalled();
    fs.rmSync(shutdownFile, {recursive: true});
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'shutdown\n');
    fs.symlinkSync(target, shutdownFile);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onShutdown).not.toHaveBeenCalled();
    fs.unlinkSync(shutdownFile);
    fs.writeFileSync(shutdownFile, 'shutdown\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();

    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the disposer is called', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-shutdown-stop-'));
    temporaryRoots.push(root);
    const shutdownFile = path.join(root, 'backend.shutdown');
    const onShutdown = jest.fn();
    const stop = installRuntimeShutdownControl(onShutdown, {
      shutdownFile,
      pollIntervalMs: 5,
    });
    stop();
    fs.writeFileSync(shutdownFile, 'shutdown\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onShutdown).not.toHaveBeenCalled();
  });
});
