import type { StreamingUpdate } from '../agent/types';

export type UpdateEmitter = (update: StreamingUpdate) => void;

/**
 * Creates a bridge function that translates Agent SDK messages into
 * SmartPerfetto StreamingUpdate events for SSE forwarding to the frontend.
 */
export function createSseBridge(emit: UpdateEmitter) {
  let lastToolUseId: string | undefined;

  return function handleSdkMessage(msg: any): void {
    const now = Date.now();

    if (msg.type === 'system' && msg.subtype === 'init') {
      emit({
        type: 'progress',
        content: { phase: 'starting', message: 'Claude 分析引擎已初始化', model: msg.model, tools: msg.tools },
        timestamp: now,
      });
      return;
    }

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        emit({ type: 'answer_token', content: { token: event.delta.text }, timestamp: now });
      }
      return;
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === 'tool_use') {
          lastToolUseId = block.id;
          emit({
            type: 'agent_task_dispatched',
            content: { taskId: block.id, toolName: block.name, args: block.input, message: `调用工具: ${block.name}` },
            timestamp: now,
          });
        } else if (block.type === 'text' && block.text?.trim().length > 0) {
          emit({
            type: 'progress',
            content: { phase: 'analyzing', message: block.text },
            timestamp: now,
          });
        }
      }
      return;
    }

    if (msg.type === 'user' && msg.tool_use_result !== undefined) {
      emit({
        type: 'agent_response',
        content: {
          taskId: lastToolUseId || 'unknown',
          result: typeof msg.tool_use_result === 'string'
            ? msg.tool_use_result
            : JSON.stringify(msg.tool_use_result),
        },
        timestamp: now,
      });
      return;
    }

    if (msg.type === 'result') {
      if (msg.subtype === 'success') {
        emit({
          type: 'conclusion',
          content: { conclusion: msg.result || '', durationMs: msg.duration_ms, turns: msg.num_turns, costUsd: msg.total_cost_usd },
          timestamp: now,
        });
      } else {
        const errors = msg.errors || [];
        emit({
          type: 'error',
          content: {
            message: `Claude analysis error (${msg.subtype}): ${errors.join('; ') || 'Unknown error'}`,
            subtype: msg.subtype,
          },
          timestamp: now,
        });
      }
    }
  };
}
