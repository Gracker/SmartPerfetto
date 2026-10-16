// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runBatchSkillCommand } from '../batch';
import { resetCliEnvironmentForTesting } from '../../bootstrap';
import { runBatchSkill } from '../../../services/batchTrace/batchTraceRunner';
import { writeBatchTraceArtifacts } from '../../../services/batchTrace/batchTraceReportService';
import { BATCH_TRACE_RUN_SCHEMA_VERSION, type BatchTraceRunV1 } from '../../../services/batchTrace/batchTraceTypes';

jest.mock('../../../services/batchTrace/batchTraceRunner', () => ({
  runBatchSkill: jest.fn(),
}));

jest.mock('../../../services/batchTrace/batchTraceReportService', () => ({
  writeBatchTraceArtifacts: jest.fn((input: { run: BatchTraceRunV1 }) => ({
    ...input.run,
    report: {
      jsonPath: '/tmp/result.json',
      htmlPath: '/tmp/report.html',
    },
  })),
}));

jest.mock('../../../services/skillEngine/skillLoader', () => ({
  ensureSkillRegistryInitialized: jest.fn(async () => undefined),
  skillRegistry: {},
}));

jest.mock('../../services/cliAnalyzeService', () => ({
  CliAnalyzeService: jest.fn().mockImplementation(() => ({
    prepareTraceProcessor: jest.fn(async () => undefined),
    shutdown: jest.fn(async () => undefined),
  })),
}));

const runBatchSkillMock = jest.mocked(runBatchSkill);
const writeArtifactsMock = jest.mocked(writeBatchTraceArtifacts);

let tempDir: string;
let tracePath: string;

function completedRun(): BatchTraceRunV1 {
  return {
    schemaVersion: BATCH_TRACE_RUN_SCHEMA_VERSION,
    id: 'batch-1',
    createdAt: 1,
    completedAt: 2,
    status: 'completed',
    input: {
      skillId: 'startup_analysis',
      params: {},
      traceInputs: [{ ordinal: 0, source: 'local_path', tracePath }],
      maxConcurrency: 2,
      traceLimit: 100,
    },
    perTrace: [{
      ordinal: 0,
      input: { ordinal: 0, source: 'local_path', tracePath, label: path.basename(tracePath) },
      traceId: 'trace-a',
      status: 'completed',
      metrics: [],
      evidenceEnvelopeIds: [],
      diagnostics: [],
      executionTimeMs: 1,
    }],
  };
}

beforeEach(() => {
  resetCliEnvironmentForTesting();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-batch-test-'));
  tracePath = path.join(tempDir, 'trace.pftrace');
  fs.writeFileSync(tracePath, 'trace');
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  runBatchSkillMock.mockReset();
  writeArtifactsMock.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runBatchSkillCommand', () => {
  it('returns exit code 2 when no trace input is provided', async () => {
    const code = await runBatchSkillCommand({
      skillId: 'startup_analysis',
      traces: [],
      sessionDir: tempDir,
      format: 'json',
    });

    expect(code).toBe(2);
    expect(runBatchSkillMock).not.toHaveBeenCalled();
  });

  it('runs a local trace batch and writes JSON/HTML artifacts', async () => {
    runBatchSkillMock.mockResolvedValue(completedRun());

    const code = await runBatchSkillCommand({
      skillId: 'startup_analysis',
      traces: [tracePath],
      sessionDir: tempDir,
      format: 'json',
    });

    expect(code).toBe(0);
    expect(runBatchSkillMock).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'cli',
        skillId: 'startup_analysis',
        traceInputs: [expect.objectContaining({ tracePath })],
      }),
      expect.objectContaining({ registry: {} }),
    );
    expect(writeArtifactsMock).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ id: 'batch-1' }),
      directory: expect.stringMatching(/batch-runs[/\\]batch-1$/),
    }));
  });
});
