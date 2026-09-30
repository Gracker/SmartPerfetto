// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it, jest } from '@jest/globals';
import { createSseBridge, extractSdkToolResultBlocks, isSdkToolResultFailure } from '../claudeSseBridge';
import {createRuntimeToolResult, readRuntimeToolResultFacts} from '../../agentRuntime/runtimeToolResult';
import {__testing as claudeRuntimeTesting} from '../../agentRuntime/engines/claude/claudeRuntime';
import type { StreamingUpdate } from '../../agent/types';
import {createAnswerDraftStream} from '../../agentRuntime/answerDraftStream';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {clearCodeAwareOutputGuards, createCodeAwareStreamingTextProjection, registerCodeAwareCanary}
  from '../../services/security/codeAwareOutputRegistry';

/** A bridge whose draft tokens go to the same emitter as its other updates. */
function bridgeFor(emit: (update: StreamingUpdate) => unknown,
  ...rest: Parameters<typeof createSseBridge> extends [unknown, unknown, ...infer Rest] ? Rest : never) {
  const deliver = (update: StreamingUpdate) => { emit(update); };
  return createSseBridge(deliver, createAnswerDraftStream('run-test', deliver), ...rest);
}

describe('createSseBridge', () => {
  it.each([false, true])('retains private source outcomes before transport truncation (body=%s)', includeBody => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor(update => updates.push(update));
    const result = {success: true, matches: Array.from({length: 20}, (_, i) => ({
      referenceId: `source-reference-${i}`, codebaseId: 'codebase-a',
      filePath: `src/PRIVATE_SOURCE_PATH_${i}.kt`, lineRange: {start: 1, end: 20},
      ...(includeBody ? {text: 'PRIVATE_SOURCE_BODY'} : {}),
    }))};
    bridge.handleMessage({type: 'assistant', message: {content: [{
      type: 'tool_use', id: 'source-outcome', name: 'search_codebase', input: {},
    }]}});
    bridge.handleMessage({type: 'user', message: {content: [{
      type: 'tool_result', tool_use_id: 'source-outcome', content: JSON.stringify(result),
    }]}});
    const update = updates.find(item => item.type === 'agent_response')!;
    expect(() => JSON.parse(update.content.result)).toThrow();
    expect(update.content.privateToolResultReceipt).toBeDefined();
    const projected = projectCodeAwareStreamingUpdate('claude-source-outcome', update, true, 'en');
    expect(projected).toMatchObject({content: {resultNarration: includeBody
      ? 'Authorized content was read and is available to check against trace evidence'
      : 'Candidate source or knowledge locations are available; their content has not been read'}});
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_SOURCE|privateToolResultReceipt/);
    expect(projectCodeAwareStreamingUpdate('claude-source-outcome', JSON.parse(JSON.stringify(update)), true, 'en')).toBeNull();
    bridge.dispose();
  });

  it('does not guess tool identity for unknown results or emit duplicate responses', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor(update => updates.push(update));
    const dispatch = {type: 'assistant', message: {content: [
      {type: 'tool_use', id: 'call-a', name: 'read_codebase_file', input: {}},
      {type: 'tool_use', id: 'call-b', name: 'execute_sql', input: {}},
    ]}};
    bridge.handleMessage(dispatch);
    bridge.handleMessage(dispatch);
    expect(updates.filter(update => update.type === 'agent_task_dispatched')).toHaveLength(2);
    bridge.handleMessage({type: 'user', tool_use_result: {raw: 'UNKNOWN_SOURCE_CANARY'}});
    bridge.handleMessage({type: 'user', message: {content: [
      {type: 'tool_result', tool_use_id: 'missing', content: 'UNKNOWN_SOURCE_CANARY'},
    ]}});
    expect(updates.filter(update => update.type === 'agent_response')).toEqual([]);
    const result = {type: 'user', message: {content: [
      {type: 'tool_result', tool_use_id: 'call-b', content: [{type: 'text', text: '{"success":true}'}]},
    ]}};
    bridge.handleMessage(result);
    bridge.handleMessage(result);
    bridge.handleMessage(dispatch);
    expect(updates.filter(update => update.type === 'agent_response')).toHaveLength(1);
    expect(updates.filter(update => update.type === 'agent_task_dispatched')).toHaveLength(2);
    expect(JSON.stringify(updates)).not.toContain('UNKNOWN_SOURCE_CANARY');
    bridge.dispose();
  });
  it('does not turn quoted failure fields inside successful data into a failed call', () => {
    expect(isSdkToolResultFailure({content: [{type: 'text', text: JSON.stringify({
      success: true, example: {success: false}, note: 'The previous invocation had "success": false.',
    })}]})).toBe(false);
  });

  it.each([
    ['object', (value: unknown) => value],
    ['serialized object', (value: unknown) => JSON.stringify(value)],
  ])('associates a complete SDK receipt in %s form with its own tool call', (_label, wrap) => {
    const complete = createRuntimeToolResult({success: false, planPhaseId: 'p1'});
    const block = {type: 'tool_result', tool_use_id: 'call1', content: 'shortened'};
    const one = extractSdkToolResultBlocks({message: {content: [block]}, tool_use_result: wrap(complete)});
    expect(readRuntimeToolResultFacts(one[0].result)).toEqual({success: false, planPhaseId: 'p1'});
    const mismatched = extractSdkToolResultBlocks({message: {content: [block]}, tool_use_result: wrap({...complete, tool_use_id: 'call2'})});
    expect(readRuntimeToolResultFacts(mismatched[0].result)).toEqual({});
    const missingContent = extractSdkToolResultBlocks({message: {content: [{...block, content: undefined}]}, tool_use_result: wrap({...complete, tool_use_id: 'call2'})});
    expect(readRuntimeToolResultFacts(missingContent[0].result)).toEqual({});
    const multiple = extractSdkToolResultBlocks({message: {content: [block, {...block, tool_use_id: 'call2'}]}, tool_use_result: wrap(complete)});
    expect(multiple.map(item => readRuntimeToolResultFacts(item.result))).toEqual([{}, {}]);
    const bound = extractSdkToolResultBlocks({message: {content: [block, {...block, tool_use_id: 'call2'}]}, tool_use_result: wrap({...complete, tool_use_id: 'call2'})});
    expect(bound.map(item => readRuntimeToolResultFacts(item.result))).toEqual([{}, {success: false, planPhaseId: 'p1'}]);
  });
  it('detects plain and string-escaped MCP failures for metrics', () => {
    expect(isSdkToolResultFailure({success: false})).toBe(true);
    expect(isSdkToolResultFailure('{"success":false}')).toBe(true);
    expect(isSdkToolResultFailure('"{\\"success\\":false}"')).toBe(true);
    expect(isSdkToolResultFailure({success: true})).toBe(false);
  });

  it('does not emit a terminal error for SDK max-turn results', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor((update) => updates.push(update));

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
    const bridge = bridgeFor((update) => updates.push(update));

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
    const bridge = bridgeFor((update) => updates.push(update), 'en');

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
    const bridge = bridgeFor((update) => updates.push(update));

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
    const bridge = bridgeFor(() => {});

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
    const bridge = bridgeFor((update) => updates.push(update));

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
      content: { token: '完整修正报告', runId: 'run-test', attempt: 0 },
    }));
  });

  it('maps parallel tool results back to their SDK tool_use_id', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor((update) => updates.push(update));

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
    const bridge = bridgeFor((update) => updates.push(update));
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

  it('retains complete multi-chunk answers beyond the former 256 KiB limit, including after dispose', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor(update => updates.push(update));
    const chunks = ['a'.repeat(150_000), '汉'.repeat(150_000), '\nComplete final answer tail.'];
    for (const text of chunks) {
      bridge.handleMessage({type: 'stream_event', event: {
        type: 'content_block_delta', delta: {type: 'text_delta', text},
      }});
      bridge.flushPendingAnswer();
    }
    const answer = chunks.join('');
    expect(bridge.getAccumulatedAnswer().length).toBe(answer.length);
    expect(bridge.getAccumulatedAnswer()).toBe(answer);
    expect(updates.filter(update => update.type === 'answer_token').map(update => update.content.token).join('')).toBe(answer);
    expect(bridge.getAccumulatedAnswer()).not.toContain('[truncated accumulated answer]');
    bridge.dispose();
    bridge.dispose();
    bridge.handleMessage({type: 'assistant', message: {content: [{type: 'text', text: 'after dispose'}]}});
    bridge.flushPendingAnswer();
    expect(bridge.getAccumulatedAnswer()).toBe(answer);
    expect(updates.filter(update => update.type === 'answer_token').map(update => update.content.token).join('')).toBe(answer);
  });

  it('projects a private canary split across chunks at the former answer limit and withdraws the draft', () => {
    jest.useFakeTimers();
    const sessionId = 'claude-answer-beyond-old-limit';
    const canary = 'PRIVATE_CLAUDE_ANSWER_BOUNDARY_CANARY';
    const split = Math.floor(canary.length / 2);
    registerCodeAwareCanary(sessionId, canary);
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor(update => updates.push(update), 'en', {},
      createCodeAwareStreamingTextProjection(sessionId, 'answer'));
    try {
      const prefix = 'a'.repeat(256 * 1024 - split);
      const tail = '\nPublic text after the private boundary.';
      bridge.handleMessage({type: 'stream_event', event: {
        type: 'content_block_delta', delta: {type: 'text_delta', text: prefix + canary.slice(0, split)},
      }});
      jest.advanceTimersByTime(250);
      bridge.handleMessage({type: 'stream_event', event: {
        type: 'content_block_delta', delta: {type: 'text_delta', text: canary.slice(split) + tail},
      }});
      bridge.flushPendingAnswer();
      expect(bridge.getAccumulatedAnswer().length).toBe(prefix.length + canary.length + tail.length);
      expect(bridge.getAccumulatedAnswer()).toBe(prefix + canary + tail);
      const visible = updates.filter(update => update.type === 'answer_token').map(update => update.content.token).join('');
      expect(visible).not.toContain(canary);
      expect(visible).not.toContain(canary.slice(0, split));
      expect(visible).not.toContain(canary.slice(split));
      expect(visible).not.toContain('[truncated accumulated answer]');
      // The guard replaced the oversized unit before anything was shown, so the
      // draft is withdrawn without a token; the final answer is projected whole
      // from the intact accumulation above.
      expect(updates.filter(update => update.type === 'answer_token' || update.type === 'answer_segment_reset')).toEqual([]);
    } finally {
      bridge.dispose();
      clearCodeAwareOutputGuards(sessionId);
      jest.useRealTimers();
    }
  });

  it('clears a large misclassified answer when tool use is discovered and accumulates the next answer', () => {
    const bridge = bridgeFor(() => {});
    bridge.handleMessage({type: 'stream_event', event: {
      type: 'content_block_delta', delta: {type: 'text_delta', text: 'intermediate '.repeat(30_000)},
    }});
    bridge.flushPendingAnswer();
    bridge.handleMessage({type: 'stream_event', event: {
      type: 'content_block_start', content_block: {type: 'tool_use', id: 'late-tool', name: 'query'},
    }});
    expect(bridge.getAccumulatedAnswer()).toBe('');
    bridge.handleMessage({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'late-tool', content: '{}'}]}});
    bridge.handleMessage({type: 'assistant', message: {content: [{type: 'text', text: 'Actual final answer'}]}});
    expect(bridge.getAccumulatedAnswer()).toBe('Actual final answer');
    bridge.dispose();
    expect(bridge.getAccumulatedAnswer()).toBe('Actual final answer');
  });

  describe('answer draft segments', () => {
    const draftEvents = (updates: StreamingUpdate[]) => updates
      .filter(update => update.type === 'answer_token' || update.type === 'answer_segment_reset')
      .map(update => [update.type, update.content.token ?? null, update.content.runId, update.content.attempt]);
    const delta = (text: string, parent: string | null = null) => ({type: 'stream_event', parent_tool_use_id: parent,
      event: {type: 'content_block_delta', delta: {type: 'text_delta', text}}});
    const messageStart = (parent: string | null = null) => ({type: 'stream_event', parent_tool_use_id: parent,
      event: {type: 'message_start', message: {}}});

    it('revokes the draft at a tool_use after answer text and at the next message_start', () => {
      jest.useFakeTimers();
      try {
        const updates: StreamingUpdate[] = [];
        const bridge = createSseBridge(update => updates.push(update),
          createAnswerDraftStream('run-c', update => updates.push(update)), 'en', {}, undefined);
        bridge.handleMessage(messageStart());
        bridge.handleMessage(delta('Looks like the answer'));
        jest.advanceTimersByTime(250);
        bridge.handleMessage({type: 'stream_event', parent_tool_use_id: null, event: {
          type: 'content_block_start', content_block: {type: 'tool_use', id: 'tool-1', name: 'query'},
        }});
        bridge.handleMessage({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 'tool-1', content: '{}'}]}});
        bridge.handleMessage(messageStart());
        bridge.handleMessage(delta('Final answer'));
        jest.advanceTimersByTime(250);
        // A retry of the same response starts over.
        bridge.handleMessage(messageStart());
        expect(draftEvents(updates)).toEqual([
          ['answer_token', 'Looks like the answer', 'run-c', 0],
          ['answer_segment_reset', null, 'run-c', 1],
          ['answer_token', 'Final answer', 'run-c', 1],
          ['answer_segment_reset', null, 'run-c', 2],
        ]);
        bridge.dispose();
      } finally {jest.useRealTimers();}
    });

    it('drops what an interrupted response held at the next message_start', () => {
      jest.useFakeTimers();
      const sessionId = 'claude-interrupted-draft';
      try {
        for (const projection of [undefined, createCodeAwareStreamingTextProjection(sessionId, 'claude-full-answer', 'owner')]) {
          const updates: StreamingUpdate[] = [];
          const bridge = createSseBridge(update => updates.push(update),
            createAnswerDraftStream('run-i', update => updates.push(update)), 'en', {}, projection);
          bridge.handleMessage(messageStart());
          bridge.handleMessage(delta('Unclassified text'));
          bridge.handleMessage(messageStart());
          bridge.handleMessage(delta('Streamed but unfinished line'));
          jest.advanceTimersByTime(250);
          // No assistant message: the response was interrupted and replaced.
          bridge.handleMessage(messageStart());
          bridge.handleMessage(delta('Fresh answer\n'));
          jest.advanceTimersByTime(250);
          const shown = draftEvents(updates).filter(([type]) => type === 'answer_token').map(([, token]) => token);
          expect(shown).toEqual(projection
            ? ['Fresh answer\n']
            : ['Streamed but unfinished line', 'Fresh answer\n']);
          expect(bridge.getAccumulatedAnswer()).not.toContain('Unclassified text');
          bridge.dispose();
        }
      } finally { jest.useRealTimers(); clearCodeAwareOutputGuards(sessionId); }
    });

    it('withdraws a private draft when a credential completes across lines', () => {
      jest.useFakeTimers();
      const sessionId = 'claude-private-draft';
      try {
        const updates: StreamingUpdate[] = [];
        const bridge = createSseBridge(update => updates.push(update),
          createAnswerDraftStream('run-p', update => updates.push(update)), 'en', {},
          createCodeAwareStreamingTextProjection(sessionId, 'claude-full-answer', 'owner'));
        bridge.handleMessage(messageStart());
        bridge.handleMessage(delta('Intro line\n'));
        jest.advanceTimersByTime(250);
        for (const text of ['api_key=\n', '"synthetic-secret-123456"\n', 'Later line\n']) bridge.handleMessage(delta(text));
        bridge.handleMessage({type: 'assistant', parent_tool_use_id: null, message: {content: [{type: 'text',
          text: 'Intro line\napi_key=\n"synthetic-secret-123456"\nLater line\n'}]}});
        expect(draftEvents(updates)).toEqual([
          ['answer_token', 'Intro line\n', 'run-p', 0],
          ['answer_segment_reset', null, 'run-p', 1],
        ]);
        expect(JSON.stringify(updates)).not.toContain('synthetic-secret-123456');
        bridge.dispose();
      } finally { jest.useRealTimers(); clearCodeAwareOutputGuards(sessionId); }
    });

    it('never lets a sub-agent final turn into the draft or the accumulated answer', () => {
      jest.useFakeTimers();
      try {
        const updates: StreamingUpdate[] = [];
        const bridge = createSseBridge(update => updates.push(update),
          createAnswerDraftStream('run-c', update => updates.push(update)), 'en', {}, undefined);
        bridge.handleMessage(messageStart('task-1'));
        bridge.handleMessage(delta('SUB_AGENT_SUMMARY', 'task-1'));
        jest.advanceTimersByTime(250);
        bridge.handleMessage({type: 'assistant', parent_tool_use_id: 'task-1',
          message: {content: [{type: 'text', text: 'SUB_AGENT_SUMMARY'}]}});
        expect(draftEvents(updates)).toEqual([]);
        expect(bridge.getAccumulatedAnswer()).toBe('');
        expect(updates).toContainEqual(expect.objectContaining({type: 'thought',
          content: {thought: 'SUB_AGENT_SUMMARY'}}));
        bridge.handleMessage(messageStart());
        bridge.handleMessage(delta('Main answer'));
        jest.advanceTimersByTime(250);
        bridge.handleMessage({type: 'assistant', parent_tool_use_id: null,
          message: {content: [{type: 'text', text: 'Main answer'}]}});
        expect(draftEvents(updates)).toEqual([['answer_token', 'Main answer', 'run-c', 0]]);
        expect(bridge.getAccumulatedAnswer()).toBe('Main answer');
        bridge.dispose();
      } finally {jest.useRealTimers();}
    });
  });

  it('disposes pending timers without emitting buffered text', () => {
    jest.useFakeTimers();
    try {
      const updates: StreamingUpdate[] = [];
      const bridge = bridgeFor(update => updates.push(update));
      bridge.handleMessage({type: 'stream_event', event: {
        type: 'content_block_delta', delta: {type: 'text_delta', text: 'must not flush after dispose'},
      }});
      bridge.dispose();
      jest.advanceTimersByTime(250);
      expect(updates).toEqual([]);
      expect(bridge.getAccumulatedAnswer()).toBe('');
    } finally {jest.useRealTimers();}
  });

  it('projects private wiki tool results before emitting agent_response', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor((update) => updates.push(update));
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

  it('does not republish an unassociated replay result as a new tool response', () => {
    const updates: StreamingUpdate[] = [];
    const bridge = bridgeFor((update) => updates.push(update));
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
    expect(updates).toEqual([]);
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
