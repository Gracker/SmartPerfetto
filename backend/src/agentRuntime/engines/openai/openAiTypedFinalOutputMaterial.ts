// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {CONCLUSION_PROTOCOL_VALUES} from '../../../agent/core/conclusionContract';
import {TYPED_OUTPUT_MATERIAL_LIMITS as LIMITS, TYPED_OUTPUT_WIRE_FINISH_REASONS,
  type RuntimeTypedOutputCollection, type RuntimeTypedOutputDecoded, type RuntimeTypedOutputMaterial,
  type RuntimeTypedOutputPartition, type RuntimeTypedOutputRetention,
  type RuntimeTypedOutputStructure} from '../../typedOutputMaterial';

/** Candidate-only schema facts are injected; this observer also runs without the native compiler. */
export interface OpenAiTypedFinalMaterialProvider {
  readonly representationVersion: 'authored_claim_document@2';
  readonly rootKeys: readonly string[];
  readonly contractKeys: readonly string[];
  measure(value: unknown): {utf8Bytes: number; nodes: number; depth: number} | 'bytes' | 'nodes' | 'depth' | 'non_json_value';
}
export interface OpenAiTypedFinalMaterialOptions {
  readonly finalToolName?: string;
  readonly knownToolNames?: readonly string[];
  readonly materialProvider?: OpenAiTypedFinalMaterialProvider;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const high = (value: number) => value >= 0xd800 && value <= 0xdbff;
const low = (value: number) => value >= 0xdc00 && value <= 0xdfff;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

/** A pending high surrogate belongs to one decoded string, never to the next tool. */
interface Tail {high: boolean}
class Counter {
  seen = false;
  private utf8 = 0;
  private utf16 = 0;
  private utf8Exact = true;
  private utf16Exact = true;
  uncertain() {this.utf8Exact = false; this.utf16Exact = false;}
  append(fragment: string, tail?: Tail) {
    this.seen = true;
    this.utf16 += fragment.length;
    if (this.utf16 > LIMITS.decodedUtf16Chars) {
      this.utf16 = LIMITS.decodedUtf16Chars + 1; this.utf16Exact = false;
    }
    if (!tail) {
      // UTF-16 length is a safe UTF-8 lower bound even if the unknown call's
      // previous fragment ended in a high surrogate. Buffer.byteLength is not.
      this.utf8 += fragment.length; this.utf8Exact = false;
    } else if (fragment.length) {
      let start = 0, end = fragment.length;
      if (tail.high) {this.utf8 += low(fragment.charCodeAt(0)) ? 4 : 3; if (low(fragment.charCodeAt(0))) start = 1;}
      tail.high = end > start && high(fragment.charCodeAt(end - 1));
      if (tail.high) end--;
      this.utf8 += Buffer.byteLength(fragment.slice(start, end));
    }
    if (this.utf8 > LIMITS.decodedUtf8Bytes) {
      this.utf8 = LIMITS.decodedUtf8Bytes + 1; this.utf8Exact = false;
    }
  }
  snapshot(pendingHigh = 0): RuntimeTypedOutputDecoded {
    const total = this.utf8 + pendingHigh * 3;
    return {utf8Bytes: Math.min(total, LIMITS.decodedUtf8Bytes + 1), utf16Chars: this.utf16,
      utf8Precision: this.utf8Exact && total <= LIMITS.decodedUtf8Bytes ? 'exact' : 'lower_bound',
      utf16Precision: this.utf16Exact ? 'exact' : 'lower_bound'};
  }
}
interface Call extends Tail {id?: string; name: string; initial: boolean}
const collection = (value: Record<string, unknown>, key: string): RuntimeTypedOutputCollection =>
  !own(value, key) ? {status: 'missing'} : value[key] === null ? {status: 'null'} :
    Array.isArray(value[key]) ? {status: 'array', items: value[key].length} : {status: 'wrong_type'};

function structure(outer: Record<string, unknown>, document: Record<string, unknown>,
  provider: OpenAiTypedFinalMaterialProvider): RuntimeTypedOutputStructure {
  const measured = provider.measure(document);
  if (typeof measured === 'string') return {status: measured === 'non_json_value' ? 'unsupported_shape' : 'resource_limit'};
  const contract = document.contract;
  if (!record(contract)) return {status: 'unsupported_shape'};
  const collections = {referenceDictionary: collection(document, 'referenceDictionary'),
    semanticFrames: collection(document, 'semanticFrames'), claims: collection(contract, 'claims'),
    bodyParts: collection(document, 'bodyParts'), relationProposals: collection(contract, 'relationProposals'),
    sourceClaimBindings: collection(contract, 'sourceClaimBindings')};
  let explicitNullCount = 0;
  const visit = (value: unknown) => {
    if (value === null) explicitNullCount++;
    else if (typeof value === 'object') for (const item of Object.values(value as object)) visit(item);
  };
  visit(document);
  let claimKinds: Extract<RuntimeTypedOutputStructure, {status: 'measured'}>['claimKinds'];
  const texts = new Set<string>();
  let duplicateClaimTextCount = 0, duplicateClaimTextUtf8Bytes = 0;
  if (Array.isArray(contract.claims)) {
    const counts = Object.fromEntries(CONCLUSION_PROTOCOL_VALUES.claimKind.map(kind => [kind, 0])) as
      Record<typeof CONCLUSION_PROTOCOL_VALUES.claimKind[number], number>;
    let absent = 0, unclassified = 0;
    for (const claim of contract.claims) {
      if (record(claim) && (!own(claim, 'kind') || claim.kind === null)) absent++;
      else if (record(claim) && CONCLUSION_PROTOCOL_VALUES.claimKind.some(kind => kind === claim.kind)) counts[claim.kind as keyof typeof counts]++;
      else unclassified++;
      if (record(claim) && own(claim, 'text') && typeof claim.text === 'string') {
        if (texts.has(claim.text)) {duplicateClaimTextCount++; duplicateClaimTextUtf8Bytes += Buffer.byteLength(claim.text);}
        else texts.add(claim.text);
      }
    }
    claimKinds = {counts, absent, unclassified};
  }
  let bodyParts: Extract<RuntimeTypedOutputStructure, {status: 'measured'}>['bodyParts'];
  let literalPartMatchingClaimTextCount = 0, literalPartMatchingClaimTextUtf8Bytes = 0;
  if (Array.isArray(document.bodyParts)) {
    let literalPartCount = 0, literalPartTextUtf8Bytes = 0, claimTextUseCount = 0, unclassifiedPartCount = 0;
    for (const part of document.bodyParts) {
      if (typeof part === 'string') {
        literalPartCount++; literalPartTextUtf8Bytes += Buffer.byteLength(part);
        if (texts.has(part)) {literalPartMatchingClaimTextCount++; literalPartMatchingClaimTextUtf8Bytes += Buffer.byteLength(part);}
      } else if (record(part) && Object.keys(part).length === 1 && own(part, 'claimText') && typeof part.claimText === 'string') claimTextUseCount++;
      else unclassifiedPartCount++;
    }
    bodyParts = {literalPartCount, literalPartTextUtf8Bytes, claimTextUseCount, unclassifiedPartCount};
  }
  let partition: RuntimeTypedOutputPartition = {status: 'unsupported_shape'};
  if (Object.keys(document).every(key => provider.rootKeys.includes(key)) &&
    Object.keys(contract).every(key => provider.contractKeys.includes(key)) &&
    [document.referenceDictionary, document.semanticFrames, contract.claims, document.bodyParts].every(Array.isArray)) {
    const totalNormalizedUtf8Bytes = bytes(outer), referenceDictionary = bytes(document.referenceDictionary),
      semanticFrames = bytes(document.semanticFrames), claims = bytes(contract.claims), bodyPartsBytes = bytes(document.bodyParts),
      contractOther = bytes(Object.fromEntries(Object.entries(contract).filter(([key]) => key !== 'claims')));
    partition = {status: 'measured', totalNormalizedUtf8Bytes, referenceDictionary, semanticFrames, claims,
      bodyParts: bodyPartsBytes, contractOther,
      overhead: totalNormalizedUtf8Bytes - referenceDictionary - semanticFrames - claims - bodyPartsBytes - contractOther};
  }
  return {status: 'measured', collections, ...(claimKinds ? {claimKinds} : {}), ...(bodyParts ? {bodyParts} : {}), explicitNullCount,
    ...(claimKinds && bodyParts ? {exactTextReuse: {duplicateClaimTextCount, duplicateClaimTextUtf8Bytes,
      literalPartMatchingClaimTextCount, literalPartMatchingClaimTextUtf8Bytes}} : {}), partition};
}

/** Pure observer over the existing parser callbacks and retained request buffer.
 * It never authorizes a tool, modifies a receipt or keeps a second raw document. */
export function createOpenAiTypedFinalOutputMaterial(options: OpenAiTypedFinalMaterialOptions,
  readRetainedArguments: () => string) {
  const argumentsCount = new Counter(), companionCount = new Counter(), refusalCount = new Counter();
  const companionTail: Tail = {high: false}, refusalTail: Tail = {high: false};
  const calls = new Map<number, Call>();
  let identityBytes = 0, unknown = false, ambiguous = false, observedTool = false, broken = false;
  let argumentsOverLimit = false, doneSeen = false, eofSeen = false, invalidFraming = false;
  let finishReason: RuntimeTypedOutputMaterial['transport']['finishReason'];
  const safely = (work: () => void) => {if (!broken) try {work();} catch {broken = true;}};
  const unknownOutput = () => {unknown = true; argumentsCount.uncertain(); companionCount.uncertain(); refusalCount.uncertain();};
  const argumentSnapshot = () => argumentsCount.snapshot([...calls.values()].filter(call => call.high).length);
  const reserveIdentity = (value: string) => {
    const size = Buffer.byteLength(value);
    if (identityBytes + size > LIMITS.identityUtf8Bytes) {unknown = true; return false;}
    identityBytes += size; return true;
  };
  return {
    chunk(value: unknown) {safely(() => {
      if (doneSeen || eofSeen) {invalidFraming = true; return;}
      if (!record(value) || !Array.isArray(value.choices)) {unknownOutput(); return;}
      if (Object.keys(value).some(key => !['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'].includes(key))) unknownOutput();
      if (value.choices.length > 1) ambiguous = true;
      for (const choice of value.choices) {
        if (!record(choice) || !record(choice.delta)) {unknownOutput(); continue;}
        if (Object.keys(choice).some(key => !['index', 'delta', 'finish_reason', 'logprobs'].includes(key))) unknownOutput();
        const singleChoice = choice.index === 0 && value.choices.length === 1;
        if (!singleChoice) ambiguous = true;
        if (choice.finish_reason != null) {
          const next = TYPED_OUTPUT_WIRE_FINISH_REASONS.find(reason => reason === choice.finish_reason) ?? 'other';
          finishReason = finishReason && finishReason !== next ? 'other' : next;
        }
        const delta = choice.delta;
        if (Object.keys(delta).some(key => !['role', 'content', 'refusal', 'reasoning', 'reasoning_content', 'tool_calls'].includes(key))) unknownOutput();
        if (delta.role !== undefined && delta.role !== 'assistant') unknownOutput();
        for (const [key, counter, tail] of [['content', companionCount, companionTail], ['refusal', refusalCount, refusalTail]] as const) {
          if (typeof delta[key] === 'string') counter.append(delta[key], singleChoice ? tail : undefined);
          else if (delta[key] != null) {counter.uncertain(); unknown = true;}
        }
        if (delta.tool_calls === undefined) continue;
        if (!Array.isArray(delta.tool_calls)) {unknown = true; argumentsCount.uncertain(); continue;}
        for (const item of delta.tool_calls) {
          observedTool = true;
          if (!record(item) || !record(item.function)) {unknown = true; argumentsCount.uncertain(); continue;}
          const indexValid = Number.isSafeInteger(item.index) && (item.index as number) >= 0 && singleChoice;
          let call = indexValid ? calls.get(item.index as number) : undefined;
          if (!call && indexValid && calls.size < LIMITS.identityEntries) {
            call = {name: '', high: false, initial: item.type === 'function' && typeof item.id === 'string' && item.id.length > 0};
            if (typeof item.id === 'string' && reserveIdentity(item.id)) call.id = item.id;
            else {call.initial = false; unknown = true;}
            calls.set(item.index as number, call);
          } else if (!call) unknown = true;
          if (calls.size > 1 || !indexValid) ambiguous = true;
          if (Object.keys(item).some(key => !['index', 'id', 'type', 'function'].includes(key)) ||
            Object.keys(item.function).some(key => !['name', 'arguments'].includes(key)) ||
            (item.type !== undefined && item.type !== 'function')) unknown = true;
          if (call && item.id !== undefined && item.id !== call.id) {unknown = true; call.initial = false;}
          if (typeof item.function.name === 'string' && call) {
            if (reserveIdentity(item.function.name)) call.name += item.function.name;
            else call.initial = false;
          } else if (item.function.name !== undefined && typeof item.function.name !== 'string') unknown = true;
          if (typeof item.function.arguments === 'string') argumentsCount.append(item.function.arguments, call?.initial ? call : undefined);
          else if (item.function.arguments !== undefined) {argumentsCount.uncertain(); unknown = true;}
          if (argumentSnapshot().utf8Bytes > LIMITS.retainedUtf8Bytes) argumentsOverLimit = true;
        }
      }
    });},
    done() {safely(() => {if (doneSeen || eofSeen) invalidFraming = true; doneSeen = true;});},
    end(valid: boolean) {safely(() => {if (eofSeen || !valid) invalidFraming = true; eofSeen = true;});},
    fail(reason: string) {safely(() => {if (['invalid_json', 'invalid_framing', 'data_after_done'].includes(reason)) invalidFraming = true;});},
    snapshot(): RuntimeTypedOutputMaterial | undefined {
      if (broken) return undefined;
      try {
        const call = calls.size === 1 ? calls.values().next().value as Call : undefined;
        const wireToolRole: RuntimeTypedOutputMaterial['wireToolRole'] = ambiguous ? 'ambiguous' : unknown ? 'unknown' : !observedTool ? 'no_tool' :
          !call?.initial || !call.name ? 'unknown' : call.name === options.finalToolName ? 'final_role' :
            options.knownToolNames?.includes(call.name) ? 'other_tool' : 'unknown';
        const decoded = {...(argumentsCount.seen ? {arguments: argumentSnapshot()} : {}),
          ...(companionCount.seen ? {companion: companionCount.snapshot(Number(companionTail.high))} : {}),
          ...(refusalCount.seen ? {refusal: refusalCount.snapshot(Number(refusalTail.high))} : {})};
        const rawArguments = readRetainedArguments(), retainedUtf8Bytes = Buffer.byteLength(rawArguments);
        const argumentRetention: RuntimeTypedOutputRetention = {status: !decoded.arguments ? 'not_observed' :
          argumentsOverLimit ? 'over_limit' : ambiguous ? 'ambiguous' :
            decoded.arguments.utf8Precision === 'exact' && decoded.arguments.utf16Precision === 'exact' &&
            decoded.arguments.utf8Bytes === retainedUtf8Bytes && decoded.arguments.utf16Chars === rawArguments.length ? 'complete' : 'not_retained',
          retainedUtf8Bytes};
        // Preserve actual retained prefix bytes even when identity or malformed chunks make completeness ambiguous.
        const retainedArguments: RuntimeTypedOutputRetention = argumentRetention.status === 'not_retained' && retainedUtf8Bytes > 0
          ? {status: 'ambiguous', retainedUtf8Bytes} : argumentRetention;
        const unretained = (counter?: RuntimeTypedOutputDecoded): RuntimeTypedOutputRetention => !counter ? {status: 'not_observed', retainedUtf8Bytes: 0} :
          {status: counter.utf8Bytes === 0 && counter.utf8Precision === 'exact' && counter.utf16Precision === 'exact' ? 'complete' : 'not_retained', retainedUtf8Bytes: 0};
        let json: RuntimeTypedOutputMaterial['json'] = {status: 'not_parsed'};
        let representation: RuntimeTypedOutputMaterial['representation'] = wireToolRole === 'other_tool' || wireToolRole === 'no_tool' ? 'not_applicable' : 'unknown';
        let observedStructure: RuntimeTypedOutputStructure = {status: representation === 'not_applicable' ? 'not_applicable' : 'not_observed'};
        if (wireToolRole === 'final_role' && retainedArguments.status === 'complete' && eofSeen && !invalidFraming) {
          let outer: unknown;
          try {outer = JSON.parse(rawArguments); json = {status: 'complete_json'};} catch {json = {status: 'invalid_json'};}
          if (record(outer) && Object.keys(outer).length === 1) {
            let document: unknown;
            if (own(outer, 'document')) document = outer.document;
            else if (typeof outer.documentJson === 'string') {try {document = JSON.parse(outer.documentJson);} catch { /* Unknown representation. */ }}
            if (record(document) && (document.representationVersion === 'authored_claim_document@1' || document.representationVersion === 'authored_claim_document@2')) {
              representation = document.representationVersion;
              if (representation === 'authored_claim_document@1') observedStructure = {status: 'not_applicable'};
              else if (own(outer, 'document') && options.materialProvider?.representationVersion === representation) {
                observedStructure = structure(outer, document, options.materialProvider);
              }
            }
          }
        }
        return freeze({schemaVersion: 'typed_output_material@1', wireToolRole,
          transport: {doneSeen, eofSeen, framing: invalidFraming ? 'invalid' : eofSeen ? 'valid' : 'unknown', ...(finishReason ? {finishReason} : {})}, decoded,
          retention: {arguments: retainedArguments, companion: unretained(decoded.companion), refusal: unretained(decoded.refusal),
            combinedRetainedUtf8Bytes: retainedArguments.retainedUtf8Bytes}, json, representation, structure: observedStructure});
      } catch {broken = true; return undefined;}
    },
  };
}
