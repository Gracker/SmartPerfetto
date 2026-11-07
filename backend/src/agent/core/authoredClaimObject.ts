// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {assembleAuthoredBody, measureAuthoredJson, type AuthoredBodyPartSpan,
  type AuthoredClaimDocumentFailure, type AuthoredClaimTextOccurrence} from './authoredClaimDocument';
import {CONCLUSION_AUTHORING_LIMITS, CONCLUSION_AUTHORING_VERSION_V2, decodeConclusionAuthoring,
  type AuthoringMaterial} from './conclusionAuthoring';
import {CONCLUSION_PROTOCOL_VALUES, parseConclusionDeclarationPayload,
  type ConclusionContractDeclarationParseResult} from './conclusionContract';
import {findQuoteOccurrence, quoteOccurrenceAtSpan} from './numericQuoteLocator';

export const AUTHORED_CLAIM_OBJECT_VERSION = 'authored_claim_document@2';
export const AUTHORED_QUOTE_FAILURE_REASONS = Object.freeze(['local_no_match', 'local_ambiguous',
  'local_occurrence_out_of_range', 'global_span_unrepresentable'] as const);
export const AUTHORED_QUOTE_MATCH_COUNT_LIMIT = 17;
/** Private diagnostic coordinates only; never a quote repair or evidence binding. */
export interface AuthoredQuoteFailureLocation {
  readonly reason: typeof AUTHORED_QUOTE_FAILURE_REASONS[number];
  readonly claimOrdinal: number;
  readonly quoteOrdinal: number;
  readonly partIndex: number;
  readonly localOccurrence?: number;
  readonly localMatchCount: Readonly<{count: number; precision: 'exact' | 'at_least'}>;
}
export interface AuthoredQuoteBinding {
  /** One-based positions in the original, unfiltered declaration arrays. */
  claimOrdinal: number;
  quoteOrdinal: number;
  originalSpan: {startUtf16: number; endUtf16: number};
  canonicalQuote: {text: string; occurrence: number};
}
export type AuthoredClaimObjectFailure = AuthoredClaimDocumentFailure | 'non_json_value' |
  'invalid_structure' | 'invalid_reference_index' | 'invalid_frame_index' | 'invalid_selector' |
  'invalid_selector_json' | 'invalid_quote_locator' | 'quote_unresolved';
export type AuthoredClaimObjectResult = {
  status: 'compiled';
  representationVersion: typeof AUTHORED_CLAIM_OBJECT_VERSION;
  /** Private input material only; none of these records issue evidence or completion. */
  privateNativeDocument: Record<string, unknown>;
  body: string;
  rawCanonicalPayload: Record<string, unknown>;
  canonicalParse: ConclusionContractDeclarationParseResult;
  occurrences: AuthoredClaimTextOccurrence[];
  partSpans: AuthoredBodyPartSpan[];
  quoteBindings: AuthoredQuoteBinding[];
  material: {nativeDocument: AuthoringMaterial; expanded: AuthoringMaterial; bodyUtf8Bytes: number; bodyUtf16Length: number};
} | {status: 'projection_failed'; code: AuthoredClaimObjectFailure; privateNativeDocument: unknown;
  compilerFailureLocation?: AuthoredQuoteFailureLocation};

type JsonRecord = Record<string, unknown>;
const object = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
class ProjectionFailure extends Error {constructor(readonly code: AuthoredClaimObjectFailure) {super(code);}}
function refuse(code: AuthoredClaimObjectFailure): never {
  if (code === 'invalid_structure') {
    try {
      const location: {stack?: string} = {};
      Error.captureStackTrace(location, refuse);
      if (typeof location.stack === 'string') {
        const sourceLocations = [...location.stack.matchAll(/authoredClaimObject\.[jt]s:(\d+):(\d+)/g)]
          .map(match => ({line: Number(match[1]), column: Number(match[2])}))
          .filter(site => Number.isSafeInteger(site.line) && site.line > 0 && Number.isSafeInteger(site.column) && site.column > 0)
          .slice(0, 3);
        if (sourceLocations.length) console.warn('[AuthoredClaimObject] invalid structure location', {sourceLocations});
      }
    } catch { /* Diagnostics cannot change the original rejection. */ }
  }
  throw new ProjectionFailure(code);
}
function shape(value: unknown, keys: readonly string[]): JsonRecord {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    try {
      console.warn('[AuthoredClaimObject] structure mismatch', {
        expectedFields: keys,
        missingFields: object(value) ? keys.filter(key => !Object.prototype.hasOwnProperty.call(value, key)) : keys,
        unexpectedFieldCount: object(value) ? Object.keys(value).filter(key => !keys.includes(key)).length : 0,
        actualKind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      });
    } catch { /* Diagnostics cannot change the original rejection. */ }
    return refuse('invalid_structure');
  }
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return refuse('invalid_structure');
  return value;
}
/** Only explicitly nullable wire positions use this conversion. */
function submitted(value: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(keys.filter(key => value[key] !== null).map(key => [key, value[key]]));
}
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  return value;
}
function measured(value: unknown, prefix: 'raw' | 'expanded'): AuthoringMaterial {
  const measured = measureAuthoredJson(value);
  if (measured === 'non_json_value') return refuse(measured);
  if (typeof measured === 'string') return refuse(`${prefix}_${measured}_exceeded`);
  return measured;
}
function index(value: unknown, length: number, code: 'invalid_frame_index' | 'invalid_reference_index'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) return refuse(code);
  return value as number;
}
function selectorEntries(value: unknown): JsonRecord {
  const seen = new Set<string>();
  return Object.fromEntries(list(value).map(raw => {
    const entry = shape(raw, ['key', 'value']);
    if (typeof entry.key !== 'string' || !entry.key.length || seen.has(entry.key)) return refuse('invalid_selector');
    seen.add(entry.key);
    return [entry.key, entry.value];
  }));
}
function artifactSelector(value: unknown): JsonRecord {
  if (!object(value)) return refuse('invalid_selector');
  if (value.encoding === 'entries') return selectorEntries(shape(value, ['encoding', 'entries']).entries);
  const encoded = shape(value, ['encoding', 'jsonText']);
  if (encoded.encoding !== 'json_object' || typeof encoded.jsonText !== 'string') return refuse('invalid_selector');
  let parsed: unknown;
  try {parsed = JSON.parse(encoded.jsonText);} catch {return refuse('invalid_selector_json');}
  measured(parsed, 'expanded');
  if (!object(parsed)) return refuse('invalid_selector_json');
  return parsed;
}
function presence(value: unknown): JsonRecord {
  if (!object(value)) return refuse('invalid_structure');
  if (value.kind === 'absent') {shape(value, ['kind']); return {};}
  shape(value, ['kind', 'value']);
  if (value.kind !== 'present') return refuse('invalid_structure');
  return {value: value.value};
}
function reference(value: unknown): JsonRecord {
  const ref = shape(value, ['evidenceRefId', 'sourceRef', 'sourceToolCallId', 'artifactId', 'sourceArtifactId',
    'column', 'rowIndex', 'rowSelector', 'value']);
  return {...submitted(ref, ['evidenceRefId', 'sourceRef', 'sourceToolCallId', 'artifactId', 'sourceArtifactId', 'column', 'rowIndex']),
    ...(ref.rowSelector === null ? {} : {rowSelector: selectorEntries(ref.rowSelector)}), ...presence(ref.value)};
}
function artifactReference(value: unknown): JsonRecord {
  const ref = shape(value, ['artifactId', 'rowIndex', 'rowSelector']);
  return {artifactId: ref.artifactId, ...submitted(ref, ['rowIndex']),
    ...(ref.rowSelector === null ? {} : {rowSelector: artifactSelector(ref.rowSelector)})};
}
interface PartQuote {claimOrdinal: number; quoteOrdinal: number; text: string; partIndex: number; localOccurrence?: number}

/** Observation only: preserve the original matcher's UTF-16, non-overlapping stepping. */
function quoteFailureLocation(quote: PartQuote, partText: string, globalFailure: boolean): AuthoredQuoteFailureLocation {
  let count = 0;
  for (let start = partText.indexOf(quote.text); start >= 0; start = partText.indexOf(quote.text, start + quote.text.length)) {
    count++;
    if (count === AUTHORED_QUOTE_MATCH_COUNT_LIMIT) break;
  }
  // This function is called only after the original matcher failed. Saturation
  // never decides whether a requested occurrence exists or changes its result.
  let reason: AuthoredQuoteFailureLocation['reason'];
  if (globalFailure) {
    reason = 'global_span_unrepresentable';
  } else if (count === 0) {
    reason = 'local_no_match';
  } else if (quote.localOccurrence === undefined) {
    reason = 'local_ambiguous';
  } else {
    reason = 'local_occurrence_out_of_range';
  }
  const precision: AuthoredQuoteFailureLocation['localMatchCount']['precision'] = count === AUTHORED_QUOTE_MATCH_COUNT_LIMIT ? 'at_least' : 'exact';
  return Object.freeze({reason, claimOrdinal: quote.claimOrdinal, quoteOrdinal: quote.quoteOrdinal, partIndex: quote.partIndex,
    ...(quote.localOccurrence === undefined ? {} : {localOccurrence: quote.localOccurrence}),
    localMatchCount: Object.freeze({count, precision})});
}

/** Explicit native grammar only. No schema coercion, captures, SDK state or live authority. */
export function compileAuthoredClaimObject(nativeDocument: unknown): AuthoredClaimObjectResult {
  const failed = (code: AuthoredClaimObjectFailure, compilerFailureLocation?: AuthoredQuoteFailureLocation): AuthoredClaimObjectResult =>
    ({status: 'projection_failed', code, privateNativeDocument: nativeDocument, ...(compilerFailureLocation ? {compilerFailureLocation} : {})});
  try {
    const nativeMaterial = measured(nativeDocument, 'raw');
    // Descriptor preflight has bounded every value, including unused frames/dictionary entries.
    const doc = shape(cloneJson(nativeDocument), ['representationVersion', 'referenceDictionary', 'semanticFrames', 'contract', 'bodyParts']);
    if (doc.representationVersion !== AUTHORED_CLAIM_OBJECT_VERSION) return failed('unsupported_version');
    const dictionary = list(doc.referenceDictionary).map(reference);
    const frames = list(doc.semanticFrames).map(raw => {
      const frame = shape(raw, ['predicate', 'polarity', 'discourse', 'quantifier', 'modality', 'conditions', 'population']);
      if (frame.conditions !== null) list(frame.conditions);
      return frame;
    });
    const alias = (value: unknown) => ({$ref: index(value, dictionary.length, 'invalid_reference_index')});
    const aliases = (value: unknown) => list(value).map(alias);
    const partQuotes: PartQuote[] = [];
    const presentation = (value: unknown, claimOrdinal: number): JsonRecord => {
      const presentationInput = shape(value, ['unit', 'decimalPlaces', 'rounding', 'quotes']);
      return {schemaVersion: 'numeric_presentation@1', unit: presentationInput.unit,
        decimalPlaces: presentationInput.decimalPlaces, rounding: presentationInput.rounding,
        quotes: list(presentationInput.quotes).map((raw, quoteIndex) => {
          if (!object(raw)) return refuse('invalid_structure');
          if (raw.kind === 'global') {
            const quote = shape(raw, ['kind', 'text', 'occurrence']);
            return {text: quote.text, ...submitted(quote, ['occurrence'])};
          }
          const quote = shape(raw, ['kind', 'text', 'partIndex', 'localOccurrence']);
          if (quote.kind !== 'body_part' || typeof quote.text !== 'string' || quote.text.length === 0 || quote.text.length > 256 ||
              !Number.isSafeInteger(quote.partIndex) || (quote.partIndex as number) < 0 ||
              quote.localOccurrence !== null && (!Number.isSafeInteger(quote.localOccurrence) || (quote.localOccurrence as number) < 0)) {
            return refuse('invalid_quote_locator');
          }
          partQuotes.push({claimOrdinal, quoteOrdinal: quoteIndex + 1, text: quote.text, partIndex: quote.partIndex as number,
            ...(quote.localOccurrence === null ? {} : {localOccurrence: quote.localOccurrence as number})});
          // The actual ordinal is resolved below against the complete literal body.
          return {text: quote.text, occurrence: 0};
        })};
    };
    const numeric = (value: unknown, ordinal: number): JsonRecord => {
      const numericInput = shape(value, ['operator', 'value', 'unit', 'presentation']);
      return {operator: numericInput.operator, value: numericInput.value, unit: numericInput.unit,
        ...(numericInput.presentation === null ? {} : {presentation: presentation(numericInput.presentation, ordinal)})};
    };
    const semantics = (value: unknown, ordinal: number): JsonRecord => {
      const semanticsInput = shape(value, ['frameIndex', 'subjectRefs', 'objectRefs', 'timeRangeNs', 'numeric']);
      const frame = frames[index(semanticsInput.frameIndex, frames.length, 'invalid_frame_index')];
      const range = semanticsInput.timeRangeNs === null ? undefined : shape(semanticsInput.timeRangeNs, ['start', 'end']);
      return {schemaVersion: CONCLUSION_PROTOCOL_VALUES.semanticsSchemaVersion,
        predicate: frame.predicate, polarity: frame.polarity, discourse: frame.discourse,
        quantifier: frame.quantifier, modality: frame.modality, ...submitted(frame, ['conditions']),
        scope: {population: frame.population,
          ...(semanticsInput.subjectRefs === null ? {} : {subjectRefs: aliases(semanticsInput.subjectRefs)}),
          ...(semanticsInput.objectRefs === null ? {} : {objectRefs: aliases(semanticsInput.objectRefs)}),
          ...(range ? {timeRangeNs: range} : {})},
        ...(semanticsInput.numeric === null ? {} : {numeric: numeric(semanticsInput.numeric, ordinal)})};
    };
    const claim = (value: unknown, ordinal: number): JsonRecord => {
      const claimInput = shape(value, ['id', 'conclusionId', 'text', 'kind', 'references', 'artifactRefs', 'relationRefs', 'supportLevel', 'semantics']);
      if (claimInput.relationRefs !== null) list(claimInput.relationRefs);
      return {text: claimInput.text, ...submitted(claimInput, ['id', 'conclusionId', 'kind', 'supportLevel', 'relationRefs']),
        references: aliases(claimInput.references),
        ...(claimInput.artifactRefs === null ? {} : {artifactRefs: list(claimInput.artifactRefs).map(artifactReference)}),
        ...(claimInput.semantics === null ? {} : {semantics: semantics(claimInput.semantics, ordinal)})};
    };
    const relation = (value: unknown): JsonRecord => {
      const relationInput = shape(value, ['id', 'kind', 'direction', 'subject', 'object', 'proof', 'proofBindings',
        'metricColumn', 'value', 'unit', 'deltaDirection']);
      if (relationInput.proofBindings !== null) {
        const bindings = shape(relationInput.proofBindings, ['subject', 'object']);
        for (const binding of [bindings.subject, bindings.object]) shape(binding, ['endpointColumn', 'proofColumn']);
      }
      return {schemaVersion: CONCLUSION_PROTOCOL_VALUES.relationSchemaVersion, id: relationInput.id,
        kind: relationInput.kind, direction: relationInput.direction,
        subject: alias(relationInput.subject), ...(relationInput.object === null ? {} : {object: alias(relationInput.object)}),
        ...(relationInput.proof === null ? {} : {proof: alias(relationInput.proof)}),
        ...submitted(relationInput, ['proofBindings', 'metricColumn', 'unit', 'deltaDirection']), ...presence(relationInput.value)};
    };
    const contractInput = shape(doc.contract, ['mode', 'conclusions', 'clusters', 'evidenceChain', 'claims', 'relationProposals',
      'sourceClaimBindings', 'uncertainties', 'nextSteps', 'metadata']);
    const optionalList = (key: string, project: (value: unknown) => unknown) =>
      contractInput[key] === null ? {} : {[key]: list(contractInput[key]).map(project)};
    const stringItem = (value: unknown): string =>
      typeof value === 'string' ? value : refuse('invalid_structure');
    const projectFields = (raw: unknown, required: readonly string[], nullable: readonly string[]) => {
      const value = shape(raw, [...required, ...nullable]);
      return {...Object.fromEntries(required.map(key => [key, value[key]])), ...submitted(value, nullable)};
    };
    const metadata = contractInput.metadata === null ? undefined : shape(contractInput.metadata, ['confidencePercent', 'sceneId', 'clusterPolicy']);
    let clusterPolicy: JsonRecord | undefined;
    if (metadata && metadata.clusterPolicy !== null) {
      clusterPolicy = projectFields(metadata.clusterPolicy, ['outputMode', 'frameListMode'], ['maxFramesPerCluster']);
    }
    const contract = {schemaVersion: CONCLUSION_PROTOCOL_VALUES.schemaVersion, mode: contractInput.mode,
      ...optionalList('conclusions', value => projectFields(value, ['rank', 'statement'], ['confidencePercent', 'trigger', 'supply', 'amplification'])),
      ...optionalList('clusters', value => {
        const projected = projectFields(value, ['cluster'], ['description', 'frames', 'percentage', 'frameRefs', 'omittedFrameRefs']);
        if (projected.frameRefs !== undefined) list(projected.frameRefs);
        return projected;
      }),
      ...optionalList('evidenceChain', value => projectFields(value, ['conclusionId', 'text'], [])),
      claims: list(contractInput.claims).map((value, ordinal) => claim(value, ordinal + 1)),
      ...optionalList('relationProposals', relation),
      ...optionalList('sourceClaimBindings', value => {
        const binding = shape(value, ['claimId', 'sourceReferenceIds', 'traceEvidenceRefIds']);
        list(binding.sourceReferenceIds); list(binding.traceEvidenceRefIds); return binding;
      }),
      ...optionalList('uncertainties', stringItem), ...optionalList('nextSteps', stringItem),
      ...(metadata ? {metadata: {...submitted(metadata, ['confidencePercent', 'sceneId']), ...(clusterPolicy ? {clusterPolicy} : {})}} : {})};
    const expanded = decodeConclusionAuthoring({authoringVersion: CONCLUSION_AUTHORING_VERSION_V2, referenceDictionary: dictionary, contract},
      CONCLUSION_AUTHORING_VERSION_V2);
    if (expanded.status !== 'expanded') return failed(expanded.code === 'non_json_value' ? expanded.code
      : expanded.code.startsWith('expanded_') ? expanded.code as AuthoredClaimObjectFailure : 'invalid_structure');
    const payload = expanded.expandedPayload;
    if (expanded.material.nodes + 2 > CONCLUSION_AUTHORING_LIMITS.nodes) return failed('expanded_nodes_exceeded');
    if (expanded.material.depth + 1 > CONCLUSION_AUTHORING_LIMITS.depth) return failed('expanded_depth_exceeded');
    const aggregateOverhead = Buffer.byteLength('{"body":,"contract":}', 'utf8');
    const assembled = assembleAuthoredBody(payload.claims, list(doc.bodyParts),
      CONCLUSION_AUTHORING_LIMITS.utf8Bytes - aggregateOverhead - expanded.material.utf8Bytes);
    if (assembled.status !== 'assembled') return failed(assembled.code);
    const quoteBindings: AuthoredQuoteBinding[] = [];
    for (const quoteLocator of partQuotes) {
      const part = assembled.partSpans[quoteLocator.partIndex];
      if (!part) return failed('invalid_quote_locator');
      const partText = assembled.body.slice(part.startUtf16, part.endUtf16);
      const local = findQuoteOccurrence(partText, quoteLocator.text, quoteLocator.localOccurrence);
      if (!local) return failed('quote_unresolved', quoteFailureLocation(quoteLocator, partText, false));
      const span = {start: part.startUtf16 + local.start, end: part.startUtf16 + local.end};
      const occurrence = quoteOccurrenceAtSpan(assembled.body, quoteLocator.text, span);
      if (occurrence === undefined) return failed('quote_unresolved', quoteFailureLocation(quoteLocator, partText, true));
      const canonicalQuote = {text: quoteLocator.text, occurrence};
      // The complete projected shape is known here; never index a parser-filtered claims array.
      const rawClaim = (payload.claims as JsonRecord[])[quoteLocator.claimOrdinal - 1];
      const expandedPresentation = ((rawClaim.semantics as JsonRecord).numeric as JsonRecord).presentation as JsonRecord;
      (expandedPresentation.quotes as JsonRecord[])[quoteLocator.quoteOrdinal - 1] = canonicalQuote;
      quoteBindings.push({claimOrdinal: quoteLocator.claimOrdinal, quoteOrdinal: quoteLocator.quoteOrdinal,
        originalSpan: {startUtf16: span.start, endUtf16: span.end}, canonicalQuote: {...canonicalQuote}});
    }
    const expandedMaterial = measured({body: assembled.body, contract: payload}, 'expanded');
    return {status: 'compiled', representationVersion: AUTHORED_CLAIM_OBJECT_VERSION, privateNativeDocument: doc,
      body: assembled.body, rawCanonicalPayload: payload, canonicalParse: parseConclusionDeclarationPayload(payload, 'canonical_v1'),
      occurrences: assembled.occurrences, partSpans: assembled.partSpans, quoteBindings,
      material: {nativeDocument: nativeMaterial, expanded: expandedMaterial,
        bodyUtf8Bytes: assembled.bodyMaterial.utf8Bytes, bodyUtf16Length: assembled.bodyUtf16Length}};
  } catch (error) {
    return failed(error instanceof ProjectionFailure ? error.code : 'non_json_value');
  }
}
