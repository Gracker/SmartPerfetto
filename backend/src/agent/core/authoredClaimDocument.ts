// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {types} from 'node:util';
import {CONCLUSION_AUTHORING_LIMITS, type AuthoringMaterial} from './conclusionAuthoring';
import {parseConclusionDeclarationPayload, type ConclusionContractDeclarationParseResult} from './conclusionContract';

export const AUTHORED_CLAIM_DOCUMENT_VERSION = 'authored_claim_document@1';

export interface AuthoredClaimTextOccurrence {
  partIndex: number;
  /** One-based position in the original, unfiltered claims array. */
  claimOrdinal: number;
  claimId: string;
  startUtf16: number;
  endUtf16: number;
}

export interface AuthoredClaimDocumentMaterial {
  rawInputUtf8Bytes: number;
  /** Compact JSON material, independently bounded before projection. */
  raw: AuthoringMaterial;
  /** Compact JSON material of the complete {body, contract} aggregate. */
  expanded: AuthoringMaterial;
  bodyUtf8Bytes: number;
  bodyUtf16Length: number;
}

export type AuthoredClaimDocumentFailure =
  | 'raw_input_bytes_exceeded' | 'invalid_json' | 'invalid_envelope' | 'unsupported_version'
  | 'raw_bytes_exceeded' | 'raw_nodes_exceeded' | 'raw_depth_exceeded'
  | 'invalid_body_part' | 'unknown_claim_id' | 'ambiguous_claim_id' | 'claim_text_unavailable'
  | 'expanded_bytes_exceeded' | 'expanded_nodes_exceeded' | 'expanded_depth_exceeded';

export type AuthoredClaimDocumentResult = {
  status: 'compiled';
  /** Private model input, not a public receipt or an issued capability. */
  privateRawDocument: string;
  body: string;
  rawCanonicalPayload: Record<string, unknown>;
  canonicalParse: ConclusionContractDeclarationParseResult;
  occurrences: AuthoredClaimTextOccurrence[];
  material: AuthoredClaimDocumentMaterial;
} | {
  status: 'projection_failed';
  code: AuthoredClaimDocumentFailure;
  privateRawDocument: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Measure the eventual string, retaining a high surrogate across part boundaries. */
class AuthoredStringMaterial {
  utf8Bytes = 0;
  jsonUtf8Bytes = 2; // JSON string quotes.
  private pendingHigh = false;

  append(value: string, limit: number): boolean {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (this.pendingHigh) {
        this.pendingHigh = false;
        if (code >= 0xdc00 && code <= 0xdfff) {
          this.utf8Bytes += 4;
          this.jsonUtf8Bytes += 4;
          if (this.jsonUtf8Bytes > limit) return false;
          continue;
        }
        this.utf8Bytes += 3; // Buffer UTF-8 replaces a lone surrogate.
        this.jsonUtf8Bytes += 6; // JSON.stringify preserves it as \uXXXX.
      }
      if (code >= 0xd800 && code <= 0xdbff) this.pendingHigh = true;
      else if (code >= 0xdc00 && code <= 0xdfff) {
        this.utf8Bytes += 3;
        this.jsonUtf8Bytes += 6;
      } else {
        const bytes = code < 128 ? 1 : code < 2048 ? 2 : 3;
        this.utf8Bytes += bytes;
        this.jsonUtf8Bytes += code === 34 || code === 92 ? 2
          : code < 32 ? ([8, 9, 10, 12, 13].includes(code) ? 2 : 6) : bytes;
      }
      if (this.jsonUtf8Bytes > limit) return false;
    }
    return this.jsonUtf8Bytes <= limit;
  }

  finish(limit: number): boolean {
    if (this.pendingHigh) {
      this.pendingHigh = false;
      this.utf8Bytes += 3;
      this.jsonUtf8Bytes += 6;
    }
    return this.jsonUtf8Bytes <= limit;
  }
}

/** Parsed JSON only: iterative preflight, without cloning or escaped-string allocation. */
export function measureAuthoredJson(root: unknown): AuthoringMaterial | 'bytes' | 'nodes' | 'depth' | 'non_json_value' {
  const material: AuthoringMaterial = {utf8Bytes: 0, nodes: 0, depth: 0};
  const stack: Array<{value: unknown; depth: number} | {leave: object}> = [{value: root, depth: 1}];
  const ancestors = new Set<object>();
  const addString = (value: string): boolean => {
    const meter = new AuthoredStringMaterial();
    const remaining = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - material.utf8Bytes;
    if (!meter.append(value, remaining) || !meter.finish(remaining)) return false;
    material.utf8Bytes += meter.jsonUtf8Bytes;
    return true;
  };
  while (stack.length) {
    const task = stack.pop()!;
    if ('leave' in task) {ancestors.delete(task.leave); continue;}
    const {value, depth} = task;
    if (types.isProxy(value)) return 'non_json_value';
    if (depth > CONCLUSION_AUTHORING_LIMITS.depth) return 'depth';
    if (++material.nodes > CONCLUSION_AUTHORING_LIMITS.nodes) return 'nodes';
    material.depth = Math.max(material.depth, depth);
    if (typeof value === 'string') {
      if (!addString(value)) return 'bytes';
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      // JSON.parse may produce Infinity. Count its serialized null but retain
      // the original value for canonical rejection; do not normalize it.
      material.utf8Bytes += JSON.stringify(value).length;
    } else {
      if (!object(value) && !Array.isArray(value)) return 'non_json_value';
      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return 'non_json_value';
      if (ancestors.has(value)) return 'non_json_value';
      ancestors.add(value); stack.push({leave: value});
      const keys = Reflect.ownKeys(value).filter(key => !array || key !== 'length');
      if (keys.length + material.nodes > CONCLUSION_AUTHORING_LIMITS.nodes ||
          array && value.length + material.nodes > CONCLUSION_AUTHORING_LIMITS.nodes) return 'nodes';
      if (array && keys.length !== value.length) return 'non_json_value';
      material.utf8Bytes += 2 + Math.max(0, keys.length - 1);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (typeof key !== 'string' || array && key !== String(index)) return 'non_json_value';
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !own(descriptor, 'value')) return 'non_json_value';
        if (!array) {if (!addString(key)) return 'bytes'; material.utf8Bytes++;}
        stack.push({value: descriptor.value, depth: depth + 1});
      }
    }
    if (material.utf8Bytes > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) return 'bytes';
  }
  return material;
}

export interface AuthoredBodyPartSpan {partIndex: number; startUtf16: number; endUtf16: number}

/** Assemble literal parts only after the caller bounded the complete input and contract. */
export function assembleAuthoredBody(rawClaims: unknown, bodyParts: readonly unknown[], bodyBudget: number) {
  const failed = (code: AuthoredClaimDocumentFailure) => ({status: 'projection_failed' as const, code});
  // Index raw IDs, including invalid items: a second occurrence is ambiguous
  // even if the canonical parser would reject or omit one of those claims.
  const claims = new Map<string, {ordinal: number; text: unknown} | null>();
  if (Array.isArray(rawClaims)) rawClaims.forEach((claim, index) => {
    if (!object(claim) || !own(claim, 'id') || typeof claim.id !== 'string') return;
    claims.set(claim.id, claims.has(claim.id) ? null : {ordinal: index + 1, text: own(claim, 'text') ? claim.text : undefined});
  });
  const bodyMaterial = new AuthoredStringMaterial();
  const chunks: string[] = [];
  const occurrences: AuthoredClaimTextOccurrence[] = [];
  const partSpans: AuthoredBodyPartSpan[] = [];
  let bodyUtf16Length = 0;
  for (let partIndex = 0; partIndex < bodyParts.length; partIndex++) {
    const part: unknown = bodyParts[partIndex];
    let text: string;
    if (typeof part === 'string') text = part;
    else {
      if (!object(part) || Object.keys(part).length !== 1 || !own(part, 'claimText') ||
          typeof part.claimText !== 'string' || part.claimText.length === 0) return failed('invalid_body_part');
      const claim = claims.get(part.claimText);
      if (claim === undefined) return failed('unknown_claim_id');
      if (claim === null) return failed('ambiguous_claim_id');
      if (typeof claim.text !== 'string') return failed('claim_text_unavailable');
      text = claim.text;
      occurrences.push({partIndex, claimOrdinal: claim.ordinal, claimId: part.claimText,
        startUtf16: bodyUtf16Length, endUtf16: bodyUtf16Length + text.length});
    }
    if (!bodyMaterial.append(text, bodyBudget)) return failed('expanded_bytes_exceeded');
    partSpans.push({partIndex, startUtf16: bodyUtf16Length, endUtf16: bodyUtf16Length + text.length});
    bodyUtf16Length += text.length;
    chunks.push(text);
  }
  if (!bodyMaterial.finish(bodyBudget)) return failed('expanded_bytes_exceeded');
  return {status: 'assembled' as const, body: chunks.join(''), occurrences, partSpans,
    bodyMaterial: {utf8Bytes: bodyMaterial.utf8Bytes, jsonUtf8Bytes: bodyMaterial.jsonUtf8Bytes}, bodyUtf16Length};
}

/**
 * Experimental pure representation compiler. It supplies neither evidence nor
 * native completion, and is not a carrier detector or a production entrypoint.
 */
export function compileAuthoredClaimDocument(documentJson: string): AuthoredClaimDocumentResult {
  const fail = (code: AuthoredClaimDocumentFailure): AuthoredClaimDocumentResult =>
    ({status: 'projection_failed', code, privateRawDocument: documentJson});
  // UTF-8 cannot be shorter than this input's UTF-16 code-unit length.
  if (documentJson.length > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) return fail('raw_input_bytes_exceeded');
  const rawInputUtf8Bytes = Buffer.byteLength(documentJson, 'utf8');
  if (rawInputUtf8Bytes > CONCLUSION_AUTHORING_LIMITS.utf8Bytes) return fail('raw_input_bytes_exceeded');
  let raw: unknown;
  try {raw = JSON.parse(documentJson);} catch {return fail('invalid_json');}
  const rawMaterial = measureAuthoredJson(raw);
  if (rawMaterial === 'non_json_value') return fail('invalid_envelope');
  if (typeof rawMaterial === 'string') return fail(`raw_${rawMaterial}_exceeded`);
  if (!object(raw) || Object.keys(raw).length !== 3 || !own(raw, 'representationVersion') ||
      !own(raw, 'contract') || !own(raw, 'bodyParts') || !object(raw.contract) || !Array.isArray(raw.bodyParts)) {
    return fail('invalid_envelope');
  }
  if (raw.representationVersion !== AUTHORED_CLAIM_DOCUMENT_VERSION) return fail('unsupported_version');

  const contractMaterial = measureAuthoredJson(raw.contract);
  if (contractMaterial === 'non_json_value') return fail('invalid_envelope');
  // Raw has already bounded this same tree. Keep the aggregate guard explicit.
  if (typeof contractMaterial === 'string') return fail(`expanded_${contractMaterial}_exceeded`);
  const expanded = {utf8Bytes: 0, nodes: contractMaterial.nodes + 2, depth: Math.max(2, contractMaterial.depth + 1)};
  if (expanded.nodes > CONCLUSION_AUTHORING_LIMITS.nodes) return fail('expanded_nodes_exceeded');
  if (expanded.depth > CONCLUSION_AUTHORING_LIMITS.depth) return fail('expanded_depth_exceeded');
  const aggregateOverhead = Buffer.byteLength('{"body":,"contract":}', 'utf8');
  const bodyBudget = CONCLUSION_AUTHORING_LIMITS.utf8Bytes - aggregateOverhead - contractMaterial.utf8Bytes;
  const assembled = assembleAuthoredBody(raw.contract.claims, raw.bodyParts, bodyBudget);
  if (assembled.status === 'projection_failed') return fail(assembled.code);
  const {body, occurrences, bodyMaterial, bodyUtf16Length} = assembled;
  expanded.utf8Bytes = aggregateOverhead + contractMaterial.utf8Bytes + bodyMaterial.jsonUtf8Bytes;
  // Only bounded references and offsets existed above; allocate the body and
  // invoke the existing parser after the complete aggregate passed preflight.
  return {status: 'compiled', privateRawDocument: documentJson, body, rawCanonicalPayload: raw.contract,
    canonicalParse: parseConclusionDeclarationPayload(raw.contract, 'canonical_v1'), occurrences,
    material: {rawInputUtf8Bytes, raw: rawMaterial, expanded, bodyUtf8Bytes: bodyMaterial.utf8Bytes, bodyUtf16Length}};
}
