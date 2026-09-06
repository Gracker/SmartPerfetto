// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, jest} from '@jest/globals';

import type {RunManifestAttributionSink} from '../../../types/selfEvolution';
import {SkillExecutor} from '../skillExecutor';
import type {SkillDefinition} from '../types';

function atomicSkill(name: string): SkillDefinition {
  return {
    name,
    version: '1.0.0',
    type: 'atomic',
    meta: {
      display_name: name,
      description: `Run manifest test Skill ${name}`,
    },
    sql: 'select value from test_table',
  };
}

function attributionSink(): RunManifestAttributionSink & {
  startSkillInvocation: jest.Mock;
  finishSkillInvocation: jest.Mock;
  recordUnknownSkillInvocation: jest.Mock;
  recordSqlStatement: jest.Mock;
} {
  let invocation = 0;
  return {
    identity: {
      runId: 'run-attribution',
      sessionId: 'session-attribution',
      scope: {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
    },
    recordScene: jest.fn(),
    recordRuntime: jest.fn(),
    recordMode: jest.fn(),
    recordSkillRegistry: jest.fn(),
    startSkillInvocation: jest.fn(() => `invocation-${++invocation}`),
    finishSkillInvocation: jest.fn(),
    recordUnknownSkillInvocation: jest.fn(),
    recordSqlStatement: jest.fn(),
    recordPromptTemplate: jest.fn(),
    recordInjection: jest.fn(),
    recordToolAllowlist: jest.fn(),
    recordTurn: jest.fn(),
    recordCapabilityManifest: jest.fn(),
  };
}

describe('SkillExecutor run manifest attribution', () => {
  let query: any;
  let sink: ReturnType<typeof attributionSink>;
  let executor: SkillExecutor;

  beforeEach(() => {
    query = jest.fn<any>();
    sink = attributionSink();
    executor = new SkillExecutor({query}, undefined, undefined, sink);
  });

  it('records one successful non-empty invocation at the actual execute boundary', async () => {
    query.mockResolvedValue({columns: ['value'], rows: [[1]]});
    executor.registerSkill(atomicSkill('non_empty'));

    const result = await executor.execute('non_empty', 'trace-a');

    expect(result.success).toBe(true);
    expect(sink.startSkillInvocation).toHaveBeenCalledTimes(1);
    expect(sink.startSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'non_empty',
      version: '1.0.0',
      contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(sink.finishSkillInvocation).toHaveBeenCalledWith(
      'invocation-1',
      {success: true, empty: false},
    );
    expect(sink.recordSqlStatement).not.toHaveBeenCalled();
  });

  it('derives empty from the Skill result payload instead of envelopes', async () => {
    query.mockResolvedValue({columns: ['value'], rows: []});
    executor.registerSkill(atomicSkill('empty'));

    const result = await executor.execute('empty', 'trace-a');

    expect(result.success).toBe(true);
    expect(sink.finishSkillInvocation).toHaveBeenCalledWith(
      'invocation-1',
      {success: true, empty: true},
    );
  });

  it('records returned SQL errors and failed Skill outcomes', async () => {
    query.mockResolvedValue({error: 'no such table'});
    executor.registerSkill(atomicSkill('failed'));

    const result = await executor.execute('failed', 'trace-a');

    expect(result.success).toBe(false);
    expect(sink.recordSqlStatement).not.toHaveBeenCalled();
    expect(sink.finishSkillInvocation).toHaveBeenCalledWith(
      'invocation-1',
      {success: false, empty: false},
    );
  });

  it('diagnoses unknown Skill ids without fabricating an invocation', async () => {
    const result = await executor.execute('missing', 'trace-a');

    expect(result.success).toBe(false);
    expect(sink.recordUnknownSkillInvocation).toHaveBeenCalledWith('missing');
    expect(sink.startSkillInvocation).not.toHaveBeenCalled();
  });
});
