// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { StreamingUpdate } from '../../../agent/types';
import {
  isSdkMaxTurnsSubtype,
  MAX_TURNS_TERMINATION_REASON,
  SDK_MAX_TURNS_SUBTYPE,
} from '../../../agentv3/analysisTermination';
import { DEFAULT_OUTPUT_LANGUAGE, localize, type OutputLanguage } from '../../../agentv3/outputLanguage';
import { formatToolCallNarration, type ToolNarrationOptions } from '../../../agentv3/toolNarration';
import {projectToolResultForExternalSurface} from '../../../services/rag/toolResultProjectionFilter';
import type {CodeAwareStreamingTextProjection} from '../../../services/security/codeAwareOutputRegistry';
import {
  appendBoundedText,
  summarizeExternalToolResult,
} from '../../runtimeLimits';

export type UpdateEmitter = (update: StreamingUpdate) => void;

export interface SdkToolResultBlock {
  toolUseId?: string;
  result: unknown;
  isError?: boolean;
}

export function extractSdkToolResultBlocks(msg: any): SdkToolResultBlock[] {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((block: any) => block && typeof block === 'object' && block.type === 'tool_result')
    .map((block: any) => ({
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
      result: block.content ?? msg.tool_use_result,
      isError: typeof block.is_error === 'boolean' ? block.is_error : undefined,
    }));
}

export function stringifySdkToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export function isSdkToolResultFailure(result: unknown, isError?: boolean): boolean {
  if (isError === true) return true;
  if (result && typeof result === 'object') {
    const record = result as {success?: unknown; isError?: unknown};
    if (record.success === false || record.isError === true) return true;
  }
  const text = stringifySdkToolResult(result);
  return /(?:\\?")success(?:\\?")\s*:\s*false|(?:\\?")isError(?:\\?")\s*:\s*true/.test(text);
}

/** Return type for createSseBridge — message handler + accumulated answer accessor. */
export interface SseBridge {
  handleMessage: (msg: any) => void;
  /** Returns all text classified as answer_token during this stream.
   *  Used as fallback when the SDK terminal `result` message is empty (e.g. timeout). */
  getAccumulatedAnswer: () => string;
  /**
   * Forces any pending text buffer into answer_token mode.
   * Useful when a stream is cancelled before the SDK emits the assistant/result
   * message that would normally disambiguate and flush the final answer text.
   */
  flushPendingAnswer: () => void;
  /** Release timers and per-stream lookup state without emitting buffered text. */
  dispose: () => void;
}

/**
 * Creates a bridge function that translates Agent SDK messages into
 * SmartPerfetto StreamingUpdate events for SSE forwarding to the frontend.
 */
export function createSseBridge(
  emit: UpdateEmitter,
  language: OutputLanguage = DEFAULT_OUTPUT_LANGUAGE,
  narrationOptions: ToolNarrationOptions = {},
  textProjection?: CodeAwareStreamingTextProjection,
): SseBridge {
  let lastToolUseId: string | undefined;
  const toolUseIdToName = new Map<string, string>();
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
  let accumulatedAnswerTruncated = false;
  let disposed = false;
  // Buffer window: trade-off between streaming responsiveness and classification
  // accuracy. Shorter = more responsive but higher risk of misclassifying thought
  // as answer_token when tool_use arrives with network jitter.
  // P2-G4: Increased from 100ms to 200ms — reduces risk of misclassifying
  // pre-tool reasoning as answer_token when tool_use arrives with network jitter.
  // 200ms is well below human perception threshold for streaming text.
  const BUFFER_DELAY_MS = 200;
  const MAX_TRACKED_TASKS = 256;

  function setBoundedTaskName(
    target: Map<string, string>,
    taskId: string,
    name: string,
  ): void {
    if (!target.has(taskId) && target.size >= MAX_TRACKED_TASKS) {
      const oldestTaskId = target.keys().next().value;
      if (oldestTaskId) target.delete(oldestTaskId);
    }
    target.set(taskId, name);
  }

  function projectCompleteText(text: string): string {
    return textProjection?.projectComplete(text) ?? text;
  }

  function emitAnswerChunk(text: string, timestamp: number): void {
    if (!text || disposed) return;
    const previousLength = accumulatedAnswerText.length;
    const bounded = appendBoundedText({
      current: accumulatedAnswerText,
      chunk: text,
      alreadyTruncated: accumulatedAnswerTruncated,
    });
    accumulatedAnswerText = bounded.text;
    accumulatedAnswerTruncated = bounded.truncated;
    const acceptedText = bounded.text.slice(previousLength);
    const projected = textProjection?.write(acceptedText) ?? acceptedText;
    if (projected) emit({type: 'answer_token', content: {token: projected}, timestamp});
  }

  function flushProjectedAnswer(timestamp = Date.now()): void {
    const projected = textProjection?.flush() ?? '';
    if (projected) emit({type: 'answer_token', content: {token: projected}, timestamp});
  }

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
      emit({type: 'thought', content: {thought: projectCompleteText(textBuffer)}, timestamp: Date.now()});
      textBuffer = '';
    }
  }

  /** Flush buffered text as answer_token and switch to direct streaming mode. */
  function flushBufferAsAnswer(): void {
    cancelBufferTimer();
    if (textBuffer) {
      currentTurnStreamedText = true;
      emitAnswerChunk(textBuffer, Date.now());
      textBuffer = '';
    }
    streamingAsAnswer = true;
  }

  function handleSdkMessage(msg: any): void {
    if (disposed) return;
    const now = Date.now();

    if (msg.type === 'system' && msg.subtype === 'init') {
      emit({
        type: 'progress',
        content: {
          phase: 'starting',
          message: localize(language, 'AI 分析引擎已初始化', 'AI analysis engine initialized'),
          model: msg.model,
          tools: msg.tools,
        },
        timestamp: now,
      });
      return;
    }

    // Claude Agent SDK emits control-plane status messages while waiting for
    // model responses. They do not represent user-visible analysis progress.
    if (msg.type === 'system' && (msg.subtype === 'status' || msg.subtype === 'thinking_tokens')) {
      return;
    }

    if (msg.type === 'rate_limit_event') {
      emit({
        type: 'progress',
        content: {
          phase: 'analyzing',
          message: localize(
            language,
            'AI 服务请求被限流，SDK 正在等待后续响应...',
            'AI service request was rate limited; the SDK is waiting for the next response...',
          ),
        },
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
          emitAnswerChunk(event.delta.text, now);
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
          accumulatedAnswerTruncated = false;
          const projectedTail = textProjection?.flush() ?? '';
          if (projectedTail) {
            emit({type: 'thought', content: {thought: projectedTail}, timestamp: now});
          }
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
          if (typeof block.id === 'string' && typeof block.name === 'string') {
            setBoundedTaskName(toolUseIdToName, block.id, block.name);
          }
          const friendlyMsg = formatToolCallNarration(block.name, block.input, language, narrationOptions);
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
              content: {thought: projectCompleteText(block.text)},
              timestamp: now,
            });
          } else {
            // Final answer text — stream as answer tokens
            emitAnswerChunk(block.text, now);
          }
        }
      }
      if (!hasToolUse) flushProjectedAnswer(now);
      return;
    }

    if (msg.type === 'user' && msg.tool_use_result !== undefined) {
      // After tool result, next assistant turn starts fresh
      cancelBufferTimer();
      textBuffer = '';
      currentTurnHasToolUse = false;
      currentTurnStreamedText = false;
      streamingAsAnswer = false;
      const resultBlocks = extractSdkToolResultBlocks(msg);
      if (resultBlocks.length > 0) {
        for (const block of resultBlocks) {
          const taskId = block.toolUseId || lastToolUseId || 'unknown';
          const toolName = toolUseIdToName.get(taskId);
          emit({
            type: 'agent_response',
            content: {
              taskId,
              result: summarizeExternalToolResult(projectToolResultForExternalSurface(
                toolName ?? 'unknown',
                block.result,
              )),
            },
            timestamp: now,
          });
          toolUseIdToName.delete(taskId);
        }
      } else {
        const taskId = lastToolUseId || 'unknown';
        const toolName = toolUseIdToName.get(taskId);
        emit({
          type: 'agent_response',
          content: {
            taskId,
            result: summarizeExternalToolResult(projectToolResultForExternalSurface(
              toolName ?? 'unknown',
              msg.tool_use_result,
            )),
          },
          timestamp: now,
        });
        toolUseIdToName.delete(taskId);
      }
      return;
    }

    if (msg.type === 'result') {
      flushProjectedAnswer(now);
      if (msg.subtype === 'success') {
        emit({
          type: 'conclusion',
          content: {
            conclusion: projectCompleteText(msg.result || ''),
            durationMs: msg.duration_ms,
            turns: msg.num_turns,
            costUsd: msg.total_cost_usd,
          },
          timestamp: now,
        });
      } else if (isSdkMaxTurnsSubtype(msg.subtype)) {
        emit({
          type: 'progress',
          content: {
            phase: 'concluding',
            message: localize(
              language,
              '分析达到轮次上限，正在整理已收集结果，结论可能不完整...',
              'Analysis reached the turn limit. Organizing collected evidence; the conclusion may be incomplete...',
            ),
            subtype: msg.subtype,
            partial: true,
            terminationReason: MAX_TURNS_TERMINATION_REASON,
            turns: msg.num_turns,
          },
          timestamp: now,
        });
        emit({
          type: 'degraded',
          content: {
            module: 'claudeSseBridge',
            fallback: 'partial_result_after_max_turns',
            error: SDK_MAX_TURNS_SUBTYPE,
            message: localize(
              language,
              '分析达到轮次上限，结果可能不完整',
              'Analysis reached the turn limit; results may be incomplete',
            ),
            partial: true,
            terminationReason: MAX_TURNS_TERMINATION_REASON,
            turns: msg.num_turns,
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
        'frame-expert': localize(language, '帧渲染与掉帧诊断', 'Frame rendering and jank diagnosis'),
        'system-expert': localize(language, '系统级性能分析 (CPU/内存/Binder)', 'System performance analysis (CPU/memory/Binder)'),
        'startup-expert': localize(language, '应用启动分析', 'App startup analysis'),
      };
      // Match known agent names from the task description
      const agentName = Object.keys(descriptions).find(name => description.includes(name)) || description;
      const desc = descriptions[agentName] || description;
      // Track task_id → agent name for use in task_notification (completion)
      if (taskId) setBoundedTaskName(taskIdToAgentName, taskId, agentName);
      emit({
        type: 'sub_agent_started',
        content: {
          agentName,
          description: desc,
          message: localize(language, `委托子代理 [${agentName}]: ${desc}`, `Delegated to sub-agent [${agentName}]: ${desc}`),
        },
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
          message: localize(
            language,
            `子代理进度: ${description}${lastTool ? ` (${lastTool})` : ''}`,
            `Sub-agent progress: ${description}${lastTool ? ` (${lastTool})` : ''}`,
          ),
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
            message: localize(
              language,
              `子代理 [${agentName}] 完成证据收集${usage ? ` (${usage.tool_uses} 次工具调用, ${Math.round(usage.duration_ms / 1000)}s)` : ''}`,
              `Sub-agent [${agentName}] completed evidence collection${usage ? ` (${usage.tool_uses} tool calls, ${Math.round(usage.duration_ms / 1000)}s)` : ''}`,
            ),
          },
          timestamp: now,
        });
      } else {
        // Sub-agent failed or was stopped
        emit({
          type: 'progress',
          content: {
            phase: 'analyzing',
            message: localize(
              language,
              `子代理 [${agentName}] ${status}: ${summary}`,
              `Sub-agent [${agentName}] ${status}: ${summary}`,
            ),
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
          message: localize(
            language,
            '⚠ 对话历史已被自动压缩（上下文窗口接近上限），早期分析细节可能丢失',
            '⚠ Conversation history was auto-compacted because the context window is near its limit; early analysis details may be lost',
          ),
        },
        timestamp: now,
      });
      return;
    }

    // Catch-all for unhandled message types. SDK messages can contain prompts,
    // source snippets, and tool payloads, so log shape only — never values.
    const messageShape = Object.keys(msg as Record<string, unknown>)
      .sort()
      .join(',');
    const subtype = typeof msg.subtype === 'string' ? ` subtype=${msg.subtype}` : '';
    console.log(`[SSEBridge] Unhandled SDK message type=${msg.type}${subtype} keys=${messageShape}`);
  }

  return {
    handleMessage: handleSdkMessage,
    getAccumulatedAnswer: () => accumulatedAnswerText,
    flushPendingAnswer: () => {
      if (disposed) return;
      flushBufferAsAnswer();
      flushProjectedAnswer();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelBufferTimer();
      textBuffer = '';
      toolUseIdToName.clear();
      taskIdToAgentName.clear();
      textProjection?.flush();
    },
  };
}
