// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { createSseBridge } from '../claudeSseBridge';
import type { StreamingUpdate } from '../../agent/types';

describe('createSseBridge', () => {
  it('does not emit a terminal error for SDK max-turn results', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'result',
      subtype: 'error_max_turns',
      errors: [],
      num_turns: 84,
    });

    expect(updates.some(update => update.type === 'error')).toBe(false);
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'progress',
      content: expect.objectContaining({
        phase: 'concluding',
        partial: true,
        subtype: 'error_max_turns',
        terminationReason: 'max_turns',
        turns: 84,
      }),
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'degraded',
      content: expect.objectContaining({
        partial: true,
        terminationReason: 'max_turns',
        error: 'error_max_turns',
      }),
    }));
  });

  it('still emits errors for non-recoverable SDK result failures', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['boom'],
    });

    expect(updates).toContainEqual(expect.objectContaining({
      type: 'error',
      content: expect.objectContaining({
        message: 'Claude analysis error (error_during_execution): boom',
        subtype: 'error_during_execution',
      }),
    }));
  });

  it('localizes max-turn progress messages in English', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update), 'en');

    bridge.handleMessage({
      type: 'result',
      subtype: 'error_max_turns',
      errors: [],
      num_turns: 10,
    });

    expect(updates).toContainEqual(expect.objectContaining({
      type: 'progress',
      content: expect.objectContaining({
        message: expect.stringContaining('turn limit'),
      }),
    }));
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'degraded',
      content: expect.objectContaining({
        message: expect.stringContaining('results may be incomplete'),
      }),
    }));
  });

  it('maps parallel tool results back to their SDK tool_use_id', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'call_a', name: 'mcp__smartperfetto__fetch_artifact', input: { artifactId: 'art-1' } },
          { type: 'tool_use', id: 'call_b', name: 'mcp__smartperfetto__fetch_artifact', input: { artifactId: 'art-2' } },
        ],
      },
    });

    bridge.handleMessage({
      type: 'user',
      tool_use_result: 'result a',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: 'result a' },
        ],
      },
    });
    bridge.handleMessage({
      type: 'user',
      tool_use_result: 'result b',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call_b', content: 'result b' },
        ],
      },
    });

    const responses = updates.filter((update) => update.type === 'agent_response');
    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual(expect.objectContaining({
      content: expect.objectContaining({ taskId: 'call_a', result: 'result a' }),
    }));
    expect(responses[1]).toEqual(expect.objectContaining({
      content: expect.objectContaining({ taskId: 'call_b', result: 'result b' }),
    }));
  });
});
