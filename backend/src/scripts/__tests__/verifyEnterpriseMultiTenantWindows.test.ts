// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  runEnterpriseWindowRegression,
  type EnterpriseWindowRegressionReport,
} from '../verifyEnterpriseMultiTenantWindows';

describe('verifyEnterpriseMultiTenantWindows script', () => {
  let tempRoot: string;
  let previousUploadDir: string | undefined;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-window-regression-test-'));
    previousUploadDir = process.env.UPLOAD_DIR;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    if (previousUploadDir === undefined) {
      delete process.env.UPLOAD_DIR;
    } else {
      process.env.UPLOAD_DIR = previousUploadDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('covers current D1-D10 isolation invariants without invoking a real provider', async () => {
    const tracePath = path.join(tempRoot, 'fixture.pftrace');
    const uploadRoot = path.join(tempRoot, 'uploads');
    const outputPath = path.join(tempRoot, 'report.json');
    await fs.writeFile(tracePath, 'fake perfetto trace bytes');

    const report = await runEnterpriseWindowRegression({
      tracePath,
      uploadRoot,
      outputPath,
      longSqlMs: 20,
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual({
      D1: true,
      D2: true,
      D3: true,
      D4: true,
      D5: true,
      D6: true,
      D7: true,
      D8: true,
      D9: true,
      D10: true,
    });
    expect(Object.values(report.scenarios.D1.checks)).toEqual(expect.arrayContaining([true]));
    expect(Object.values(report.scenarios.D1.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D2.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D3.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D4.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D5.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D6.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D7.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D8.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D9.checks).every(Boolean)).toBe(true);
    expect(Object.values(report.scenarios.D10.checks).every(Boolean)).toBe(true);
    expect(report.coverageLimitations.join('\n')).toContain('TraceProcessorLease');
    expect(report.scenarios.D6.details).toEqual(expect.objectContaining({
      reportUrl: expect.stringMatching(/^\/api\/reports\//),
      crossTenantReplayCount: 0,
    }));
    expect(report.scenarios.D3.details).toEqual(expect.objectContaining({
      queryDispatchOrder: ['running-p2', 'p0', 'p1', 'queued-p2'],
      queuedStats: expect.objectContaining({
        running: true,
        queuedP0: 1,
        queuedP1: 1,
        queuedP2: 1,
      }),
    }));
    expect(report.scenarios.D8.details).toEqual(expect.objectContaining({
      providerSnapshotChanged: true,
    }));
    expect(report.scenarios.D9.details).toEqual(expect.objectContaining({
      recoveredPreviousStatuses: expect.arrayContaining([
        expect.arrayContaining([expect.stringMatching(/^run-/), 'pending']),
        expect.arrayContaining([expect.stringMatching(/^run-/), 'running']),
      ]),
    }));
    expect(report.scenarios.D10.details).toEqual(expect.objectContaining({
      candidateLeaseCount: 0,
      activeHolderCountAfterShare: 2,
    }));
    expect(process.env.UPLOAD_DIR).toBe(previousUploadDir);

    const written = JSON.parse(await fs.readFile(outputPath, 'utf8')) as EnterpriseWindowRegressionReport;
    expect(written.passed).toBe(true);
    expect(written.checks).toEqual(report.checks);

    const traceFiles = (await fs.readdir(path.join(uploadRoot, 'traces')))
      .filter(file => file.endsWith('.trace'));
    expect(traceFiles).toHaveLength(16);
  });
});
