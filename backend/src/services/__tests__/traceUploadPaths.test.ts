// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getTraceFilePath, getTraceMetadataPath } from '../traceMetadataStore';
import { TraceProcessorService } from '../traceProcessorService';
import { getTracesDir, getUploadRoot } from '../traceUploadPaths';

const TRACE_UPLOAD_DIR_ENV = 'SMARTPERFETTO_TRACE_UPLOAD_DIR';

describe('trace upload paths', () => {
  it('defaults to ./uploads and its traces directory', () => {
    expect(getUploadRoot({})).toBe('./uploads');
    expect(getTracesDir({})).toBe(path.join('./uploads', 'traces'));
  });

  it('derives the trace directory from UPLOAD_DIR', () => {
    const env = { UPLOAD_DIR: ' /data/uploads ' };
    expect(getUploadRoot(env)).toBe('/data/uploads');
    expect(getTracesDir(env)).toBe(path.join('/data/uploads', 'traces'));
  });

  it('lets the explicit trace directory override win', () => {
    const env = { UPLOAD_DIR: '/data/uploads', [TRACE_UPLOAD_DIR_ENV]: '/cli/traces' };
    expect(getTracesDir(env)).toBe('/cli/traces');
  });

  it('treats blank values as unset', () => {
    expect(getTracesDir({ UPLOAD_DIR: '  ', [TRACE_UPLOAD_DIR_ENV]: ' ' }))
      .toBe(path.join('./uploads', 'traces'));
  });
});

// The portable launcher sets only UPLOAD_DIR and starts the backend with its
// cwd inside the (possibly read-only) package.
describe('TraceProcessorService default directory under a portable layout', () => {
  const savedEnv = {
    uploadDir: process.env.UPLOAD_DIR,
    traceUploadDir: process.env[TRACE_UPLOAD_DIR_ENV],
  };
  const savedCwd = process.cwd();
  let root: string;
  let packageBackend: string;
  let uploadRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-trace-upload-paths-'));
    packageBackend = path.join(root, 'package', 'backend');
    uploadRoot = path.join(root, 'user-data', 'uploads');
    fs.mkdirSync(packageBackend, { recursive: true });
    process.env.UPLOAD_DIR = uploadRoot;
    delete process.env[TRACE_UPLOAD_DIR_ENV];
    process.chdir(packageBackend);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.chmodSync(packageBackend, 0o755);
    for (const [key, value] of [
      ['UPLOAD_DIR', savedEnv.uploadDir],
      [TRACE_UPLOAD_DIR_ENV, savedEnv.traceUploadDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses the route upload directory instead of the package cwd', () => {
    const service = new TraceProcessorService();

    expect(service.getTraceFilePath('t1')).toBe(getTraceFilePath('t1'));
    expect(service.getTraceFilePath('t1')).toBe(path.join(uploadRoot, 'traces', 't1.trace'));
    expect(fs.existsSync(path.join(uploadRoot, 'traces'))).toBe(true);
    expect(fs.existsSync(path.join(packageBackend, 'uploads'))).toBe(false);
  });

  // A read-only mode does not stop root, or any Windows user, from writing.
  const canMakeReadOnly = process.platform !== 'win32' && process.getuid?.() !== 0;
  (canMakeReadOnly ? it : it.skip)('constructs when the package directory is not writable', () => {
    fs.chmodSync(packageBackend, 0o555);
    expect(() => new TraceProcessorService()).not.toThrow();
  });

  it('reloads a trace stored by the upload routes after a restart', async () => {
    fs.mkdirSync(path.join(uploadRoot, 'traces'), { recursive: true });
    fs.writeFileSync(getTraceFilePath('t1')!, 'trace-bytes');
    fs.writeFileSync(
      getTraceMetadataPath('t1')!,
      JSON.stringify({ filename: 'app.pftrace', size: 11 }),
    );
    const service = new TraceProcessorService();
    // Only where the file is found is under test, not processor startup.
    jest.spyOn(service as any, 'createProcessor').mockResolvedValue({ traceId: 't1' } as never);
    jest.spyOn(service as any, 'publishProcessor').mockImplementation(() => undefined);

    const trace = await service.getOrLoadTrace('t1');

    expect(trace?.filename).toBe('app.pftrace');
    expect(trace?.filePath).toBe(path.join(uploadRoot, 'traces', 't1.trace'));
  });
});
