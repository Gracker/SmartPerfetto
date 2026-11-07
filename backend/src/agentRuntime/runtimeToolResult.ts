// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Facts owned by a completed tool invocation, independent of its presentation. */
export interface RuntimeToolResultFacts {
  success?: boolean;
  planPhaseId?: string;
}

export const TOOL_RESULT_RECEIPT_KEY = 'smartperfetto/tool-result';
const RECEIPT_VERSION = 'tool_result_v1';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

/** Decode only an exact JSON envelope, never extract one from explanation text. */
export function readRuntimeToolEnvelope(value: unknown): JsonObject | undefined {
  for (let depth = 0; depth < 8 && typeof value === 'string'; depth += 1) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return asObject(value);
}

function pickFacts(value: JsonObject): RuntimeToolResultFacts {
  const planPhaseId = typeof value.planPhaseId === 'string' ? value.planPhaseId.trim() : '';
  return {
    ...(typeof value.success === 'boolean' ? {success: value.success} : {}),
    ...(planPhaseId ? {planPhaseId} : {}),
  };
}

/** Deliberately projects only this version's fields, never arbitrary MCP metadata. */
export function readRuntimeToolReceipt(value: unknown): RuntimeToolResultFacts | undefined {
  const receipt = asObject(asObject(asObject(value)?._meta)?.[TOOL_RESULT_RECEIPT_KEY]);
  return receipt?.schemaVersion === RECEIPT_VERSION ? pickFacts(receipt) : undefined;
}

export function runtimeToolReceiptMetadata(facts: RuntimeToolResultFacts): JsonObject {
  return {[TOOL_RESULT_RECEIPT_KEY]: {schemaVersion: RECEIPT_VERSION, ...pickFacts({...facts})}};
}

function payloadFacts(body: JsonObject | undefined): RuntimeToolResultFacts {
  if (!body) return {};
  const facts = pickFacts(body);
  if (body.isError === true) return {...facts, success: false};
  if (facts.success !== undefined) return facts;
  switch (body.outcome) {
    case 'success': return {...facts, success: true};
    case 'rejected':
    case 'budget_exceeded':
    case 'consent_blocked':
    case 'license_blocked':
    case 'unresolved':
    case 'sidecar_missing': return {...facts, success: false};
    default: return facts;
  }
}

/**
 * Compatibility for old JSON-first results with trailing guidance. Arbitrary
 * prose containing JSON is not a tool protocol. Multiple valid containers are
 * ambiguous. New producers supply structuredContent before adding any prose.
 */
function parseLegacyJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* guidance can surround old payloads */ }
  if (text[0] !== '{' && text[0] !== '[') return undefined;
  let candidate: unknown;
  let found = false;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let closed = false;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) {
          if (!found) return undefined;
          start = end;
          closed = true;
          break;
        }
        if (stack.length === 0) {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, end + 1));
            if (found) return undefined;
            candidate = parsed;
            found = true;
          } catch {
            if (!found) return undefined;
          }
          start = end;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break;
  }
  return candidate;
}

export interface DecodedRuntimeToolResult {
  body?: JsonObject;
  /** Undefined means legacy; an empty object is an authoritative unknown receipt. */
  receipt?: RuntimeToolResultFacts;
  isError?: boolean;
}

/** Common MCP/SDK decoding. Bounded recursion also rejects cyclic wrappers. */
export function decodeRuntimeToolResult(value: unknown, depth = 0): DecodedRuntimeToolResult {
  if (depth > 8 || value == null) return {};
  if (typeof value === 'string') {
    const parsed = parseLegacyJson(value.trim());
    return parsed === undefined ? {} : decodeRuntimeToolResult(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    const blocks = value.filter(entry => {
      const block = asObject(entry);
      return (block?.type === 'text' || block?.type === 'input_text') && typeof block.text === 'string';
    });
    if (blocks.length === 0) return {body: {items: value}};
    const decoded = blocks.map(block => decodeRuntimeToolResult(block.text, depth + 1))
      .filter(result => result.body !== undefined || result.receipt !== undefined || result.isError);
    return decoded.length === 1 ? decoded[0] : {};
  }
  const record = asObject(value);
  if (!record) return {};
  const receipt = readRuntimeToolReceipt(record);
  const structured = asObject(record.structuredContent);
  let result: DecodedRuntimeToolResult;
  if (structured) result = {body: structured};
  // Pi keeps the original MCP result in details and may shorten content.
  else if (record.content !== undefined && asObject(record.details)) {
    result = decodeRuntimeToolResult(record.details, depth + 1);
  } else if (record.content !== undefined) result = decodeRuntimeToolResult(record.content, depth + 1);
  else if ((record.type === 'text' || record.type === 'input_text') && typeof record.text === 'string') {
    result = decodeRuntimeToolResult(record.text, depth + 1);
  } else result = {body: record};
  return {
    ...result,
    ...(receipt === undefined ? {} : {receipt}),
    ...(record.isError === true ? {isError: true} : {}),
  };
}

export function readRuntimeToolResultFacts(value: unknown): RuntimeToolResultFacts {
  const decoded = decodeRuntimeToolResult(value);
  const facts = decoded.receipt ?? payloadFacts(decoded.body);
  return decoded.isError === true || decoded.body?.isError === true ? {...facts, success: false} : facts;
}

/** A structured refusal is distinct from a malfunction; prose grants no classification. */
export function isPolicyRefusalResult(result: unknown): boolean {
  const body = decodeRuntimeToolResult(result).body;
  return readRuntimeToolResultFacts(result).success === false &&
    typeof body?.action_required === 'string' && body.action_required.trim().length > 0;
}

/** Construct facts before any notes, watchdog warnings, or transport truncation. */
export function createRuntimeToolResult(
  payload: JsonObject,
  options: {
    facts?: RuntimeToolResultFacts;
    isError?: boolean;
    decorate?: (text: string) => string;
  } = {},
) {
  const facts = options.facts === undefined ? payloadFacts(payload) : pickFacts({...options.facts});
  const effectiveFacts = options.isError === true ? {...facts, success: false} : facts;
  const text = JSON.stringify(payload);
  return {
    _meta: runtimeToolReceiptMetadata(effectiveFacts),
    structuredContent: payload,
    content: [{type: 'text' as const, text: options.decorate ? options.decorate(text) : text}],
    ...(options.isError === true ? {isError: true} : {}),
  };
}

/** Preserve legacy results with no facts; normalize known results once at the shared boundary. */
export function normalizeRuntimeToolResult<T extends {content: unknown}>(result: T): T {
  if (readRuntimeToolReceipt(result) !== undefined) return result;
  const decoded = decodeRuntimeToolResult(result);
  const facts = readRuntimeToolResultFacts(result);
  if (Object.keys(facts).length === 0) return result;
  return {
    ...result,
    ...(decoded.body ? {structuredContent: decoded.body} : {}),
    _meta: {...asObject(asObject(result)?._meta), ...runtimeToolReceiptMetadata(facts)},
  };
}
