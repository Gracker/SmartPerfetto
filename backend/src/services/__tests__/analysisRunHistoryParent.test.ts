// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import {AnalysisHistoryStore, resetAnalysisHistoryStoreForTests, type AnalysisHistoryScope} from '../analysisHistoryStore';
import {persistAnalysisRunState, resetAnalysisRunStoreForTests} from '../analysisRunStore';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {ENTERPRISE_DB_PATH_ENV} from '../enterpriseDb';
import {NO_PRIVATE_CONTEXT} from '../security/analysisPrivateContext';

// The existing history-store suite builds its run parent with hand-written SQL,
// and the persistence suite mocks `append` outright. Both stayed green while no
// production caller on the CLI path created the parent at all. This suite uses
// the real run-lifecycle writer against a real database so that gap is covered.
const scope: AnalysisHistoryScope = {tenantId: 'local', workspaceId: 'default', userId: 'local-user',
  sessionId: 'agent-cli-1', traceId: 'trace-cli-1', runId: 'run-cli-1'};
const turn = () => toAnalysisHistoryTurn({id: scope.runId!, turnIndex: 0, traceId: scope.traceId, timestamp: 1,
  query: '分析启动性能', result: {message: 'complete body', completion: {status: 'completed'}}});

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[ENTERPRISE_DB_PATH_ENV];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-run-history-'));
  process.env[ENTERPRISE_DB_PATH_ENV] = path.join(dir, 'sessions.db');
  resetAnalysisRunStoreForTests();
  resetAnalysisHistoryStoreForTests();
});

afterEach(() => {
  resetAnalysisRunStoreForTests();
  resetAnalysisHistoryStoreForTests();
  if (previous === undefined) delete process.env[ENTERPRISE_DB_PATH_ENV];
  else process.env[ENTERPRISE_DB_PATH_ENV] = previous;
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('finalized history requires a registered run parent', () => {
  it('fails closed when the run lifecycle was never registered', () => {
    expect(() => new AnalysisHistoryStore().append(scope, turn()))
      .toThrow('analysis_history_parent_not_authorized');
  });

  it('accepts the turn once the same owner registered the run', () => {
    persistAnalysisRunState({tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: scope.userId,
      sessionId: scope.sessionId, runId: scope.runId!, traceId: scope.traceId, query: '分析启动性能', mode: 'fast',
      privateContext: NO_PRIVATE_CONTEXT}, 'running');
    expect(() => new AnalysisHistoryStore().append(scope, turn())).not.toThrow();
    expect(new AnalysisHistoryStore().list(scope)).toEqual([turn()]);
  });

  it('keeps a run registered under one owner unusable by another', () => {
    persistAnalysisRunState({tenantId: scope.tenantId, workspaceId: scope.workspaceId, userId: 'someone-else',
      sessionId: scope.sessionId, runId: scope.runId!, traceId: scope.traceId, mode: 'fast',
      privateContext: NO_PRIVATE_CONTEXT}, 'running');
    expect(() => new AnalysisHistoryStore().append(scope, turn()))
      .toThrow('analysis_history_parent_not_authorized');
  });
});
