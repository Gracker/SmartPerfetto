// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SqlToken} from '../services/skillEngine/sqlTemplate';
import {isNameToken, structuralSqlTokens, tokenMatchers, unqualifiedName} from '../services/skillEngine/sqlStructure';

/**
 * A SmartPerfetto artifact named where trace_processor expects a table or a
 * table function: an `art-N` id a Skill result returned, the
 * `synthesizeArtifacts` list, or an invented artifact table (`artifacts`,
 * `artifact_rows`, `__intrinsic_artifact_rows`). None of them is SQL; the
 * model reads them with `fetch_artifact`.
 *
 * Real trace_processor tables are never refused here, `__intrinsic_*` ones
 * included: Skills read `__intrinsic_trace_diagnostics` and
 * `__intrinsic_android_process_state`, and trace_processor reports an
 * unknown table itself.
 */
export interface ArtifactSqlReference {
  /** The table or function name as written, lower-cased. */
  reference: string;
  /** The `art-N` id the reference names, when it names one. */
  artifactId?: string;
}

const ARTIFACT_ID_NAME = /^art[-_](\d+)(?:[-_]\w+)*$/i;
const ARTIFACT_TABLE_NAME = /^(?:__intrinsic_)?artifacts?(?:_\w+)?$|^synthesize_?artifacts$/i;
const ARTIFACT_FUNCTION = /^(?:read|query|fetch)_artifact(?:_rows)?$/i;
// Words that end a FROM list at its own nesting depth.
const FROM_LIST_END = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT',
  'SELECT', 'VALUES', 'ON', 'USING', 'RETURNING',
]);

function isArtifactPseudoTableName(name: string): boolean {
  return ARTIFACT_ID_NAME.test(name) || ARTIFACT_TABLE_NAME.test(name);
}

function artifactIdOf(name: string): string | undefined {
  const number = ARTIFACT_ID_NAME.exec(name)?.[1];
  return number ? `art-${number}` : undefined;
}

/** The relation name at `index`: an unquoted `art-2` arrives as `ART`, `-`, `2`. */
function relationNameAt(tokens: readonly SqlToken[], index: number): string | undefined {
  const token = tokens[index];
  if (!isNameToken(token)) return undefined;
  const name = unqualifiedName(token);
  const next = tokens[index + 2];
  if (name === 'art' && tokens[index + 1]?.kind === 'punct' && tokens[index + 1].text === '-' &&
    next?.kind === 'word' && /^\d/.test(next.text)) {
    return `art-${next.text.toLowerCase()}`;
  }
  return name;
}

/** The first artifact named as a table (after FROM, JOIN or a FROM-list comma) or table function. */
export function findArtifactSqlReference(sql: string): ArtifactSqlReference | undefined {
  const tokens = structuralSqlTokens(sql, {cache: false});
  const {word, punct} = tokenMatchers(tokens);
  const fromListDepths = new Set<number>();
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (punct(index, '(')) { depth++; continue; }
    if (punct(index, ')')) { fromListDepths.delete(depth); depth = Math.max(0, depth - 1); continue; }
    if (token.kind === 'word' && ARTIFACT_FUNCTION.test(token.text) && punct(index + 1, '(')) {
      const argument = tokens[index + 2];
      const artifactId = argument && (argument.kind === 'string' || argument.kind === 'identifier')
        ? artifactIdOf(argument.text) : undefined;
      if (artifactId) return {reference: token.text.toLowerCase(), artifactId};
    }
    let relation: number | undefined;
    if (word(index, 'FROM')) {
      fromListDepths.add(depth);
      relation = index + 1;
    } else if (word(index, 'JOIN')) {
      relation = index + 1;
    } else if (punct(index, ',') && fromListDepths.has(depth)) {
      relation = index + 1;
    } else if (token.kind === 'word' && FROM_LIST_END.has(token.text)) {
      fromListDepths.delete(depth);
    }
    // A table function is judged by its argument when the loop reaches it.
    if (relation === undefined || punct(relation + 1, '(')) continue;
    const name = relationNameAt(tokens, relation);
    if (name && isArtifactPseudoTableName(name)) return {reference: name, artifactId: artifactIdOf(name)};
  }
  return undefined;
}
