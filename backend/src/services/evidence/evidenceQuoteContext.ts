// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {randomBytes} from 'crypto';
import {isDeepStrictEqual, types} from 'util';
import type {ArtifactStore} from '../../agentv3/artifactStore';
import type {SceneEvidencePromptData} from '../../agentRuntime/sceneEntryEvidence';
import {matchesSceneQuotePromptSeal, readSceneQuotePromptSeal} from '../../agentv3/claudeSystemPrompt';
import {readRuntimeToolQuotePayload, readRuntimeToolQuoteProjection} from '../../agentRuntime/runtimeToolResult';
import {isVisibleQuoteScalar, snapshotQuoteProjectionScope, type PreparedQuoteProjectionBinding,
  type QuoteLocator, type QuoteProjectedCell, type QuoteProjectedPage, type QuoteProjectionScope} from './modelEvidenceMetadata';

type Row = Record<string, unknown>;
export interface PreparedQuoteView {readonly kind: 'prepared_quote_view'}
export interface PreparedToolQuoteProjection {readonly kind: 'prepared_tool_quote_projection'}
export type QuoteViewAddress = {viewId: string} & QuoteLocator;
export type ModelQuoteViewDescriptor = QuoteViewAddress & {
  rows: number[]; columns: string[]; page: {hasMore: 'yes' | 'no' | 'unknown'; coverage: 'visible_page_only'};
};
export interface ToolQuoteCallBinding {
  responseId: string; callId: string; nativeName: string; rawArguments: string;
  sdkArguments: unknown; normalizedArguments: unknown; collector: object; collectorDispatchOrdinal: number;
}
interface ViewState {id: string; locator: QuoteLocator; page: QuoteProjectedPage; binding: PreparedQuoteProjectionBinding}
interface ToolSource {locator: QuoteLocator; page: QuoteProjectedPage}
interface ToolState {payload: object; descriptorJson: string; sources: readonly {index: number; view: ViewState}[]; views: readonly ViewState[]}
interface SceneState {json: string; views: readonly ViewState[]}
interface ToolSeal {token: object; tool: object; call: ToolQuoteCallBinding; output: string; views: readonly ViewState[]}
interface SceneSeal {token: object; fullPrompt: string; views: readonly ViewState[]}

function properties(value: unknown, allowed?: readonly string[]): PropertyDescriptorMap | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || allowed && !allowed.includes(key))) return undefined;
  return Object.getOwnPropertyDescriptors(value);
}
function field(properties: PropertyDescriptorMap, key: string): unknown {
  const entry = Object.getOwnPropertyDescriptor(properties, key)?.value as PropertyDescriptor | undefined;
  return entry && 'value' in entry ? entry.value : undefined;
}
function array(value: unknown): unknown[] | undefined {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 ||
      Reflect.ownKeys(value).length !== length + 1) return undefined;
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return undefined;
    values.push(descriptor.value);
  }
  return values;
}
function locatorSnapshot(value: unknown): QuoteLocator | undefined {
  const data = properties(value, ['artifactId', 'evidenceRefId']);
  if (!data || Object.keys(data).length !== 1) return undefined;
  const key = Object.keys(data)[0], id = field(data, key);
  if (typeof id !== 'string' || !id.trim()) return undefined;
  return Object.freeze(key === 'artifactId' ? {artifactId: id} : {evidenceRefId: id});
}
function pageSnapshot(value: unknown): QuoteProjectedPage | undefined {
  const data = properties(value, ['rows', 'columns', 'cells', 'page']);
  if (!data) return undefined;
  const rows = array(field(data, 'rows')), columns = array(field(data, 'columns')), cells = array(field(data, 'cells'));
  const page = properties(field(data, 'page'), ['hasMore', 'coverage']);
  if (!rows || !columns || !cells || !page || rows.some(row => typeof row !== 'number' || !Number.isSafeInteger(row) || row < 0) ||
      columns.some(column => typeof column !== 'string' || !column.trim()) ||
      new Set(rows).size !== rows.length || new Set(columns).size !== columns.length) return undefined;
  const rowSet = new Set(rows), columnSet = new Set(columns);
  const hasMore = field(page, 'hasMore');
  if ((hasMore !== 'yes' && hasMore !== 'no' && hasMore !== 'unknown') || field(page, 'coverage') !== 'visible_page_only') return undefined;
  const normalized: QuoteProjectedCell[] = [], seen = new Map<number, Set<string>>();
  for (const item of cells) {
    const cell = properties(item, ['rowIndex', 'column', 'value', 'unit', 'availability']);
    if (!cell) return undefined;
    const rowIndex = field(cell, 'rowIndex'), column = field(cell, 'column'), availability = field(cell, 'availability'), unit = field(cell, 'unit');
    const unitDescriptor = Object.getOwnPropertyDescriptor(cell, 'unit')?.value as PropertyDescriptor | undefined;
    if (typeof rowIndex !== 'number' || !rowSet.has(rowIndex) || typeof column !== 'string' || !columnSet.has(column) ||
        seen.get(rowIndex)?.has(column) || (availability !== 'visible' && availability !== 'unavailable' && availability !== 'redacted') ||
        (unitDescriptor && !('value' in unitDescriptor)) || (unit !== undefined && typeof unit !== 'string')) return undefined;
    const used = seen.get(rowIndex) ?? new Set<string>(); used.add(column); seen.set(rowIndex, used);
    // Ineligible values are never accessed, traversed or copied into private state.
    const value = availability === 'visible' ? field(cell, 'value') : undefined;
    if (availability === 'visible' && !isVisibleQuoteScalar(value)) return undefined;
    normalized.push(Object.freeze({rowIndex, column, value, availability, ...(unit === undefined ? {} : {unit})}));
  }
  return Object.freeze({rows: Object.freeze(rows as number[]), columns: Object.freeze(columns as string[]),
    cells: Object.freeze(normalized), page: Object.freeze({hasMore, coverage: 'visible_page_only'})});
}

/** Copy only the required program/closed call facts; never getters, iterators or callbacks. */
function snapshot(value: unknown): unknown {
  const ancestors = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) throw new Error('quote_data_unavailable');
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const items = array(value); if (!items) throw new Error('quote_data_unavailable');
      result = items.map(item => copy(item));
    } else {
      const data = properties(value); if (!data) throw new Error('quote_data_unavailable');
      const entries: Array<[string, unknown]> = [];
      for (const key of Object.keys(data)) {
        const descriptor = Object.getOwnPropertyDescriptor(data, key)!.value as PropertyDescriptor;
        if (!('value' in descriptor)) throw new Error('quote_data_unavailable');
        if (key === 'toJSON' && typeof descriptor.value === 'function') throw new Error('quote_data_unavailable');
        if (!descriptor.enumerable) continue;
        entries.push([key, copy(descriptor.value)]);
      }
      result = Object.fromEntries(entries);
    }
    ancestors.delete(value);
    return Object.freeze(result);
  };
  try {return copy(value);} catch {return undefined;}
}
/** Shallow own-data access only; unrelated schema/history graphs are never cloned. */
function row(value: unknown): Row | undefined {
  const data = properties(value); if (!data) return undefined;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(data)) {
    const descriptor = Object.getOwnPropertyDescriptor(data, key)!.value as PropertyDescriptor;
    if (!('value' in descriptor) || key === 'toJSON' && typeof descriptor.value === 'function') return undefined;
    if (descriptor.enumerable) entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}
function address(view: ViewState): QuoteViewAddress {return {viewId: view.id, ...view.locator};}
function descriptor(view: ViewState): ModelQuoteViewDescriptor {
  return {...address(view), rows: [...view.page.rows], columns: [...view.page.columns], page: {...view.page.page}};
}
function pageFromRows(rawColumns: unknown, rawRows: unknown, units: unknown, indexed: boolean, hasMore: unknown): QuoteProjectedPage | undefined {
  const columns = array(rawColumns), rows = array(rawRows);
  if (!columns || columns.some(column => typeof column !== 'string') || !rows) return undefined;
  const projectedRows: number[] = [], cells: QuoteProjectedCell[] = [], columnUnits = row(units);
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const entry = indexed ? row(rows[ordinal]) : undefined;
    const rowIndex = indexed ? entry?.rowIndex : ordinal;
    const values = array(indexed ? entry?.values : rows[ordinal]);
    if (typeof rowIndex !== 'number' || !Number.isSafeInteger(rowIndex) || rowIndex < 0 || !values || values.length !== columns.length) return undefined;
    projectedRows.push(rowIndex);
    (columns as string[]).forEach((column, index) => {
      const value = values[index], unit = columnUnits?.[column], visible = isVisibleQuoteScalar(value);
      cells.push({rowIndex, column, value: visible ? value : undefined,
        availability: visible ? 'visible' : 'unavailable', ...(typeof unit === 'string' ? {unit} : {})});
    });
  }
  return {rows: projectedRows, columns: columns as string[], cells,
    page: {hasMore: typeof hasMore === 'boolean' ? hasMore ? 'yes' : 'no' : 'unknown', coverage: 'visible_page_only'}};
}
function payloadLocator(payload: Row): QuoteLocator | undefined {
  for (const name of ['artifactId', 'sourceArtifactId', 'id'] as const) {
    const id = payload[name]; if (typeof id === 'string') return {artifactId: id};
  }
  return typeof payload.evidenceRefId === 'string' ? {evidenceRefId: payload.evidenceRefId} : undefined;
}

/** Only the producer's existing displayed table shapes, never derived aggregate values. */
function toolSources(payload: Row): ToolSource[] {
  const sources: ToolSource[] = [];
  const add = (locator: QuoteLocator | undefined, page: QuoteProjectedPage | undefined) => {
    if (locator && page) sources.push({locator, page});
  };
  const table = (value: Row, locator: QuoteLocator | undefined, units: unknown) => {
    const summary = row(value.summary), data = row(value.data), preview = row(value.preview);
    if (Array.isArray(value.sampleRows)) add(locator, pageFromRows(value.columns, value.sampleRows, units, true, undefined));
    else if (summary && Array.isArray(summary.sampleRows)) add(locator, pageFromRows(summary.columns, summary.sampleRows, units, true, undefined));
    else if (Array.isArray(value.rows)) add(locator, pageFromRows(value.columns, value.rows, units, value.rowShape === 'indexed_rows@1', value.hasMore));
    else if (data && Array.isArray(data.rows)) add(locator, pageFromRows(data.columns, data.rows, units, false, value.truncated === true ? true : undefined));
    else if (Array.isArray(value.sampleRow)) add(locator, pageFromRows(value.columns, [value.sampleRow], units, false, undefined));
    else if (preview) add(locator, pageFromRows(Object.keys(preview), [Object.values(preview)], units, false, undefined));
  };
  table(payload, payloadLocator(payload), payload.columnUnits);
  const artifact = row(payload.artifact);
  if (artifact?.preview && !artifact.previewOmitted) table(artifact, payloadLocator(artifact), artifact.columnUnits);
  const artifacts = array(payload.artifacts);
  if (artifacts) for (const item of artifacts) {
    const artifact = row(item); if (artifact?.preview && !artifact.previewOmitted) table(artifact, payloadLocator(artifact), artifact.columnUnits);
  }
  return sources;
}
function sameVisiblePage(expected: QuoteProjectedPage, actual: QuoteProjectedPage): boolean {
  return isDeepStrictEqual(expected.rows, actual.rows) && isDeepStrictEqual(expected.columns, actual.columns) &&
    isDeepStrictEqual(expected.page, actual.page) && expected.cells.length === actual.cells.length && expected.cells.every((cell, index) => {
      const found = actual.cells[index];
      return cell.rowIndex === found.rowIndex && cell.column === found.column && cell.unit === found.unit &&
        (cell.availability !== 'visible' || found.availability === 'visible' && Object.is(cell.value, found.value));
    });
}

/** Run-bound preparation only. D must bind observations to actual native attempt/response tickets. */
export function createEvidenceQuoteContext(options: {store: ArtifactStore; scope: QuoteProjectionScope; assertCurrent(): void;
  productSignal: AbortSignal; deadlineAtMs: number}) {
  const scope = snapshotQuoteProjectionScope(options.scope), store = options.store;
  const signal = options.productSignal, deadlineAtMs = options.deadlineAtMs, assertCurrent = options.assertCurrent;
  if (!scope || !Number.isFinite(deadlineAtMs)) throw new Error('quote_context_invalid');
  let disposed = false;
  let prepared = new WeakMap<object, ViewState>(), bundles = new WeakMap<object, ToolState>(), scenes = new WeakMap<object, SceneState>();
  let requests = new WeakMap<object, {ordinal: number; views: ReadonlyMap<string, ViewState>}>();
  const toolSeals: ToolSeal[] = [], sceneSeals: SceneSeal[] = [];
  const ids = new Set<string>();
  const guard = () => {
    signal.throwIfAborted();
    if (disposed) throw new Error('quote_context_disposed');
    if (Date.now() >= deadlineAtMs) throw new DOMException('Quote deadline exceeded', 'AbortError');
    assertCurrent();
    signal.throwIfAborted();
    if (disposed) throw new Error('quote_context_disposed');
    if (Date.now() >= deadlineAtMs) throw new DOMException('Quote deadline exceeded', 'AbortError');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; signal.removeEventListener('abort', dispose);
    prepared = new WeakMap(); bundles = new WeakMap(); scenes = new WeakMap(); requests = new WeakMap();
    toolSeals.length = 0; sceneSeals.length = 0; ids.clear();
  };
  signal.addEventListener('abort', dispose, {once: true});
  if (signal.aborted) dispose();
  const prepareCapturedView = (capturedLocator: QuoteLocator, capturedPage: QuoteProjectedPage): PreparedQuoteView | undefined => {
    guard();
    const binding = store.prepareQuoteProjectionBinding(capturedLocator, {scope, page: capturedPage});
    guard();
    if (!binding) return undefined;
    let id: string; do {id = `q_${randomBytes(12).toString('base64url')}`;} while (ids.has(id));
    ids.add(id);
    const token: PreparedQuoteView = Object.freeze({kind: 'prepared_quote_view'});
    prepared.set(token, {id, locator: capturedLocator, page: capturedPage, binding});
    return token;
  };
  const prepareModelQuoteView = (locator: QuoteLocator, page: QuoteProjectedPage): PreparedQuoteView | undefined => {
    // All caller-owned input is captured before the first external guard (including a facade's guard).
    const capturedLocator = locatorSnapshot(locator), capturedPage = pageSnapshot(page);
    if (!capturedLocator || !capturedPage) {guard(); return undefined;}
    return prepareCapturedView(capturedLocator, capturedPage);
  };
  const prepareToolQuoteProjection = (payload: Row): {payload: Row; projection?: PreparedToolQuoteProjection} => {
    const captured = row(payload);
    // Freeze only the actual visible pages, before any owner/facade callback. Do not clone the payload graph.
    const sources = captured && captured.success !== false ? toolSources(captured).map(source => ({
      locator: locatorSnapshot(source.locator), page: pageSnapshot(source.page)})) : [];
    guard();
    if (!captured || captured.success === false) return {payload};
    const admitted: Array<{index: number; view: ViewState}> = [];
    sources.forEach((source, index) => {
      if (!source.locator || !source.page) return;
      const token = prepareCapturedView(source.locator, source.page), view = token && prepared.get(token);
      if (view) admitted.push(Object.freeze({index, view}));
    });
    if (!admitted.length) return {payload};
    const views = admitted.map(source => source.view), descriptors = views.map(descriptor);
    const outgoing = {...captured, quoteViews: descriptors};
    const projection: PreparedToolQuoteProjection = Object.freeze({kind: 'prepared_tool_quote_projection'});
    bundles.set(projection, {payload: outgoing, descriptorJson: JSON.stringify(descriptors), sources: Object.freeze(admitted), views: Object.freeze(views)});
    return {payload: outgoing, projection};
  };
  const prepareSceneQuoteProjection = <T extends SceneEvidencePromptData>(data: T, maxBytes: number): T & {quoteViews?: QuoteViewAddress[]} => {
    const original = row(data), captured = row(snapshot(original));
    if (!original || !captured || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {guard(); return data;}
    const groups = new Map<string, {locator: QuoteLocator; cells: QuoteProjectedCell[]}>();
    const addCell = (locator: QuoteLocator, cell: QuoteProjectedCell) => {
      const key = JSON.stringify(locator), group = groups.get(key) ?? {locator, cells: []};
      group.cells.push(cell); groups.set(key, group);
    };
    const cells = row(captured.cells);
    if (cells && isDeepStrictEqual(cells.fields, ['artifactId', 'rowIndex', 'column', 'value', 'unit'])) {
      for (const list of [cells.key, cells.summary, cells.selected]) if (Array.isArray(list)) for (const tuple of list) {
        if (!Array.isArray(tuple) || tuple.length !== 5 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'number' || typeof tuple[2] !== 'string') continue;
        const value = tuple[3], unit = tuple[4];
        addCell({artifactId: tuple[0]}, {rowIndex: tuple[1], column: tuple[2], value: isVisibleQuoteScalar(value) ? value : undefined,
          availability: isVisibleQuoteScalar(value) ? 'visible' : 'unavailable', ...(typeof unit === 'string' ? {unit} : {})});
      }
    }
    const native = row(captured.native), nativeRow = row(native?.row);
    if (native?.status === 'captured' && typeof native.evidenceRefId === 'string' && native.rowIndex === 0 && nativeRow) {
      const units = row(native.columnUnits);
      for (const column of ['id', 'ts', 'dur', 'track_id']) {
        const value = nativeRow[column], unit = units?.[column];
        addCell({evidenceRefId: native.evidenceRefId}, {rowIndex: 0, column, value: isVisibleQuoteScalar(value) ? value : undefined,
          availability: isVisibleQuoteScalar(value) ? 'visible' : 'unavailable', ...(typeof unit === 'string' ? {unit} : {})});
      }
    }
    const sources = [...groups.values()].map(group => {
      const page: QuoteProjectedPage = {rows: [...new Set(group.cells.map(cell => cell.rowIndex))],
        columns: [...new Set(group.cells.map(cell => cell.column))], cells: group.cells,
        page: {hasMore: 'unknown', coverage: 'visible_page_only'}};
      return {locator: locatorSnapshot(group.locator), page: pageSnapshot(page)};
    });
    guard();
    const retained: ViewState[] = [];
    for (const source of sources) {
      if (!source.locator || !source.page) continue;
      const token = prepareCapturedView(source.locator, source.page), view = token && prepared.get(token);
      if (!view) continue;
      const candidate = {...captured, quoteViews: [...retained, view].map(address)};
      if (Buffer.byteLength(JSON.stringify({context: 'scene_evidence', data: candidate}), 'utf8') <= maxBytes) retained.push(view);
      else {prepared.delete(token!); ids.delete(view.id);}
    }
    if (!retained.length) return data;
    const outgoing = {...original, quoteViews: retained.map(address)};
    const enriched = outgoing as T & {quoteViews: QuoteViewAddress[]};
    scenes.set(enriched, {json: JSON.stringify({context: 'scene_evidence', data: {...captured, quoteViews: retained.map(address)}}),
      views: Object.freeze(retained)});
    return enriched;
  };
  const sealToolQuoteOutput = (result: unknown, actualSdkTool: object, call: ToolQuoteCallBinding, exactOutput: string): object | undefined => {
    const projection = readRuntimeToolQuoteProjection(result), bundle = projection && bundles.get(projection);
    if (!bundle) {guard(); return undefined;}
    const payloadText = readRuntimeToolQuotePayload(result);
    const callFields = properties(call, ['responseId', 'callId', 'nativeName', 'rawArguments', 'sdkArguments',
      'normalizedArguments', 'collector', 'collectorDispatchOrdinal']);
    const collector = callFields && field(callFields, 'collector');
    const input = callFields && row(snapshot(Object.fromEntries(['responseId', 'callId', 'nativeName', 'rawArguments',
      'sdkArguments', 'normalizedArguments', 'collectorDispatchOrdinal'].map(key => [key, field(callFields, key)]))));
    const resultFields = properties(result), payload = resultFields && field(resultFields, 'structuredContent');
    guard();
    if (typeof exactOutput !== 'string' || !input || !actualSdkTool || types.isProxy(actualSdkTool) || !collector || typeof collector !== 'object' || types.isProxy(collector) ||
        payload !== bundle.payload || payloadText === undefined || readRuntimeToolQuoteProjection(result) !== projection ||
        readRuntimeToolQuotePayload(result) !== payloadText) return undefined;
    const toolName = Object.getOwnPropertyDescriptor(actualSdkTool, 'name')?.value;
    const {responseId, callId, nativeName, rawArguments, collectorDispatchOrdinal} = input;
    if (toolName !== nativeName || typeof responseId !== 'string' || !responseId || typeof callId !== 'string' || !callId ||
        typeof nativeName !== 'string' || !nativeName || typeof rawArguments !== 'string' || !rawArguments ||
        typeof collectorDispatchOrdinal !== 'number' || !Number.isSafeInteger(collectorDispatchOrdinal) || collectorDispatchOrdinal < 1) return undefined;
    try {
      // This is the carrier's actual inner JSON, not a serialization of a mutable structuredContent object.
      const visiblePayload = row(JSON.parse(payloadText));
      const wire = row(JSON.parse(exactOutput));
      const error = resultFields && field(resultFields, 'isError');
      const wireKeys = error === undefined ? ['_meta', 'content'] : ['_meta', 'content', 'isError'];
      if (!wire || error === true || Object.keys(wire).length !== wireKeys.length || wireKeys.some(key => !Object.prototype.hasOwnProperty.call(wire, key)) ||
          !isDeepStrictEqual(wire._meta, resultFields && field(resultFields, '_meta')) ||
          !isDeepStrictEqual(wire.content, resultFields && field(resultFields, 'content')) || wire.isError !== error) return undefined;
      if (!visiblePayload || visiblePayload.success === false || JSON.stringify(visiblePayload.quoteViews) !== bundle.descriptorJson ||
          !isDeepStrictEqual(JSON.parse(rawArguments), input.sdkArguments)) return undefined;
      const visibleSources = toolSources(visiblePayload);
      if (!bundle.sources.every(source => {
        const visible = visibleSources[source.index];
        return visible && isDeepStrictEqual(source.view.locator, visible.locator) && sameVisiblePage(source.view.page, visible.page);
      })) return undefined;
    } catch {return undefined;}
    const capturedCall: ToolQuoteCallBinding = Object.freeze({responseId, callId, nativeName, rawArguments,
      sdkArguments: input.sdkArguments, normalizedArguments: input.normalizedArguments, collector, collectorDispatchOrdinal});
    const existing = toolSeals.find(seal => seal.tool === actualSdkTool && seal.call.collector === capturedCall.collector &&
      isDeepStrictEqual({...seal.call, collector: undefined}, {...capturedCall, collector: undefined}) && seal.output === exactOutput);
    if (existing) return existing.token;
    const token = Object.freeze({kind: 'sealed_tool_quote_output'});
    toolSeals.push({token, tool: actualSdkTool, call: capturedCall, output: exactOutput, views: bundle.views});
    return token;
  };
  const sealSceneQuotePrompt = (data: SceneEvidencePromptData, parts: unknown): object | undefined => {
    const preparedScene = scenes.get(data), seal = readSceneQuotePromptSeal(parts);
    const partFields = properties(parts), fullPrompt = partFields && field(partFields, 'fullPrompt');
    guard();
    if (!preparedScene || !seal || typeof fullPrompt !== 'string' || !matchesSceneQuotePromptSeal(seal,
      {sceneData: data, parts, fullPrompt, expectedSceneJson: preparedScene.json})) return undefined;
    const previous = sceneSeals.find(item => item.token === seal);
    if (!previous) sceneSeals.push({token: seal, fullPrompt, views: preparedScene.views});
    return seal;
  };
  const observeProducingRequest = (ticket: object, collectorOrdinal: number, actualBody: string | Uint8Array) => {
    guard();
    const active = new Map<string, ViewState>();
    if (!ticket || typeof ticket !== 'object' || types.isProxy(ticket) || !Number.isSafeInteger(collectorOrdinal) || collectorOrdinal < 1) {
      return Object.freeze({status: 'unavailable' as const, viewCount: 0});
    }
    // An opaque ticket is a leaf observation key, not an attestation of actual network or native ownership.
    if (requests.has(ticket)) {requests.set(ticket, {ordinal: collectorOrdinal, views: active}); return Object.freeze({status: 'unavailable' as const, viewCount: 0});}
    try {
      const text = typeof actualBody === 'string' ? actualBody : !types.isProxy(actualBody) && actualBody instanceof Uint8Array
        ? new TextDecoder('utf-8', {fatal: true}).decode(actualBody) : undefined;
      if (text === undefined) throw new Error('quote_request_unobservable');
      const body = row(JSON.parse(text)), messages = body?.messages;
      if (!Array.isArray(messages)) throw new Error('quote_request_unobservable');
      const records = messages.map(row);
      const systemMessages = records.filter(message => message?.role === 'system');
      for (const seal of sceneSeals) if (systemMessages.length === 1 && systemMessages[0]?.content === seal.fullPrompt &&
          !records.some(message => message?.role === 'developer')) {
        seal.views.forEach(view => active.set(view.id, view));
      }
      for (let index = 0; index < records.length; index++) {
        const message = records[index];
        if (message?.role !== 'tool' || typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') continue;
        const calls: Array<{index: number; name: unknown; args: unknown}> = [];
        records.forEach((entry, ordinal) => {
          if (entry?.role !== 'assistant' || !Array.isArray(entry.tool_calls)) return;
          for (const value of entry.tool_calls) {
            const call = row(value), fn = row(call?.function);
            if (call?.type === 'function' && call.id === message.tool_call_id) calls.push({index: ordinal, name: fn?.name, args: fn?.arguments});
          }
        });
        if (calls.length !== 1 || calls[0].index >= index || records.filter(entry => entry?.role === 'tool' && entry.tool_call_id === message.tool_call_id).length !== 1) continue;
        const matching = toolSeals.filter(seal => seal.call.callId === message.tool_call_id && seal.output === message.content &&
          seal.call.nativeName === calls[0].name && seal.call.rawArguments === calls[0].args);
        if (matching.length === 1) matching[0].views.forEach(view => active.set(view.id, view));
      }
      requests.set(ticket, {ordinal: collectorOrdinal, views: active});
      return Object.freeze({status: 'observed' as const, viewCount: active.size});
    } catch {
      active.clear();
      requests.set(ticket, {ordinal: collectorOrdinal, views: active});
      return Object.freeze({status: 'unavailable' as const, viewCount: 0});
    }
  };
  return Object.freeze({prepareModelQuoteView, prepareToolQuoteProjection, prepareSceneQuoteProjection,
    sealToolQuoteOutput, sealSceneQuotePrompt, observeProducingRequest, dispose});
}
export type EvidenceQuoteContext = ReturnType<typeof createEvidenceQuoteContext>;
