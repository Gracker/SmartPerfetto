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

// Transport-only sidecar. The quote context, not this carrier, recognizes issued tokens.
interface QuoteCarrier {token: object; payload: object; payloadText: string;
  content: object; block: object; text: string; metadata: object; receipt: object;
  receiptFields: ReadonlyArray<readonly [string, unknown]>; isError: unknown}
const quoteProjections = new WeakMap<object, QuoteCarrier>();
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function unchangedQuoteCarrier(value: unknown): QuoteCarrier | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = quoteProjections.get(value);
  if (!state || ownData(value, 'structuredContent') !== state.payload || ownData(value, 'isError') !== state.isError) return undefined;
  const errorField = Object.getOwnPropertyDescriptor(value, 'isError');
  if (state.isError === undefined ? errorField !== undefined : !errorField || !('value' in errorField)) return undefined;
  const content = ownData(value, 'content'), metadata = ownData(value, '_meta');
  if (content !== state.content || metadata !== state.metadata || Object.getPrototypeOf(state.content) !== Array.prototype ||
      [state.block, state.metadata, state.receipt].some(item => Object.getPrototypeOf(item) !== Object.prototype) ||
      ownData(state.content, 'length') !== 1 ||
      Reflect.ownKeys(state.content).length !== 2 || ownData(state.content, '0') !== state.block ||
      Reflect.ownKeys(state.block).length !== 2 || ownData(state.block, 'type') !== 'text' || ownData(state.block, 'text') !== state.text ||
      Reflect.ownKeys(state.metadata).length !== 1 || ownData(state.metadata, TOOL_RESULT_RECEIPT_KEY) !== state.receipt ||
      Reflect.ownKeys(state.receipt).length !== state.receiptFields.length ||
      !state.receiptFields.every(([key, expected]) => Object.is(ownData(state.receipt, key), expected))) return undefined;
  return state;
}
export function readRuntimeToolQuoteProjection(value: unknown): object | undefined {return unchangedQuoteCarrier(value)?.token;}
/** Actual JSON already serialized by this carrier, not a backing-store/raw-evidence reader. */
export function readRuntimeToolQuotePayload(value: unknown): string | undefined {return unchangedQuoteCarrier(value)?.payloadText;}

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
    /** Opaque carrier only. A forged object never becomes issued quote authority. */
    quoteProjection?: object;
  } = {},
) {
  const facts = options.facts === undefined ? payloadFacts(payload) : pickFacts({...options.facts});
  const effectiveFacts = options.isError === true ? {...facts, success: false} : facts;
  const text = JSON.stringify(payload);
  const result = {
    _meta: runtimeToolReceiptMetadata(effectiveFacts),
    structuredContent: payload,
    content: [{type: 'text' as const, text: options.decorate ? options.decorate(text) : text}],
    ...(options.isError === true ? {isError: true} : {}),
  };
  if (options.quoteProjection && typeof options.quoteProjection === 'object') {
    const decorated = result.content[0].text;
    const offset = decorated.indexOf(text);
    if (offset >= 0 && decorated.indexOf(text, offset + text.length) < 0) {
      const receipt = result._meta[TOOL_RESULT_RECEIPT_KEY] as JsonObject;
      quoteProjections.set(result, {token: options.quoteProjection, payload, payloadText: text,
        content: result.content, block: result.content[0], text: decorated, metadata: result._meta, receipt,
        receiptFields: Object.freeze(Object.entries(receipt).map(entry => Object.freeze(entry))), isError: result.isError});
    }
  }
  return result;
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
