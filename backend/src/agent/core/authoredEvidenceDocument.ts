// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {types} from 'node:util';
import {z} from 'zod';
import {authoredClaimObjectSchema} from './authoredClaimObjectSchema';
import {AUTHORED_CLAIM_OBJECT_VERSION, compileAuthoredClaimObject,
  type AuthoredClaimObjectFailure, type AuthoredClaimObjectResult, type AuthoredQuoteFailureLocation} from './authoredClaimObject';
import {measureAuthoredJson} from './authoredClaimDocument';
import {CONCLUSION_AUTHORING_LIMITS, type AuthoringMaterial} from './conclusionAuthoring';
import {exactNumber} from '../../utils/exactDecimal';
import {claimUnitFor, countedUnitDimension, declaredUnitAcceptsProducerDimension} from '../../utils/claimUnits';

export const AUTHORED_EVIDENCE_DOCUMENT_VERSION = 'authored_claim_document@3';
export const AUTHORED_EVIDENCE_DOCUMENT_COMPILER_VERSION = 'authored_claim_document_compiler@3';
export const AUTHORED_EVIDENCE_RENDERER_VERSION = 'program_evidence_quote_render@1';

const indexSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const formatSchema = z.union([
  z.strictObject({kind: z.literal('raw')}),
  z.strictObject({kind: z.literal('numeric'), unit: z.string().min(1),
    decimalPlaces: z.number().int().min(0).max(18), rounding: z.literal('half_away_from_zero')}),
]);
const quotePartSchema = z.strictObject({evidenceQuote: z.strictObject({
  id: z.string().min(1), viewId: z.string().min(1),
  rows: z.union([z.strictObject({kind: z.literal('all_visible')}),
    z.strictObject({kind: z.literal('indices'), indices: z.array(indexSchema)})]),
  fields: z.array(z.strictObject({column: z.string().min(1), format: formatSchema})).min(1),
  layout: z.literal('table'),
})});
/** Generation constraints only. Invalid model semantics still reach the original complete compiler. */
export const authoredEvidenceDocumentSchema = z.strictObject({...authoredClaimObjectSchema.shape,
  representationVersion: z.literal(AUTHORED_EVIDENCE_DOCUMENT_VERSION),
  bodyParts: z.array(z.union([authoredClaimObjectSchema.shape.bodyParts.element, quotePartSchema])),
});

export type EvidenceQuoteUnavailableReason = 'view_not_visible' | 'selection_unavailable' | 'read_unavailable' |
  'binding_mismatch' | 'unsupported_cell' | 'unit_unknown' | 'unit_dimension_mismatch' | 'invalid_precision' |
  'discrete_format_required';
const unavailableReasons: readonly EvidenceQuoteUnavailableReason[] = ['view_not_visible', 'selection_unavailable',
  'read_unavailable', 'binding_mismatch', 'unsupported_cell', 'unit_unknown', 'unit_dimension_mismatch',
  'invalid_precision', 'discrete_format_required'];
type QuoteFormat = {kind: 'raw'} | {kind: 'numeric'; unit: string; decimalPlaces: number; rounding: 'half_away_from_zero'};
type QuoteSpec = {id: string; viewId: string; rows: {kind: 'all_visible'} | {kind: 'indices'; indices: readonly number[]};
  fields: readonly {column: string; format: QuoteFormat}[]; layout: 'table'};
interface PreparedQuoteSpec {partIndex: number; quote: QuoteSpec}
export interface PreparedAuthoredEvidenceDocument {
  readonly status: 'prepared';
  readonly privateNativeDocument: Readonly<Record<string, unknown>>;
  readonly rawMaterial: Readonly<AuthoringMaterial>;
  readonly quotes: readonly PreparedQuoteSpec[];
}
export interface EvidenceQuoteSelection {
  readonly viewId: string;
  readonly rows: readonly number[];
  readonly columns: readonly string[];
  readonly page: {readonly visibleRows: number; readonly hasMore: 'yes' | 'no' | 'unknown'; readonly coverage: 'visible_page_only'};
}
/** Ordinary compiler data. Only the run context can establish its actual visibility and read provenance. */
export interface PreparedEvidenceQuotePart {
  readonly partIndex: number;
  readonly quoteId: string;
  readonly fidelity: 'matched' | 'unavailable';
  readonly reason?: EvidenceQuoteUnavailableReason;
  readonly selection: EvidenceQuoteSelection;
  readonly readKeys: readonly string[];
}
export interface SelectedQuoteReadRecord {
  readonly key: string;
  readonly locator: {readonly artifactId: string} | {readonly evidenceRefId: string};
  readonly traceSide: 'current' | 'reference';
  readonly rowIndex?: number;
  readonly metadataOnly?: true;
  readonly cells: readonly {readonly column: string; readonly value: unknown; readonly unit?: string}[];
}
interface Span {startUtf16: number; endUtf16: number}
export interface AuthoredEvidenceOriginSpan extends Span {
  partIndex: number;
  origin: 'model_literal' | 'model_claim_text' | 'program_evidence_quote';
  quoteId?: string;
}
export interface AuthoredEvidenceQuoteOccurrence extends Span {
  quoteId: string;
  partIndex: number;
  fidelity: 'matched' | 'unavailable';
  reason?: EvidenceQuoteUnavailableReason;
  selection: EvidenceQuoteSelection;
  readKeys: readonly string[];
  dataSpans: readonly (Span & {readKey: string})[];
  contextSpans: readonly Span[];
  headingSpans: readonly Span[];
}
type CompiledModel = Extract<AuthoredClaimObjectResult, {status: 'compiled'}>;
export interface CompiledAuthoredEvidenceDocument {
  readonly status: 'composed';
  readonly representationVersion: typeof AUTHORED_EVIDENCE_DOCUMENT_VERSION;
  readonly compilerVersion: typeof AUTHORED_EVIDENCE_DOCUMENT_COMPILER_VERSION;
  readonly rendererVersion: typeof AUTHORED_EVIDENCE_RENDERER_VERSION;
  readonly privateNativeDocument: Readonly<Record<string, unknown>>;
  /** Explicit program composition input to @2, never the original native model document. */
  readonly internalModelDocument: Readonly<Record<string, unknown>>;
  readonly modelCompiled: CompiledModel;
  readonly body: string;
  readonly rawCanonicalPayload: Record<string, unknown>;
  readonly originSpans: readonly AuthoredEvidenceOriginSpan[];
  readonly quoteOccurrences: readonly AuthoredEvidenceQuoteOccurrence[];
  readonly selectedReadSnapshot: readonly SelectedQuoteReadRecord[];
  readonly resourcePhases: {readonly raw: AuthoringMaterial; readonly derived: AuthoringMaterial;
    readonly compiler: AuthoringMaterial; readonly final: AuthoringMaterial};
}
interface EvidenceProjectionFailure {
  status: 'projection_failed';
  phase: 'raw' | 'derived' | 'compiler' | 'final';
  code: AuthoredClaimObjectFailure | 'bytes_exceeded' | 'nodes_exceeded' | 'depth_exceeded';
  privateNativeDocument: unknown;
  compilerFailureLocation?: AuthoredQuoteFailureLocation;
}
export type AuthoredEvidencePreparationResult = PreparedAuthoredEvidenceDocument | EvidenceProjectionFailure;
export type AuthoredEvidenceDocumentResult = CompiledAuthoredEvidenceDocument | EvidenceProjectionFailure;

type Row = Record<string, unknown>;
class InvalidMaterial extends Error {}
class MaterialOverflow extends Error {
  constructor(readonly axis: 'bytes' | 'nodes' | 'depth') {super(axis);}
}
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function dataObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new InvalidMaterial();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new InvalidMaterial();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !own(value, key)) || keys.some(key => typeof key !== 'string' ||
      !required.includes(key) && !optional.includes(key))) throw new InvalidMaterial();
  const captured: Row = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !own(descriptor, 'value')) throw new InvalidMaterial();
    Object.defineProperty(captured, key, {value: descriptor.value, enumerable: true});
  }
  return captured;
}
function dataArray(value: unknown): readonly unknown[] {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new InvalidMaterial();
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new InvalidMaterial();
  if (length > CONCLUSION_AUTHORING_LIMITS.nodes) throw new MaterialOverflow('nodes');
  if (Reflect.ownKeys(value).length !== length + 1) throw new InvalidMaterial();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) throw new InvalidMaterial();
  }
  return value;
}
function nonempty(value: unknown): value is string {return typeof value === 'string' && value.length > 0;}
function safeIndex(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;}
function strings(value: unknown): readonly string[] {
  const entries = dataArray(value);
  if (entries.some(entry => !nonempty(entry))) throw new InvalidMaterial();
  return entries as readonly string[];
}
function indices(value: unknown): readonly number[] {
  const entries = dataArray(value);
  if (entries.some(entry => !safeIndex(entry)) || new Set(entries).size !== entries.length) throw new InvalidMaterial();
  return entries as readonly number[];
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function fail(phase: EvidenceProjectionFailure['phase'], code: EvidenceProjectionFailure['code'], raw: unknown,
  location?: AuthoredQuoteFailureLocation): EvidenceProjectionFailure {
  return {status: 'projection_failed', phase, code, privateNativeDocument: raw,
    ...(location ? {compilerFailureLocation: location} : {})};
}
function rawFailure(result: ReturnType<typeof measureAuthoredJson>, raw: unknown): EvidenceProjectionFailure | undefined {
  if (typeof result !== 'string') return undefined;
  const code = result === 'non_json_value' ? result : `raw_${result}_exceeded` as AuthoredClaimObjectFailure;
  return fail('raw', code, raw);
}
function parseQuote(value: unknown): QuoteSpec {
  const raw = dataObject(value, ['id', 'viewId', 'rows', 'fields', 'layout']);
  if (!nonempty(raw.id) || !nonempty(raw.viewId) || raw.layout !== 'table') throw new InvalidMaterial();
  const row = dataObject(raw.rows, ['kind'], ['indices']);
  let rows: QuoteSpec['rows'];
  if (row.kind === 'all_visible' && !own(row, 'indices')) rows = {kind: 'all_visible'};
  else if (row.kind === 'indices' && own(row, 'indices')) rows = {kind: 'indices', indices: indices(row.indices)};
  else throw new InvalidMaterial();
  const fields = dataArray(raw.fields).map(value => {
    const field = dataObject(value, ['column', 'format']);
    if (!nonempty(field.column)) throw new InvalidMaterial();
    const format = dataObject(field.format, ['kind'], ['unit', 'decimalPlaces', 'rounding']);
    if (format.kind === 'raw' && Object.keys(format).length === 1) return {column: field.column, format: {kind: 'raw'} as QuoteFormat};
    if (format.kind !== 'numeric' || Object.keys(format).length !== 4 || typeof format.unit !== 'string' ||
        typeof format.decimalPlaces !== 'number' || format.rounding !== 'half_away_from_zero') throw new InvalidMaterial();
    return {column: field.column, format: {kind: 'numeric', unit: format.unit, decimalPlaces: format.decimalPlaces,
      rounding: 'half_away_from_zero'} as QuoteFormat};
  });
  if (!fields.length || new Set(fields.map(field => field.column)).size !== fields.length) throw new InvalidMaterial();
  return {id: raw.id, viewId: raw.viewId, rows, fields, layout: 'table'};
}
function quoteSpecs(document: Row): readonly PreparedQuoteSpec[] {
  const quotes: PreparedQuoteSpec[] = [];
  const ids = new Set<string>();
  for (const [partIndex, part] of dataArray(document.bodyParts).entries()) {
    if (typeof part === 'string') continue;
    const item = dataObject(part, [], ['claimText', 'evidenceQuote']);
    if (Object.keys(item).length !== 1) throw new InvalidMaterial();
    if (own(item, 'claimText')) {
      if (!nonempty(item.claimText)) throw new InvalidMaterial();
      continue;
    }
    const quote = parseQuote(item.evidenceQuote);
    if (ids.has(quote.id)) throw new InvalidMaterial();
    ids.add(quote.id);
    quotes.push({partIndex, quote});
  }
  return quotes;
}

/** Pure preparation. Neither this snapshot nor its type conveys evidence/native authority. */
export function prepareAuthoredEvidenceDocument(raw: unknown): AuthoredEvidencePreparationResult {
  const measured = measureAuthoredJson(raw);
  const rejected = rawFailure(measured, raw);
  if (rejected) return rejected;
  let document: Row;
  try {
    // Capture every original model value before any later asynchronous read can occur.
    const snapshot: unknown = deepFreeze(structuredClone(raw));
    document = dataObject(snapshot, ['representationVersion', 'referenceDictionary', 'semanticFrames', 'contract', 'bodyParts']);
    if (document.representationVersion !== AUTHORED_EVIDENCE_DOCUMENT_VERSION) return fail('raw', 'unsupported_version', snapshot);
    try {
      const quotes = quoteSpecs(document);
      return deepFreeze({status: 'prepared' as const, privateNativeDocument: snapshot as Row,
        rawMaterial: measured as AuthoringMaterial, quotes});
    } catch {
      return fail('raw', 'invalid_body_part', snapshot);
    }
  } catch {
    return fail('raw', 'invalid_envelope', raw);
  }
}

interface Cell {column: string; value: unknown; unit?: string}
interface ReadData extends Omit<SelectedQuoteReadRecord, 'cells'> {
  cells: readonly Cell[];
  byColumn: ReadonlyMap<string, Cell | null>;
}
interface Component {
  spec: PreparedQuoteSpec;
  part: PreparedEvidenceQuotePart;
  reason?: EvidenceQuoteUnavailableReason;
  reads: ReadonlyMap<string, ReadData | null>;
}
function selection(value: unknown): EvidenceQuoteSelection {
  const data = dataObject(value, ['viewId', 'rows', 'columns', 'page']);
  const page = dataObject(data.page, ['visibleRows', 'hasMore', 'coverage']);
  const rows = indices(data.rows), columns = strings(data.columns);
  if (!nonempty(data.viewId) || !safeIndex(page.visibleRows) || new Set(columns).size !== columns.length ||
      (page.hasMore !== 'yes' && page.hasMore !== 'no' && page.hasMore !== 'unknown') || page.coverage !== 'visible_page_only') throw new InvalidMaterial();
  // Assembly is synchronous and these are descriptor-checked arrays. Detach them
  // only after the complete derived graph passes its material preflight.
  return {viewId: data.viewId, rows, columns,
    page: {visibleRows: page.visibleRows, hasMore: page.hasMore, coverage: 'visible_page_only'}};
}
function partData(value: unknown, spec: PreparedQuoteSpec): PreparedEvidenceQuotePart {
  const data = dataObject(value, ['partIndex', 'quoteId', 'fidelity', 'selection', 'readKeys'], ['reason']);
  const selected = selection(data.selection), readKeys = strings(data.readKeys);
  if (data.partIndex !== spec.partIndex || data.quoteId !== spec.quote.id || selected.viewId !== spec.quote.viewId ||
      (data.fidelity !== 'matched' && data.fidelity !== 'unavailable') ||
      (data.reason !== undefined && !unavailableReasons.includes(data.reason as EvidenceQuoteUnavailableReason)) ||
      (data.fidelity === 'matched' && data.reason !== undefined) ||
      (data.fidelity === 'unavailable' && data.reason === undefined) ||
      selected.columns.length !== spec.quote.fields.length || selected.columns.some((column, index) => column !== spec.quote.fields[index].column)) {
    throw new InvalidMaterial();
  }
  if (spec.quote.rows.kind === 'indices') {
    const expectedRows = spec.quote.rows.indices;
    if (selected.rows.length !== expectedRows.length || selected.rows.some((row, index) => row !== expectedRows[index])) {
      throw new InvalidMaterial();
    }
  }
  if (data.fidelity === 'matched' && (selected.rows.length > selected.page.visibleRows ||
      spec.quote.rows.kind === 'all_visible' && selected.rows.length !== selected.page.visibleRows)) throw new InvalidMaterial();
  return {partIndex: spec.partIndex, quoteId: spec.quote.id, fidelity: data.fidelity, selection: selected,
    readKeys, ...(data.reason ? {reason: data.reason as EvidenceQuoteUnavailableReason} : {})};
}
function readData(value: unknown): ReadData {
  const data = dataObject(value, ['key', 'locator', 'traceSide', 'cells'], ['rowIndex', 'metadataOnly']);
  const locator = dataObject(data.locator, [], ['artifactId', 'evidenceRefId']);
  const locatorId = Object.values(locator)[0];
  if (!nonempty(data.key) || Object.keys(locator).length !== 1 || !nonempty(locatorId) ||
      (data.traceSide !== 'current' && data.traceSide !== 'reference') ||
      (data.rowIndex !== undefined && !safeIndex(data.rowIndex)) ||
      (data.metadataOnly !== undefined && data.metadataOnly !== true)) throw new InvalidMaterial();
  const cells = dataArray(data.cells).map(value => {
    const cell = dataObject(value, ['column', 'value'], ['unit']);
    if (!nonempty(cell.column) || cell.unit !== undefined && typeof cell.unit !== 'string') throw new InvalidMaterial();
    return {column: cell.column, value: cell.value, ...(cell.unit === undefined ? {} : {unit: cell.unit as string})};
  });
  const byColumn = new Map<string, Cell | null>();
  for (const cell of cells) {
    byColumn.set(cell.column, byColumn.has(cell.column) ? null : cell);
  }
  const capturedLocator = own(locator, 'artifactId') ? {artifactId: locatorId} : {evidenceRefId: locatorId};
  return {key: data.key, locator: capturedLocator, traceSide: data.traceSide, cells, byColumn,
    ...(data.rowIndex === undefined ? {} : {rowIndex: data.rowIndex as number}),
    ...(data.metadataOnly === undefined ? {} : {metadataOnly: true})};
}
function locatorText(record: ReadData): string {
  return 'artifactId' in record.locator ? record.locator.artifactId : record.locator.evidenceRefId;
}
function sameLocator(left: ReadData, right: ReadData): boolean {
  return left.traceSide === right.traceSide && Object.keys(left.locator)[0] === Object.keys(right.locator)[0] && locatorText(left) === locatorText(right);
}
interface FormattedCell {number: string; raw: string; unit: string; suffix: string; approximate: boolean}
function formatCell(cell: Cell, format: QuoteFormat): FormattedCell | EvidenceQuoteUnavailableReason {
  const source = claimUnitFor(cell.unit);
  const target = format.kind === 'numeric' ? claimUnitFor(format.unit) : undefined;
  if (format.kind === 'numeric') {
    if (!source || !target) return 'unit_unknown';
    if (source.dimension !== target.dimension && !declaredUnitAcceptsProducerDimension(format.unit, source.dimension)) return 'unit_dimension_mismatch';
    if (!Number.isSafeInteger(format.decimalPlaces) || format.decimalPlaces < 0 || format.decimalPlaces > 18) return 'invalid_precision';
  }
  if (cell.value === null) return {number: 'NULL', raw: 'NULL', unit: cell.unit ?? 'unknown', suffix: '', approximate: false};
  // Raw transport eligibility and exact arithmetic eligibility are different.
  // A finite JSON-stable Number is already a captured value, even above the
  // safe-integer arithmetic limit. -0 cannot regain B's rejected visibility.
  if (typeof cell.value === 'number' && (!Number.isFinite(cell.value) || Object.is(cell.value, -0))) return 'unsupported_cell';
  if (format.kind === 'raw') {
    if (typeof cell.value !== 'number' && (typeof cell.value !== 'string' || !exactNumber(cell.value))) return 'unsupported_cell';
    const raw = String(cell.value);
    return {number: raw, raw, unit: cell.unit ?? 'unknown', suffix: '', approximate: false};
  }
  const value = exactNumber(cell.value);
  if (!value) return 'unsupported_cell';
  const raw = String(cell.value);
  // The explicit unit checks above establish both scales without a column-name inference.
  if (!source || !target) return 'unit_unknown';
  if (countedUnitDimension(cell.unit) && (format.decimalPlaces !== 0 || value.numerator % value.denominator !== 0n)) return 'discrete_format_required';
  const numerator = value.numerator * source.numerator * target.denominator;
  const denominator = value.denominator * source.denominator * target.numerator;
  const scaled = numerator * 10n ** BigInt(format.decimalPlaces);
  const magnitude = scaled < 0n ? -scaled : scaled;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  const digits = rounded.toString().padStart(format.decimalPlaces + 1, '0');
  const number = format.decimalPlaces === 0 ? digits : `${digits.slice(0, -format.decimalPlaces)}.${digits.slice(-format.decimalPlaces)}`;
  return {number: `${scaled < 0n && rounded !== 0n ? '-' : ''}${number}`, raw, unit: cell.unit!,
    suffix: ` ${format.unit}`, approximate: magnitude !== rounded * denominator};
}
function resolveComponent(spec: PreparedQuoteSpec, part: PreparedEvidenceQuotePart,
  reads: ReadonlyMap<string, ReadData | null>): Component {
  const unavailable = (reason: EvidenceQuoteUnavailableReason): Component => ({spec, part, reason, reads});
  if (part.fidelity === 'unavailable') return unavailable(part.reason!);
  const expectedReads = Math.max(1, part.selection.rows.length);
  if (part.readKeys.length !== expectedReads || new Set(part.readKeys).size !== part.readKeys.length) return unavailable('read_unavailable');
  let first: ReadData | undefined;
  for (const [index, key] of part.readKeys.entries()) {
    const record = reads.get(key);
    if (!record) return unavailable('read_unavailable');
    if (first && !sameLocator(first, record)) return unavailable('binding_mismatch');
    first ??= record;
    if (!part.selection.rows.length) {
      if (record.metadataOnly !== true || record.rowIndex !== undefined || record.cells.length) return unavailable('binding_mismatch');
      continue;
    }
    if (record.metadataOnly || record.rowIndex !== part.selection.rows[index]) return unavailable('binding_mismatch');
    for (const field of spec.quote.fields) {
      const found = record.byColumn.get(field.column);
      if (!found) return unavailable('read_unavailable');
      const formatted = formatCell(found, field.format);
      if (typeof formatted === 'string') return unavailable(formatted);
    }
  }
  return {spec, part, reads};
}

function* componentReads(component: Component): Generator<ReadData> {
  if (component.reason) return;
  for (const key of component.part.readKeys) {
    const record = component.reads.get(key);
    if (!record) throw new InvalidMaterial();
    yield record;
  }
}

// These plans are created only inside this module. There is no caller-supplied renderer or iterator.
class TextPlan {
  constructor(readonly chunks: () => Iterable<string>) {}
}
class ListPlan {
  constructor(readonly items: () => Iterable<unknown>) {}
}
function* textChunks(value: string | TextPlan): Generator<string> {
  if (typeof value === 'string') yield value;
  else yield* value.chunks();
}
function textLength(value: string | TextPlan): number {
  let length = 0;
  for (const chunk of textChunks(value)) length += chunk.length;
  return length;
}
function escaped(value: string): TextPlan {
  return new TextPlan(function* () {
    for (const character of value) {
      if (character === '&') yield '&amp;';
      else if (character === '<') yield '&lt;';
      else if (character === '>') yield '&gt;';
      else if (character === '|') yield '&#124;';
      else if (character === '\n') yield '<br>';
      else if (character === '\r') yield '&#13;';
      else if (/[\\`*_\[\]()#!]/.test(character)) yield `\\${character}`;
      else yield character;
    }
  });
}
interface Fragment {
  kind: 'data' | 'context' | 'heading';
  text: string | TextPlan;
  readKey?: string;
}
const heading = '### 证据摘录 / Evidence excerpt\n';
const tableHeader = '| rowIndex | field | display | raw | producer unit |\n|---|---|---|---|---|\n';
function* fragments(component: Component): Generator<Fragment> {
  yield {kind: 'context', text: '\n\n'};
  yield {kind: 'heading', text: heading};
  if (component.reason) {
    yield {kind: 'context', text: '摘录不可用 / Excerpt unavailable.\n\n'};
    return;
  }
  const first = component.reads.get(component.part.readKeys[0]);
  if (!first) throw new InvalidMaterial();
  const selected = component.part.selection;
  yield {kind: 'context', text: 'Source '};
  yield {kind: 'context', text: escaped(locatorText(first))};
  yield {kind: 'context', text: ` · trace side ${first.traceSide} · identity unknown · window unknown.\n` +
    `Visible page ${selected.page.visibleRows} rows · selected ${selected.rows.length} rows · hasMore ${selected.page.hasMore} · coverage visible_page_only.\n`};
  if (!selected.rows.length) {
    yield {kind: 'context', text: '未选择行 / No rows selected. This does not establish an empty result or population.\n\n'};
    return;
  }
  yield {kind: 'context', text: tableHeader};
  for (const record of componentReads(component)) {
    for (const field of component.spec.quote.fields) {
      const cell = record.byColumn.get(field.column);
      if (!cell) throw new InvalidMaterial();
      const formatted = formatCell(cell, field.format);
      if (typeof formatted === 'string') throw new InvalidMaterial();
      yield {kind: 'context', text: `| ${record.rowIndex} | `};
      yield {kind: 'context', text: escaped(field.column)};
      yield {kind: 'context', text: ' | '};
      if (formatted.approximate) yield {kind: 'context', text: '≈ '};
      yield {kind: 'data', text: formatted.number, readKey: record.key};
      if (formatted.suffix) yield {kind: 'context', text: escaped(formatted.suffix)};
      yield {kind: 'context', text: ' | '};
      yield {kind: 'data', text: formatted.raw, readKey: record.key};
      yield {kind: 'context', text: ' | '};
      yield {kind: 'context', text: escaped(formatted.unit)};
      yield {kind: 'context', text: ' |\n'};
    }
  }
  yield {kind: 'context', text: '\n'};
}
function componentText(component: Component): TextPlan {
  return new TextPlan(function* () {
    for (const fragment of fragments(component)) yield* textChunks(fragment.text);
  });
}
interface BodyPart {
  partIndex: number;
  origin: AuthoredEvidenceOriginSpan['origin'];
  text: string | TextPlan;
  component?: Component;
}
function bodyParts(document: Row, components: readonly Component[]): {parts: BodyPart[]; unresolvedModelPart: boolean} {
  const byPart = new Map(components.map(component => [component.spec.partIndex, component]));
  const claims = new Map<string, unknown | null>();
  const contract = document.contract;
  if (contract !== null && typeof contract === 'object' && !Array.isArray(contract)) {
    const rawClaims = (contract as Row).claims;
    if (Array.isArray(rawClaims)) {
      for (const claim of rawClaims) {
        if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) continue;
        const raw = claim as Row;
        if (typeof raw.id !== 'string') continue;
        claims.set(raw.id, claims.has(raw.id) ? null : raw.text);
      }
    }
  }
  let unresolvedModelPart = false;
  const parts = dataArray(document.bodyParts).map((value, partIndex): BodyPart => {
    const component = byPart.get(partIndex);
    if (component) return {partIndex, origin: 'program_evidence_quote', component, text: componentText(component)};
    if (typeof value === 'string') return {partIndex, origin: 'model_literal', text: value};
    const raw = value as Row;
    const text = claims.get(raw.claimText as string);
    if (typeof text !== 'string') unresolvedModelPart = true;
    // An unresolved model part can only reach the original compiler's failure path.
    // The original {claimText} is never replaced in its actual input.
    return {partIndex, origin: 'model_claim_text', text: typeof text === 'string' ? text : ''};
  });
  return {parts, unresolvedModelPart};
}
function* originPlans(parts: readonly BodyPart[]): Generator<AuthoredEvidenceOriginSpan> {
  let startUtf16 = 0;
  for (const part of parts) {
    const endUtf16 = startUtf16 + textLength(part.text);
    yield {partIndex: part.partIndex, origin: part.origin, startUtf16, endUtf16,
      ...(part.component ? {quoteId: part.component.spec.quote.id} : {})};
    startUtf16 = endUtf16;
  }
}
function spanPlan(component: Component, start: number, kind: Fragment['kind']): ListPlan {
  return new ListPlan(function* () {
    let at = start;
    for (const fragment of fragments(component)) {
      const end = at + textLength(fragment.text);
      if (end > at && fragment.kind === kind) {
        yield {startUtf16: at, endUtf16: end, ...(kind === 'data' ? {readKey: fragment.readKey!} : {})};
      }
      at = end;
    }
  });
}
function* occurrencePlans(parts: readonly BodyPart[]): Generator<unknown> {
  let start = 0;
  for (const part of parts) {
    const end = start + textLength(part.text), component = part.component;
    if (component) {
      yield {quoteId: component.spec.quote.id, partIndex: part.partIndex, startUtf16: start, endUtf16: end,
        fidelity: component.reason ? 'unavailable' : 'matched', ...(component.reason ? {reason: component.reason} : {}),
        selection: component.part.selection, readKeys: component.part.readKeys,
        dataSpans: spanPlan(component, start, 'data'), contextSpans: spanPlan(component, start, 'context'),
        headingSpans: spanPlan(component, start, 'heading')};
    }
    start = end;
  }
}
function selectedRecords(components: readonly Component[]): ListPlan {
  const selected = new Map<string, {record: ReadData; cells: Map<string, Cell>}>();
  for (const component of components) {
    if (component.reason) continue;
    for (const record of componentReads(component)) {
      let retained = selected.get(record.key);
      if (!retained) {
        retained = {record, cells: new Map()};
        selected.set(record.key, retained);
      }
      for (const field of component.spec.quote.fields) {
        if (record.metadataOnly) continue;
        const cell = record.byColumn.get(field.column);
        if (!cell) throw new InvalidMaterial();
        retained.cells.set(cell.column, cell);
      }
    }
  }
  return new ListPlan(function* () {
    for (const {record, cells} of selected.values()) {
      yield {key: record.key, locator: record.locator, traceSide: record.traceSide,
        ...(record.rowIndex === undefined ? {} : {rowIndex: record.rowIndex}),
        ...(record.metadataOnly ? {metadataOnly: true} : {}), cells: new ListPlan(() => cells.values())};
    }
  });
}

/** Exact material of internal lazy graphs; no escaped large strings or repeated arrays are allocated here. */
function measurePlan(root: unknown): AuthoringMaterial {
  const limits = CONCLUSION_AUTHORING_LIMITS;
  const result: AuthoringMaterial = {utf8Bytes: 0, nodes: 0, depth: 0};
  const bytes = (amount: number) => {
    result.utf8Bytes = Math.min(limits.utf8Bytes + 1, result.utf8Bytes + amount);
    if (result.utf8Bytes > limits.utf8Bytes) throw new MaterialOverflow('bytes');
  };
  const string = (value: string | TextPlan) => {
    bytes(2);
    let pendingHigh = false;
    for (const chunk of textChunks(value)) {
      for (let index = 0; index < chunk.length; index++) {
        const code = chunk.charCodeAt(index);
        if (pendingHigh) {
          pendingHigh = false;
          if (code >= 0xdc00 && code <= 0xdfff) {
            bytes(4);
            continue;
          }
          bytes(6);
        }
        if (code >= 0xd800 && code <= 0xdbff) pendingHigh = true;
        else if (code >= 0xdc00 && code <= 0xdfff) bytes(6);
        else if (code === 34 || code === 92) bytes(2);
        else if (code < 32) bytes([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
        else if (code < 128) bytes(1);
        else if (code < 2048) bytes(2);
        else bytes(3);
      }
    }
    if (pendingHigh) bytes(6);
  };
  const visit = (value: unknown, depth: number): void => {
    result.nodes = Math.min(limits.nodes + 1, result.nodes + 1);
    result.depth = Math.min(limits.depth + 1, Math.max(result.depth, depth));
    if (result.nodes > limits.nodes) throw new MaterialOverflow('nodes');
    if (result.depth > limits.depth) throw new MaterialOverflow('depth');
    if (typeof value === 'string' || value instanceof TextPlan) {
      string(value);
    } else if (Array.isArray(value) || value instanceof ListPlan) {
      bytes(2);
      let first = true;
      const items = value instanceof ListPlan ? value.items() : value;
      for (const item of items) {
        if (!first) bytes(1);
        first = false;
        visit(item, depth + 1);
      }
    } else if (value !== null && typeof value === 'object') {
      bytes(2);
      let first = true;
      for (const [key, child] of Object.entries(value)) {
        if (!first) bytes(1);
        first = false;
        string(key);
        bytes(1);
        visit(child, depth + 1);
      }
    } else if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      bytes(JSON.stringify(value).length);
    } else {
      throw new InvalidMaterial();
    }
  };
  visit(root, 1);
  return result;
}
function materialize(value: unknown): unknown {
  if (value instanceof TextPlan) return [...value.chunks()].join('');
  if (value instanceof ListPlan) return [...value.items()].map(materialize);
  if (Array.isArray(value)) return value.map(materialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
  }
  return value;
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deeplyFrozen);
}

/**
 * Deterministic ordinary composition only. The run context must separately bind
 * the producing request, actual reads, shared session and final native issuance.
 */
export function assembleAuthoredEvidenceDocument(prepared: PreparedAuthoredEvidenceDocument, material: {
  quoteParts: readonly PreparedEvidenceQuotePart[];
  selectedReadSnapshot: readonly SelectedQuoteReadRecord[];
}): AuthoredEvidenceDocumentResult {
  let raw: unknown;
  try {
    const input = dataObject(prepared, ['status', 'privateNativeDocument', 'rawMaterial', 'quotes']);
    raw = input.privateNativeDocument;
    const rawMaterial = measureAuthoredJson(raw);
    const rejected = rawFailure(rawMaterial, raw);
    if (rejected) return rejected;
    if (input.status !== 'prepared' || !deeplyFrozen(raw)) throw new InvalidMaterial();
    const document = dataObject(raw, ['representationVersion', 'referenceDictionary', 'semanticFrames', 'contract', 'bodyParts']);
    if (document.representationVersion !== AUTHORED_EVIDENCE_DOCUMENT_VERSION) return fail('raw', 'unsupported_version', raw);
    // Derive specs again from the immutable document; caller-supplied stage metadata is not trusted.
    const specs = quoteSpecs(document);
    const supplied = dataObject(material, ['quoteParts', 'selectedReadSnapshot']);
    const quoteParts = dataArray(supplied.quoteParts);
    if (quoteParts.length !== specs.length) throw new InvalidMaterial();
    const parts: PreparedEvidenceQuotePart[] = [];
    for (const [index, spec] of specs.entries()) {
      const part = partData(quoteParts[index], spec);
      parts.push(part);
    }
    // These closed fields occur in every quoteOccurrence. A later formatting
    // failure only lengthens fidelity and adds its reason, so this is a lower
    // material bound. Arrays remain borrowed until the full graph is admitted.
    measurePlan(parts);
    const reads = new Map<string, ReadData | null>();
    const neededReadKeys = new Set<string>();
    for (const part of parts) {
      if (part.fidelity === 'matched') {
        for (const key of part.readKeys) neededReadKeys.add(key);
      }
    }
    let readPlanNodes = 0;
    for (const value of dataArray(supplied.selectedReadSnapshot)) {
      // Count the actual input read-plan cells before making their bounded private descriptors.
      const header = dataObject(value, ['key', 'locator', 'traceSide', 'cells'], ['rowIndex', 'metadataOnly']);
      if (!nonempty(header.key)) throw new InvalidMaterial();
      if (!neededReadKeys.has(header.key)) continue;
      readPlanNodes = Math.min(CONCLUSION_AUTHORING_LIMITS.nodes + 1,
        readPlanNodes + 1 + dataArray(header.cells).length);
      if (readPlanNodes > CONCLUSION_AUTHORING_LIMITS.nodes) throw new MaterialOverflow('nodes');
      const record = readData(value);
      reads.set(record.key, reads.has(record.key) ? null : record);
    }
    // Components retain only the shared read index and selection keys. Rows,
    // cells, spans and quote occurrences are not copied per component here.
    const components = specs.map((spec, index) => resolveComponent(spec, parts[index], reads));
    const planned = bodyParts(document, components);
    const body = new TextPlan(function* () {
      for (const part of planned.parts) yield* textChunks(part.text);
    });
    const graph = {body, originSpans: new ListPlan(() => originPlans(planned.parts)),
      quoteOccurrences: new ListPlan(() => occurrencePlans(planned.parts)), selectedReadSnapshot: selectedRecords(components)};
    const derivedMaterial = measurePlan(graph);
    const assembled = materialize(graph) as {body: string; originSpans: AuthoredEvidenceOriginSpan[];
      quoteOccurrences: AuthoredEvidenceQuoteOccurrence[]; selectedReadSnapshot: SelectedQuoteReadRecord[]};
    const byPart = new Map(components.map(component => [component.spec.partIndex, component]));
    const internalModelDocument = {...document, representationVersion: AUTHORED_CLAIM_OBJECT_VERSION,
      bodyParts: dataArray(document.bodyParts).map((part, index) => {
        const component = byPart.get(index);
        return component ? materialize(componentText(component)) : part;
      })};
    const modelCompiled = compileAuthoredClaimObject(internalModelDocument);
    if (modelCompiled.status === 'projection_failed') {
      return fail('compiler', modelCompiled.code, raw, modelCompiled.compilerFailureLocation);
    }
    // No placeholder or alternative body can escape the original complete compiler.
    if (planned.unresolvedModelPart || modelCompiled.body !== assembled.body) return fail('compiler', 'invalid_body_part', raw);
    const aggregate = {body: modelCompiled.body, rawCanonicalPayload: modelCompiled.rawCanonicalPayload,
      originSpans: assembled.originSpans, quoteOccurrences: assembled.quoteOccurrences,
      selectedReadSnapshot: assembled.selectedReadSnapshot};
    const finalMaterial = measureAuthoredJson(aggregate);
    if (typeof finalMaterial === 'string') {
      if (finalMaterial === 'non_json_value') return fail('final', 'non_json_value', raw);
      return fail('final', `${finalMaterial}_exceeded`, raw);
    }
    const frozenAggregate = deepFreeze(structuredClone(aggregate));
    // Keep the original canonicalParse object: its private parser state must not be lost to a JSON/clone transport.
    return deepFreeze({status: 'composed' as const, representationVersion: AUTHORED_EVIDENCE_DOCUMENT_VERSION,
      compilerVersion: AUTHORED_EVIDENCE_DOCUMENT_COMPILER_VERSION, rendererVersion: AUTHORED_EVIDENCE_RENDERER_VERSION,
      privateNativeDocument: raw as Row, internalModelDocument, modelCompiled, ...frozenAggregate,
      resourcePhases: {raw: rawMaterial as AuthoringMaterial, derived: derivedMaterial,
        compiler: modelCompiled.material.expanded, final: finalMaterial}});
  } catch (error) {
    if (error instanceof MaterialOverflow) return fail('derived', `${error.axis}_exceeded`, raw);
    return fail('derived', 'invalid_structure', raw);
  }
}
