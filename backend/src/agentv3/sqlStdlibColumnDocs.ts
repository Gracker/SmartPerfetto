// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Perfetto stdlib column documentation for a raw SQL result.
 *
 * A note is attached only when a result column is a direct projection (named
 * column or star) of exactly one documented stdlib module relation, as the
 * shared pure-read grammar resolves it against the documented schema. Joins,
 * aggregates, subqueries and scalar expressions get no note, and a result
 * column name alone never borrows a documented meaning.
 *
 * `description` is Perfetto's. Where Perfetto leaves out a unit or meaning
 * SmartPerfetto knows, the curated overlay `backend/strategies/
 * stdlib-column-semantics.yaml` adds `unit` / `semantics` to that column's note
 * and the result names it in `overlaySource`. Notes are documentation only:
 * neither source is a measurement or evidence authority, and both stay
 * separate from `columnUnits` / `modelEvidence`.
 */

import {analyzeRawSqlDirectProjection, resolveRawSqlDirectProjection} from '../services/evidence/rawSqlDirectProjection';
import {exactKeys, isRecord} from '../services/codebase/policyYaml';
import {findPerfettoRelationDoc, loadPerfettoSqlDocsAsset, type PerfettoSqlDocsAsset} from '../services/perfettoSqlDocs';
import {claimUnitFor} from '../utils/claimUnits';
import {loadStrategyYaml} from './strategyLoader';

export const STDLIB_COLUMN_DOC_LIMITS = Object.freeze({columns: 24, descriptionChars: 240});

const OVERLAY_ASSET_NAME = 'stdlib-column-semantics';
const OVERLAY_SCHEMA_VERSION = 'stdlib_column_semantics@1';
const OVERLAY_SOURCE = 'smartperfetto_stdlib_column_semantics';

/** What SmartPerfetto adds to one documented stdlib column. */
interface StdlibColumnSemantics {
  readonly relation: string;
  readonly column: string;
  readonly unit: string;
  readonly semantics: string;
}

/** Overlay entries keyed by `relation.column`. */
type StdlibColumnSemanticsOverlay = ReadonlyMap<string, StdlibColumnSemantics>;

interface StdlibColumnDoc {
  /** The result column. */
  column: string;
  /** The documented relation column, present when the result aliases it. */
  sourceColumn?: string;
  type?: string;
  /** Perfetto's column documentation. */
  description?: string;
  /** From the SmartPerfetto overlay (`overlaySource`). */
  unit?: string;
  /** From the SmartPerfetto overlay (`overlaySource`). */
  semantics?: string;
}

interface StdlibColumnDocs {
  source: 'perfetto_stdlib_docs';
  relation: string;
  module: string;
  columns: StdlibColumnDoc[];
  /** Present when a column note carries `unit` / `semantics`. */
  overlaySource?: typeof OVERLAY_SOURCE;
  /** Documented direct columns left out of this result by the size bound. */
  omittedColumns?: number;
}

/** Documentation text on one line, as a column note carries it. */
export function normalizeDocText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const OVERLAY_ROOT_KEYS = ['schema_version', 'columns'] as const;
const OVERLAY_ENTRY_KEYS = ['relation', 'column', 'unit', 'semantics'] as const;
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The overlay's structure; whether it still matches the docs is `parseDocumentedStdlibColumnSemantics`. */
function parseStdlibColumnSemantics(value: unknown): StdlibColumnSemanticsOverlay {
  if (!isRecord(value) || !exactKeys(value, OVERLAY_ROOT_KEYS) || value.schema_version !== OVERLAY_SCHEMA_VERSION
    || !Array.isArray(value.columns) || value.columns.length === 0) {
    throw new Error('stdlib_column_semantics_invalid_root');
  }
  const overlay = new Map<string, StdlibColumnSemantics>();
  for (const entry of value.columns) {
    if (!isRecord(entry) || !exactKeys(entry, OVERLAY_ENTRY_KEYS)) throw new Error('stdlib_column_semantics_invalid_entry');
    const {relation, column, unit, semantics} = entry;
    if (typeof relation !== 'string' || !IDENTIFIER.test(relation)
      || typeof column !== 'string' || !IDENTIFIER.test(column)) {
      throw new Error('stdlib_column_semantics_invalid_entry');
    }
    const key = `${relation}.${column}`;
    if (typeof unit !== 'string' || !claimUnitFor(unit)) throw new Error(`stdlib_column_semantics_invalid_unit:${key}`);
    const text = typeof semantics === 'string' ? normalizeDocText(semantics) : '';
    if (!text || text.length > STDLIB_COLUMN_DOC_LIMITS.descriptionChars) {
      throw new Error(`stdlib_column_semantics_invalid_semantics:${key}`);
    }
    if (overlay.has(key)) throw new Error(`stdlib_column_semantics_duplicate:${key}`);
    overlay.set(key, Object.freeze({relation, column, unit, semantics: text}));
  }
  return overlay;
}

/**
 * The overlay, rejecting any entry that does not name a documented column of
 * a stdlib module table or view in `docs`: a stale entry fails, never idles.
 */
export function parseDocumentedStdlibColumnSemantics(
  value: unknown,
  docs: PerfettoSqlDocsAsset | null = loadPerfettoSqlDocsAsset(),
): StdlibColumnSemanticsOverlay {
  const overlay = parseStdlibColumnSemantics(value);
  if (!docs) throw new Error('stdlib_column_semantics_docs_unavailable');
  const undocumented = [...overlay.entries()].filter(([, {relation, column}]) => {
    const entry = findPerfettoRelationDoc(docs, relation, 'module');
    return entry?.name !== relation || !entry.columns?.some(documented => documented.name === column);
  }).map(([key]) => key);
  if (undocumented.length) throw new Error(`stdlib_column_semantics_undocumented:${undocumented.join(',')}`);
  return overlay;
}

/** The shipped overlay; none when the asset is absent. */
function loadStdlibColumnSemantics(): StdlibColumnSemanticsOverlay {
  return loadStrategyYaml(OVERLAY_ASSET_NAME, parseStdlibColumnSemantics) ?? new Map();
}

/**
 * The shipped overlay entry a Skill column's `semantics_ref` (`relation.column`)
 * names, or undefined. Whether the entry still matches the stdlib docs is
 * `validate:strategies`' check of the overlay itself.
 */
export function stdlibColumnSemanticsEntry(ref: string): Readonly<{unit: string; semantics: string}> | undefined {
  const entry = loadStdlibColumnSemantics().get(ref);
  return entry ? {unit: entry.unit, semantics: entry.semantics} : undefined;
}

function boundedDescription(description: string): string {
  const text = normalizeDocText(description);
  const limit = STDLIB_COLUMN_DOC_LIMITS.descriptionChars;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** One result's notes: what it may still say, within its bound. */
export interface EmittedNotePass {
  /** Neither delivered earlier in the run nor considered for this result. */
  isNew(key: string): boolean;
  /** Takes a note outside the bound. */
  claim(key: string): void;
  /** Takes a note inside the bound; one left out is counted, stays eligible and returns false. */
  admit(key: string): boolean;
  readonly omitted: number;
  /** Marks the taken notes delivered. Until then the run has said none of them. */
  commit(): void;
}

/**
 * The note keys one run has delivered to the model, so each is said once. A
 * note left out of a result by its bound stays eligible for a later one.
 */
export class EmittedNoteKeys {
  private readonly emitted = new Set<string>();

  has(key: string): boolean {
    return this.emitted.has(key);
  }

  begin(limit: number): EmittedNotePass {
    const seen = new Set<string>();
    const taken = new Set<string>();
    let admitted = 0;
    let omitted = 0;
    const emitted = this.emitted;
    const claim = (key: string) => {
      seen.add(key);
      taken.add(key);
    };
    return {
      isNew: key => !emitted.has(key) && !seen.has(key),
      claim,
      admit(key) {
        if (admitted >= limit) {
          seen.add(key);
          omitted++;
          return false;
        }
        admitted++;
        claim(key);
        return true;
      },
      get omitted() { return omitted; },
      commit() { for (const key of taken) emitted.add(key); },
    };
  }
}

/**
 * Emits each `relation.column` note once per owner (one MCP server per run),
 * within the per-result size bound. Pi shares the owner's keys with Skill
 * result notes, so one overlay entry reaches the model once by either path.
 */
export class StdlibColumnDocMemory {
  constructor(private readonly emitted: EmittedNoteKeys = new EmittedNoteKeys()) {}

  notesFor(
    sql: string,
    outputColumns: readonly string[],
    docs: PerfettoSqlDocsAsset | null = loadPerfettoSqlDocsAsset(),
    overlay: StdlibColumnSemanticsOverlay = loadStdlibColumnSemantics(),
  ): StdlibColumnDocs | undefined {
    if (!docs || !outputColumns.length) return undefined;
    const analysis = analyzeRawSqlDirectProjection(sql, {allowIncludePrelude: true});
    if (!analysis.pureRead || !analysis.relation || !analysis.projections) return undefined;
    const entry = findPerfettoRelationDoc(docs, analysis.relation.name, 'module');
    if (!entry?.columns) return undefined;
    const key = (sourceColumn: string) => `${entry.name}.${sourceColumn}`;
    // Nothing left to say about this relation: skip resolving the projection.
    if (entry.columns.every(column => this.emitted.has(key(column.name)))) return undefined;
    const mapping = resolveRawSqlDirectProjection(analysis, outputColumns, entry.columns.map(column => column.name));
    if (!mapping) return undefined;
    const documented = new Map(entry.columns.map(column => [column.name, column]));
    const pass = this.emitted.begin(STDLIB_COLUMN_DOC_LIMITS.columns);
    const columns: StdlibColumnDoc[] = [];
    for (const {outputColumn, sourceColumn} of mapping) {
      const doc = documented.get(sourceColumn);
      const description = doc?.description?.trim();
      const semantics = overlay.get(key(sourceColumn));
      if (!doc || (!description && !semantics) || !pass.isNew(key(sourceColumn)) || !pass.admit(key(sourceColumn))) continue;
      columns.push({
        column: outputColumn,
        ...(outputColumn === sourceColumn ? {} : {sourceColumn}),
        ...(doc.type ? {type: doc.type} : {}),
        ...(description ? {description: boundedDescription(description)} : {}),
        ...(semantics ? {unit: semantics.unit, semantics: semantics.semantics} : {}),
      });
    }
    if (!columns.length) return undefined;
    pass.commit();
    return {source: 'perfetto_stdlib_docs', relation: entry.name, module: entry.module, columns,
      ...(columns.some(doc => doc.semantics) ? {overlaySource: OVERLAY_SOURCE} : {}),
      ...(pass.omitted > 0 ? {omittedColumns: pass.omitted} : {})};
  }
}
