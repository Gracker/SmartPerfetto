// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {immutableCanonicalSnapshot} from '../services/selfEvolution/canonicalJson';
import {isPlainObject} from '../utils/llmJson';
import {readRuntimeToolReceipt} from './runtimeToolResult';

/**
 * Top-level payload fields the product attaches to steer or qualify the
 * model's reading of a tool result. A producer that adds such a field adds it
 * here too, so its delivery stays auditable. Presence only; values are never
 * copied, except the registry vendor id of `vendorOverride`.
 */
export const RUNTIME_TOOL_RESULT_AUDITED_FIELDS = [
  'action_required',
  'drillDownResolution',
  'error',
  'identity',
  'identityResolution',
  'partial',
  'scopeLimitations',
  'vendorOverride',
] as const;
export type RuntimeToolResultAuditedField = typeof RUNTIME_TOOL_RESULT_AUDITED_FIELDS[number];

/**
 * `verbatim`: the field's serialized key and value appear unchanged in a text
 * block handed to the runtime. `unproven` does not mean the model missed it
 * (pretty-printed legacy text fails the check too); it only means this check
 * cannot show it was there.
 */
export type RuntimeToolResultFieldVisibility = 'verbatim' | 'unproven' | 'not_checked';

/**
 * What one tool call handed to its runtime adapter for the model, recorded at
 * the outermost shared tool boundary, after every product wrapper (including
 * pacing reminders) and before any transport truncation. It describes the
 * handoff, not what a provider tokenized: runtime-native output caps are
 * outside the product's view, so `content.chars` is what an auditor compares
 * against them. `returned` means the adapter received the result; an adapter
 * may still discard it, e.g. OpenCode after its bridge closed.
 */
export interface RuntimeToolResultAuditEntryV1 {
  toolName: string;
  /** Runtime tool-call id when the adapter supplied one; joins the SSE `taskId`. */
  toolCallId?: string;
  skillId?: string;
  outcome: 'returned' | 'cancelled' | 'threw';
  isError?: true;
  /**
   * Product receipt facts. The plan phase id is model-authored, so only its
   * presence is kept. Their model visibility depends on the runtime adapter.
   */
  facts?: {success?: boolean; planPhaseIdPresent?: true};
  content?: {textBlocks: number; otherBlocks: number; chars: number; bytes: number};
  payloadFields?: Partial<Record<RuntimeToolResultAuditedField, RuntimeToolResultFieldVisibility>>;
  vendorOverride?: {vendor?: string; additionalStepCount: number};
}

export interface RuntimeToolResultAuditReceiptV1 {
  schemaVersion: 1;
  /** In completion order. */
  results: RuntimeToolResultAuditEntryV1[];
  /** Entries dropped after the cap or because they could not be recorded. */
  truncated?: number;
}

const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Registry skill/vendor ids and adapter tool-call ids. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Above this, scanning the text for each field is not worth its cost. */
const MAX_VISIBILITY_CHECK_CHARS = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function describeFacts(result: unknown): RuntimeToolResultAuditEntryV1['facts'] {
  const receipt = readRuntimeToolReceipt(result);
  if (!receipt) return undefined;
  const facts = {
    ...(receipt.success !== undefined ? {success: receipt.success} : {}),
    ...(receipt.planPhaseId !== undefined ? {planPhaseIdPresent: true as const} : {}),
  };
  return Object.keys(facts).length > 0 ? facts : undefined;
}

interface HandedOffText {
  texts: string[];
  otherBlocks: number;
  chars: number;
  bytes: number;
  checkable: boolean;
}

function handedOffText(result: Record<string, unknown>): HandedOffText {
  const blocks = typeof result.content === 'string'
    ? [{type: 'text', text: result.content}]
    : Array.isArray(result.content) ? result.content : [];
  const handed: HandedOffText = {texts: [], otherBlocks: 0, chars: 0, bytes: 0, checkable: true};
  for (const block of blocks) {
    if (isPlainObject(block) && typeof block.text === 'string' && (block.type === 'text' || block.type === 'input_text')) {
      handed.texts.push(block.text);
      handed.chars += block.text.length;
      handed.bytes += Buffer.byteLength(block.text, 'utf8');
      if (block.text.length > MAX_VISIBILITY_CHECK_CHARS) handed.checkable = false;
    } else {
      handed.otherBlocks += 1;
    }
  }
  return handed;
}

function fieldVisibility(field: string, value: unknown, text: HandedOffText): RuntimeToolResultFieldVisibility {
  if (!text.checkable) return 'not_checked';
  let needle: string;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 'not_checked';
    needle = `${JSON.stringify(field)}:${serialized}`;
  } catch {
    return 'not_checked';
  }
  return text.texts.some(block => block.includes(needle)) ? 'verbatim' : 'unproven';
}

function describeVendorOverride(value: unknown): RuntimeToolResultAuditEntryV1['vendorOverride'] {
  if (!isPlainObject(value)) return undefined;
  const vendor = safeId(value.vendor);
  return {
    ...(vendor ? {vendor} : {}),
    additionalStepCount: Array.isArray(value.additionalStepIds) ? value.additionalStepIds.length : 0,
  };
}

function baseEntry(
  toolName: string,
  outcome: RuntimeToolResultAuditEntryV1['outcome'],
  toolCallId: unknown,
): RuntimeToolResultAuditEntryV1 {
  const callId = safeId(toolCallId);
  return {
    toolName: SAFE_TOOL_NAME.test(toolName) ? toolName : 'unrecorded_tool_name',
    ...(callId ? {toolCallId: callId} : {}),
    outcome,
  };
}

/** Describe the result an adapter received; never throws and copies no payload values. */
export function describeRuntimeToolResultHandoff(
  toolName: string,
  result: unknown,
  options: {toolCallId?: unknown; cancelled?: boolean} = {},
): RuntimeToolResultAuditEntryV1 {
  const entry = baseEntry(toolName, options.cancelled ? 'cancelled' : 'returned', options.toolCallId);
  try {
    if (!isPlainObject(result)) return entry;
    const payload = isPlainObject(result.structuredContent) ? result.structuredContent : undefined;
    const skillId = safeId(payload?.skillId);
    const facts = describeFacts(result);
    const text = handedOffText(result);
    const payloadFields: RuntimeToolResultAuditEntryV1['payloadFields'] = {};
    for (const field of RUNTIME_TOOL_RESULT_AUDITED_FIELDS) {
      if (payload?.[field] !== undefined) payloadFields[field] = fieldVisibility(field, payload[field], text);
    }
    const vendorOverride = describeVendorOverride(payload?.vendorOverride);
    return {
      ...entry,
      ...(skillId ? {skillId} : {}),
      ...(result.isError === true ? {isError: true as const} : {}),
      ...(facts ? {facts} : {}),
      content: {textBlocks: text.texts.length, otherBlocks: text.otherBlocks, chars: text.chars, bytes: text.bytes},
      ...(Object.keys(payloadFields).length > 0 ? {payloadFields} : {}),
      ...(vendorOverride ? {vendorOverride} : {}),
    };
  } catch {
    return entry;
  }
}

export function describeRuntimeToolFailure(
  toolName: string,
  options: {toolCallId?: unknown; cancelled?: boolean} = {},
): RuntimeToolResultAuditEntryV1 {
  return baseEntry(toolName, options.cancelled ? 'cancelled' : 'threw', options.toolCallId);
}

/** Drop identifiers a private run must not write to a durable owner artifact. */
export function projectToolResultAuditForPrivateRun(
  receipt: RuntimeToolResultAuditReceiptV1,
): RuntimeToolResultAuditReceiptV1 {
  return {
    ...receipt,
    results: receipt.results.map(({skillId: _skillId, ...entry}) => entry),
  };
}

/**
 * Bounded, append-only and run-scoped. An entry is described only when it
 * will be kept, and canonicalized when recorded, so sealing cannot fail;
 * recording after `seal` is ignored. Never throws into the tool call.
 */
export class RuntimeToolResultAuditRecorder {
  private readonly entries: RuntimeToolResultAuditEntryV1[] = [];
  private dropped = 0;
  private sealedReceipt: RuntimeToolResultAuditReceiptV1 | undefined;

  get hasRecordedData(): boolean {
    return this.entries.length > 0 || this.dropped > 0;
  }

  record(describe: () => RuntimeToolResultAuditEntryV1): void {
    if (this.sealedReceipt) return;
    if (this.entries.length >= MAX_ENTRIES) {
      this.dropped += 1;
      return;
    }
    try {
      this.entries.push(immutableCanonicalSnapshot(describe()));
    } catch {
      this.dropped += 1;
    }
  }

  seal(): RuntimeToolResultAuditReceiptV1 {
    this.sealedReceipt ??= Object.freeze({
      schemaVersion: 1 as const,
      results: Object.freeze([...this.entries]) as RuntimeToolResultAuditEntryV1[],
      ...(this.dropped > 0 ? {truncated: this.dropped} : {}),
    });
    return this.sealedReceipt;
  }
}
