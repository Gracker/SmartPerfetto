// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { StreamingUpdate } from '../agent/types';

export type UpdateEmitter = (update: StreamingUpdate) => void;

/** Map MCP tool names to user-friendly Chinese descriptions. */
function getFriendlyToolMessage(toolName: string, args: any): string {
  switch (toolName) {
    case 'mcp__smartperfetto__execute_sql': {
      const sql = String(args?.sql || '').toLowerCase();
      const tableMatch = sql.match(/from\s+(\w+)/i);
      const table = tableMatch?.[1] || '';
      const tableHints: Record<string, string> = {
        actual_frame_timeline_event: '帧渲染数据',
        expected_frame_timeline_event: '预期帧数据',
        frame_slice: '帧 Slice',
        slice: 'Trace Slice',
        thread_state: '线程状态',
        thread: '线程信息',
        process: '进程信息',
        counter: '计数器',
        sched_slice: 'CPU 调度',
        android_launches: '应用启动',
        android_app_process_starts: '进程启动',
        cpu_counter_track: 'CPU 频率',
        gpu_counter_track: 'GPU 频率',
        memory_counter: '内存计数',
        android_binder_transaction: 'Binder 事务',
      };
      const hint = tableHints[table] || (table ? table : '');
      return hint ? `执行 SQL 查询: ${hint}` : '执行 SQL 查询';
    }
    case 'mcp__smartperfetto__invoke_skill': {
      const skillId = args?.skillId;
      return skillId ? `调用分析技能: ${skillId}` : '调用分析技能';
    }
    case 'mcp__smartperfetto__list_skills':
      return '查询可用技能列表';
    case 'mcp__smartperfetto__detect_architecture':
      return '检测渲染架构';
    case 'mcp__smartperfetto__lookup_sql_schema':
      return `查询 SQL 表结构: ${args?.keyword || ''}`;
    case 'mcp__smartperfetto__write_analysis_note':
      return `记录分析笔记: ${args?.section || ''}`;
    case 'mcp__smartperfetto__fetch_artifact':
      return `获取数据详情: ${args?.artifactId || ''}`;
    case 'mcp__smartperfetto__query_perfetto_source':
      return `搜索 Perfetto 源码: ${args?.keyword || ''}`;
    default:
      return `调用工具: ${toolName}`;
  }
}

/** Return type for createSseBridge — message handler + accumulated answer accessor. */
export interface SseBridge {
  handleMessage: (msg: any) => void;
  /** Returns all text classified as answer_token during this stream.
   *  Used as fallback when the SDK terminal `result` message is empty (e.g. timeout). */
  getAccumulatedAnswer: () => string;
}

const RECOVERABLE_RESULT_SUBTYPES = new Set(['error_max_turns']);

function isRecoverableResultSubtype(subtype: unknown): boolean {
  return typeof subtype === 'string' && RECOVERABLE_RESULT_SUBTYPES.has(subtype);
}

/**
 * Creates a bridge function that translates Agent SDK messages into
 * SmartPerfetto StreamingUpdate events for SSE forwarding to the frontend.
 */
export function createSseBridge(emit: UpdateEmitter): SseBridge {
  let lastToolUseId: string | undefined;
  /**
   * Track whether the current assistant turn uses tools.
   * When true, stream_event text deltas are intermediate reasoning (emit as thought).
   * When false, they are final answer text (emit as answer_token).
   * Reset on each new assistant message.
   */
  let currentTurnHasToolUse = false;
  /**
   * Track whether stream_event text deltas were emitted for the current turn.
   * When true, skip re-emitting text blocks from the complete `assistant` message
   * to avoid duplication (SDK sends content via both pathways).
   */
  let currentTurnStreamedText = false;
  /** Map task_id → agent name for sub-agent lifecycle tracking. */
  const taskIdToAgentName: Map<string, string> = new Map();

  /**
   * Text buffering for correct classification.
   *
   * Within a single Claude API turn, content blocks are ordered: text blocks
   * first, then tool_use blocks. In the streaming phase, text_delta events
   * arrive BEFORE content_block_start for tool_use. Without buffering, text
   * is emitted as answer_token when it's actually intermediate reasoning
   * before tool calls.
   *
   * Strategy: buffer text deltas briefly. If a tool_use block starts within
   * the buffer window, flush as thought. Otherwise start streaming as
   * answer_token (indicating it's the final answer turn).
   */
  let textBuffer = '';
  let bufferFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Once we've committed to answer_token mode for this turn, stream directly. */
  let streamingAsAnswer = false;
  /** Accumulated answer text from the final (non-tool) turn — used as fallback
   *  when SDK `result` message is empty (e.g. on timeout). */
  let accumulatedAnswerText = '';
  // Buffer window: trade-off between streaming responsiveness and classification
  // accuracy. Shorter = more responsive but higher risk of misclassifying thought
  // as answer_token when tool_use arrives with network jitter.
  // P2-G4: Increased from 100ms to 200ms — reduces risk of misclassifying
  // pre-tool reasoning as answer_token when tool_use arrives with network jitter.
  // 200ms is well below human perception threshold for streaming text.
  const BUFFER_DELAY_MS = 200;

  function cancelBufferTimer(): void {
    if (bufferFlushTimer !== null) {
      clearTimeout(bufferFlushTimer);
      bufferFlushTimer = null;
    }
  }

  /** Flush buffered text as thought (intermediate reasoning before tool calls). */
  function flushBufferAsThought(): void {
    cancelBufferTimer();
    if (textBuffer) {
      currentTurnStreamedText = true;
      emit({ type: 'thought', content: { thought: textBuffer }, timestamp: Date.now() });
      textBuffer = '';
    }
  }

  /** Flush buffered text as answer_token and switch to direct streaming mode. */
  function flushBufferAsAnswer(): void {
    cancelBufferTimer();
    if (textBuffer) {
      currentTurnStreamedText = true;
      accumulatedAnswerText += textBuffer;
      emit({ type: 'answer_token', content: { token: textBuffer }, timestamp: Date.now() });
      textBuffer = '';
    }
    streamingAsAnswer = true;
  }

  function handleSdkMessage(msg: any): void {
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
        if (currentTurnHasToolUse) {
          // Already know this turn has tools — buffer text and flush as
          // a single thought when the next tool_use block starts or the
          // turn ends, instead of emitting per-delta fragments.
          textBuffer += event.delta.text;
        } else if (streamingAsAnswer) {
          // Buffer timer already fired — stream as answer_token directly
          currentTurnStreamedText = true;
          accumulatedAnswerText += event.delta.text;
          emit({ type: 'answer_token', content: { token: event.delta.text }, timestamp: now });
        } else {
          // Buffer text until we know if tool_use follows
          textBuffer += event.delta.text;
          cancelBufferTimer();
          bufferFlushTimer = setTimeout(() => {
            flushBufferAsAnswer();
          }, BUFFER_DELAY_MS);
        }
      }
      // Track tool_use blocks in the streaming phase to set currentTurnHasToolUse early
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        // Tool use detected — any buffered text was intermediate reasoning
        flushBufferAsThought();
        currentTurnHasToolUse = true;
        // Recovery: if buffer timer already fired and text was emitted as
        // answer_token, that classification was wrong (it was actually thought).
        // Reset streamingAsAnswer so subsequent text in this turn is handled
        // correctly. The frontend handles this gracefully — answer text
        // appearing before tool calls is visually acceptable.
        if (streamingAsAnswer) {
          // Answer text was misclassified as conclusion — it was actually
          // intermediate reasoning before tool calls. Clear accumulated text.
          accumulatedAnswerText = '';
          streamingAsAnswer = false;
        }
      }
      return;
    }

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;

      const hasToolUse = content.some((block: any) => block.type === 'tool_use');
      // If text was buffered but never flushed (edge case), flush now
      if (textBuffer) {
        if (hasToolUse) {
          flushBufferAsThought();
        } else {
          flushBufferAsAnswer();
        }
      }
      // The complete assistant message duplicates text already emitted via
      // stream_event deltas. Only re-emit text if streaming didn't happen
      // (e.g. when stream_event was skipped or unavailable).
      const textAlreadyStreamed = currentTurnStreamedText;
      // Reset per-turn state for the next turn
      currentTurnHasToolUse = hasToolUse;
      currentTurnStreamedText = false;
      streamingAsAnswer = false;

      for (const block of content) {
        if (block.type === 'tool_use') {
          lastToolUseId = block.id;
          const friendlyMsg = getFriendlyToolMessage(block.name, block.input);
          emit({
            type: 'agent_task_dispatched',
            content: { taskId: block.id, toolName: block.name, args: block.input, message: friendlyMsg },
            timestamp: now,
          });
        } else if (block.type === 'text' && block.text?.trim().length > 0 && !textAlreadyStreamed) {
          if (hasToolUse) {
            // Intermediate reasoning — emit as thought so frontend can distinguish from system progress
            emit({
              type: 'thought',
              content: { thought: block.text },
              timestamp: now,
            });
          } else {
            // Final answer text — stream as answer tokens
            accumulatedAnswerText += block.text;
            emit({ type: 'answer_token', content: { token: block.text }, timestamp: now });
          }
        }
      }
      return;
    }

    if (msg.type === 'user' && msg.tool_use_result !== undefined) {
      // After tool result, next assistant turn starts fresh
      cancelBufferTimer();
      textBuffer = '';
      currentTurnHasToolUse = false;
      currentTurnStreamedText = false;
      streamingAsAnswer = false;
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
      } else if (isRecoverableResultSubtype(msg.subtype)) {
        emit({
          type: 'progress',
          content: {
            phase: 'concluding',
            message: '分析达到轮次上限，正在整理已收集结果...',
            subtype: msg.subtype,
          },
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
      return;
    }

    // Sub-agent lifecycle messages from Claude Agent SDK.
    // SDK sends these as { type: 'system', subtype: 'task_started|task_progress|task_notification' }
    // with fields: task_id, description, status, summary, usage.
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      const description = msg.description || 'sub-agent';
      const taskId = msg.task_id;
      const descriptions: Record<string, string> = {
        'frame-expert': '帧渲染与掉帧诊断',
        'system-expert': '系统级性能分析 (CPU/内存/Binder)',
        'startup-expert': '应用启动分析',
      };
      // Match known agent names from the task description
      const agentName = Object.keys(descriptions).find(name => description.includes(name)) || description;
      const desc = descriptions[agentName] || description;
      // Track task_id → agent name for use in task_notification (completion)
      if (taskId) taskIdToAgentName.set(taskId, agentName);
      emit({
        type: 'sub_agent_started',
        content: { agentName, description: desc, message: `委托子代理 [${agentName}]: ${desc}` },
        timestamp: now,
      });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'task_progress') {
      const description = msg.description || '';
      const lastTool = msg.last_tool_name || '';
      emit({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: `子代理进度: ${description}${lastTool ? ` (${lastTool})` : ''}`,
        },
        timestamp: now,
      });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'task_notification') {
      const taskId = msg.task_id;
      const summary = msg.summary || '';
      const status = msg.status || 'completed'; // 'completed' | 'failed' | 'stopped'
      const usage = msg.usage;
      // Resolve agent name from task_id tracked at task_started, fallback to summary
      const agentName = (taskId && taskIdToAgentName.get(taskId)) || summary;
      if (taskId) taskIdToAgentName.delete(taskId); // Clean up after completion
      if (status === 'completed') {
        emit({
          type: 'sub_agent_completed',
          content: {
            agentName,
            message: `子代理 [${agentName}] 完成证据收集${usage ? ` (${usage.tool_uses} 次工具调用, ${Math.round(usage.duration_ms / 1000)}s)` : ''}`,
          },
          timestamp: now,
        });
      } else {
        // Sub-agent failed or was stopped
        emit({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: `子代理 [${agentName}] ${status}: ${summary}`,
          },
          timestamp: now,
        });
      }
      return;
    }

    // SDK auto-compact: fires when conversation history exceeds context window.
    // The SDK summarizes prior turns, potentially losing early-turn details.
    // Notify frontend so user is aware of context compression.
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      console.warn('[SSEBridge] SDK auto-compact triggered — prior conversation history has been summarized');
      emit({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: '⚠ 对话历史已被自动压缩（上下文窗口接近上限），早期分析细节可能丢失',
        },
        timestamp: now,
      });
      return;
    }

    // Catch-all for unhandled message types
    console.log(`[SSEBridge] Unhandled SDK message type: ${msg.type}`, JSON.stringify(msg).substring(0, 200));
  }

  return {
    handleMessage: handleSdkMessage,
    getAccumulatedAnswer: () => accumulatedAnswerText,
  };
}
