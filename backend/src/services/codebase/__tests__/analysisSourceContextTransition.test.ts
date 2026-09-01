// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import type {IOrchestrator} from '../../../agent/core/orchestratorTypes';
import {resetRuntimeForSourceActivation} from '../analysisSourceContextTransition';

function orchestratorWithCleanup() {
  const emitter = new EventEmitter();
  const cleanupSession = jest.fn();
  return {
    cleanupSession,
    orchestrator: Object.assign(emitter, {
      cleanupSession,
      analyze: jest.fn(),
      reset: jest.fn(),
    }) as unknown as IOrchestrator,
  };
}

describe('analysis source context transition', () => {
  it('does nothing while activation remains stable', async () => {
    const fixture = orchestratorWithCleanup();
    await expect(resetRuntimeForSourceActivation({
      orchestrator: fixture.orchestrator,
      sessionId: 'session-a',
      query: 'current',
      previousActivation: 'dormant',
      nextActivation: 'dormant',
    })).resolves.toBeUndefined();
    expect(fixture.cleanupSession).not.toHaveBeenCalled();
  });

  it('cleans provider state and replays only safe non-source turns', async () => {
    const fixture = orchestratorWithCleanup();
    const query = await resetRuntimeForSourceActivation({
      orchestrator: fixture.orchestrator,
      sessionId: 'session-a',
      query: 'current trace question',
      previousActivation: 'bounded_explicit',
      nextActivation: 'dormant',
      queryHistory: [
        {turn: 1, query: 'safe trace question'},
        {turn: 2, query: 'PRIVATE_SOURCE_QUERY', sourceDerived: true},
      ],
      conclusionHistory: [
        {turn: 1, conclusion: 'safe trace conclusion'},
        {turn: 2, conclusion: 'PRIVATE_SOURCE_CONCLUSION', sourceDerived: true},
      ],
    });

    expect(fixture.cleanupSession).toHaveBeenCalledWith('session-a');
    expect(query).toContain('safe trace question');
    expect(query).toContain('safe trace conclusion');
    expect(query).toContain('current trace question');
    expect(query).not.toContain('PRIVATE_SOURCE_QUERY');
    expect(query).not.toContain('PRIVATE_SOURCE_CONCLUSION');
  });
});
