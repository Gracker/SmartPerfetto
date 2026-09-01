// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { createSseBridge, isSdkToolResultFailure } from '../claudeSseBridge';
import {__testing as claudeRuntimeTesting} from '../../agentRuntime/engines/claude/claudeRuntime';
import type { StreamingUpdate } from '../../agent/types';

describe('createSseBridge', () => {
  it('detects plain and string-escaped MCP failures for metrics', () => {
    expect(isSdkToolResultFailure({success: false})).toBe(true);
    expect(isSdkToolResultFailure('{"success":false}')).toBe(true);
    expect(isSdkToolResultFailure('"{\\"success\\":false}"')).toBe(true);
    expect(isSdkToolResultFailure({success: true})).toBe(false);
  });

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

  it('handles SDK status and rate-limit control messages without unhandled log noise', () => {
    const updates: StreamingUpdate[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const bridge = createSseBridge((update) => updates.push(update));

    try {
      bridge.handleMessage({
        type: 'system',
        subtype: 'status',
        status: 'requesting',
        uuid: 'request-1',
        session_id: 'sdk-session-1',
      });
      bridge.handleMessage({
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 12,
        estimated_tokens_delta: 2,
        uuid: 'thinking-1',
        session_id: 'sdk-session-1',
      });
      bridge.handleMessage({
        type: 'rate_limit_event',
        retry_after_ms: 1000,
      });

      expect(logSpy).not.toHaveBeenCalled();
      expect(updates).toEqual([
        expect.objectContaining({
          type: 'progress',
          content: expect.objectContaining({
            phase: 'analyzing',
            message: expect.stringContaining('限流'),
          }),
        }),
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs only the shape of unhandled SDK messages', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const bridge = createSseBridge(() => {});

    try {
      bridge.handleMessage({
        type: 'future_sdk_message',
        subtype: 'future_subtype',
        payload: 'PRIVATE_UNHANDLED_MESSAGE_CANARY',
      });

      const serializedLogs = JSON.stringify(logSpy.mock.calls);
      expect(serializedLogs).not.toContain('PRIVATE_UNHANDLED_MESSAGE_CANARY');
      expect(serializedLogs).toContain('future_sdk_message');
      expect(serializedLogs).toContain('future_subtype');
      expect(serializedLogs).toContain('payload');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('can flush pending streamed answer text when a stream is cancelled before assistant/result', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));

    bridge.handleMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '完整修正报告' },
      },
    });

    expect(bridge.getAccumulatedAnswer()).toBe('');
    bridge.flushPendingAnswer();

    expect(bridge.getAccumulatedAnswer()).toBe('完整修正报告');
    expect(updates).toContainEqual(expect.objectContaining({
      type: 'answer_token',
      content: { token: '完整修正报告' },
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

  it('bounds externally projected tool results without changing the source payload', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));
    const sourcePayload = {success: true, rows: ['x'.repeat(10_000)]};

    bridge.handleMessage({
      type: 'assistant',
      message: {content: [{
        type: 'tool_use',
        id: 'large-result',
        name: 'mcp__smartperfetto__fetch_artifact',
        input: {artifactId: 'art-large'},
      }]},
    });
    bridge.handleMessage({
      type: 'user',
      tool_use_result: sourcePayload,
      message: {content: [{
        type: 'tool_result',
        tool_use_id: 'large-result',
        content: sourcePayload,
      }]},
    });

    const response = updates.find(update => update.type === 'agent_response');
    const projected = String(response?.content?.result ?? '');
    expect(projected.length).toBeLessThanOrEqual(2_000);
    expect(projected).toContain('truncated');
    expect(sourcePayload.rows[0]).toHaveLength(10_000);
  });

  it('bounds fallback answer accumulation and disposes pending timers', () => {
    jest.useFakeTimers();
    try {
      const updates: StreamingUpdate[] = [];
      const bridge = createSseBridge((update) => updates.push(update));
      bridge.handleMessage({
        type: 'assistant',
        message: {content: [{type: 'text', text: 'a'.repeat(300_000)}]},
      });

      expect(bridge.getAccumulatedAnswer().length).toBeLessThanOrEqual(256 * 1024);
      expect(bridge.getAccumulatedAnswer()).toContain('truncated');
      expect(updates
        .filter(update => update.type === 'answer_token')
        .reduce((sum, update) => sum + String(update.content?.token ?? '').length, 0))
        .toBeLessThanOrEqual(256 * 1024);

      const pendingUpdates: StreamingUpdate[] = [];
      const pendingBridge = createSseBridge((update) => pendingUpdates.push(update));
      pendingBridge.handleMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: {type: 'text_delta', text: 'must not flush after dispose'},
        },
      });
      pendingBridge.dispose();
      jest.advanceTimersByTime(250);

      expect(pendingUpdates).toEqual([]);
      expect(pendingBridge.getAccumulatedAnswer()).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });

  it('projects private wiki tool results before emitting agent_response', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));
    bridge.handleMessage({
      type: 'assistant',
      message: {content: [{
        type: 'tool_use',
        id: 'wiki-call',
        name: 'mcp__smartperfetto__lookup_blog_knowledge',
        input: {source: 'android_internals_wiki'},
      }]},
    });
    const privateResult = JSON.stringify({
      success: true,
      result: {
        query: 'Handler',
        probed: ['android_internals_wiki'],
        retrievedAt: 1,
        legacyPath: false,
        hits: [{
          chunkId: 'wiki-1',
          score: 1,
          metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
          snippet: 'CLAUDE_PRIVATE_WIKI_CANARY',
        }],
      },
    });

    bridge.handleMessage({
      type: 'user',
      tool_use_result: privateResult,
      message: {content: [{
        type: 'tool_result',
        tool_use_id: 'wiki-call',
        content: privateResult,
      }]},
    });

    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('CLAUDE_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('projects replayed private wiki results even without a local tool-use mapping', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = createSseBridge((update) => updates.push(update));
    const privateResult = JSON.stringify({result: {
      query: 'Handler',
      probed: ['android_internals_wiki'],
      retrievedAt: 1,
      legacyPath: false,
      hits: [{
        chunkId: 'wiki-replay',
        score: 1,
        metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
        snippet: 'CLAUDE_REPLAY_PRIVATE_WIKI_CANARY',
      }],
    }});

    bridge.handleMessage({
      type: 'user',
      tool_use_result: privateResult,
      message: {content: [{
        type: 'tool_result',
        tool_use_id: 'replayed-wiki-call',
        content: privateResult,
      }]},
    });

    const serialized = JSON.stringify(updates);
    expect(serialized).not.toContain('CLAUDE_REPLAY_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('projects private wiki results before recording Claude plan evidence', () => {
    const result = claudeRuntimeTesting.projectClaudeToolResultForPlan(
      'lookup_blog_knowledge',
      JSON.stringify({result: {
        query: 'Handler',
        probed: ['android_internals_wiki'],
        retrievedAt: 1,
        legacyPath: false,
        hits: [{
          chunkId: 'wiki-1',
          score: 1,
          metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
          snippet: 'CLAUDE_PLAN_PRIVATE_WIKI_CANARY',
        }],
      }}),
    );

    expect(result).not.toContain('CLAUDE_PLAN_PRIVATE_WIKI_CANARY');
    expect(result).toContain('snippetHash');
  });

  it('bounds Claude plan evidence text without mutating the source result', () => {
    const sourceResult = {success: true, rows: ['p'.repeat(10_000)]};
    const result = claudeRuntimeTesting.projectClaudeToolResultForPlan(
      'execute_sql',
      sourceResult,
    );

    expect(result.length).toBeLessThanOrEqual(2_000);
    expect(result).toContain('truncated');
    expect(sourceResult.rows[0]).toHaveLength(10_000);
  });
});
