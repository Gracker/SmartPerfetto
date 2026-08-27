// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  tool as createClaudeSdkTool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolExposure } from '../types/sparkContracts';

type ClaudeSdkToolHandler = SdkMcpToolDefinition['handler'];
export type RuntimeToolResult = Awaited<ReturnType<ClaudeSdkToolHandler>>;
export type RuntimeToolAnnotations = NonNullable<SdkMcpToolDefinition['annotations']>;

export interface RuntimeToolExtra {
  runtime?: string;
  toolCallId?: string;
  signal?: AbortSignal;
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
  return description === spec.description ? spec : { ...spec, description };
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
  extras: Pick<SharedToolSpec, 'summary' | 'requires'> = {},
): SharedToolSpec {
  if (!isClaudeSdkToolLike(sdkTool)) {
    throw new Error(`Cannot build shared tool spec for ${name}: unsupported SDK descriptor shape`);
  }
  return {
    name,
    description: sdkTool.description,
    exposure,
    inputSchema: sdkTool.inputSchema,
    handler: sdkTool.handler,
    annotations: sdkTool.annotations,
    ...extras,
  };
}

export function createClaudeSdkToolFromSharedSpec(
  spec: SharedToolSpec,
): SdkMcpToolDefinition {
  const sdkTool = createClaudeSdkTool(
    spec.name,
    spec.description,
    spec.inputSchema,
    async (args, extra) => spec.handler(
      args as Record<string, unknown>,
      normalizeRuntimeToolExtra(extra),
    ),
    spec.annotations ? { annotations: spec.annotations } : undefined,
  );
  return Object.assign(sdkTool, {
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
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
