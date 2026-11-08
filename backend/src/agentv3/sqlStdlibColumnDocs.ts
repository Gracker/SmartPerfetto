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
 * column name alone never borrows a documented meaning. Notes are
 * documentation only: they carry no unit, measurement or evidence authority
 * and stay separate from `columnUnits` / `modelEvidence`.
 */

import {analyzeRawSqlDirectProjection, resolveRawSqlDirectProjection} from '../services/evidence/rawSqlDirectProjection';
import {findPerfettoRelationDoc, loadPerfettoSqlDocsAsset, type PerfettoSqlDocsAsset} from '../services/perfettoSqlDocs';

export const STDLIB_COLUMN_DOC_LIMITS = Object.freeze({columns: 24, descriptionChars: 240});

interface StdlibColumnDoc {
  /** The result column. */
  column: string;
  /** The documented relation column, present when the result aliases it. */
  sourceColumn?: string;
  type?: string;
  description: string;
}

interface StdlibColumnDocs {
  source: 'perfetto_stdlib_docs';
  relation: string;
  module: string;
  columns: StdlibColumnDoc[];
  /** Documented direct columns left out of this result by the size bound. */
  omittedColumns?: number;
}

function boundedDescription(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const limit = STDLIB_COLUMN_DOC_LIMITS.descriptionChars;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Emits each `relation.column` note once per owner (one MCP server per run),
 * within the per-result size bound. Notes left out by the bound stay eligible.
 */
export class StdlibColumnDocMemory {
  private readonly emitted = new Set<string>();

  notesFor(
    sql: string,
    outputColumns: readonly string[],
    docs: PerfettoSqlDocsAsset | null = loadPerfettoSqlDocsAsset(),
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
    const fresh = new Set<string>();
    const columns: StdlibColumnDoc[] = [];
    let omittedColumns = 0;
    for (const {outputColumn, sourceColumn} of mapping) {
      const doc = documented.get(sourceColumn);
      if (!doc?.description?.trim() || this.emitted.has(key(sourceColumn)) || fresh.has(sourceColumn)) continue;
      fresh.add(sourceColumn);
      if (columns.length >= STDLIB_COLUMN_DOC_LIMITS.columns) {
        omittedColumns++;
        continue;
      }
      columns.push({
        column: outputColumn,
        ...(outputColumn === sourceColumn ? {} : {sourceColumn}),
        ...(doc.type ? {type: doc.type} : {}),
        description: boundedDescription(doc.description),
      });
    }
    if (!columns.length) return undefined;
    for (const doc of columns) this.emitted.add(key(doc.sourceColumn ?? doc.column));
    return {source: 'perfetto_stdlib_docs', relation: entry.name, module: entry.module, columns,
      ...(omittedColumns > 0 ? {omittedColumns} : {})};
  }
}
