// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  RunManifestLifecycle,
  withRunManifestLifecycle,
} from '../runManifestLifecycle';
import type {RunManifestStore} from '../runManifestStore';
import {
  TraceProcessorService,
  type QueryResult,
  type TraceProcessor,
} from '../../traceProcessorService';

const temporaryDirectories: string[] = [];

function lifecycle(runId: string): RunManifestLifecycle {
  const store = {
    append: jest.fn(),
    pin: jest.fn(),
    unpin: jest.fn(),
  } as unknown as RunManifestStore;
  return new RunManifestLifecycle({
    runId,
    sessionId: `session-${runId}`,
    scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    runtime: 'claude-agent-sdk',
    providerId: null,
    outputLanguage: 'en',
    analysisMode: 'auto',
    skillRegistry: {
      registryFingerprint: 'registry-a',
      skills: [],
    },
    store,
  });
}

function serviceWithResult(result: QueryResult | Error): TraceProcessorService {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-manifest-sql-'));
  temporaryDirectories.push(uploadDir);
  const service = new TraceProcessorService(uploadDir);
  const processor = {
    id: 'processor-a',
    traceId: 'trace-a',
    status: 'ready',
    activeQueries: 0,
    query: result instanceof Error
      ? jest.fn(async () => {
          throw result;
        })
      : jest.fn(async () => result),
    queryRaw: jest.fn(async () => Buffer.alloc(0)),
    destroy: jest.fn(),
  } as TraceProcessor;
  (
    service as unknown as {
      processorForQuery: () => Promise<TraceProcessor>;
    }
  ).processorForQuery = jest.fn(async () => processor);
  return service;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});

describe('TraceProcessorService RunManifest attribution', () => {
  it('counts every submitted SQL statement once at the service boundary', async () => {
    const run = lifecycle('run-sql-ok');
    const service = serviceWithResult({
      columns: ['value'],
      rows: [[1]],
      durationMs: 1,
    });

    await withRunManifestLifecycle(run, () => service.query(
      'trace-a',
      "INCLUDE PERFETTO MODULE android.startup.startups;\nSELECT ';' AS value;",
    ));
    const manifest = run.sealOnceAndPersist();

    expect(manifest.sqlStatementCount).toBe(2);
    expect(manifest.sqlErrorCount).toBe(0);
    run.dispose();
  });

  it.each([
    ['error result', {
      columns: [],
      rows: [],
      durationMs: 1,
      error: 'query failed',
    }],
    ['rejection', new Error('query rejected')],
  ])('attributes every statement in a failed query batch: %s', async (_label, result) => {
    const run = lifecycle(`run-sql-failed-${_label}`);
    const service = serviceWithResult(result);
    const query = withRunManifestLifecycle(run, () => service.query(
      'trace-a',
      'INCLUDE PERFETTO MODULE android.startup.startups;\nSELECT * FROM missing_table;',
    ));

    if (result instanceof Error) {
      await expect(query).rejects.toThrow('query rejected');
    } else {
      await expect(query).resolves.toEqual(result);
    }
    const manifest = run.sealOnceAndPersist();

    expect(manifest.sqlStatementCount).toBe(2);
    expect(manifest.sqlErrorCount).toBe(2);
    run.dispose();
  });

  it('attributes every statement when processor acquisition rejects', async () => {
    const run = lifecycle('run-sql-processor-acquisition-failed');
    const service = serviceWithResult({
      columns: [],
      rows: [],
      durationMs: 1,
    });
    (
      service as unknown as {
        processorForQuery: () => Promise<TraceProcessor>;
      }
    ).processorForQuery = jest.fn(async () => {
      throw new Error('processor acquisition failed');
    });

    const query = withRunManifestLifecycle(run, () => service.query(
      'trace-a',
      'INCLUDE PERFETTO MODULE android.startup.startups;\nSELECT 1;',
    ));
    await expect(query).rejects.toThrow('processor acquisition failed');
    const manifest = run.sealOnceAndPersist();

    expect(manifest.sqlStatementCount).toBe(2);
    expect(manifest.sqlErrorCount).toBe(2);
    run.dispose();
  });
});
