// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { redactTextForLLM } from './llmPrivacy';

export const LLM_JSON_PARSER_VERSION = '1.0.0';

export interface LlmJsonSchema<T> {
  name: string;
  validate: (value: unknown) => value is T;
}

class LlmJsonError extends Error {
  readonly parserVersion = LLM_JSON_PARSER_VERSION;
  constructor(message: string) {
    super(message);
    this.name = 'LlmJsonError';
  }
}

export class LlmJsonParseError extends LlmJsonError {
  constructor(message: string) {
    super(message);
    this.name = 'LlmJsonParseError';
  }
}

export class LlmJsonSchemaError extends LlmJsonError {
  constructor(schemaName: string, message: string) {
    super(`[${schemaName}] ${message}`);
    this.name = 'LlmJsonSchemaError';
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function stripOuterMarkdownCodeFence(text: string): string {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;

  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline < 0) return trimmed;

  const closing = trimmed.lastIndexOf('```');
  if (closing <= firstNewline) return trimmed;

  return trimmed.slice(firstNewline + 1, closing).trim();
}

/**
 * Extract the first JSON object/array substring from a (possibly messy) LLM response.
 * Uses a small state machine to handle nested braces/brackets and quoted strings.
 */
export function extractFirstJsonValue(text: string): string | null {
  const input = (text || '').trim();
  if (!input) return null;

  const startObj = input.indexOf('{');
  const startArr = input.indexOf('[');

  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = startObj >= 0 ? startObj : startArr;

  if (start < 0) return null;

  const stack: Array<'}' | ']'> = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      stack.push('}');
      continue;
    }
    if (ch === '[') {
      stack.push(']');
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null;
      const expected = stack[stack.length - 1];
      if (ch !== expected) return null;
      stack.pop();
      if (stack.length === 0) {
        return input.slice(start, i + 1).trim();
      }
    }
  }

  return null;
}

export function parseLlmJson<T = unknown>(text: string, schema?: LlmJsonSchema<T>): T {
  const raw = stripOuterMarkdownCodeFence(text);
  const trimmed = (raw || '').trim();
  if (!trimmed) throw new LlmJsonParseError('Empty LLM response');

  const candidate = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? trimmed
    : extractFirstJsonValue(trimmed);

  if (!candidate) {
    const safeSnippet = redactTextForLLM(trimmed.slice(0, 200)).text;
    throw new LlmJsonParseError(
      `No JSON object/array found in LLM response (len=${trimmed.length}, head="${safeSnippet}")`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error: any) {
    throw new LlmJsonParseError(`Invalid JSON (candidateLen=${candidate.length}): ${error.message}`);
  }

  if (schema && !schema.validate(parsed)) {
    throw new LlmJsonSchemaError(schema.name, 'JSON matched but schema validation failed');
  }

  return parsed as T;
}

