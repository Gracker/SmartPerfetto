// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisContextSelection} from '../resolvedAnalysisContext';

/**
 * The private material an analysis run was authorized to read: a selected
 * codebase under an active code-aware mode, or registered knowledge sources.
 * Every artifact derived from such a run (report, result snapshot, comparison,
 * run record) carries this marker from the moment it is written. A marked
 * artifact is readable only by its creator, can never be shared with the
 * workspace, and leaves administrative exports without its content.
 */
export type AnalysisPrivateContextV1 = {
  codebase: boolean;
  knowledge: boolean;
};

/**
 * Artifacts written before markers existed are 'unknown'. Nothing that
 * survives from that time proves such a run did not read private material, so
 * an unknown artifact is restricted exactly like a marked one.
 */
export type AnalysisPrivateContextMarker = AnalysisPrivateContextV1 | 'unknown';

export const NO_PRIVATE_CONTEXT: Readonly<AnalysisPrivateContextV1> = Object.freeze({
  codebase: false,
  knowledge: false,
});

/**
 * Decided from the run's authorized selection, never from its output. Only an
 * explicit 'off' excludes a selected codebase: an unset mode normalizes to
 * metadata_only, which still gives the run source tools.
 */
export function resolveAnalysisPrivateContext(
  selection: AnalysisContextSelection,
): AnalysisPrivateContextV1 {
  return {
    codebase: selection.codeAwareMode !== 'off' && Boolean(selection.codebaseIds?.length),
    knowledge: Boolean(selection.knowledgeSourceIds?.length),
  };
}

export function privateContextRestrictsAudience(
  marker: AnalysisPrivateContextMarker | undefined,
): boolean {
  return marker === undefined || marker === 'unknown' || marker.codebase || marker.knowledge;
}

/** Union of the contexts an artifact was derived from; any unknown input stays unknown. */
export function unionPrivateContexts(
  markers: readonly AnalysisPrivateContextMarker[],
): AnalysisPrivateContextMarker {
  const union = {codebase: false, knowledge: false};
  for (const marker of markers) {
    if (marker === 'unknown') return 'unknown';
    union.codebase ||= marker.codebase;
    union.knowledge ||= marker.knowledge;
  }
  return union;
}

const CODEBASE_BIT = 1;
const KNOWLEDGE_BIT = 2;

/**
 * SQLite column: bit flags, NULL for unknown. A missing marker (an object
 * deserialized from before markers existed) is stored as unknown.
 */
export function encodePrivateContextColumn(marker: AnalysisPrivateContextMarker | undefined): number | null {
  if (marker === undefined || marker === 'unknown') return null;
  return (marker.codebase ? CODEBASE_BIT : 0) | (marker.knowledge ? KNOWLEDGE_BIT : 0);
}

export function decodePrivateContextColumn(value: unknown): AnalysisPrivateContextMarker {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3) {
    return 'unknown';
  }
  return {codebase: (value & CODEBASE_BIT) !== 0, knowledge: (value & KNOWLEDGE_BIT) !== 0};
}

/** JSON metadata holds the marker itself; anything else reads back as unknown. */
export function decodePrivateContextJson(value: unknown): AnalysisPrivateContextMarker {
  if (!value || typeof value !== 'object') return 'unknown';
  const {codebase, knowledge} = value as Record<string, unknown>;
  return typeof codebase === 'boolean' && typeof knowledge === 'boolean'
    ? {codebase, knowledge}
    : 'unknown';
}

/** SQL predicate over a `private_context` column: known to be unrestricted. */
export function unrestrictedPrivateContextSql(column: string): string {
  return `${column} = 0`;
}
