// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {
  projectSessionMetricsForPersistence,
  type SessionMetrics,
} from '../agentMetrics';

function metricsWithPrivateError(): SessionMetrics {
  return {
    sessionId: 'session-private',
    startTime: 1,
    endTime: 2,
    totalDurationMs: 1,
    turns: 1,
    toolExecutions: [{
      toolName: 'search_knowledge',
      startTime: 1,
      durationMs: 1,
      inputChars: 10,
      outputChars: 0,
      success: false,
      error: 'PRIVATE_METRICS_ERROR_CANARY',
    }],
    toolSummary: {
      totalCalls: 1,
      totalDurationMs: 1,
      successCount: 0,
      failureCount: 1,
      byTool: {
        search_knowledge: {calls: 1, totalMs: 1, avgMs: 1, failures: 1},
      },
    },
  };
}

describe('agent metrics privacy projection', () => {
  it('keeps timing/counts but drops raw tool errors for private analyses', () => {
    const original = metricsWithPrivateError();
    const projected = projectSessionMetricsForPersistence(original, true);

    expect(projected.toolExecutions[0]).toEqual(expect.objectContaining({
      toolName: 'search_knowledge',
      success: false,
      durationMs: 1,
    }));
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_METRICS_ERROR_CANARY');
    expect(original.toolExecutions[0].error).toBe('PRIVATE_METRICS_ERROR_CANARY');
  });
});
