// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  EvalCaseV1,
  SelfEvolutionPersistenceCapability,
} from '../../../types/selfEvolution';
import {EvalCaseStore} from '../evalCaseStore';
import {
  EvaluationReplayUnavailableError,
  materializeEvaluationTraces,
} from '../evaluationTraceMaterializer';

const persistenceUnavailable: SelfEvolutionPersistenceCapability = {
  persistence: 'unavailable',
  reason: 'data_root_not_writable',
  configured: true,
  writable: false,
  outsidePackage: true,
  externalMount: true,
  dataRoot: '/tmp/evaluation-trace-materializer-tests',
  packageRoot: '/app',
  checkedAt: 1,
};
const scope = {tenantId: 'local', workspaceId: 'local'};

describe('evaluation trace materializer', () => {
  let directory: string;
  let store: EvalCaseStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-materializer-'));
    store = new EvalCaseStore({
      persistence: persistenceUnavailable,
      corpusRoot: path.join(directory, 'corpus'),
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  it('copies current and reference traces from verified descriptors into isolated files', () => {
    const current = Buffer.from('current trace bytes');
    const reference = Buffer.from('reference trace bytes');
    const importTrace = (name: string, content: Buffer) => {
      const sourcePath = path.join(directory, name);
      fs.writeFileSync(sourcePath, content);
      return store.importTrace({
        scope,
        sourcePath,
        expectedContentHash:
          createHash('sha256').update(content).digest('hex'),
      });
    };
    const currentRecord = importTrace('current.pftrace', current);
    const referenceRecord = importTrace('reference.pftrace', reference);
    const evalCase: EvalCaseV1 = {
      schemaVersion: 1,
      caseId: 'case-dual',
      evalSetId: 'set-a',
      origin: 'manual_golden',
      scope,
      traces: [
        {
          role: 'current',
          corpusId: currentRecord.corpusId,
          contentHash: currentRecord.contentHash,
        },
        {
          role: 'reference',
          corpusId: referenceRecord.corpusId,
          contentHash: referenceRecord.contentHash,
        },
      ],
      query: 'Compare both traces.',
      analysisMode: 'full',
      split: 'validation',
      createdAt: '2026-07-29T00:00:00.000Z',
    };

    const materialized = materializeEvaluationTraces({
      evalCaseStore: store,
      evalCase,
    });
    const currentCopy = materialized.traces.find(
      trace => trace.role === 'current',
    )!;
    const referenceCopy = materialized.traces.find(
      trace => trace.role === 'reference',
    )!;
    expect(currentCopy.traceId).not.toBe(referenceCopy.traceId);
    expect(currentCopy.leaseId).not.toBe(referenceCopy.leaseId);
    expect(fs.readFileSync(currentCopy.filePath)).toEqual(current);
    expect(fs.readFileSync(referenceCopy.filePath)).toEqual(reference);
    expect(fs.statSync(materialized.directory).mode & 0o777).toBe(0o700);
    materialized.cleanup();
    expect(fs.existsSync(materialized.directory)).toBe(false);
  });

  it('reports a missing corpus object as unavailable', () => {
    const evalCase: EvalCaseV1 = {
      schemaVersion: 1,
      caseId: 'case-missing',
      evalSetId: 'set-a',
      origin: 'manual_golden',
      scope,
      traces: [{
        role: 'current',
        corpusId: 'a'.repeat(64),
        contentHash: 'a'.repeat(64),
      }],
      query: 'Analyze.',
      analysisMode: 'full',
      split: 'validation',
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    expect(() => materializeEvaluationTraces({
      evalCaseStore: store,
      evalCase,
    })).toThrow(EvaluationReplayUnavailableError);
  });
});
