// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  tool as createClaudeSdkTool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolExposure } from '../types/sparkContracts';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {runtimeOutcomeFromError} from './runtimePerformance';
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
  RuntimeToolConcurrencyMode,
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

export const RUNTIME_TOOL_DESCRIPTION_MAX_CHARS = 1100;

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
  let output = '';
  for (const sentence of sentences) {
    const normalized = sentence.trim();
    if (!normalized) continue;
    const candidate = output ? `${output} ${normalized}` : normalized;
    if (candidate.length > maxChars) break;
    output = candidate;
  }
  return output.length >= Math.min(90, Math.floor(maxChars * 0.4))
    ? output
    : truncateAtWord(value, maxChars);
}

function compactToolDescriptionParagraph(paragraph: string, maxChars: number): string {
  return truncateAtSentence(paragraph.replace(/\s*\n\s*/g, ' '), maxChars);
}

function isImportantToolDescriptionParagraph(paragraph: string): boolean {
  return /^(Use when:|Don't use when:|Always |SQL safety rules:|Response includes|Supports )/i.test(paragraph);
}

function paragraphBudget(paragraph: string, index: number): number {
  if (index === 0) return 240;
  if (/^SQL safety rules:/i.test(paragraph)) return 360;
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
      const result = await handler(args, normalizedExtra);
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
    return coordinator.run({
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
  };
  coordinatedHandler[TIMED_SHARED_TOOL_HANDLER] = true;
  return {...timedSpec, handler: coordinatedHandler};
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
  extras: Pick<SharedToolSpec, 'summary' | 'requires' | 'concurrency'> = {},
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
  const sdkTool = createClaudeSdkTool(
    timedSpec.name,
    timedSpec.description,
    timedSpec.inputSchema,
    async (args, extra) => {
      const normalizedExtra = normalizeRuntimeToolExtra(extra);
      return timedSpec.handler(
        args as Record<string, unknown>,
        normalizedExtra,
      );
    },
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

export function normalizeRuntimeToolArgs(value: unknown): unknown {
  if (typeof value === 'string') {
    const parsed = parseJsonContainerString(value);
    return parsed === value ? value : normalizeRuntimeToolArgs(parsed);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeRuntimeToolArgs(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeRuntimeToolArgs(nested)]),
  );
}

export function stringifyRuntimeToolResult(result: unknown): string {
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
