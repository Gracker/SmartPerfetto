// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// ART garbage-collection slice names, read from the one list the Skills use
// (skills/fragments/art_gc_names.sql), so code that labels a slice as GC agrees
// with the SQL that counts it.

import {builtInSkillFragment} from './skillEngine/skillFragments';
import {skillSqlTokens} from './skillEngine/sqlTemplate';
import {sqliteGlobRegExp} from './skillEngine/sqlPatterns';

export type ArtGcKind = 'collection' | 'wait';

const KINDS: ReadonlySet<string> = new Set<ArtGcKind>(['collection', 'wait']);

let patterns: Array<{kind: ArtGcKind; pattern: RegExp}> | undefined;

/**
 * The rows of art_gc_slice_name_patterns, read from the fragment's own tokens:
 * `VALUES ('<kind>', '<glob>'), ...`. A row of another shape or kind fails
 * loudly rather than leaving a name unlabelled.
 */
export function artGcSliceNamePatterns(): ReadonlyArray<{kind: ArtGcKind; pattern: RegExp}> {
  if (patterns) return patterns;
  const tokens = skillSqlTokens(builtInSkillFragment('art_gc_names.sql'));
  const isPunct = (index: number, text: string) => tokens[index]?.kind === 'punct' && tokens[index].text === text;
  const start = tokens.findIndex(token => token.kind === 'word' && token.text === 'ART_GC_SLICE_NAME_PATTERNS');
  let index = tokens.findIndex((token, at) => at > start && token.kind === 'word' && token.text === 'VALUES') + 1;
  const parsed: Array<{kind: ArtGcKind; pattern: RegExp}> = [];
  for (; start >= 0 && index > 0 && isPunct(index, '('); index += 6) {
    const [kind, glob] = [tokens[index + 1], tokens[index + 3]];
    if (kind?.kind !== 'string' || !KINDS.has(kind.text) || !isPunct(index + 2, ',')
      || glob?.kind !== 'string' || !isPunct(index + 4, ')')) {
      throw new Error('art_gc_names.sql: an art_gc_slice_name_patterns row is not (collection|wait, glob)');
    }
    parsed.push({kind: kind.text as ArtGcKind, pattern: sqliteGlobRegExp(glob.text)});
    if (!isPunct(index + 5, ',')) break;
  }
  if (parsed.length === 0) throw new Error('art_gc_names.sql: no art_gc_slice_name_patterns rows');
  patterns = parsed;
  return patterns;
}

/** The kind of ART GC a slice name names, or undefined when it names none. */
export function artGcSliceKind(name: string): ArtGcKind | undefined {
  return artGcSliceNamePatterns().find(({pattern}) => pattern.test(name))?.kind;
}
