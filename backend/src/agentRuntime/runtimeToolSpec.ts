// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  tool as createClaudeSdkTool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {isPlaceholderToolString} from './toolArgPlaceholders';
import type {RunAuthorizationCheck} from './runAuthorizationFence';
import type { McpToolExposure } from '../types/sparkContracts';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {runtimeOutcomeFromError} from './runtimePerformance';
import {normalizeRuntimeToolResult, readRuntimeToolReceipt, runtimeToolReceiptMetadata} from './runtimeToolResult';
import {describeRuntimeToolFailure, describeRuntimeToolResultHandoff} from './runtimeToolResultAudit';
import {
  currentRunManifestAttributionSink,
  resolveRunManifestAttributionSink,
} from '../services/selfEvolution/runManifestLifecycle';
import {
  resolveRuntimeToolConcurrencyPolicy,
  type RuntimeToolConcurrencyCoordinator,
  type RuntimeToolConcurrencyPolicy,
  type RuntimeToolScheduling,
} from './runtimeToolConcurrency';

export type {
  RuntimeToolConcurrencyCoordinator,
  RuntimeToolConcurrencyPolicy,
  RuntimeToolScheduling,
} from './runtimeToolConcurrency';

type ClaudeSdkToolHandler = SdkMcpToolDefinition['handler'];
export type RuntimeToolResult = Awaited<ReturnType<ClaudeSdkToolHandler>>;
export type RuntimeToolAnnotations = NonNullable<SdkMcpToolDefinition['annotations']>;

export interface RuntimeToolExtra {
  runtime?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  runManifestAttributionSink?: RunManifestAttributionSink;
  runtimeToolScheduling?: RuntimeToolScheduling;
  [key: string]: unknown;
}

export function normalizeRuntimeToolExtra(extra: unknown): RuntimeToolExtra {
  return extra && typeof extra === 'object' ? extra as RuntimeToolExtra : {};
}

export type RuntimeToolHandler = (
  args: Record<string, unknown>,
  extra: RuntimeToolExtra,
) => Promise<RuntimeToolResult>;

/**
 * Evidence access is declared by the canonical registration, not inferred from
 * a tool name. `background` reads owner-selected background material (a
 * document knowledge base): it collects no trace evidence and produces no
 * capture, so an `existing_only` turn may call it, and it is never paced as an
 * acquisition.
 */
export type RuntimeToolEvidenceEffect = 'none' | 'read_existing' | 'background' | 'acquire';

export interface SharedToolSpec {
  name: string;
  description: string;
  exposure: McpToolExposure;
  inputSchema: z.ZodRawShape;
  handler: RuntimeToolHandler;
  summary?: string;
  requires?: string[];
  annotations?: RuntimeToolAnnotations;
  concurrency?: RuntimeToolConcurrencyPolicy;
  evidenceEffect?: RuntimeToolEvidenceEffect;
}

const TIMED_SHARED_TOOL_HANDLER = Symbol('TIMED_SHARED_TOOL_HANDLER');
const RUNTIME_TOOL_TIMING_SUPPRESSED_EXTRA_KEY = '__smartperfettoRuntimeToolTimingSuppressed';

type TimedRuntimeToolHandler = RuntimeToolHandler & {
  [TIMED_SHARED_TOOL_HANDLER]?: true;
};

type RuntimeToolTimingSinkResolution =
  | {kind: 'resolved'; sink: RunManifestAttributionSink}
  | {kind: 'none'}
  | {kind: 'suppressed'};

type RuntimeToolTimingSuppressedExtra = RuntimeToolExtra & {
  [RUNTIME_TOOL_TIMING_SUPPRESSED_EXTRA_KEY]?: true;
};

function hasSuppressedRuntimeToolTiming(normalizedExtra: RuntimeToolExtra): boolean {
  return (normalizedExtra as RuntimeToolTimingSuppressedExtra)[RUNTIME_TOOL_TIMING_SUPPRESSED_EXTRA_KEY] === true;
}

function resolveRuntimeToolTimingSink(
  normalizedExtra: RuntimeToolExtra,
): RuntimeToolTimingSinkResolution {
  if (hasSuppressedRuntimeToolTiming(normalizedExtra)) {
    return {kind: 'suppressed'};
  }
  try {
    const sink = resolveRunManifestAttributionSink(
      normalizedExtra.runManifestAttributionSink,
      currentRunManifestAttributionSink(),
    );
    return sink ? {kind: 'resolved', sink} : {kind: 'none'};
  } catch {
    return {kind: 'suppressed'};
  }
}

export interface ClaudeSdkToolLike {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: RuntimeToolAnnotations;
  handler: (args: Record<string, unknown>, extra: RuntimeToolExtra) => Promise<RuntimeToolResult>;
}

export const RUNTIME_TOOL_DESCRIPTION_MAX_CHARS = 1000;

function normalizeRuntimeToolDescription(description: string): string {
  return description
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitToolDescriptionExamples(description: string): { body: string; examples?: string } {
  const match = /\n\nExamples:\n/i.exec(description);
  if (!match) return { body: description };
  return {
    body: description.slice(0, match.index).trim(),
    examples: description.slice(match.index + match[0].length).trim(),
  };
}

function truncateAtWord(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  const lastSpace = clipped.lastIndexOf(' ');
  const cutPoint = lastSpace >= Math.floor(maxChars * 0.65) ? lastSpace : clipped.length;
  return `${clipped.slice(0, cutPoint).replace(/[.,;:!?]+$/, '')}...`;
}

function splitSentences(value: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (!'.!?。！？'.includes(char)) continue;

    const prev = value[i - 1] ?? '';
    const next = value[i + 1] ?? '';
    const asciiIdentifierBoundary = char === '.'
      && /[A-Za-z0-9_]/.test(prev)
      && /[A-Za-z0-9_]/.test(next);
    if (asciiIdentifierBoundary) continue;
    if (next && !/\s/.test(next)) continue;

    const sentence = value.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    while (i + 1 < value.length && /\s/.test(value[i + 1])) i++;
    start = i + 1;
  }

  const tail = value.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function truncateAtSentence(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const sentences = splitSentences(value);
  if (sentences.length >= 2) {
    const omission = ' … ';
    const head = [sentences[0]];
    const tail = [sentences[sentences.length - 1]];
    let left = 1;
    let right = sentences.length - 2;
    const render = () => [
      head.join(' '),
      ...(left <= right ? [omission.trim()] : []),
      tail.join(' '),
    ].filter(Boolean).join(' ');

    if (render().length <= maxChars) {
      while (left <= right) {
        let progressed = false;
        const nextHead = sentences[left];
        head.push(nextHead);
        if (render().length <= maxChars) {
          left++;
          progressed = true;
        } else {
          head.pop();
        }
        if (left <= right) {
          const nextTail = sentences[right];
          tail.unshift(nextTail);
          if (render().length <= maxChars) {
            right--;
            progressed = true;
          } else {
            tail.shift();
          }
        }
        if (!progressed) break;
      }
      return render();
    }
  }
  return truncateAtWord(value, maxChars);
}

function compactToolDescriptionParagraph(paragraph: string, maxChars: number): string {
  return truncateAtSentence(paragraph.replace(/\s*\n\s*/g, ' '), maxChars);
}

function isImportantToolDescriptionParagraph(paragraph: string): boolean {
  return /^(Use when:|Don't use when:|Always |SQL safety rules:|Response includes|Supports )/i.test(paragraph);
}

function paragraphBudget(paragraph: string, index: number): number {
  if (index === 0) return 240;
  if (/^SQL safety rules:/i.test(paragraph)) return 500;
  if (/^Don't use when:/i.test(paragraph)) return 220;
  if (/^Use when:/i.test(paragraph)) return 190;
  return 170;
}

function extractPlanExampleSignal(examples: string | undefined, body: string): string | undefined {
  if (!examples || /expectedCalls|expectedTools/.test(body)) return undefined;
  if (!/expectedCalls|expectedTools/.test(examples)) return undefined;
  return `Example shape: ${truncateAtWord(examples.replace(/\s+/g, ' '), 220)}`;
}

export function compactRuntimeToolDescription(description: string): string {
  const normalized = normalizeRuntimeToolDescription(description);
  const { body, examples } = splitToolDescriptionExamples(normalized);
  const exampleSignal = extractPlanExampleSignal(examples, body);
  const compactable = exampleSignal ? `${body}\n\n${exampleSignal}` : body;

  if (compactable.length <= RUNTIME_TOOL_DESCRIPTION_MAX_CHARS) {
    return compactable;
  }

  const paragraphs = compactable.split(/\n\n+/).filter(Boolean);
  const selected = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) => index === 0 || isImportantToolDescriptionParagraph(paragraph))
    .map(({ paragraph, index }) => compactToolDescriptionParagraph(paragraph, paragraphBudget(paragraph, index)));

  const compacted = selected.length > 0
    ? selected.join('\n')
    : compactToolDescriptionParagraph(compactable, RUNTIME_TOOL_DESCRIPTION_MAX_CHARS);
  return truncateAtWord(compacted, RUNTIME_TOOL_DESCRIPTION_MAX_CHARS);
}

export function compactSharedToolSpec(spec: SharedToolSpec): SharedToolSpec {
  const description = compactRuntimeToolDescription(spec.description);
  const timedSpec = withRuntimeToolTiming(spec);
  return description === timedSpec.description ? timedSpec : { ...timedSpec, description };
}

export function withRuntimeToolTiming(spec: SharedToolSpec): SharedToolSpec {
  const handler = spec.handler as TimedRuntimeToolHandler;
  if (handler[TIMED_SHARED_TOOL_HANDLER]) return spec;

  const timedHandler: TimedRuntimeToolHandler = async (args, extra) => {
    const normalizedExtra = normalizeRuntimeToolExtra(extra);
    const timingSinkResolution = resolveRuntimeToolTimingSink(normalizedExtra);
    const recorder = timingSinkResolution.kind === 'resolved'
      ? timingSinkResolution.sink.runtimePerformanceRecorder
      : undefined;
    const toolCallId = typeof normalizedExtra.toolCallId === 'string'
      && normalizedExtra.toolCallId.trim()
      ? normalizedExtra.toolCallId
      : undefined;
    const scheduling = normalizedExtra.runtimeToolScheduling;
    const effectivePolicy = scheduling?.policy
      ?? resolveRuntimeToolConcurrencyPolicy(spec.name, spec.concurrency).policy;
    let timing: ReturnType<NonNullable<typeof recorder>['startTool']> | undefined;
    try {
      timing = recorder?.startTool(
        toolCallId,
        effectivePolicy.mode,
        scheduling?.schedulerWaitMs ?? 0,
        scheduling?.fallbackReason,
      );
    } catch {
      timing = undefined;
    }
    try {
      const result = normalizeRuntimeToolResult(await handler(args, normalizedExtra));
      const outcome = normalizedExtra.signal?.aborted
        ? 'cancelled'
        : (result as {isError?: unknown} | undefined)?.isError === true
          ? 'error'
          : 'ok';
      try {
        timing?.end(outcome);
      } catch {
        // Runtime performance is internal observability only.
      }
      return result;
    } catch (error) {
      try {
        timing?.end(runtimeOutcomeFromError(error, normalizedExtra.signal));
      } catch {
        // Preserve the original tool failure.
      }
      throw error;
    }
  };
  timedHandler[TIMED_SHARED_TOOL_HANDLER] = true;
  return {...spec, handler: timedHandler};
}

export function withRuntimeToolConcurrency(
  spec: SharedToolSpec,
  coordinator: RuntimeToolConcurrencyCoordinator,
  options: {
    runManifestAttributionSink?: RunManifestAttributionSink;
  } = {},
): SharedToolSpec {
  const timedSpec = withRuntimeToolTiming(spec);
  const timedHandler = timedSpec.handler;
  const coordinatedHandler: TimedRuntimeToolHandler = async (args, extra) => {
    const normalizedExtra = normalizeRuntimeToolExtra(extra);
    const timingSinkResolution: RuntimeToolTimingSinkResolution = options.runManifestAttributionSink
      ? {kind: 'resolved', sink: options.runManifestAttributionSink}
      : resolveRuntimeToolTimingSink(normalizedExtra);
    const runManifestAttributionSink = timingSinkResolution.kind === 'resolved'
      ? timingSinkResolution.sink
      : undefined;
    // The outermost shared boundary: every product wrapper, including pacing
    // reminders, has already shaped the result the adapter receives.
    const auditRecorder = runManifestAttributionSink?.toolResultAuditRecorder;
    const toolCallId = normalizedExtra.toolCallId;
    try {
      const result = await coordinator.run({
        toolName: timedSpec.name,
        policy: timedSpec.concurrency,
        signal: normalizedExtra.signal,
        execute: scheduling => timedHandler(args, {
          ...normalizedExtra,
          ...(timingSinkResolution.kind === 'suppressed'
            ? {[RUNTIME_TOOL_TIMING_SUPPRESSED_EXTRA_KEY]: true}
            : {}),
          runManifestAttributionSink,
          runtimeToolScheduling: scheduling,
        }),
      });
      auditRecorder?.record(() => describeRuntimeToolResultHandoff(timedSpec.name, result, {
        toolCallId, cancelled: normalizedExtra.signal?.aborted === true,
      }));
      return result;
    } catch (error) {
      auditRecorder?.record(() => describeRuntimeToolFailure(timedSpec.name, {
        toolCallId, cancelled: runtimeOutcomeFromError(error, normalizedExtra.signal) === 'cancelled',
      }));
      throw error;
    }
  };
  coordinatedHandler[TIMED_SHARED_TOOL_HANDLER] = true;
  return {...timedSpec, handler: coordinatedHandler};
}

/**
 * The run's authorization around one tool call: checked before the call and
 * again after it, before its result reaches the runtime adapter. A revoked
 * authorization ends the run; the call fails only after that cancel settled,
 * whether the wrapper's check or the tool's own (a private-context check, an
 * index checkpoint) saw it, so a native loop cannot turn the failure into
 * another model request carrying this result or an earlier one. `settled`
 * resolves at once when nothing was revoked.
 */
export function withRuntimeToolAuthorization(
  spec: SharedToolSpec,
  authorization: Pick<RunAuthorizationCheck, 'assertCurrentInTurn' | 'settled'>,
): SharedToolSpec {
  // The pre-check produces no timing; the post-check runs after timing ended.
  const authorized = withRunAuthorizationOnly(withRuntimeToolTiming(spec), authorization);
  return {...spec, handler: authorized.handler};
}

/**
 * The run authorization fence alone: the pre-check, waiting for the revoke's
 * cancel to settle when the body fails, and the post-check. No timing receipt
 * and no performance sink, so product-owned work that is not a model tool call
 * (scene entry evidence) shares the fence without appearing as a tool.
 */
export function withRunAuthorizationOnly(
  spec: SharedToolSpec,
  authorization: Pick<RunAuthorizationCheck, 'assertCurrentInTurn' | 'settled'>,
): SharedToolSpec {
  const inner = spec.handler;
  const check = async () => {
    try {
      authorization.assertCurrentInTurn();
    } catch (error) {
      await authorization.settled();
      throw error;
    }
  };
  const handler: TimedRuntimeToolHandler = async (args, extra) => {
    await check();
    let result: Awaited<ReturnType<typeof inner>>;
    try {
      result = await inner(args, extra);
    } catch (error) {
      await authorization.settled();
      throw error;
    }
    await check();
    return result;
  };
  // Timed exactly when the wrapped body is: outer wrappers must neither re-time nor skip it.
  if ((inner as TimedRuntimeToolHandler)[TIMED_SHARED_TOOL_HANDLER]) handler[TIMED_SHARED_TOOL_HANDLER] = true;
  return {...spec, handler};
}

/** Both admission branches own one timing receipt, including already-timed SDK handlers. */
export function withRuntimeToolGuard(
  spec: SharedToolSpec,
  isAllowed: () => boolean,
  deniedHandler: RuntimeToolHandler,
): SharedToolSpec {
  const allowed = withRuntimeToolTiming(spec).handler;
  const denied = withRuntimeToolTiming({...spec, handler: deniedHandler}).handler;
  const handler: TimedRuntimeToolHandler = (args, extra) =>
    (isAllowed() ? allowed : denied)(args, extra);
  // Every branch above is timed; outer SDK/concurrency wrappers must not time it again.
  handler[TIMED_SHARED_TOOL_HANDLER] = true;
  return {...spec, handler};
}

export function isClaudeSdkToolLike(value: unknown): value is ClaudeSdkToolLike {
  const toolLike = value as Partial<ClaudeSdkToolLike>;
  return !!toolLike
    && typeof toolLike.name === 'string'
    && typeof toolLike.description === 'string'
    && !!toolLike.inputSchema
    && typeof toolLike.inputSchema === 'object'
    && typeof toolLike.handler === 'function';
}

export function sharedToolSpecFromClaudeSdkTool(
  name: string,
  sdkTool: unknown,
  exposure: McpToolExposure,
  extras: Pick<SharedToolSpec, 'summary' | 'requires' | 'concurrency' | 'evidenceEffect'> = {},
): SharedToolSpec {
  if (!isClaudeSdkToolLike(sdkTool)) {
    throw new Error(`Cannot build shared tool spec for ${name}: unsupported SDK descriptor shape`);
  }
  return withRuntimeToolTiming({
    name,
    description: sdkTool.description,
    exposure,
    inputSchema: sdkTool.inputSchema,
    handler: sdkTool.handler,
    annotations: sdkTool.annotations,
    ...extras,
  });
}

export function createClaudeSdkToolFromSharedSpec(
  spec: SharedToolSpec,
): SdkMcpToolDefinition {
  const timedSpec = withRuntimeToolTiming(spec);
  const handler: ClaudeSdkToolHandler & TimedRuntimeToolHandler = async (args, extra) => timedSpec.handler(
    args as Record<string, unknown>,
    normalizeRuntimeToolExtra(extra),
  );
  // SDK -> shared conversion may wrap this descriptor again; this bridge already delegates timing.
  handler[TIMED_SHARED_TOOL_HANDLER] = true;
  const sdkTool = createClaudeSdkTool(
    timedSpec.name,
    timedSpec.description,
    timedSpec.inputSchema,
    handler,
    timedSpec.annotations ? { annotations: timedSpec.annotations } : undefined,
  );
  return Object.assign(sdkTool, {
    inputSchema: timedSpec.inputSchema,
    annotations: timedSpec.annotations,
  });
}

/** Detect open `z.record(z.string(), z.any())` argument containers. */
function isOpenRecordAnySchema(entries: Array<[string, unknown]>): boolean {
  const record = Object.fromEntries(entries) as Record<string, unknown>;
  const additionalProperties = record.additionalProperties;
  return record.type === 'object'
    && (!('properties' in record) || Object.keys(record.properties as Record<string, unknown> || {}).length === 0)
    && !!additionalProperties
    && typeof additionalProperties === 'object'
    && !Array.isArray(additionalProperties)
    && Object.keys(additionalProperties as Record<string, unknown>).length === 0;
}

/** Remove Zod JSON Schema fragments that tool adapters do not accept or need. */
export function sanitizeToolJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolJsonSchema(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value);
  if (isOpenRecordAnySchema(entries)) {
    const description = (value as Record<string, unknown>).description;
    return {
      type: 'string',
      ...(typeof description === 'string'
        ? { description: `${description} Pass as a JSON object string.` }
        : { description: 'JSON object string.' }),
    };
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    if (key === '$schema' || key === 'propertyNames') {
      continue;
    }
    const sanitizedNested = sanitizeToolJsonSchema(nested);
    if (sanitizedNested !== undefined) {
      sanitized[key] = sanitizedNested;
    }
  }
  return sanitized;
}

export function createJsonSchemaFromZodRawShape(
  inputSchema: z.ZodRawShape,
): Record<string, unknown> {
  const zodObject = z.object(inputSchema);
  const jsonSchema = z.toJSONSchema(zodObject);
  return sanitizeToolJsonSchema(jsonSchema) as Record<string, unknown>;
}

function parseJsonContainerString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Strict tool schemas make a model fill every field, so an optional argument
 * it meant to omit arrives as `null` or a placeholder string. With the tool's
 * input shape, top-level optional fields holding one are dropped before the
 * handler sees them; required fields and nested values are left to the handler.
 */
function dropOptionalPlaceholders(
  args: Record<string, unknown>,
  inputSchema: z.ZodRawShape,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => {
    const field = inputSchema[key];
    if (!field || (value !== null && !isPlaceholderToolString(value))) return true;
    return !z.safeParse(field, undefined).success;
  }));
}

export function normalizeRuntimeToolArgs(
  value: unknown,
  inputSchema?: z.ZodRawShape,
): unknown {
  const normalized = normalizeRuntimeToolArgValue(value);
  return inputSchema && normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? dropOptionalPlaceholders(normalized as Record<string, unknown>, inputSchema)
    : normalized;
}

function normalizeRuntimeToolArgValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseJsonContainerString(value);
    return parsed === value ? value : normalizeRuntimeToolArgValue(parsed);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeToolArgValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeRuntimeToolArgValue(nested)]),
  );
}

export function stringifyRuntimeToolResult(result: unknown): string {
  const receipt = readRuntimeToolReceipt(result);
  if (receipt !== undefined) {
    const envelope = result as {content?: unknown; isError?: boolean};
    return JSON.stringify({
      _meta: runtimeToolReceiptMetadata(receipt),
      content: envelope.content,
      ...(envelope.isError === true ? {isError: true} : {}),
    });
  }
  const maybeResult = result as { content?: Array<Record<string, unknown>> };
  if (Array.isArray(maybeResult?.content)) {
    return maybeResult.content.map((block) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    }).join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}
